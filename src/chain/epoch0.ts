import { BLOCK_SHARD, type Upstream } from "../config.js";
import { decodeFields, fieldsByNumber } from "../util/protobuf.js";
import { encodeBlocksRequest, encodeShardChunksRequest, type GrpcTransport } from "./grpc.js";
import type { ChainAdapter, NodeInfo, ShardStatus } from "./types.js";

/**
 * Epoch 0: Hypersnap nodes are read nodes of Snapchain-certified blocks.
 * Info and events are JSON over HTTPS. Blocks and shard chunks are HubService
 * gRPC over HTTP/2. The server treats stop_block_number as an exclusive key,
 * so this adapter adds one when the caller asks for an inclusive stop.
 */
export class Epoch0Adapter implements ChainAdapter {
  readonly epoch = "epoch0" as const;

  constructor(
    readonly upstream: Upstream,
    private readonly transport: GrpcTransport,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get id(): string {
    return this.upstream.id;
  }

  async getInfo(): Promise<NodeInfo> {
    const response = await this.fetchImpl(new URL("/v1/info", this.upstream.httpBase));
    if (!response.ok) {
      throw new Error(`${this.id} /v1/info HTTP ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const shardInfos = asArray(body.shardInfos).map(parseShard);
    return {
      version: String(body.version ?? ""),
      peerId: String(body.peer_id ?? body.peerId ?? ""),
      numShards: Number(body.numShards ?? shardInfos.length),
      shardInfos,
      dbStats: parseDbStats(body.dbStats),
      nextEngineVersionTimestamp: Number(body.nextEngineVersionTimestamp ?? 0),
    };
  }

  async getBlocks(start: number, stopInclusive: number): Promise<Uint8Array[]> {
    if (stopInclusive < start) return [];
    const frames = await this.transport.call(
      this.upstream.grpcBase,
      "/HubService/GetBlocks",
      encodeBlocksRequest(start, stopInclusive + 1),
    );
    if (frames.length === 0) {
      throw new Error(`${this.id} returned no blocks for ${start}..${stopInclusive}`);
    }
    return frames;
  }

  async getShardChunks(shardId: number, start: number, stopInclusive: number): Promise<Uint8Array[]> {
    if (shardId === BLOCK_SHARD) return this.getBlocks(start, stopInclusive);
    if (stopInclusive < start) return [];
    const frames = await this.transport.call(
      this.upstream.grpcBase,
      "/HubService/GetShardChunks",
      encodeShardChunksRequest(shardId, start, stopInclusive + 1),
    );
    const response = frames[0] ?? new Uint8Array();
    if (response.length === 0) {
      throw new Error(`${this.id} returned no shard chunks for ${shardId}/${start}..${stopInclusive}`);
    }
    const chunks = fieldsByNumber(decodeFields(response), 1)
      .map((field) => field.bytes)
      .filter((bytes): bytes is Uint8Array => Boolean(bytes));
    if (chunks.length === 0) {
      throw new Error(`${this.id} shard ${shardId} response contained no chunks`);
    }
    return chunks;
  }
}

export class PostPivotAdapter implements ChainAdapter {
  readonly id = "post-pivot";
  readonly epoch = "post-pivot" as const;

  async getInfo(): Promise<NodeInfo> {
    throw new Error("post-pivot chain adapter is not implemented (epoch 0 only)");
  }
  async getBlocks(_start: number, _stopInclusive: number): Promise<Uint8Array[]> {
    throw new Error("post-pivot chain adapter is not implemented (epoch 0 only)");
  }
  async getShardChunks(_shardId: number, _start: number, _stopInclusive: number): Promise<Uint8Array[]> {
    throw new Error("post-pivot chain adapter is not implemented (epoch 0 only)");
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function parseShard(raw: Record<string, unknown>): ShardStatus {
  return {
    shardId: Number(raw.shardId ?? 0),
    maxHeight: Number(raw.maxHeight ?? 0),
    numMessages: Number(raw.numMessages ?? 0),
    numFidRegistrations: Number(raw.numFidRegistrations ?? 0),
    approxSize: Number(raw.approxSize ?? 0),
    blockDelay: Number(raw.blockDelay ?? 0),
    mempoolSize: Number(raw.mempoolSize ?? 0),
  };
}

function parseDbStats(value: unknown): NodeInfo["dbStats"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    numMessages: Number(raw.numMessages ?? 0),
    numFidRegistrations: Number(raw.numFidRegistrations ?? 0),
    approxSize: Number(raw.approxSize ?? 0),
  };
}
