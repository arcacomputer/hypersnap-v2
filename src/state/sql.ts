import { castRemoveTargetHex, type ApiMessage } from "../proto/messages.js";
import { base64ToBytes, bytesToBase64 } from "../util/bytes.js";

export interface SqlExecutor {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  all(sql: string, params?: SqlValue[]): Record<string, unknown>[];
}

export type SqlValue = string | number | null;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  fid INTEGER NOT NULL,
  hash TEXT NOT NULL,
  message_type TEXT NOT NULL,
  user_data_type TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fid, hash)
);
CREATE INDEX IF NOT EXISTS idx_messages_fid_type
  ON messages (fid, message_type, removed, timestamp, hash);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface PageQuery {
  pageSize: number;
  pageToken?: string;
  reverse: boolean;
}

export interface PagedMessages {
  messages: ApiMessage[];
  nextPageToken?: string;
}

const CAST_TYPES = ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE"];

export function migrate(db: SqlExecutor): void {
  db.exec(SCHEMA);
}

export function applyMessages(db: SqlExecutor, messages: ApiMessage[]): { applied: number; newFids: number } {
  let applied = 0;
  let newFids = 0;
  for (const message of messages) {
    const fid = message.data.fid;
    const existingFid = db.all("SELECT 1 AS x FROM messages WHERE fid = ? LIMIT 1", [fid]);
    if (existingFid.length === 0) newFids += 1;
    if (message.data.type === "MESSAGE_TYPE_CAST_REMOVE") {
      const target = castRemoveTargetHex(message);
      if (target) {
        db.run("UPDATE messages SET removed = 1 WHERE fid = ? AND hash = ?", [fid, target]);
      }
    }
    if (message.data.type === "MESSAGE_TYPE_USER_DATA_ADD") {
      const userDataType = message.data.userDataBody?.type ?? "";
      db.run(
        "DELETE FROM messages WHERE fid = ? AND message_type = ? AND user_data_type = ?",
        [fid, message.data.type, userDataType],
      );
    }
    db.run(
      `INSERT INTO messages (fid, hash, message_type, user_data_type, timestamp, message_json, removed)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(fid, hash) DO UPDATE SET
         message_type = excluded.message_type,
         user_data_type = excluded.user_data_type,
         timestamp = excluded.timestamp,
         message_json = excluded.message_json,
         removed = 0`,
      [
        fid,
        message.hash,
        message.data.type,
        message.data.userDataBody?.type ?? "",
        message.data.timestamp,
        JSON.stringify(message),
      ],
    );
    applied += 1;
  }
  return { applied, newFids };
}

export function queryCasts(db: SqlExecutor, fid: number, query: PageQuery): PagedMessages {
  return queryByType(db, fid, CAST_TYPES, query);
}

export function queryUserData(db: SqlExecutor, fid: number, query: PageQuery): PagedMessages {
  return queryByType(db, fid, ["MESSAGE_TYPE_USER_DATA_ADD"], query);
}

export function countMessages(db: SqlExecutor): number {
  return Number(db.all("SELECT COUNT(*) AS c FROM messages WHERE removed = 0")[0]?.c ?? 0);
}

export function countFids(db: SqlExecutor): number {
  return Number(db.all("SELECT COUNT(DISTINCT fid) AS c FROM messages")[0]?.c ?? 0);
}

export function metaGet(db: SqlExecutor, key: string): string | undefined {
  const row = db.all("SELECT value FROM meta WHERE key = ?", [key])[0];
  return row ? String(row.value) : undefined;
}

export function metaSet(db: SqlExecutor, key: string, value: string): void {
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

function queryByType(db: SqlExecutor, fid: number, types: string[], query: PageQuery): PagedMessages {
  const placeholders = types.map(() => "?").join(", ");
  const cursor = decodePageToken(query.pageToken);
  const params: SqlValue[] = [fid, ...types];
  let cursorSql = "";
  if (cursor) {
    const cmp = query.reverse ? "<" : ">";
    cursorSql = ` AND (timestamp ${cmp} ? OR (timestamp = ? AND hash ${cmp} ?))`;
    params.push(cursor.timestamp, cursor.timestamp, cursor.hash);
  }
  const direction = query.reverse ? "DESC" : "ASC";
  params.push(query.pageSize + 1);
  const rows = db.all(
    `SELECT message_json FROM messages
     WHERE fid = ? AND removed = 0 AND message_type IN (${placeholders})
     ${cursorSql}
     ORDER BY timestamp ${direction}, hash ${direction}
     LIMIT ?`,
    params,
  );
  const hasMore = rows.length > query.pageSize;
  const page = rows.slice(0, query.pageSize).map((row) => JSON.parse(String(row.message_json)) as ApiMessage);
  const last = page[page.length - 1];
  return {
    messages: page,
    nextPageToken: hasMore && last ? encodePageToken(last.data.timestamp, last.hash) : undefined,
  };
}

export function encodePageToken(timestamp: number, hash: string): string {
  return bytesToBase64(new TextEncoder().encode(`${timestamp}\n${hash}`))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodePageToken(token: string | undefined): { timestamp: number; hash: string } | null {
  if (!token) return null;
  const padded = token.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
  const text = new TextDecoder().decode(base64ToBytes(padded));
  const split = text.indexOf("\n");
  if (split < 0) return null;
  const timestamp = Number(text.slice(0, split));
  const hash = text.slice(split + 1);
  if (!Number.isFinite(timestamp) || !hash.startsWith("0x")) return null;
  return { timestamp, hash };
}
