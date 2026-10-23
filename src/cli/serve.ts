import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { emptyInfo, handleRead, type InfoJson, type ReadModel } from "../api/read.js";
import { LocalStore } from "../state/local.js";
import type { PageQuery } from "../state/sql.js";

const dataDir = process.env.HYPERSNAP_DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 8787);
const store = new LocalStore(`${dataDir}/state.sqlite`);

const model: ReadModel = {
  info(): InfoJson {
    const shards = store.trackedShards();
    const base = emptyInfo(shards);
    let messages = 0;
    const shardInfos = shards.map((shardId) => {
      const cursor = store.getCursor(shardId);
      const tip = store.getTip(shardId) ?? cursor?.height ?? 0;
      const height = cursor?.height ?? 0;
      return {
        shardId,
        maxHeight: height,
        numMessages: 0,
        numFidRegistrations: 0,
        approxSize: 0,
        blockDelay: Math.max(0, tip - height),
        mempoolSize: 0,
      };
    });
    messages = store.messageCount();
    return {
      ...base,
      dbStats: {
        numMessages: messages,
        numFidRegistrations: store.fidCount(),
        approxSize: store.approxSize(),
      },
      numShards: shardInfos.length,
      shardInfos: shardInfos.map((info) => ({
        ...info,
        numMessages: messages,
        numFidRegistrations: store.fidCount(),
        approxSize: store.approxSize(),
      })),
    };
  },
  castsByFid(fid: number, query: PageQuery) {
    return store.castsByFid(fid, query);
  },
  userDataByFid(fid: number, query: PageQuery) {
    return store.userDataByFid(fid, query);
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const result = await handleRead(model, url);
  res.writeHead(result.status, {
    "content-type": result.contentType,
    "access-control-allow-origin": "*",
  });
  res.end(result.body);
});

server.listen(port, () => {
  console.log(`hypersnap-v2 read API on http://127.0.0.1:${port}`);
});
