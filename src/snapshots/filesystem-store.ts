import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  validateSnapshotObjectKey,
  type SnapshotObjectMetadata,
  type SnapshotObjectStore,
} from "./object-store.js";

export class FilesystemSnapshotStore implements SnapshotObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(
    key: string,
    source: Readable,
    _metadata?: SnapshotObjectMetadata,
  ): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        source,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  private resolveKey(key: string): string {
    const validated = validateSnapshotObjectKey(key);
    const resolved = path.resolve(this.root, ...validated.split("/"));
    if (
      resolved === this.root ||
      !resolved.startsWith(`${this.root}${path.sep}`)
    ) {
      throw new Error(`Snapshot object escapes store root: ${key}`);
    }
    return resolved;
  }
}
