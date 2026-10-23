import http2 from "node:http2";
import { frameGrpc, parseGrpcFrames, type GrpcTransport } from "./grpc.js";

export function createNodeGrpcTransport(timeoutMs = 15_000): GrpcTransport {
  return {
    call(base, method, message) {
      return new Promise((resolve, reject) => {
        const client = http2.connect(base);
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.close();
          reject(error);
        };
        const timer = setTimeout(() => fail(new Error(`gRPC timeout ${base}${method}`)), timeoutMs);
        client.on("error", (error) => fail(error));
        const req = client.request({
          ":method": "POST",
          ":path": method,
          "content-type": "application/grpc",
          te: "trailers",
          "grpc-accept-encoding": "identity",
        });
        const chunks: Buffer[] = [];
        let grpcStatus: string | undefined;
        let grpcMessage: string | undefined;
        let httpStatus: number | undefined;
        req.on("response", (headers) => {
          httpStatus = Number(headers[":status"] ?? 0);
        });
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("trailers", (trailers) => {
          grpcStatus = trailer(trailers, "grpc-status");
          grpcMessage = trailer(trailers, "grpc-message");
        });
        req.on("error", (error) => fail(error));
        req.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.close();
          if (httpStatus !== 200) {
            reject(new Error(`${base}${method} HTTP ${httpStatus ?? "unknown"}`));
            return;
          }
          if (grpcStatus !== undefined && grpcStatus !== "0") {
            reject(new Error(`${base}${method} grpc-status ${grpcStatus} ${grpcMessage ?? ""}`.trim()));
            return;
          }
          try {
            resolve(parseGrpcFrames(Buffer.concat(chunks)));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        req.end(frameGrpc(message));
      });
    },
  };
}

function trailer(headers: http2.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
