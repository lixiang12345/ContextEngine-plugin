import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextEngine } from "../src/engine.js";
import { IndexJobRunner } from "../src/server/index-job-runner.js";
import {
  type ClaimedIndexJob,
  type StoredIndexJob,
  type StoredWorkspace,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";

describe("durable index job runner", () => {
  it("polls and executes work created after startup", async () => {
    let current: StoredIndexJob | null = null;
    let completed = false;
    let scanExecutorId: string | undefined;
    let claimExecutorId: string | undefined;
    const repository = {
      async listRunnableIndexJobs(_leaseMs: number, executorId?: string) {
        scanExecutorId = executorId;
        return current?.status === "queued" ? [current] : [];
      },
      async getIndexJob() {
        return current;
      },
      async listStrandedLocalIndexJobs() {
        return [];
      },
      async claimIndexJob(_jobId: string, _leaseMs: number, executorId?: string) {
        claimExecutorId = executorId;
        if (current?.status !== "queued") return null;
        current = indexJob("running", 1);
        return { ...current, attemptToken: "attempt-1" } satisfies ClaimedIndexJob;
      },
      async requireWorkspace() {
        return workspace();
      },
      async updateIndexJobProgress() {
        return current;
      },
      async renewIndexJobLease() {
        return true;
      },
      async completeIndexJob() {
        completed = true;
        current = indexJob("succeeded", 1);
        return current;
      },
      async failIndexJob() {
        throw new Error("successful indexing must not fail");
      },
      async releaseIndexJob() {
        throw new Error("successful indexing must not be released");
      },
    } as unknown as WorkspaceRepository;
    const engine = {
      async index(
        onProgress?: (progress: {
          phase: string;
          filesTotal: number;
          filesDone: number;
          chunksTotal: number;
        }) => void,
        signal?: AbortSignal,
      ) {
        signal?.throwIfAborted();
        onProgress?.({
          phase: "done",
          filesTotal: 1,
          filesDone: 1,
          chunksTotal: 1,
        });
        return indexResult();
      },
    } as unknown as ContextEngine;
    const runner = new IndexJobRunner({
      repository,
      engineFor: () => engine,
      executorId: "local-executor-a",
      pollIntervalMs: 25,
      leaseMs: 100,
    });

    await runner.start();
    current = indexJob("queued");
    await waitFor(() => completed);
    await runner.close();

    assert.equal(current.status, "succeeded");
    assert.equal(current.attempts, 1);
    assert.equal(scanExecutorId, "local-executor-a");
    assert.equal(claimExecutorId, "local-executor-a");
  });

  it("cooperatively aborts and requeues owned work during graceful shutdown", async () => {
    let observedSignal: AbortSignal | undefined;
    let released = false;
    let completed = false;
    let failed = false;
    const queued = indexJob("queued");
    const running = indexJob("running", 1);
    const repository = runnerRepository({
      queued,
      running,
      onComplete: () => {
        completed = true;
      },
      onFail: () => {
        failed = true;
      },
      onRelease: () => {
        released = true;
      },
    });
    const engine = waitingEngine((signal) => {
      observedSignal = signal;
    });
    const runner = new IndexJobRunner({
      repository,
      engineFor: () => engine,
      leaseMs: 100,
      pollIntervalMs: 25,
    });

    await runner.start();
    await waitFor(() => observedSignal !== undefined);
    await runner.close();

    assert.equal(observedSignal?.aborted, true);
    assert.equal(released, true);
    assert.equal(completed, false);
    assert.equal(failed, false);
  });

  it("terminally fails a claimed job that exceeded the retry budget", async () => {
    let failedMessage: string | undefined;
    let engineRan = false;
    let claimable = true;
    const repository = {
      async listRunnableIndexJobs() {
        return claimable ? [indexJob("queued", 5)] : [];
      },
      async listStrandedLocalIndexJobs() {
        return [];
      },
      async claimIndexJob() {
        if (!claimable) return null;
        claimable = false;
        return {
          ...indexJob("running", 6),
          attemptToken: "attempt-6",
        } satisfies ClaimedIndexJob;
      },
      async failIndexJob(_jobId: string, _token: string, message: string) {
        failedMessage = message;
        return indexJob("failed", 6);
      },
      async requireWorkspace() {
        throw new Error("over-budget jobs must not reach the engine");
      },
      async completeIndexJob() {
        throw new Error("over-budget jobs must not complete");
      },
      async releaseIndexJob() {
        throw new Error("over-budget jobs must not be requeued");
      },
      async renewIndexJobLease() {
        return true;
      },
      async updateIndexJobProgress() {
        return null;
      },
    } as unknown as WorkspaceRepository;
    const runner = new IndexJobRunner({
      repository,
      engineFor: () => {
        engineRan = true;
        throw new Error("over-budget jobs must not build an engine");
      },
      maxAttempts: 5,
      leaseMs: 100,
      pollIntervalMs: 25,
    });

    await runner.start();
    await waitFor(() => failedMessage !== undefined);
    await runner.close();

    assert.match(failedMessage ?? "", /retry budget/);
    assert.equal(engineRan, false);
  });

  it("tolerates transient lease-renewal errors while the lease margin holds", async () => {
    let renewalAttempts = 0;
    let completed = false;
    let released = false;
    let failed = false;
    let current: StoredIndexJob | null = indexJob("queued");
    const repository = {
      async listRunnableIndexJobs() {
        return current?.status === "queued" ? [current] : [];
      },
      async listStrandedLocalIndexJobs() {
        return [];
      },
      async claimIndexJob() {
        if (current?.status !== "queued") return null;
        current = indexJob("running", 1);
        return { ...current, attemptToken: "attempt-1" } satisfies ClaimedIndexJob;
      },
      async requireWorkspace() {
        return workspace();
      },
      async updateIndexJobProgress() {
        return current;
      },
      async renewIndexJobLease() {
        renewalAttempts += 1;
        throw new Error("transient database blip");
      },
      async completeIndexJob() {
        completed = true;
        current = indexJob("succeeded", 1);
        return current;
      },
      async failIndexJob() {
        failed = true;
        return null;
      },
      async releaseIndexJob() {
        released = true;
        return null;
      },
    } as unknown as WorkspaceRepository;
    const engine = {
      async index(_onProgress?: unknown, signal?: AbortSignal) {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        (signal as AbortSignal).throwIfAborted();
        return indexResult();
      },
    } as unknown as ContextEngine;
    const runner = new IndexJobRunner({
      repository,
      engineFor: () => engine,
      leaseMs: 600,
      pollIntervalMs: 25,
    });

    await runner.start();
    await waitFor(() => completed);
    await runner.close();

    assert.ok(renewalAttempts >= 1, "expected at least one renewal attempt");
    assert.equal(completed, true);
    assert.equal(released, false);
    assert.equal(failed, false);
  });

  it("stops stale work without writing a terminal state after lease loss", async () => {
    let observedSignal: AbortSignal | undefined;
    let released = false;
    let completed = false;
    let failed = false;
    const repository = runnerRepository({
      queued: indexJob("queued"),
      running: indexJob("running", 1),
      renewLease: false,
      onComplete: () => {
        completed = true;
      },
      onFail: () => {
        failed = true;
      },
      onRelease: () => {
        released = true;
      },
    });
    const runner = new IndexJobRunner({
      repository,
      engineFor: () =>
        waitingEngine((signal) => {
          observedSignal = signal;
        }),
      leaseMs: 100,
      pollIntervalMs: 25,
    });

    await runner.start();
    await waitFor(() => observedSignal?.aborted === true);
    await waitFor(() => !runner.isBusy());
    await runner.close();

    assert.equal(completed, false);
    assert.equal(failed, false);
    assert.equal(released, false);
  });
});

function runnerRepository(options: {
  queued: StoredIndexJob;
  running: StoredIndexJob;
  renewLease?: boolean;
  onComplete(): void;
  onFail(): void;
  onRelease(): void;
}): WorkspaceRepository {
  let claimable = true;
  return {
    async listRunnableIndexJobs() {
      return claimable ? [options.queued] : [];
    },
    async getIndexJob() {
      return claimable ? options.queued : options.running;
    },
    async listStrandedLocalIndexJobs() {
      return [];
    },
    async claimIndexJob() {
      if (!claimable) return null;
      claimable = false;
      return {
        ...options.running,
        attemptToken: "attempt-1",
      } satisfies ClaimedIndexJob;
    },
    async requireWorkspace() {
      return workspace();
    },
    async updateIndexJobProgress() {
      return options.running;
    },
    async renewIndexJobLease() {
      return options.renewLease ?? true;
    },
    async completeIndexJob() {
      options.onComplete();
      return null;
    },
    async failIndexJob() {
      options.onFail();
      return null;
    },
    async releaseIndexJob() {
      options.onRelease();
      return options.queued;
    },
  } as unknown as WorkspaceRepository;
}

function waitingEngine(onSignal: (signal: AbortSignal) => void): ContextEngine {
  return {
    async index(
      _onProgress?: unknown,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      assert.ok(signal);
      onSignal(signal);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("index aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  } as unknown as ContextEngine;
}

function workspace(): StoredWorkspace {
  const now = new Date().toISOString();
  return {
    id: "workspace",
    name: "Workspace",
    sourceMode: "local",
    localRoot: "/tmp/workspace",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function indexJob(
  status: StoredIndexJob["status"],
  attempts = 0,
): StoredIndexJob {
  const now = new Date().toISOString();
  return {
    id: "index-job",
    workspaceId: "workspace",
    executorId: "test-executor",
    revision: 0,
    mode: "rebuild",
    changedPaths: null,
    deletedPaths: [],
    status,
    progress: { phase: status },
    result: null,
    error: null,
    attempts,
    lockedAt: status === "running" ? now : null,
    createdAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt:
      status === "succeeded" || status === "failed" ? now : null,
  };
}

function indexResult(): {
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  chunksWritten: number;
  embeddingsWritten: number;
  durationMs: number;
  roots: string[];
} {
  return {
    filesScanned: 1,
    filesIndexed: 1,
    filesRemoved: 0,
    chunksWritten: 1,
    embeddingsWritten: 0,
    durationMs: 1,
    roots: ["/tmp/workspace"],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runner state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
