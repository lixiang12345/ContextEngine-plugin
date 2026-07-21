import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  SyncPlanConflictError,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

type RaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

type ConnectorLeaseState = {
  status: string;
  sync_attempt_id: string | null;
  lease_expires_at: Date | string | null;
  cursor_version: string | number;
  cursor: unknown;
  upstream_revision: string | null;
  last_error: string | null;
};

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

async function settled<T>(promise: Promise<T>): Promise<RaceResult<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

describePostgres("connector synchronization leases", () => {
  const schema = `ce_connector_lease_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = quoteIdentifier(schema);
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  let firstWorker: WorkspaceRepository;
  let secondWorker: WorkspaceRepository;

  before(async () => {
    await adminDatabase.query(`CREATE SCHEMA ${quotedSchema}`);
    firstWorker = await WorkspaceRepository.open(schemaUrl);
    secondWorker = await WorkspaceRepository.open(schemaUrl);
    await adminDatabase.query(`
      CREATE FUNCTION ${quotedSchema}.ce_test_expire_lease_on_file_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE ${quotedSchema}.ce_connector_sources
        SET lease_expires_at = clock_timestamp() + interval '100 milliseconds'
        WHERE id = OLD.source_id;
        PERFORM pg_sleep(0.25);
        RETURN OLD;
      END;
      $function$;

      CREATE FUNCTION ${quotedSchema}.ce_test_expire_lease_on_workspace_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE ${quotedSchema}.ce_connector_sources
        SET lease_expires_at = clock_timestamp() + interval '100 milliseconds'
        WHERE workspace_id = OLD.id AND status = 'syncing';
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $function$;

      CREATE FUNCTION ${quotedSchema}.ce_test_expire_session_on_blob_grant()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE ${quotedSchema}.ce_sync_sessions
        SET expires_at = clock_timestamp() + interval '100 milliseconds'
        WHERE workspace_id = NEW.workspace_id AND status = 'planned';
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $function$;

      CREATE FUNCTION ${quotedSchema}.ce_test_expire_session_on_workspace_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE ${quotedSchema}.ce_sync_sessions
        SET expires_at = clock_timestamp() + interval '100 milliseconds'
        WHERE workspace_id = OLD.id AND status = 'planned';
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END;
      $function$;
    `);
  });

  after(async () => {
    await Promise.all([firstWorker?.close(), secondWorker?.close()]);
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await adminDatabase.end();
  });

  async function createConnectorWorkspace(name: string) {
    const workspace = await firstWorker.createWorkspace({
      name,
      sourceMode: "blob",
    });
    const source = await firstWorker.createConnectorSource({
      workspaceId: workspace.id,
      provider: "github",
      externalId: `owner/${name.replaceAll(" ", "-")}`,
      config: { owner: "owner", repository: "repository", ref: "main" },
      createdBy: "lease-race-test",
    });
    return { workspace, source };
  }

  async function expireLease(sourceId: string): Promise<void> {
    await adminDatabase.query(
      `UPDATE ${quotedSchema}.ce_connector_sources
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [sourceId],
    );
  }

  async function leaseState(sourceId: string): Promise<ConnectorLeaseState> {
    const result = await adminDatabase.query<ConnectorLeaseState>(
      `SELECT status, sync_attempt_id, lease_expires_at, cursor_version,
              cursor, upstream_revision, last_error
       FROM ${quotedSchema}.ce_connector_sources
       WHERE id = $1`,
      [sourceId],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  }

  async function assertReplacementStillOwnsLease(input: {
    workspaceId: string;
    sourceId: string;
    attemptId: string;
    path: string;
  }): Promise<void> {
    const source = await leaseState(input.sourceId);
    assert.equal(source.status, "syncing");
    assert.equal(source.sync_attempt_id, input.attemptId);
    assert.ok(source.lease_expires_at);
    assert.equal(Number(source.cursor_version), 0);
    assert.equal(source.cursor, null);
    assert.equal(source.upstream_revision, null);
    assert.equal(source.last_error, null);
    assert.deepEqual(await firstWorker.listConnectorFiles(input.sourceId), []);
    assert.equal(await firstWorker.readSourceFile(input.workspaceId, input.path), null);
    assert.equal((await firstWorker.requireWorkspace(input.workspaceId)).revision, 0);
  }

  it("allows only one concurrent worker to acquire a cursor-version lease", async () => {
    const { workspace, source } = await createConnectorWorkspace("Concurrent lease");

    const [first, second] = await Promise.all([
      firstWorker.beginConnectorSync(workspace.id, source.id, source.cursorVersion),
      secondWorker.beginConnectorSync(workspace.id, source.id, source.cursorVersion),
    ]);
    const winners = [first, second].filter(
      (lease): lease is NonNullable<typeof lease> => lease !== null,
    );

    assert.equal(winners.length, 1);
    assert.equal(winners[0].status, "syncing");
    assert.equal(winners[0].cursorVersion, source.cursorVersion);
    assert.ok(winners[0].syncAttemptId);
    assert.ok(winners[0].leaseExpiresAt);

    const persisted = await leaseState(source.id);
    assert.equal(persisted.status, "syncing");
    assert.equal(persisted.sync_attempt_id, winners[0].syncAttemptId);
  });

  it("records an expired owner's failure until another worker takes over", async () => {
    const { workspace, source } = await createConnectorWorkspace("Expired lease failure");
    const lease = await firstWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(lease);
    await expireLease(source.id);

    const failed = await firstWorker.failConnectorSync(
      workspace.id,
      {
        sourceId: lease.id,
        expectedCursorVersion: lease.cursorVersion,
        syncAttemptId: lease.syncAttemptId,
      },
      "upstream request timed out",
    );
    assert.equal(failed, true);

    const sourceState = await leaseState(source.id);
    assert.equal(sourceState.status, "error");
    assert.equal(sourceState.sync_attempt_id, null);
    assert.equal(sourceState.lease_expires_at, null);
    assert.equal(sourceState.last_error, "upstream request timed out");
  });

  it("prevents a replaced worker from failing, completing, or committing its old attempt", async () => {
    const { workspace, source } = await createConnectorWorkspace("Takeover guard");
    const oldLease = await firstWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(oldLease);
    const oldAttempt = {
      sourceId: oldLease.id,
      expectedCursorVersion: oldLease.cursorVersion,
      syncAttemptId: oldLease.syncAttemptId,
    };
    const staleContent = Buffer.from("export const staleWorker = true;\n");
    const staleHash = digest(staleContent);
    const stalePath = "src/stale-worker.ts";
    const oldPlan = await firstWorker.createSyncPlan(
      workspace.id,
      workspace.revision,
      [
        {
          op: "upsert",
          path: stalePath,
          blobHash: staleHash,
          size: staleContent.length,
          mtimeMs: 0,
          rootAlias: "github:owner/repository",
        },
      ],
      60_000,
      false,
      oldAttempt,
    );
    assert.deepEqual(oldPlan.missingBlobs, [staleHash]);

    await expireLease(source.id);
    const replacementLease = await secondWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(replacementLease);
    assert.notEqual(replacementLease.syncAttemptId, oldAttempt.syncAttemptId);

    await assertReplacementStillOwnsLease({
      workspaceId: workspace.id,
      sourceId: source.id,
      attemptId: replacementLease.syncAttemptId,
      path: stalePath,
    });

    await assert.rejects(
      firstWorker.putBlobForSync(
        workspace.id,
        oldPlan.id,
        staleHash,
        staleContent,
        oldAttempt,
      ),
      SyncPlanConflictError,
    );
    const replacementAttempt = {
      sourceId: replacementLease.id,
      expectedCursorVersion: replacementLease.cursorVersion,
      syncAttemptId: replacementLease.syncAttemptId,
    };
    await assert.rejects(
      secondWorker.putBlobForSync(
        workspace.id,
        oldPlan.id,
        staleHash,
        staleContent,
        replacementAttempt,
      ),
      SyncPlanConflictError,
    );
    assert.equal(await firstWorker.hasBlob(staleHash), false);

    assert.equal(
      await firstWorker.failConnectorSync(
        workspace.id,
        oldAttempt,
        "stale worker must not replace the new lease",
      ),
      false,
    );
    await assertReplacementStillOwnsLease({
      workspaceId: workspace.id,
      sourceId: source.id,
      attemptId: replacementLease.syncAttemptId,
      path: stalePath,
    });

    const staleNoop = await firstWorker.completeConnectorNoop(
      workspace.id,
      oldAttempt,
      { ref: "main", tree_sha: "stale-tree" },
      "stale-tree",
      [
        {
          sourceId: source.id,
          path: "src/stale-noop.ts",
          remoteRevision: "stale-noop",
          contentHash: staleHash,
          bytes: staleContent.length,
        },
      ],
    );
    assert.equal(staleNoop, null);
    await assertReplacementStillOwnsLease({
      workspaceId: workspace.id,
      sourceId: source.id,
      attemptId: replacementLease.syncAttemptId,
      path: stalePath,
    });

    await assert.rejects(
      firstWorker.commitSync(workspace.id, oldPlan.id, {
        connector: {
          ...oldAttempt,
          cursor: { ref: "main", tree_sha: "stale-tree" },
          upstreamRevision: "stale-tree",
          files: [
            {
              sourceId: source.id,
              path: stalePath,
              remoteRevision: "stale-tree",
              contentHash: staleHash,
              bytes: staleContent.length,
            },
          ],
        },
      }),
      SyncPlanConflictError,
    );
    await assert.rejects(
      secondWorker.commitSync(workspace.id, oldPlan.id, {
        connector: {
          ...replacementAttempt,
          cursor: { ref: "main", tree_sha: "replacement-tree" },
          upstreamRevision: "replacement-tree",
          files: [],
        },
      }),
      SyncPlanConflictError,
    );
    await assertReplacementStillOwnsLease({
      workspaceId: workspace.id,
      sourceId: source.id,
      attemptId: replacementLease.syncAttemptId,
      path: stalePath,
    });
    assert.equal(await secondWorker.renewConnectorSyncLease(workspace.id, {
      sourceId: replacementLease.id,
      expectedCursorVersion: replacementLease.cursorVersion,
      syncAttemptId: replacementLease.syncAttemptId,
    }), true);
  });

  it("rolls back a noop when its lease expires inside the transaction", async () => {
    const { workspace, source } = await createConnectorWorkspace("Noop lease expiry");
    const lease = await firstWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(lease);
    const attempt = {
      sourceId: lease.id,
      expectedCursorVersion: lease.cursorVersion,
      syncAttemptId: lease.syncAttemptId,
    };
    const originalFile = {
      sourceId: source.id,
      path: "src/original.ts",
      remoteRevision: "original-revision",
      contentHash: null,
      bytes: 42,
    };
    await adminDatabase.query(
      `INSERT INTO ${quotedSchema}.ce_connector_files(
         source_id, path, remote_revision, content_hash, bytes
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        originalFile.sourceId,
        originalFile.path,
        originalFile.remoteRevision,
        originalFile.contentHash,
        originalFile.bytes,
      ],
    );
    await adminDatabase.query(
      `CREATE TRIGGER ce_test_expire_lease_on_file_delete
       BEFORE DELETE ON ${quotedSchema}.ce_connector_files
       FOR EACH ROW
       EXECUTE FUNCTION ${quotedSchema}.ce_test_expire_lease_on_file_delete()`,
    );

    try {
      await assert.rejects(
        firstWorker.completeConnectorNoop(
          workspace.id,
          attempt,
          { ref: "main", tree_sha: "new-tree" },
          "new-tree",
          [
            {
              sourceId: source.id,
              path: "src/replacement.ts",
              remoteRevision: "new-tree",
              contentHash: null,
              bytes: 7,
            },
          ],
        ),
        SyncPlanConflictError,
      );
    } finally {
      await adminDatabase.query(
        `DROP TRIGGER IF EXISTS ce_test_expire_lease_on_file_delete
         ON ${quotedSchema}.ce_connector_files`,
      );
    }

    assert.deepEqual(await firstWorker.listConnectorFiles(source.id), [originalFile]);
    const persisted = await leaseState(source.id);
    assert.equal(persisted.status, "syncing");
    assert.equal(persisted.sync_attempt_id, attempt.syncAttemptId);
    assert.equal(Number(persisted.cursor_version), 0);
    assert.equal(persisted.cursor, null);
    assert.equal(persisted.upstream_revision, null);
  });

  it("rolls back a commit when its lease expires inside the transaction", async () => {
    const { workspace, source } = await createConnectorWorkspace("Commit lease expiry");
    const lease = await firstWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(lease);
    const attempt = {
      sourceId: lease.id,
      expectedCursorVersion: lease.cursorVersion,
      syncAttemptId: lease.syncAttemptId,
    };
    const content = Buffer.from("export const committedTooLate = true;\n");
    const hash = digest(content);
    const path = "src/late-commit.ts";
    const plan = await firstWorker.createSyncPlan(
      workspace.id,
      workspace.revision,
      [
        {
          op: "upsert",
          path,
          blobHash: hash,
          size: content.length,
          mtimeMs: 0,
          rootAlias: "github:owner/repository",
        },
      ],
      60_000,
      false,
      attempt,
    );
    await firstWorker.putBlobForSync(
      workspace.id,
      plan.id,
      hash,
      content,
      attempt,
    );
    await adminDatabase.query(
      `CREATE TRIGGER ce_test_expire_lease_on_workspace_update
       BEFORE UPDATE ON ${quotedSchema}.ce_workspaces
       FOR EACH ROW
       EXECUTE FUNCTION ${quotedSchema}.ce_test_expire_lease_on_workspace_update()`,
    );

    try {
      await assert.rejects(
        firstWorker.commitSync(workspace.id, plan.id, {
          createIndexJob: true,
          connector: {
            ...attempt,
            cursor: { ref: "main", tree_sha: "late-tree" },
            upstreamRevision: "late-tree",
            files: [
              {
                sourceId: source.id,
                path,
                remoteRevision: "late-tree",
                contentHash: hash,
                bytes: content.length,
              },
            ],
          },
        }),
        SyncPlanConflictError,
      );
    } finally {
      await adminDatabase.query(
        `DROP TRIGGER IF EXISTS ce_test_expire_lease_on_workspace_update
         ON ${quotedSchema}.ce_workspaces`,
      );
    }

    assert.equal((await firstWorker.requireWorkspace(workspace.id)).revision, 0);
    assert.equal(await firstWorker.readSourceFile(workspace.id, path), null);
    assert.deepEqual(await firstWorker.listConnectorFiles(source.id), []);
    const session = await adminDatabase.query<{ status: string }>(
      `SELECT status FROM ${quotedSchema}.ce_sync_sessions WHERE id = $1`,
      [plan.id],
    );
    assert.deepEqual(session.rows, [{ status: "planned" }]);
    const jobs = await adminDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quotedSchema}.ce_index_jobs
       WHERE workspace_id = $1`,
      [workspace.id],
    );
    assert.deepEqual(jobs.rows, [{ count: "0" }]);
    const persisted = await leaseState(source.id);
    assert.equal(persisted.status, "syncing");
    assert.equal(persisted.sync_attempt_id, attempt.syncAttemptId);
    assert.equal(Number(persisted.cursor_version), 0);
    assert.equal(persisted.cursor, null);
    assert.equal(persisted.upstream_revision, null);
  });

  it("rolls back a Blob upload when its sync session expires inside the transaction", async () => {
    const workspace = await firstWorker.createWorkspace({
      name: "Blob upload session expiry",
      sourceMode: "blob",
    });
    const content = Buffer.from(`upload-session-expiry:${workspace.id}`);
    const hash = digest(content);
    const plan = await firstWorker.createSyncPlan(
      workspace.id,
      workspace.revision,
      [
        {
          op: "upsert",
          path: "src/upload-expired.ts",
          blobHash: hash,
          size: content.length,
          mtimeMs: 0,
        },
      ],
      60_000,
    );
    await adminDatabase.query(
      `CREATE TRIGGER ce_test_expire_session_on_blob_grant
       BEFORE INSERT ON ${quotedSchema}.ce_workspace_blob_grants
       FOR EACH ROW
       EXECUTE FUNCTION ${quotedSchema}.ce_test_expire_session_on_blob_grant()`,
    );

    try {
      await assert.rejects(
        firstWorker.putBlobForSync(workspace.id, plan.id, hash, content),
        /Sync session has expired/,
      );
    } finally {
      await adminDatabase.query(
        `DROP TRIGGER IF EXISTS ce_test_expire_session_on_blob_grant
         ON ${quotedSchema}.ce_workspace_blob_grants`,
      );
    }

    assert.equal(await firstWorker.hasBlob(hash), false);
    const grants = await adminDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quotedSchema}.ce_workspace_blob_grants
       WHERE workspace_id = $1 AND blob_hash = $2`,
      [workspace.id, hash],
    );
    assert.deepEqual(grants.rows, [{ count: "0" }]);
    const session = await adminDatabase.query<{ status: string; active: boolean }>(
      `SELECT status, expires_at > clock_timestamp() AS active
       FROM ${quotedSchema}.ce_sync_sessions
       WHERE id = $1`,
      [plan.id],
    );
    assert.deepEqual(session.rows, [{ status: "planned", active: true }]);
  });

  it("rolls back a manual commit when its sync session expires inside the transaction", async () => {
    const workspace = await firstWorker.createWorkspace({
      name: "Manual commit session expiry",
      sourceMode: "blob",
    });
    const content = Buffer.from(`manual-session-expiry:${workspace.id}`);
    const hash = digest(content);
    const path = "src/manual-expired.ts";
    const plan = await firstWorker.createSyncPlan(
      workspace.id,
      workspace.revision,
      [
        {
          op: "upsert",
          path,
          blobHash: hash,
          size: content.length,
          mtimeMs: 0,
        },
      ],
      60_000,
    );
    await firstWorker.putBlobForSync(workspace.id, plan.id, hash, content);
    await adminDatabase.query(
      `CREATE TRIGGER ce_test_expire_session_on_workspace_update
       BEFORE UPDATE ON ${quotedSchema}.ce_workspaces
       FOR EACH ROW
       EXECUTE FUNCTION ${quotedSchema}.ce_test_expire_session_on_workspace_update()`,
    );

    try {
      await assert.rejects(
        firstWorker.commitSync(workspace.id, plan.id, { createIndexJob: true }),
        /Sync session has expired/,
      );
    } finally {
      await adminDatabase.query(
        `DROP TRIGGER IF EXISTS ce_test_expire_session_on_workspace_update
         ON ${quotedSchema}.ce_workspaces`,
      );
    }

    assert.equal((await firstWorker.requireWorkspace(workspace.id)).revision, 0);
    assert.equal(await firstWorker.readSourceFile(workspace.id, path), null);
    const session = await adminDatabase.query<{ status: string; active: boolean }>(
      `SELECT status, expires_at > clock_timestamp() AS active
       FROM ${quotedSchema}.ce_sync_sessions
       WHERE id = $1`,
      [plan.id],
    );
    assert.deepEqual(session.rows, [{ status: "planned", active: true }]);
    const jobs = await adminDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quotedSchema}.ce_index_jobs
       WHERE workspace_id = $1`,
      [workspace.id],
    );
    assert.deepEqual(jobs.rows, [{ count: "0" }]);
  });

  it("rolls back a connector commit when its sync session expires inside the transaction", async () => {
    const { workspace, source } = await createConnectorWorkspace(
      "Connector commit session expiry",
    );
    const lease = await firstWorker.beginConnectorSync(
      workspace.id,
      source.id,
      source.cursorVersion,
    );
    assert.ok(lease);
    const attempt = {
      sourceId: lease.id,
      expectedCursorVersion: lease.cursorVersion,
      syncAttemptId: lease.syncAttemptId,
    };
    const content = Buffer.from(`connector-session-expiry:${workspace.id}`);
    const hash = digest(content);
    const path = "src/connector-expired.ts";
    const plan = await firstWorker.createSyncPlan(
      workspace.id,
      workspace.revision,
      [
        {
          op: "upsert",
          path,
          blobHash: hash,
          size: content.length,
          mtimeMs: 0,
          rootAlias: "github:owner/repository",
        },
      ],
      60_000,
      false,
      attempt,
    );
    await firstWorker.putBlobForSync(
      workspace.id,
      plan.id,
      hash,
      content,
      attempt,
    );
    await adminDatabase.query(
      `CREATE TRIGGER ce_test_expire_session_on_workspace_update
       BEFORE UPDATE ON ${quotedSchema}.ce_workspaces
       FOR EACH ROW
       EXECUTE FUNCTION ${quotedSchema}.ce_test_expire_session_on_workspace_update()`,
    );

    try {
      await assert.rejects(
        firstWorker.commitSync(workspace.id, plan.id, {
          createIndexJob: true,
          connector: {
            ...attempt,
            cursor: { ref: "main", tree_sha: "session-expired-tree" },
            upstreamRevision: "session-expired-tree",
            files: [
              {
                sourceId: source.id,
                path,
                remoteRevision: "session-expired-tree",
                contentHash: hash,
                bytes: content.length,
              },
            ],
          },
        }),
        /Sync session has expired/,
      );
    } finally {
      await adminDatabase.query(
        `DROP TRIGGER IF EXISTS ce_test_expire_session_on_workspace_update
         ON ${quotedSchema}.ce_workspaces`,
      );
    }

    assert.equal((await firstWorker.requireWorkspace(workspace.id)).revision, 0);
    assert.equal(await firstWorker.readSourceFile(workspace.id, path), null);
    assert.deepEqual(await firstWorker.listConnectorFiles(source.id), []);
    const session = await adminDatabase.query<{ status: string; active: boolean }>(
      `SELECT status, expires_at > clock_timestamp() AS active
       FROM ${quotedSchema}.ce_sync_sessions
       WHERE id = $1`,
      [plan.id],
    );
    assert.deepEqual(session.rows, [{ status: "planned", active: true }]);
    const persisted = await leaseState(source.id);
    assert.equal(persisted.status, "syncing");
    assert.equal(persisted.sync_attempt_id, attempt.syncAttemptId);
    assert.equal(Number(persisted.cursor_version), 0);
    assert.equal(persisted.cursor, null);
    assert.equal(persisted.upstream_revision, null);
    const jobs = await adminDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${quotedSchema}.ce_index_jobs
       WHERE workspace_id = $1`,
      [workspace.id],
    );
    assert.deepEqual(jobs.rows, [{ count: "0" }]);
  });

  it("uses the database clock for sync-plan creation, upload, and commit", async () => {
    const workspace = await firstWorker.createWorkspace({
      name: "Application clock skew",
      sourceMode: "blob",
    });
    const content = Buffer.from(`database-clock:${workspace.id}`);
    const hash = digest(content);
    const path = "src/database-clock.ts";
    const actualNow = Date.now;
    let plan;
    let commit;

    try {
      Date.now = () => 0;
      plan = await firstWorker.createSyncPlan(
        workspace.id,
        workspace.revision,
        [
          {
            op: "upsert",
            path,
            blobHash: hash,
            size: content.length,
            mtimeMs: 0,
          },
        ],
        60_000,
      );
      Date.now = () => 8_000_000_000_000_000;
      await firstWorker.putBlobForSync(workspace.id, plan.id, hash, content);
      commit = await firstWorker.commitSync(workspace.id, plan.id);
    } finally {
      Date.now = actualNow;
    }

    assert.ok(new Date(plan.expiresAt).getTime() > actualNow());
    assert.equal(commit.revision, 1);
    assert.equal((await firstWorker.requireWorkspace(workspace.id)).revision, 1);
    assert.equal((await firstWorker.readSourceFile(workspace.id, path))?.content, content.toString());
  });

  it("serializes concurrent connector attachment and manual plan creation", async () => {
    const workspace = await firstWorker.createWorkspace({
      name: "Attach versus manual plan",
      sourceMode: "blob",
    });

    const [attachment, manualPlan] = await Promise.all([
      settled(
        firstWorker.createConnectorSource({
          workspaceId: workspace.id,
          provider: "github",
          externalId: "owner/attach-manual-race",
          config: { owner: "owner", repository: "attach-manual-race", ref: "main" },
          createdBy: "lease-race-test",
        }),
      ),
      settled(secondWorker.createSyncPlan(workspace.id, workspace.revision, [])),
    ]);

    assert.equal(Number(attachment.ok) + Number(manualPlan.ok), 1);
    const invariant = await adminDatabase.query<{
      connector_count: string | number;
      planned_count: string | number;
    }>(
      `SELECT
         (SELECT count(*) FROM ${quotedSchema}.ce_connector_sources
          WHERE workspace_id = $1) AS connector_count,
         (SELECT count(*) FROM ${quotedSchema}.ce_sync_sessions
          WHERE workspace_id = $1
            AND status = 'planned'
            AND expires_at >= clock_timestamp())
          AS planned_count`,
      [workspace.id],
    );
    const state = invariant.rows[0];
    assert.equal(Number(state.connector_count) + Number(state.planned_count), 1);

    if (attachment.ok) {
      assert.equal(manualPlan.ok, false);
      assert.ok(manualPlan.error instanceof SyncPlanConflictError);
      assert.equal(Number(state.connector_count), 1);
      assert.equal(Number(state.planned_count), 0);
    } else {
      assert.equal(manualPlan.ok, true);
      assert.ok(attachment.error instanceof Error);
      assert.equal(Number(state.connector_count), 0);
      assert.equal(Number(state.planned_count), 1);
    }
  });
});
