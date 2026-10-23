import { mkdirSync } from "node:fs";
import { FilesystemArchive } from "../archive/fs.js";
import { createNodeGrpcTransport } from "../chain/node-grpc.js";
import { Epoch0Adapter } from "../chain/epoch0.js";
import { FailoverChain } from "../chain/failover.js";
import { DEFAULT_ORACLE_HTTP, DEFAULT_SHARDS, DEFAULT_UPSTREAMS } from "../config.js";
import { followOnce, formatSummary } from "../follower/follow.js";
import { LocalStore } from "../state/local.js";

const maxPerShard = numberFlag("--max", 4);
const shards = (process.env.HYPERSNAP_SHARDS ?? DEFAULT_SHARDS.join(","))
  .split(",")
  .map((part) => Number(part.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
const dataDir = process.env.HYPERSNAP_DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const oracle = process.env.HYPERSNAP_ORACLE ?? DEFAULT_ORACLE_HTTP;

const transport = createNodeGrpcTransport();
const chain = new FailoverChain(
  DEFAULT_UPSTREAMS.map((upstream) => new Epoch0Adapter(upstream, transport)),
);
const store = new LocalStore(`${dataDir}/state.sqlite`);
const archive = new FilesystemArchive(`${dataDir}/archive`);

const summary = await followOnce({
  chain,
  store: {
    apply: async (messages) => store.apply(messages),
    getCursor: async (shard) => store.getCursor(shard),
    setCursor: async (shard, height, hash) => store.setCursor(shard, height, hash),
    setTip: async (shard, height) => store.setTip(shard, height),
    addBytes: async (bytes) => store.addBytes(bytes),
  },
  archive,
  shards,
  maxPerShard,
  lag: 2,
  oracleHttp: oracle || undefined,
});
console.log(formatSummary(summary));
store.close();

function numberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
