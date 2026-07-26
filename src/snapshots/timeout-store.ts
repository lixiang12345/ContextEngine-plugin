import { finished, type Readable } from "node:stream";
import type {
  SnapshotConditionalWriteResult,
  SnapshotObjectMetadata,
  SnapshotObjectRequestOptions,
  SnapshotObjectStore,
  SnapshotObjectVersion,
  SnapshotObjectWriteCondition,
} from "./object-store.js";

export interface SnapshotStoreTimeouts {
  /** Bounded operations: head, list, delete, and conditional (CAS) writes.
   * 0 or null disables the deadline. */
  metadataMs?: number | null;
  /** Streaming transfers: put and get. Artifact size is unbounded, so this
   * defaults to disabled; operators size it to their artifacts. */
  transferMs?: number | null;
}

type SnapshotStoreOperation =
  | "put"
  | "get"
  | "delete"
  | "list"
  | "head"
  | "putConditional";

/** Raised when a store operation exceeds its configured deadline, so callers
 * can distinguish an operation timeout from a caller-driven abort. */
export class SnapshotStoreTimeoutError extends Error {
  readonly operation: SnapshotStoreOperation;
  readonly timeoutMs: number;

  constructor(operation: SnapshotStoreOperation, timeoutMs: number) {
    super(`Snapshot store ${operation} timed out after ${timeoutMs}ms`);
    this.name = "SnapshotStoreTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** Decorate a store so every operation carries an independent deadline
 * signal combined with the caller's AbortSignal. Optional capabilities are
 * forwarded conditionally so minimal third-party stores stay minimal. */
export function withSnapshotStoreTimeouts(
  store: SnapshotObjectStore,
  timeouts: SnapshotStoreTimeouts,
): SnapshotObjectStore {
  const metadataMs = normalizeTimeout(timeouts.metadataMs);
  const transferMs = normalizeTimeout(timeouts.transferMs);
  if (!metadataMs && !transferMs) return store;

  const run = async <T>(
    operation: SnapshotStoreOperation,
    timeoutMs: number | null,
    options: SnapshotObjectRequestOptions | undefined,
    invoke: (options: SnapshotObjectRequestOptions | undefined) => Promise<T>,
  ): Promise<T> => {
    if (!timeoutMs) return invoke(options);
    // The deadline both aborts the combined signal (so cooperative stores
    // clean up) and races the pending promise (so a store call stuck in a
    // non-signal-aware syscall — e.g. fs mkdir on a hung mount — still
    // settles for the caller instead of pinning the operation forever).
    const timeoutError = new SnapshotStoreTimeoutError(operation, timeoutMs);
    const deadline = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const signal = options?.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const pending = invoke({ ...options, signal });
    // An orphaned store call that loses the race must not surface later as
    // an unhandled rejection.
    pending.catch(() => undefined);
    try {
      return await Promise.race([pending, expired]);
    } catch (error) {
      // The caller's own abort must keep its original error; only a fired
      // deadline is rewritten into the classifiable timeout error.
      if (deadline.signal.aborted && !options?.signal?.aborted) {
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const guarded: SnapshotObjectStore = {
    put: (key, source, metadata, options) =>
      run("put", transferMs, options, (o) => store.put(key, source, metadata, o)),
    get: async (key, options) => {
      const stream = await run("get", transferMs, options, (o) =>
        store.get(key, o),
      );
      // The acquisition deadline above only covers obtaining the stream
      // handle (filesystem returns it synchronously; S3 resolves on response
      // headers). Arm a second deadline over the body transfer itself so a
      // stalled download destroys the stream instead of hanging its consumer.
      if (transferMs) {
        const timer = setTimeout(() => {
          stream.destroy(new SnapshotStoreTimeoutError("get", transferMs));
        }, transferMs);
        finished(stream, () => clearTimeout(timer));
      }
      return stream;
    },
    delete: (key, options) =>
      run("delete", metadataMs, options, (o) => store.delete(key, o)),
  };
  if (store.list) {
    guarded.list = (prefix?: string, options?: SnapshotObjectRequestOptions) =>
      run("list", metadataMs, options, (o) => store.list!(prefix, o));
  }
  if (store.head) {
    guarded.head = (
      key: string,
      options?: SnapshotObjectRequestOptions,
    ): Promise<SnapshotObjectVersion | null> =>
      run("head", metadataMs, options, (o) => store.head!(key, o));
  }
  if (store.putConditional) {
    guarded.putConditional = (
      key: string,
      source: Readable,
      condition: SnapshotObjectWriteCondition,
      metadata?: SnapshotObjectMetadata,
      options?: SnapshotObjectRequestOptions,
    ): Promise<SnapshotConditionalWriteResult> =>
      run("putConditional", metadataMs, options, (o) =>
        store.putConditional!(key, source, condition, metadata, o),
      );
  }
  return guarded;
}

function normalizeTimeout(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}
