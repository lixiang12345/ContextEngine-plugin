import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { WorkspaceRepository } from "../src/server/workspace-repository.js";

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

describePostgres("durable snapshot jobs", () => {
  const schema = `ce_snapshot_jobs_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  let repository: WorkspaceRepository;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    repository = await WorkspaceRepository.open(schemaUrl);
  });

  after(async () => {
    await repository.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("claims once, recovers expired leases, and fences stale attempts", async () => {
    const workspace = await repository.createWorkspace({
      name: "snapshot jobs",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const created = await repository.createSnapshotJob({
      workspaceId: workspace.id,
      principalId: "owner",
      operation: "export",
      snapshotName: "main",
    });
    const claims = await Promise.all([
      repository.claimSnapshotJob(created.id, 60_000),
      repository.claimSnapshotJob(created.id, 60_000),
    ]);
    const first = claims.find((claim) => claim !== null)!;
    assert.ok(first);
    assert.equal(claims.filter(Boolean).length, 1);

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const takeover = await repository.claimSnapshotJob(created.id, 1);
    assert.ok(takeover);
    assert.notEqual(takeover.attemptToken, first.attemptToken);
    assert.equal(
      await repository.updateSnapshotJobProgress(first.id, first.attemptToken, {
        phase: "stale",
      }),
      null,
    );
    assert.equal(
      await repository.completeSnapshotJob(first.id, first.attemptToken, {}),
      null,
    );
    const completed = await repository.completeSnapshotJob(
      takeover.id,
      takeover.attemptToken,
      { ok: true },
    );
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.attempts, 2);
  });

  it("schedules fenced retries using the database clock", async () => {
    const workspace = await repository.createWorkspace({
      name: "snapshot retry",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const created = await repository.createSnapshotJob({
      workspaceId: workspace.id,
      principalId: "owner",
      operation: "replicate",
      snapshotName: "main",
      parameters: { target_id: "region_backup" },
    });
    const first = await repository.claimSnapshotJob(created.id, 60_000);
    assert.ok(first);
    const retrying = await repository.scheduleSnapshotJobRetry(
      first.id,
      first.attemptToken,
      "temporary outage",
      60_000,
    );
    assert.equal(retrying?.status, "queued");
    assert.equal(retrying?.error, "temporary outage");
    assert.equal(
      await repository.completeSnapshotJob(first.id, first.attemptToken, {}),
      null,
    );
    assert.equal(await repository.claimSnapshotJob(created.id, 60_000), null);
    const clock = new Pool({ connectionString: schemaUrl });
    try {
      await clock.query(
        `UPDATE ce_snapshot_jobs
         SET next_attempt_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [created.id],
      );
    } finally {
      await clock.end();
    }
    const second = await repository.claimSnapshotJob(created.id, 60_000);
    assert.ok(second);
    assert.equal(second.attempts, 2);
    assert.equal(
      (await repository.failSnapshotJob(second.id, second.attemptToken, "terminal"))
        ?.status,
      "failed",
    );
  });

  it("pins one manifest per replication job across lease takeovers", async () => {
    const workspace = await repository.createWorkspace({
      name: "snapshot publication pin",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const created = await repository.createSnapshotJob({
      workspaceId: workspace.id,
      principalId: "owner",
      operation: "replicate",
      snapshotName: "main",
      parameters: { target_id: "region_backup" },
    });
    const first = await repository.claimSnapshotJob(created.id, 60_000);
    assert.ok(first);
    const secondRepository = await WorkspaceRepository.open(schemaUrl);
    try {
      const manifest = { generation_id: "generation-a", value: 1 };
      const digest = "a".repeat(64);
      await assert.rejects(
        repository.pinSnapshotReplicationPublication(first.id, first.attemptToken, {
          sourceManifest: { oversized: "x".repeat(256 * 1024) },
          sourceManifestSha256: digest,
        }),
        /publication is invalid/,
      );
      let releaseLifecycle!: () => void;
      const lifecycleReleased = new Promise<void>((resolve) => {
        releaseLifecycle = resolve;
      });
      let enterLifecycle!: () => void;
      const lifecycleEntered = new Promise<void>((resolve) => {
        enterLifecycle = resolve;
      });
      const lifecycle = repository.withSnapshotReplicationArtifactGuard(
        workspace.id,
        async () => {
          enterLifecycle();
          await lifecycleReleased;
        },
      );
      await lifecycleEntered;
      let loaderCalled = false;
      const firstPinPromise =
        secondRepository.pinSnapshotReplicationPublicationWithLoader(
          first.id,
          first.attemptToken,
          async () => {
            loaderCalled = true;
            return {
              sourceManifest: manifest,
              sourceManifestSha256: digest,
            };
          },
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(loaderCalled, false);
      releaseLifecycle();
      await lifecycle;
      const pins = [
        await firstPinPromise,
        await repository.pinSnapshotReplicationPublication(
          first.id,
          first.attemptToken,
          { sourceManifest: manifest, sourceManifestSha256: digest },
        ),
      ];
      assert.equal(loaderCalled, true);
      assert.ok(pins[0]);
      assert.deepEqual(pins[1], pins[0]);
      assert.match(pins[0].publicationSequence, /^[1-9][0-9]*$/);

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const takeover = await secondRepository.claimSnapshotJob(created.id, 1);
      assert.ok(takeover);
      assert.equal(
        await repository.getSnapshotReplicationPublication(
          first.id,
          first.attemptToken,
        ),
        null,
      );
      assert.equal(
        await repository.pinSnapshotReplicationPublication(
          first.id,
          first.attemptToken,
          {
            sourceManifest: { generation_id: "stale" },
            sourceManifestSha256: "b".repeat(64),
          },
        ),
        null,
      );
      assert.equal(
        await repository.isSnapshotJobAttemptActive(first.id, first.attemptToken),
        false,
      );
      assert.deepEqual(
        await secondRepository.getSnapshotReplicationPublication(
          takeover.id,
          takeover.attemptToken,
        ),
        pins[0],
      );
      assert.deepEqual(
        await secondRepository.pinSnapshotReplicationPublication(
          takeover.id,
          takeover.attemptToken,
          {
            sourceManifest: { generation_id: "new-source-must-not-replace-pin" },
            sourceManifestSha256: "c".repeat(64),
          },
        ),
        pins[0],
      );
      assert.equal(
        (
          await secondRepository.completeSnapshotJob(
            takeover.id,
            takeover.attemptToken,
            {},
          )
        )?.status,
        "succeeded",
      );

      const next = await repository.createSnapshotJob({
        workspaceId: workspace.id,
        principalId: "owner",
        operation: "replicate",
        snapshotName: "main",
        parameters: { target_id: "region_backup" },
      });
      const nextClaim = await repository.claimSnapshotJob(next.id);
      assert.ok(nextClaim);
      const nextPin = await repository.pinSnapshotReplicationPublication(
        nextClaim.id,
        nextClaim.attemptToken,
        {
          sourceManifest: {
            generation_id: "generation-b",
            artifact: {
              key: `objects/sha256/${"d".repeat(64)}.ndjson.gz`,
            },
          },
          sourceManifestSha256: "d".repeat(64),
        },
      );
      assert.ok(nextPin);
      assert.ok(
        BigInt(nextPin.publicationSequence) > BigInt(pins[0].publicationSequence),
      );
      assert.equal(
        await repository.isSnapshotReplicationPublicationCurrent(
          nextClaim.id,
          nextClaim.attemptToken,
        ),
        true,
      );
      let enterGuard!: () => void;
      const guardEntered = new Promise<void>((resolve) => {
        enterGuard = resolve;
      });
      let releaseGuard!: () => void;
      const guardReleased = new Promise<void>((resolve) => {
        releaseGuard = resolve;
      });
      const guarded = repository.withSnapshotReplicationPublicationGuard(
        nextClaim.id,
        nextClaim.attemptToken,
        async () => {
          enterGuard();
          await guardReleased;
          return "published";
        },
      );
      await guardEntered;
      let terminalSettled = false;
      const terminal = secondRepository
        .failSnapshotJob(nextClaim.id, nextClaim.attemptToken, "done")
        .finally(() => {
          terminalSettled = true;
        });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(terminalSettled, false);
      releaseGuard();
      assert.equal(await guarded, "published");
      assert.equal((await terminal)?.status, "failed");
      assert.deepEqual(
        await repository.listRetainedSnapshotReplicationArtifactKeys(workspace.id),
        [`objects/sha256/${"d".repeat(64)}.ndjson.gz`],
      );

      const newest = await repository.createSnapshotJob({
        workspaceId: workspace.id,
        principalId: "owner",
        operation: "replicate",
        snapshotName: "main",
        parameters: { target_id: "region_backup" },
      });
      const newestClaim = await repository.claimSnapshotJob(newest.id);
      assert.ok(newestClaim);
      const newestPin = await repository.pinSnapshotReplicationPublication(
        newestClaim.id,
        newestClaim.attemptToken,
        {
          sourceManifest: { generation_id: "generation-c" },
          sourceManifestSha256: "e".repeat(64),
        },
      );
      assert.ok(newestPin);
      assert.ok(
        BigInt(newestPin.publicationSequence) > BigInt(nextPin.publicationSequence),
      );
      await repository.completeSnapshotJob(
        newestClaim.id,
        newestClaim.attemptToken,
        {},
      );

      const retried = await repository.retrySnapshotJob(next.id);
      assert.ok(retried);
      const staleRetry = await repository.claimSnapshotJob(next.id);
      assert.ok(staleRetry);
      assert.equal(
        await repository.isSnapshotReplicationPublicationCurrent(
          staleRetry.id,
          staleRetry.attemptToken,
        ),
        false,
      );
      let staleOperationRan = false;
      assert.equal(
        await repository.withSnapshotReplicationPublicationGuard(
          staleRetry.id,
          staleRetry.attemptToken,
          async () => {
            staleOperationRan = true;
          },
        ),
        null,
      );
      assert.equal(staleOperationRan, false);
      await repository.completeSnapshotJob(
        staleRetry.id,
        staleRetry.attemptToken,
        { publication_status: "superseded" },
      );
      const metrics = await repository.snapshotReplicationMetrics(workspace.id);
      assert.equal(metrics[0].succeeded, 2);

      const exportJob = await repository.createSnapshotJob({
        workspaceId: workspace.id,
        principalId: "owner",
        operation: "export",
        snapshotName: "not-replication",
      });
      const exportClaim = await repository.claimSnapshotJob(exportJob.id);
      assert.ok(exportClaim);
      assert.equal(
        await repository.pinSnapshotReplicationPublication(
          exportClaim.id,
          exportClaim.attemptToken,
          {
            sourceManifest: manifest,
            sourceManifestSha256: digest,
          },
        ),
        null,
      );
      await repository.failSnapshotJob(
        exportClaim.id,
        exportClaim.attemptToken,
        "done",
      );
    } finally {
      await secondRepository.close();
    }
  });

  it("persists interval and nightly policies with database-clock pause/resume", async () => {
    const workspace = await repository.createWorkspace({
      name: "snapshot schedules",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const manual = await repository.upsertSnapshotReplicationSchedule({
      workspaceId: workspace.id,
      principalId: "owner",
      targetId: "region_backup",
      snapshotName: "main",
      mode: "manual",
    });
    assert.equal(manual.enabled, false);
    assert.equal(manual.nextScheduledAt, null);

    const interval = await repository.upsertSnapshotReplicationSchedule({
      workspaceId: workspace.id,
      principalId: "owner",
      targetId: "region_backup",
      snapshotName: "main",
      mode: "interval",
      intervalMs: 60_000,
    });
    assert.equal(interval.id, manual.id);
    assert.equal(interval.mode, "interval");
    assert.equal(interval.intervalMs, 60_000);
    assert.equal(interval.enabled, true);
    assert.ok(Date.parse(interval.nextScheduledAt!) > Date.now());

    const paused = await repository.setSnapshotReplicationScheduleEnabled(
      workspace.id,
      "region_backup",
      "main",
      false,
    );
    assert.equal(paused?.enabled, false);
    assert.equal(paused?.nextScheduledAt, null);
    const resumed = await repository.setSnapshotReplicationScheduleEnabled(
      workspace.id,
      "region_backup",
      "main",
      true,
    );
    assert.equal(resumed?.enabled, true);
    assert.ok(Date.parse(resumed?.nextScheduledAt ?? "") > Date.now());

    const nightly = await repository.upsertSnapshotReplicationSchedule({
      workspaceId: workspace.id,
      principalId: "owner",
      targetId: "region_backup",
      snapshotName: "nightly",
      mode: "nightly",
      nightlyAt: "23:30",
      timezone: "Asia/Shanghai",
    });
    assert.equal(nightly.nightlyAt, "23:30:00");
    assert.equal(nightly.timezone, "Asia/Shanghai");
    assert.ok(nightly.nextScheduledAt);
    await assert.rejects(
      repository.upsertSnapshotReplicationSchedule({
        workspaceId: workspace.id,
        principalId: "owner",
        targetId: "region_backup",
        snapshotName: "invalid",
        mode: "nightly",
        nightlyAt: "23:30",
        timezone: "Not/AZone",
      }),
      /Invalid snapshot replication timezone/,
    );
    assert.equal(
      await repository.deleteSnapshotReplicationSchedule(
        workspace.id,
        "region_backup",
        "nightly",
      ),
      true,
    );
  });

  it("claims due schedules once across repositories and deduplicates manual jobs", async () => {
    const workspace = await repository.createWorkspace({
      name: "schedule race",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const schedule = await repository.upsertSnapshotReplicationSchedule({
      workspaceId: workspace.id,
      principalId: "owner",
      targetId: "region_backup",
      snapshotName: "main",
      mode: "interval",
      intervalMs: 60_000,
    });
    const control = new Pool({ connectionString: schemaUrl });
    const second = await WorkspaceRepository.open(schemaUrl);
    try {
      await control.query(
        `UPDATE ce_snapshot_replication_schedules
         SET next_scheduled_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [schedule.id],
      );
      const claims = await Promise.all([
        repository.scheduleDueSnapshotReplicationJobs(["region_backup"]),
        second.scheduleDueSnapshotReplicationJobs(["region_backup"]),
      ]);
      const scheduled = claims.flat();
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].parameters.schedule_id, schedule.id);
      assert.equal(scheduled[0].parameters.trigger, "schedule");
      const active = await repository.createSnapshotReplicationJob({
        workspaceId: workspace.id,
        principalId: "owner",
        targetId: "region_backup",
        snapshotName: "main",
      });
      assert.equal(active.created, false);
      assert.equal(active.job.id, scheduled[0].id);

      const claimed = await repository.claimSnapshotJob(scheduled[0].id);
      assert.ok(claimed);
      assert.equal(
        (await repository.completeSnapshotJob(claimed.id, claimed.attemptToken, {
          artifact_bytes: 12,
          transfer_duration_ms: 3,
        }))?.status,
        "succeeded",
      );
      await control.query(
        `UPDATE ce_snapshot_replication_schedules
         SET next_scheduled_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [schedule.id],
      );
      const next = await repository.scheduleDueSnapshotReplicationJobs([
        "region_backup",
      ]);
      assert.equal(next.length, 1);
      assert.notEqual(next[0].id, scheduled[0].id);
      assert.equal(
        (await repository.createSnapshotReplicationJob({
          workspaceId: workspace.id,
          principalId: "owner",
          targetId: "region_backup",
          snapshotName: "main",
        })).created,
        false,
      );
      assert.deepEqual(
        await repository.scheduleDueSnapshotReplicationJobs(["unconfigured"]),
        [],
      );
    } finally {
      await second.close();
      await control.end();
    }
  });
});
