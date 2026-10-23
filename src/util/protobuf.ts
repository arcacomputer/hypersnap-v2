/** Minimal protobuf wire codec. Enough to hash headers and rebuild vote bytes. */

export interface VarintResult {
  value: bigint;
  next: number;
}

export function readVarint(buf: Uint8Array, offset: number): VarintResult {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i];
    value |= BigInt(b & 0x7f) << shift;
    i++;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

export function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative varint");
  const out: number[] = [];
  let v = value;
  while (v >= 128n) {
    out.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

export type WireField = {
  field: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
};

export function decodeFields(buf: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, i);
      i = v.next;
      fields.push({ field, wire, varint: v.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const n = Number(len.value);
      if (n < 0 || i + n > buf.length) throw new Error("truncated length-delimited field");
      fields.push({ field, wire, bytes: buf.subarray(i, i + n) });
      i += n;
    } else if (wire === 1) {
      i += 8;
      if (i > buf.length) throw new Error("truncated fixed64");
    } else if (wire === 5) {
      i += 4;
      if (i > buf.length) throw new Error("truncated fixed32");
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

export function fieldsByNumber(fields: WireField[], field: number): WireField[] {
  return fields.filter((f) => f.field === field);
}

export function firstBytes(fields: WireField[], field: number): Uint8Array | undefined {
  return fieldsByNumber(fields, field).find((f) => f.bytes)?.bytes;
}

export function firstVarint(fields: WireField[], field: number): bigint | undefined {
  return fieldsByNumber(fields, field).find((f) => f.varint !== undefined)?.varint;
}

export function encodeKey(field: number, wire: number): Uint8Array {
  return encodeVarint(BigInt((field << 3) | wire));
}

export function encodeLengthDelimited(field: number, bytes: Uint8Array): Uint8Array {
  return concat(encodeKey(field, 2), encodeVarint(BigInt(bytes.length)), bytes);
}

export function encodeVarintField(field: number, value: bigint): Uint8Array {
  return concat(encodeKey(field, 0), encodeVarint(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
