import { PEER_ID, VERSION } from "../version.js";
import type { PageQuery, PagedMessages } from "../state/sql.js";

export interface InfoJson {
  dbStats: {
    numMessages: number;
    numFidRegistrations: number;
    approxSize: number;
  };
  numShards: number;
  shardInfos: Array<{
    shardId: number;
    maxHeight: number;
    numMessages: number;
    numFidRegistrations: number;
    approxSize: number;
    blockDelay: number;
    mempoolSize: number;
  }>;
  version: string;
  peer_id: string;
  nextEngineVersionTimestamp: number;
}

export interface ReadModel {
  info(): InfoJson | Promise<InfoJson>;
  castsByFid(fid: number, query: PageQuery): PagedMessages | Promise<PagedMessages>;
  userDataByFid(fid: number, query: PageQuery): PagedMessages | Promise<PagedMessages>;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

export async function handleRead(model: ReadModel, url: URL): Promise<HttpResult> {
  if (url.pathname === "/v1/info") {
    return json(200, await model.info());
  }
  if (url.pathname === "/v1/castsByFid" || url.pathname === "/v1/userDataByFid") {
    const fidRaw = url.searchParams.get("fid");
    if (fidRaw === null || fidRaw === "") {
      return {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "Invalid query parameters: missing field `fid`",
      };
    }
    const fid = Number(fidRaw);
    if (!Number.isInteger(fid) || fid < 0) {
      return {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "Invalid query parameters: missing field `fid`",
      };
    }
    const query = parsePage(url);
    const page =
      url.pathname === "/v1/castsByFid"
        ? await model.castsByFid(fid, query)
        : await model.userDataByFid(fid, query);
    return json(200, page.nextPageToken ? page : { messages: page.messages });
  }
  return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not Found" };
}

export function emptyInfo(shards: number[] = []): InfoJson {
  return {
    dbStats: { numMessages: 0, numFidRegistrations: 0, approxSize: 0 },
    numShards: shards.length,
    shardInfos: shards.map((shardId) => ({
      shardId,
      maxHeight: 0,
      numMessages: 0,
      numFidRegistrations: 0,
      approxSize: 0,
      blockDelay: 0,
      mempoolSize: 0,
    })),
    version: VERSION,
    peer_id: PEER_ID,
    nextEngineVersionTimestamp: 0,
  };
}

function parsePage(url: URL): PageQuery {
  const raw = url.searchParams.get("pageSize") ?? url.searchParams.get("page_size") ?? "100";
  let pageSize = Number(raw);
  if (!Number.isInteger(pageSize) || pageSize <= 0) pageSize = 100;
  if (pageSize > 1000) pageSize = 1000;
  const reverseRaw = url.searchParams.get("reverse");
  const reverse = reverseRaw === "true" || reverseRaw === "1";
  const pageToken = url.searchParams.get("pageToken") ?? url.searchParams.get("page_token") ?? undefined;
  return { pageSize, reverse, pageToken };
}

function json(status: number, body: unknown): HttpResult {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}
