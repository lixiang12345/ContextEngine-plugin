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
});
