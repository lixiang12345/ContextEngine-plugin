import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { PostgresStore } from "../store/postgres-store.js";
import { languageForPath } from "../util/fs.js";
import { sha256 } from "../util/hash.js";

export type WorkspaceSourceMode = "blob" | "local";
export type SyncOperation = "upsert" | "delete" | "rename";
export type IndexJobMode = "incremental" | "rebuild";
export type IndexJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface StoredWorkspace {
  id: string;
  name: string;
  sourceMode: WorkspaceSourceMode;
  localRoot: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncChange {
  op: SyncOperation;
  path: string;
  oldPath?: string;
  blobHash?: string;
  language?: string;
  mtimeMs?: number;
  size?: number;
  rootAlias?: string;
}

export interface SyncPlan {
  id: string;
  workspaceId: string;
  baseRevision: number;
  missingBlobs: string[];
  expiresAt: string;
}

export interface SyncCommitResult {
  revision: number;
  changedPaths: string[];
  deletedPaths: string[];
}

export interface StoredSourceDocument {
  path: string;
  content: string;
  hash: string;
  language: string;
  mtimeMs: number;
  size: number;
  rootAlias: string;
}

export interface StoredIndexJob {
  id: string;
  workspaceId: string;
  revision: number;
  mode: IndexJobMode;
  changedPaths: string[] | null;
  deletedPaths: string[];
  status: IndexJobStatus;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  source_mode: WorkspaceSourceMode;
  local_root: string | null;
  revision: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SourceRow extends QueryResultRow {
  path: string;
  blob_hash: string;
  language: string;
  mtime_ms: string | number;
  size: string | number;
  root_alias: string;
  content: Buffer;
}

interface JobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  revision: string | number;
  mode: IndexJobMode;
  changed_paths: unknown;
  deleted_paths: unknown;
  status: IndexJobStatus;
  progress: unknown;
  result: unknown;
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = "WorkspaceNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Workspace revision conflict: expected ${expected}, current ${actual}`);
    this.name = "RevisionConflictError";
  }
}

export class MissingBlobError extends Error {
  constructor(readonly hashes: string[]) {
    super(`Missing uploaded blobs: ${hashes.join(", ")}`);
    this.name = "MissingBlobError";
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function workspaceFromRow(row: WorkspaceRow): StoredWorkspace {
  return {
    id: row.id,
    name: row.name,
    sourceMode: row.source_mode,
    localRoot: row.local_root,
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function jobFromRow(row: JobRow): StoredIndexJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    revision: Number(row.revision),
    mode: row.mode,
    changedPaths: row.changed_paths === null ? null : asStringArray(row.changed_paths),
    deletedPaths: asStringArray(row.deleted_paths),
    status: row.status,
    progress: asObject(row.progress),
    result: asObject(row.result),
    error: row.error,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

function decodeText(content: Buffer): string | null {
  const sample = content.subarray(0, Math.min(content.length, 2048));
  let nulls = 0;
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte === 0) nulls++;
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) nonPrintable++;
  }
  if (nulls > 2 || (sample.length > 0 && nonPrintable / sample.length > 0.3)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function sourceFromRow(row: SourceRow): StoredSourceDocument | null {
  const content = decodeText(row.content);
  if (content === null) return null;
  return {
    path: row.path,
    content,
    hash: row.blob_hash,
    language: row.language,
    mtimeMs: Number(row.mtime_ms),
    size: Number(row.size),
    rootAlias: row.root_alias,
  };
}

/**
 * Repository for HTTP workspaces. Source bytes, file manifests, and vectors
 * remain in one PostgreSQL deployment; only a bounded page of source files is
 * decoded during indexing.
 */
export class WorkspaceRepository {
  private constructor(private readonly pool: Pool) {}

  static async open(databaseUrl: string): Promise<WorkspaceRepository> {
    await PostgresStore.ensureSchema(databaseUrl);
    return new WorkspaceRepository(
      new Pool({
        connectionString: databaseUrl,
        max: Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8),
      }),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createWorkspace(input: {
    name: string;
    sourceMode: WorkspaceSourceMode;
    localRoot?: string;
  }): Promise<StoredWorkspace> {
    const id = randomUUID();
    const result = await this.pool.query<WorkspaceRow>(
      `INSERT INTO ce_workspaces(id, name, source_mode, local_root)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, source_mode, local_root, revision, created_at, updated_at`,
      [id, input.name, input.sourceMode, input.localRoot ?? null],
    );
    return workspaceFromRow(result.rows[0]);
  }

  async listWorkspaces(): Promise<StoredWorkspace[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, name, source_mode, local_root, revision, created_at, updated_at
       FROM ce_workspaces
       ORDER BY updated_at DESC, id`,
    );
    return result.rows.map(workspaceFromRow);
  }

  async getWorkspace(workspaceId: string): Promise<StoredWorkspace | null> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, name, source_mode, local_root, revision, created_at, updated_at
       FROM ce_workspaces
       WHERE id = $1`,
      [workspaceId],
    );
    return result.rows[0] ? workspaceFromRow(result.rows[0]) : null;
  }

  async requireWorkspace(workspaceId: string): Promise<StoredWorkspace> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ce_workspaces WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      if (!existing.rows[0]) throw new WorkspaceNotFoundError(workspaceId);
      await client.query(`DELETE FROM ce_chunks WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM ce_imports WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM ce_files WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM ce_meta WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM ce_workspaces WHERE id = $1`, [workspaceId]);
      await client.query(
        `DELETE FROM ce_source_blobs AS blob
         WHERE NOT EXISTS (
           SELECT 1 FROM ce_workspace_sources AS source
           WHERE source.blob_hash = blob.hash
         )`,
      );
    });
  }

  async putBlob(hash: string, content: Buffer): Promise<void> {
    const normalizedHash = hash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error("Blob hash must be a lowercase SHA-256 hex digest");
    }
    if (sha256(content) !== normalizedHash) {
      throw new Error("Blob SHA-256 does not match its content");
    }
    await this.pool.query(
      `INSERT INTO ce_source_blobs(hash, content, bytes)
       VALUES ($1, $2, $3)
       ON CONFLICT(hash) DO NOTHING`,
      [normalizedHash, content, content.length],
    );
  }

  async hasBlob(hash: string): Promise<boolean> {
    const result = await this.pool.query<{ hash: string }>(
      `SELECT hash FROM ce_source_blobs WHERE hash = $1`,
      [hash.toLowerCase()],
    );
    return Boolean(result.rows[0]);
  }

  async createSyncPlan(
    workspaceId: string,
    baseRevision: number,
    changes: SyncChange[],
    ttlMs = 15 * 60 * 1000,
  ): Promise<SyncPlan> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs);
    return this.withTransaction(async (client) => {
      const workspace = await client.query<WorkspaceRow>(
        `SELECT id, name, source_mode, local_root, revision, created_at, updated_at
         FROM ce_workspaces WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      const row = workspace.rows[0];
      if (!row) throw new WorkspaceNotFoundError(workspaceId);
      if (Number(row.revision) !== baseRevision) {
        throw new RevisionConflictError(baseRevision, Number(row.revision));
      }
      if (row.source_mode !== "blob") {
        throw new Error("File sync is available only for blob workspaces");
      }

      const requested = [
        ...new Set(
          changes
            .filter((change) => change.op !== "delete")
            .flatMap((change) => (change.blobHash ? [change.blobHash] : [])),
        ),
      ];
      const known = await client.query<{ hash: string }>(
        `SELECT hash FROM ce_source_blobs WHERE hash = ANY($1::text[])`,
        [requested],
      );
      const knownHashes = new Set(known.rows.map((item) => item.hash));
      const missingBlobs = requested.filter((hash) => !knownHashes.has(hash));

      await client.query(
        `INSERT INTO ce_sync_sessions(id, workspace_id, base_revision, status, expires_at)
         VALUES ($1, $2, $3, 'planned', $4)`,
        [id, workspaceId, baseRevision, expiresAt],
      );
      for (const [sequence, change] of changes.entries()) {
        await client.query(
          `INSERT INTO ce_sync_changes(
             session_id, sequence, op, path, old_path, blob_hash,
             language, mtime_ms, size, root_alias
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            sequence,
            change.op,
            change.path,
            change.oldPath ?? null,
            change.blobHash?.toLowerCase() ?? null,
            change.language ?? null,
            change.mtimeMs ?? null,
            change.size ?? null,
            change.rootAlias ?? null,
          ],
        );
      }
      return {
        id,
        workspaceId,
        baseRevision,
        missingBlobs,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async commitSync(
    workspaceId: string,
    syncId: string,
  ): Promise<SyncCommitResult> {
    return this.withTransaction(async (client) => {
      const session = await client.query<{
        id: string;
        workspace_id: string;
        base_revision: string | number;
        status: string;
        expires_at: Date | string;
        revision: string | number;
      }>(
        `SELECT s.id, s.workspace_id, s.base_revision, s.status, s.expires_at, w.revision
         FROM ce_sync_sessions AS s
         JOIN ce_workspaces AS w ON w.id = s.workspace_id
         WHERE s.id = $1
         FOR UPDATE OF s, w`,
        [syncId],
      );
      const current = session.rows[0];
      if (!current || current.workspace_id !== workspaceId) {
        throw new Error("Sync session was not found for this workspace");
      }
      if (current.status !== "planned") {
        throw new Error(`Sync session is ${current.status}`);
      }
      if (new Date(current.expires_at).getTime() < Date.now()) {
        await client.query(`UPDATE ce_sync_sessions SET status = 'aborted' WHERE id = $1`, [
          syncId,
        ]);
        throw new Error("Sync session has expired");
      }
      const currentRevision = Number(current.revision);
      if (currentRevision !== Number(current.base_revision)) {
        throw new RevisionConflictError(Number(current.base_revision), currentRevision);
      }

      const changes = await client.query<{
        op: SyncOperation;
        path: string;
        old_path: string | null;
        blob_hash: string | null;
        language: string | null;
        mtime_ms: string | number | null;
        size: string | number | null;
        root_alias: string | null;
      }>(
        `SELECT op, path, old_path, blob_hash, language, mtime_ms, size, root_alias
         FROM ce_sync_changes
         WHERE session_id = $1
         ORDER BY sequence`,
        [syncId],
      );
      const requiredHashes = [
        ...new Set(
          changes.rows.flatMap((change) =>
            change.op === "delete" || !change.blob_hash ? [] : [change.blob_hash],
          ),
        ),
      ];
      const known = await client.query<{ hash: string }>(
        `SELECT hash FROM ce_source_blobs WHERE hash = ANY($1::text[])`,
        [requiredHashes],
      );
      const knownHashes = new Set(known.rows.map((item) => item.hash));
      const missing = requiredHashes.filter((hash) => !knownHashes.has(hash));
      if (missing.length) throw new MissingBlobError(missing);

      const nextRevision = currentRevision + 1;
      const changedPaths = new Set<string>();
      const deletedPaths = new Set<string>();
      for (const change of changes.rows) {
        if (change.op === "delete") {
          await client.query(
            `DELETE FROM ce_workspace_sources WHERE workspace_id = $1 AND path = $2`,
            [workspaceId, change.path],
          );
          changedPaths.delete(change.path);
          deletedPaths.add(change.path);
          continue;
        }

        let blobHash = change.blob_hash;
        let language = change.language;
        let mtimeMs = change.mtime_ms === null ? null : Number(change.mtime_ms);
        let size = change.size === null ? null : Number(change.size);
        let rootAlias = change.root_alias;
        if (change.op === "rename") {
          if (!change.old_path) throw new Error("Rename change is missing old_path");
          const source = await client.query<{
            blob_hash: string;
            language: string;
            mtime_ms: string | number;
            size: string | number;
            root_alias: string;
          }>(
            `SELECT blob_hash, language, mtime_ms, size, root_alias
             FROM ce_workspace_sources
             WHERE workspace_id = $1 AND path = $2`,
            [workspaceId, change.old_path],
          );
          const previous = source.rows[0];
          if (!previous && !blobHash) {
            throw new Error(`Cannot rename missing source file: ${change.old_path}`);
          }
          blobHash ??= previous?.blob_hash ?? null;
          language ??= previous?.language ?? null;
          mtimeMs ??= previous ? Number(previous.mtime_ms) : null;
          size ??= previous ? Number(previous.size) : null;
          rootAlias ??= previous?.root_alias ?? null;
          await client.query(
            `DELETE FROM ce_workspace_sources WHERE workspace_id = $1 AND path = $2`,
            [workspaceId, change.old_path],
          );
          if (change.old_path !== change.path) deletedPaths.add(change.old_path);
        }
        if (!blobHash) throw new Error(`Sync change is missing blob_hash: ${change.path}`);
        const resolvedLanguage = language ?? languageForPath(change.path);
        const resolvedMtimeMs = mtimeMs ?? Date.now();
        const resolvedSize = size ?? 0;
        const resolvedRootAlias = rootAlias ?? "main";
        await client.query(
          `INSERT INTO ce_workspace_sources(
             workspace_id, path, blob_hash, language, mtime_ms, size, root_alias, revision
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT(workspace_id, path) DO UPDATE SET
             blob_hash = excluded.blob_hash,
             language = excluded.language,
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             root_alias = excluded.root_alias,
             revision = excluded.revision`,
          [
            workspaceId,
            change.path,
            blobHash,
            resolvedLanguage,
            Math.round(resolvedMtimeMs),
            Math.round(resolvedSize),
            resolvedRootAlias,
            nextRevision,
          ],
        );
        changedPaths.add(change.path);
        deletedPaths.delete(change.path);
      }
      await client.query(
        `UPDATE ce_workspaces
         SET revision = $2, updated_at = now()
         WHERE id = $1`,
        [workspaceId, nextRevision],
      );
      await client.query(`UPDATE ce_sync_sessions SET status = 'committed' WHERE id = $1`, [
        syncId,
      ]);
      return {
        revision: nextRevision,
        changedPaths: [...changedPaths].sort(),
        deletedPaths: [...deletedPaths].sort(),
      };
    });
  }

  async createIndexJob(input: {
    workspaceId: string;
    revision: number;
    mode: IndexJobMode;
    changedPaths?: string[] | null;
    deletedPaths?: string[];
  }): Promise<StoredIndexJob> {
    const id = randomUUID();
    const result = await this.pool.query<JobRow>(
      `INSERT INTO ce_index_jobs(
         id, workspace_id, revision, mode, changed_paths, deleted_paths, status, progress
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'queued', $7::jsonb)
       RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                 status, progress, result, error, created_at, started_at, completed_at`,
      [
        id,
        input.workspaceId,
        input.revision,
        input.mode,
        input.changedPaths === undefined ? null : JSON.stringify(input.changedPaths),
        JSON.stringify(input.deletedPaths ?? []),
        JSON.stringify({ phase: "queued" }),
      ],
    );
    return jobFromRow(result.rows[0]);
  }

  async getIndexJob(jobId: string): Promise<StoredIndexJob | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT id, workspace_id, revision, mode, changed_paths, deleted_paths,
              status, progress, result, error, created_at, started_at, completed_at
       FROM ce_index_jobs
       WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async listRecentIndexJobs(limit = 25): Promise<StoredIndexJob[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const result = await this.pool.query<JobRow>(
      `SELECT id, workspace_id, revision, mode, changed_paths, deleted_paths,
              status, progress, result, error, created_at, started_at, completed_at
       FROM ce_index_jobs
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map(jobFromRow);
  }

  async listQueuedIndexJobs(): Promise<StoredIndexJob[]> {
    const result = await this.pool.query<JobRow>(
      `SELECT id, workspace_id, revision, mode, changed_paths, deleted_paths,
              status, progress, result, error, created_at, started_at, completed_at
       FROM ce_index_jobs
       WHERE status = 'queued'
       ORDER BY created_at, id`,
    );
    return result.rows.map(jobFromRow);
  }

  async markRunningJobsFailed(): Promise<void> {
    await this.pool.query(
      `UPDATE ce_index_jobs
       SET status = 'failed',
           error = 'Server restarted while the job was running',
           completed_at = now()
       WHERE status = 'running'`,
    );
  }

  async markIndexJobRunning(jobId: string): Promise<StoredIndexJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ce_index_jobs
       SET status = 'running', started_at = now(), progress = $2::jsonb, error = NULL
       WHERE id = $1 AND status = 'queued'
       RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                 status, progress, result, error, created_at, started_at, completed_at`,
      [jobId, JSON.stringify({ phase: "starting" })],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async updateIndexJobProgress(
    jobId: string,
    progress: Record<string, unknown>,
  ): Promise<StoredIndexJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ce_index_jobs
       SET progress = $2::jsonb
       WHERE id = $1
       RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                 status, progress, result, error, created_at, started_at, completed_at`,
      [jobId, JSON.stringify(progress)],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async completeIndexJob(
    jobId: string,
    resultPayload: object,
  ): Promise<StoredIndexJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ce_index_jobs
       SET status = 'succeeded',
           result = $2::jsonb,
           completed_at = now(),
           progress = $3::jsonb
       WHERE id = $1
       RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                 status, progress, result, error, created_at, started_at, completed_at`,
      [jobId, JSON.stringify(resultPayload), JSON.stringify({ phase: "done" })],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async failIndexJob(jobId: string, message: string): Promise<StoredIndexJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ce_index_jobs
       SET status = 'failed',
           error = $2,
           completed_at = now()
       WHERE id = $1
       RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                 status, progress, result, error, created_at, started_at, completed_at`,
      [jobId, message.slice(0, 4000)],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async countSourceFiles(
    workspaceId: string,
    paths?: string[] | null,
  ): Promise<number> {
    const result = paths
      ? await this.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM ce_workspace_sources
           WHERE workspace_id = $1 AND path = ANY($2::text[])`,
          [workspaceId, paths],
        )
      : await this.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM ce_workspace_sources
           WHERE workspace_id = $1`,
          [workspaceId],
        );
    return Number(result.rows[0]?.count ?? 0);
  }

  async *iterateSourceFiles(
    workspaceId: string,
    paths?: string[] | null,
  ): AsyncIterable<StoredSourceDocument> {
    const pageSize = 64;
    if (paths) {
      for (let index = 0; index < paths.length; index += pageSize) {
        const result = await this.pool.query<SourceRow>(
          `SELECT source.path, source.blob_hash, source.language, source.mtime_ms,
                  source.size, source.root_alias, blob.content
           FROM ce_workspace_sources AS source
           JOIN ce_source_blobs AS blob ON blob.hash = source.blob_hash
           WHERE source.workspace_id = $1 AND source.path = ANY($2::text[])
           ORDER BY source.path`,
          [workspaceId, paths.slice(index, index + pageSize)],
        );
        for (const row of result.rows) {
          const document = sourceFromRow(row);
          if (document) yield document;
        }
      }
      return;
    }

    let afterPath = "";
    for (;;) {
      const result = await this.pool.query<SourceRow>(
        `SELECT source.path, source.blob_hash, source.language, source.mtime_ms,
                source.size, source.root_alias, blob.content
         FROM ce_workspace_sources AS source
         JOIN ce_source_blobs AS blob ON blob.hash = source.blob_hash
         WHERE source.workspace_id = $1 AND source.path > $2
         ORDER BY source.path
         LIMIT $3`,
        [workspaceId, afterPath, pageSize],
      );
      if (!result.rows.length) return;
      for (const row of result.rows) {
        afterPath = row.path;
        const document = sourceFromRow(row);
        if (document) yield document;
      }
    }
  }

  async readSourceFile(
    workspaceId: string,
    sourcePath: string,
  ): Promise<StoredSourceDocument | null> {
    const result = await this.pool.query<SourceRow>(
      `SELECT source.path, source.blob_hash, source.language, source.mtime_ms,
              source.size, source.root_alias, blob.content
       FROM ce_workspace_sources AS source
       JOIN ce_source_blobs AS blob ON blob.hash = source.blob_hash
       WHERE source.workspace_id = $1 AND source.path = $2`,
      [workspaceId, sourcePath],
    );
    return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
  }

  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
