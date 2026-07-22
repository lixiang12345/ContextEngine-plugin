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
