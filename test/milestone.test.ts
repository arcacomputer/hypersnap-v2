import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleRead } from "../src/api/read.js";
import { MemoryArchive, R2Archive, objectKey } from "../src/archive/archive.js";
import { FilesystemArchive } from "../src/archive/fs.js";
import { FailoverChain } from "../src/chain/failover.js";
import { PostPivotAdapter } from "../src/chain/epoch0.js";
import { oracleAgrees } from "../src/chain/oracle.js";
import type { ChainAdapter, NodeInfo, ShardStatus } from "../src/chain/types.js";
import { followOnce } from "../src/follower/follow.js";
import { messageFromBytes, type ApiMessage } from "../src/proto/messages.js";
import { LocalStore } from "../src/state/local.js";
import { readVarint } from "../src/util/protobuf.js";
import { bytesToBase64, bytesToHex, hexToBytes } from "../src/util/bytes.js";
import { MAINNET_VALIDATOR_SETS, parseValidatorsToml, quorumMet } from "../src/verify/validators.js";
import { VerifyError, verifySequence, verifyUnit } from "../src/verify/block.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures");

interface FixtureFile {
  kind: "block" | "chunk";
  shard: number;
  height: number;
  file: string;
  hash: string;
  messages: number;
  signers: number;
  validators: number;
}

const manifest = JSON.parse(await readFile(path.join(fixtureDir, "manifest.json"), "utf8")) as {
  units: FixtureFile[];
};

const blocks = manifest.units.filter((unit) => unit.kind === "block");
const chunks = manifest.units.filter((unit) => unit.kind === "chunk");

async function load(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureDir, file)));
}

test("recorded blocks verify commits, hashes, and parent linkage offline", async () => {
  const raws = await Promise.all(blocks.map((unit) => load(unit.file)));
  const verified = verifySequence(raws, {
    kind: "block",
    validatorSets: MAINNET_VALIDATOR_SETS,
    expectedChainId: 1,
    startHeight: blocks[0].height,
    previousHash: null,
  });
  assert.equal(verified.length, 2);
  assert.equal(verified[0].parentLinked, false);
  assert.equal(verified[1].parentLinked, true);
  assert.deepEqual(verified[1].parentHash, verified[0].hash);
  for (const [index, unit] of verified.entries()) {
    const expected = blocks[index];
    assert.equal(unit.shard, 0);
    assert.equal(unit.height, expected.height);
    assert.equal(bytesToHex(unit.hash, true), expected.hash);
    assert.equal(unit.hash.length, 32);
    assert.equal(unit.signers, expected.signers);
    assert.equal(unit.validators, expected.validators);
    assert.equal(unit.chainId, 1);
    assert.equal(unit.witnessHashOk, true);
    assert.equal(unit.eventsHashOk, true);
    assert.equal(unit.messages.length, 0);
    assert.ok(quorumMet(unit.signers, unit.validators));
  }
});

test("recorded shard chunks verify commits and the user message signature", async () => {
  const raws = await Promise.all(chunks.map((unit) => load(unit.file)));
  const verified = verifySequence(raws, {
    kind: "chunk",
    validatorSets: MAINNET_VALIDATOR_SETS,
    startHeight: chunks[0].height,
    previousHash: null,
  });
  assert.equal(verified[1].parentLinked, true);
  assert.deepEqual(verified[1].parentHash, verified[0].hash);
  assert.equal(verified[0].messages.length, 1);
  assert.equal(verified[0].rejectedMessages, 0);
  assert.equal(verified[1].signers, 7);
  const message = messageFromBytes(verified[0].messages[0].messageBytes);
  assert.equal(message.hash, bytesToHex(verified[0].messages[0].hash, true));
  assert.equal(message.hashScheme, "HASH_SCHEME_BLAKE3");
  assert.equal(message.signatureScheme, "SIGNATURE_SCHEME_ED25519");
  assert.match(message.signer, /^0x[0-9a-f]{64}$/);
  assert.match(message.signature, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(message.data.network, "FARCASTER_NETWORK_MAINNET");
  assert.equal(message.data.fid, verified[0].messages[0].fid);
});

test("a flipped commit signature is rejected", async () => {
  const raw = await load(blocks[1].file);
  const tampered = flipCommitSignature(raw);
  assert.throws(
    () =>
      verifyUnit(tampered, {
        kind: "block",
        validatorSets: MAINNET_VALIDATOR_SETS,
        expectedChainId: 1,
        expectedHeight: blocks[1].height,
        expectedParent: hexToBytes(blocks[0].hash),
      }),
    (error: unknown) => error instanceof VerifyError && /invalid commit signature/.test(error.message),
  );
});

test("a broken parent link is rejected", async () => {
  const raw = await load(blocks[1].file);
  assert.throws(
    () =>
      verifyUnit(raw, {
        kind: "block",
        validatorSets: MAINNET_VALIDATOR_SETS,
        expectedChainId: 1,
        expectedHeight: blocks[1].height,
        expectedParent: new Uint8Array(32),
      }),
    (error: unknown) => error instanceof VerifyError && /parent link broken/.test(error.message),
  );
});

test("quorum requires more than two thirds", () => {
  assert.equal(quorumMet(4, 7), false);
  assert.equal(quorumMet(5, 7), true);
  assert.equal(quorumMet(7, 7), true);
});

test("validators.json matches the vendored Snapchain mainnet toml", async () => {
  const toml = await readFile(path.join(import.meta.dirname, "../config/validators.toml"), "utf8");
  const parsed = parseValidatorsToml(toml);
  assert.deepEqual(parsed, MAINNET_VALIDATOR_SETS);
  const current = MAINNET_VALIDATOR_SETS.filter(
    (set) => set.shardIds.includes(0) && set.effectiveAt <= blocks[0].height,
  ).at(-1);
  assert.ok(current);
  assert.ok(current.publicKeys.includes("bd465c947fe1acfac219fec2fb2ae1e8a13e2acd0498c413f2e54c946ea95095"));
  assert.equal(current.publicKeys.length, 7);
});

test("failover skips an upstream that returns an invalid block", async () => {
  const good = await load(blocks[0].file);
  const bad = flipCommitSignature(good);
  const chain = new FailoverChain([
    new StaticAdapter("bad-upstream", [bad]),
    new StaticAdapter("good-upstream", [good]),
  ]);
  const accepted = await chain.getBlocks(blocks[0].height, blocks[0].height, (raws) => {
    verifySequence(raws, {
      kind: "block",
      validatorSets: MAINNET_VALIDATOR_SETS,
      expectedChainId: 1,
      startHeight: blocks[0].height,
    });
  });
  assert.equal(accepted.upstreamId, "good-upstream");
  assert.equal(accepted.value.length, 1);
  assert.match(chain.attempts[0], /bad-upstream fail/);
  assert.match(chain.attempts[1], /good-upstream ok/);
});

test("post-pivot adapter is isolated and unimplemented", async () => {
  const adapter = new PostPivotAdapter();
  await assert.rejects(adapter.getInfo(), /epoch 0 only/);
  await assert.rejects(adapter.getBlocks(1, 1), /epoch 0 only/);
});

test("follower applies a real chunk and the read API matches v1 shapes", async () => {
  const blockRaws = await Promise.all(blocks.map((unit) => load(unit.file)));
  const chunkRaws = await Promise.all(chunks.map((unit) => load(unit.file)));
  const store = new LocalStore(":memory:");
  const archive = new MemoryArchive();
  const good = new FixtureAdapter("snap-farcaster", blockRaws, chunkRaws);
  const chain = new FailoverChain([new ThrowingAdapter("haatz", await good.getInfo()), good]);
  const summary = await followOnce({
    chain,
    store: asyncStore(store),
    archive,
    shards: [0, 2],
    maxPerShard: 2,
    lag: 1,
    oracleHttp: "https://oracle.test",
    fetchImpl: oracleFetch,
  });
  assert.equal(summary.verified, 4);
  assert.equal(summary.applied, 1);
  assert.equal(summary.rejected, 0);
  assert.ok(summary.attempts.some((line) => line.startsWith("haatz fail")));
  assert.ok(summary.units.every((unit) => unit.upstreamId === "snap-farcaster"));
  assert.ok(summary.units.every((unit) => unit.oracle === "match"));
  assert.equal(summary.units[1].parentLinked, true);
  assert.equal(summary.units[3].parentLinked, true);

  const withMessage = summary.units.find((unit) => unit.messages === 1);
  assert.ok(withMessage);
  const archived = await archive.get(objectKey("chunks", withMessage.shard, withMessage.height));
  assert.ok(archived);
  assert.equal(archived.byteLength > 0, true);

  const verified = verifyUnit(chunkRaws[0], {
    kind: "chunk",
    validatorSets: MAINNET_VALIDATOR_SETS,
    expectedHeight: chunks[0].height,
  });
  const message = messageFromBytes(verified.messages[0].messageBytes);
  const fid = String(message.data.fid);
  const casts = await handleRead(readModel(store), new URL(`http://local/v1/castsByFid?fid=${fid}`));
  const userData = await handleRead(readModel(store), new URL(`http://local/v1/userDataByFid?fid=${fid}`));
  const info = await handleRead(readModel(store), new URL("http://local/v1/info"));
  assert.equal(info.status, 200);
  const infoBody = JSON.parse(info.body);
  assert.equal(infoBody.peer_id, "hypersnap-v2");
  assert.equal(infoBody.dbStats.numMessages, 1);
  assert.equal(typeof infoBody.shardInfos[0].maxHeight, "number");

  if (message.data.type === "MESSAGE_TYPE_CAST_ADD" || message.data.type === "MESSAGE_TYPE_CAST_REMOVE") {
    const body = JSON.parse(casts.body) as { messages: ApiMessage[] };
    assert.equal(casts.status, 200);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].hash, message.hash);
    assert.equal(body.messages[0].data.type, message.data.type);
    if (message.data.castAddBody) {
      assert.equal("parentCastId" in body.messages[0].data.castAddBody!, true);
      assert.equal("parentUrl" in body.messages[0].data.castAddBody!, true);
    }
    assert.deepEqual(JSON.parse(userData.body), { messages: [] });
  } else if (message.data.type === "MESSAGE_TYPE_USER_DATA_ADD") {
    const body = JSON.parse(userData.body) as { messages: ApiMessage[] };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].data.userDataBody?.type, message.data.userDataBody?.type);
    assert.deepEqual(JSON.parse(casts.body), { messages: [] });
  } else {
    assert.ok(message.data.type.startsWith("MESSAGE_TYPE_"));
  }

  const missing = await handleRead(readModel(store), new URL("http://local/v1/castsByFid"));
  assert.equal(missing.status, 400);
  assert.equal(missing.body, "Invalid query parameters: missing field `fid`");
  store.close();
});

test("oracle mismatch rejects the batch", () => {
  const hash = hexToBytes(chunks[0].hash);
  assert.equal(
    oracleAgrees(
      [{ shardIndex: 2, blockNumber: chunks[0].height, blockHash: "0x" + "ab".repeat(32) }],
      2,
      chunks[0].height,
      hash,
    ),
    "mismatch",
  );
  assert.equal(
    oracleAgrees(
      [{ shardIndex: 2, blockNumber: chunks[0].height, blockHash: chunks[0].hash }],
      2,
      chunks[0].height,
      hash,
    ),
    "match",
  );
  assert.equal(oracleAgrees([], 2, chunks[0].height, hash), "absent");
});

test("local sqlite keeps casts, hides removed casts, and replaces user data", () => {
  const store = new LocalStore(":memory:");
  const add = message({
    type: "MESSAGE_TYPE_CAST_ADD",
    fid: 42,
    timestamp: 10,
    hash: "0x" + "11".repeat(20),
    castAddBody: {
      embedsDeprecated: [],
      mentions: [],
      parentCastId: null,
      parentUrl: null,
      text: "hello",
      embeds: [],
      mentionsPositions: [],
      type: "CAST",
    },
  });
  const later = message({
    type: "MESSAGE_TYPE_CAST_ADD",
    fid: 42,
    timestamp: 11,
    hash: "0x" + "22".repeat(20),
    castAddBody: { ...add.data.castAddBody!, text: "next" },
  });
  const remove = message({
    type: "MESSAGE_TYPE_CAST_REMOVE",
    fid: 42,
    timestamp: 12,
    hash: "0x" + "33".repeat(20),
    castRemoveBody: { targetHash: bytesToBase64(hexToBytes(add.hash)) },
  });
  store.apply([add, later, remove]);
  const casts = store.castsByFid(42, { pageSize: 1, reverse: false });
  assert.equal(casts.messages.length, 1);
  assert.equal(casts.messages[0].hash, later.hash);
  assert.ok(casts.nextPageToken);
  const page2 = store.castsByFid(42, { pageSize: 10, reverse: false, pageToken: casts.nextPageToken });
  assert.equal(page2.messages.length, 1);
  assert.equal(page2.messages[0].data.type, "MESSAGE_TYPE_CAST_REMOVE");

  const firstName = message({
    type: "MESSAGE_TYPE_USER_DATA_ADD",
    fid: 42,
    timestamp: 1,
    hash: "0x" + "44".repeat(20),
    userDataBody: { type: "USER_DATA_TYPE_DISPLAY", value: "old" },
  });
  const newName = message({
    type: "MESSAGE_TYPE_USER_DATA_ADD",
    fid: 42,
    timestamp: 2,
    hash: "0x" + "55".repeat(20),
    userDataBody: { type: "USER_DATA_TYPE_DISPLAY", value: "new" },
  });
  store.apply([firstName, newName]);
  const names = store.userDataByFid(42, { pageSize: 10, reverse: true });
  assert.equal(names.messages.length, 1);
  assert.equal(names.messages[0].data.userDataBody?.value, "new");
  store.close();
});

test("filesystem and R2-like archives round-trip raw blocks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hypersnap-archive-"));
  try {
    const fsArchive = new FilesystemArchive(dir);
    const bytes = await load(blocks[0].file);
    const key = objectKey("blocks", 0, blocks[0].height);
    await fsArchive.put(key, bytes);
    const stored = await fsArchive.get(key);
    assert.ok(stored);
    assert.deepEqual(stored, bytes);

    const objects = new Map<string, Uint8Array>();
    const r2 = new R2Archive({
      async put(objectKeyName, value) {
        objects.set(objectKeyName, value.slice());
      },
      async get(objectKeyName) {
        const found = objects.get(objectKeyName);
        if (!found) return null;
        const copy = new ArrayBuffer(found.byteLength);
        new Uint8Array(copy).set(found);
        return { arrayBuffer: async () => copy };
      },
    });
    await r2.put(key, bytes);
    const fromR2 = await r2.get(key);
    assert.ok(fromR2);
    assert.deepEqual(fromR2, bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class StaticAdapter implements ChainAdapter {
  readonly epoch = "epoch0" as const;
  constructor(
    readonly id: string,
    private readonly blocks: Uint8Array[],
  ) {}
  async getInfo(): Promise<NodeInfo> {
    return infoFor(this.blocks.length);
  }
  async getBlocks(): Promise<Uint8Array[]> {
    return this.blocks;
  }
  async getShardChunks(): Promise<Uint8Array[]> {
    return this.blocks;
  }
}

class ThrowingAdapter implements ChainAdapter {
  readonly epoch = "epoch0" as const;
  constructor(
    readonly id: string,
    private readonly info: NodeInfo,
  ) {}
  async getInfo(): Promise<NodeInfo> {
    return this.info;
  }
  async getBlocks(): Promise<Uint8Array[]> {
    throw new Error("grpc 404");
  }
  async getShardChunks(): Promise<Uint8Array[]> {
    throw new Error("grpc 404");
  }
}

class FixtureAdapter implements ChainAdapter {
  readonly epoch = "epoch0" as const;
  constructor(
    readonly id: string,
    private readonly blocks: Uint8Array[],
    private readonly chunks: Uint8Array[],
  ) {}
  async getInfo(): Promise<NodeInfo> {
    return {
      version: "fixture",
      peerId: "fixture",
      numShards: 2,
      nextEngineVersionTimestamp: 0,
      shardInfos: [
        shard(0, blocks[1].height + 1),
        shard(2, chunks[1].height + 1),
      ],
    };
  }
  async getBlocks(start: number, stop: number): Promise<Uint8Array[]> {
    return sliceHeights(this.blocks, blocks, start, stop);
  }
  async getShardChunks(shardId: number, start: number, stop: number): Promise<Uint8Array[]> {
    if (shardId !== 2) throw new Error(`unexpected shard ${shardId}`);
    return sliceHeights(this.chunks, chunks, start, stop);
  }
}

function sliceHeights(raws: Uint8Array[], meta: FixtureFile[], start: number, stop: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < meta.length; i++) {
    if (meta[i].height >= start && meta[i].height <= stop) out.push(raws[i]);
  }
  if (out.length === 0) throw new Error(`no units for ${start}..${stop}`);
  return out;
}

function infoFor(height: number): NodeInfo {
  return {
    version: "t",
    peerId: "t",
    numShards: 1,
    nextEngineVersionTimestamp: 0,
    shardInfos: [shard(0, height)],
  };
}

function shard(shardId: number, maxHeight: number): ShardStatus {
  return {
    shardId,
    maxHeight,
    numMessages: 0,
    numFidRegistrations: 0,
    approxSize: 0,
    blockDelay: 0,
    mempoolSize: 0,
  };
}

function asyncStore(store: LocalStore) {
  return {
    apply: async (messages: ApiMessage[]) => store.apply(messages),
    getCursor: async (shardId: number) => store.getCursor(shardId),
    setCursor: async (shardId: number, height: number, hash: Uint8Array) => store.setCursor(shardId, height, hash),
    setTip: async (shardId: number, height: number) => store.setTip(shardId, height),
    addBytes: async (bytes: number) => store.addBytes(bytes),
  };
}

function readModel(store: LocalStore) {
  return {
    info: () => {
      const shards = store.trackedShards();
      return {
        dbStats: {
          numMessages: store.messageCount(),
          numFidRegistrations: store.fidCount(),
          approxSize: store.approxSize(),
        },
        numShards: shards.length,
        shardInfos: shards.map((shardId) => ({
          shardId,
          maxHeight: store.getCursor(shardId)?.height ?? 0,
          numMessages: store.messageCount(),
          numFidRegistrations: store.fidCount(),
          approxSize: store.approxSize(),
          blockDelay: 0,
          mempoolSize: 0,
        })),
        version: "0.1.0",
        peer_id: "hypersnap-v2",
        nextEngineVersionTimestamp: 0,
      };
    },
    castsByFid: (fid: number, query: { pageSize: number; pageToken?: string; reverse: boolean }) =>
      store.castsByFid(fid, query),
    userDataByFid: (fid: number, query: { pageSize: number; pageToken?: string; reverse: boolean }) =>
      store.userDataByFid(fid, query),
  };
}

const oracleFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const shardIndex = Number(url.searchParams.get("shard_index"));
  const units = manifest.units.filter((unit) => unit.shard === shardIndex);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        events: units.map((unit) => ({
          blockConfirmedBody: {
            shardIndex: unit.shard,
            blockNumber: unit.height,
            blockHash: unit.hash,
          },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
};

function message(partial: {
  type: string;
  fid: number;
  timestamp: number;
  hash: string;
  castAddBody?: ApiMessage["data"]["castAddBody"];
  castRemoveBody?: ApiMessage["data"]["castRemoveBody"];
  userDataBody?: ApiMessage["data"]["userDataBody"];
}): ApiMessage {
  return {
    data: {
      type: partial.type,
      fid: partial.fid,
      timestamp: partial.timestamp,
      network: "FARCASTER_NETWORK_MAINNET",
      castAddBody: partial.castAddBody,
      castRemoveBody: partial.castRemoveBody,
      userDataBody: partial.userDataBody,
    },
    hash: partial.hash,
    hashScheme: "HASH_SCHEME_BLAKE3",
    signature: "aaaa",
    signatureScheme: "SIGNATURE_SCHEME_ED25519",
    signer: "0x" + "ab".repeat(32),
  };
}

interface Span {
  field: number;
  start: number;
  end: number;
}

function flipCommitSignature(raw: Uint8Array): Uint8Array {
  const copy = raw.slice();
  const top = spans(copy, 0, copy.length);
  const commits = top.find((span) => span.field === 4);
  if (!commits) throw new Error("no commits");
  const commitFields = spans(copy, commits.start, commits.end);
  const signatureField = commitFields.find((span) => span.field === 4);
  if (!signatureField) throw new Error("no signature");
  const sig = spans(copy, signatureField.start, signatureField.end).find((span) => span.field === 2);
  if (!sig) throw new Error("no signature bytes");
  copy[sig.end - 1] ^= 0xff;
  return copy;
}

function spans(buf: Uint8Array, from: number, to: number): Span[] {
  const out: Span[] = [];
  let i = from;
  while (i < to) {
    const key = readVarint(buf, i);
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buf, i);
      i = value.next;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const start = i;
      const end = i + Number(len.value);
      out.push({ field, start, end });
      i = end;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error(`wire ${wire}`);
    }
  }
  return out;
}
