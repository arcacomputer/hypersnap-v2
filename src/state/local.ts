import { DatabaseSync } from "node:sqlite";
import { hexToBytes } from "../util/bytes.js";
import type { ApiMessage } from "../proto/messages.js";
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
  type PagedMessages,
  type SqlExecutor,
  type SqlValue,
} from "./sql.js";

export interface ShardCursor {
  height: number;
  hash: Uint8Array;
}

export class LocalStore {
  private readonly db: DatabaseSync;
  private readonly sql: SqlExecutor;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.sql = new NodeSql(this.db);
    migrate(this.sql);
  }

  apply(messages: ApiMessage[]): { applied: number; newFids: number } {
    this.db.exec("BEGIN");
    try {
      const result = applyMessages(this.sql, messages);
      const messagesTotal = Number(metaGet(this.sql, "numMessages") ?? "0") + result.applied;
      const fidsTotal = Number(metaGet(this.sql, "numFids") ?? "0") + result.newFids;
      metaSet(this.sql, "numMessages", String(messagesTotal));
      metaSet(this.sql, "numFids", String(fidsTotal));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  castsByFid(fid: number, query: PageQuery): PagedMessages {
    return queryCasts(this.sql, fid, query);
  }

  userDataByFid(fid: number, query: PageQuery): PagedMessages {
    return queryUserData(this.sql, fid, query);
  }

  messageCount(): number {
    return countMessages(this.sql);
  }

  fidCount(): number {
    return countFids(this.sql);
  }

  approxSize(): number {
    return Number(metaGet(this.sql, "approxSize") ?? "0");
  }

  addBytes(bytes: number): void {
    metaSet(this.sql, "approxSize", String(this.approxSize() + bytes));
  }

  getCursor(shard: number): ShardCursor | null {
    const raw = metaGet(this.sql, `cursor:${shard}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { height: number; hash: string };
    return { height: parsed.height, hash: hexToBytes(parsed.hash) };
  }

  setCursor(shard: number, height: number, hash: Uint8Array): void {
    metaSet(this.sql, `cursor:${shard}`, JSON.stringify({ height, hash: toHex(hash) }));
  }

  getTip(shard: number): number | undefined {
    const raw = metaGet(this.sql, `tip:${shard}`);
    return raw === undefined ? undefined : Number(raw);
  }

  setTip(shard: number, height: number): void {
    metaSet(this.sql, `tip:${shard}`, String(height));
  }

  trackedShards(): number[] {
    return this.sql
      .all("SELECT key FROM meta WHERE key LIKE 'cursor:%' ORDER BY key")
      .map((row) => Number(String(row.key).slice("cursor:".length)));
  }

  close(): void {
    this.db.close();
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

class NodeSql implements SqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }
}
