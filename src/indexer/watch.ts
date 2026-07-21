import { watch } from "node:fs";
import path from "node:path";
import type { EngineConfig } from "../types.js";
import {
  indexWorkspace,
  type IndexResult,
} from "./indexer.js";

type WatchListener = (
  event: string,
  filename: string | Buffer | null,
) => void;

export interface WatchOptions {
  debounceMs?: number;
  /** Run one incremental index immediately after the watchers are attached. */
  initialIndex?: boolean;
  onIndexed?: (result: IndexResult) => void | Promise<void>;
  onError?: (err: unknown) => void;
  /** Injectable seams used by tests and embedders. */
  runIndex?: (config: EngineConfig) => Promise<IndexResult>;
  watchRoot?: (
    root: string,
    listener: WatchListener,
  ) => { close: () => void };
}

export interface WatchHandle {
  /** Resolves after the optional initial indexing attempt has settled. */
  ready: Promise<void>;
  /** Flush a pending debounce and request an index immediately. */
  reindex: () => Promise<IndexResult | undefined>;
  /** Stop watching and wait for any active indexing callback to settle. */
  close: () => Promise<void>;
}

/** Roots watched by the local indexer, with duplicate absolute paths removed. */
export function rootsToWatch(config: EngineConfig): string[] {
  const roots = [config.root, ...(config.extraRoots ?? []).map((root) => root.path)];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Return whether a filesystem notification may affect searchable content.
 * A missing filename is conservatively treated as relevant.
 */
export function shouldReindexWatchPath(
  filename: string | Buffer | null,
): boolean {
  if (filename === null) return true;
  const rel = filename
    .toString()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (!rel) return true;

  const segments = rel.split("/").filter(Boolean);
  if (
    segments.includes("node_modules") ||
    segments.includes(".git") ||
    segments.includes(".contextengine")
  ) {
    return false;
  }
  return segments[0] !== "dist";
}

/**
 * Debounced recursive multi-root watcher that re-runs incremental indexing.
 * Best-effort; relies on Node fs.watch (platform differences apply).
 */
export function watchAndIndex(
  config: EngineConfig,
  opts: WatchOptions = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 800;
  const runIndex = opts.runIndex ?? ((cfg: EngineConfig) => indexWorkspace(cfg));
  const watchRoot =
    opts.watchRoot ??
    ((root: string, listener: WatchListener) =>
      watch(root, { recursive: true }, listener));

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<IndexResult | undefined> | null = null;
  let runningCleanup: Promise<void> | null = null;
  let pending = false;
  let closed = false;
  let readySettled = false;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const reportError = (error: unknown): void => {
    try {
      opts.onError?.(error);
    } catch {
      // Observability callbacks must not break the watcher lifecycle.
    }
  };

  const settleReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, debounceMs);
  };

  const execute = (): Promise<IndexResult | undefined> => {
    if (closed) return Promise.resolve(undefined);
    if (running) {
      pending = true;
      return running;
    }

    running = (async () => {
      try {
        const result = await runIndex(config);
        if (!closed) await opts.onIndexed?.(result);
        return result;
      } catch (error) {
        if (!closed) reportError(error);
        return undefined;
      } finally {
        settleReady();
      }
    })();

    const active = running;
    runningCleanup = active.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      running = null;
      if (pending && !closed) {
        pending = false;
        schedule();
      }
      runningCleanup = null;
    });
    return running;
  };

  const watchers: Array<{ close: () => void }> = [];
  for (const root of rootsToWatch(config)) {
    try {
      watchers.push(
        watchRoot(root, (_event, filename) => {
          if (shouldReindexWatchPath(filename)) schedule();
        }),
      );
    } catch (error) {
      reportError(error);
    }
  }

  if (opts.initialIndex === false) settleReady();
  else void execute();

  return {
    ready,
    reindex: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!running) return execute();

      // A manual request made during an active pass must wait for a fresh
      // pass, rather than returning the result of the older one.
      pending = true;
      const active = running;
      const activeCleanup = runningCleanup;
      await active;
      if (activeCleanup) await activeCleanup;
      if (closed) return undefined;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return execute();
    },
    close: async () => {
      if (closed) {
        if (running) await running;
        return;
      }
      closed = true;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch (error) {
          reportError(error);
        }
      }
      if (running) await running;
      settleReady();
    },
  };
}
