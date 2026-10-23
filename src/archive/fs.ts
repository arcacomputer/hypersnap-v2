import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlockArchive } from "./archive.js";

export class FilesystemArchive implements BlockArchive {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = path.join(this.root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path.join(this.root, key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
