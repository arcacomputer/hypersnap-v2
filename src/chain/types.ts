export interface DbStats {
  numMessages: number;
  numFidRegistrations: number;
  approxSize: number;
}

export interface ShardStatus {
  shardId: number;
  maxHeight: number;
  numMessages: number;
  numFidRegistrations: number;
  approxSize: number;
  blockDelay: number;
  mempoolSize: number;
}

export interface NodeInfo {
  version: string;
  peerId: string;
  numShards: number;
  shardInfos: ShardStatus[];
  dbStats?: DbStats;
  nextEngineVersionTimestamp: number;
}

export type ChainEpoch = "epoch0" | "post-pivot";

export interface ChainAdapter {
  readonly id: string;
  readonly epoch: ChainEpoch;
  getInfo(): Promise<NodeInfo>;
  /** Inclusive heights. Block shard only. */
  getBlocks(start: number, stopInclusive: number): Promise<Uint8Array[]>;
  /** Inclusive heights. Message shards. */
  getShardChunks(shardId: number, start: number, stopInclusive: number): Promise<Uint8Array[]>;
}
