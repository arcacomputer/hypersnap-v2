import { frameGrpc, parseGrpcFrames, type GrpcTransport } from "./grpc.js";

/** Fetch-based gRPC for runtimes that speak HTTP/2 (Cloudflare Workers). */
export function createFetchGrpcTransport(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): GrpcTransport {
  return {
    async call(base, method, message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(new URL(method, base.endsWith("/") ? base : `${base}/`), {
          method: "POST",
          headers: {
            "content-type": "application/grpc",
            te: "trailers",
            "grpc-accept-encoding": "identity",
          },
          body: frameGrpc(message),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`${base}${method} HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return parseGrpcFrames(bytes);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
