import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import {
  supportsConditionalSnapshotWrites,
  type SnapshotObjectStore,
} from "./object-store.js";
import {
  classifySnapshotStoreError,
  type SnapshotStoreErrorClassification,
} from "./store-errors.js";

const DEFAULT_PROBE_OPERATION_TIMEOUT_MS = 10_000;
const MAX_PROBE_ERROR_CHARS = 200;
const MAX_PROBE_READ_BYTES = 4096;
/** Orphaned probe objects (a crash between write and delete) become sweepable
 * once they are clearly not part of a concurrent probe. */
const STALE_PROBE_OBJECT_AGE_MS = 60 * 60_000;
const MAX_STALE_PROBE_SWEEP = 8;

export interface SnapshotStoreCapacity {
  availableBytes: number | null;
  totalBytes: number | null;
}

export interface SnapshotStoreProbeOptions {
  signal?: AbortSignal;
  /** Independent deadline applied to every probe operation. */
  operationTimeoutMs?: number;
  /** Optional capacity reader; filesystem targets report free space, object
   * stores without a capacity API report null. */
  capacity?: () => Promise<SnapshotStoreCapacity | null>;
}

export type SnapshotStoreProbeOperation =
  | "write"
  | "head"
  | "read"
  | "conditional_write"
  | "list"
  | "delete";

export interface SnapshotStoreProbeCheck {
  operation: SnapshotStoreProbeOperation;
  status: "ok" | "failed" | "skipped";
  latencyMs?: number;
  classification?: SnapshotStoreErrorClassification;
  error?: string;
}

export interface SnapshotStoreProbeResult {
  ok: boolean;
  capabilities: { list: boolean; head: boolean; conditionalWrite: boolean };
  checks: SnapshotStoreProbeCheck[];
  capacity: SnapshotStoreCapacity | null;
  operationTimeoutMs: number;
  durationMs: number;
}

/** Exercise a snapshot object store end to end with one short-lived probe
 * object: write, read-after-write, optional head/CAS/list capability checks,
 * and cleanup. Never throws for store failures — every outcome is reported as
 * a bounded, credential-free check result. */
export async function probeSnapshotObjectStore(
  store: SnapshotObjectStore,
  options: SnapshotStoreProbeOptions = {},
): Promise<SnapshotStoreProbeResult> {
  const startedAt = performance.now();
  const operationTimeoutMs = Math.max(
    100,
    Math.min(
      120_000,
      Math.floor(options.operationTimeoutMs ?? DEFAULT_PROBE_OPERATION_TIMEOUT_MS),
    ),
  );
  const probeId = randomUUID();
  const key = `probe/${Date.now()}-${probeId}`;
  const payload = `contextengine-probe ${probeId}`;
  const payloadBytes = Buffer.byteLength(payload);
  const capabilities = {
    list: typeof store.list === "function",
    head: typeof store.head === "function",
    conditionalWrite: supportsConditionalSnapshotWrites(store),
  };
  const checks: SnapshotStoreProbeCheck[] = [];

  const race = async <T>(
    operation: string,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<
    | { ok: true; value: T }
    | { ok: false; error: unknown; timedOut: boolean }
  > => {
    // The deadline both aborts the combined signal (cooperative stores clean
    // up) and races the pending promise, so a call stuck in a non-signal-aware
    // syscall — e.g. fs mkdir on a hung network mount — still settles instead
    // of pinning the probe request forever.
    const timeoutError = new Error(
      `snapshot store probe ${operation} timed out after ${operationTimeoutMs}ms`,
    );
    const deadline = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.abort(timeoutError);
        reject(timeoutError);
      }, operationTimeoutMs);
    });
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const pending = invoke(signal);
    // A hung store call that loses the race must not surface later as an
    // unhandled rejection.
    Promise.resolve(pending).catch(() => undefined);
    try {
      const value = await Promise.race([pending, expired]);
      return { ok: true, value };
    } catch (error) {
      const timedOut = deadline.signal.aborted && !options.signal?.aborted;
      return { ok: false, error: timedOut ? timeoutError : error, timedOut };
    } finally {
      clearTimeout(timer);
    }
  };

  const attempt = async (
    operation: SnapshotStoreProbeOperation,
    invoke: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> => {
    const opStartedAt = performance.now();
    const outcome = await race(operation, invoke);
    if (outcome.ok) {
      checks.push({
        operation,
        status: "ok",
        latencyMs: roundLatency(performance.now() - opStartedAt),
      });
      return true;
    }
    checks.push({
      operation,
      status: "failed",
      latencyMs: roundLatency(performance.now() - opStartedAt),
      classification: outcome.timedOut
        ? "timeout"
        : classifySnapshotStoreError(outcome.error),
      error: boundedErrorMessage(outcome.error),
    });
    return false;
  };

  const skip = (operation: SnapshotStoreProbeOperation): void => {
    checks.push({ operation, status: "skipped" });
  };

  // contentLength is required for real S3 targets: the SDK rejects a stream
  // body of unknown length, which would turn a healthy store into a false
  // probe failure.
  const written = await attempt("write", (signal) =>
    store.put(
      key,
      Readable.from(payload),
      { contentType: "text/plain", contentLength: payloadBytes },
      { signal },
    ),
  );

  if (capabilities.head) {
    if (written) {
      await attempt("head", async (signal) => {
        const version = await store.head!(key, { signal });
        if (!version) {
          throw new Error("probe object was not visible to head after write");
        }
      });
    } else {
      skip("head");
    }
  }

  if (written) {
    await attempt("read", async (signal) => {
      const stream = await store.get(key, { signal });
      const body = await readBounded(stream, MAX_PROBE_READ_BYTES);
      if (body !== payload) {
        throw new Error("probe object content did not match what was written");
      }
    });
  } else {
    skip("read");
  }

  if (capabilities.conditionalWrite) {
    if (written) {
      await attempt("conditional_write", async (signal) => {
        const result = await store.putConditional!(
          key,
          Readable.from(payload),
          { ifAbsent: true },
          { contentType: "text/plain", contentLength: payloadBytes },
          { signal },
        );
        if (result.written) {
          throw new Error(
            "conditional write ignored an existing object; CAS fencing is unreliable",
          );
        }
      });
    } else {
      skip("conditional_write");
    }
  }

  let listedKeys: string[] = [];
  if (capabilities.list) {
    if (written) {
      await attempt("list", async (signal) => {
        listedKeys = await store.list!("probe", { signal });
        if (!listedKeys.includes(key)) {
          throw new Error("probe object was not visible in the listing");
        }
      });
    } else {
      skip("list");
    }
  }

  await attempt("delete", (signal) => store.delete(key, { signal }));

  // Best-effort sweep of orphaned probe objects left behind by a crash
  // between write and delete; bounded so a large backlog cannot stall the
  // probe response.
  const staleKeys = listedKeys
    .filter((candidate) => {
      if (candidate === key) return false;
      const match = /^probe\/(\d+)-/.exec(candidate);
      if (!match) return false;
      const writtenAt = Number(match[1]);
      return (
        Number.isFinite(writtenAt) &&
        Date.now() - writtenAt > STALE_PROBE_OBJECT_AGE_MS
      );
    })
    .slice(0, MAX_STALE_PROBE_SWEEP);
  for (const staleKey of staleKeys) {
    await race(`stale sweep of ${staleKey}`, (signal) =>
      store.delete(staleKey, { signal }),
    );
  }

  let capacity: SnapshotStoreCapacity | null = null;
  if (options.capacity) {
    const outcome = await race("capacity", () => options.capacity!());
    capacity = outcome.ok ? outcome.value : null;
  }

  return {
    ok: checks.every((check) => check.status !== "failed"),
    capabilities,
    checks,
    capacity,
    operationTimeoutMs,
    durationMs: roundLatency(performance.now() - startedAt),
  };
}

async function readBounded(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`probe object exceeded the ${maxBytes}-byte read bound`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function boundedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Server-side filesystem errors embed absolute paths ("open '/srv/…'");
  // scrub multi-segment absolute paths so probe output never exposes store
  // internals to workspace owners. Relative object keys (probe/…) survive.
  const message = raw.replace(/(?:\/[\w.@+~-]+){2,}\/?/g, "<path>");
  return message.length > MAX_PROBE_ERROR_CHARS
    ? `${message.slice(0, MAX_PROBE_ERROR_CHARS)}…`
    : message;
}

function roundLatency(value: number): number {
  return Number(Math.max(0, value).toFixed(1));
}
