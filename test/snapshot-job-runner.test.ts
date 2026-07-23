import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { SnapshotJobRunner } from "../src/server/snapshot-job-runner.js";
import {
  type ClaimedSnapshotJob,
  type StoredSnapshotJob,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";
import type { SnapshotObjectStore } from "../src/snapshots/object-store.js";

describe("snapshot job runner fencing", () => {
  it("serializes export with artifact lifecycle work", async () => {
    const queued = snapshotJob("queued", "export");
    const claimed: ClaimedSnapshotJob = {
      ...snapshotJob("running", "export"),
      attemptToken: "attempt-export",
    };
    let guarded = false;
    let completed = false;
    let failed = false;
    const repository = {
      async getSnapshotJob() {
        return queued;
      },
      async claimSnapshotJob() {
        return claimed;
      },
      async updateSnapshotJobProgress() {
        return claimed;
      },
      async renewSnapshotJobLease() {
        return true;
      },
      async withSnapshotArtifactGuard(
        _workspaceId: string,
        _operation: () => Promise<unknown>,
      ) {
        guarded = true;
        return {
          manifest: sourceManifest(),
          manifestKey: "snapshots/main/manifest.json",
        };
      },
      async completeSnapshotJob() {
        completed = true;
        return null;
      },
      async failSnapshotJob() {
        failed = true;
        return null;
      },
      async scheduleSnapshotJobRetry() {
        return null;
      },
    } as unknown as WorkspaceRepository;
    const unusedStore: SnapshotObjectStore = {
      async put() {
        throw new Error("guarded export must not call the object store");
      },
      async get() {
        throw new Error("guarded export must not call the object store");
      },
      async delete() {},
    };
    const runner = new SnapshotJobRunner({
      repository,
      databaseUrl: "postgresql://unused",
      storeFor: () => unusedStore,
    });

    runner.enqueue(claimed.id);
    await runner.close();

    assert.equal(guarded, true);
    assert.equal(completed, true);
    assert.equal(failed, false);
  });

  it("aborts object-store I/O when lease renewal loses ownership", async () => {
    const queued = snapshotJob("queued");
    const claimed: ClaimedSnapshotJob = {
      ...snapshotJob("running"),
      attemptToken: "attempt-1",
    };
    let completed = false;
    let failed = false;
    let observedSignal: AbortSignal | undefined;
    const repository = {
      async getSnapshotJob() {
        return queued;
      },
      async claimSnapshotJob() {
        return claimed;
      },
      async updateSnapshotJobProgress() {
        return claimed;
      },
      async renewSnapshotJobLease() {
        return false;
      },
      async getSnapshotReplicationPublication() {
        return {
          jobId: claimed.id,
          publicationSequence: "1",
          sourceManifest: sourceManifest(),
          sourceManifestSha256: "a".repeat(64),
          pinnedAt: new Date().toISOString(),
        };
      },
      async isSnapshotReplicationPublicationCurrent() {
        return true;
      },
      async withSnapshotArtifactGuard(
        _workspaceId: string,
        operation: () => Promise<unknown>,
      ) {
        return operation();
      },
      async withSnapshotReplicationPublicationGuard(
        _jobId: string,
        _attemptToken: string,
        operation: () => Promise<unknown>,
      ) {
        return operation();
      },
      async completeSnapshotJob() {
        completed = true;
        return null;
      },
      async failSnapshotJob() {
        failed = true;
        return null;
      },
      async scheduleSnapshotJobRetry() {
        return null;
      },
    } as unknown as WorkspaceRepository;
    const source: SnapshotObjectStore = {
      async put() {},
      async get(_key, options) {
        observedSignal = options?.signal;
        return new Promise<Readable>((_resolve, reject) => {
          const abort = () =>
            reject(observedSignal?.reason ?? new Error("operation aborted"));
          if (observedSignal?.aborted) abort();
          else observedSignal?.addEventListener("abort", abort, { once: true });
        });
      },
      async delete() {},
    };
    const unusedTarget: SnapshotObjectStore = {
      async put() {
        throw new Error("target must not be reached");
      },
      async get() {
        throw new Error("target must not be reached");
      },
      async delete() {},
    };
    const runner = new SnapshotJobRunner({
      repository,
      databaseUrl: "postgresql://unused",
      storeFor: () => source,
      replicationTargetFor: () => unusedTarget,
      leaseMs: 30,
      replicationMaxAttempts: 1,
    });
    runner.enqueue(claimed.id);
    const keepAlive = setInterval(() => undefined, 20);
    try {
      await runner.close();
    } finally {
      clearInterval(keepAlive);
    }

    assert.ok(observedSignal);
    assert.equal(observedSignal.aborted, true);
    assert.equal(completed, false);
    assert.equal(failed, true);
  });
});

function snapshotJob(
  status: StoredSnapshotJob["status"],
  operation: StoredSnapshotJob["operation"] = "replicate",
): StoredSnapshotJob {
  const now = new Date().toISOString();
  return {
    id: "replication-job",
    workspaceId: "workspace",
    principalId: "owner",
    operation,
    snapshotName: "main",
    parameters: operation === "replicate" ? { target_id: "backup" } : {},
    status,
    progress: null,
    result: null,
    error: null,
    attempts: 1,
    lockedAt: status === "running" ? now : null,
    nextAttemptAt: now,
    createdAt: now,
    startedAt: status === "running" ? now : null,
    completedAt: null,
  };
}

function sourceManifest(): Record<string, unknown> {
  return {
    format_version: 1,
    index_version: 3,
    created_at: new Date().toISOString(),
    workspace_fingerprint: "0".repeat(64),
    generation_id: "generation",
    source_revision: "1",
    indexed_revision: "1",
    artifact: {
      key: `objects/sha256/${"0".repeat(64)}.ndjson.gz`,
      sha256: "0".repeat(64),
      bytes: 1,
      content_encoding: "gzip",
    },
    counts: { metadata: 1, files: 0, chunks: 0, embeddings: 0 },
  };
}
