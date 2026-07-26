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

describePostgres("durable index jobs", () => {
  const schema = `ce_index_jobs_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      name: "durable index job",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const created = await repository.createIndexJob({
      workspaceId: workspace.id,
      revision: workspace.revision,
      mode: "rebuild",
    });

    const claims = await Promise.all([
      repository.claimIndexJob(created.id, 60_000),
      repository.claimIndexJob(created.id, 60_000),
    ]);
    const first = claims.find((claim) => claim !== null)!;
    assert.ok(first);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(first.attempts, 1);
    assert.ok(first.lockedAt);
    assert.ok(
      await repository.updateIndexJobProgress(first.id, first.attemptToken, {
        phase: "chunk",
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const takeover = await repository.claimIndexJob(created.id, 1);
    assert.ok(takeover);
    assert.equal(takeover.attempts, 2);
    assert.notEqual(takeover.attemptToken, first.attemptToken);
    assert.equal(
      await repository.updateIndexJobProgress(first.id, first.attemptToken, {
        phase: "stale",
      }),
      null,
    );
    assert.equal(
      await repository.completeIndexJob(first.id, first.attemptToken, {}),
      null,
    );
    assert.equal(
      await repository.failIndexJob(first.id, first.attemptToken, "stale"),
      null,
    );

    const completed = await repository.completeIndexJob(
      takeover.id,
      takeover.attemptToken,
      { ok: true },
    );
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.attempts, 2);
    assert.equal(completed?.lockedAt, null);
    assert.equal(
      (await repository.listRunnableIndexJobs(1)).some(
        (job) => job.id === created.id,
      ),
      false,
    );
  });

  it("requeues an owned job for immediate takeover during graceful shutdown", async () => {
    const workspace = await repository.createWorkspace({
      name: "released index job",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const created = await repository.createIndexJob({
      workspaceId: workspace.id,
      revision: workspace.revision,
      mode: "rebuild",
    });
    const first = await repository.claimIndexJob(created.id, 60_000);
    assert.ok(first);
    const released = await repository.releaseIndexJob(
      first.id,
      first.attemptToken,
      "worker shutdown",
    );
    assert.equal(released?.status, "queued");
    assert.equal(released?.attempts, 1);
    assert.equal(released?.lockedAt, null);
    assert.equal(released?.error, "worker shutdown");
    assert.equal(
      (await repository.listRunnableIndexJobs()).some(
        (job) => job.id === created.id,
      ),
      true,
    );

    const second = await repository.claimIndexJob(created.id, 60_000);
    assert.ok(second);
    assert.equal(second.attempts, 2);
    assert.equal(
      (await repository.failIndexJob(second.id, second.attemptToken, "terminal"))
        ?.status,
      "failed",
    );
  });

  it("recovers local jobs only on their persistent executor affinity", async () => {
    const blobWorkspace = await repository.createWorkspace({
      name: "shared blob workspace",
      sourceMode: "blob",
      ownerPrincipalId: "owner",
    });
    const localWorkspace = await repository.createWorkspace({
      name: "instance-local workspace",
      sourceMode: "local",
      localRoot: "/tmp/contextengine-local-affinity",
      ownerPrincipalId: "owner",
    });
    const blobJob = await repository.createIndexJob({
      workspaceId: blobWorkspace.id,
      revision: 0,
      mode: "rebuild",
    });
    const localJob = await repository.createIndexJob({
      workspaceId: localWorkspace.id,
      revision: 0,
      mode: "rebuild",
      executorId: "local-executor-a",
    });

    const runnable = await repository.listRunnableIndexJobs();
    assert.equal(runnable.some((job) => job.id === blobJob.id), true);
    assert.equal(runnable.some((job) => job.id === localJob.id), false);

    const matching = await repository.listRunnableIndexJobs(
      60_000,
      "local-executor-a",
    );
    assert.equal(matching.some((job) => job.id === blobJob.id), true);
    assert.equal(matching.some((job) => job.id === localJob.id), true);
    assert.equal(
      (await repository.listRunnableIndexJobs(60_000, "local-executor-b")).some(
        (job) => job.id === localJob.id,
      ),
      false,
    );

    assert.equal(
      await repository.claimIndexJob(localJob.id, 60_000, "local-executor-b"),
      null,
    );
    const first = await repository.claimIndexJob(
      localJob.id,
      60_000,
      "local-executor-a",
    );
    assert.ok(first);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(
      await repository.claimIndexJob(localJob.id, 1, "local-executor-b"),
      null,
    );
    const recovered = await repository.claimIndexJob(
      localJob.id,
      1,
      "local-executor-a",
    );
    assert.ok(recovered);
    assert.equal(recovered.attempts, 2);
  });
});
