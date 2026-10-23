import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Epoch0Adapter } from "../chain/epoch0.js";
import { createNodeGrpcTransport } from "../chain/node-grpc.js";
import { oracleAgrees, recentConfirmed } from "../chain/oracle.js";
import { DEFAULT_ORACLE_HTTP } from "../config.js";
import { bytesToHex } from "../util/bytes.js";
import { verifySequence } from "../verify/block.js";
import { MAINNET_VALIDATOR_SETS } from "../verify/validators.js";

const outDir = path.resolve("test/fixtures");
const transport = createNodeGrpcTransport(20_000);
const source = new Epoch0Adapter(
  {
    id: "snap-farcaster",
    httpBase: "https://snap.farcaster.xyz:3381",
    grpcBase: "https://snap.farcaster.xyz:3383",
  },
  transport,
);

const info = await source.getInfo();
const blockTip = info.shardInfos.find((shard) => shard.shardId === 0)!.maxHeight;
const chunkTip = info.shardInfos.find((shard) => shard.shardId === 2)!.maxHeight;
const blockStart = blockTip - 6;
const blocks = await source.getBlocks(blockStart, blockStart + 1);
const verifiedBlocks = verifySequence(blocks, {
  kind: "block",
  validatorSets: MAINNET_VALIDATOR_SETS,
  expectedChainId: 1,
  startHeight: blockStart,
  previousHash: null,
});

let chunkStart = chunkTip - 30;
let chosen: Uint8Array[] = [];
let chosenStart = chunkStart;
for (let height = chunkTip - 30; height < chunkTip - 2; height++) {
  const chunks = await source.getShardChunks(2, height, height);
  const unit = verifySequence(chunks, {
    kind: "chunk",
    validatorSets: MAINNET_VALIDATOR_SETS,
    expectedChainId: 1,
    startHeight: height,
    previousHash: null,
  })[0];
  if (unit.messages.length > 0) {
    const next = await source.getShardChunks(2, height + 1, height + 1);
    chosen = [chunks[0], next[0]];
    chosenStart = height;
    break;
  }
}
if (chosen.length !== 2) {
  chosen = await source.getShardChunks(2, chunkStart, chunkStart + 1);
  chosenStart = chunkStart;
}
const verifiedChunks = verifySequence(chosen, {
  kind: "chunk",
  validatorSets: MAINNET_VALIDATOR_SETS,
  expectedChainId: 1,
  startHeight: chosenStart,
  previousHash: null,
});

await mkdir(outDir, { recursive: true });
const files: Array<{ kind: "block" | "chunk"; shard: number; height: number; file: string; hash: string; messages: number; signers: number; validators: number }> = [];
for (const unit of verifiedBlocks) {
  const file = `block-shard0-${unit.height}.pb`;
  await writeFile(path.join(outDir, file), unit.raw);
  files.push({
    kind: "block",
    shard: 0,
    height: unit.height,
    file,
    hash: bytesToHex(unit.hash, true),
    messages: unit.messages.length,
    signers: unit.signers,
    validators: unit.validators,
  });
}
for (const unit of verifiedChunks) {
  const file = `chunk-shard2-${unit.height}.pb`;
  await writeFile(path.join(outDir, file), unit.raw);
  files.push({
    kind: "chunk",
    shard: 2,
    height: unit.height,
    file,
    hash: bytesToHex(unit.hash, true),
    messages: unit.messages.length,
    signers: unit.signers,
    validators: unit.validators,
  });
}

const oracle = await recentConfirmed(DEFAULT_ORACLE_HTTP, 2).catch(() => []);
const oracleNotes = verifiedChunks.map((unit) => ({
  height: unit.height,
  agreement: oracleAgrees(oracle, unit.shard, unit.height, unit.hash),
}));

await writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify(
    {
      recordedFrom: "https://snap.farcaster.xyz:3383",
      httpInfo: "https://snap.farcaster.xyz:3381/v1/info",
      oracle: DEFAULT_ORACLE_HTTP,
      recordedAt: new Date().toISOString(),
      nodeVersion: info.version,
      units: files,
      oracleNotes,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ files, oracleNotes }, null, 2));
