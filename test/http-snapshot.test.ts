import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import type {
  SnapshotObjectMetadata,
  SnapshotObjectStore,
} from "../src/snapshots/object-store.js";

class FailingSnapshotStore implements SnapshotObjectStore {
  constructor(
    private readonly inner: SnapshotObjectStore,
    private remainingFailures: number,
  ) {}

  async put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
  ): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      source.destroy();
      throw new Error("replication target temporarily unavailable");
    }
    await this.inner.put(key, source, metadata);
  }

  get(key: string): Promise<Readable> {
    return this.inner.get(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  list(prefix?: string): Promise<string[]> {
    if (!this.inner.list) throw new Error("listing is unavailable");
    return this.inner.list(prefix);
  }
}

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres("owner-managed snapshot HTTP API", () => {
  const schema = `ce_http_snapshot_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const tokens = { alice: "snapshot-alice", bob: "snapshot-bob" } as const;
  let directory = "";
  let replicaDirectory = "";
  let flakyReplicaDirectory = "";
  let replicaStore: FilesystemSnapshotStore;
  let handle: HttpServerHandle;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    directory = await mkdtemp(path.join(os.tmpdir(), "ce-http-snapshot-"));
    replicaDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-http-replica-"));
    flakyReplicaDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-http-flaky-replica-"));
    replicaStore = new FilesystemSnapshotStore(replicaDirectory);
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKeys: [
        { principalId: "alice", token: tokens.alice },
        { principalId: "bob", token: tokens.bob },
      ],
      disableEmbeddings: true,
      snapshotStore: new FilesystemSnapshotStore(directory),
      snapshotReplicationTargets: {
        "region-backup": replicaStore,
        flaky: new FailingSnapshotStore(
          new FilesystemSnapshotStore(flakyReplicaDirectory),
          1,
        ),
        offline: new FailingSnapshotStore(
          new FilesystemSnapshotStore(flakyReplicaDirectory),
          Number.POSITIVE_INFINITY,
        ),
      },
      snapshotReplicationMaxAttempts: 3,
      snapshotReplicationRetryBaseMs: 10,
      snapshotJobPollIntervalMs: 100,
    });
  });

  after(async () => {
    await handle.close();
    try {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
    } finally {
      await admin.end();
      await rm(directory, { recursive: true, force: true });
      await rm(replicaDirectory, { recursive: true, force: true });
      await rm(flakyReplicaDirectory, { recursive: true, force: true });
    }
  });

  function request(
    actor: keyof typeof tokens,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function createWorkspace(
    actor: keyof typeof tokens,
    name: string,
  ): Promise<string> {
    const response = await request(actor, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { workspace: { id: string } }).workspace
      .id;
  }

  async function waitSnapshotJob(
    actor: keyof typeof tokens,
    workspaceId: string,
    jobId: string,
  ): Promise<{
    status: "succeeded" | "failed";
    result: Record<string, unknown> | null;
    error: string | null;
    attempts: number;
  }> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await request(
        actor,
        `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}`,
      );
      assert.equal(response.status, 200);
      const job = (await response.json()) as {
        job: {
          status: "queued" | "running" | "succeeded" | "failed";
          result: Record<string, unknown> | null;
          error: string | null;
          attempts: number;
        };
      };
      if (job.job.status === "succeeded" || job.job.status === "failed") {
        return job.job;
      }
      if (Date.now() >= deadline) throw new Error(`snapshot job ${jobId} timed out`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  it("isolates snapshots by workspace and requires owner permission", async () => {
    const aliceWorkspace = await createWorkspace("alice", "Alice snapshots");
    const bobWorkspace = await createWorkspace("bob", "Bob snapshots");
    const capabilities = await request("alice", "/v1/capabilities");
    assert.equal(capabilities.status, 200);
    const snapshotCapabilities = (
      (await capabilities.json()) as {
        snapshots: { configured: boolean; replication_targets: string[] };
      }
    ).snapshots;
    assert.equal(snapshotCapabilities.configured, true);
    assert.deepEqual(snapshotCapabilities.replication_targets, [
      "flaky",
      "offline",
      "region-backup",
    ]);

    const invalid = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "team-main", unexpected: true }),
      },
    );
    assert.equal(invalid.status, 400);

    const exported = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "team-main" }),
      },
    );
    assert.equal(exported.status, 202);
    const exportJobId = ((await exported.json()) as { job: { id: string } }).job.id;
    const exportJob = await waitSnapshotJob("alice", aliceWorkspace, exportJobId);
    assert.equal(exportJob.status, "succeeded", exportJob.error ?? undefined);
    assert.equal(
      (
        await request(
          "bob",
          `/v1/workspaces/${aliceWorkspace}/snapshot-jobs/${exportJobId}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          "bob",
          `/v1/workspaces/${aliceWorkspace}/snapshot-replication-schedules`,
        )
      ).status,
      404,
    );
    assert.equal(
      ((exportJob.result as { snapshot: { counts: { files: number } } })
        .snapshot.counts.files),
      0,
    );
    const schedulePath =
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main` +
      "/replication-schedules/region-backup";
    const scheduledPolicy = await request("alice", schedulePath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "interval", interval_ms: 60_000 }),
    });
    assert.equal(scheduledPolicy.status, 200);
    const schedule = (await scheduledPolicy.json()) as {
      schedule: {
        id: string;
        enabled: boolean;
        next_scheduled_at: string;
      };
    };
    assert.equal(schedule.schedule.enabled, true);
    assert.ok(Date.parse(schedule.schedule.next_scheduled_at) > Date.now());
    const invalidNightly = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replication-schedules/flaky`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "nightly",
          nightly_at: "23:30",
          timezone: "Not/AZone",
        }),
      },
    );
    assert.equal(invalidNightly.status, 400);
    const unknownScheduleTarget = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replication-schedules/unknown`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "interval", interval_ms: 60_000 }),
      },
    );
    assert.equal(unknownScheduleTarget.status, 404);
    await admin.query(
      `UPDATE ${quoteIdentifier(schema)}.ce_snapshot_replication_schedules
       SET next_scheduled_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [schedule.schedule.id],
    );
    let scheduledJobId: string | null = null;
    const scheduleDeadline = Date.now() + 5_000;
    while (!scheduledJobId) {
      const list = await request(
        "alice",
        `/v1/workspaces/${aliceWorkspace}/snapshot-replication-schedules`,
      );
      assert.equal(list.status, 200);
      scheduledJobId = ((await list.json()) as {
        schedules: Array<{ id: string; last_job_id: string | null }>;
      }).schedules.find((entry) => entry.id === schedule.schedule.id)?.last_job_id ?? null;
      if (scheduledJobId) break;
      if (Date.now() >= scheduleDeadline) {
        throw new Error("scheduled replication was not materialized");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const scheduledJob = await waitSnapshotJob(
      "alice",
      aliceWorkspace,
      scheduledJobId,
    );
    assert.equal(scheduledJob.status, "succeeded", scheduledJob.error ?? undefined);
    const pausedPolicy = await request("alice", schedulePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(pausedPolicy.status, 200);
    assert.equal(
      ((await pausedPolicy.json()) as {
        schedule: { enabled: boolean; next_scheduled_at: string | null };
      }).schedule.next_scheduled_at,
      null,
    );
    const resumedPolicy = await request("alice", schedulePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(resumedPolicy.status, 200);
    const replicated = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "region-backup" }),
      },
    );
    assert.equal(replicated.status, 202);
    const queuedReplication = (await replicated.json()) as {
      job: { id: string; target_id: string };
    };
    assert.equal(queuedReplication.job.target_id, "region-backup");
    const replicationJobId = queuedReplication.job.id;
    const replicationJob = await waitSnapshotJob(
      "alice",
      aliceWorkspace,
      replicationJobId,
    );
    assert.equal(replicationJob.status, "succeeded", replicationJob.error ?? undefined);
    assert.equal(replicationJob.result?.target_id, "region-backup");
    assert.equal(typeof replicationJob.result?.artifact_bytes, "number");
    assert.ok((replicationJob.result?.artifact_bytes as number) > 0);
    assert.equal(typeof replicationJob.result?.transfer_duration_ms, "number");
    assert.ok((replicationJob.result?.transfer_duration_ms as number) >= 1);
    assert.equal(
      typeof replicationJob.result?.transfer_throughput_bytes_per_second,
      "number",
    );
    assert.ok(
      (await replicaStore.list()).some((key) => key.endsWith("/snapshots/team-main/manifest.json")),
    );

    const flakyReplication = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "flaky" }),
      },
    );
    assert.equal(flakyReplication.status, 202);
    const flakyJobId = ((await flakyReplication.json()) as { job: { id: string } }).job.id;
    const recoveredReplication = await waitSnapshotJob("alice", aliceWorkspace, flakyJobId);
    assert.equal(recoveredReplication.status, "succeeded", recoveredReplication.error ?? undefined);
    assert.equal(recoveredReplication.attempts, 2);

    const offlineReplication = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "offline" }),
      },
    );
    assert.equal(offlineReplication.status, 202);
    const offlineJobId = ((await offlineReplication.json()) as { job: { id: string } }).job.id;
    const failedReplication = await waitSnapshotJob("alice", aliceWorkspace, offlineJobId);
    assert.equal(failedReplication.status, "failed");
    assert.equal(failedReplication.attempts, 3);
    assert.match(failedReplication.error ?? "", /temporarily unavailable/);
    const retriedOffline = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshot-jobs/${offlineJobId}/retry`,
      { method: "POST", body: "{}" },
    );
    assert.equal(retriedOffline.status, 202);
    const failedAgain = await waitSnapshotJob("alice", aliceWorkspace, offlineJobId);
    assert.equal(failedAgain.status, "failed");
    assert.equal(failedAgain.attempts, 3);

    const targetStatus = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshot-replication-targets`,
    );
    assert.equal(targetStatus.status, 200);
    const targets = (await targetStatus.json()) as {
      targets: Array<{
        id: string;
        configured: boolean;
        metrics: {
          succeeded: number;
          failed: number;
          retries: number;
          average_duration_ms: number | null;
          total_artifact_bytes: number;
          average_throughput_bytes_per_second: number | null;
          consecutive_failures: number;
          replication_lag_ms: number | null;
        };
        health: string;
        alert: Record<string, unknown> | null;
        schedules: Array<{ id: string; enabled: boolean }>;
        replications: Array<{ status: string; snapshot_name: string }>;
      }>;
    };
    assert.deepEqual(
      targets.targets.map((target) => ({
        id: target.id,
        configured: target.configured,
        status: target.replications[0]?.status,
        snapshot: target.replications[0]?.snapshot_name,
        succeeded: target.metrics.succeeded,
        failed: target.metrics.failed,
        retries: target.metrics.retries,
      })),
      [
        {
          id: "flaky", configured: true, status: "succeeded", snapshot: "team-main",
          succeeded: 1, failed: 0, retries: 1,
        },
        {
          id: "offline", configured: true, status: "failed", snapshot: "team-main",
          succeeded: 0, failed: 1, retries: 2,
        },
        {
          id: "region-backup", configured: true, status: "succeeded", snapshot: "team-main",
          succeeded: 2, failed: 0, retries: 0,
        },
      ],
    );
    for (const target of targets.targets.filter((entry) => entry.metrics.succeeded)) {
      assert.ok(target.metrics.average_duration_ms !== null);
      assert.ok(target.metrics.replication_lag_ms !== null);
      assert.ok(target.metrics.total_artifact_bytes > 0);
      assert.ok(target.metrics.average_throughput_bytes_per_second !== null);
    }
    const scheduledTarget = targets.targets.find((target) => target.id === "region-backup")!;
    assert.equal(scheduledTarget.health, "healthy");
    assert.equal(scheduledTarget.alert, null);
    assert.deepEqual(
      scheduledTarget.schedules.map(({ id, enabled }) => ({ id, enabled })),
      [{ id: schedule.schedule.id, enabled: true }],
    );
    const deletedSchedule = await request("alice", schedulePath, { method: "DELETE" });
    assert.equal(deletedSchedule.status, 200);
    assert.deepEqual(await deletedSchedule.json(), { deleted: true });
    for (let index = 0; index < 2; index += 1) {
      const failed = await request(
        "alice",
        `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replicate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target_id: "offline" }),
        },
      );
      assert.equal(failed.status, 202);
      const failedJobId = ((await failed.json()) as { job: { id: string } }).job.id;
      assert.equal(
        (await waitSnapshotJob("alice", aliceWorkspace, failedJobId)).status,
        "failed",
      );
    }
    const alertingTargets = (await (
      await request(
        "alice",
        `/v1/workspaces/${aliceWorkspace}/snapshot-replication-targets`,
      )
    ).json()) as {
      targets: Array<{
        id: string;
        health: string;
        alert: { code: string; count: number } | null;
      }>;
    };
    const alertingOffline = alertingTargets.targets.find(
      (target) => target.id === "offline",
    )!;
    assert.equal(alertingOffline.health, "unhealthy");
    assert.equal(alertingOffline.alert?.code, "consecutive_replication_failures");
    assert.equal(alertingOffline.alert?.count, 3);
    assert.equal(
      typeof (alertingOffline.alert as { last_failed_at?: string }).last_failed_at,
      "string",
    );
    const unknownTarget = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/replicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "unknown" }),
      },
    );
    assert.equal(unknownTarget.status, 404);
    const aliceList = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
    );
    assert.deepEqual(await aliceList.json(), { snapshots: ["team-main"] });
    const bobList = await request(
      "bob",
      `/v1/workspaces/${bobWorkspace}/snapshots`,
    );
    assert.deepEqual(await bobList.json(), { snapshots: [] });
    const missingImport = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/missing/import`,
      { method: "POST", body: "{}" },
    );
    assert.equal(missingImport.status, 202);
    const missingJobId = ((await missingImport.json()) as { job: { id: string } }).job.id;
    const missingJob = await waitSnapshotJob("alice", aliceWorkspace, missingJobId);
    assert.equal(missingJob.status, "failed");
    assert.match(missingJob.error ?? "", /not found/i);
    const retried = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshot-jobs/${missingJobId}/retry`,
      { method: "POST", body: "{}" },
    );
    assert.equal(retried.status, 202);
    const retryJob = await waitSnapshotJob("alice", aliceWorkspace, missingJobId);
    assert.equal(retryJob.status, "failed");
    assert.equal(retryJob.attempts, 2);

    const grant = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: "reader" }),
      },
    );
    assert.equal(grant.status, 200);
    assert.equal(
      (await request("bob", `/v1/workspaces/${aliceWorkspace}/snapshots`))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          "bob",
          `/v1/workspaces/${aliceWorkspace}/snapshot-replication-targets`,
        )
      ).status,
      404,
    );

    const imported = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/import`,
      { method: "POST", body: "{}" },
    );
    assert.equal(imported.status, 202);
    const importJobId = ((await imported.json()) as { job: { id: string } }).job.id;
    const importJob = await waitSnapshotJob("alice", aliceWorkspace, importJobId);
    assert.equal(importJob.status, "succeeded", importJob.error ?? undefined);
    assert.match(
      (importJob.result as { generation_id: string }).generation_id,
      /^[0-9a-f-]{36}$/,
    );
    const pruned = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots:prune`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keep: 1 }),
      },
    );
    assert.equal(pruned.status, 202);
    const pruneJobId = ((await pruned.json()) as { job: { id: string } }).job.id;
    const pruneJob = await waitSnapshotJob("alice", aliceWorkspace, pruneJobId);
    assert.equal(pruneJob.status, "succeeded", pruneJob.error ?? undefined);
    assert.deepEqual(pruneJob.result, { deleted: [] });
    const deleted = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 200);
    const gc = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots:gc`,
      { method: "POST", body: "{}" },
    );
    assert.equal(gc.status, 202);
    const gcJobId = ((await gc.json()) as { job: { id: string } }).job.id;
    const gcJob = await waitSnapshotJob("alice", aliceWorkspace, gcJobId);
    assert.equal(gcJob.status, "succeeded", gcJob.error ?? undefined);
    const gcResult = gcJob.result as {
      deleted_artifacts: string[];
      preserved_replication_artifacts: string[];
    };
    assert.deepEqual(gcResult.deleted_artifacts, []);
    assert.equal(gcResult.preserved_replication_artifacts.length, 1);
  });

  it("returns service unavailable when no snapshot store is configured", async () => {
    const isolated = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: "snapshot-unconfigured",
      disableEmbeddings: true,
      snapshotStore: null,
    });
    try {
      const created = await fetch(`${isolated.url}/v1/workspaces`, {
        method: "POST",
        headers: {
          authorization: "Bearer snapshot-unconfigured",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "No snapshot store" }),
      });
      const workspaceId = (
        (await created.json()) as { workspace: { id: string } }
      ).workspace.id;
      const response = await fetch(
        `${isolated.url}/v1/workspaces/${workspaceId}/snapshots`,
        { headers: { authorization: "Bearer snapshot-unconfigured" } },
      );
      assert.equal(response.status, 503);
    } finally {
      await isolated.close();
    }
  });
});
