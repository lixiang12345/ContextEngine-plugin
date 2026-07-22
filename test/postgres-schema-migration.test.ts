import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(
  baseUrl: string,
  schema: string,
  statementTimeoutMs?: number,
): string {
  const parsed = new URL(baseUrl);
  const options = [`-c search_path=${schema},public`];
  if (statementTimeoutMs) {
    options.push(`-c statement_timeout=${statementTimeoutMs}`);
  }
  parsed.searchParams.set("options", options.join(" "));
  return parsed.toString();
}

function runEnsureSchemaInFreshProcess(url: string): Promise<void> {
  const storeUrl = pathToFileURL(
    `${process.cwd()}/src/store/postgres-store.ts`,
  ).href;
  const source = [
    `import { PostgresStore } from ${JSON.stringify(storeUrl)};`,
    "await PostgresStore.ensureSchema(process.env.CONTEXTENGINE_TEST_DATABASE_URL);",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONTEXTENGINE_TEST_DATABASE_URL: url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `fresh schema migration process failed (code=${code}, signal=${signal}): ${stderr}`,
        ),
      );
    });
  });
}

async function waitForPendingRelationLock(
  pool: Pool,
  schema: string,
  table: string,
  mode: string,
  isSettled: () => boolean,
  operation: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks AS locks
         JOIN pg_class AS relations ON relations.oid = locks.relation
         JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
         WHERE locks.locktype = 'relation'
           AND namespaces.nspname = $1
           AND relations.relname = $2
           AND locks.mode = $3
           AND NOT locks.granted
       ) AS waiting`,
      [schema, table, mode],
    );
    if (result.rows[0]?.waiting) return;
    if (isSettled()) {
      throw new Error(`${operation} completed before its expected lock wait`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${operation} did not enter its expected lock wait`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describePostgres("PostgreSQL schema migration coordination", () => {
  it(
    "migrates v1 source ownership into workspace-scoped blob grants",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let schemaPool: Pool | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        schemaPool = new Pool({ connectionString: schemaUrl });
        await schemaPool.query(`
          CREATE TABLE ce_schema_version (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            version INTEGER NOT NULL CHECK (version > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 1);

          CREATE TABLE ce_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
            local_root TEXT,
            revision BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_source_blobs (
            hash TEXT PRIMARY KEY,
            content BYTEA NOT NULL,
            bytes BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (hash ~ '^[0-9a-f]{64}$')
          );

          CREATE TABLE ce_workspace_sources (
            workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            blob_hash TEXT NOT NULL REFERENCES ce_source_blobs(hash),
            language TEXT NOT NULL,
            mtime_ms BIGINT NOT NULL,
            size BIGINT NOT NULL,
            root_alias TEXT NOT NULL DEFAULT 'main',
            revision BIGINT NOT NULL,
            PRIMARY KEY (workspace_id, path)
          );

          CREATE TABLE ce_sync_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            base_revision BIGINT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
          );
        `);

        const workspaceId = "workspace-v1";
        const referencedContent = Buffer.from("export const migrated = true;\n");
        const referencedHash = createHash("sha256")
          .update(referencedContent)
          .digest("hex");
        const orphanedContent = Buffer.from("not attached to a workspace\n");
        const orphanedHash = createHash("sha256")
          .update(orphanedContent)
          .digest("hex");

        await schemaPool.query(
          `INSERT INTO ce_workspaces(id, name, source_mode, revision)
           VALUES ($1, $2, 'blob', 1)`,
          [workspaceId, "V1 workspace"],
        );
        await schemaPool.query(
          `INSERT INTO ce_source_blobs(hash, content, bytes)
           VALUES ($1, $2, $3), ($4, $5, $6)`,
          [
            referencedHash,
            referencedContent,
            referencedContent.byteLength,
            orphanedHash,
            orphanedContent,
            orphanedContent.byteLength,
          ],
        );
        await schemaPool.query(
          `INSERT INTO ce_workspace_sources(
             workspace_id, path, blob_hash, language, mtime_ms, size, revision
           )
           VALUES
             ($1, 'src/first.ts', $2, 'typescript', 1, $3, 1),
             ($1, 'src/second.ts', $2, 'typescript', 2, $3, 1)`,
          [workspaceId, referencedHash, referencedContent.byteLength],
        );
        await schemaPool.end();
        schemaPool = undefined;

        await runEnsureSchemaInFreshProcess(schemaUrl);

        schemaPool = new Pool({ connectionString: schemaUrl });
        const marker = await schemaPool.query<{ version: number }>(
          `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
        );
        const grants = await schemaPool.query<{
          workspace_id: string;
          blob_hash: string;
        }>(
          `SELECT workspace_id, blob_hash
           FROM ce_workspace_blob_grants
           ORDER BY workspace_id, blob_hash`,
        );

        assert.deepEqual(marker.rows, [{ version: 14 }]);
        const ciTokens = await schemaPool.query<{ table_name: string | null }>(
          `SELECT to_regclass('ce_connector_ci_tokens')::text AS table_name`,
        );
        assert.deepEqual(ciTokens.rows, [{ table_name: "ce_connector_ci_tokens" }]);
        const webhookMetadata = await schemaPool.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'ce_connector_webhook_events'
             AND column_name = 'metadata'`,
          [schema],
        );
        assert.deepEqual(webhookMetadata.rows, [{ column_name: "metadata" }]);
        assert.deepEqual(grants.rows, [
          { workspace_id: workspaceId, blob_hash: referencedHash },
        ]);
      } finally {
        if (schemaPool) await schemaPool.end();
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );

  it(
    "does not replay business-table DDL from a fresh process after the schema marker is current",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let lockClient: PoolClient | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        await runEnsureSchemaInFreshProcess(schemaUrl);

        const marker = await admin.query<{ version: number }>(
          `SELECT version FROM ${quotedSchema}.ce_schema_version WHERE singleton = TRUE`,
        );
        assert.deepEqual(marker.rows, [{ version: 14 }]);

        const mcpSessionColumns = await admin.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'ce_mcp_sessions'
           ORDER BY ordinal_position`,
          [schema],
        );
        assert.deepEqual(
          mcpSessionColumns.rows.map((row) => row.column_name),
          [
            "session_id_hash",
            "workspace_id",
            "principal_id",
            "protocol_version",
            "status",
            "last_seen_at",
            "created_at",
            "updated_at",
          ],
        );

        const additiveTables = await admin.query<{ table_name: string }>(
          `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = $1
             AND table_name IN (
               'ce_source_access_policies', 'ce_source_access_rules',
               'ce_connector_webhook_events'
             )
           ORDER BY table_name`,
          [schema],
        );
        assert.deepEqual(additiveTables.rows, [
          { table_name: "ce_connector_webhook_events" },
          { table_name: "ce_source_access_policies" },
          { table_name: "ce_source_access_rules" },
        ]);

        const leaseColumns = await admin.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'ce_connector_sources'
             AND column_name IN ('sync_attempt_id', 'lease_expires_at')
           ORDER BY column_name`,
          [schema],
        );
        assert.deepEqual(leaseColumns.rows, [
          { column_name: "lease_expires_at" },
          { column_name: "sync_attempt_id" },
        ]);

        const sessionColumns = await admin.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'ce_sync_sessions'
             AND column_name IN ('connector_source_id', 'connector_attempt_id')
           ORDER BY column_name`,
          [schema],
        );
        assert.deepEqual(sessionColumns.rows, [
          { column_name: "connector_attempt_id" },
          { column_name: "connector_source_id" },
        ]);

        const attemptIndex = await admin.query<{ indexname: string }>(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = $1
             AND indexname = 'ce_sync_sessions_connector_attempt_idx'`,
          [schema],
        );
        assert.deepEqual(attemptIndex.rows, [
          { indexname: "ce_sync_sessions_connector_attempt_idx" },
        ]);

        const transitionTrigger = await admin.query<{ trigger_name: string }>(
          `SELECT trigger_name
           FROM information_schema.triggers
           WHERE trigger_schema = $1
             AND event_object_table = 'ce_connector_sources'
             AND trigger_name = 'ce_connector_sync_transition_guard'`,
          [schema],
        );
        assert.deepEqual(transitionTrigger.rows, [
          { trigger_name: "ce_connector_sync_transition_guard" },
        ]);

        lockClient = await admin.connect();
        await lockClient.query("BEGIN");
        // Replaying CREATE INDEX IF NOT EXISTS against ce_chunks needs a lock
        // incompatible with this one. A marker hit avoids all business DDL.
        await lockClient.query(
          `LOCK TABLE ${quotedSchema}.ce_chunks IN ROW EXCLUSIVE MODE`,
        );

        await runEnsureSchemaInFreshProcess(
          databaseUrlForSchema(databaseUrl!, schema, 1_000),
        );
      } finally {
        if (lockClient) {
          try {
            await lockClient.query("ROLLBACK");
          } finally {
            lockClient.release();
          }
        }
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );

  it(
    "adds connector leases and sync-session attempt binding when migrating v2",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let schemaPool: Pool | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        schemaPool = new Pool({ connectionString: schemaUrl });
        await schemaPool.query(`
          CREATE TABLE ce_schema_version (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            version INTEGER NOT NULL CHECK (version > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 2);

          CREATE TABLE ce_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
            local_root TEXT,
            revision BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_connector_sources (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL UNIQUE REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK (provider IN ('github')),
            external_id TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            cursor JSONB,
            cursor_version BIGINT NOT NULL DEFAULT 0,
            upstream_revision TEXT,
            status TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
            last_error TEXT,
            last_synced_at TIMESTAMPTZ,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_sync_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            base_revision BIGINT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
          );

          INSERT INTO ce_workspaces(id, name, source_mode)
          VALUES ('workspace-v2', 'V2 workspace', 'blob');
          INSERT INTO ce_connector_sources(
            id, workspace_id, provider, external_id, status, created_by
          )
          VALUES (
            'source-v2', 'workspace-v2', 'github', 'owner/repository',
            'syncing', 'migration-test'
          );
          INSERT INTO ce_sync_sessions(
            id, workspace_id, base_revision, status, expires_at
          )
          VALUES ('session-v2', 'workspace-v2', 0, 'planned', now() + interval '1 hour');
        `);
        await schemaPool.end();
        schemaPool = undefined;

        await runEnsureSchemaInFreshProcess(schemaUrl);

        schemaPool = new Pool({ connectionString: schemaUrl });
        const marker = await schemaPool.query<{ version: number }>(
          `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
        );
        const source = await schemaPool.query<{
          id: string;
          status: string;
          sync_attempt_id: string | null;
          lease_expires_at: Date | null;
        }>(
          `SELECT id, status, sync_attempt_id, lease_expires_at
           FROM ce_connector_sources
           WHERE id = 'source-v2'`,
        );
        const session = await schemaPool.query<{
          id: string;
          connector_source_id: string | null;
          connector_attempt_id: string | null;
        }>(
          `SELECT id, connector_source_id, connector_attempt_id
           FROM ce_sync_sessions
           WHERE id = 'session-v2'`,
        );

        assert.deepEqual(marker.rows, [{ version: 14 }]);
        assert.deepEqual(source.rows, [
          {
            id: "source-v2",
            status: "syncing",
            sync_attempt_id: null,
            lease_expires_at: null,
          },
        ]);
        assert.deepEqual(session.rows, [
          {
            id: "session-v2",
            connector_source_id: null,
            connector_attempt_id: null,
          },
        ]);

        await schemaPool.query(
          `UPDATE ce_connector_sources
           SET status = 'syncing',
               sync_attempt_id = 'active-v4-attempt',
               lease_expires_at = clock_timestamp() + interval '15 minutes'
           WHERE id = 'source-v2'`,
        );
        await assert.rejects(
          schemaPool.query(
            `UPDATE ce_connector_sources
             SET status = 'ready'
             WHERE id = 'source-v2'`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
        await schemaPool.query(
          `UPDATE ce_connector_sources
           SET status = 'ready',
               sync_attempt_id = NULL,
               lease_expires_at = NULL
           WHERE id = 'source-v2'`,
        );
      } finally {
        if (schemaPool) await schemaPool.end();
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );

  it(
    "preserves active leases and existing sessions when migrating v3 to v4",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let schemaPool: Pool | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        schemaPool = new Pool({ connectionString: schemaUrl });
        await schemaPool.query(`
          CREATE TABLE ce_schema_version (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            version INTEGER NOT NULL CHECK (version > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 3);

          CREATE TABLE ce_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
            local_root TEXT,
            revision BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_connector_sources (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL UNIQUE REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK (provider IN ('github')),
            external_id TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            cursor JSONB,
            cursor_version BIGINT NOT NULL DEFAULT 0,
            sync_attempt_id TEXT,
            lease_expires_at TIMESTAMPTZ,
            upstream_revision TEXT,
            status TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
            last_error TEXT,
            last_synced_at TIMESTAMPTZ,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_sync_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            base_revision BIGINT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
          );

          INSERT INTO ce_workspaces(id, name, source_mode)
          VALUES ('workspace-v3', 'V3 workspace', 'blob');
          INSERT INTO ce_connector_sources(
            id, workspace_id, provider, external_id, status, sync_attempt_id,
            lease_expires_at, created_by
          )
          VALUES (
            'source-v3', 'workspace-v3', 'github', 'owner/repository',
            'syncing', 'active-v3-attempt', now() + interval '10 minutes',
            'migration-test'
          );
          INSERT INTO ce_sync_sessions(
            id, workspace_id, base_revision, status, expires_at
          )
          VALUES ('session-v3', 'workspace-v3', 0, 'planned', now() + interval '1 hour');
        `);
        await schemaPool.end();
        schemaPool = undefined;

        await runEnsureSchemaInFreshProcess(schemaUrl);

        schemaPool = new Pool({ connectionString: schemaUrl });
        const marker = await schemaPool.query<{ version: number }>(
          `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
        );
        const source = await schemaPool.query<{
          status: string;
          sync_attempt_id: string | null;
          lease_active: boolean;
        }>(
          `SELECT status, sync_attempt_id, lease_expires_at > clock_timestamp() AS lease_active
           FROM ce_connector_sources
           WHERE id = 'source-v3'`,
        );
        const session = await schemaPool.query<{
          id: string;
          connector_source_id: string | null;
          connector_attempt_id: string | null;
        }>(
          `SELECT id, connector_source_id, connector_attempt_id
           FROM ce_sync_sessions
           WHERE id = 'session-v3'`,
        );

        assert.deepEqual(marker.rows, [{ version: 14 }]);
        assert.deepEqual(source.rows, [
          {
            status: "syncing",
            sync_attempt_id: "active-v3-attempt",
            lease_active: true,
          },
        ]);
        assert.deepEqual(session.rows, [
          {
            id: "session-v3",
            connector_source_id: null,
            connector_attempt_id: null,
          },
        ]);
      } finally {
        if (schemaPool) await schemaPool.end();
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );

  it(
    "adds durable MCP, plugins, source ACL, webhook inbox, CI tokens, provenance, replication jobs, schedules, and publication pins when migrating v4 to v14",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let schemaPool: Pool | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        schemaPool = new Pool({ connectionString: schemaUrl });
        await schemaPool.query(`
          CREATE TABLE ce_schema_version (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            version INTEGER NOT NULL CHECK (version > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 4);
          CREATE TABLE ce_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
            local_root TEXT,
            revision BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_workspaces(id, name, source_mode)
          VALUES ('workspace-v4', 'V4 workspace', 'blob');
          CREATE TABLE ce_connector_sources (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL UNIQUE REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK (provider IN ('github')),
            external_id TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            cursor JSONB,
            cursor_version BIGINT NOT NULL DEFAULT 0,
            sync_attempt_id TEXT,
            lease_expires_at TIMESTAMPTZ,
            upstream_revision TEXT,
            status TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
            last_error TEXT,
            last_synced_at TIMESTAMPTZ,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
        `);
        await schemaPool.end();
        schemaPool = undefined;

        await runEnsureSchemaInFreshProcess(schemaUrl);
        schemaPool = new Pool({ connectionString: schemaUrl });
        const marker = await schemaPool.query<{ version: number }>(
          `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
        );
        assert.deepEqual(marker.rows, [{ version: 14 }]);
        const snapshotJob = await schemaPool.query<{
          status: string;
          attempts: number;
        }>(
          `INSERT INTO ce_snapshot_jobs(
             id, workspace_id, principal_id, operation, snapshot_name, status
           ) VALUES (
             'snapshot-job-v11', 'workspace-v4', 'migration-test',
             'export', 'main', 'queued'
           )
           RETURNING status, attempts`,
        );
        assert.deepEqual(snapshotJob.rows, [{ status: "queued", attempts: 0 }]);
        const replicationJob = await schemaPool.query<{ operation: string }>(
          `INSERT INTO ce_snapshot_jobs(
             id, workspace_id, principal_id, operation, snapshot_name,
             parameters, status
           ) VALUES (
             'snapshot-replication-v12', 'workspace-v4', 'migration-test',
             'replicate', 'main', '{"target_id":"region_backup"}'::jsonb,
             'queued'
           )
           RETURNING operation`,
        );
        assert.deepEqual(replicationJob.rows, [{ operation: "replicate" }]);
        const publication = await schemaPool.query<{
          publication_sequence: string;
          source_manifest_sha256: string;
        }>(
          `INSERT INTO ce_snapshot_replication_publications(
             job_id, source_manifest, source_manifest_sha256
           ) VALUES (
             'snapshot-replication-v12', '{"generation_id":"v14"}'::jsonb, $1
           )
           RETURNING publication_sequence::text, source_manifest_sha256`,
          ["a".repeat(64)],
        );
        assert.match(publication.rows[0].publication_sequence, /^[1-9][0-9]*$/);
        assert.equal(publication.rows[0].source_manifest_sha256, "a".repeat(64));
        await assert.rejects(
          schemaPool.query(
            `UPDATE ce_snapshot_replication_publications
             SET source_manifest_sha256 = 'invalid'
             WHERE job_id = 'snapshot-replication-v12'`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
        await assert.rejects(
          schemaPool.query(
            `INSERT INTO ce_snapshot_jobs(
               id, workspace_id, principal_id, operation, snapshot_name,
               parameters, status
             ) VALUES (
               'snapshot-replication-duplicate-v13', 'workspace-v4',
               'migration-test', 'replicate', 'main',
               '{"target_id":"region_backup"}'::jsonb, 'queued'
             )`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505",
        );
        const schedule = await schemaPool.query<{ mode: string }>(
          `INSERT INTO ce_snapshot_replication_schedules(
             id, workspace_id, target_id, snapshot_name, mode, interval_ms,
             enabled, next_scheduled_at, created_by
           ) VALUES (
             'replication-schedule-v13', 'workspace-v4', 'region_backup',
             'main', 'interval', 60000, TRUE,
             clock_timestamp() + interval '1 minute', 'migration-test'
           )
           RETURNING mode`,
        );
        assert.deepEqual(schedule.rows, [{ mode: "interval" }]);
        await assert.rejects(
          schemaPool.query(
            `INSERT INTO ce_snapshot_replication_schedules(
               id, workspace_id, target_id, snapshot_name, mode, interval_ms,
               enabled, next_scheduled_at, created_by
             ) VALUES (
               'replication-schedule-invalid-v13', 'workspace-v4',
               'region_backup_2', 'main', 'interval', 60000, TRUE, NULL,
               'migration-test'
             )`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
        await assert.rejects(
          schemaPool.query(
            `INSERT INTO ce_snapshot_jobs(
               id, workspace_id, principal_id, operation, snapshot_name,
               parameters, status
             ) VALUES (
               'snapshot-replication-invalid-v12', 'workspace-v4',
               'migration-test', 'replicate', 'main', '{}'::jsonb, 'queued'
             )`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
        await schemaPool.query(
          `INSERT INTO ce_connector_sources(
             id, workspace_id, provider, external_id, created_by
           ) VALUES (
             'memory-source', 'workspace-v4', 'memory_docs',
             'docs/example', 'migration-test'
           )`,
        );
        await schemaPool.query(
          `INSERT INTO ce_mcp_sessions(
             session_id_hash, workspace_id, principal_id, protocol_version
           ) VALUES ($1, 'workspace-v4', 'alice', '2025-03-26')`,
          ["a".repeat(64)],
        );
        await assert.rejects(
          schemaPool.query(
            `INSERT INTO ce_mcp_sessions(
               session_id_hash, workspace_id, principal_id, protocol_version
             ) VALUES ('raw-replayable-id', 'workspace-v4', 'alice', '2025-03-26')`,
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23514",
        );
      } finally {
        if (schemaPool) await schemaPool.end();
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );

  it("deduplicates active v12 replications before installing the v13 invariant", async () => {
    const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
    const admin = new Pool({ connectionString: databaseUrl! });
    let schemaPool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${quotedSchema}`);
      schemaPool = new Pool({ connectionString: schemaUrl });
      await schemaPool.query(`
        CREATE TABLE ce_schema_version (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          version INTEGER NOT NULL CHECK (version > 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 12);
        CREATE TABLE ce_workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source_mode TEXT NOT NULL,
          local_root TEXT,
          revision BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ce_workspaces(id, name, source_mode)
        VALUES ('workspace-v12', 'V12 workspace', 'blob');
        CREATE TABLE ce_snapshot_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
          principal_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          snapshot_name TEXT,
          parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL,
          progress JSONB NOT NULL DEFAULT '{}'::jsonb,
          result JSONB,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          locked_at TIMESTAMPTZ,
          lock_token TEXT,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ
        );
        INSERT INTO ce_snapshot_jobs(
          id, workspace_id, principal_id, operation, snapshot_name,
          parameters, status, locked_at, lock_token
        ) VALUES
          ('queued-v12', 'workspace-v12', 'owner', 'replicate', 'main',
           '{"target_id":"region_backup"}', 'queued', NULL, NULL),
          ('running-v12', 'workspace-v12', 'owner', 'replicate', 'main',
           '{"target_id":"region_backup"}', 'running', clock_timestamp(), 'attempt');
      `);
      await schemaPool.end();
      schemaPool = undefined;

      await runEnsureSchemaInFreshProcess(schemaUrl);
      schemaPool = new Pool({ connectionString: schemaUrl });
      const jobs = await schemaPool.query<{ id: string; status: string; error: string | null }>(
        `SELECT id, status, error
         FROM ce_snapshot_jobs
         ORDER BY id`,
      );
      assert.deepEqual(jobs.rows, [
        {
          id: "queued-v12",
          status: "failed",
          error: "Superseded by schema v13 active replication deduplication",
        },
        { id: "running-v12", status: "running", error: null },
      ]);
      const marker = await schemaPool.query<{ version: number }>(
        `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
      );
      assert.deepEqual(marker.rows, [{ version: 14 }]);
    } finally {
      if (schemaPool) await schemaPool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  it("rejects a database schema newer than this build", async () => {
    const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
    const admin = new Pool({ connectionString: databaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA ${quotedSchema}`);
      await admin.query(`
        CREATE TABLE ${quotedSchema}.ce_schema_version (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
          version INTEGER NOT NULL CHECK (version > 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO ${quotedSchema}.ce_schema_version(singleton, version)
        VALUES (TRUE, 15);
      `);
      await assert.rejects(
        runEnsureSchemaInFreshProcess(schemaUrl),
        /schema version 15 is newer than this build \(14\)/,
      );
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  it(
    "blocks legacy connector completion until the v3-to-v4 guard is committed",
    { timeout: 15_000 },
    async () => {
      const schema = `ce_migration_${process.pid}_${randomUUID().replaceAll("-", "")}`;
      const quotedSchema = quoteIdentifier(schema);
      const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
      const admin = new Pool({ connectionString: databaseUrl! });
      let schemaPool: Pool | undefined;
      let lockClient: PoolClient | undefined;
      let migrationSettled = false;
      let legacyUpdateSettled = false;
      let migrationOutcome:
        | Promise<
            | { status: "fulfilled" }
            | { status: "rejected"; error: unknown }
          >
        | undefined;
      let legacyUpdateOutcome:
        | Promise<
            | { status: "fulfilled"; rowCount: number | null }
            | { status: "rejected"; error: unknown }
          >
        | undefined;

      try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        schemaPool = new Pool({ connectionString: schemaUrl });
        await schemaPool.query(`
          CREATE TABLE ce_schema_version (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            version INTEGER NOT NULL CHECK (version > 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          INSERT INTO ce_schema_version(singleton, version) VALUES (TRUE, 3);

          CREATE TABLE ce_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
            local_root TEXT,
            revision BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_connector_sources (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL UNIQUE REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            provider TEXT NOT NULL CHECK (provider IN ('github')),
            external_id TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            cursor JSONB,
            cursor_version BIGINT NOT NULL DEFAULT 0,
            sync_attempt_id TEXT,
            lease_expires_at TIMESTAMPTZ,
            upstream_revision TEXT,
            status TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
            last_error TEXT,
            last_synced_at TIMESTAMPTZ,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE ce_sync_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
            base_revision BIGINT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL
          );

          INSERT INTO ce_workspaces(id, name, source_mode)
          VALUES ('workspace-v3', 'V3 workspace', 'blob');
          INSERT INTO ce_connector_sources(
            id, workspace_id, provider, external_id, status, sync_attempt_id,
            lease_expires_at, created_by
          )
          VALUES (
            'source-v3', 'workspace-v3', 'github', 'owner/repository',
            'syncing', 'active-v3-attempt', now() + interval '10 minutes',
            'migration-test'
          );
          INSERT INTO ce_sync_sessions(
            id, workspace_id, base_revision, status, expires_at
          )
          VALUES ('session-v3', 'workspace-v3', 0, 'planned', now() + interval '1 hour');
        `);
        await schemaPool.end();
        schemaPool = undefined;

        lockClient = await admin.connect();
        await lockClient.query("BEGIN");
        await lockClient.query(
          `LOCK TABLE ${quotedSchema}.ce_sync_sessions IN ACCESS SHARE MODE`,
        );

        migrationOutcome = runEnsureSchemaInFreshProcess(schemaUrl)
          .then(
            () => ({ status: "fulfilled" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          )
          .then((outcome) => {
            migrationSettled = true;
            return outcome;
          });

        await waitForPendingRelationLock(
          admin,
          schema,
          "ce_sync_sessions",
          "AccessExclusiveLock",
          () => migrationSettled,
          "v4 migration",
        );

        schemaPool = new Pool({ connectionString: schemaUrl });
        legacyUpdateOutcome = schemaPool
          .query(
            `UPDATE ce_connector_sources
             SET status = 'ready'
             WHERE id = 'source-v3'`,
          )
          .then(
            (result) => ({
              status: "fulfilled" as const,
              rowCount: result.rowCount,
            }),
            (error: unknown) => ({
              status: "rejected" as const,
              error,
            }),
          )
          .then((outcome) => {
            legacyUpdateSettled = true;
            return outcome;
          });

        await waitForPendingRelationLock(
          admin,
          schema,
          "ce_connector_sources",
          "RowExclusiveLock",
          () => legacyUpdateSettled,
          "legacy connector completion",
        );
        assert.equal(
          legacyUpdateSettled,
          false,
          "legacy connector completion succeeded before the v4 migration committed",
        );
        assert.equal(migrationSettled, false);

        await lockClient.query("ROLLBACK");
        lockClient.release();
        lockClient = undefined;

        const migrationResult = await migrationOutcome;
        assert.deepEqual(migrationResult, { status: "fulfilled" });

        const legacyUpdateResult = await legacyUpdateOutcome;
        assert.equal(legacyUpdateResult.status, "rejected");
        if (legacyUpdateResult.status === "rejected") {
          assert.equal(
            typeof legacyUpdateResult.error === "object" &&
              legacyUpdateResult.error !== null &&
              "code" in legacyUpdateResult.error
              ? legacyUpdateResult.error.code
              : undefined,
            "23514",
          );
        }
      } finally {
        if (lockClient) {
          try {
            await lockClient.query("ROLLBACK");
          } finally {
            lockClient.release();
          }
        }
        if (migrationOutcome) await migrationOutcome;
        if (legacyUpdateOutcome) await legacyUpdateOutcome;
        if (schemaPool) await schemaPool.end();
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  );
});
