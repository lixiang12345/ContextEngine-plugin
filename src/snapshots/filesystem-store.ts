import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import {
  validateSnapshotObjectKey,
  type SnapshotConditionalWriteResult,
  type SnapshotObjectMetadata,
  type SnapshotObjectRequestOptions,
  type SnapshotObjectStore,
  type SnapshotObjectVersion,
  type SnapshotObjectWriteCondition,
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
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        source,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        { signal: options?.signal },
      );
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const lock = `${target}.contextengine-lock`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await acquireObjectLock(lock, options?.signal);
      options?.signal?.throwIfAborted();
      await assertObjectLockOwner(handle, lock);
      await rename(temporary, target);
    } finally {
      if (handle) await releaseObjectLock(handle, lock);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<Readable> {
    return createReadStream(this.resolveKey(key), { signal: options?.signal });
  }

  async delete(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    const lock = `${target}.contextengine-lock`;
    const handle = await acquireObjectLock(lock, options?.signal);
    try {
      options?.signal?.throwIfAborted();
      await rm(target, { force: true });
    } finally {
      await releaseObjectLock(handle, lock);
    }
  }

  async list(
    prefix = "",
    options?: SnapshotObjectRequestOptions,
  ): Promise<string[]> {
    options?.signal?.throwIfAborted();
    const safePrefix = prefix
      ? validateSnapshotObjectKey(
          `${prefix.replace(/\/+$/, "")}/placeholder`,
        ).replace(/\/placeholder$/, "")
      : "";
    const directory = safePrefix ? this.resolveKey(safePrefix) : this.root;
    const output: string[] = [];
    await walk(directory, this.root, output, options?.signal);
    return output.filter(
      (key) => !safePrefix || key.startsWith(`${safePrefix}/`),
    );
  }

  async head(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotObjectVersion | null> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    const lock = `${target}.contextengine-lock`;
    const handle = await acquireObjectLock(lock, options?.signal);
    try {
      return await fileVersion(target, options?.signal);
    } finally {
      await releaseObjectLock(handle, lock);
    }
  }

  async putConditional(
    key: string,
    source: Readable,
    condition: SnapshotObjectWriteCondition,
    metadata: SnapshotObjectMetadata = {},
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotConditionalWriteResult> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    const hash = createHash("sha256");
    let bytes = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        source,
        digest,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        { signal: options?.signal },
      );
      if (
        metadata.contentLength !== undefined &&
        metadata.contentLength !== bytes
      ) {
        throw new Error(
          `Snapshot object content length mismatch: expected ${metadata.contentLength}, received ${bytes}`,
        );
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    const lock = `${target}.contextengine-lock`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await acquireObjectLock(lock, options?.signal);
      const current = await fileVersion(target, options?.signal);
      const matches = "ifAbsent" in condition
        ? current === null
        : current?.entityTag === condition.entityTag;
      if (!matches) {
        return { written: false, entityTag: current?.entityTag };
      }
      options?.signal?.throwIfAborted();
      await assertObjectLockOwner(handle, lock);
      await rename(temporary, target);
      return {
        written: true,
        entityTag: hash.digest("hex"),
      };
    } finally {
      if (handle) await releaseObjectLock(handle, lock);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
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

async function fileVersion(
  target: string,
  signal?: AbortSignal,
): Promise<SnapshotObjectVersion | null> {
  signal?.throwIfAborted();
  let metadata;
  try {
    metadata = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const hash = createHash("sha256");
  const stream = createReadStream(target, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return { entityTag: hash.digest("hex"), contentLength: metadata.size };
}

async function acquireObjectLock(
  lock: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for snapshot object publication lock; verify no writer is active before removing an orphaned lock",
        );
      }
      await delay(10, undefined, { signal });
    }
  }
}

async function assertObjectLockOwner(
  handle: Awaited<ReturnType<typeof open>>,
  lock: string,
): Promise<void> {
  const [held, current] = await Promise.all([handle.stat(), stat(lock)]);
  if (held.dev !== current.dev || held.ino !== current.ino) {
    throw new Error("Snapshot object publication lock ownership was lost");
  }
}

async function releaseObjectLock(
  handle: Awaited<ReturnType<typeof open>>,
  lock: string,
): Promise<void> {
  try {
    await assertObjectLockOwner(handle, lock);
    await rm(lock, { force: true });
  } catch {
    // A stale owner must never remove a replacement lock.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function walk(
  directory: string,
  root: string,
  output: string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink() || entry.name.endsWith(".contextengine-lock")) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, root, output, signal);
    else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}
