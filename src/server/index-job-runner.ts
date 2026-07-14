import { EventEmitter } from "node:events";
import { ContextEngine } from "../engine.js";
import { indexVirtualWorkspace } from "../indexer/indexer.js";
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
}

/**
 * A single in-process queue keeps embedding/rerank GPU pressure predictable.
 * Job state is persisted in PostgreSQL, so callers can poll even if they do
 * not keep an SSE connection open.
 */
export class IndexJobRunner {
  private readonly repository: WorkspaceRepository;
  private readonly engineFor: (workspace: StoredWorkspace) => ContextEngine;
  private readonly events = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private draining = false;

  constructor(options: IndexJobRunnerOptions) {
    this.repository = options.repository;
    this.engineFor = options.engineFor;
  }

  async start(): Promise<void> {
    await this.repository.markRunningJobsFailed();
    const queued = await this.repository.listQueuedIndexJobs();
    for (const job of queued) this.enqueue(job.id);
  }

  enqueue(jobId: string): void {
    if (this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.queue.push(jobId);
    void this.drain();
  }

  subscribe(jobId: string, listener: IndexJobListener): () => void {
    const event = `job:${jobId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const jobId = this.queue.shift();
        if (!jobId) return;
        this.queued.delete(jobId);
        await this.run(jobId);
      }
    } finally {
      this.draining = false;
      if (this.queue.length) void this.drain();
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.repository.markIndexJobRunning(jobId);
    if (!job) return;
    this.publish(job);

    try {
      const workspace = await this.repository.requireWorkspace(job.workspaceId);
      const engine = this.engineFor(workspace);
      let pendingProgress = Promise.resolve();
      let lastProgressAt = 0;
      let lastPhase = "";
      const onProgress = (progress: IndexProgress): void => {
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
        pendingProgress = pendingProgress.then(async () => {
          const updated = await this.repository.updateIndexJobProgress(jobId, {
            phase: progress.phase,
            files_total: progress.filesTotal,
            files_done: progress.filesDone,
            chunks_total: progress.chunksTotal,
            message: progress.message ?? null,
          });
          if (updated) this.publish(updated);
        });
      };

      const result =
        workspace.sourceMode === "local"
          ? await engine.index(onProgress)
          : await this.indexBlobWorkspace(job, workspace, engine, onProgress);
      await pendingProgress;
      await engine.refresh();
      const completed = await this.repository.completeIndexJob(jobId, result);
      if (completed) this.publish(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.repository.failIndexJob(jobId, message);
      if (failed) this.publish(failed);
    }
  }

  private async indexBlobWorkspace(
    job: StoredIndexJob,
    workspace: StoredWorkspace,
    engine: ContextEngine,
    onProgress: (progress: IndexProgress) => void,
  ): Promise<object> {
    const selectedPaths =
      job.mode === "rebuild" ? null : job.changedPaths;
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
        rebuild: job.mode === "rebuild",
        rootLabel: `workspace://${workspace.id}`,
        onProgress,
      },
    );
  }

  private publish(job: StoredIndexJob): void {
    this.events.emit(`job:${job.id}`, job);
  }
}
