import { concatBytes } from "../util/bytes.js";
import { encodeVarint } from "../util/protobuf.js";

export function frameGrpc(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + message.length);
  frame[0] = 0;
  const view = new DataView(frame.buffer);
  view.setUint32(1, message.length, false);
  frame.set(message, 5);
  return frame;
}

export function parseGrpcFrames(buf: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const compressed = buf[offset];
    const length = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4).getUint32(0, false);
    offset += 5;
    if (offset + length > buf.length) {
      throw new Error("truncated gRPC frame");
    }
    if (compressed !== 0) throw new Error("compressed gRPC frames are not accepted");
    messages.push(buf.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== buf.length) throw new Error("trailing bytes after gRPC frames");
  return messages;
}

export interface GrpcTransport {
  call(base: string, method: string, message: Uint8Array): Promise<Uint8Array[]>;
}

export function encodeBlocksRequest(start: number, stopExclusive: number): Uint8Array {
  return concatBytes(encodeField(2, start), encodeField(3, stopExclusive));
}

export function encodeShardChunksRequest(
  shardId: number,
  start: number,
  stopExclusive: number,
): Uint8Array {
  return concatBytes(encodeField(1, shardId), encodeField(2, start), encodeField(3, stopExclusive));
}

function encodeField(field: number, value: number): Uint8Array {
  return concatBytes(encodeVarint(BigInt((field << 3) | 0)), encodeVarint(BigInt(value)));
}
