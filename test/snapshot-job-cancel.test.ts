import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
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

describePostgres("snapshot job cancellation and history retention", () => {
  const schema = `ce_snap_cancel_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const schemaPool = () => new Pool({ connectionString: schemaUrl });
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

  async function newJob(): Promise<{ workspaceId: string; jobId: string }> {
    const workspace = await repository.createWorkspace({
      name: `cancel ${randomUUID().slice(0, 8)}`,
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const job = await repository.createSnapshotJob({
      workspaceId: workspace.id,
      principalId: "owner",
      operation: "export",
      snapshotName: "nightly",
    });
    return { workspaceId: workspace.id, jobId: job.id };
  }

  it("terminalizes a queued job immediately and stays idempotent", async () => {
    const { jobId } = await newJob();

    const first = await repository.requestSnapshotJobCancellation(jobId);
    assert.ok(first);
    assert.equal(first.accepted, true);
    assert.equal(first.job.status, "cancelled");
    assert.ok(first.job.cancelRequestedAt);
    assert.ok(first.job.completedAt);

    const events = await repository.listSnapshotJobEvents(jobId);
    const cancelledEvents = events.filter((event) => event.kind === "cancelled");
    assert.equal(cancelledEvents.length, 1);

    const repeat = await repository.requestSnapshotJobCancellation(jobId);
    assert.ok(repeat);
    assert.equal(repeat.accepted, true);
    assert.equal(repeat.job.status, "cancelled");
    const eventsAfterRepeat = await repository.listSnapshotJobEvents(jobId);
    assert.equal(eventsAfterRepeat.length, events.length);
  });

  it("does not cancel a job that already reached success", async () => {
    const { jobId } = await newJob();
    const claimed = await repository.claimSnapshotJob(jobId, 60_000);
    assert.ok(claimed);
    const completed = await repository.completeSnapshotJob(
      jobId,
      claimed.attemptToken,
      { ok: true },
    );
    assert.ok(completed);

    const outcome = await repository.requestSnapshotJobCancellation(jobId);
    assert.ok(outcome);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.job.status, "succeeded");
  });

  it("flags a running job, fences success/failure, and lets the owner finish the cancel", async () => {
    const { jobId } = await newJob();
    const claimed = await repository.claimSnapshotJob(jobId, 60_000);
    assert.ok(claimed);

    const requested = await repository.requestSnapshotJobCancellation(jobId);
    assert.ok(requested);
    assert.equal(requested.accepted, true);
    assert.equal(requested.job.status, "running");
    assert.ok(requested.job.cancelRequestedAt);

    const events = await repository.listSnapshotJobEvents(jobId);
    assert.equal(
      events.filter((event) => event.kind === "cancel_requested").length,
      1,
    );

    const lease = await repository.renewSnapshotJobLease(
      jobId,
      claimed.attemptToken,
    );
    assert.deepEqual(lease, { renewed: true, cancelRequested: true });

    assert.equal(
      await repository.completeSnapshotJob(jobId, claimed.attemptToken, {
        ok: true,
      }),
      null,
    );
    assert.equal(
      await repository.failSnapshotJob(jobId, claimed.attemptToken, "boom"),
      null,
    );
    assert.equal(
      await repository.scheduleSnapshotJobRetry(
        jobId,
        claimed.attemptToken,
        "boom",
        1_000,
      ),
      null,
    );

    const cancelled = await repository.cancelSnapshotJob(
      jobId,
      claimed.attemptToken,
    );
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.completedAt);

    // Terminal state is fenced against any further stale writes.
    assert.equal(
      await repository.completeSnapshotJob(jobId, claimed.attemptToken, {
        ok: true,
      }),
      null,
    );
    assert.equal(
      await repository.cancelSnapshotJob(jobId, claimed.attemptToken),
      null,
    );

    const pool = schemaPool();
    try {
      const attempt = await pool.query<{ status: string }>(
        `SELECT status FROM ce_snapshot_job_attempts
         WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1`,
        [jobId],
      );
      assert.deepEqual(attempt.rows, [{ status: "cancelled" }]);
    } finally {
      await pool.end();
    }

    const terminalEvents = await repository.listSnapshotJobEvents(jobId);
    assert.equal(
      terminalEvents.filter((event) => event.kind === "cancelled").length,
      1,
    );
  });

  it("lets a takeover observe the cancellation flag and terminalize the job", async () => {
    const { jobId } = await newJob();
    const first = await repository.claimSnapshotJob(jobId, 60_000);
    assert.ok(first);

    const requested = await repository.requestSnapshotJobCancellation(jobId);
    assert.ok(requested);
    assert.equal(requested.job.status, "running");

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    // Claiming with a 1 ms lease treats the 30 ms old lock as expired.
    const takeover = await repository.claimSnapshotJob(jobId, 1);
    assert.ok(takeover);
    assert.equal(takeover.attempts, 2);
    assert.ok(takeover.cancelRequestedAt);

    // The replaced attempt cannot cancel with its stale token …
    assert.equal(
      await repository.cancelSnapshotJob(jobId, first.attemptToken),
      null,
    );
    // … while the new owner writes the terminal state.
    const cancelled = await repository.cancelSnapshotJob(
      jobId,
      takeover.attemptToken,
    );
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
  });

  it("prunes event and attempt history by age and count without breaking cursors", async () => {
    const { jobId } = await newJob();
    const claimed = await repository.claimSnapshotJob(jobId, 60_000);
    assert.ok(claimed);
    for (let step = 0; step < 5; step += 1) {
      assert.ok(
        await repository.updateSnapshotJobProgress(jobId, claimed.attemptToken, {
          phase: `step-${step}`,
        }),
      );
    }
    assert.ok(
      await repository.completeSnapshotJob(jobId, claimed.attemptToken, {
        ok: true,
      }),
    );

    const all = await repository.listSnapshotJobEvents(jobId);
    assert.ok(all.length >= 7);
    const latest = all[all.length - 1];

    // The count cap applies per job across the whole store, so earlier
    // tests' jobs may contribute additional deletions.
    const byCount = await repository.pruneSnapshotJobHistory({
      maxEventsPerJob: 3,
    });
    assert.ok(byCount.deletedEvents >= all.length - 3);

    const retained = await repository.listSnapshotJobEvents(jobId);
    assert.equal(retained.length, 3);
    assert.equal(retained[retained.length - 1].eventId, latest.eventId);
    // A cursor older than the oldest retained event still resumes forward.
    const resumed = await repository.listSnapshotJobEvents(jobId, all[0].eventId);
    assert.equal(resumed.length, 3);

    const pool = schemaPool();
    try {
      await pool.query(
        `UPDATE ce_snapshot_job_events
         SET created_at = created_at - interval '10 days'
         WHERE job_id = $1`,
        [jobId],
      );
      await pool.query(
        `UPDATE ce_snapshot_job_attempts
         SET completed_at = completed_at - interval '10 days'
         WHERE job_id = $1`,
        [jobId],
      );
    } finally {
      await pool.end();
    }

    const byAge = await repository.pruneSnapshotJobHistory({
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(byAge.deletedEvents, 3);
    assert.equal(byAge.deletedAttempts, 1);
    assert.deepEqual(await repository.listSnapshotJobEvents(jobId), []);
  });
});
