import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import pgvector from "pgvector/pg";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodeChunk, IndexStats, SourcePathPolicy } from "../types.js";
import { extractSymbolNames } from "../chunker/code-chunker.js";
import { extractImports } from "../graph/symbol-graph.js";
import { tokenize } from "../search/bm25.js";

export const INDEX_VERSION = 3;
const SCHEMA_VERSION = 15;
const SCHEMA_LOCK_ID = 842847321;
const SCHEMA_DDL_MAX_ATTEMPTS = 4;
const DEFAULT_GENERATION_RETENTION_MS = 60 * 60 * 1000;
const GENERATION_GC_BATCH = 8;

export interface StoreSearchFilter {
  pathPrefix?: string;
  sourceAccess?: SourcePathPolicy;
  language?: string;
  includeCommits?: boolean;
}

interface PostgresStoreOptions {
  databaseUrl: string;
  workspaceId: string;
  /** Hold a cross-process workspace lock for the full indexing operation. */
  lockWorkspace?: boolean;
}

interface FileMetadata {
  path: string;
  hash: string;
  language: string;
  mtimeMs: number;
  size: number;
  rootAlias?: string;
}

export interface SnapshotFileRow extends FileMetadata {
  rootAlias: string;
}

export interface SnapshotChunkRow extends CodeChunk {
  rootAlias: string;
}

export interface SnapshotEmbeddingRow {
  chunkId: string;
  model: string;
  dim: number;
  embedding: string;
}

export interface IndexGenerationStatus {
  generationId: string | null;
  sourceRevision: string | null;
  indexedRevision: string | null;
  pendingRevision: string | null;
  status: "active" | "building" | "retired" | "failed" | null;
  updatedAt: string | null;
}

interface ResolvedGeneration {
  generationId: string;
  storageWorkspaceId: string;
}

function generationRetentionMs(): number {
  const parsed = Number(process.env.CONTEXTENGINE_GENERATION_RETENTION_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_GENERATION_RETENTION_MS;
  return Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(parsed)));
}

/** Numeric revisions and timestamp-suffixed local scan revisions are ordered. */
function comparableRevision(value: string | null | undefined): bigint | null {
  const text = value?.trim();
  if (!text) return null;
  const exact = /^\d+$/.test(text) ? text : /:(\d+)$/.exec(text)?.[1];
  if (!exact) return null;
  try {
    return BigInt(exact);
  } catch {
    return null;
  }
}

export class StaleGenerationError extends Error {
  constructor(readonly generationRevision: string, readonly currentRevision: string) {
    super(
      `Index generation revision ${generationRevision} is older than current revision ${currentRevision}`,
    );
    this.name = "StaleGenerationError";
  }
}

function rowToChunk(row: {
  id: string;
  path: string;
  language: string;
  start_line: number;
  end_line: number;
  content: string;
  symbol: string | null;
  hash: string;
}): CodeChunk {
  return {
    id: row.id,
    path: row.path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    symbol: row.symbol ?? undefined,
    hash: row.hash,
  };
}

function searchText(chunk: CodeChunk): string {
  return tokenize(
    [chunk.path, chunk.path, chunk.symbol ?? "", chunk.symbol ?? "", chunk.language, chunk.content].join(
      "\n",
    ),
  ).join(" ");
}

function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "postgresql://configured";
  }
}

function extractDefNames(content: string, language: string): string[] {
  return extractSymbolNames(content, language);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isRetryableSchemaError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === "40P01" || code === "40001";
}

async function retrySchemaDdl(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SCHEMA_DDL_MAX_ATTEMPTS; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableSchemaError(error) || attempt === SCHEMA_DDL_MAX_ATTEMPTS - 1) {
        throw error;
      }
      await sleep(75 * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Unified PostgreSQL store. Runtime vectors live in pgvector, never in a
 * SQLite BLOB or a process-wide in-memory map.
 */
export class PostgresStore {
  private static readonly schemaMigrations = new Map<string, Promise<void>>();

  readonly databaseUrl: string;
  /** Physical namespace used by all index tables. */
  readonly workspaceId: string;
  /** Stable caller-facing workspace id whose active generation is resolved. */
  readonly logicalWorkspaceId: string;
  readonly generationId: string;
  private readonly pool: Pool;
  private readonly client: PoolClient | null;
  private lockClient: PoolClient | null;
  private lockKey: string | null;
  private closed = false;

  private constructor(
    databaseUrl: string,
    workspaceId: string,
    pool: Pool,
    client: PoolClient | null = null,
    logicalWorkspaceId = workspaceId,
    generationId = "legacy",
    lockClient: PoolClient | null = null,
    lockKey: string | null = null,
  ) {
    this.databaseUrl = databaseUrl;
    this.workspaceId = workspaceId;
    this.logicalWorkspaceId = logicalWorkspaceId;
    this.generationId = generationId;
    this.pool = pool;
    this.client = client;
    this.lockClient = lockClient;
    this.lockKey = lockKey;
  }

  static async open(options: PostgresStoreOptions): Promise<PostgresStore> {
    const pool = new Pool({
      connectionString: options.databaseUrl,
      max: Math.max(2, Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8) || 8),
    });
    let lockClient: PoolClient | null = null;
    let lockKey: string | null = null;
    try {
      await PostgresStore.ensureMigrated(options.databaseUrl);
      const bootstrap = new PostgresStore(
        options.databaseUrl,
        options.workspaceId,
        pool,
      );
      // Run bounded retention cleanup before taking an indexing lock. This
      // keeps pool size 1 deployments from deadlocking on their lock session.
      if (options.workspaceId) {
        try {
          await bootstrap.gcGenerations();
        } catch {
          // Retention cleanup is best effort and must not make readers fail to
          // open. A later open will retry the bounded batch.
        }
      }
      if (options.lockWorkspace && options.workspaceId) {
        const lock = await bootstrap.acquireWorkspaceLock(options.workspaceId);
        lockClient = lock.client;
        lockKey = lock.key;
      }
      const resolved = options.workspaceId
        ? await bootstrap.resolveActiveGeneration(options.workspaceId)
        : {
            generationId: "legacy",
            storageWorkspaceId: options.workspaceId,
          };
      const store = new PostgresStore(
        options.databaseUrl,
        resolved.storageWorkspaceId,
        pool,
        null,
        options.workspaceId,
        resolved.generationId,
        lockClient,
        lockKey,
      );
      if (options.workspaceId) {
        await store.setMeta("index_version", String(INDEX_VERSION));
      }
      lockClient = null;
      lockKey = null;
      return store;
    } catch (error) {
      if (lockClient) {
        try {
          if (lockKey) {
            await lockClient.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]);
          }
        } finally {
          lockClient.release();
        }
      }
      await pool.end();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `PostgreSQL + pgvector is required. Set CONTEXTENGINE_DATABASE_URL and enable the vector extension. ${detail}`,
      );
    }
  }

  /**
   * Create shared database objects without assigning index metadata to a
   * particular workspace. HTTP workspace/blob APIs use this before opening an
   * engine namespace.
   */
  static async ensureSchema(databaseUrl: string): Promise<void> {
    await PostgresStore.ensureMigrated(databaseUrl);
  }

  private static async ensureMigrated(databaseUrl: string): Promise<void> {
    const existing = PostgresStore.schemaMigrations.get(databaseUrl);
    if (existing) return existing;

    const pool = new Pool({
      connectionString: databaseUrl,
      max: Math.max(2, Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8) || 8),
    });
    const store = new PostgresStore(databaseUrl, "", pool);
    const migration = retrySchemaDdl(() => store.migrate(false))
      .catch((error) => {
        PostgresStore.schemaMigrations.delete(databaseUrl);
        throw error;
      })
      .finally(async () => {
        await pool.end();
      });
    PostgresStore.schemaMigrations.set(databaseUrl, migration);
    return migration;
  }

  get hasFts(): boolean {
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const lockClient = this.lockClient;
    const lockKey = this.lockKey;
    this.lockClient = null;
    this.lockKey = null;
    if (lockClient) {
      try {
        if (lockKey) {
          await lockClient.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]);
        }
      } finally {
        lockClient.release();
      }
    }
    if (!this.client) await this.pool.end();
  }

  async transaction<T>(fn: (store: PostgresStore) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(
        new PostgresStore(
          this.databaseUrl,
          this.workspaceId,
          this.pool,
          client,
          this.logicalWorkspaceId,
          this.generationId,
        ),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pin one immutable MVCC view while a snapshot is streamed in pages. */
  async consistentRead<T>(fn: (store: PostgresStore) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await fn(new PostgresStore(
        this.databaseUrl,
        this.workspaceId,
        this.pool,
        client,
        this.logicalWorkspaceId,
        this.generationId,
      ));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async acquireWorkspaceLock(
    logicalWorkspaceId: string,
  ): Promise<{ client: PoolClient; key: string }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ key: string }>(
        `SELECT hashtextextended($1, 0)::text AS key`,
        [logicalWorkspaceId],
      );
      const key = result.rows[0]?.key;
      if (!key) throw new Error("Unable to derive workspace index lock key");
      await client.query(`SELECT pg_advisory_lock($1::bigint)`, [key]);
      return { client, key };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /**
   * Start an isolated copy-on-write generation. Readers continue using the
   * currently promoted namespace while the caller incrementally mutates the
   * returned staging store. Promotion is a single alias update.
   */
  async beginGeneration(sourceRevision?: string | number | null): Promise<PostgresStore> {
    if (!this.logicalWorkspaceId) {
      throw new Error("Cannot create an index generation without a workspace id");
    }
    const generationId = randomUUID();
    const storageWorkspaceId = `${this.logicalWorkspaceId}::generation:${generationId}`;
    const revision = sourceRevision === undefined || sourceRevision === null
      ? null
      : String(sourceRevision);

    await this.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ce_workspace_generations(
           id, logical_workspace_id, storage_workspace_id, source_revision,
           pending_revision, status
         ) VALUES ($1, $2, $3, $4, $4, 'building')`,
        [generationId, this.logicalWorkspaceId, storageWorkspaceId, revision],
      );

      // Copy in foreign-key order. JSON/blob content stays in PostgreSQL and
      // is never materialized in the indexing process.
      await tx.query(
        `INSERT INTO ce_meta(workspace_id, key, value)
         SELECT $2, key, value FROM ce_meta WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_files(workspace_id, path, hash, language, mtime_ms, size, root_alias)
         SELECT $2, path, hash, language, mtime_ms, size, root_alias
         FROM ce_files WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_chunks(
           workspace_id, id, path, language, start_line, end_line,
           content, symbol, hash, root_alias, search_vector
         )
         SELECT $2, id, path, language, start_line, end_line,
                content, symbol, hash, root_alias, search_vector
         FROM ce_chunks WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_embeddings(workspace_id, chunk_id, model, dim, embedding)
         SELECT $2, chunk_id, model, dim, embedding
         FROM ce_embeddings WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_symbols(
           workspace_id, name, name_lower, path, chunk_id, start_line, kind
         )
         SELECT $2, name, name_lower, path, chunk_id, start_line, kind
         FROM ce_symbols WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_imports(workspace_id, source_path, target_spec)
         SELECT $2, source_path, target_spec
         FROM ce_imports WHERE workspace_id = $1`,
        [this.workspaceId, storageWorkspaceId],
      );
      await tx.query(
        `INSERT INTO ce_meta(workspace_id, key, value)
         VALUES ($1, 'generation_id', $2),
                ($1, 'source_revision', COALESCE($3, '')),
                ($1, 'pending_revision', COALESCE($3, ''))
         ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
        [storageWorkspaceId, generationId, revision],
      );
    });

    // The lock belongs to the full indexing lifecycle, not the bootstrap
    // reader. Transfer it to the staging store so close() releases it only
    // after promotion or discard.
    const lockClient = this.lockClient;
    const lockKey = this.lockKey;
    this.lockClient = null;
    this.lockKey = null;
    return new PostgresStore(
      this.databaseUrl,
      storageWorkspaceId,
      this.pool,
      null,
      this.logicalWorkspaceId,
      generationId,
      lockClient,
      lockKey,
    );
  }

  /** Atomically make this staging generation visible to newly opened readers. */
  async promoteGeneration(): Promise<void> {
    if (this.generationId === "legacy") return;
    await this.transaction(async (tx) => {
      const current = await tx.query<{ generation_id: string }>(
        `SELECT generation_id
         FROM ce_workspace_aliases
         WHERE logical_workspace_id = $1
         FOR UPDATE`,
        [this.logicalWorkspaceId],
      );
      const oldGeneration = current.rows[0]?.generation_id;

      const target = await tx.query<{
        status: IndexGenerationStatus["status"];
        source_revision: string | null;
        pending_revision: string | null;
      }>(
        `SELECT status, source_revision, pending_revision
         FROM ce_workspace_generations
         WHERE id = $1
         FOR UPDATE`,
        [this.generationId],
      );
      const targetRow = target.rows[0];
      if (!targetRow) {
        throw new Error(`Index generation not found: ${this.generationId}`);
      }
      if (targetRow.status === "active" && oldGeneration === this.generationId) {
        return;
      }
      if (targetRow.status !== "building") {
        throw new Error(
          `Index generation ${this.generationId} cannot be promoted from ${targetRow.status}`,
        );
      }

      const active = oldGeneration
        ? await tx.query<{
            indexed_revision: string | null;
            source_revision: string | null;
          }>(
            `SELECT indexed_revision, source_revision
             FROM ce_workspace_generations
             WHERE id = $1`,
            [oldGeneration],
          )
        : { rows: [] };
      const workspace = await tx.query<{ revision: string | number }>(
        `SELECT revision
         FROM ce_workspaces
         WHERE id = $1
         FOR SHARE`,
        [this.logicalWorkspaceId],
      );
      const targetRevision = comparableRevision(
        targetRow.pending_revision ?? targetRow.source_revision,
      );
      const activeRevision = comparableRevision(
        active.rows[0]?.indexed_revision ?? active.rows[0]?.source_revision,
      );
      const workspaceRevision = comparableRevision(
        workspace.rows[0] ? String(workspace.rows[0].revision) : null,
      );
      const currentRevision =
        activeRevision !== null && workspaceRevision !== null
          ? activeRevision > workspaceRevision
            ? activeRevision
            : workspaceRevision
          : activeRevision ?? workspaceRevision;
      if (
        targetRevision !== null &&
        currentRevision !== null &&
        targetRevision < currentRevision
      ) {
        throw new StaleGenerationError(
          targetRow.pending_revision ?? targetRow.source_revision ?? "unknown",
          currentRevision.toString(),
        );
      }

      if (oldGeneration && oldGeneration !== this.generationId) {
        await tx.query(
          `UPDATE ce_workspace_generations
           SET status = 'retired', updated_at = now()
           WHERE id = $1 AND status = 'active'`,
          [oldGeneration],
        );
      }
      const promoted = await tx.query(
        `UPDATE ce_workspace_generations
         SET status = 'active', indexed_revision = pending_revision,
             pending_revision = NULL, promoted_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'building'
         RETURNING id`,
        [this.generationId],
      );
      if (!promoted.rows.length) {
        throw new Error(`Index generation ${this.generationId} was changed before promotion`);
      }
      await tx.query(
        `INSERT INTO ce_workspace_aliases(logical_workspace_id, generation_id, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT(logical_workspace_id) DO UPDATE SET
           generation_id = excluded.generation_id, updated_at = now()`,
        [this.logicalWorkspaceId, this.generationId],
      );
      await tx.query(
        `INSERT INTO ce_meta(workspace_id, key, value)
         VALUES ($1, 'indexed_revision', COALESCE($2, ''))
         ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
        [this.workspaceId, targetRow.pending_revision ?? targetRow.source_revision],
      );
    });
  }

  /** Mark a failed staging generation and remove its searchable rows. */
  async discardGeneration(): Promise<void> {
    if (this.generationId === "legacy") return;
    try {
      await this.clearWorkspace();
    } finally {
      await this.query(
        `UPDATE ce_workspace_generations
         SET status = 'failed', pending_revision = NULL, updated_at = now()
         WHERE id = $1`,
        [this.generationId],
      );
    }
  }

  /** Return false when this reader is pinned to a retired generation. */
  async isCurrentGeneration(): Promise<boolean> {
    if (!this.logicalWorkspaceId) return true;
    const result = await this.query<{ generation_id: string }>(
      `SELECT generation_id
       FROM ce_workspace_aliases
       WHERE logical_workspace_id = $1`,
      [this.logicalWorkspaceId],
    );
    return result.rows[0]?.generation_id === this.generationId;
  }

  /**
   * Remove old staging namespaces after a grace period. Retention is required
   * because another process may still be serving a reader pinned to the old
   * alias while it refreshes.
   */
  async gcGenerations(
    retentionMs = generationRetentionMs(),
    limit = GENERATION_GC_BATCH,
  ): Promise<number> {
    if (!this.logicalWorkspaceId) return 0;
    const boundedLimit = Math.max(1, Math.min(GENERATION_GC_BATCH, Math.floor(limit)));
    return this.transaction(async (tx) => {
      const candidates = await tx.query<{
        id: string;
        storage_workspace_id: string;
      }>(
        `SELECT g.id, g.storage_workspace_id
         FROM ce_workspace_generations g
         WHERE g.logical_workspace_id = $1
           AND g.status IN ('retired', 'failed')
           AND g.updated_at < now() - ($2::bigint * interval '1 millisecond')
           AND NOT EXISTS (
             SELECT 1 FROM ce_workspace_aliases a
             WHERE a.generation_id = g.id
           )
         ORDER BY g.updated_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [this.logicalWorkspaceId, Math.max(60_000, Math.floor(retentionMs)), boundedLimit],
      );
      for (const candidate of candidates.rows) {
        // Chunk foreign keys cascade embeddings and symbols; the remaining
        // tables have no generation FK and must be removed explicitly.
        await tx.query(`DELETE FROM ce_chunks WHERE workspace_id = $1`, [
          candidate.storage_workspace_id,
        ]);
        await tx.query(`DELETE FROM ce_imports WHERE workspace_id = $1`, [
          candidate.storage_workspace_id,
        ]);
        await tx.query(`DELETE FROM ce_files WHERE workspace_id = $1`, [
          candidate.storage_workspace_id,
        ]);
        await tx.query(`DELETE FROM ce_meta WHERE workspace_id = $1`, [
          candidate.storage_workspace_id,
        ]);
        await tx.query(
          `DELETE FROM ce_workspace_generations
           WHERE id = $1 AND status IN ('retired', 'failed')`,
          [candidate.id],
        );
      }
      return candidates.rows.length;
    });
  }

  async generationStatus(): Promise<IndexGenerationStatus> {
    if (!this.logicalWorkspaceId) {
      return {
        generationId: null,
        sourceRevision: null,
        indexedRevision: null,
        pendingRevision: null,
        status: null,
        updatedAt: null,
      };
    }
    const result = await this.query<{
      generation_id: string;
      source_revision: string | null;
      indexed_revision: string | null;
      status: IndexGenerationStatus["status"];
      updated_at: string;
      pending_revision: string | null;
    }>(
      `SELECT serving.id AS generation_id,
              serving.source_revision,
              serving.indexed_revision,
              serving.status,
              serving.updated_at,
              pending.pending_revision
       FROM ce_workspace_generations serving
       LEFT JOIN LATERAL (
         SELECT pending_revision
         FROM ce_workspace_generations
         WHERE logical_workspace_id = $1 AND status = 'building'
         ORDER BY created_at DESC
         LIMIT 1
       ) pending ON true
       WHERE serving.logical_workspace_id = $1 AND serving.id = $2`,
      [this.logicalWorkspaceId, this.generationId],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        generationId: this.generationId === "legacy" ? null : this.generationId,
        sourceRevision: null,
        indexedRevision: null,
        pendingRevision: null,
        status: null,
        updatedAt: null,
      };
    }
    return {
      generationId: row.generation_id,
      sourceRevision: row.source_revision,
      indexedRevision: row.indexed_revision,
      pendingRevision: row.pending_revision,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  private async resolveActiveGeneration(logicalWorkspaceId: string): Promise<ResolvedGeneration> {
    const legacyId = `legacy:${logicalWorkspaceId}`;
    await this.query(
      `INSERT INTO ce_workspace_generations(
         id, logical_workspace_id, storage_workspace_id, indexed_revision, status
       ) VALUES ($1, $2, $2, NULL, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [legacyId, logicalWorkspaceId],
    );
    await this.query(
      `INSERT INTO ce_workspace_aliases(logical_workspace_id, generation_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (logical_workspace_id) DO NOTHING`,
      [logicalWorkspaceId, legacyId],
    );
    const result = await this.query<ResolvedGeneration>(
      `SELECT g.id AS "generationId", g.storage_workspace_id AS "storageWorkspaceId"
       FROM ce_workspace_aliases a
       JOIN ce_workspace_generations g ON g.id = a.generation_id
       WHERE a.logical_workspace_id = $1`,
      [logicalWorkspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Unable to resolve active index generation for ${logicalWorkspaceId}`);
    return row;
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.query<{ value: string }>(
      `SELECT value FROM ce_meta WHERE workspace_id = $1 AND key = $2`,
      [this.workspaceId, key],
    );
    return result.rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO ce_meta(workspace_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
      [this.workspaceId, key, value],
    );
  }

  /** Safe, portable metadata only; local roots and generation ids are excluded. */
  async snapshotMetadata(): Promise<Record<string, string>> {
    const result = await this.query<{ key: string; value: string }>(
      `SELECT key, value
       FROM ce_meta
       WHERE workspace_id = $1
         AND key = ANY($2::text[])
       ORDER BY key`,
      [
        this.workspaceId,
        [
          "commit_lineage_key",
          "embedding_model",
          "embedding_signature",
          "index_version",
          "last_indexed_at",
          "search_tokenizer_version",
        ],
      ],
    );
    return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  }

  async snapshotFilesPage(afterPath: string | null, limit = 500): Promise<SnapshotFileRow[]> {
    const bounded = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const result = await this.query<{
      path: string;
      hash: string;
      language: string;
      mtime_ms: string | number;
      size: string | number;
      root_alias: string;
    }>(
      `SELECT path, hash, language, mtime_ms, size, root_alias
       FROM ce_files
       WHERE workspace_id = $1 AND ($2::text IS NULL OR path > $2)
       ORDER BY path
       LIMIT $3`,
      [this.workspaceId, afterPath, bounded],
    );
    return result.rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      language: row.language,
      mtimeMs: Number(row.mtime_ms),
      size: Number(row.size),
      rootAlias: row.root_alias,
    }));
  }

  async snapshotChunksPage(
    after: { path: string; id: string } | null,
    limit = 500,
  ): Promise<SnapshotChunkRow[]> {
    const bounded = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
      root_alias: string;
    }>(
      `SELECT id, path, language, start_line, end_line, content, symbol,
              hash, root_alias
       FROM ce_chunks
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR (path, id) > ($2, $3))
       ORDER BY path, id
       LIMIT $4`,
      [this.workspaceId, after?.path ?? null, after?.id ?? null, bounded],
    );
    return result.rows.map((row) => ({ ...rowToChunk(row), rootAlias: row.root_alias }));
  }

  async snapshotEmbeddingsPage(
    afterChunkId: string | null,
    limit = 500,
  ): Promise<SnapshotEmbeddingRow[]> {
    const bounded = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const result = await this.query<{
      chunk_id: string;
      model: string;
      dim: number;
      embedding: string;
    }>(
      `SELECT chunk_id, model, dim, embedding::text AS embedding
       FROM ce_embeddings
       WHERE workspace_id = $1 AND ($2::text IS NULL OR chunk_id > $2)
       ORDER BY chunk_id
       LIMIT $3`,
      [this.workspaceId, afterChunkId, bounded],
    );
    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      model: row.model,
      dim: Number(row.dim),
      embedding: row.embedding,
    }));
  }

  async snapshotRowCounts(): Promise<{
    files: number;
    chunks: number;
    embeddings: number;
    orphanChunks: number;
  }> {
    const result = await this.query<{
      files: string;
      chunks: string;
      embeddings: string;
      orphan_chunks: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ce_files WHERE workspace_id = $1)::text AS files,
         (SELECT count(*) FROM ce_chunks WHERE workspace_id = $1)::text AS chunks,
         (SELECT count(*) FROM ce_embeddings WHERE workspace_id = $1)::text AS embeddings,
         (SELECT count(*)
          FROM ce_chunks AS chunk
          LEFT JOIN ce_files AS file
            ON file.workspace_id = chunk.workspace_id AND file.path = chunk.path
          WHERE chunk.workspace_id = $1 AND file.path IS NULL)::text AS orphan_chunks`,
      [this.workspaceId],
    );
    const row = result.rows[0];
    return {
      files: Number(row?.files ?? 0),
      chunks: Number(row?.chunks ?? 0),
      embeddings: Number(row?.embeddings ?? 0),
      orphanChunks: Number(row?.orphan_chunks ?? 0),
    };
  }

  async getFileHash(relPath: string): Promise<string | null> {
    const result = await this.query<{ hash: string }>(
      `SELECT hash FROM ce_files WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );
    return result.rows[0]?.hash ?? null;
  }

  async listFilePaths(): Promise<string[]> {
    const result = await this.query<{ path: string }>(
      `SELECT path FROM ce_files WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return result.rows.map((row) => row.path);
  }

  async upsertFile(meta: FileMetadata): Promise<void> {
    await this.query(
      `INSERT INTO ce_files(workspace_id, path, hash, language, mtime_ms, size, root_alias)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(workspace_id, path) DO UPDATE SET
         hash = excluded.hash,
         language = excluded.language,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         root_alias = excluded.root_alias`,
      [
        this.workspaceId,
        meta.path,
        meta.hash,
        meta.language,
        Math.round(meta.mtimeMs),
        meta.size,
        meta.rootAlias ?? "",
      ],
    );
  }

  async upsertFiles(items: readonly FileMetadata[]): Promise<void> {
    if (!items.length) return;
    if (items.length > 2_000) throw new Error("File metadata batch exceeds 2000 rows");
    const rows = items.map((meta) => ({
      path: meta.path,
      hash: meta.hash,
      language: meta.language,
      mtime_ms: Math.round(meta.mtimeMs),
      size: meta.size,
      root_alias: meta.rootAlias ?? "",
    }));
    await this.query(
      `INSERT INTO ce_files(workspace_id, path, hash, language, mtime_ms, size, root_alias)
       SELECT $1, input.path, input.hash, input.language, input.mtime_ms,
              input.size, input.root_alias
       FROM jsonb_to_recordset($2::jsonb) AS input(
         path TEXT, hash TEXT, language TEXT, mtime_ms BIGINT,
         size BIGINT, root_alias TEXT
       )
       ON CONFLICT(workspace_id, path) DO UPDATE SET
         hash = excluded.hash,
         language = excluded.language,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         root_alias = excluded.root_alias`,
      [this.workspaceId, JSON.stringify(rows)],
    );
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.query(
      `WITH deleted_imports AS (
         DELETE FROM ce_imports WHERE workspace_id = $1 AND source_path = $2
       ), deleted_chunks AS (
         DELETE FROM ce_chunks WHERE workspace_id = $1 AND path = $2
       )
       DELETE FROM ce_files WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );
  }

  async replaceChunksForFile(
    relPath: string,
    chunks: CodeChunk[],
    rootAlias = "",
  ): Promise<void> {
    await this.query(
      `DELETE FROM ce_imports WHERE workspace_id = $1 AND source_path = $2`,
      [this.workspaceId, relPath],
    );
    await this.query(
      `DELETE FROM ce_chunks WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );

    if (chunks.length) {
      const chunkRows = chunks.map((chunk) => ({
        id: chunk.id,
        path: chunk.path,
        language: chunk.language,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content: chunk.content,
        symbol: chunk.symbol ?? null,
        hash: chunk.hash,
        root_alias: rootAlias,
        search_text: searchText(chunk),
      }));
      await this.query(
        `INSERT INTO ce_chunks(
           workspace_id, id, path, language, start_line, end_line,
           content, symbol, hash, root_alias, search_vector
         )
         SELECT $1, input.id, input.path, input.language, input.start_line,
                input.end_line, input.content, input.symbol, input.hash,
                input.root_alias, to_tsvector('simple', input.search_text)
         FROM jsonb_to_recordset($2::jsonb) AS input(
           id TEXT, path TEXT, language TEXT, start_line INTEGER,
           end_line INTEGER, content TEXT, symbol TEXT, hash TEXT,
           root_alias TEXT, search_text TEXT
         )`,
        [this.workspaceId, JSON.stringify(chunkRows)],
      );

      const symbolRows = new Map<
        string,
        {
          name: string;
          name_lower: string;
          path: string;
          chunk_id: string;
          start_line: number;
        }
      >();
      for (const chunk of chunks) {
        const symbols = new Set<string>([
          ...(chunk.symbol ? [chunk.symbol] : []),
          ...extractDefNames(chunk.content, chunk.language),
        ]);
        for (const name of symbols) {
          const nameLower = name.toLowerCase();
          symbolRows.set(`${nameLower}\0${chunk.path}\0${chunk.id}`, {
            name,
            name_lower: nameLower,
            path: chunk.path,
            chunk_id: chunk.id,
            start_line: chunk.startLine,
          });
        }
      }
      if (symbolRows.size) {
        await this.query(
          `INSERT INTO ce_symbols(
             workspace_id, name, name_lower, path, chunk_id, start_line, kind
           )
           SELECT $1, input.name, input.name_lower, input.path,
                  input.chunk_id, input.start_line, 'def'
           FROM jsonb_to_recordset($2::jsonb) AS input(
             name TEXT, name_lower TEXT, path TEXT, chunk_id TEXT,
             start_line INTEGER
           )
           ON CONFLICT(workspace_id, name_lower, path, chunk_id) DO NOTHING`,
          [this.workspaceId, JSON.stringify([...symbolRows.values()])],
        );
      }
    }

    if (chunks.length) {
      const imports = extractImports(
        relPath,
        chunks.map((chunk) => chunk.content).join("\n"),
        chunks[0].language,
      ).slice(0, 256);
      if (imports.length) {
        await this.query(
          `INSERT INTO ce_imports(workspace_id, source_path, target_spec)
           SELECT $1, $2, target_spec
           FROM unnest($3::text[]) AS input(target_spec)
           ON CONFLICT(workspace_id, source_path, target_spec) DO NOTHING`,
          [this.workspaceId, relPath, imports],
        );
      }
    }
  }

  async ftsSearch(
    query: string,
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const terms = [...new Set(tokenize(query))].slice(0, 16);
    if (!terms.length) return [];
    const params: unknown[] = [this.workspaceId, terms.join(" | ")];
    const where = this.filterSql(params, filter, "c");
    params.push(limit);
    const result = await this.query<{ id: string; score: number }>(
      `SELECT c.id, ts_rank_cd(c.search_vector, to_tsquery('simple', $2)) AS score
       FROM ce_chunks c
       WHERE ${where} AND c.search_vector @@ to_tsquery('simple', $2)
       ORDER BY score DESC, c.path
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
  }

  async searchSymbols(
    names: string[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const scores = new Map<string, number>();
    for (const name of names) {
      const lower = name.toLowerCase();
      const params: unknown[] = [this.workspaceId, lower, `${lower}%`, `%${lower}%`];
      const where = this.filterSql(params, filter, "c");
      params.push(limit);
      const result = await this.query<{ id: string; score: number }>(
        `SELECT s.chunk_id AS id,
           MAX(
             CASE
               WHEN s.name_lower = $2 THEN 3.0
               WHEN s.name_lower LIKE $3 THEN 1.5
               WHEN length($2) >= 4 AND s.name_lower LIKE $4 THEN 0.8
               ELSE 0
             END
           ) AS score
         FROM ce_symbols s
         JOIN ce_chunks c
           ON c.workspace_id = s.workspace_id AND c.id = s.chunk_id
         WHERE s.workspace_id = $1
           AND (s.name_lower = $2 OR s.name_lower LIKE $3
             OR (length($2) >= 4 AND s.name_lower LIKE $4))
           AND ${where}
         GROUP BY s.chunk_id
         ORDER BY score DESC
         LIMIT $${params.length}`,
        params,
      );
      for (const row of result.rows) {
        scores.set(row.id, Math.max(scores.get(row.id) ?? 0, Number(row.score)));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async searchByPathHints(
    hints: string[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const normalized = hints.map((h) => h.trim().toLowerCase()).filter((h) => h.length >= 2);
    if (!normalized.length) return [];
    const patterns = normalized.map((h) => `%${h.replace(/[\\%_]/g, "\\$&")}%`);
    const params: unknown[] = [this.workspaceId, patterns, normalized];
    const where = this.filterSql(params, filter, "c");
    params.push(limit * 2);
    const result = await this.query<{ id: string; path: string; hint: string }>(
      `SELECT c.id, c.path, h.hint
       FROM unnest($2::text[], $3::text[]) AS h(pattern, hint)
       CROSS JOIN LATERAL (
         SELECT c.id, c.path
         FROM ce_chunks c
         WHERE ${where} AND lower(c.path) LIKE h.pattern ESCAPE '\\'
         ORDER BY length(c.path), c.path
         LIMIT $${params.length}
       ) c`,
      params,
    );
    const scores = new Map<string, number>();
    for (const row of result.rows) {
      const base = path.basename(row.path).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, "");
      const score =
        stem === row.hint
          ? 3.2
          : base.startsWith(`${row.hint}.`)
            ? 3
            : 2;
      scores.set(row.id, Math.max(scores.get(row.id) ?? 0, score));
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async semanticSearch(
    queryVector: ArrayLike<number>,
    model: string,
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const dim = queryVector.length;
    if (!Number.isInteger(dim) || dim <= 0 || dim > 16_000) return [];
    const params: unknown[] = [
      this.workspaceId,
      model,
      dim,
      pgvector.toSql(Array.from(queryVector)),
    ];
    const where = this.filterSql(params, filter, "c");
    params.push(limit);
    const result = await this.query<{ id: string; score: number }>(
      `SELECT e.chunk_id AS id,
              1 - ((e.embedding::vector(${dim})) <=> $4::vector(${dim})) AS score
       FROM ce_embeddings e
       JOIN ce_chunks c
         ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
       WHERE e.workspace_id = $1
         AND e.model = $2
         AND e.dim = $3
         AND ${where}
       ORDER BY (e.embedding::vector(${dim})) <=> $4::vector(${dim})
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
  }

  async getChunksByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!ids.length) return [];
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT id, path, language, start_line, end_line, content, symbol, hash
       FROM ce_chunks
       WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [this.workspaceId, ids],
    );
    const byId = new Map(result.rows.map((row) => [row.id, rowToChunk(row)]));
    return ids.flatMap((id) => {
      const chunk = byId.get(id);
      return chunk ? [chunk] : [];
    });
  }

  async expandGraph(
    seedChunks: CodeChunk[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<CodeChunk[]> {
    if (!seedChunks.length || limit <= 0) return [];

    const seedIds = new Set(seedChunks.map((chunk) => chunk.id));
    const seedPaths = [...new Set(seedChunks.map((chunk) => chunk.path))];
    const symbols = new Set<string>();
    for (const chunk of seedChunks) {
      if (chunk.symbol) symbols.add(chunk.symbol);
      for (const name of extractDefNames(chunk.content, chunk.language)) {
        symbols.add(name);
      }
    }

    const ids: string[] = [];
    const addIds = (items: Array<{ id: string }>): void => {
      for (const item of items) {
        if (!seedIds.has(item.id) && !ids.includes(item.id)) ids.push(item.id);
      }
    };

    if (symbols.size) {
      addIds(await this.searchSymbols([...symbols], limit, filter));
    }

    const forward = await this.query<{ target_spec: string }>(
      `SELECT target_spec
       FROM ce_imports
       WHERE workspace_id = $1 AND source_path = ANY($2::text[])
       LIMIT $3`,
      [this.workspaceId, seedPaths, Math.max(limit * 8, 32)],
    );
    const specs = [...new Set(forward.rows.map((row) => row.target_spec))];
    if (specs.length) {
      const params: unknown[] = [this.workspaceId, specs];
      const where = this.filterSql(params, filter, "c");
      params.push(limit);
      const related = await this.query<{ id: string }>(
        `SELECT c.id
         FROM ce_chunks c
         WHERE ${where}
           AND EXISTS (
             SELECT 1
             FROM unnest($2::text[]) AS spec
             WHERE c.path = spec
                OR c.path LIKE spec || '.%'
                OR c.path LIKE spec || '/%'
                OR c.path LIKE '%' || '/' || spec || '/%'
           )
         ORDER BY c.path, c.start_line
         LIMIT $${params.length}`,
        params,
      );
      addIds(related.rows);
    }

    const seedPathSpecs = [
      ...new Set([
        ...seedPaths,
        ...seedPaths.map((value) => value.replace(/\.[^.]+$/, "")),
      ]),
    ];
    const reverse = await this.query<{ source_path: string }>(
      `SELECT DISTINCT source_path
       FROM ce_imports
       WHERE workspace_id = $1 AND target_spec = ANY($2::text[])
       LIMIT $3`,
      [this.workspaceId, seedPathSpecs, Math.max(limit * 4, 16)],
    );
    const importingPaths = [
      ...new Set(reverse.rows.map((row) => row.source_path)),
    ];
    if (importingPaths.length) {
      const params: unknown[] = [this.workspaceId, importingPaths];
      const where = this.filterSql(params, filter, "c");
      params.push(limit * 2);
      const related = await this.query<{ id: string }>(
        `SELECT c.id
         FROM ce_chunks c
         WHERE ${where} AND c.path = ANY($2::text[])
         ORDER BY c.path, c.start_line
         LIMIT $${params.length}`,
        params,
      );
      addIds(related.rows);
    }

    return this.getChunksByIds(ids.slice(0, limit));
  }

  async getAllChunks(): Promise<CodeChunk[]> {
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT id, path, language, start_line, end_line, content, symbol, hash
       FROM ce_chunks WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return result.rows.map(rowToChunk);
  }

  async chunkCount(): Promise<number> {
    const result = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ce_chunks WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async upsertEmbedding(
    chunkId: string,
    model: string,
    vector: ArrayLike<number>,
  ): Promise<void> {
    await this.query(
      `INSERT INTO ce_embeddings(workspace_id, chunk_id, model, dim, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT(workspace_id, chunk_id) DO UPDATE SET
         model = excluded.model,
         dim = excluded.dim,
         embedding = excluded.embedding`,
      [
        this.workspaceId,
        chunkId,
        model,
        vector.length,
        pgvector.toSql(Array.from(vector)),
      ],
    );
  }

  async upsertEmbeddings(
    model: string,
    items: Array<{ chunkId: string; vector: ArrayLike<number> }>,
  ): Promise<void> {
    if (!items.length) return;
    const rows = items.map(({ chunkId, vector }) => ({
      chunk_id: chunkId,
      dim: vector.length,
      embedding: pgvector.toSql(Array.from(vector)),
    }));
    await this.query(
      `INSERT INTO ce_embeddings(workspace_id, chunk_id, model, dim, embedding)
       SELECT $1, input.chunk_id, $2, input.dim, input.embedding::vector
       FROM jsonb_to_recordset($3::jsonb) AS input(
         chunk_id TEXT, dim INTEGER, embedding TEXT
       )
       ON CONFLICT(workspace_id, chunk_id) DO UPDATE SET
         model = excluded.model,
         dim = excluded.dim,
         embedding = excluded.embedding`,
      [this.workspaceId, model, JSON.stringify(rows)],
    );
  }

  async embeddingCount(model?: string): Promise<number> {
    const result = await this.query<{ n: string }>(
      model
        ? `SELECT COUNT(*)::text AS n
           FROM ce_embeddings WHERE workspace_id = $1 AND model = $2`
        : `SELECT COUNT(*)::text AS n FROM ce_embeddings WHERE workspace_id = $1`,
      model ? [this.workspaceId, model] : [this.workspaceId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async clearEmbeddings(): Promise<void> {
    await this.query(`DELETE FROM ce_embeddings WHERE workspace_id = $1`, [
      this.workspaceId,
    ]);
  }

  async clearWorkspace(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.query(`DELETE FROM ce_chunks WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_imports WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_files WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_meta WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
    });
  }

  async countChunksMissingEmbeddings(model: string): Promise<number> {
    const result = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
       FROM ce_chunks c
       LEFT JOIN ce_embeddings e
         ON e.workspace_id = c.workspace_id
        AND e.chunk_id = c.id
        AND e.model = $2
       WHERE c.workspace_id = $1 AND e.chunk_id IS NULL`,
      [this.workspaceId, model],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async chunksMissingEmbeddings(
    model: string,
    limit = 32,
    afterId?: string,
  ): Promise<CodeChunk[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 512));
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT c.id, c.path, c.language, c.start_line, c.end_line,
              c.content, c.symbol, c.hash
       FROM ce_chunks c
       LEFT JOIN ce_embeddings e
         ON e.workspace_id = c.workspace_id
        AND e.chunk_id = c.id
        AND e.model = $2
       WHERE c.workspace_id = $1
         AND e.chunk_id IS NULL
         AND ($3::text IS NULL OR c.id > $3)
       ORDER BY c.id
       LIMIT $4`,
      [this.workspaceId, model, afterId ?? null, boundedLimit],
    );
    return result.rows.map(rowToChunk);
  }

  async ensureVectorIndex(dim: number): Promise<void> {
    if (!Number.isInteger(dim) || dim <= 0 || dim > 16_000) return;
    const indexName = `ce_embeddings_hnsw_${dim}`;
    await retrySchemaDdl(async () => {
      const client = this.client ?? (await this.pool.connect());
      const release = !this.client;
      try {
        await client.query(`SELECT pg_advisory_lock(${SCHEMA_LOCK_ID})`);
        try {
          await client.query(
            `CREATE INDEX IF NOT EXISTS ${indexName}
             ON ce_embeddings
             USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)
             WHERE dim = ${dim}`,
          );
        } finally {
          await client.query(`SELECT pg_advisory_unlock(${SCHEMA_LOCK_ID})`);
        }
      } finally {
        if (release) client.release();
      }
    });
  }

  async stats(root: string): Promise<IndexStats> {
    const [chunks, files, embeddings, indexedAt, version, generation] = await Promise.all([
      this.chunkCount(),
      this.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ce_files WHERE workspace_id = $1`,
        [this.workspaceId],
      ),
      this.query<{ model: string; n: string }>(
        `SELECT model, COUNT(*)::text AS n
         FROM ce_embeddings
         WHERE workspace_id = $1
         GROUP BY model
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [this.workspaceId],
      ),
      this.getMeta("last_indexed_at"),
      this.getMeta("index_version"),
      this.generationStatus(),
    ]);
    return {
      root,
      dbPath: redactDatabaseUrl(this.databaseUrl),
      chunkCount: chunks,
      fileCount: Number(files.rows[0]?.n ?? 0),
      hasEmbeddings: Number(embeddings.rows[0]?.n ?? 0) > 0,
      embeddingModel: embeddings.rows[0]?.model ?? null,
      lastIndexedAt: indexedAt,
      indexVersion: Number(version ?? INDEX_VERSION),
      hasFts: true,
      generationId: generation.generationId,
      sourceRevision: generation.sourceRevision,
      indexedRevision: generation.indexedRevision,
      pendingRevision: generation.pendingRevision,
    };
  }

  private async migrate(setIndexVersion = true): Promise<void> {
    const client = this.client ?? (await this.pool.connect());
    const release = !this.client;
    try {
      // Extension creation is not race-safe across independent CLI/MCP processes.
      await client.query(`SELECT pg_advisory_lock(${SCHEMA_LOCK_ID})`);
      try {
        // The schema objects below are unqualified, so only a marker in the
        // selected schema can prove their DDL has already been applied.
        const marker = await client.query<{ table_name: string | null }>(
          `SELECT to_regclass(
             format('%I.ce_schema_version', current_schema())
           )::text AS table_name`,
        );
        let schemaVersion = 0;
        if (marker.rows[0]?.table_name) {
          const version = await client.query<{ version: number | string }>(
            `SELECT version FROM ce_schema_version WHERE singleton = TRUE`,
          );
          const parsedVersion = Number(version.rows[0]?.version ?? 0);
          if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
            throw new Error("ContextEngine database schema marker is invalid.");
          }
          schemaVersion = parsedVersion;
        }

        if (schemaVersion > SCHEMA_VERSION) {
          throw new Error(
            `ContextEngine database schema version ${schemaVersion} is newer than this build (${SCHEMA_VERSION}). Upgrade ContextEngine or use a compatible database.`,
          );
        }

        if (schemaVersion < 1) {
          await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
          await client.query(`
      CREATE TABLE IF NOT EXISTS ce_schema_version (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ce_meta (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );

      CREATE TABLE IF NOT EXISTS ce_files (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        size BIGINT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, path)
      );

      CREATE TABLE IF NOT EXISTS ce_chunks (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        symbol TEXT,
        hash TEXT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT '',
        search_vector tsvector NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS ce_chunks_path_idx
        ON ce_chunks(workspace_id, path);
      CREATE INDEX IF NOT EXISTS ce_chunks_language_idx
        ON ce_chunks(workspace_id, language);
      CREATE INDEX IF NOT EXISTS ce_chunks_symbol_idx
        ON ce_chunks(workspace_id, symbol);
      CREATE INDEX IF NOT EXISTS ce_chunks_search_idx
        ON ce_chunks USING GIN(search_vector);

      CREATE TABLE IF NOT EXISTS ce_embeddings (
        workspace_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        embedding vector NOT NULL,
        PRIMARY KEY (workspace_id, chunk_id),
        FOREIGN KEY (workspace_id, chunk_id)
          REFERENCES ce_chunks(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ce_embeddings_model_idx
        ON ce_embeddings(workspace_id, model, dim);

      CREATE TABLE IF NOT EXISTS ce_symbols (
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'def',
        PRIMARY KEY (workspace_id, name_lower, path, chunk_id),
        FOREIGN KEY (workspace_id, chunk_id)
          REFERENCES ce_chunks(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ce_symbols_name_idx
        ON ce_symbols(workspace_id, name_lower);
      CREATE INDEX IF NOT EXISTS ce_symbols_chunk_idx
        ON ce_symbols(workspace_id, chunk_id);

      CREATE TABLE IF NOT EXISTS ce_imports (
        workspace_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_spec TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_path, target_spec)
      );
      CREATE INDEX IF NOT EXISTS ce_imports_source_idx
        ON ce_imports(workspace_id, source_path);
      CREATE INDEX IF NOT EXISTS ce_imports_target_idx
        ON ce_imports(workspace_id, target_spec);

      -- A logical workspace points at one immutable searchable generation.
      -- Staging generations are copied and populated before promotion, so a
      -- failed or in-flight rebuild never exposes a partial index.
      CREATE TABLE IF NOT EXISTS ce_workspace_generations (
        id TEXT PRIMARY KEY,
        logical_workspace_id TEXT NOT NULL,
        storage_workspace_id TEXT NOT NULL UNIQUE,
        source_revision TEXT,
        indexed_revision TEXT,
        pending_revision TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'building', 'retired', 'failed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        promoted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ce_workspace_generations_logical_idx
        ON ce_workspace_generations(logical_workspace_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ce_workspace_aliases (
        logical_workspace_id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES ce_workspace_generations(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ce_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
        local_root TEXT,
        revision BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ce_source_blobs (
        hash TEXT PRIMARY KEY,
        content BYTEA NOT NULL,
        bytes BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (hash ~ '^[0-9a-f]{64}$')
      );

      CREATE TABLE IF NOT EXISTS ce_workspace_sources (
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
      CREATE INDEX IF NOT EXISTS ce_workspace_sources_blob_idx
        ON ce_workspace_sources(blob_hash);

      CREATE TABLE IF NOT EXISTS ce_sync_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        base_revision BIGINT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ce_sync_sessions_workspace_idx
        ON ce_sync_sessions(workspace_id, status);

      CREATE TABLE IF NOT EXISTS ce_sync_changes (
        session_id TEXT NOT NULL REFERENCES ce_sync_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('upsert', 'delete', 'rename')),
        path TEXT NOT NULL,
        old_path TEXT,
        blob_hash TEXT,
        language TEXT,
        mtime_ms BIGINT,
        size BIGINT,
        root_alias TEXT,
        PRIMARY KEY (session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS ce_index_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('incremental', 'rebuild')),
        changed_paths JSONB,
        deleted_paths JSONB,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        progress JSONB,
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ce_index_jobs_workspace_idx
        ON ce_index_jobs(workspace_id, created_at DESC);
        `);
          await client.query(
            `INSERT INTO ce_schema_version(singleton, version)
             VALUES (TRUE, $1)
             ON CONFLICT(singleton) DO UPDATE
             SET version = excluded.version, updated_at = now()`,
            [1],
          );
        }
        if (schemaVersion < 2) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_workspace_acl (
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL,
        permission TEXT NOT NULL CHECK (permission IN ('reader', 'writer', 'owner')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id)
      );
      CREATE INDEX IF NOT EXISTS ce_workspace_acl_principal_idx
        ON ce_workspace_acl(principal_id, workspace_id);

      -- Blob bytes remain globally deduplicated, but possession is scoped to a
      -- workspace. A hash from another tenant is never sufficient proof that a
      -- caller may attach or read that Blob.
      CREATE TABLE IF NOT EXISTS ce_workspace_blob_grants (
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        blob_hash TEXT NOT NULL REFERENCES ce_source_blobs(hash) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, blob_hash)
      );
      INSERT INTO ce_workspace_blob_grants(workspace_id, blob_hash)
      SELECT DISTINCT workspace_id, blob_hash
      FROM ce_workspace_sources
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS ce_connector_sources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
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
      CREATE INDEX IF NOT EXISTS ce_connector_sources_provider_idx
        ON ce_connector_sources(provider, external_id);

      CREATE TABLE IF NOT EXISTS ce_connector_files (
        source_id TEXT NOT NULL REFERENCES ce_connector_sources(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        remote_revision TEXT NOT NULL,
        content_hash TEXT,
        bytes BIGINT NOT NULL,
        PRIMARY KEY (source_id, path)
      );
          `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [2],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 3) {
          await client.query("BEGIN");
          try {
            await client.query(`
      ALTER TABLE ce_connector_sources
        ADD COLUMN IF NOT EXISTS sync_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [3],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 4) {
          await client.query("BEGIN");
          try {
            await client.query(`
      -- Block terminal writes from already-running v3 workers until the guard
      -- below is committed. This lock is deliberately acquired before any
      -- ce_sync_sessions DDL that may wait on a large or busy table.
      LOCK TABLE ce_connector_sources IN SHARE ROW EXCLUSIVE MODE;
      CREATE OR REPLACE FUNCTION ce_guard_connector_sync_transition()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.status = 'syncing'
           AND NEW.status IN ('ready', 'error')
           AND OLD.sync_attempt_id IS NOT NULL
           AND NEW.sync_attempt_id IS NOT NULL THEN
          RAISE EXCEPTION
            'Connector synchronization completion must clear the active attempt token'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $function$;

      DROP TRIGGER IF EXISTS ce_connector_sync_transition_guard
        ON ce_connector_sources;
      CREATE TRIGGER ce_connector_sync_transition_guard
        BEFORE UPDATE ON ce_connector_sources
        FOR EACH ROW
        EXECUTE FUNCTION ce_guard_connector_sync_transition();

      ALTER TABLE ce_sync_sessions
        ADD COLUMN IF NOT EXISTS connector_source_id TEXT,
        ADD COLUMN IF NOT EXISTS connector_attempt_id TEXT;
      ALTER TABLE ce_sync_sessions
        ADD CONSTRAINT ce_sync_sessions_connector_source_fk
          FOREIGN KEY (connector_source_id)
          REFERENCES ce_connector_sources(id) ON DELETE CASCADE,
        ADD CONSTRAINT ce_sync_sessions_connector_attempt_pair_check
          CHECK ((connector_source_id IS NULL) = (connector_attempt_id IS NULL));
      CREATE INDEX IF NOT EXISTS ce_sync_sessions_connector_attempt_idx
        ON ce_sync_sessions(connector_source_id, connector_attempt_id)
        WHERE connector_source_id IS NOT NULL;
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [4],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 5) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_mcp_sessions (
        session_id_hash TEXT PRIMARY KEY CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'closing', 'closed')),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS ce_mcp_sessions_active_idx
        ON ce_mcp_sessions(status, last_seen_at)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS ce_mcp_sessions_workspace_idx
        ON ce_mcp_sessions(workspace_id, status);
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [5],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 6) {
          await client.query("BEGIN");
          try {
            await client.query(`
      ALTER TABLE ce_connector_sources
        DROP CONSTRAINT IF EXISTS ce_connector_sources_provider_check;
      ALTER TABLE ce_connector_sources
        ADD CONSTRAINT ce_connector_sources_provider_check
        CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$');
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [6],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 7) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_source_access_policies (
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        default_access TEXT NOT NULL CHECK (default_access IN ('allow', 'deny')),
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id),
        FOREIGN KEY (workspace_id, principal_id)
          REFERENCES ce_workspace_acl(workspace_id, principal_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ce_source_access_rules (
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        path_prefix TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id, path_prefix),
        FOREIGN KEY (workspace_id, principal_id)
          REFERENCES ce_source_access_policies(workspace_id, principal_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ce_source_access_rules_principal_idx
        ON ce_source_access_rules(principal_id, workspace_id);
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [7],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 8) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_connector_webhook_events (
        source_id TEXT NOT NULL REFERENCES ce_connector_sources(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        body_hash TEXT NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        locked_at TIMESTAMPTZ,
        last_error TEXT,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (source_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS ce_connector_webhook_events_pending_idx
        ON ce_connector_webhook_events(status, next_attempt_at, created_at)
        WHERE status IN ('pending', 'processing');
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [8],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 9) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_connector_ci_tokens (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES ce_connector_sources(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        name TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (char_length(name) BETWEEN 1 AND 100)
      );
      CREATE INDEX IF NOT EXISTS ce_connector_ci_tokens_source_idx
        ON ce_connector_ci_tokens(source_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ce_connector_ci_tokens_active_idx
        ON ce_connector_ci_tokens(token_hash, expires_at)
        WHERE revoked_at IS NULL;
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [9],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 10) {
          await client.query("BEGIN");
          try {
            await client.query(`
      ALTER TABLE ce_connector_webhook_events
        ADD COLUMN IF NOT EXISTS metadata JSONB;
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [10],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 11) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_snapshot_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('export', 'import', 'prune', 'gc')),
        snapshot_name TEXT,
        parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        result JSONB,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        locked_at TIMESTAMPTZ,
        lock_token TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ce_snapshot_jobs_runnable_idx
        ON ce_snapshot_jobs(status, next_attempt_at, created_at)
        WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS ce_snapshot_jobs_workspace_idx
        ON ce_snapshot_jobs(workspace_id, created_at DESC);
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [11],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 12) {
          await client.query("BEGIN");
          try {
            await client.query(`
      ALTER TABLE ce_snapshot_jobs
        DROP CONSTRAINT IF EXISTS ce_snapshot_jobs_operation_check;
      ALTER TABLE ce_snapshot_jobs
        ADD CONSTRAINT ce_snapshot_jobs_operation_check
          CHECK (operation IN ('export', 'import', 'prune', 'gc', 'replicate')),
        ADD CONSTRAINT ce_snapshot_jobs_replication_target_check
          CHECK (
            operation <> 'replicate'
            OR (
              snapshot_name IS NOT NULL
              AND parameters ? 'target_id'
              AND jsonb_typeof(parameters->'target_id') = 'string'
              AND char_length(parameters->>'target_id') BETWEEN 1 AND 63
            )
          );
      CREATE INDEX IF NOT EXISTS ce_snapshot_jobs_replication_idx
        ON ce_snapshot_jobs(
          workspace_id,
          (parameters->>'target_id'),
          snapshot_name,
          created_at DESC
        )
        WHERE operation = 'replicate';
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [12],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 13) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_snapshot_replication_schedules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL CHECK (target_id ~ '^[a-z][a-z0-9_-]{0,62}$'),
        snapshot_name TEXT NOT NULL
          CHECK (snapshot_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
        mode TEXT NOT NULL CHECK (mode IN ('manual', 'interval', 'nightly')),
        interval_ms BIGINT,
        nightly_at TIME WITHOUT TIME ZONE,
        timezone TEXT NOT NULL DEFAULT 'UTC'
          CHECK (char_length(timezone) BETWEEN 1 AND 64),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        next_scheduled_at TIMESTAMPTZ,
        last_scheduled_at TIMESTAMPTZ,
        last_job_id TEXT REFERENCES ce_snapshot_jobs(id) ON DELETE SET NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (workspace_id, target_id, snapshot_name),
        CHECK (
          (mode = 'manual' AND interval_ms IS NULL AND nightly_at IS NULL)
          OR (mode = 'interval' AND interval_ms BETWEEN 60000 AND 31536000000
              AND nightly_at IS NULL)
          OR (mode = 'nightly' AND interval_ms IS NULL AND nightly_at IS NOT NULL)
        ),
        CHECK (
          (mode = 'manual' AND enabled = FALSE AND next_scheduled_at IS NULL)
          OR (
            mode <> 'manual'
            AND (
              (enabled = TRUE AND next_scheduled_at IS NOT NULL)
              OR (enabled = FALSE AND next_scheduled_at IS NULL)
            )
          )
        ),
        CHECK (
          mode <> 'nightly'
          OR pg_catalog.timezone(
            timezone,
            TIMESTAMP '2000-01-01 00:00:00'
          ) IS NOT NULL
        )
      );
      CREATE INDEX IF NOT EXISTS ce_snapshot_replication_schedules_due_idx
        ON ce_snapshot_replication_schedules(next_scheduled_at, target_id)
        WHERE enabled = TRUE AND next_scheduled_at IS NOT NULL;
      -- v12 allowed callers to queue the same replication more than once.
      -- Keep a running job when possible, fence the rest, then install one
      -- global active-job invariant shared by manual and scheduled triggers.
      LOCK TABLE ce_snapshot_jobs IN SHARE ROW EXCLUSIVE MODE;
      WITH ranked_active_replications AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY workspace_id, parameters->>'target_id', snapshot_name
                 ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
                          created_at, id
               ) AS position
        FROM ce_snapshot_jobs
        WHERE operation = 'replicate' AND status IN ('queued', 'running')
      )
      UPDATE ce_snapshot_jobs AS jobs
      SET status = 'failed',
          error = 'Superseded by schema v13 active replication deduplication',
          progress = '{"phase":"superseded"}'::jsonb,
          locked_at = NULL,
          lock_token = NULL,
          completed_at = clock_timestamp()
      FROM ranked_active_replications AS ranked
      WHERE jobs.id = ranked.id AND ranked.position > 1;

      CREATE UNIQUE INDEX IF NOT EXISTS ce_snapshot_jobs_active_replication_idx
        ON ce_snapshot_jobs(
          workspace_id,
          (parameters->>'target_id'),
          snapshot_name
        )
        WHERE operation = 'replicate'
          AND status IN ('queued', 'running');
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [13],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 14) {
          await client.query("BEGIN");
          try {
            await client.query(`
      CREATE TABLE IF NOT EXISTS ce_snapshot_replication_publications (
        job_id TEXT PRIMARY KEY
          REFERENCES ce_snapshot_jobs(id) ON DELETE CASCADE,
        publication_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        source_manifest JSONB NOT NULL
          CHECK (jsonb_typeof(source_manifest) = 'object'),
        source_manifest_sha256 TEXT NOT NULL
          CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
        pinned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [14],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (schemaVersion < 15) {
          await client.query("BEGIN");
          try {
            await client.query(`
      -- Close the v14 write window before backfill and trigger installation.
      -- Existing workers may continue after commit; their SQL then passes
      -- through the v15 trigger even though their binary predates history.
      LOCK TABLE ce_snapshot_jobs IN SHARE ROW EXCLUSIVE MODE;

      CREATE TABLE IF NOT EXISTS ce_snapshot_job_attempts (
        job_id TEXT NOT NULL
          REFERENCES ce_snapshot_jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        budget_attempt INTEGER NOT NULL CHECK (budget_attempt > 0),
        status TEXT NOT NULL
          CHECK (status IN (
            'running', 'succeeded', 'failed', 'retry_scheduled', 'lease_expired'
          )),
        progress JSONB NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(progress) = 'object'),
        result JSONB,
        error TEXT,
        backfilled BOOLEAN NOT NULL DEFAULT FALSE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (job_id, attempt),
        CHECK (
          (status = 'running' AND completed_at IS NULL)
          OR (status <> 'running' AND completed_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS ce_snapshot_job_attempts_status_idx
        ON ce_snapshot_job_attempts(status, last_heartbeat_at)
        WHERE status = 'running';
      CREATE UNIQUE INDEX IF NOT EXISTS ce_snapshot_job_attempts_running_idx
        ON ce_snapshot_job_attempts(job_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ce_snapshot_job_events (
        event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id TEXT NOT NULL
          REFERENCES ce_snapshot_jobs(id) ON DELETE CASCADE,
        attempt INTEGER CHECK (attempt > 0),
        kind TEXT NOT NULL
          CHECK (kind IN (
            'snapshot', 'queued', 'attempt_started', 'lease_takeover',
            'progress', 'retry_scheduled', 'manual_retry', 'succeeded', 'failed'
          )),
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        details JSONB NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(details) = 'object'),
        progress JSONB NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(progress) = 'object'),
        result JSONB,
        error TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        backfilled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (job_id, attempt)
          REFERENCES ce_snapshot_job_attempts(job_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS ce_snapshot_job_events_job_idx
        ON ce_snapshot_job_events(job_id, event_id);

      INSERT INTO ce_snapshot_job_attempts(
        job_id, attempt, budget_attempt, status, progress, result, error, backfilled,
        started_at, last_heartbeat_at, completed_at
      )
      SELECT id,
             attempts,
             attempts,
             CASE status
               WHEN 'running' THEN 'running'
               WHEN 'succeeded' THEN 'succeeded'
               WHEN 'failed' THEN 'failed'
               ELSE CASE
                 WHEN error IS NULL THEN 'failed'
                 ELSE 'retry_scheduled'
               END
             END,
             progress,
             result,
             error,
             TRUE,
             COALESCE(started_at, created_at),
             COALESCE(locked_at, completed_at, started_at, created_at),
             CASE
               WHEN status = 'running' THEN NULL
               ELSE COALESCE(completed_at, created_at)
             END
      FROM ce_snapshot_jobs
      WHERE attempts > 0
      ON CONFLICT (job_id, attempt) DO NOTHING;

      INSERT INTO ce_snapshot_job_events(
        job_id, attempt, kind, status, attempts, details, progress, result, error,
        next_attempt_at, started_at, completed_at, backfilled
      )
      SELECT id, NULLIF(attempts, 0), 'snapshot', status, attempts, '{}'::jsonb,
             progress, result, error,
             next_attempt_at, started_at, completed_at, TRUE
      FROM ce_snapshot_jobs;

      CREATE OR REPLACE FUNCTION ce_record_snapshot_job_audit()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $ce_snapshot_job_audit$
      DECLARE
        audit_attempt INTEGER;
        audit_kind TEXT;
        audit_details JSONB := '{}'::jsonb;
        audit_now TIMESTAMPTZ := clock_timestamp();
      BEGIN
        IF TG_OP = 'INSERT' THEN
          audit_kind := 'queued';
        ELSE
          IF NEW.status = 'running' AND NEW.attempts > OLD.attempts THEN
            SELECT attempt INTO audit_attempt
            FROM ce_snapshot_job_attempts
            WHERE job_id = NEW.id AND status = 'running'
            ORDER BY attempt DESC
            LIMIT 1;

            IF audit_attempt IS NOT NULL THEN
              UPDATE ce_snapshot_job_attempts
              SET status = 'lease_expired',
                  error = COALESCE(error, 'Lease expired and attempt was replaced'),
                  completed_at = audit_now,
                  last_heartbeat_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
              audit_details := jsonb_build_object(
                'replaced_attempt', audit_attempt
              );
            END IF;

            SELECT COALESCE(MAX(attempt), 0) + 1 INTO audit_attempt
            FROM ce_snapshot_job_attempts
            WHERE job_id = NEW.id;

            INSERT INTO ce_snapshot_job_attempts(
              job_id, attempt, budget_attempt, status, progress,
              started_at, last_heartbeat_at
            ) VALUES (
              NEW.id, audit_attempt, NEW.attempts, 'running', NEW.progress,
              audit_now, audit_now
            );
            audit_kind := CASE
              WHEN OLD.status = 'running' THEN 'lease_takeover'
              ELSE 'attempt_started'
            END;
          ELSIF OLD.status = 'running' THEN
            SELECT attempt INTO audit_attempt
            FROM ce_snapshot_job_attempts
            WHERE job_id = NEW.id AND status = 'running'
            ORDER BY attempt DESC
            LIMIT 1;

            IF NEW.status = 'succeeded' THEN
              UPDATE ce_snapshot_job_attempts
              SET status = 'succeeded', progress = NEW.progress,
                  result = NEW.result, error = NEW.error,
                  last_heartbeat_at = audit_now, completed_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
              audit_kind := 'succeeded';
            ELSIF NEW.status = 'failed' THEN
              UPDATE ce_snapshot_job_attempts
              SET status = 'failed', progress = NEW.progress,
                  result = NEW.result, error = NEW.error,
                  last_heartbeat_at = audit_now, completed_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
              audit_kind := 'failed';
            ELSIF NEW.status = 'queued' THEN
              UPDATE ce_snapshot_job_attempts
              SET status = 'retry_scheduled', progress = NEW.progress,
                  result = NEW.result, error = NEW.error,
                  last_heartbeat_at = audit_now, completed_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
              audit_kind := 'retry_scheduled';
            ELSIF NEW.progress IS DISTINCT FROM OLD.progress THEN
              UPDATE ce_snapshot_job_attempts
              SET progress = NEW.progress, last_heartbeat_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
              audit_kind := 'progress';
            ELSIF NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
              UPDATE ce_snapshot_job_attempts
              SET last_heartbeat_at = audit_now
              WHERE job_id = NEW.id AND attempt = audit_attempt;
            END IF;
          ELSIF OLD.status = 'failed' AND NEW.status = 'queued' THEN
            audit_kind := 'manual_retry';
          ELSIF NEW.progress IS DISTINCT FROM OLD.progress THEN
            audit_kind := 'progress';
          END IF;
        END IF;

        IF audit_kind IS NOT NULL THEN
          INSERT INTO ce_snapshot_job_events(
            job_id, attempt, kind, status, attempts, details, progress, result, error,
            next_attempt_at, started_at, completed_at
          ) VALUES (
            NEW.id, audit_attempt, audit_kind, NEW.status, NEW.attempts,
            audit_details, NEW.progress, NEW.result, NEW.error, NEW.next_attempt_at,
            NEW.started_at, NEW.completed_at
          );
          PERFORM pg_notify('ce_snapshot_job_events', NEW.id);
        END IF;
        RETURN NEW;
      END;
      $ce_snapshot_job_audit$;

      DROP TRIGGER IF EXISTS ce_snapshot_job_audit_trigger ON ce_snapshot_jobs;
      CREATE TRIGGER ce_snapshot_job_audit_trigger
        AFTER INSERT OR UPDATE ON ce_snapshot_jobs
        FOR EACH ROW EXECUTE FUNCTION ce_record_snapshot_job_audit();
            `);
            await client.query(
              `INSERT INTO ce_schema_version(singleton, version)
               VALUES (TRUE, $1)
               ON CONFLICT(singleton) DO UPDATE
               SET version = excluded.version, updated_at = now()`,
              [15],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (setIndexVersion && this.workspaceId) {
          await client.query(
            `INSERT INTO ce_meta(workspace_id, key, value)
             VALUES ($1, 'index_version', $2)
             ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
            [this.workspaceId, String(INDEX_VERSION)],
          );
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${SCHEMA_LOCK_ID})`);
      }
    } finally {
      if (release) client.release();
    }
  }

  private filterSql(
    params: unknown[],
    filter: StoreSearchFilter | undefined,
    alias: string,
  ): string {
    const conditions = [`${alias}.workspace_id = $1`];
    if (filter?.pathPrefix) {
      const prefix = filter.pathPrefix
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
      params.push(prefix);
      conditions.push(
        `(${alias}.path = $${params.length} OR left(${alias}.path, length($${params.length}) + 1) = $${params.length} || '/')`,
      );
    }
    if (filter?.sourceAccess) {
      const prefixes = filter.sourceAccess.rules.map((rule) => rule.pathPrefix);
      const effects = filter.sourceAccess.rules.map((rule) => rule.effect);
      params.push(prefixes, effects, filter.sourceAccess.defaultAccess);
      const prefixesParam = params.length - 2;
      const effectsParam = params.length - 1;
      const defaultParam = params.length;
      conditions.push(`COALESCE((
        SELECT rule.effect
        FROM unnest($${prefixesParam}::text[], $${effectsParam}::text[])
          AS rule(path_prefix, effect)
        WHERE ${alias}.path = rule.path_prefix
           OR left(${alias}.path, length(rule.path_prefix) + 1)
                = rule.path_prefix || '/'
        ORDER BY length(rule.path_prefix) DESC,
                 CASE rule.effect WHEN 'deny' THEN 1 ELSE 0 END DESC
        LIMIT 1
      ), $${defaultParam}::text) = 'allow'`);
    }
    if (filter?.language) {
      params.push(filter.language);
      conditions.push(`${alias}.language = $${params.length}`);
    }
    if (filter?.includeCommits === false) {
      conditions.push(`${alias}.language <> 'git-commit'`);
    }
    return conditions.join(" AND ");
  }

  private query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client
      ? this.client.query<T>(text, values)
      : this.pool.query<T>(text, values);
  }
}
