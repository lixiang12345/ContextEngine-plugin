import type { Readable } from "node:stream";

export interface SnapshotObjectMetadata {
  contentType?: string;
  contentEncoding?: string;
  contentLength?: number;
  checksumSha256?: string;
}

export interface SnapshotObjectRequestOptions {
  signal?: AbortSignal;
}

export interface SnapshotObjectVersion {
  entityTag: string;
  contentLength?: number;
}

export type SnapshotObjectWriteCondition =
  | { ifAbsent: true }
  | { entityTag: string };

export interface SnapshotConditionalWriteResult {
  written: boolean;
  entityTag?: string;
}

/** Minimal object-store contract so snapshot transport is host-pluggable. */
export interface SnapshotObjectStore {
  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void>;
  get(key: string, options?: SnapshotObjectRequestOptions): Promise<Readable>;
  delete(key: string, options?: SnapshotObjectRequestOptions): Promise<void>;
  /** Optional listing capability used by lifecycle and garbage collection. */
  list?(prefix?: string, options?: SnapshotObjectRequestOptions): Promise<string[]>;
  /** Optional optimistic-concurrency capability used for fenced publication.
   * Implementations must honor request abort signals for bounded lease guards. */
  head?(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotObjectVersion | null>;
  putConditional?(
    key: string,
    source: Readable,
    condition: SnapshotObjectWriteCondition,
    metadata?: SnapshotObjectMetadata,
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotConditionalWriteResult>;
}

export type ConditionalSnapshotObjectStore = SnapshotObjectStore &
  Required<Pick<SnapshotObjectStore, "head" | "putConditional">>;

export function supportsConditionalSnapshotWrites(
  store: SnapshotObjectStore,
): store is ConditionalSnapshotObjectStore {
  return (
    typeof store.head === "function" &&
    typeof store.putConditional === "function"
  );
}

/** Restrict a shared object store to one validated key prefix. */
export class PrefixedSnapshotObjectStore implements SnapshotObjectStore {
  private readonly prefix: string;
  readonly head?: NonNullable<SnapshotObjectStore["head"]>;
  readonly putConditional?: NonNullable<SnapshotObjectStore["putConditional"]>;

  constructor(
    private readonly inner: SnapshotObjectStore,
    prefix: string,
  ) {
    this.prefix = validateSnapshotObjectKey(
      `${prefix.replace(/\/+$/, "")}/item`,
    ).replace(/\/item$/, "");
    if (inner.head) {
      this.head = (key, options) => inner.head!(this.key(key), options);
    }
    if (inner.putConditional) {
      this.putConditional = (key, source, condition, metadata, options) =>
        inner.putConditional!(this.key(key), source, condition, metadata, options);
    }
  }

  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    return this.inner.put(this.key(key), source, metadata, options);
  }

  get(key: string, options?: SnapshotObjectRequestOptions): Promise<Readable> {
    return this.inner.get(this.key(key), options);
  }

  delete(key: string, options?: SnapshotObjectRequestOptions): Promise<void> {
    return this.inner.delete(this.key(key), options);
  }

  async list(
    prefix = "",
    options?: SnapshotObjectRequestOptions,
  ): Promise<string[]> {
    if (!this.inner.list) {
      throw new Error("Snapshot object store does not support listing");
    }
    const scopedPrefix = prefix ? this.key(prefix) : this.prefix;
    const marker = `${this.prefix}/`;
    return (await this.inner.list(scopedPrefix, options))
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
