export interface BlockArchive {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export function objectKey(kind: "blocks" | "chunks", shard: number, height: number): string {
  return `${kind}/shard-${shard}/${height}.pb`;
}

export class MemoryArchive implements BlockArchive {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = this.objects.get(key);
    return found ? found.slice() : null;
  }
}

/** Minimal R2 binding surface. The Worker passes env.BLOCK_ARCHIVE. */
export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export class R2Archive implements BlockArchive {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
}
