import { EventEmitter } from "node:events";
import type { SnapshotObjectStore } from "../snapshots/object-store.js";
import {
  exportIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  importIndexSnapshot,
  pruneIndexSnapshots,
} from "../snapshots/snapshot.js";
import {
  type ClaimedSnapshotJob,
  type StoredSnapshotJob,
  WorkspaceRepository,
} from "./workspace-repository.js";

export type SnapshotJobListener = (job: StoredSnapshotJob) => void;

export interface SnapshotJobRunnerOptions {
  repository: WorkspaceRepository;
  databaseUrl: string;
  storeFor(workspaceId: string, requiresList: boolean): SnapshotObjectStore;
  onImportCompleted?(workspaceId: string): Promise<void>;
  leaseMs?: number;
}

export class SnapshotJobRunner {
  private readonly repository: WorkspaceRepository;
  private readonly databaseUrl: string;
  private readonly storeFor: SnapshotJobRunnerOptions["storeFor"];
  private readonly onImportCompleted?: SnapshotJobRunnerOptions["onImportCompleted"];
  private readonly leaseMs: number;
  private readonly events = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private drainPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: SnapshotJobRunnerOptions) {
    this.repository = options.repository;
    this.databaseUrl = options.databaseUrl;
    this.storeFor = options.storeFor;
    this.onImportCompleted = options.onImportCompleted;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
  }

  async start(): Promise<void> {
    await this.scan();
    const pollMs = Math.max(1_000, Math.min(10_000, Math.floor(this.leaseMs / 3)));
    this.pollTimer = setInterval(() => {
      void this.scan().catch((error: unknown) => {
        console.error(
          "[snapshot jobs] queue scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }, pollMs);
    this.pollTimer.unref();
  }

  enqueue(jobId: string): void {
    if (this.closed || this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.queue.push(jobId);
    this.startDrain();
  }

  subscribe(jobId: string, listener: SnapshotJobListener): () => void {
    const event = `snapshot-job:${jobId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.drainPromise;
  }

  private async scan(): Promise<void> {
    const jobs = await this.repository.listQueuedSnapshotJobs(this.leaseMs);
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
          `[snapshot jobs] failed to claim ${jobId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.repository.claimSnapshotJob(jobId, this.leaseMs);
    if (!job) return;
    this.publish(job);
    let heartbeat = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        await this.repository.renewSnapshotJobLease(job.id, job.attemptToken);
      }).catch(() => undefined);
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeatTimer.unref();
    try {
      await this.progress(job, "running");
      const result = await this.execute(job);
      clearInterval(heartbeatTimer);
      await heartbeat;
      const completed = await this.repository.completeSnapshotJob(
        job.id,
        job.attemptToken,
        result,
      );
      if (completed) this.publish(completed);
    } catch (error) {
      clearInterval(heartbeatTimer);
      await heartbeat.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.repository.failSnapshotJob(
        job.id,
        job.attemptToken,
        message,
      );
      if (failed) this.publish(failed);
    }
  }

  private async execute(job: ClaimedSnapshotJob): Promise<Record<string, unknown>> {
    const requiresList = job.operation === "prune" || job.operation === "gc";
    const store = this.storeFor(job.workspaceId, requiresList);
    if (job.operation === "export") {
      if (!job.snapshotName) throw new Error("Snapshot export job has no snapshot name");
      await this.progress(job, "exporting");
      const result = await exportIndexSnapshot({
        databaseUrl: this.databaseUrl,
        workspaceId: job.workspaceId,
        name: job.snapshotName,
        store,
      });
      return { snapshot: result.manifest, manifest_key: result.manifestKey };
    }
    if (job.operation === "import") {
      if (!job.snapshotName) throw new Error("Snapshot import job has no snapshot name");
      await this.progress(job, "importing");
      const result = await importIndexSnapshot({
        databaseUrl: this.databaseUrl,
        workspaceId: job.workspaceId,
        name: job.snapshotName,
        store,
      });
      await this.onImportCompleted?.(job.workspaceId);
      return { snapshot: result.manifest, generation_id: result.generationId };
    }
    if (job.operation === "prune") {
      await this.progress(job, "pruning");
      const keepLatest = numberParameter(job, "keep_latest");
      const olderThanMs = optionalNumberParameter(job, "older_than_ms");
      return {
        deleted: await pruneIndexSnapshots({ store, keepLatest, olderThanMs }),
      };
    }
    await this.progress(job, "garbage_collecting");
    return { deleted_artifacts: await garbageCollectSnapshotArtifacts(store) };
  }

  private async progress(job: ClaimedSnapshotJob, phase: string): Promise<void> {
    const updated = await this.repository.updateSnapshotJobProgress(
      job.id,
      job.attemptToken,
      { phase },
    );
    if (!updated) throw new Error("Snapshot job lease is no longer active");
    this.publish(updated);
  }

  private publish(job: StoredSnapshotJob): void {
    this.events.emit(`snapshot-job:${job.id}`, job);
  }
}

function numberParameter(job: ClaimedSnapshotJob, key: string): number {
  const value = job.parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Snapshot job parameter ${key} is invalid`);
  }
  return value;
}

function optionalNumberParameter(
  job: ClaimedSnapshotJob,
  key: string,
): number | undefined {
  const value = job.parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Snapshot job parameter ${key} is invalid`);
  }
  return value;
}
