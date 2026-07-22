import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
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

  async list(prefix = ""): Promise<string[]> {
    const safePrefix = prefix
      ? validateSnapshotObjectKey(
          `${prefix.replace(/\/+$/, "")}/placeholder`,
        ).replace(/\/placeholder$/, "")
      : "";
    const directory = safePrefix ? this.resolveKey(safePrefix) : this.root;
    const output: string[] = [];
    await walk(directory, this.root, output);
    return output.filter(
      (key) => !safePrefix || key.startsWith(`${safePrefix}/`),
    );
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

async function walk(
  directory: string,
  root: string,
  output: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, root, output);
    else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}
