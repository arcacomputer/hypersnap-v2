import { bytesToBase64, bytesToHex, base64ToBytes, hexToBytes } from "../util/bytes.js";
import { MessageType } from "./root.js";

export interface CastIdJson {
  fid: number;
  hash: string;
}

export interface CastAddJson {
  embedsDeprecated: string[];
  mentions: number[];
  parentCastId: CastIdJson | null;
  parentUrl: string | null;
  text: string;
  embeds: Array<{ url: string } | { castId: CastIdJson }>;
  mentionsPositions: number[];
  type: string;
}

export interface ApiMessage {
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
    castAddBody?: CastAddJson;
    castRemoveBody?: { targetHash: string };
    userDataBody?: { type: string; value: string };
    reactionBody?: Record<string, unknown>;
    linkBody?: Record<string, unknown>;
  };
  hash: string;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  signer: string;
}

export function messageFromBytes(bytes: Uint8Array): ApiMessage {
  const decoded = MessageType.decode(bytes);
  const obj = MessageType.toObject(decoded, {
    longs: Number,
    enums: String,
    bytes: String,
    defaults: false,
    oneofs: true,
  }) as Record<string, unknown>;
  const data = (obj.data ?? {}) as Record<string, unknown>;
  const message: ApiMessage = {
    data: {
      type: String(data.type ?? "MESSAGE_TYPE_NONE"),
      fid: Number(data.fid ?? 0),
      timestamp: Number(data.timestamp ?? 0),
      network: String(data.network ?? "FARCASTER_NETWORK_NONE"),
    },
    hash: bytesToHex(asBytes(obj.hash), true),
    hashScheme: String(obj.hashScheme ?? "HASH_SCHEME_BLAKE3"),
    signature: typeof obj.signature === "string" ? obj.signature : bytesToBase64(asBytes(obj.signature)),
    signatureScheme: String(obj.signatureScheme ?? "SIGNATURE_SCHEME_ED25519"),
    signer: bytesToHex(asBytes(obj.signer), true),
  };
  if (data.castAddBody && typeof data.castAddBody === "object") {
    message.data.castAddBody = mapCastAdd(data.castAddBody as Record<string, unknown>);
  }
  if (data.castRemoveBody && typeof data.castRemoveBody === "object") {
    const body = data.castRemoveBody as Record<string, unknown>;
    message.data.castRemoveBody = {
      targetHash:
        typeof body.targetHash === "string" ? body.targetHash : bytesToBase64(asBytes(body.targetHash)),
    };
  }
  if (data.userDataBody && typeof data.userDataBody === "object") {
    const body = data.userDataBody as Record<string, unknown>;
    message.data.userDataBody = {
      type: String(body.type ?? "USER_DATA_TYPE_NONE"),
      value: String(body.value ?? ""),
    };
  }
  if (data.reactionBody && typeof data.reactionBody === "object") {
    message.data.reactionBody = mapReaction(data.reactionBody as Record<string, unknown>);
  }
  if (data.linkBody && typeof data.linkBody === "object") {
    const body = data.linkBody as Record<string, unknown>;
    message.data.linkBody = {
      type: String(body.type ?? ""),
      displayTimestamp: body.displayTimestamp === undefined ? undefined : Number(body.displayTimestamp),
      targetFid: Number(body.targetFid ?? 0),
    };
  }
  return message;
}

export function castRemoveTargetHex(message: ApiMessage): string | undefined {
  const target = message.data.castRemoveBody?.targetHash;
  if (!target) return undefined;
  return bytesToHex(base64ToBytes(target), true);
}

function mapCastAdd(body: Record<string, unknown>): CastAddJson {
  const embeds = Array.isArray(body.embeds) ? body.embeds : [];
  return {
    embedsDeprecated: stringList(body.embedsDeprecated),
    mentions: numberList(body.mentions),
    parentCastId: mapCastId(body.parentCastId),
    parentUrl: typeof body.parentUrl === "string" ? body.parentUrl : null,
    text: String(body.text ?? ""),
    embeds: embeds.map((embed) => mapEmbed(embed as Record<string, unknown>)),
    mentionsPositions: numberList(body.mentionsPositions),
    type: String(body.type ?? "CAST"),
  };
}

function mapEmbed(embed: Record<string, unknown>): { url: string } | { castId: CastIdJson } {
  if (typeof embed.url === "string") return { url: embed.url };
  const castId = mapCastId(embed.castId);
  if (castId) return { castId };
  return { url: "" };
}

function mapCastId(value: unknown): CastIdJson | null {
  if (!value || typeof value !== "object") return null;
  const cast = value as Record<string, unknown>;
  return { fid: Number(cast.fid ?? 0), hash: bytesToHex(asBytes(cast.hash), true) };
}

function mapReaction(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: String(body.type ?? "REACTION_TYPE_NONE") };
  const castId = mapCastId(body.targetCastId);
  if (castId) out.targetCastId = castId;
  if (typeof body.targetUrl === "string") out.targetUrl = body.targetUrl;
  return out;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    if (value.startsWith("0x")) return hexToBytes(value);
    return base64ToBytes(value);
  }
  if (value && typeof value === "object" && "length" in value) {
    return Uint8Array.from(value as ArrayLike<number>);
  }
  return new Uint8Array();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => Number(item)) : [];
}
