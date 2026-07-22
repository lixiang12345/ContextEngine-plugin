import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { SnapshotObjectStore } from "../snapshots/object-store.js";
import {
  exportIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  importIndexSnapshot,
  loadIndexSnapshotManifest,
  parseSnapshotManifest,
  pruneIndexSnapshots,
  replicateIndexSnapshot,
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
  replicationTargetFor?(
    workspaceId: string,
    targetId: string,
  ): SnapshotObjectStore;
  hasReplicationTarget?(targetId: string): boolean;
  /** Target ids available in this process; used to avoid creating jobs that
   * no local worker can execute while still allowing another instance to do so. */
  replicationTargetIds?(): readonly string[];
  onImportCompleted?(workspaceId: string): Promise<void>;
  leaseMs?: number;
  replicationMaxAttempts?: number;
  replicationRetryBaseMs?: number;
  pollIntervalMs?: number;
}

export class SnapshotJobRunner {
  private readonly repository: WorkspaceRepository;
  private readonly databaseUrl: string;
  private readonly storeFor: SnapshotJobRunnerOptions["storeFor"];
  private readonly replicationTargetFor?: SnapshotJobRunnerOptions["replicationTargetFor"];
  private readonly hasReplicationTarget?: SnapshotJobRunnerOptions["hasReplicationTarget"];
  private readonly replicationTargetIds?: SnapshotJobRunnerOptions["replicationTargetIds"];
  private readonly onImportCompleted?: SnapshotJobRunnerOptions["onImportCompleted"];
  private readonly leaseMs: number;
  private readonly replicationMaxAttempts: number;
  private readonly replicationRetryBaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly events = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private drainPromise: Promise<void> | null = null;
  private scanPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: SnapshotJobRunnerOptions) {
    this.repository = options.repository;
    this.databaseUrl = options.databaseUrl;
    this.storeFor = options.storeFor;
    this.replicationTargetFor = options.replicationTargetFor;
    this.hasReplicationTarget = options.hasReplicationTarget;
    this.replicationTargetIds = options.replicationTargetIds;
    this.onImportCompleted = options.onImportCompleted;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.replicationMaxAttempts = Math.max(
      1,
      Math.min(10, Math.floor(options.replicationMaxAttempts ?? 3)),
    );
    this.replicationRetryBaseMs = Math.max(
      10,
      Math.min(60_000, Math.floor(options.replicationRetryBaseMs ?? 1_000)),
    );
    this.pollIntervalMs = Math.max(
      100,
      Math.min(
        60_000,
        Math.floor(
          options.pollIntervalMs ??
            Math.max(1_000, Math.min(10_000, Math.floor(this.leaseMs / 3))),
        ),
      ),
    );
  }

  async start(): Promise<void> {
    await this.scan();
    this.pollTimer = setInterval(() => this.triggerScan(), this.pollIntervalMs);
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
    await this.scanPromise;
    await this.drainPromise;
  }

  private triggerScan(): void {
    if (this.closed || this.scanPromise) return;
    this.scanPromise = this.scan()
      .catch((error: unknown) => {
        console.error(
          "[snapshot jobs] queue scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.scanPromise = null;
      });
  }

  private async scan(): Promise<void> {
    if (this.replicationTargetIds && this.replicationTargetFor) {
      try {
        const scheduled = await this.repository.scheduleDueSnapshotReplicationJobs(
          this.replicationTargetIds(),
        );
        for (const job of scheduled) this.enqueue(job.id);
      } catch (error) {
        console.error(
          "[snapshot jobs] replication schedule scan failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const jobs = await this.repository.listQueuedSnapshotJobs(this.leaseMs);
    for (const job of jobs) {
      if (this.canRun(job)) this.enqueue(job.id);
    }
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
    const candidate = await this.repository.getSnapshotJob(jobId);
    if (!candidate || !this.canRun(candidate)) return;
    const job = await this.repository.claimSnapshotJob(jobId, this.leaseMs);
    if (!job) return;
    this.publish(job);
    let heartbeat = Promise.resolve();
    const abortController = new AbortController();
    const heartbeatTimer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          if (abortController.signal.aborted) return;
          const renewed = await this.repository.renewSnapshotJobLease(
            job.id,
            job.attemptToken,
          );
          if (!renewed) {
            abortController.abort(
              new Error("Snapshot job lease is no longer active"),
            );
          }
        })
        .catch((error: unknown) => {
          abortController.abort(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    }, Math.max(100, Math.floor(this.leaseMs / 3)));
    heartbeatTimer.unref();
    try {
      await this.progress(job, "running");
      const result = await this.execute(job, abortController.signal);
      clearInterval(heartbeatTimer);
      await heartbeat;
      abortController.signal.throwIfAborted();
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
      if (job.operation === "replicate" && job.attempts < this.replicationMaxAttempts) {
        const delayMs = Math.min(
          5 * 60_000,
          this.replicationRetryBaseMs * 2 ** Math.max(0, job.attempts - 1),
        );
        const retrying = await this.repository.scheduleSnapshotJobRetry(
          job.id,
          job.attemptToken,
          message,
          delayMs,
        );
        if (retrying) {
          this.publish(retrying);
          const timer = setTimeout(() => this.enqueue(job.id), delayMs + 10);
          timer.unref();
        }
        return;
      }
      const failed = await this.repository.failSnapshotJob(
        job.id,
        job.attemptToken,
        message,
      );
      if (failed) this.publish(failed);
    }
  }

  private async execute(
    job: ClaimedSnapshotJob,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
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
    if (job.operation === "replicate") {
      if (!job.snapshotName) throw new Error("Snapshot replication job has no snapshot name");
      const targetId = stringParameter(job, "target_id");
      if (!this.replicationTargetFor) {
        throw new Error("Snapshot replication targets are not configured");
      }
      await this.progress(job, "replicating");
      const transferStartedAt = performance.now();
      let publication = await this.repository.getSnapshotReplicationPublication(
        job.id,
        job.attemptToken,
      );
      if (!publication) {
        publication = await this.repository.pinSnapshotReplicationPublicationWithLoader(
          job.id,
          job.attemptToken,
          async () => {
            const loaded = await loadIndexSnapshotManifest({
              name: job.snapshotName!,
              store,
              signal,
            });
            return {
              sourceManifest: loaded.manifest,
              sourceManifestSha256: loaded.sha256,
            };
          },
        );
      }
      if (!publication) {
        throw new Error("Snapshot job lease is no longer active");
      }
      const result =
        await this.repository.withSnapshotReplicationArtifactGuard(
          job.workspaceId,
          () =>
            replicateIndexSnapshot({
              name: job.snapshotName!,
              source: store,
              target: this.replicationTargetFor!(job.workspaceId, targetId),
              publication: {
                publicationSequence: publication.publicationSequence,
                sourceManifest: parseSnapshotManifest(publication.sourceManifest),
                sourceManifestSha256: publication.sourceManifestSha256,
              },
              isPublicationCurrent: () =>
                this.repository.isSnapshotReplicationPublicationCurrent(
                  job.id,
                  job.attemptToken,
                ),
              withPublicationGuard: (operation) =>
                this.repository.withSnapshotReplicationPublicationGuard(
                  job.id,
                  job.attemptToken,
                  operation,
                ),
              signal,
            }),
        );
      // Keep transfer measurements with the durable result so aggregate
      // metrics remain available after a worker restarts or another instance
      // claims the job. A one millisecond floor avoids an infinite rate for
      // tiny local artifacts while preserving sub-millisecond work as 1 ms.
      const transferDurationMs = Math.max(
        1,
        Math.round(performance.now() - transferStartedAt),
      );
      const effectivePublication = result.publicationStatus !== "superseded";
      const artifactBytes = effectivePublication
        ? result.manifest.artifact.bytes
        : 0;
      const effectiveTransferDurationMs = effectivePublication
        ? transferDurationMs
        : 0;
      return {
        target_id: targetId,
        snapshot: result.manifest,
        manifest_key: result.manifestKey,
        artifact_key: result.artifactKey,
        publication_status: result.publicationStatus,
        publication_sequence: result.publicationSequence,
        source_manifest_sha256: result.sourceManifestSha256,
        strict_fencing: result.strictFencing,
        artifact_bytes: artifactBytes,
        transfer_duration_ms: effectiveTransferDurationMs,
        transfer_throughput_bytes_per_second:
          effectiveTransferDurationMs === 0
            ? 0
            : Math.round(
                (artifactBytes * 1000) / effectiveTransferDurationMs,
              ),
      };
    }
    await this.progress(job, "garbage_collecting");
    return this.repository.withSnapshotReplicationArtifactGuard(
      job.workspaceId,
      async () => {
        const preserveArtifactKeys =
          await this.repository.listRetainedSnapshotReplicationArtifactKeys(
            job.workspaceId,
          );
        return {
          deleted_artifacts: await garbageCollectSnapshotArtifacts(store, {
            preserveArtifactKeys,
          }),
          preserved_replication_artifacts: preserveArtifactKeys,
        };
      },
    );
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

  private canRun(job: StoredSnapshotJob): boolean {
    if (job.operation !== "replicate") return true;
    const targetId = job.parameters.target_id;
    return (
      typeof targetId === "string" &&
      Boolean(this.replicationTargetFor) &&
      (this.hasReplicationTarget?.(targetId) ?? true)
    );
  }
}

function stringParameter(job: ClaimedSnapshotJob, key: string): string {
  const value = job.parameters[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Snapshot job parameter ${key} is invalid`);
  }
  return value;
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
