import { hexToBytes } from "../util/bytes.js";
import setsJson from "../generated/validators.json" with { type: "json" };

export interface ValidatorSetEntry {
  effectiveAt: number;
  shardIds: number[];
  publicKeys: string[];
}

export const MAINNET_VALIDATOR_SETS = setsJson as ValidatorSetEntry[];

/** Parse Hypersnap's validators.toml (the subset this file actually uses). */
export function parseValidatorsToml(text: string): ValidatorSetEntry[] {
  const sets: ValidatorSetEntry[] = [];
  let current: ValidatorSetEntry | null = null;
  let mode: "none" | "keys" | "shards" = "none";
  const pushNums = (bucket: number[], fragment: string) => {
    for (const part of fragment.split(/[^0-9]+/)) {
      if (part) bucket.push(Number(part));
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("[[")) {
      if (current) sets.push(current);
      current = { effectiveAt: 0, shardIds: [], publicKeys: [] };
      mode = "none";
      continue;
    }
    if (!current) continue;
    if (line.startsWith("effective_at")) {
      current.effectiveAt = Number(line.split("=")[1].replace(/_/g, "").trim());
      continue;
    }
    if (line.startsWith("shard_ids")) {
      mode = "shards";
      pushNums(current.shardIds, line.split("=")[1] ?? "");
      if (line.includes("]")) mode = "none";
      continue;
    }
    if (line.startsWith("validator_public_keys")) {
      mode = "keys";
      if (line.includes("]")) mode = "none";
      continue;
    }
    if (mode === "shards") {
      pushNums(current.shardIds, line);
      if (line.includes("]")) mode = "none";
      continue;
    }
    if (mode === "keys") {
      const match = line.match(/"([0-9a-fA-F]+)"/);
      if (match) current.publicKeys.push(match[1].toLowerCase());
      if (line.includes("]")) mode = "none";
    }
  }
  if (current) sets.push(current);
  return sets;
}

/** Latest set whose effective height is <= `height` for this shard. */
export function validatorKeysAt(
  sets: ValidatorSetEntry[],
  shard: number,
  height: number,
): Uint8Array[] {
  let best: ValidatorSetEntry | undefined;
  for (const set of sets) {
    if (!set.shardIds.includes(shard)) continue;
    if (set.effectiveAt > height) continue;
    if (!best || set.effectiveAt >= best.effectiveAt) best = set;
  }
  if (!best || best.publicKeys.length === 0) {
    throw new Error(`no validator set for shard ${shard} at height ${height}`);
  }
  return best.publicKeys.map((hex) => hexToBytes(hex));
}

/**
 * Malachite default quorum: weight * 3 > total * 2 (more than two thirds).
 * Each validator has weight 1.
 */
export function quorumMet(signatures: number, validators: number): boolean {
  return signatures * 3 > validators * 2;
}
