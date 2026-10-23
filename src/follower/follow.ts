import { BLOCK_SHARD } from "../config.js";
import { objectKey, type BlockArchive } from "../archive/archive.js";
import { oracleAgrees, recentConfirmed, type ConfirmedEvent } from "../chain/oracle.js";
import type { FailoverChain } from "../chain/failover.js";
import { messageFromBytes, type ApiMessage } from "../proto/messages.js";
import { bytesToHex } from "../util/bytes.js";
import { verifySequence, type VerifiedUnit } from "../verify/block.js";
import { MAINNET_VALIDATOR_SETS } from "../verify/validators.js";

export interface ShardCursor {
  height: number;
  hash: Uint8Array;
}

export interface FollowerStore {
  apply(messages: ApiMessage[]): Promise<{ applied: number }>;
  getCursor(shard: number): Promise<ShardCursor | null>;
  setCursor(shard: number, height: number, hash: Uint8Array): Promise<void>;
  setTip(shard: number, height: number): Promise<void>;
  addBytes(bytes: number): Promise<void>;
}

export interface UnitReport {
  kind: "block" | "chunk";
  shard: number;
  height: number;
  hash: string;
  signers: number;
  validators: number;
  parentLinked: boolean;
  messages: number;
  rejected: number;
  applied: number;
  oracle: "match" | "mismatch" | "absent" | "skipped";
  upstreamId: string;
}

export interface FollowSummary {
  attempts: string[];
  units: UnitReport[];
  verified: number;
  applied: number;
  rejected: number;
}

export interface FollowOptions {
  chain: FailoverChain;
  store: FollowerStore;
  archive: BlockArchive;
  shards: number[];
  maxPerShard: number;
  /** Drop this many newest heights so the HTTP oracle has usually seen them. */
  lag?: number;
  oracleHttp?: string;
  expectedChainId?: number;
  fetchImpl?: typeof fetch;
}

export async function followOnce(options: FollowOptions): Promise<FollowSummary> {
  const lag = options.lag ?? 1;
  const info = await options.chain.getInfo();
  const units: UnitReport[] = [];
  for (const shard of options.shards) {
    const status = info.shardInfos.find((item) => item.shardId === shard);
    if (!status) continue;
    await options.store.setTip(shard, status.maxHeight);
    const tip = Math.max(0, status.maxHeight - lag);
    const cursor = await options.store.getCursor(shard);
    const start = cursor ? cursor.height + 1 : Math.max(1, tip - options.maxPerShard + 1);
    const stop = Math.min(tip, start + options.maxPerShard - 1);
    if (start > stop || tip < 1) continue;
    const kind = shard === BLOCK_SHARD ? "block" : "chunk";
    let oracleEvents: ConfirmedEvent[] | null = null;
    let oracleSkipped = false;
    if (options.oracleHttp) {
      try {
        oracleEvents = await recentConfirmed(options.oracleHttp, shard, options.fetchImpl);
      } catch {
        oracleSkipped = true;
      }
    }
    const fetched =
      kind === "block"
        ? await options.chain.getBlocks(start, stop, (raws) => {
            assertBatch(raws, kind, shard, start, options.expectedChainId ?? 1, cursor?.hash ?? null, oracleEvents);
          })
        : await options.chain.getShardChunks(shard, start, stop, (raws) => {
            assertBatch(raws, kind, shard, start, options.expectedChainId ?? 1, cursor?.hash ?? null, oracleEvents);
          });
    const verified = verifySequence(fetched.value, {
      kind,
      validatorSets: MAINNET_VALIDATOR_SETS,
      expectedChainId: options.expectedChainId ?? 1,
      startHeight: start,
      previousHash: cursor?.hash ?? null,
    });
    for (const unit of verified) {
      const oracle = !options.oracleHttp
        ? "skipped"
        : oracleSkipped || !oracleEvents
          ? "skipped"
          : oracleAgrees(oracleEvents, unit.shard, unit.height, unit.hash);
      const messages: ApiMessage[] = [];
      for (const checked of unit.messages) {
        messages.push(messageFromBytes(checked.messageBytes));
      }
      const applied = messages.length === 0 ? { applied: 0 } : await options.store.apply(messages);
      const key = objectKey(kind === "block" ? "blocks" : "chunks", unit.shard, unit.height);
      await options.archive.put(key, unit.raw);
      await options.store.addBytes(unit.raw.byteLength);
      await options.store.setCursor(unit.shard, unit.height, unit.hash);
      units.push(toReport(unit, applied.applied, oracle, fetched.upstreamId));
    }
  }
  return {
    attempts: options.chain.attempts.slice(),
    units,
    verified: units.length,
    applied: units.reduce((sum, unit) => sum + unit.applied, 0),
    rejected: units.reduce((sum, unit) => sum + unit.rejected, 0),
  };
}

function assertBatch(
  raws: Uint8Array[],
  kind: "block" | "chunk",
  shard: number,
  start: number,
  chainId: number,
  previous: Uint8Array | null,
  oracleEvents: ConfirmedEvent[] | null,
): void {
  const units = verifySequence(raws, {
    kind,
    validatorSets: MAINNET_VALIDATOR_SETS,
    expectedChainId: chainId,
    startHeight: start,
    previousHash: previous,
  });
  if (units.length === 0) throw new Error(`empty ${kind} batch`);
  if (units[0].shard !== shard) throw new Error(`shard ${units[0].shard} != requested ${shard}`);
  if (!oracleEvents) return;
  for (const unit of units) {
    if (oracleAgrees(oracleEvents, unit.shard, unit.height, unit.hash) === "mismatch") {
      throw new Error(`oracle hash mismatch at ${unit.shard}/${unit.height}`);
    }
  }
}

function toReport(
  unit: VerifiedUnit,
  applied: number,
  oracle: UnitReport["oracle"],
  upstreamId: string,
): UnitReport {
  return {
    kind: unit.kind,
    shard: unit.shard,
    height: unit.height,
    hash: bytesToHex(unit.hash, true),
    signers: unit.signers,
    validators: unit.validators,
    parentLinked: unit.parentLinked,
    messages: unit.messages.length,
    rejected: unit.rejectedMessages,
    applied,
    oracle,
    upstreamId,
  };
}

export function formatSummary(summary: FollowSummary): string {
  const lines = ["hypersnap-v2 follower"];
  for (const attempt of summary.attempts) lines.push(`upstream ${attempt}`);
  for (const unit of summary.units) {
    lines.push(
      `${unit.kind} shard ${unit.shard} height ${unit.height} hash ${unit.hash} commits ${unit.signers}/${unit.validators} parent ${unit.parentLinked ? "linked" : "checkpoint"} messages ${unit.messages} applied ${unit.applied} rejected ${unit.rejected} oracle ${unit.oracle} via ${unit.upstreamId}`,
    );
  }
  lines.push(
    `verified ${summary.verified} applied ${summary.applied} rejected ${summary.rejected}`,
  );
  return lines.join("\n");
}
