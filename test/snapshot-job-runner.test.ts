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
        return { renewed: true, cancelRequested: false };
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
      async cancelSnapshotJob() {
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
        return { renewed: false, cancelRequested: false };
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
      async cancelSnapshotJob() {
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

  it("fails fast on capacity errors instead of spending the retry budget", async () => {
    const { failed, failMessage, retryScheduled } = await runReplicationFailure(
      Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
    );
    assert.equal(retryScheduled, false);
    assert.equal(failed, true);
    assert.match(failMessage ?? "", /^non-retryable capacity error: /);
  });

  it("fails fast on permission errors instead of spending the retry budget", async () => {
    const s3Denied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const { failed, failMessage, retryScheduled } =
      await runReplicationFailure(s3Denied);
    assert.equal(retryScheduled, false);
    assert.equal(failed, true);
    assert.match(failMessage ?? "", /^non-retryable permission error: /);
  });

  it("still retries transient replication errors", async () => {
    const { failed, retryScheduled } = await runReplicationFailure(
      new Error("replication target temporarily unavailable"),
    );
    assert.equal(retryScheduled, true);
    assert.equal(failed, false);
  });
});

/** Drive one replicate attempt whose publication load throws, and report
 * whether the runner retried or failed terminally. */
async function runReplicationFailure(error: Error): Promise<{
  failed: boolean;
  failMessage: string | null;
  retryScheduled: boolean;
}> {
  const queued = snapshotJob("queued");
  const claimed: ClaimedSnapshotJob = {
    ...snapshotJob("running"),
    attemptToken: "attempt-fail-fast",
  };
  let failed = false;
  let failMessage: string | null = null;
  let retryScheduled = false;
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
      return { renewed: true, cancelRequested: false };
    },
    async getSnapshotReplicationPublication() {
      throw error;
    },
    async completeSnapshotJob() {
      return null;
    },
    async cancelSnapshotJob() {
      return null;
    },
    async failSnapshotJob(_id: string, _token: string, message: string) {
      failed = true;
      failMessage = message;
      return snapshotJob("failed");
    },
    async scheduleSnapshotJobRetry() {
      retryScheduled = true;
      return snapshotJob("queued");
    },
  } as unknown as WorkspaceRepository;
  const unusedStore: SnapshotObjectStore = {
    async put() {},
    async get() {
      return Readable.from("unused");
    },
    async delete() {},
  };
  const runner = new SnapshotJobRunner({
    repository,
    databaseUrl: "postgresql://unused",
    storeFor: () => unusedStore,
    replicationTargetFor: () => unusedStore,
    replicationMaxAttempts: 3,
    replicationRetryBaseMs: 10,
  });
  runner.enqueue(claimed.id);
  await runner.close();
  return { failed, failMessage, retryScheduled };
}

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
