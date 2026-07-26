import { EventEmitter } from "node:events";
import { ContextEngine } from "../engine.js";
import { indexVirtualWorkspace } from "../indexer/indexer.js";
import { SEARCH_TOKENIZER_VERSION } from "../search/bm25.js";
import type { IndexProgress } from "../types.js";
import {
  type StoredIndexJob,
  type StoredWorkspace,
  WorkspaceRepository,
} from "./workspace-repository.js";

export type IndexJobListener = (job: StoredIndexJob) => void;

export interface IndexJobRunnerOptions {
  repository: WorkspaceRepository;
  engineFor(workspace: StoredWorkspace): ContextEngine;
  /** Stable identity for server-local workspace recovery. */
  executorId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  /** Terminal-fail a job once takeovers/requeues exceed this many attempts. */
  maxAttempts?: number;
}

/**
 * Each process runs one local worker, while PostgreSQL claim tokens and leases
 * coordinate ownership across instances. The local queue keeps per-process
 * embedding pressure bounded; periodic scans discover work created elsewhere.
 */
export class IndexJobRunner {
  private readonly repository: WorkspaceRepository;
  private readonly engineFor: (workspace: StoredWorkspace) => ContextEngine;
  private readonly executorId: string | undefined;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly events = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private drainPromise: Promise<void> | null = null;
  private scanPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeAbortController: AbortController | null = null;
  private closed = false;

  constructor(options: IndexJobRunnerOptions) {
    this.repository = options.repository;
    this.engineFor = options.engineFor;
    this.executorId = options.executorId;
    this.leaseMs = Math.max(
      100,
      Math.min(24 * 60 * 60_000, Math.floor(options.leaseMs ?? 5 * 60_000)),
    );
    this.pollIntervalMs = Math.max(
      25,
      Math.min(60_000, Math.floor(options.pollIntervalMs ?? 2_000)),
    );
    this.maxAttempts = Math.max(
      1,
      Math.min(100, Math.floor(options.maxAttempts ?? 5)),
    );
  }

  async start(): Promise<void> {
    await this.warnAboutStrandedLocalJobs();
    await this.scan();
    this.pollTimer = setInterval(() => this.triggerScan(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  /**
   * Local-workspace jobs are pinned to the executor that enqueued them. When
   * the derived identity changes (new hostname, moved cwd), those jobs can
   * never be claimed here — surface them loudly instead of stranding silently.
   */
  private async warnAboutStrandedLocalJobs(): Promise<void> {
    if (!this.executorId) return;
    try {
      const stranded = await this.repository.listStrandedLocalIndexJobs(
        this.executorId,
      );
      if (!stranded.length) return;
      console.warn(
        `[index jobs] ${stranded.length} local-workspace job(s) are bound to a different executor and will not run here: ` +
          stranded
            .map((job) => `${job.id} (executor ${job.executorId ?? "unknown"})`)
            .join(", ") +
          ". Set CONTEXTENGINE_INDEX_JOB_EXECUTOR_ID to a stable value or re-enqueue the jobs on this instance.",
      );
    } catch (error) {
      console.error(
        "[index jobs] stranded-job check failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  enqueue(jobId: string): void {
    if (this.closed || this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.queue.push(jobId);
    this.startDrain();
  }

  isBusy(): boolean {
    return this.drainPromise !== null || this.queue.length > 0;
  }

  subscribe(jobId: string, listener: IndexJobListener): () => void {
    const event = `job:${jobId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.queue.length = 0;
    this.queued.clear();
    this.activeAbortController?.abort(
      new Error("Index job runner is closing"),
    );
    await this.scanPromise;
    await this.drainPromise;
  }

  private triggerScan(): void {
    if (this.closed || this.scanPromise) return;
    this.scanPromise = this.scan()
      .catch((error: unknown) => {
        console.error(
          "[index jobs] queue scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.scanPromise = null;
      });
  }

  private async scan(): Promise<void> {
    const jobs = await this.repository.listRunnableIndexJobs(
      this.leaseMs,
      this.executorId,
    );
    for (const job of jobs) this.enqueue(job.id);
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (!this.closed && this.queue.length) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      this.queued.delete(jobId);
      try {
        await this.run(jobId);
      } catch (error) {
        console.error(
          `[index jobs] failed to process ${jobId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async run(jobId: string): Promise<void> {
    await this.runClaimed(jobId);
  }

  private async runClaimed(jobId: string): Promise<void> {
    if (this.closed) return;
    const job = await this.repository.claimIndexJob(
      jobId,
      this.leaseMs,
      this.executorId,
    );
    if (!job) return;
    this.publish(job);
    if (job.attempts > this.maxAttempts) {
      // The claim is fenced by a fresh attempt token, so this terminal write
      // cannot race a live owner. Without a budget, a job that kills its
      // worker every run would be re-claimed after each lease expiry forever.
      const failed = await this.repository.failIndexJob(
        jobId,
        job.attemptToken,
        `Index job exceeded the retry budget after ${job.attempts} attempts`,
      );
      if (failed) this.publish(failed);
      return;
    }
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    if (this.closed) {
      abortController.abort(new Error("Index job runner is closing"));
    }
    let ownershipLost = false;
    let leaseUncertain = false;
    let lastRenewalAt = Date.now();
    let heartbeat = Promise.resolve();
    let pendingProgress = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          if (abortController.signal.aborted) return;
          const renewed = await this.repository.renewIndexJobLease(
            job.id,
            job.attemptToken,
          );
          if (!renewed) {
            ownershipLost = true;
            abortController.abort(new Error("Index job lease is no longer active"));
            return;
          }
          lastRenewalAt = Date.now();
        })
        .catch((error: unknown) => {
          // A thrown renewal error (connection blip) is not proof of lost
          // ownership: the lease stays valid until leaseMs after the last
          // successful renewal. Only abort once that margin is gone.
          if (Date.now() - lastRenewalAt < this.leaseMs) {
            console.error(
              `[index jobs] lease renewal for ${job.id} failed (will retry):`,
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          leaseUncertain = true;
          abortController.abort(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    }, Math.max(25, Math.floor(this.leaseMs / 3)));
    heartbeatTimer.unref();

    try {
      const workspace = await this.repository.requireWorkspace(job.workspaceId);
      const engine = this.engineFor(workspace);
      let lastProgressAt = 0;
      let lastPhase = "";
      const onProgress = (progress: IndexProgress): void => {
        abortController.signal.throwIfAborted();
        const now = Date.now();
        if (
          progress.phase === lastPhase &&
          now - lastProgressAt < 500 &&
          progress.phase !== "done"
        ) {
          return;
        }
        lastPhase = progress.phase;
        lastProgressAt = now;
        pendingProgress = pendingProgress
          .then(async () => {
            abortController.signal.throwIfAborted();
            const updated = await this.repository.updateIndexJobProgress(
              jobId,
              job.attemptToken,
              {
                phase: progress.phase,
                files_total: progress.filesTotal,
                files_done: progress.filesDone,
                chunks_total: progress.chunksTotal,
                message: progress.message ?? null,
              },
            );
            if (!updated) {
              ownershipLost = true;
              abortController.abort(
                new Error("Index job lease is no longer active"),
              );
              return;
            }
            this.publish(updated);
          })
          .catch((error: unknown) => {
            // Progress rows are advisory; ownership is guarded by the fenced
            // predicate above and the lease heartbeat. Skip the failed write
            // and let the next progress event retry instead of aborting a
            // long build over one transient error.
            if (abortController.signal.aborted) return;
            console.error(
              `[index jobs] progress write for ${job.id} failed (skipped):`,
              error instanceof Error ? error.message : String(error),
            );
          });
      };

      const result =
        workspace.sourceMode === "local"
          ? await engine.index(onProgress, abortController.signal)
          : await this.indexBlobWorkspace(
              job,
              workspace,
              engine,
              onProgress,
              abortController.signal,
            );
      await pendingProgress;
      abortController.signal.throwIfAborted();
      // ContextEngine.index() reloads its searcher after local indexing. Blob
      // indexing runs through the repository-backed helper, so refresh only
      // that path after its generation is promoted.
      if (workspace.sourceMode !== "local") await engine.refresh();
      abortController.signal.throwIfAborted();
      clearInterval(heartbeatTimer);
      await heartbeat;
      abortController.signal.throwIfAborted();
      const completed = await this.repository.completeIndexJob(
        jobId,
        job.attemptToken,
        result,
      );
      if (completed) this.publish(completed);
    } catch (error) {
      clearInterval(heartbeatTimer);
      await pendingProgress;
      await heartbeat.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (this.closed || leaseUncertain) {
        const released = await this.repository.releaseIndexJob(
          jobId,
          job.attemptToken,
          message,
        );
        if (released) this.publish(released);
      } else if (!ownershipLost) {
        const failed = await this.repository.failIndexJob(
          jobId,
          job.attemptToken,
          message,
        );
        if (failed) this.publish(failed);
      }
    } finally {
      clearInterval(heartbeatTimer);
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  private async indexBlobWorkspace(
    job: StoredIndexJob,
    workspace: StoredWorkspace,
    engine: ContextEngine,
    onProgress: (progress: IndexProgress) => void,
    signal: AbortSignal,
  ): Promise<object> {
    signal.throwIfAborted();
    const tokenizerChanged =
      (await this.repository.getMeta(
        workspace.id,
        "search_tokenizer_version",
      )) !== String(SEARCH_TOKENIZER_VERSION);
    // Incremental jobs are only composable when they are based on the
    // immediately preceding source revision. If another instance completed a
    // newer revision first, rebuild from the authoritative Blob snapshot
    // rather than promoting a generation that omits intervening changes.
    const indexedRevision = (await engine.indexStatus()).indexedRevision;
    const indexedNumber = indexedRevision === null ? null : Number(indexedRevision);
    const contiguous =
      Number.isSafeInteger(indexedNumber) && indexedNumber === job.revision - 1;
    const rebuild =
      job.mode === "rebuild" || tokenizerChanged || !contiguous;
    const selectedPaths = rebuild ? null : job.changedPaths;
    const filesTotal = await this.repository.countSourceFiles(
      workspace.id,
      selectedPaths,
    );
    return indexVirtualWorkspace(
      engine.config,
      this.repository.iterateSourceFiles(workspace.id, selectedPaths),
      {
        filesTotal,
        deletedPaths: job.deletedPaths,
        rebuild,
        fullScan: selectedPaths === null,
        sourceRevision: job.revision,
        rootLabel: `workspace://${workspace.id}`,
        onProgress,
        signal,
      },
    );
  }

  private publish(job: StoredIndexJob): void {
    this.events.emit(`job:${job.id}`, job);
  }
}
