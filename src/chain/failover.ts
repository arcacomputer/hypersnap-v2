import type { ChainAdapter, NodeInfo } from "./types.js";

export interface Accepted<T> {
  upstreamId: string;
  value: T;
}

/**
 * Tries each upstream in order. A transport error or an accept() rejection
 * (invalid hashes, signatures, or linkage) moves on to the next one.
 */
export class FailoverChain {
  readonly epoch = "epoch0" as const;
  readonly id: string;
  attempts: string[] = [];

  constructor(private readonly upstreams: ChainAdapter[]) {
    if (upstreams.length === 0) throw new Error("failover chain needs an upstream");
    this.id = upstreams.map((u) => u.id).join(",");
  }

  async getInfo(): Promise<NodeInfo> {
    return (await this.tryEach("info", (upstream) => upstream.getInfo())).value;
  }

  async getBlocks(
    start: number,
    stopInclusive: number,
    accept?: (blocks: Uint8Array[]) => void,
  ): Promise<Accepted<Uint8Array[]>> {
    return this.tryEach(`blocks ${start}-${stopInclusive}`, async (upstream) => {
      const blocks = await upstream.getBlocks(start, stopInclusive);
      accept?.(blocks);
      return blocks;
    });
  }

  async getShardChunks(
    shardId: number,
    start: number,
    stopInclusive: number,
    accept?: (chunks: Uint8Array[]) => void,
  ): Promise<Accepted<Uint8Array[]>> {
    return this.tryEach(`chunks ${shardId}/${start}-${stopInclusive}`, async (upstream) => {
      const chunks = await upstream.getShardChunks(shardId, start, stopInclusive);
      accept?.(chunks);
      return chunks;
    });
  }

  private async tryEach<T>(label: string, run: (upstream: ChainAdapter) => Promise<T>): Promise<Accepted<T>> {
    const errors: string[] = [];
    for (const upstream of this.upstreams) {
      try {
        const value = await run(upstream);
        this.attempts.push(`${upstream.id} ok (${label})`);
        return { upstreamId: upstream.id, value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.attempts.push(`${upstream.id} fail (${label}): ${message}`);
        errors.push(`${upstream.id}: ${message}`);
      }
    }
    throw new Error(`all upstreams failed for ${label}: ${errors.join(" | ")}`);
  }
}
