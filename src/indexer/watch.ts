import { watch } from "node:fs";
import path from "node:path";
import type { EngineConfig } from "../types.js";
import { indexWorkspace } from "./indexer.js";

export interface WatchOptions {
  debounceMs?: number;
  onIndexed?: (result: Awaited<ReturnType<typeof indexWorkspace>>) => void;
  onError?: (err: unknown) => void;
}

/**
 * Debounced recursive directory watcher that re-runs incremental indexing.
 * Best-effort; relies on Node fs.watch (platform differences apply).
 */
export function watchAndIndex(
  config: EngineConfig,
  opts: WatchOptions = {},
): { close: () => void } {
  const debounceMs = opts.debounceMs ?? 800;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  let closed = false;

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, debounceMs);
  };

  const run = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await indexWorkspace(config);
      opts.onIndexed?.(result);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(config.root, { recursive: true }, (_event, filename) => {
      if (!filename) {
        schedule();
        return;
      }
      const rel = filename.toString().split(path.sep).join("/");
      if (
        rel.includes("node_modules/") ||
        rel.includes(".git/") ||
        rel.includes(".contextengine/") ||
        rel.startsWith("dist/")
      ) {
        return;
      }
      schedule();
    });
  } catch (e) {
    opts.onError?.(e);
  }

  // Initial index
  schedule();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
