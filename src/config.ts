/**
 * Epoch 0 defaults.
 *
 * haatz.quilibrium.com is the public Hypersnap HTTP node (info + events).
 * It does not expose GetBlocks / GetShardChunks. snap.farcaster.xyz speaks
 * the same HubService over HTTPS on :3383 and is a read node of the same
 * Snapchain-certified chain Hypersnap follows in epoch 0.
 *
 * haatz is listed first so a failed block fetch fails over.
 */
export interface Upstream {
  id: string;
  httpBase: string;
  grpcBase: string;
}

export const DEFAULT_UPSTREAMS: Upstream[] = [
  {
    id: "haatz",
    httpBase: "https://haatz.quilibrium.com",
    grpcBase: "https://haatz.quilibrium.com",
  },
  {
    id: "snap-farcaster",
    httpBase: "https://snap.farcaster.xyz:3381",
    grpcBase: "https://snap.farcaster.xyz:3383",
  },
];

export const DEFAULT_ORACLE_HTTP = "https://haatz.quilibrium.com";

/** Block shard uses GetBlocks. Message shards use GetShardChunks. */
export const BLOCK_SHARD = 0;

export const DEFAULT_SHARDS = [0, 2];
