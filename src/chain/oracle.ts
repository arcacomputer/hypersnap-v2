import { bytesToHex } from "../util/bytes.js";

export interface ConfirmedEvent {
  shardIndex: number;
  blockNumber: number;
  blockHash: string;
}

/** Read recent BLOCK_CONFIRMED events from a Hypersnap HTTP node. */
export async function recentConfirmed(
  httpBase: string,
  shard: number,
  fetchImpl: typeof fetch = fetch,
  pageSize = 100,
): Promise<ConfirmedEvent[]> {
  const url = new URL("/v1/events", httpBase);
  url.searchParams.set("shard_index", String(shard));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("reverse", "true");
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${httpBase} /v1/events HTTP ${response.status}`);
  const body = (await response.json()) as { events?: Array<Record<string, unknown>> };
  const out: ConfirmedEvent[] = [];
  for (const event of body.events ?? []) {
    const confirmed = event.blockConfirmedBody as Record<string, unknown> | undefined;
    if (!confirmed) continue;
    const blockHash = String(confirmed.blockHash ?? "");
    out.push({
      shardIndex: Number(confirmed.shardIndex ?? event.shardIndex ?? shard),
      blockNumber: Number(confirmed.blockNumber ?? event.blockNumber ?? 0),
      blockHash: blockHash.toLowerCase(),
    });
  }
  return out;
}

/**
 * When the oracle has this height, its hash must match. A missing event is
 * not a contradiction (the page is only the recent tip).
 */
export function oracleAgrees(
  events: ConfirmedEvent[],
  shard: number,
  height: number,
  hash: Uint8Array,
): "match" | "mismatch" | "absent" {
  const found = events.find((event) => event.shardIndex === shard && event.blockNumber === height);
  if (!found) return "absent";
  const ours = bytesToHex(hash, true).toLowerCase();
  return found.blockHash === ours ? "match" : "mismatch";
}
