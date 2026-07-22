import type { Readable } from "node:stream";

export interface SnapshotObjectMetadata {
  contentType?: string;
  contentEncoding?: string;
  contentLength?: number;
  checksumSha256?: string;
}

/** Minimal object-store contract so snapshot transport is host-pluggable. */
export interface SnapshotObjectStore {
  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
  ): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** Optional listing capability used by lifecycle and garbage collection. */
  list?(prefix?: string): Promise<string[]>;
}

/** Restrict a shared object store to one validated key prefix. */
export class PrefixedSnapshotObjectStore implements SnapshotObjectStore {
  private readonly prefix: string;

  constructor(
    private readonly inner: SnapshotObjectStore,
    prefix: string,
  ) {
    this.prefix = validateSnapshotObjectKey(
      `${prefix.replace(/\/+$/, "")}/item`,
    ).replace(/\/item$/, "");
  }

  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
  ): Promise<void> {
    return this.inner.put(this.key(key), source, metadata);
  }

  get(key: string): Promise<Readable> {
    return this.inner.get(this.key(key));
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(this.key(key));
  }

  async list(prefix = ""): Promise<string[]> {
    if (!this.inner.list) {
      throw new Error("Snapshot object store does not support listing");
    }
    const scopedPrefix = prefix ? this.key(prefix) : this.prefix;
    const marker = `${this.prefix}/`;
    return (await this.inner.list(scopedPrefix))
      .filter((key) => key.startsWith(marker))
      .map((key) => key.slice(marker.length));
  }

  private key(key: string): string {
    return `${this.prefix}/${validateSnapshotObjectKey(key)}`;
  }
}

export function validateSnapshotObjectKey(key: string): string {
  if (
    !key ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid snapshot object key: ${key}`);
  }
  return key;
}
