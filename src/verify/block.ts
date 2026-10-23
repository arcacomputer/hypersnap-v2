import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { GENESIS_PARENT_TEXT } from "../version.js";
import { bytesToHex, concatBytes, equalBytes } from "../util/bytes.js";
import {
  decodeFields,
  encodeLengthDelimited,
  encodeVarintField,
  firstBytes,
  firstVarint,
  type WireField,
} from "../util/protobuf.js";
import { quorumMet, validatorKeysAt, type ValidatorSetEntry } from "./validators.js";

const GENESIS_PARENT = new TextEncoder().encode(GENESIS_PARENT_TEXT);
/** Shard proposer uses this parent when it has no previous chunk. */
const SHARD_GENESIS_PARENT = Uint8Array.of(0, 32);
const PRECOMMIT = 1n;

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export interface CheckedMessage {
  fid: number;
  messageBytes: Uint8Array;
  hash: Uint8Array;
  dataBytes: Uint8Array;
  ok: true;
}

export interface RejectedMessage {
  ok: false;
  reason: string;
}

export interface VerifiedUnit {
  kind: "block" | "chunk";
  shard: number;
  height: number;
  hash: Uint8Array;
  parentHash: Uint8Array;
  /** Parent matched the previous unit, or height 1 matched the genesis bytes. */
  parentLinked: boolean;
  timestamp: number;
  round: number;
  chainId?: number;
  version?: number;
  signers: number;
  validators: number;
  witnessHashOk: boolean;
  eventsHashOk: boolean;
  stateRoot: Uint8Array;
  messages: CheckedMessage[];
  rejectedMessages: number;
  raw: Uint8Array;
}

export interface VerifyOptions {
  kind: "block" | "chunk";
  validatorSets: ValidatorSetEntry[];
  expectedChainId?: number;
  expectedParent?: Uint8Array | null;
  expectedHeight?: number;
}

export function verifyUnit(raw: Uint8Array, options: VerifyOptions): VerifiedUnit {
  const top = decodeFields(raw);
  const headerBytes = mustBytes(top, 1, "header");
  const hash = mustBytes(top, 2, "hash");
  const headerHash = blake3(headerBytes);
  if (!equalBytes(headerHash, hash)) {
    throw new VerifyError(
      `header hash mismatch: computed ${bytesToHex(headerHash, true)} embedded ${bytesToHex(hash, true)}`,
    );
  }
  if (hash.length !== 32) throw new VerifyError(`hash is ${hash.length} bytes, expected 32`);

  const header = decodeFields(headerBytes);
  const heightBytes = mustBytes(header, 1, "height");
  const heightFields = decodeFields(heightBytes);
  const shard = Number(firstVarint(heightFields, 1) ?? 0n);
  const height = Number(mustVarint(heightFields, 2, "block_number"));
  if (options.expectedHeight !== undefined && options.expectedHeight !== height) {
    throw new VerifyError(`height ${height} != expected ${options.expectedHeight}`);
  }
  const timestamp = Number(mustVarint(header, 2, "timestamp"));

  let parentHash: Uint8Array;
  let chainId: number | undefined;
  let version: number | undefined;
  let stateRoot: Uint8Array;
  let witnessHashOk = false;
  let eventsHashOk = false;

  if (options.kind === "block") {
    version = Number(firstVarint(header, 3) ?? 0n);
    chainId = Number(firstVarint(header, 4) ?? 0n);
    if (options.expectedChainId !== undefined && chainId !== options.expectedChainId) {
      throw new VerifyError(`chain_id ${chainId} != expected ${options.expectedChainId}`);
    }
    const witnessesHash = mustBytes(header, 5, "shard_witnesses_hash");
    parentHash = mustBytes(header, 6, "parent_hash");
    stateRoot = firstBytes(header, 7) ?? new Uint8Array();
    const eventsHash = firstBytes(header, 8) ?? new Uint8Array();
    const witness = mustBytes(top, 3, "shard_witness");
    if (!equalBytes(blake3(witness), witnessesHash)) {
      throw new VerifyError("shard witness hash does not match header.shard_witnesses_hash");
    }
    witnessHashOk = true;
    checkEventHashes(fieldsBy(top, 6), eventsHash);
    eventsHashOk = true;
  } else {
    parentHash = mustBytes(header, 3, "parent_hash");
    stateRoot = firstBytes(header, 4) ?? new Uint8Array();
    eventsHashOk = true;
    witnessHashOk = true;
  }

  let parentLinked = false;
  if (height === 1) {
    const expected = options.kind === "block" ? GENESIS_PARENT : SHARD_GENESIS_PARENT;
    if (!equalBytes(parentHash, expected)) {
      throw new VerifyError("height 1 parent is not the genesis parent");
    }
    parentLinked = true;
  } else if (options.expectedParent) {
    if (!equalBytes(parentHash, options.expectedParent)) {
      throw new VerifyError(
        `parent link broken at ${shard}/${height}: got ${bytesToHex(parentHash, true)} expected ${bytesToHex(options.expectedParent, true)}`,
      );
    }
    parentLinked = true;
  }

  const commits = mustBytes(top, options.kind === "block" ? 4 : 4, "commits");
  const { signers, validators, round } = verifyCommits({
    commitsBytes: commits,
    hash,
    shard,
    height,
    sets: options.validatorSets,
  });

  const txField = options.kind === "block" ? 5 : 3;
  const { messages, rejectedMessages } = checkTransactions(fieldsBy(top, txField));

  return {
    kind: options.kind,
    shard,
    height,
    hash,
    parentHash,
    parentLinked,
    timestamp,
    round,
    chainId,
    version,
    signers,
    validators,
    witnessHashOk,
    eventsHashOk,
    stateRoot,
    messages,
    rejectedMessages,
    raw,
  };
}

export function verifySequence(
  raws: Uint8Array[],
  options: Omit<VerifyOptions, "expectedParent" | "expectedHeight"> & {
    startHeight: number;
    previousHash?: Uint8Array | null;
  },
): VerifiedUnit[] {
  const out: VerifiedUnit[] = [];
  let previous = options.previousHash ?? null;
  let height = options.startHeight;
  for (const raw of raws) {
    const unit = verifyUnit(raw, {
      ...options,
      expectedParent: previous,
      expectedHeight: height,
    });
    out.push(unit);
    previous = unit.hash;
    height += 1;
  }
  return out;
}

function verifyCommits(args: {
  commitsBytes: Uint8Array;
  hash: Uint8Array;
  shard: number;
  height: number;
  sets: ValidatorSetEntry[];
}): { signers: number; validators: number; round: number } {
  const fields = decodeFields(args.commitsBytes);
  const heightBytes = mustBytes(fields, 1, "commits.height");
  const heightFields = decodeFields(heightBytes);
  const commitShard = Number(firstVarint(heightFields, 1) ?? 0n);
  const commitHeight = Number(mustVarint(heightFields, 2, "commits.height.block"));
  if (commitShard !== args.shard || commitHeight !== args.height) {
    throw new VerifyError(
      `commits height ${commitShard}/${commitHeight} != header ${args.shard}/${args.height}`,
    );
  }
  const round = firstVarint(fields, 2) ?? 0n;
  const valueBytes = mustBytes(fields, 3, "commits.value");
  const value = decodeFields(valueBytes);
  const valueShard = Number(firstVarint(value, 1) ?? 0n);
  const valueHash = mustBytes(value, 2, "value.hash");
  if (valueShard !== args.shard || !equalBytes(valueHash, args.hash)) {
    throw new VerifyError("commits value is not this block hash");
  }

  const keys = validatorKeysAt(args.sets, args.shard, args.height);
  const allowed = new Set(keys.map((k) => bytesToHex(k)));
  const seen = new Set<string>();
  let signers = 0;
  for (const sigField of fieldsBy(fields, 4)) {
    if (!sigField.bytes) continue;
    const sig = decodeFields(sigField.bytes);
    const signer = mustBytes(sig, 1, "signer");
    const signature = mustBytes(sig, 2, "signature");
    const signerHex = bytesToHex(signer);
    if (!allowed.has(signerHex)) {
      throw new VerifyError(`commit signer ${signerHex} is not in the validator set`);
    }
    if (seen.has(signerHex)) throw new VerifyError(`duplicate commit from ${signerHex}`);
    seen.add(signerHex);
    const vote = encodePrecommit(heightBytes, round, valueBytes, signer);
    const ok = ed25519.verify(signature, vote, signer, { zip215: false });
    if (!ok) throw new VerifyError(`invalid commit signature from ${signerHex}`);
    signers += 1;
  }
  if (!quorumMet(signers, keys.length)) {
    throw new VerifyError(`quorum not met: ${signers}/${keys.length}`);
  }
  return { signers, validators: keys.length, round: Number(round) };
}

/** Prost encodes Vote { type=PRECOMMIT, height, round?, value, voter }. Nested bytes are reused raw. */
function encodePrecommit(
  heightBytes: Uint8Array,
  round: bigint,
  valueBytes: Uint8Array,
  voter: Uint8Array,
): Uint8Array {
  const parts = [encodeVarintField(1, PRECOMMIT), encodeLengthDelimited(2, heightBytes)];
  if (round !== 0n) parts.push(encodeVarintField(3, round));
  parts.push(encodeLengthDelimited(4, valueBytes));
  parts.push(encodeLengthDelimited(5, voter));
  return concatBytes(...parts);
}

function checkEventHashes(events: WireField[], eventsHash: Uint8Array): void {
  const hashes: Uint8Array[] = [];
  for (const eventField of events) {
    if (!eventField.bytes) continue;
    const event = decodeFields(eventField.bytes);
    const hash = mustBytes(event, 1, "event.hash");
    const data = mustBytes(event, 2, "event.data");
    if (!equalBytes(blake3(data), hash)) throw new VerifyError("block event hash mismatch");
    hashes.push(hash);
  }
  if (hashes.length === 0) {
    if (eventsHash.length !== 0) throw new VerifyError("events_hash set but block has no events");
    return;
  }
  const computed = blake3(concatBytes(...hashes));
  if (!equalBytes(computed, eventsHash)) throw new VerifyError("events_hash mismatch");
}

function checkTransactions(txs: WireField[]): {
  messages: CheckedMessage[];
  rejectedMessages: number;
} {
  const messages: CheckedMessage[] = [];
  let rejectedMessages = 0;
  for (const txField of txs) {
    if (!txField.bytes) continue;
    const tx = decodeFields(txField.bytes);
    const txFid = Number(firstVarint(tx, 1) ?? 0n);
    for (const msgField of fieldsBy(tx, 2)) {
      if (!msgField.bytes) continue;
      const checked = checkUserMessage(msgField.bytes, txFid);
      if (checked.ok) messages.push(checked);
      else rejectedMessages += 1;
    }
  }
  return { messages, rejectedMessages };
}

function checkUserMessage(messageBytes: Uint8Array, txFid: number): CheckedMessage | RejectedMessage {
  let fields: WireField[];
  try {
    fields = decodeFields(messageBytes);
  } catch (error) {
    return { ok: false, reason: `undecodable message: ${(error as Error).message}` };
  }
  const hash = firstBytes(fields, 2);
  const hashScheme = firstVarint(fields, 3);
  const signature = firstBytes(fields, 4);
  const sigScheme = firstVarint(fields, 5);
  const signer = firstBytes(fields, 6);
  const dataBytes = firstBytes(fields, 7);
  if (!hash || !signature || !signer || !dataBytes) {
    return { ok: false, reason: "message missing hash, signature, signer, or data_bytes" };
  }
  if (hashScheme !== 1n) return { ok: false, reason: `hash scheme ${hashScheme}` };
  if (sigScheme !== 1n) return { ok: false, reason: `signature scheme ${sigScheme}` };
  const digest = blake3(dataBytes).subarray(0, 20);
  if (!equalBytes(digest, hash)) return { ok: false, reason: "message hash mismatch" };
  let valid = false;
  try {
    valid = ed25519.verify(signature, hash, signer, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "message signature invalid" };
  let dataFields: WireField[];
  try {
    dataFields = decodeFields(dataBytes);
  } catch {
    return { ok: false, reason: "data_bytes is not a MessageData" };
  }
  const fid = Number(firstVarint(dataFields, 2) ?? 0n);
  if (fid !== txFid) return { ok: false, reason: `message fid ${fid} != transaction fid ${txFid}` };
  return { fid, messageBytes, hash, dataBytes, ok: true };
}

function fieldsBy(fields: WireField[], field: number): WireField[] {
  return fields.filter((f) => f.field === field);
}

function mustBytes(fields: WireField[], field: number, name: string): Uint8Array {
  const bytes = firstBytes(fields, field);
  if (!bytes) throw new VerifyError(`missing ${name}`);
  return bytes;
}

function mustVarint(fields: WireField[], field: number, name: string): bigint {
  const value = firstVarint(fields, field);
  if (value === undefined) throw new VerifyError(`missing ${name}`);
  return value;
}
