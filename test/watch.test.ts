import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { EngineConfig } from "../src/types.js";
import {
  rootsToWatch,
  shouldReindexWatchPath,
  watchAndIndex,
  type WatchOptions,
} from "../src/indexer/watch.js";
import type { IndexResult } from "../src/indexer/indexer.js";

const result: IndexResult = {
  filesScanned: 1,
  filesIndexed: 1,
  filesRemoved: 0,
  chunksWritten: 1,
  embeddingsWritten: 0,
  durationMs: 1,
  roots: [],
};

function config(): EngineConfig {
  return {
    root: path.join(tmpdir(), "ce-watch-main"),
    extraRoots: [
      {
        name: "docs",
        path: path.join(tmpdir(), "ce-watch-docs"),
        kind: "docs",
      },
    ],
    dataDir: path.join(tmpdir(), "ce-watch-index"),
    maxFileBytes: 1024,
    maxChunkChars: 240,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for watcher state");
    }
    await delay(5);
  }
}

function fakeWatchers() {
  type Listener = Parameters<NonNullable<WatchOptions["watchRoot"]>>[1];
  const listeners = new Map<string, Listener>();
  const closed: string[] = [];
  const watchRoot: NonNullable<WatchOptions["watchRoot"]> = (root, listener) => {
    listeners.set(root, listener);
    return {
      close: () => {
        closed.push(root);
      },
    };
  };
  return { listeners, closed, watchRoot };
}

describe("watcher path selection", () => {
  it("normalizes and de-duplicates the primary and extra roots", () => {
    const main = path.join(tmpdir(), "ce-watch-main");
    const docs = path.join(tmpdir(), "ce-watch-docs");
    const roots = rootsToWatch({
      ...config(),
      root: path.join(main, "..", path.basename(main)),
      extraRoots: [
        { name: "docs", path: docs },
        { name: "duplicate", path: path.join(docs, ".") },
      ],
    });
    assert.deepEqual(roots, [path.resolve(main), path.resolve(docs)]);
  });

  it("ignores generated and dependency paths, including Windows separators", () => {
    assert.equal(shouldReindexWatchPath("src/index.ts"), true);
    assert.equal(shouldReindexWatchPath("node_modules/pkg/index.js"), false);
    assert.equal(shouldReindexWatchPath(".git/HEAD"), false);
    assert.equal(shouldReindexWatchPath(".contextengine/index.db"), false);
    assert.equal(shouldReindexWatchPath("dist/index.js"), false);
    assert.equal(shouldReindexWatchPath("src\\dist\\index.ts"), true);
    assert.equal(shouldReindexWatchPath("node_modules\\pkg\\index.js"), false);
    assert.equal(shouldReindexWatchPath(null), true);
  });
});

describe("watchAndIndex", () => {
  it("debounces changes across all roots and closes every watcher", async () => {
    const fake = fakeWatchers();
    let runs = 0;
    const handle = watchAndIndex(config(), {
      initialIndex: false,
      debounceMs: 15,
      watchRoot: fake.watchRoot,
      runIndex: async () => {
        runs += 1;
        return result;
      },
    });

    await handle.ready;
    const roots = [...fake.listeners.keys()];
    assert.equal(roots.length, 2);
    fake.listeners.get(roots[0])!("change", "src/a.ts");
    fake.listeners.get(roots[0])!("change", "src/b.ts");
    fake.listeners.get(roots[1])!("change", "README.md");
    fake.listeners.get(roots[0])!("change", "node_modules/pkg.js");
    await waitUntil(() => runs === 1);

    await handle.close();
    assert.deepEqual(new Set(fake.closed), new Set(roots));
    await handle.close();
    assert.equal(fake.closed.length, roots.length);
  });

  it("schedules one pending pass when a change arrives during indexing", async () => {
    const fake = fakeWatchers();
    let runs = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = watchAndIndex(config(), {
      initialIndex: false,
      debounceMs: 10,
      watchRoot: fake.watchRoot,
      runIndex: async () => {
        runs += 1;
        if (runs === 1) {
          firstStarted();
          await firstGate;
        }
        return result;
      },
    });

    await handle.ready;
    const listener = fake.listeners.values().next().value!;
    listener("change", "src/first.ts");
    await firstStartedPromise;
    listener("change", "src/second.ts");
    await delay(25);
    assert.equal(runs, 1);

    releaseFirst();
    await waitUntil(() => runs === 2);
    await handle.close();
  });

  it("waits for a fresh pass when manual reindex overlaps an active pass", async () => {
    const fake = fakeWatchers();
    let runs = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = watchAndIndex(config(), {
      initialIndex: false,
      debounceMs: 5,
      watchRoot: fake.watchRoot,
      runIndex: async () => {
        runs += 1;
        if (runs === 1) {
          firstStarted();
          await firstGate;
        }
        return result;
      },
    });

    await handle.ready;
    const listener = fake.listeners.values().next().value!;
    listener("change", "src/first.ts");
    await firstStartedPromise;
    const reindexing = handle.reindex();
    await delay(5);
    assert.equal(runs, 1);
    releaseFirst();
    await reindexing;
    assert.equal(runs, 2);
    await handle.close();
  });

  it("does not resolve ready until the initial index callback finishes", async () => {
    const fake = fakeWatchers();
    let releaseIndex!: () => void;
    let releaseCallback!: () => void;
    let callbackFinished = false;
    const indexGate = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const handle = watchAndIndex(config(), {
      watchRoot: fake.watchRoot,
      runIndex: async () => {
        await indexGate;
        return result;
      },
      onIndexed: async () => {
        await callbackGate;
        callbackFinished = true;
      },
    });

    let readyFinished = false;
    void handle.ready.then(() => {
      readyFinished = true;
    });
    await delay(10);
    assert.equal(readyFinished, false);
    releaseIndex();
    await delay(10);
    assert.equal(readyFinished, false);
    releaseCallback();
    await handle.ready;
    assert.equal(callbackFinished, true);
    await handle.close();
  });

  it("waits for active indexing before closing", async () => {
    const fake = fakeWatchers();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = watchAndIndex(config(), {
      initialIndex: false,
      debounceMs: 5,
      watchRoot: fake.watchRoot,
      runIndex: async () => {
        started();
        await gate;
        return result;
      },
    });

    const listener = fake.listeners.values().next().value!;
    listener("change", "src/app.ts");
    await startedPromise;
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await delay(10);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(closed, true);
  });
});
