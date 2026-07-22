import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { PostgresStore } from "../store/postgres-store.js";
import { languageForPath } from "../util/fs.js";
import { sha256 } from "../util/hash.js";
import type {
  SourceAccessEffect,
  SourcePathPolicy,
  SourcePathRule,
} from "../types.js";

export type WorkspaceSourceMode = "blob" | "local";
export type SyncOperation = "upsert" | "delete" | "rename";
export type IndexJobMode = "incremental" | "rebuild";
export type IndexJobStatus = "queued" | "running" | "succeeded" | "failed";
export type WorkspacePermission = "reader" | "writer" | "owner";
/** Lowercase provider id registered by a SourceConnectorPlugin. */
export type ConnectorProvider = string;
export type McpSessionStatus = "active" | "closing" | "closed";
export type McpSessionRejectionReason =
  | "unknown"
  | "expired"
  | "closed"
  | "principal_mismatch";

export interface StoredWorkspace {
  id: string;
  name: string;
  sourceMode: WorkspaceSourceMode;
  localRoot: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMcpSession {
  sessionIdHash: string;
  workspaceId: string;
  principalId: string;
  protocolVersion: string;
  status: McpSessionStatus;
  lastSeenAt: string;
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
  indexJob?: StoredIndexJob;
}

export interface ConnectorSyncCommit {
  sourceId: string;
  expectedCursorVersion: number;
  syncAttemptId: string;
  cursor: Record<string, unknown>;
  upstreamRevision: string;
  files: StoredConnectorFile[];
}

/**
 * Identifies one ownership lease for a connector synchronization. Cursor
 * versions describe source state; they are deliberately not enough to
 * distinguish a timed-out worker from the worker that took over its work.
 */
export interface ConnectorSyncAttempt {
  sourceId: string;
  expectedCursorVersion: number;
  syncAttemptId: string;
}

export interface ConnectorSyncLease extends StoredConnectorSource {
  syncAttemptId: string;
  leaseExpiresAt: string;
}

export interface SyncCommitOptions {
  allowGlobalBlobs?: boolean;
  createIndexJob?: boolean;
  connector?: ConnectorSyncCommit;
}

export interface StoredConnectorSource {
  id: string;
  workspaceId: string;
  provider: ConnectorProvider;
  externalId: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown> | null;
  cursorVersion: number;
  upstreamRevision: string | null;
  status: "idle" | "syncing" | "ready" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredConnectorFile {
  sourceId: string;
  path: string;
  remoteRevision: string;
  contentHash: string | null;
  bytes: number;
}

export interface StoredSourceDocument {
  path: string;
  content: string;
  indexable?: boolean;
  hash: string;
  language: string;
  mtimeMs: number;
  size: number;
  rootAlias: string;
}

export interface StoredSourceAccessPolicy extends SourcePathPolicy {
  workspaceId: string;
  principalId: string;
  updatedBy: string;
  updatedAt: string;
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

interface ConnectorSourceRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  provider: ConnectorProvider;
  external_id: string;
  config: unknown;
  cursor: unknown;
  cursor_version: string | number;
  upstream_revision: string | null;
  status: StoredConnectorSource["status"];
  last_error: string | null;
  last_synced_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConnectorSyncLeaseRow extends ConnectorSourceRow {
  sync_attempt_id: string;
  lease_expires_at: string | Date;
}

interface ConnectorFileRow extends QueryResultRow {
  source_id: string;
  path: string;
  remote_revision: string;
  content_hash: string | null;
  bytes: string | number;
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

interface McpSessionRow extends QueryResultRow {
  session_id_hash: string;
  workspace_id: string;
  principal_id: string;
  protocol_version: string;
  status: McpSessionStatus;
  last_seen_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SourceAccessPolicyRow extends QueryResultRow {
  workspace_id: string;
  principal_id: string;
  default_access: SourceAccessEffect;
  updated_by: string;
  updated_at: string | Date;
  path_prefix: string | null;
  effect: SourceAccessEffect | null;
}

type AdvisoryLockClient = PoolClient;

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

export class SyncPlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPlanConflictError";
  }
}

export class SyncPlanExpiredError extends Error {
  constructor(message = "Sync session has expired") {
    super(message);
    this.name = "SyncPlanExpiredError";
  }
}

export class SourceAccessPolicyTargetError extends Error {
  constructor() {
    super("Source access policy principal must have workspace access");
    this.name = "SourceAccessPolicyTargetError";
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

function connectorSourceFromRow(row: ConnectorSourceRow): StoredConnectorSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    externalId: row.external_id,
    config: asObject(row.config) ?? {},
    cursor: asObject(row.cursor),
    cursorVersion: Number(row.cursor_version),
    upstreamRevision: row.upstream_revision,
    status: row.status,
    lastError: row.last_error,
    lastSyncedAt: iso(row.last_synced_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function connectorSyncLeaseFromRow(row: ConnectorSyncLeaseRow): ConnectorSyncLease {
  const leaseExpiresAt = iso(row.lease_expires_at);
  if (!row.sync_attempt_id || !leaseExpiresAt) {
    throw new Error("Connector synchronization lease is incomplete");
  }
  return {
    ...connectorSourceFromRow(row),
    syncAttemptId: row.sync_attempt_id,
    leaseExpiresAt,
  };
}

function connectorFileFromRow(row: ConnectorFileRow): StoredConnectorFile {
  return {
    sourceId: row.source_id,
    path: row.path,
    remoteRevision: row.remote_revision,
    contentHash: row.content_hash,
    bytes: Number(row.bytes),
  };
}

function mcpSessionFromRow(row: McpSessionRow): StoredMcpSession {
  return {
    sessionIdHash: row.session_id_hash,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    protocolVersion: row.protocol_version,
    status: row.status,
    lastSeenAt: iso(row.last_seen_at)!,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

const permissionRank: Record<WorkspacePermission, number> = {
  reader: 1,
  writer: 2,
  owner: 3,
};

export function workspacePermissionAllows(
  actual: WorkspacePermission | null,
  required: WorkspacePermission,
): boolean {
  return actual !== null && permissionRank[actual] >= permissionRank[required];
}

export function sourcePathAllowed(
  policy: SourcePathPolicy | null | undefined,
  sourcePath: string,
): boolean {
  if (!policy) return true;
  let selected: SourcePathRule | null = null;
  for (const rule of policy.rules) {
    if (
      sourcePath !== rule.pathPrefix &&
      !sourcePath.startsWith(`${rule.pathPrefix}/`)
    ) {
      continue;
    }
    if (
      !selected ||
      rule.pathPrefix.length > selected.pathPrefix.length ||
      (rule.pathPrefix.length === selected.pathPrefix.length &&
        rule.effect === "deny")
    ) {
      selected = rule;
    }
  }
  return (selected?.effect ?? policy.defaultAccess) === "allow";
}

function sourceAccessPoliciesFromRows(
  rows: readonly SourceAccessPolicyRow[],
): StoredSourceAccessPolicy[] {
  const policies = new Map<string, StoredSourceAccessPolicy>();
  for (const row of rows) {
    const key = `${row.workspace_id}\0${row.principal_id}`;
    let policy = policies.get(key);
    if (!policy) {
      policy = {
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        defaultAccess: row.default_access,
        rules: [],
        updatedBy: row.updated_by,
        updatedAt: iso(row.updated_at)!,
      };
      policies.set(key, policy);
    }
    if (row.path_prefix && row.effect) {
      (policy.rules as SourcePathRule[]).push({
        pathPrefix: row.path_prefix,
        effect: row.effect,
      });
    }
  }
  return [...policies.values()];
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

function sourceFromRow(
  row: SourceRow,
  includeUnindexable = false,
): StoredSourceDocument | null {
  const content = decodeText(row.content);
  if (content === null && !includeUnindexable) return null;
  return {
    path: row.path,
    content: content ?? "",
    indexable: content !== null,
    hash: row.blob_hash,
    language: row.language,
    mtimeMs: Number(row.mtime_ms),
    // Blob bytes are authoritative. The manifest size is caller-provided and
    // must not be able to bypass the indexer's max-file-size guard.
    size: row.content.length,
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
        max: Math.max(2, Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8) || 8),
      }),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createMcpSession(input: {
    sessionIdHash: string;
    workspaceId: string;
    principalId: string;
    protocolVersion: string;
    idleTtlMs: number;
    maxSessions: number;
  }): Promise<StoredMcpSession | null> {
    return this.withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('contextengine:mcp-session-capacity', 0)
         )`,
      );
      const created = await client.query<McpSessionRow>(
        `INSERT INTO ce_mcp_sessions(
           session_id_hash, workspace_id, principal_id, protocol_version
         )
         SELECT $1, $2, $3, $4
         WHERE (
           SELECT COUNT(*)
           FROM ce_mcp_sessions
           WHERE status = 'active'
             AND last_seen_at + ($5::bigint * interval '1 millisecond')
                   > clock_timestamp()
         ) < $6
         ON CONFLICT (session_id_hash) DO NOTHING
         RETURNING session_id_hash, workspace_id, principal_id, protocol_version,
                   status, last_seen_at, created_at, updated_at`,
        [
          input.sessionIdHash,
          input.workspaceId,
          input.principalId,
          input.protocolVersion,
          input.idleTtlMs,
          input.maxSessions,
        ],
      );
      return created.rows[0] ? mcpSessionFromRow(created.rows[0]) : null;
    });
  }

  async getAuthorizedMcpSession(input: {
    sessionIdHash: string;
    workspaceId: string;
    principalId: string;
    idleTtlMs: number;
  }): Promise<StoredMcpSession | null> {
    const result = await this.pool.query<McpSessionRow>(
      `SELECT session_id_hash, workspace_id, principal_id, protocol_version,
              status, last_seen_at, created_at, updated_at
       FROM ce_mcp_sessions
       WHERE session_id_hash = $1
         AND workspace_id = $2
         AND principal_id = $3
         AND status = 'active'
         AND last_seen_at + ($4::bigint * interval '1 millisecond')
               > clock_timestamp()`,
      [
        input.sessionIdHash,
        input.workspaceId,
        input.principalId,
        input.idleTtlMs,
      ],
    );
    return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
  }

  async touchMcpSession(input: {
    sessionIdHash: string;
    workspaceId: string;
    principalId: string;
    idleTtlMs: number;
  }): Promise<StoredMcpSession | null> {
    const result = await this.pool.query<McpSessionRow>(
      `UPDATE ce_mcp_sessions
       SET last_seen_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE session_id_hash = $1
         AND workspace_id = $2
         AND principal_id = $3
         AND status = 'active'
         AND last_seen_at + ($4::bigint * interval '1 millisecond')
               > clock_timestamp()
       RETURNING session_id_hash, workspace_id, principal_id, protocol_version,
                 status, last_seen_at, created_at, updated_at`,
      [
        input.sessionIdHash,
        input.workspaceId,
        input.principalId,
        input.idleTtlMs,
      ],
    );
    return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
  }

  async classifyMcpSessionRejection(input: {
    sessionIdHash: string;
    workspaceId: string;
    principalId: string;
    idleTtlMs: number;
  }): Promise<McpSessionRejectionReason> {
    const result = await this.pool.query<{ reason: McpSessionRejectionReason }>(
      `SELECT CASE
         WHEN workspace_id <> $2 OR principal_id <> $3
           THEN 'principal_mismatch'
         WHEN status <> 'active' THEN 'closed'
         WHEN last_seen_at + ($4::bigint * interval '1 millisecond')
                <= clock_timestamp() THEN 'expired'
         ELSE 'unknown'
       END AS reason
       FROM ce_mcp_sessions
       WHERE session_id_hash = $1`,
      [
        input.sessionIdHash,
        input.workspaceId,
        input.principalId,
        input.idleTtlMs,
      ],
    );
    return result.rows[0]?.reason ?? "unknown";
  }

  async closeMcpSession(input: {
    sessionIdHash: string;
    workspaceId: string;
    principalId: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ce_mcp_sessions
       SET status = 'closed', updated_at = clock_timestamp()
       WHERE session_id_hash = $1
         AND workspace_id = $2
         AND principal_id = $3
         AND status <> 'closed'`,
      [input.sessionIdHash, input.workspaceId, input.principalId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async pruneExpiredMcpSessions(idleTtlMs: number, limit = 256): Promise<number> {
    const result = await this.pool.query(
      `WITH doomed AS (
         SELECT session_id_hash
         FROM ce_mcp_sessions
         WHERE (
             status = 'active'
             AND last_seen_at + (($1::bigint * 2) * interval '1 millisecond')
                   <= clock_timestamp()
           ) OR (
             status <> 'active'
             AND updated_at + ($1::bigint * interval '1 millisecond')
                   <= clock_timestamp()
           )
         ORDER BY updated_at
         LIMIT $2
       )
       DELETE FROM ce_mcp_sessions AS session
       USING doomed
       WHERE session.session_id_hash = doomed.session_id_hash`,
      [idleTtlMs, limit],
    );
    return result.rowCount ?? 0;
  }

  async countActiveMcpSessions(idleTtlMs: number): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ce_mcp_sessions
       WHERE status = 'active'
         AND last_seen_at + ($1::bigint * interval '1 millisecond')
               > clock_timestamp()`,
      [idleTtlMs],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getMcpSessionStatistics(idleTtlMs: number): Promise<{
    active: number;
    expired: number;
    closed: number;
  }> {
    const result = await this.pool.query<{
      active: string;
      expired: string;
      closed: string;
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'active'
             AND last_seen_at + ($1::bigint * interval '1 millisecond')
                   > clock_timestamp()
         )::text AS active,
         COUNT(*) FILTER (
           WHERE status = 'active'
             AND last_seen_at + ($1::bigint * interval '1 millisecond')
                   <= clock_timestamp()
         )::text AS expired,
         COUNT(*) FILTER (WHERE status <> 'active')::text AS closed
       FROM ce_mcp_sessions`,
      [idleTtlMs],
    );
    return {
      active: Number(result.rows[0]?.active ?? 0),
      expired: Number(result.rows[0]?.expired ?? 0),
      closed: Number(result.rows[0]?.closed ?? 0),
    };
  }

  /**
   * Serialize indexing for one logical workspace across HTTP server
   * instances. The lock is held on a dedicated PostgreSQL session for the
   * whole callback, so a second process cannot build from an old generation
   * while the first process is promoting a new one.
   */
  async withIndexJobLock<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const client: AdvisoryLockClient = await this.pool.connect();
    let lockKey: string | null = null;
    try {
      const key = await client.query<{ key: string }>(
        `SELECT hashtextextended($1, 0)::text AS key`,
        [`contextengine:index-job:${workspaceId}`],
      );
      lockKey = key.rows[0]?.key ?? null;
      if (!lockKey) throw new Error("Unable to derive workspace index lock key");
      await client.query(`SELECT pg_advisory_lock($1::bigint)`, [lockKey]);
      return await operation();
    } finally {
      if (lockKey) {
        try {
          await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]);
        } finally {
          client.release();
        }
      } else {
        client.release();
      }
    }
  }

  async getMeta(workspaceId: string, key: string): Promise<string | null> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT m.value
       FROM ce_meta m
       WHERE m.workspace_id = COALESCE(
         (
           SELECT g.storage_workspace_id
           FROM ce_workspace_aliases a
           JOIN ce_workspace_generations g ON g.id = a.generation_id
           WHERE a.logical_workspace_id = $1
         ),
         $1
       )
       AND m.key = $2`,
      [workspaceId, key],
    );
    return result.rows[0]?.value ?? null;
  }

  async createWorkspace(input: {
    name: string;
    sourceMode: WorkspaceSourceMode;
    localRoot?: string;
    ownerPrincipalId?: string;
  }): Promise<StoredWorkspace> {
    const id = randomUUID();
    return this.withTransaction(async (client) => {
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO ce_workspaces(id, name, source_mode, local_root)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, source_mode, local_root, revision, created_at, updated_at`,
        [id, input.name, input.sourceMode, input.localRoot ?? null],
      );
      if (input.ownerPrincipalId) {
        await client.query(
          `INSERT INTO ce_workspace_acl(workspace_id, principal_id, permission)
           VALUES ($1, $2, 'owner')`,
          [id, input.ownerPrincipalId],
        );
      }
      return workspaceFromRow(result.rows[0]);
    });
  }

  async listWorkspaces(): Promise<StoredWorkspace[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, name, source_mode, local_root, revision, created_at, updated_at
       FROM ce_workspaces
       ORDER BY updated_at DESC, id`,
    );
    return result.rows.map(workspaceFromRow);
  }

  async listWorkspacesForPrincipal(principalId: string): Promise<StoredWorkspace[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.id, w.name, w.source_mode, w.local_root, w.revision,
              w.created_at, w.updated_at
       FROM ce_workspaces AS w
       JOIN ce_workspace_acl AS acl ON acl.workspace_id = w.id
       WHERE acl.principal_id = $1
       ORDER BY w.updated_at DESC, w.id`,
      [principalId],
    );
    return result.rows.map(workspaceFromRow);
  }

  async getWorkspacePermission(
    workspaceId: string,
    principalId: string,
  ): Promise<WorkspacePermission | null> {
    const result = await this.pool.query<{ permission: WorkspacePermission }>(
      `SELECT permission
       FROM ce_workspace_acl
       WHERE workspace_id = $1 AND principal_id = $2`,
      [workspaceId, principalId],
    );
    return result.rows[0]?.permission ?? null;
  }

  async listWorkspaceAcl(
    workspaceId: string,
  ): Promise<Array<{ principalId: string; permission: WorkspacePermission }>> {
    await this.requireWorkspace(workspaceId);
    const result = await this.pool.query<{
      principal_id: string;
      permission: WorkspacePermission;
    }>(
      `SELECT principal_id, permission
       FROM ce_workspace_acl
       WHERE workspace_id = $1
       ORDER BY principal_id`,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      principalId: row.principal_id,
      permission: row.permission,
    }));
  }

  async setWorkspacePermission(
    workspaceId: string,
    principalId: string,
    permission: WorkspacePermission,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO ce_workspace_acl(workspace_id, principal_id, permission)
       SELECT id, $2, $3 FROM ce_workspaces WHERE id = $1
       ON CONFLICT(workspace_id, principal_id) DO UPDATE
       SET permission = excluded.permission, updated_at = now()
       RETURNING workspace_id`,
      [workspaceId, principalId, permission],
    );
    if (!result.rows[0]) throw new WorkspaceNotFoundError(workspaceId);
  }

  async removeWorkspacePermission(
    workspaceId: string,
    principalId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ce_workspace_acl
       WHERE workspace_id = $1 AND principal_id = $2
       RETURNING workspace_id`,
      [workspaceId, principalId],
    );
    return Boolean(result.rows[0]);
  }

  async getSourceAccessPolicy(
    workspaceId: string,
    principalId: string,
  ): Promise<StoredSourceAccessPolicy | null> {
    const result = await this.pool.query<SourceAccessPolicyRow>(
      `SELECT policy.workspace_id, policy.principal_id, policy.default_access,
              policy.updated_by, policy.updated_at,
              rule.path_prefix, rule.effect
       FROM ce_source_access_policies AS policy
       LEFT JOIN ce_source_access_rules AS rule
         ON rule.workspace_id = policy.workspace_id
        AND rule.principal_id = policy.principal_id
       WHERE policy.workspace_id = $1 AND policy.principal_id = $2
       ORDER BY rule.path_prefix`,
      [workspaceId, principalId],
    );
    return sourceAccessPoliciesFromRows(result.rows)[0] ?? null;
  }

  async listSourceAccessPolicies(
    workspaceId: string,
  ): Promise<StoredSourceAccessPolicy[]> {
    await this.requireWorkspace(workspaceId);
    const result = await this.pool.query<SourceAccessPolicyRow>(
      `SELECT policy.workspace_id, policy.principal_id, policy.default_access,
              policy.updated_by, policy.updated_at,
              rule.path_prefix, rule.effect
       FROM ce_source_access_policies AS policy
       LEFT JOIN ce_source_access_rules AS rule
         ON rule.workspace_id = policy.workspace_id
        AND rule.principal_id = policy.principal_id
       WHERE policy.workspace_id = $1
       ORDER BY policy.principal_id, rule.path_prefix`,
      [workspaceId],
    );
    return sourceAccessPoliciesFromRows(result.rows);
  }

  async setSourceAccessPolicy(input: {
    workspaceId: string;
    principalId: string;
    defaultAccess: SourceAccessEffect;
    rules: readonly SourcePathRule[];
    updatedBy: string;
  }): Promise<StoredSourceAccessPolicy> {
    if (input.rules.length > 256) {
      throw new Error("Source access policy cannot exceed 256 rules");
    }
    const prefixes = new Set<string>();
    for (const rule of input.rules) {
      if (prefixes.has(rule.pathPrefix)) {
        throw new Error("Source access policy path prefixes must be unique");
      }
      prefixes.add(rule.pathPrefix);
    }
    await this.withTransaction(async (client) => {
      const member = await client.query(
        `SELECT 1 FROM ce_workspace_acl
         WHERE workspace_id = $1 AND principal_id = $2
         FOR UPDATE`,
        [input.workspaceId, input.principalId],
      );
      if (!member.rows[0]) throw new SourceAccessPolicyTargetError();
      await client.query(
        `INSERT INTO ce_source_access_policies(
           workspace_id, principal_id, default_access, updated_by
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT(workspace_id, principal_id) DO UPDATE
         SET default_access = excluded.default_access,
             updated_by = excluded.updated_by,
             updated_at = now()`,
        [
          input.workspaceId,
          input.principalId,
          input.defaultAccess,
          input.updatedBy,
        ],
      );
      await client.query(
        `DELETE FROM ce_source_access_rules
         WHERE workspace_id = $1 AND principal_id = $2`,
        [input.workspaceId, input.principalId],
      );
      if (input.rules.length) {
        await client.query(
          `INSERT INTO ce_source_access_rules(
             workspace_id, principal_id, path_prefix, effect
           )
           SELECT $1, $2, rule.path_prefix, rule.effect
           FROM unnest($3::text[], $4::text[]) AS rule(path_prefix, effect)`,
          [
            input.workspaceId,
            input.principalId,
            input.rules.map((rule) => rule.pathPrefix),
            input.rules.map((rule) => rule.effect),
          ],
        );
      }
    });
    return (await this.getSourceAccessPolicy(input.workspaceId, input.principalId))!;
  }

  async removeSourceAccessPolicy(
    workspaceId: string,
    principalId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ce_source_access_policies
       WHERE workspace_id = $1 AND principal_id = $2
       RETURNING workspace_id`,
      [workspaceId, principalId],
    );
    return Boolean(result.rows[0]);
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

  async createConnectorSource(input: {
    workspaceId: string;
    provider: ConnectorProvider;
    externalId: string;
    config: Record<string, unknown>;
    createdBy: string;
  }): Promise<StoredConnectorSource> {
    return this.withTransaction(async (client) => {
      const workspace = await client.query<{
        id: string;
        source_mode: WorkspaceSourceMode;
        file_count: string | number;
      }>(
        `SELECT w.id, w.source_mode,
                (SELECT count(*) FROM ce_workspace_sources s
                 WHERE s.workspace_id = w.id) AS file_count
         FROM ce_workspaces w
         WHERE w.id = $1
         FOR UPDATE`,
        [input.workspaceId],
      );
      const current = workspace.rows[0];
      if (!current) throw new WorkspaceNotFoundError(input.workspaceId);
      if (current.source_mode !== "blob") {
        throw new Error("Connectors require a blob workspace");
      }
      if (Number(current.file_count) > 0) {
        throw new Error("A connector can only be attached to an empty workspace");
      }
      const planned = await client.query<{ active: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM ce_sync_sessions
           WHERE workspace_id = $1
             AND status = 'planned'
             AND expires_at >= clock_timestamp()
         ) AS active`,
        [input.workspaceId],
      );
      if (planned.rows[0]?.active) {
        throw new Error("A connector cannot be attached while a file sync plan is active");
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ce_connector_sources WHERE workspace_id = $1`,
        [input.workspaceId],
      );
      if (existing.rows[0]) {
        throw new Error("This workspace already has a connector source");
      }
      const id = randomUUID();
      const result = await client.query<ConnectorSourceRow>(
        `INSERT INTO ce_connector_sources(
           id, workspace_id, provider, external_id, config, created_by
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING id, workspace_id, provider, external_id, config, cursor,
                   cursor_version, upstream_revision, status, last_error,
                   last_synced_at, created_by, created_at, updated_at`,
        [
          id,
          input.workspaceId,
          input.provider,
          input.externalId,
          JSON.stringify(input.config),
          input.createdBy,
        ],
      );
      return connectorSourceFromRow(result.rows[0]);
    });
  }

  async listConnectorSources(workspaceId: string): Promise<StoredConnectorSource[]> {
    const result = await this.pool.query<ConnectorSourceRow>(
      `SELECT id, workspace_id, provider, external_id, config, cursor,
              cursor_version, upstream_revision, status, last_error,
              last_synced_at, created_by, created_at, updated_at
       FROM ce_connector_sources
       WHERE workspace_id = $1
       ORDER BY created_at, id`,
      [workspaceId],
    );
    return result.rows.map(connectorSourceFromRow);
  }

  async getConnectorSource(
    workspaceId: string,
    sourceId: string,
  ): Promise<StoredConnectorSource | null> {
    const result = await this.pool.query<ConnectorSourceRow>(
      `SELECT id, workspace_id, provider, external_id, config, cursor,
              cursor_version, upstream_revision, status, last_error,
              last_synced_at, created_by, created_at, updated_at
       FROM ce_connector_sources
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, sourceId],
    );
    return result.rows[0] ? connectorSourceFromRow(result.rows[0]) : null;
  }

  async workspaceHasConnector(workspaceId: string): Promise<boolean> {
    const result = await this.pool.query<{ connected: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ce_connector_sources WHERE workspace_id = $1
       ) AS connected`,
      [workspaceId],
    );
    return Boolean(result.rows[0]?.connected);
  }

  async listConnectorFiles(sourceId: string): Promise<StoredConnectorFile[]> {
    const result = await this.pool.query<ConnectorFileRow>(
      `SELECT source_id, path, remote_revision, content_hash, bytes
       FROM ce_connector_files
       WHERE source_id = $1
       ORDER BY path`,
      [sourceId],
    );
    return result.rows.map(connectorFileFromRow);
  }

  async beginConnectorSync(
    workspaceId: string,
    sourceId: string,
    cursorVersion: number,
  ): Promise<ConnectorSyncLease | null> {
    const syncAttemptId = randomUUID();
    const result = await this.pool.query<ConnectorSyncLeaseRow>(
      `UPDATE ce_connector_sources
       SET status = 'syncing',
           sync_attempt_id = $4,
           lease_expires_at = clock_timestamp() + interval '15 minutes',
           last_error = NULL,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND cursor_version = $3
         AND (
           status <> 'syncing'
           OR lease_expires_at IS NULL
           OR lease_expires_at <= clock_timestamp()
         )
       RETURNING id, workspace_id, provider, external_id, config, cursor,
                 cursor_version, upstream_revision, status, last_error,
                 last_synced_at, created_by, created_at, updated_at,
                 sync_attempt_id, lease_expires_at`,
      [sourceId, workspaceId, cursorVersion, syncAttemptId],
    );
    return result.rows[0] ? connectorSyncLeaseFromRow(result.rows[0]) : null;
  }

  async renewConnectorSyncLease(
    workspaceId: string,
    attempt: ConnectorSyncAttempt,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ce_connector_sources
       SET lease_expires_at = clock_timestamp() + interval '15 minutes',
           updated_at = now()
       WHERE id = $1
         AND workspace_id = $2
         AND cursor_version = $3
         AND sync_attempt_id = $4
         AND status = 'syncing'
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [
        attempt.sourceId,
        workspaceId,
        attempt.expectedCursorVersion,
        attempt.syncAttemptId,
      ],
    );
    return Boolean(result.rows[0]);
  }

  async completeConnectorNoop(
    workspaceId: string,
    attempt: ConnectorSyncAttempt,
    cursor: Record<string, unknown>,
    upstreamRevision: string,
    files: StoredConnectorFile[],
  ): Promise<StoredConnectorSource | null> {
    return this.withTransaction(async (client) => {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM ce_connector_sources
         WHERE id = $1
           AND workspace_id = $2
           AND cursor_version = $3
           AND sync_attempt_id = $4
           AND status = 'syncing'
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          attempt.sourceId,
          workspaceId,
          attempt.expectedCursorVersion,
          attempt.syncAttemptId,
        ],
      );
      if (!source.rows[0]) return null;
      await client.query(`DELETE FROM ce_connector_files WHERE source_id = $1`, [
        attempt.sourceId,
      ]);
      if (files.length > 0) {
        await client.query(
          `INSERT INTO ce_connector_files(
             source_id, path, remote_revision, content_hash, bytes
           )
           SELECT $1, input.path, input.remote_revision, input.content_hash, input.bytes
           FROM unnest(
             $2::text[], $3::text[], $4::text[], $5::bigint[]
          ) AS input(path, remote_revision, content_hash, bytes)`,
          [
            attempt.sourceId,
            files.map((file) => file.path),
            files.map((file) => file.remoteRevision),
            files.map((file) => file.contentHash),
            files.map((file) => file.bytes),
          ],
        );
      }
      const result = await client.query<ConnectorSourceRow>(
        `UPDATE ce_connector_sources
         SET cursor = $5::jsonb,
             cursor_version = cursor_version + 1,
             upstream_revision = $6,
             status = 'ready',
             sync_attempt_id = NULL,
             lease_expires_at = NULL,
             last_error = NULL,
             last_synced_at = now(),
             updated_at = now()
         WHERE id = $1
           AND workspace_id = $2
           AND cursor_version = $3
           AND sync_attempt_id = $4
           AND status = 'syncing'
           AND lease_expires_at > clock_timestamp()
         RETURNING id, workspace_id, provider, external_id, config, cursor,
                   cursor_version, upstream_revision, status, last_error,
                   last_synced_at, created_by, created_at, updated_at`,
        [
          attempt.sourceId,
          workspaceId,
          attempt.expectedCursorVersion,
          attempt.syncAttemptId,
          JSON.stringify(cursor),
          upstreamRevision,
        ],
      );
      if (!result.rows[0]) {
        // The lease may expire while the row is locked. Roll back the file
        // snapshot rather than committing stale metadata for the next worker.
        throw new SyncPlanConflictError(
          "Connector synchronization lease is no longer active",
        );
      }
      return connectorSourceFromRow(result.rows[0]);
    });
  }

  async failConnectorSync(
    workspaceId: string,
    attempt: ConnectorSyncAttempt,
    error: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ce_connector_sources
       SET status = 'error',
           sync_attempt_id = NULL,
           lease_expires_at = NULL,
           last_error = $5,
           updated_at = now()
       WHERE id = $1
         AND workspace_id = $2
         AND cursor_version = $3
         AND sync_attempt_id = $4
         AND status = 'syncing'
       RETURNING id`,
      [
        attempt.sourceId,
        workspaceId,
        attempt.expectedCursorVersion,
        attempt.syncAttemptId,
        error.slice(0, 1000),
      ],
    );
    return Boolean(result.rows[0]);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ce_workspaces WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      if (!existing.rows[0]) throw new WorkspaceNotFoundError(workspaceId);
      // A logical workspace can own several immutable index generations. Drop
      // every physical namespace, not only the currently promoted one.
      const generationStorage =
        `(SELECT storage_workspace_id FROM ce_workspace_generations WHERE logical_workspace_id = $1)`;
      await client.query(
        `DELETE FROM ce_chunks WHERE workspace_id = $1 OR workspace_id IN ${generationStorage}`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM ce_imports WHERE workspace_id = $1 OR workspace_id IN ${generationStorage}`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM ce_files WHERE workspace_id = $1 OR workspace_id IN ${generationStorage}`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM ce_meta WHERE workspace_id = $1 OR workspace_id IN ${generationStorage}`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM ce_workspace_aliases WHERE logical_workspace_id = $1`,
        [workspaceId],
      );
      await client.query(
        `DELETE FROM ce_workspace_generations WHERE logical_workspace_id = $1`,
        [workspaceId],
      );
      await client.query(`DELETE FROM ce_workspaces WHERE id = $1`, [workspaceId]);
      await client.query(
        `DELETE FROM ce_source_blobs AS blob
         WHERE NOT EXISTS (
           SELECT 1 FROM ce_workspace_sources AS source
           WHERE source.blob_hash = blob.hash
         )
         AND NOT EXISTS (
           SELECT 1 FROM ce_workspace_blob_grants AS grant_row
           WHERE grant_row.blob_hash = blob.hash
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

  async putBlobForSync(
    workspaceId: string,
    syncId: string,
    hash: string,
    content: Buffer,
    connectorAttempt?: ConnectorSyncAttempt,
  ): Promise<void> {
    const normalizedHash = hash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error("Blob hash must be a lowercase SHA-256 hex digest");
    }
    if (sha256(content) !== normalizedHash) {
      throw new Error("Blob SHA-256 does not match its content");
    }
    await this.withTransaction(async (client) => {
      const session = await client.query<{
        workspace_id: string;
        status: string;
        expires_at: Date | string;
        session_active: boolean;
        connector_source_id: string | null;
        connector_attempt_id: string | null;
      }>(
        `SELECT workspace_id, status, expires_at,
                expires_at > clock_timestamp() AS session_active,
                connector_source_id, connector_attempt_id
         FROM ce_sync_sessions
         WHERE id = $1
         FOR SHARE`,
        [syncId],
      );
      const current = session.rows[0];
      if (!current || current.workspace_id !== workspaceId) {
        throw new Error("Sync session was not found for this workspace");
      }
      if (current.status !== "planned") {
        throw new Error(`Sync session is ${current.status}`);
      }
      if (!current.session_active) {
        throw new SyncPlanExpiredError();
      }
      if (current.connector_attempt_id) {
        if (
          !connectorAttempt ||
          current.connector_source_id !== connectorAttempt.sourceId ||
          current.connector_attempt_id !== connectorAttempt.syncAttemptId
        ) {
          throw new SyncPlanConflictError(
            "Connector synchronization lease is no longer active",
          );
        }
        const lease = await client.query<{ active: boolean }>(
          `SELECT EXISTS(
             SELECT 1
             FROM ce_connector_sources
             WHERE id = $1
               AND workspace_id = $2
               AND cursor_version = $3
               AND sync_attempt_id = $4
               AND status = 'syncing'
               AND lease_expires_at > clock_timestamp()
           ) AS active`,
          [
            connectorAttempt.sourceId,
            workspaceId,
            connectorAttempt.expectedCursorVersion,
            connectorAttempt.syncAttemptId,
          ],
        );
        if (!lease.rows[0]?.active) {
          throw new SyncPlanConflictError(
            "Connector synchronization lease is no longer active",
          );
        }
      } else if (connectorAttempt) {
        throw new SyncPlanConflictError(
          "Sync session is not owned by this connector attempt",
        );
      }
      const requested = await client.query<{ requested: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM ce_sync_changes
           WHERE session_id = $1 AND blob_hash = $2
         ) AS requested`,
        [syncId, normalizedHash],
      );
      if (!requested.rows[0]?.requested) {
        throw new Error("Blob was not requested by this sync session");
      }
      await client.query(
        `INSERT INTO ce_source_blobs(hash, content, bytes)
         VALUES ($1, $2, $3)
         ON CONFLICT(hash) DO NOTHING`,
        [normalizedHash, content, content.length],
      );
      await client.query(
        `INSERT INTO ce_workspace_blob_grants(workspace_id, blob_hash)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [workspaceId, normalizedHash],
      );
      if (connectorAttempt && current.connector_attempt_id) {
        const finalLease = await client.query<{ id: string }>(
          `SELECT id
           FROM ce_connector_sources
           WHERE id = $1
             AND workspace_id = $2
             AND cursor_version = $3
             AND sync_attempt_id = $4
             AND status = 'syncing'
             AND lease_expires_at > clock_timestamp()
           FOR SHARE`,
          [
            connectorAttempt.sourceId,
            workspaceId,
            connectorAttempt.expectedCursorVersion,
            connectorAttempt.syncAttemptId,
          ],
        );
        if (!finalLease.rows[0]) {
          throw new SyncPlanConflictError(
            "Connector synchronization lease is no longer active",
          );
        }
      }
      const finalSession = await client.query<{ id: string }>(
        `SELECT id
         FROM ce_sync_sessions
         WHERE id = $1
           AND workspace_id = $2
           AND status = 'planned'
           AND expires_at > clock_timestamp()
         FOR SHARE`,
        [syncId, workspaceId],
      );
      if (!finalSession.rows[0]) {
        throw new SyncPlanExpiredError();
      }
    });
  }

  async getSyncWorkspaceId(syncId: string): Promise<string | null> {
    const result = await this.pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM ce_sync_sessions WHERE id = $1`,
      [syncId],
    );
    return result.rows[0]?.workspace_id ?? null;
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
    allowGlobalBlobs = false,
    connectorAttempt?: ConnectorSyncAttempt,
  ): Promise<SyncPlan> {
    const id = randomUUID();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Sync plan TTL must be a positive finite number");
    }
    const normalizedTtlMs = Math.max(1, Math.floor(ttlMs));
    return this.withTransaction(async (client) => {
      const workspace = await client.query<WorkspaceRow>(
        `SELECT id, name, source_mode, local_root, revision, created_at, updated_at
         FROM ce_workspaces WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      const row = workspace.rows[0];
      if (!row) throw new WorkspaceNotFoundError(workspaceId);

      const connector = await client.query<{
        id: string;
        cursor_version: string | number;
        status: StoredConnectorSource["status"];
        sync_attempt_id: string | null;
        lease_active: boolean;
      }>(
        `SELECT id,
                cursor_version,
                status,
                sync_attempt_id,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM ce_connector_sources
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId],
      );
      const attachedConnector = connector.rows[0];
      if (!connectorAttempt && attachedConnector) {
        throw new SyncPlanConflictError(
          "Use the attached connector to synchronize this workspace",
        );
      }
      if (
        connectorAttempt &&
        (!attachedConnector ||
          attachedConnector.id !== connectorAttempt.sourceId ||
          attachedConnector.status !== "syncing" ||
          attachedConnector.sync_attempt_id !== connectorAttempt.syncAttemptId ||
          Number(attachedConnector.cursor_version) !==
            connectorAttempt.expectedCursorVersion ||
          !attachedConnector.lease_active)
      ) {
        throw new SyncPlanConflictError(
          "Connector synchronization lease is no longer active",
        );
      }
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
      // Existing mappings are also workspace-scoped possession proof. This
      // preserves unchanged/renamed files after grants from expired sessions
      // are cleaned up, without consulting another workspace's Blob state.
      await client.query(
        `INSERT INTO ce_workspace_blob_grants(workspace_id, blob_hash)
         SELECT DISTINCT workspace_id, blob_hash
         FROM ce_workspace_sources
         WHERE workspace_id = $1 AND blob_hash = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [workspaceId, requested],
      );
      const known = allowGlobalBlobs
        ? await client.query<{ hash: string }>(
            `SELECT hash FROM ce_source_blobs WHERE hash = ANY($1::text[])`,
            [requested],
          )
        : await client.query<{ hash: string }>(
            `SELECT blob.hash
             FROM ce_workspace_blob_grants AS grant_row
             JOIN ce_source_blobs AS blob ON blob.hash = grant_row.blob_hash
             WHERE grant_row.workspace_id = $1
               AND blob.hash = ANY($2::text[])`,
            [workspaceId, requested],
          );
      const knownHashes = new Set(known.rows.map((item) => item.hash));
      const missingBlobs = requested.filter((hash) => !knownHashes.has(hash));

      const session = await client.query<{ expires_at: Date | string }>(
        `INSERT INTO ce_sync_sessions(
           id, workspace_id, base_revision, status, expires_at,
           connector_source_id, connector_attempt_id
         )
         VALUES (
           $1, $2, $3, 'planned',
           clock_timestamp() + interval '1 millisecond' * $4::double precision,
           $5, $6
         )
         RETURNING expires_at`,
        [
          id,
          workspaceId,
          baseRevision,
          normalizedTtlMs,
          connectorAttempt?.sourceId ?? null,
          connectorAttempt?.syncAttemptId ?? null,
        ],
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
      if (connectorAttempt) {
        const finalLease = await client.query<{ id: string }>(
          `SELECT id
           FROM ce_connector_sources
           WHERE id = $1
             AND workspace_id = $2
             AND cursor_version = $3
             AND sync_attempt_id = $4
             AND status = 'syncing'
             AND lease_expires_at > clock_timestamp()`,
          [
            connectorAttempt.sourceId,
            workspaceId,
            connectorAttempt.expectedCursorVersion,
            connectorAttempt.syncAttemptId,
          ],
        );
        if (!finalLease.rows[0]) {
          throw new SyncPlanConflictError(
            "Connector synchronization lease is no longer active",
          );
        }
      }
      const finalSession = await client.query<{ active: boolean }>(
        `SELECT expires_at > clock_timestamp() AS active
         FROM ce_sync_sessions
         WHERE id = $1 AND workspace_id = $2 AND status = 'planned'
         FOR SHARE`,
        [id, workspaceId],
      );
      if (!finalSession.rows[0]?.active) {
        throw new SyncPlanExpiredError(
          "Sync plan TTL elapsed before plan creation completed",
        );
      }
      const expiresAt = iso(session.rows[0]?.expires_at);
      if (!expiresAt) throw new Error("Sync session expiry was not returned");
      return {
        id,
        workspaceId,
        baseRevision,
        missingBlobs,
        expiresAt,
      };
    });
  }

  async commitSync(
    workspaceId: string,
    syncId: string,
    options: SyncCommitOptions = {},
  ): Promise<SyncCommitResult> {
    return this.withTransaction(async (client) => {
      const session = await client.query<{
        id: string;
        workspace_id: string;
        base_revision: string | number;
        status: string;
        expires_at: Date | string;
        session_active: boolean;
        revision: string | number;
        connector_source_id: string | null;
        connector_attempt_id: string | null;
      }>(
        `SELECT s.id, s.workspace_id, s.base_revision, s.status, s.expires_at,
                s.expires_at > clock_timestamp() AS session_active,
                s.connector_source_id, s.connector_attempt_id, w.revision
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
      if (!current.session_active) {
        throw new SyncPlanExpiredError();
      }
      const currentRevision = Number(current.revision);
      if (currentRevision !== Number(current.base_revision)) {
        throw new RevisionConflictError(Number(current.base_revision), currentRevision);
      }
      if (
        options.connector &&
        (current.connector_source_id !== options.connector.sourceId ||
          current.connector_attempt_id !== options.connector.syncAttemptId)
      ) {
        throw new SyncPlanConflictError(
          "Sync session is not owned by this connector attempt",
        );
      }
      if (!options.connector && current.connector_attempt_id) {
        throw new SyncPlanConflictError(
          "Connector-owned sync sessions cannot be committed manually",
        );
      }

      const connector = await client.query<{
        id: string;
        cursor_version: string | number;
        status: StoredConnectorSource["status"];
        sync_attempt_id: string | null;
        lease_active: boolean;
      }>(
        `SELECT id,
                cursor_version,
                status,
                sync_attempt_id,
                lease_expires_at > clock_timestamp() AS lease_active
         FROM ce_connector_sources
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId],
      );
      const attachedConnector = connector.rows[0];
      if (!options.connector && attachedConnector) {
        throw new SyncPlanConflictError(
          "Use the attached connector to synchronize this workspace",
        );
      }
      if (
        options.connector &&
        (!attachedConnector ||
          attachedConnector.id !== options.connector.sourceId ||
          attachedConnector.status !== "syncing" ||
          attachedConnector.sync_attempt_id !== options.connector.syncAttemptId ||
          !attachedConnector.lease_active)
      ) {
        throw new SyncPlanConflictError(
          "Connector synchronization lease is no longer active",
        );
      }
      if (
        options.connector &&
        Number(attachedConnector?.cursor_version) !==
          options.connector.expectedCursorVersion
      ) {
        throw new RevisionConflictError(
          options.connector.expectedCursorVersion,
          Number(attachedConnector?.cursor_version),
        );
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
      const known = options.allowGlobalBlobs
        ? await client.query<{ hash: string }>(
            `SELECT hash FROM ce_source_blobs WHERE hash = ANY($1::text[])`,
            [requiredHashes],
          )
        : await client.query<{ hash: string }>(
            `SELECT blob.hash
             FROM ce_workspace_blob_grants AS grant_row
             JOIN ce_source_blobs AS blob ON blob.hash = grant_row.blob_hash
             WHERE grant_row.workspace_id = $1
               AND blob.hash = ANY($2::text[])`,
            [workspaceId, requiredHashes],
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
      if (options.connector) {
        await client.query(`DELETE FROM ce_connector_files WHERE source_id = $1`, [
          options.connector.sourceId,
        ]);
        if (options.connector.files.length > 0) {
          await client.query(
            `INSERT INTO ce_connector_files(
               source_id, path, remote_revision, content_hash, bytes
             )
             SELECT $1, input.path, input.remote_revision, input.content_hash, input.bytes
             FROM unnest(
               $2::text[], $3::text[], $4::text[], $5::bigint[]
             ) AS input(path, remote_revision, content_hash, bytes)`,
            [
              options.connector.sourceId,
              options.connector.files.map((file) => file.path),
              options.connector.files.map((file) => file.remoteRevision),
              options.connector.files.map((file) => file.contentHash),
              options.connector.files.map((file) => file.bytes),
            ],
          );
        }
        const completed = await client.query(
          `UPDATE ce_connector_sources
           SET cursor = $5::jsonb,
               cursor_version = cursor_version + 1,
               upstream_revision = $6,
               status = 'ready',
               sync_attempt_id = NULL,
               lease_expires_at = NULL,
               last_error = NULL,
               last_synced_at = now(),
               updated_at = now()
           WHERE id = $1
             AND workspace_id = $2
             AND cursor_version = $3
             AND sync_attempt_id = $4
             AND status = 'syncing'
             AND lease_expires_at > clock_timestamp()
           RETURNING id`,
          [
            options.connector.sourceId,
            workspaceId,
            options.connector.expectedCursorVersion,
            options.connector.syncAttemptId,
            JSON.stringify(options.connector.cursor),
            options.connector.upstreamRevision,
          ],
        );
        if (!completed.rows[0]) {
          throw new SyncPlanConflictError(
            "Connector synchronization lease is no longer active",
          );
        }
      }
      let indexJob: StoredIndexJob | undefined;
      if (options.createIndexJob) {
        const jobId = randomUUID();
        const result = await client.query<JobRow>(
          `INSERT INTO ce_index_jobs(
             id, workspace_id, revision, mode, changed_paths, deleted_paths,
             status, progress
           )
           VALUES ($1, $2, $3, 'incremental', $4::jsonb, $5::jsonb,
                   'queued', $6::jsonb)
           RETURNING id, workspace_id, revision, mode, changed_paths, deleted_paths,
                     status, progress, result, error, created_at, started_at, completed_at`,
          [
            jobId,
            workspaceId,
            nextRevision,
            JSON.stringify([...changedPaths].sort()),
            JSON.stringify([...deletedPaths].sort()),
            JSON.stringify({ phase: "queued" }),
          ],
        );
        indexJob = jobFromRow(result.rows[0]);
      }
      const committedSession = await client.query<{ id: string }>(
        `UPDATE ce_sync_sessions
         SET status = 'committed'
         WHERE id = $1
           AND workspace_id = $2
           AND status = 'planned'
           AND expires_at > clock_timestamp()
         RETURNING id`,
        [syncId, workspaceId],
      );
      if (!committedSession.rows[0]) {
        throw new SyncPlanExpiredError();
      }
      return {
        revision: nextRevision,
        changedPaths: [...changedPaths].sort(),
        deletedPaths: [...deletedPaths].sort(),
        ...(indexJob ? { indexJob } : {}),
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
    // A running job may belong to another live server instance. Only recover
    // it after acquiring the same workspace advisory lock used by runners;
    // a live owner keeps the lock and is left untouched.
    const workspaces = await this.pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id
       FROM ce_index_jobs
       WHERE status = 'running'`,
    );
    for (const row of workspaces.rows) {
      const client = await this.pool.connect();
      let lockKey: string | null = null;
      try {
        const key = await client.query<{ key: string }>(
          `SELECT hashtextextended($1, 0)::text AS key`,
          [`contextengine:index-job:${row.workspace_id}`],
        );
        lockKey = key.rows[0]?.key ?? null;
        if (!lockKey) continue;
        const acquired = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
          [lockKey],
        );
        if (!acquired.rows[0]?.acquired) continue;
        await this.pool.query(
          `UPDATE ce_index_jobs
           SET status = 'failed',
               error = 'Server restarted while the job was running',
               completed_at = now()
           WHERE workspace_id = $1 AND status = 'running'`,
          [row.workspace_id],
        );
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]);
      } finally {
        client.release();
      }
    }
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
          const document = sourceFromRow(row, true);
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
        const document = sourceFromRow(row, true);
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
