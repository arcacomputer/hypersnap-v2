import { DurableObject } from "cloudflare:workers";
import { handleRead, emptyInfo, type InfoJson, type ReadModel } from "./api/read.js";
import { R2Archive } from "./archive/archive.js";
import { Epoch0Adapter } from "./chain/epoch0.js";
import { createFetchGrpcTransport } from "./chain/fetch-grpc.js";
import { FailoverChain } from "./chain/failover.js";
import { DEFAULT_ORACLE_HTTP, DEFAULT_SHARDS, DEFAULT_UPSTREAMS, type Upstream } from "./config.js";
import { followOnce, type FollowerStore, type ShardCursor } from "./follower/follow.js";
import type { ApiMessage } from "./proto/messages.js";
import { hexToBytes, bytesToHex } from "./util/bytes.js";
import {
  applyMessages,
  countFids,
  countMessages,
  metaGet,
  metaSet,
  migrate,
  queryCasts,
  queryUserData,
  type PageQuery,
  type SqlExecutor,
  type SqlValue,
} from "./state/sql.js";

/** Optional JSON override of DEFAULT_UPSTREAMS. Not a Wrangler binding. */
type RuntimeEnv = Env & { UPSTREAMS?: string };

export class FidStateDurableObject extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(sqlFrom(this.ctx.storage.sql));
    });
  }

  async apply(messages: ApiMessage[]): Promise<{ applied: number; newFids: number }> {
    return applyMessages(sqlFrom(this.ctx.storage.sql), messages);
  }

  async castsByFid(query: PageQuery): Promise<{ messages: ApiMessage[]; nextPageToken?: string }> {
    return queryCasts(sqlFrom(this.ctx.storage.sql), this.fid(), query);
  }

  async userDataByFid(query: PageQuery): Promise<{ messages: ApiMessage[]; nextPageToken?: string }> {
    return queryUserData(sqlFrom(this.ctx.storage.sql), this.fid(), query);
  }

  async counts(): Promise<{ messages: number; fids: number }> {
    const sql = sqlFrom(this.ctx.storage.sql);
    return { messages: countMessages(sql), fids: countFids(sql) };
  }

  private fid(): number {
    const name = this.ctx.id.name;
    if (!name) throw new Error("fid durable object requires a named id");
    return Number(name);
  }
}

export class FollowerDurableObject extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(sqlFrom(this.ctx.storage.sql));
    });
  }

  async tick(): Promise<{ verified: number; applied: number; rejected: number }> {
    const transport = createFetchGrpcTransport(fetch);
    const upstreams = parseUpstreams(this.env.UPSTREAMS);
    const chain = new FailoverChain(upstreams.map((upstream) => new Epoch0Adapter(upstream, transport, fetch)));
    const store = new DurableFollowerStore(this.env, sqlFrom(this.ctx.storage.sql));
    const archive = new R2Archive(this.env.BLOCK_ARCHIVE);
    const shards = (this.env.SHARDS ?? DEFAULT_SHARDS.join(","))
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n));
    const summary = await followOnce({
      chain,
      store,
      archive,
      shards,
      maxPerShard: Number(this.env.MAX_PER_SHARD ?? "2") || 2,
      lag: 2,
      oracleHttp: this.env.ORACLE_HTTP ?? DEFAULT_ORACLE_HTTP,
      fetchImpl: fetch,
    });
    return { verified: summary.verified, applied: summary.applied, rejected: summary.rejected };
  }

  async info(): Promise<InfoJson> {
    const sql = sqlFrom(this.ctx.storage.sql);
    const shards = sql
      .all("SELECT key FROM meta WHERE key LIKE 'cursor:%' ORDER BY key")
      .map((row) => Number(String(row.key).slice("cursor:".length)));
    const base = emptyInfo(shards);
    const numMessages = Number(metaGet(sql, "numMessages") ?? "0");
    const numFids = Number(metaGet(sql, "numFids") ?? "0");
    const approxSize = Number(metaGet(sql, "approxSize") ?? "0");
    return {
      ...base,
      dbStats: { numMessages, numFidRegistrations: numFids, approxSize },
      shardInfos: shards.map((shardId) => {
        const cursor = metaGet(sql, `cursor:${shardId}`);
        const parsed = cursor ? (JSON.parse(cursor) as { height: number }) : { height: 0 };
        const tip = Number(metaGet(sql, `tip:${shardId}`) ?? parsed.height);
        return {
          shardId,
          maxHeight: parsed.height,
          numMessages,
          numFidRegistrations: numFids,
          approxSize,
          blockDelay: Math.max(0, tip - parsed.height),
          mempoolSize: 0,
        };
      }),
    };
  }
}

class DurableFollowerStore implements FollowerStore {
  constructor(
    private readonly env: RuntimeEnv,
    private readonly sql: SqlExecutor,
  ) {}

  async apply(messages: ApiMessage[]): Promise<{ applied: number }> {
    const byFid = new Map<number, ApiMessage[]>();
    for (const message of messages) {
      const list = byFid.get(message.data.fid) ?? [];
      list.push(message);
      byFid.set(message.data.fid, list);
    }
    let applied = 0;
    let newFids = 0;
    for (const [fid, batch] of byFid) {
      const stub = this.env.FID_STATE.get(this.env.FID_STATE.idFromName(String(fid)));
      const result = await stub.apply(batch);
      applied += result.applied;
      newFids += result.newFids;
    }
    metaSet(this.sql, "numMessages", String(Number(metaGet(this.sql, "numMessages") ?? "0") + applied));
    metaSet(this.sql, "numFids", String(Number(metaGet(this.sql, "numFids") ?? "0") + newFids));
    return { applied };
  }

  async getCursor(shard: number): Promise<ShardCursor | null> {
    const raw = metaGet(this.sql, `cursor:${shard}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { height: number; hash: string };
    return { height: parsed.height, hash: hexToBytes(parsed.hash) };
  }

  async setCursor(shard: number, height: number, hash: Uint8Array): Promise<void> {
    metaSet(this.sql, `cursor:${shard}`, JSON.stringify({ height, hash: bytesToHex(hash) }));
  }

  async setTip(shard: number, height: number): Promise<void> {
    metaSet(this.sql, `tip:${shard}`, String(height));
  }

  async addBytes(bytes: number): Promise<void> {
    const current = Number(metaGet(this.sql, "approxSize") ?? "0");
    metaSet(this.sql, "approxSize", String(current + bytes));
  }
}

function parseUpstreams(raw: string | undefined): Upstream[] {
  if (!raw) return DEFAULT_UPSTREAMS;
  const parsed = JSON.parse(raw) as Upstream[];
  if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_UPSTREAMS;
  return parsed;
}

function sqlFrom(sql: SqlStorage): SqlExecutor {
  return {
    exec(statement: string) {
      sql.exec(statement);
    },
    run(statement: string, params: SqlValue[] = []) {
      sql.exec(statement, ...params);
    },
    all(statement: string, params: SqlValue[] = []) {
      return sql.exec(statement, ...params).toArray() as Record<string, unknown>[];
    },
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const follower = env.FOLLOWER.get(env.FOLLOWER.idFromName("global"));
    const model: ReadModel = {
      info: () => follower.info(),
      castsByFid: (fid, query) => env.FID_STATE.get(env.FID_STATE.idFromName(String(fid))).castsByFid(query),
      userDataByFid: (fid, query) =>
        env.FID_STATE.get(env.FID_STATE.idFromName(String(fid))).userDataByFid(query),
    };
    const result = await handleRead(model, url);
    const headers = corsHeaders();
    headers["content-type"] = result.contentType;
    return new Response(result.body, { status: result.status, headers });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const follower = env.FOLLOWER.get(env.FOLLOWER.idFromName("global"));
    const tick = follower.tick();
    ctx.waitUntil(tick);
    await tick;
  },
} satisfies ExportedHandler<RuntimeEnv>;

function corsHeaders(): Record<string, string> {
  return { "access-control-allow-origin": "*" };
}
