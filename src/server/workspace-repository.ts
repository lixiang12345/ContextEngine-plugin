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
export { sourcePathAllowed } from "../source-access.js";

export type WorkspaceSourceMode = "blob" | "local";
export type SyncOperation = "upsert" | "delete" | "rename";
export type IndexJobMode = "incremental" | "rebuild";
export type IndexJobStatus = "queued" | "running" | "succeeded" | "failed";
export type SnapshotJobOperation = "export" | "import" | "prune" | "gc" | "replicate";
export type SnapshotJobStatus = "queued" | "running" | "succeeded" | "failed";
export type SnapshotJobAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "retry_scheduled"
  | "lease_expired";
export type SnapshotJobEventKind =
  | "snapshot"
  | "queued"
  | "attempt_started"
  | "lease_takeover"
  | "progress"
  | "retry_scheduled"
  | "manual_retry"
  | "succeeded"
  | "failed";
export type SnapshotReplicationScheduleMode = "manual" | "interval" | "nightly";
export type WorkspacePermission = "reader" | "writer" | "owner";
/** Lowercase provider id registered by a SourceConnectorPlugin. */
export type ConnectorProvider = string;
export type McpSessionStatus = "active" | "closing" | "closed";
export type ConnectorWebhookEventStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed";
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

export interface StoredConnectorWebhookEvent {
  sourceId: string;
  eventId: string;
  provider: string;
  bodyHash: string;
  status: ConnectorWebhookEventStatus;
  attempts: number;
  nextAttemptAt: string;
  lockedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StoredConnectorCiToken {
  id: string;
  sourceId: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
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

export interface StoredSnapshotJob {
  id: string;
  workspaceId: string;
  principalId: string;
  operation: SnapshotJobOperation;
  snapshotName: string | null;
  parameters: Record<string, unknown>;
  status: SnapshotJobStatus;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  lockedAt: string | null;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ClaimedSnapshotJob extends StoredSnapshotJob {
  attemptToken: string;
}

export interface StoredSnapshotJobAttempt {
  jobId: string;
  attempt: number;
  budgetAttempt: number;
  status: SnapshotJobAttemptStatus;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  backfilled: boolean;
  startedAt: string;
  lastHeartbeatAt: string;
  completedAt: string | null;
}

export interface StoredSnapshotJobEvent {
  eventId: string;
  jobId: string;
  attempt: number | null;
  kind: SnapshotJobEventKind;
  status: SnapshotJobStatus;
  attempts: number;
  details: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  nextAttemptAt: string;
  startedAt: string | null;
  completedAt: string | null;
  backfilled: boolean;
  createdAt: string;
}

export interface StoredSnapshotReplicationSchedule {
  id: string;
  workspaceId: string;
  targetId: string;
  snapshotName: string;
  mode: SnapshotReplicationScheduleMode;
  intervalMs: number | null;
  nightlyAt: string | null;
  timezone: string;
  enabled: boolean;
  nextScheduledAt: string | null;
  lastScheduledAt: string | null;
  lastJobId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotReplicationJobCreation {
  job: StoredSnapshotJob;
  created: boolean;
}

export interface StoredSnapshotReplicationPublication {
  jobId: string;
  publicationSequence: string;
  sourceManifest: Record<string, unknown>;
  sourceManifestSha256: string;
  pinnedAt: string;
}

export interface SnapshotReplicationMetrics {
  targetId: string;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  retries: number;
  averageDurationMs: number | null;
  totalArtifactBytes: number;
  averageArtifactBytes: number | null;
  largestArtifactBytes: number | null;
  averageThroughputBytesPerSecond: number | null;
  consecutiveFailures: number;
  replicationLagMs: number | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
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

interface SnapshotJobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  operation: SnapshotJobOperation;
  snapshot_name: string | null;
  parameters: unknown;
  status: SnapshotJobStatus;
  progress: unknown;
  result: unknown;
  error: string | null;
  attempts: string | number;
  locked_at: string | Date | null;
  lock_token: string | null;
  next_attempt_at: string | Date;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
}

interface SnapshotJobAttemptRow extends QueryResultRow {
  job_id: string;
  attempt: string | number;
  budget_attempt: string | number;
  status: SnapshotJobAttemptStatus;
  progress: unknown;
  result: unknown;
  error: string | null;
  backfilled: boolean;
  started_at: string | Date;
  last_heartbeat_at: string | Date;
  completed_at: string | Date | null;
}

interface SnapshotJobEventRow extends QueryResultRow {
  event_id: string | number;
  job_id: string;
  attempt: string | number | null;
  kind: SnapshotJobEventKind;
  status: SnapshotJobStatus;
  attempts: string | number;
  details: unknown;
  progress: unknown;
  result: unknown;
  error: string | null;
  next_attempt_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  backfilled: boolean;
  created_at: string | Date;
}

interface SnapshotReplicationScheduleRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  target_id: string;
  snapshot_name: string;
  mode: SnapshotReplicationScheduleMode;
  interval_ms: string | number | null;
  nightly_at: string | null;
  timezone: string;
  enabled: boolean;
  next_scheduled_at: string | Date | null;
  last_scheduled_at: string | Date | null;
  last_job_id: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SnapshotReplicationPublicationRow extends QueryResultRow {
  job_id: string;
  publication_sequence: string | number;
  source_manifest: unknown;
  source_manifest_sha256: string;
  pinned_at: string | Date;
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

interface ConnectorWebhookEventRow extends QueryResultRow {
  source_id: string;
  event_id: string;
  provider: string;
  body_hash: string;
  status: ConnectorWebhookEventStatus;
  attempts: number;
  next_attempt_at: string | Date;
  locked_at: string | Date | null;
  last_error: string | null;
  metadata: unknown;
  result: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

interface ConnectorCiTokenRow extends QueryResultRow {
  id: string;
  source_id: string;
  name: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  last_used_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
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

export class ConnectorWebhookReplayError extends Error {
  constructor() {
    super("Webhook delivery id was reused with a different payload");
    this.name = "ConnectorWebhookReplayError";
  }
}

export class ConnectorCiRateLimitError extends Error {
  constructor() {
    super("CI trigger rate limit exceeded for this source token");
    this.name = "ConnectorCiRateLimitError";
  }
}

export class SnapshotHistoryCursorError extends Error {
  constructor(label: string) {
    super(`Snapshot history ${label} cursor must be an unsigned PostgreSQL BIGINT`);
    this.name = "SnapshotHistoryCursorError";
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

const SNAPSHOT_REPLICATION_TARGET_ID_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NIGHTLY_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const MIN_SNAPSHOT_REPLICATION_INTERVAL_MS = 60_000;
const MAX_SNAPSHOT_REPLICATION_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const SNAPSHOT_HISTORY_CURSOR_RE = /^(?:0|[1-9][0-9]*)$/;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function parseSnapshotHistoryCursor(value: string, label: string): string {
  if (!SNAPSHOT_HISTORY_CURSOR_RE.test(value)) {
    throw new SnapshotHistoryCursorError(label);
  }
  try {
    const parsed = BigInt(value);
    if (parsed > MAX_SIGNED_BIGINT) throw new Error("out of range");
  } catch {
    throw new SnapshotHistoryCursorError(label);
  }
  return value;
}

function boundedHistoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function normalizeNightlyTime(value: string): string {
  const trimmed = value.trim();
  if (!NIGHTLY_TIME_RE.test(trimmed)) {
    throw new Error("Snapshot replication nightlyAt must be HH:MM or HH:MM:SS");
  }
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

function validateSnapshotReplicationScheduleInput(input: {
  targetId: string;
  snapshotName: string;
  mode: SnapshotReplicationScheduleMode;
  intervalMs?: number | null;
  nightlyAt?: string | null;
  timezone?: string;
  enabled?: boolean;
}): {
  intervalMs: number | null;
  nightlyAt: string | null;
  timezone: string;
  enabled: boolean;
} {
  if (!SNAPSHOT_REPLICATION_TARGET_ID_RE.test(input.targetId)) {
    throw new Error(`Invalid snapshot replication target id: ${input.targetId}`);
  }
  if (!SNAPSHOT_NAME_RE.test(input.snapshotName)) {
    throw new Error(`Invalid snapshot name: ${input.snapshotName}`);
  }
  if (!["manual", "interval", "nightly"].includes(input.mode)) {
    throw new Error(`Invalid snapshot replication schedule mode: ${input.mode}`);
  }
  const intervalMs = input.intervalMs == null ? null : Math.floor(input.intervalMs);
  const nightlyAt = input.nightlyAt == null ? null : normalizeNightlyTime(input.nightlyAt);
  const timezone = (input.timezone ?? "UTC").trim();
  if (!timezone || timezone.length > 64) {
    throw new Error("Snapshot replication timezone must be 1 to 64 characters");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid snapshot replication timezone: ${timezone}`);
  }
  const enabled = input.mode === "manual" ? false : (input.enabled ?? true);
  if (input.mode === "manual") {
    if (intervalMs !== null || nightlyAt !== null) {
      throw new Error("Manual snapshot replication schedules cannot set intervalMs or nightlyAt");
    }
  } else if (input.mode === "interval") {
    if (
      intervalMs === null ||
      !Number.isFinite(intervalMs) ||
      intervalMs < MIN_SNAPSHOT_REPLICATION_INTERVAL_MS ||
      intervalMs > MAX_SNAPSHOT_REPLICATION_INTERVAL_MS
    ) {
      throw new Error(
        `Snapshot replication intervalMs must be from ${MIN_SNAPSHOT_REPLICATION_INTERVAL_MS} to ${MAX_SNAPSHOT_REPLICATION_INTERVAL_MS}`,
      );
    }
    if (nightlyAt !== null) {
      throw new Error("Interval snapshot replication schedules cannot set nightlyAt");
    }
  } else if (nightlyAt === null) {
    throw new Error("Nightly snapshot replication schedules require nightlyAt");
  } else if (intervalMs !== null) {
    throw new Error("Nightly snapshot replication schedules cannot set intervalMs");
  }
  return {
    intervalMs,
    nightlyAt,
    timezone: input.mode === "nightly" ? timezone : "UTC",
    enabled,
  };
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

function snapshotJobFromRow(row: SnapshotJobRow): StoredSnapshotJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    operation: row.operation,
    snapshotName: row.snapshot_name,
    parameters: asObject(row.parameters) ?? {},
    status: row.status,
    progress: asObject(row.progress),
    result: asObject(row.result),
    error: row.error,
    attempts: Number(row.attempts),
    lockedAt: iso(row.locked_at),
    nextAttemptAt: iso(row.next_attempt_at)!,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

function snapshotJobAttemptFromRow(
  row: SnapshotJobAttemptRow,
): StoredSnapshotJobAttempt {
  return {
    jobId: row.job_id,
    attempt: Number(row.attempt),
    budgetAttempt: Number(row.budget_attempt),
    status: row.status,
    progress: asObject(row.progress) ?? {},
    result: asObject(row.result),
    error: row.error,
    backfilled: row.backfilled,
    startedAt: iso(row.started_at)!,
    lastHeartbeatAt: iso(row.last_heartbeat_at)!,
    completedAt: iso(row.completed_at),
  };
}

function snapshotJobEventFromRow(row: SnapshotJobEventRow): StoredSnapshotJobEvent {
  return {
    eventId: String(row.event_id),
    jobId: row.job_id,
    attempt: row.attempt === null ? null : Number(row.attempt),
    kind: row.kind,
    status: row.status,
    attempts: Number(row.attempts),
    details: asObject(row.details) ?? {},
    progress: asObject(row.progress) ?? {},
    result: asObject(row.result),
    error: row.error,
    nextAttemptAt: iso(row.next_attempt_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    backfilled: row.backfilled,
    createdAt: iso(row.created_at)!,
  };
}

function snapshotReplicationScheduleFromRow(
  row: SnapshotReplicationScheduleRow,
): StoredSnapshotReplicationSchedule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetId: row.target_id,
    snapshotName: row.snapshot_name,
    mode: row.mode,
    intervalMs: row.interval_ms === null ? null : Number(row.interval_ms),
    // PostgreSQL returns TIME as a string. Keep the canonical database value
    // so callers can use it directly when rendering or calculating a run.
    nightlyAt: row.nightly_at,
    timezone: row.timezone,
    enabled: row.enabled,
    nextScheduledAt: iso(row.next_scheduled_at),
    lastScheduledAt: iso(row.last_scheduled_at),
    lastJobId: row.last_job_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function snapshotReplicationPublicationFromRow(
  row: SnapshotReplicationPublicationRow,
): StoredSnapshotReplicationPublication {
  const sourceManifest = asObject(row.source_manifest);
  if (!sourceManifest) {
    throw new Error("Snapshot replication publication manifest is invalid");
  }
  return {
    jobId: row.job_id,
    publicationSequence: String(row.publication_sequence),
    sourceManifest,
    sourceManifestSha256: row.source_manifest_sha256,
    pinnedAt: iso(row.pinned_at)!,
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

function webhookEventFromRow(
  row: ConnectorWebhookEventRow,
): StoredConnectorWebhookEvent {
  return {
    sourceId: row.source_id,
    eventId: row.event_id,
    provider: row.provider,
    bodyHash: row.body_hash,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at)!,
    lockedAt: iso(row.locked_at),
    lastError: row.last_error,
    metadata: asObject(row.metadata),
    result: asObject(row.result),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    completedAt: iso(row.completed_at),
  };
}

function ciTokenFromRow(row: ConnectorCiTokenRow): StoredConnectorCiToken {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    expiresAt: iso(row.expires_at)!,
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
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

function validateSourceAccessRules(rules: readonly SourcePathRule[]): void {
  if (rules.length > 256) {
    throw new Error("Source access policy cannot exceed 256 rules");
  }
  const prefixes = new Set<string>();
  for (const rule of rules) {
    if (prefixes.has(rule.pathPrefix)) {
      throw new Error("Source access policy path prefixes must be unique");
    }
    prefixes.add(rule.pathPrefix);
  }
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

  /**
   * Grant workspace access and install its initial source policy in one
   * transaction. Other connections observe either neither row or both rows,
   * so a newly granted principal never receives an unrestricted read window.
   */
  async setWorkspacePermissionWithSourceAccess(input: {
    workspaceId: string;
    principalId: string;
    permission: WorkspacePermission;
    defaultAccess: SourceAccessEffect;
    rules: readonly SourcePathRule[];
    updatedBy: string;
  }): Promise<StoredSourceAccessPolicy> {
    validateSourceAccessRules(input.rules);
    return this.withTransaction(async (client) => {
      const granted = await client.query(
        `INSERT INTO ce_workspace_acl(workspace_id, principal_id, permission)
         SELECT id, $2, $3 FROM ce_workspaces WHERE id = $1
         ON CONFLICT(workspace_id, principal_id) DO UPDATE
         SET permission = excluded.permission, updated_at = now()
         RETURNING workspace_id`,
        [input.workspaceId, input.principalId, input.permission],
      );
      if (!granted.rows[0]) {
        throw new WorkspaceNotFoundError(input.workspaceId);
      }
      await this.replaceSourceAccessPolicy(client, input);
      return this.getSourceAccessPolicyInTransaction(
        client,
        input.workspaceId,
        input.principalId,
      );
    });
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
    validateSourceAccessRules(input.rules);
    return this.withTransaction(async (client) => {
      const member = await client.query(
        `SELECT 1 FROM ce_workspace_acl
         WHERE workspace_id = $1 AND principal_id = $2
         FOR UPDATE`,
        [input.workspaceId, input.principalId],
      );
      if (!member.rows[0]) throw new SourceAccessPolicyTargetError();
      await this.replaceSourceAccessPolicy(client, input);
      return this.getSourceAccessPolicyInTransaction(
        client,
        input.workspaceId,
        input.principalId,
      );
    });
  }

  private async getSourceAccessPolicyInTransaction(
    client: PoolClient,
    workspaceId: string,
    principalId: string,
  ): Promise<StoredSourceAccessPolicy> {
    const result = await client.query<SourceAccessPolicyRow>(
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
    const policy = sourceAccessPoliciesFromRows(result.rows)[0];
    if (!policy) {
      throw new Error("Source access policy disappeared inside its transaction");
    }
    return policy;
  }

  private async replaceSourceAccessPolicy(
    client: PoolClient,
    input: {
      workspaceId: string;
      principalId: string;
      defaultAccess: SourceAccessEffect;
      rules: readonly SourcePathRule[];
      updatedBy: string;
    },
  ): Promise<void> {
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

  async getConnectorSourceById(sourceId: string): Promise<StoredConnectorSource | null> {
    const result = await this.pool.query<ConnectorSourceRow>(
      `SELECT id, workspace_id, provider, external_id, config, cursor,
              cursor_version, upstream_revision, status, last_error,
              last_synced_at, created_by, created_at, updated_at
       FROM ce_connector_sources
       WHERE id = $1`,
      [sourceId],
    );
    return result.rows[0] ? connectorSourceFromRow(result.rows[0]) : null;
  }

  async listConnectorSourcesForWebhook(
    provider: string,
    externalId: string,
  ): Promise<StoredConnectorSource[]> {
    const result = await this.pool.query<ConnectorSourceRow>(
      `SELECT id, workspace_id, provider, external_id, config, cursor,
              cursor_version, upstream_revision, status, last_error,
              last_synced_at, created_by, created_at, updated_at
       FROM ce_connector_sources
       WHERE provider = $1 AND external_id = $2
       ORDER BY id`,
      [provider, externalId],
    );
    return result.rows.map(connectorSourceFromRow);
  }

  async enqueueConnectorWebhookEvents(input: {
    provider: string;
    eventId: string;
    bodyHash: string;
    sourceIds: readonly string[];
  }): Promise<{ accepted: number; duplicates: number }> {
    if (!input.sourceIds.length) return { accepted: 0, duplicates: 0 };
    return this.withTransaction(async (client) => {
      const inserted = await client.query<{ source_id: string }>(
        `INSERT INTO ce_connector_webhook_events(
           source_id, event_id, provider, body_hash
         )
         SELECT source.id, $2, $3, $4
         FROM ce_connector_sources AS source
         WHERE source.id = ANY($1::text[]) AND source.provider = $3
         ON CONFLICT(source_id, event_id) DO NOTHING
         RETURNING source_id`,
        [input.sourceIds, input.eventId, input.provider, input.bodyHash],
      );
      const persisted = await client.query<{ body_hash: string }>(
        `SELECT body_hash
         FROM ce_connector_webhook_events
         WHERE source_id = ANY($1::text[]) AND event_id = $2
         FOR UPDATE`,
        [input.sourceIds, input.eventId],
      );
      if (persisted.rows.some((row) => row.body_hash !== input.bodyHash)) {
        throw new ConnectorWebhookReplayError();
      }
      return {
        accepted: inserted.rowCount ?? 0,
        duplicates: input.sourceIds.length - (inserted.rowCount ?? 0),
      };
    });
  }

  async createConnectorCiToken(input: {
    workspaceId: string;
    sourceId: string;
    tokenHash: string;
    name: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<StoredConnectorCiToken> {
    return this.withTransaction(async (client) => {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM ce_connector_sources
         WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
        [input.workspaceId, input.sourceId],
      );
      if (!source.rows[0]) throw new WorkspaceNotFoundError(input.workspaceId);
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ce_connector_ci_tokens
         WHERE source_id = $1 AND revoked_at IS NULL
           AND expires_at > clock_timestamp()`,
        [input.sourceId],
      );
      if (Number(active.rows[0]?.count ?? 0) >= 20) {
        throw new Error("Connector source already has 20 active CI tokens");
      }
      const id = randomUUID();
      const result = await client.query<ConnectorCiTokenRow>(
        `INSERT INTO ce_connector_ci_tokens(
           id, source_id, token_hash, name, expires_at, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, source_id, name, expires_at, revoked_at,
                   last_used_at, created_by, created_at`,
        [id, input.sourceId, input.tokenHash, input.name, input.expiresAt, input.createdBy],
      );
      return ciTokenFromRow(result.rows[0]);
    });
  }

  async listConnectorCiTokens(
    workspaceId: string,
    sourceId: string,
  ): Promise<StoredConnectorCiToken[]> {
    const result = await this.pool.query<ConnectorCiTokenRow>(
      `SELECT token.id, token.source_id, token.name, token.expires_at,
              token.revoked_at, token.last_used_at, token.created_by,
              token.created_at
       FROM ce_connector_ci_tokens AS token
       JOIN ce_connector_sources AS source ON source.id = token.source_id
       WHERE source.workspace_id = $1 AND source.id = $2
       ORDER BY token.created_at DESC, token.id`,
      [workspaceId, sourceId],
    );
    return result.rows.map(ciTokenFromRow);
  }

  async revokeConnectorCiToken(
    workspaceId: string,
    sourceId: string,
    tokenId: string,
  ): Promise<StoredConnectorCiToken | null> {
    const result = await this.pool.query<ConnectorCiTokenRow>(
      `UPDATE ce_connector_ci_tokens AS token
       SET revoked_at = COALESCE(token.revoked_at, clock_timestamp())
       FROM ce_connector_sources AS source
       WHERE token.id = $3 AND token.source_id = source.id
         AND source.workspace_id = $1 AND source.id = $2
       RETURNING token.id, token.source_id, token.name, token.expires_at,
                 token.revoked_at, token.last_used_at, token.created_by,
                 token.created_at`,
      [workspaceId, sourceId, tokenId],
    );
    return result.rows[0] ? ciTokenFromRow(result.rows[0]) : null;
  }

  async authenticateCiTokenAndEnqueue(input: {
    tokenHash: string;
    deliveryId: string;
    bodyHash: string;
    metadata: Record<string, unknown> | null;
  }): Promise<{
    token: StoredConnectorCiToken;
    workspaceId: string;
    provider: string;
    accepted: number;
    duplicates: number;
  } | null> {
    return this.withTransaction(async (client) => {
      const authenticated = await client.query<ConnectorCiTokenRow & {
        workspace_id: string;
        provider: string;
      }>(
        `SELECT token.id, token.source_id, token.name, token.expires_at,
                token.revoked_at, token.last_used_at, token.created_by,
                token.created_at, source.workspace_id, source.provider
         FROM ce_connector_ci_tokens AS token
         JOIN ce_connector_sources AS source ON source.id = token.source_id
         WHERE token.token_hash = $1 AND token.revoked_at IS NULL
           AND token.expires_at > clock_timestamp()
         FOR UPDATE OF token`,
        [input.tokenHash],
      );
      const row = authenticated.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE ce_connector_ci_tokens
         SET last_used_at = clock_timestamp()
         WHERE id = $1`,
        [row.id],
      );
      const eventId = `ci:${row.id}:${input.deliveryId}`;
      const recent = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ce_connector_webhook_events
         WHERE source_id = $1 AND event_id LIKE $2
           AND created_at > clock_timestamp() - interval '10 minutes'`,
        [row.source_id, `ci:${row.id}:%`],
      );
      if (Number(recent.rows[0]?.count ?? 0) >= 60) {
        throw new ConnectorCiRateLimitError();
      }
      const inserted = await client.query(
        `INSERT INTO ce_connector_webhook_events(
           source_id, event_id, provider, body_hash, metadata
         ) VALUES ($1, $2, 'ci', $3, $4::jsonb)
         ON CONFLICT(source_id, event_id) DO NOTHING
         RETURNING source_id`,
        [row.source_id, eventId, input.bodyHash, JSON.stringify(input.metadata)],
      );
      const persisted = await client.query<{ body_hash: string }>(
        `SELECT body_hash FROM ce_connector_webhook_events
         WHERE source_id = $1 AND event_id = $2
         FOR UPDATE`,
        [row.source_id, eventId],
      );
      if (persisted.rows[0]?.body_hash !== input.bodyHash) {
        throw new ConnectorWebhookReplayError();
      }
      return {
        token: { ...ciTokenFromRow(row), lastUsedAt: new Date().toISOString() },
        workspaceId: row.workspace_id,
        provider: row.provider,
        accepted: inserted.rowCount ?? 0,
        duplicates: inserted.rowCount ? 0 : 1,
      };
    });
  }

  async claimConnectorWebhookEvents(
    limit = 8,
    processingLeaseMs = 5 * 60 * 1000,
  ): Promise<StoredConnectorWebhookEvent[]> {
    const result = await this.pool.query<ConnectorWebhookEventRow>(
      `WITH candidates AS (
         SELECT source_id, event_id
         FROM ce_connector_webhook_events
         WHERE (
             status = 'pending' AND next_attempt_at <= clock_timestamp()
           ) OR (
             status = 'processing'
             AND locked_at + ($2::bigint * interval '1 millisecond')
                   <= clock_timestamp()
           )
         ORDER BY next_attempt_at, created_at, source_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ce_connector_webhook_events AS event
       SET status = 'processing',
           attempts = attempts + 1,
           locked_at = clock_timestamp(),
           updated_at = clock_timestamp()
       FROM candidates
       WHERE event.source_id = candidates.source_id
         AND event.event_id = candidates.event_id
       RETURNING event.source_id, event.event_id, event.provider,
                 event.body_hash, event.status, event.attempts,
                 event.next_attempt_at, event.locked_at, event.last_error,
                 event.metadata, event.result, event.created_at, event.updated_at,
                 event.completed_at`,
      [Math.max(1, Math.min(64, Math.floor(limit))), processingLeaseMs],
    );
    return result.rows.map(webhookEventFromRow);
  }

  async completeConnectorWebhookEvent(
    sourceId: string,
    eventId: string,
    expectedAttempt: number,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE ce_connector_webhook_events
       SET status = 'succeeded', result = $4::jsonb, last_error = NULL,
           locked_at = NULL, completed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE source_id = $1 AND event_id = $2 AND status = 'processing'
         AND attempts = $3
       RETURNING source_id`,
      [sourceId, eventId, expectedAttempt, JSON.stringify(result)],
    );
    return Boolean(updated.rows[0]);
  }

  async retryConnectorWebhookEvent(
    sourceId: string,
    eventId: string,
    expectedAttempt: number,
    error: string,
    retryDelayMs: number,
    maxAttempts = 5,
  ): Promise<"pending" | "failed" | null> {
    const updated = await this.pool.query<{ status: "pending" | "failed" }>(
      `UPDATE ce_connector_webhook_events
       SET status = CASE WHEN attempts >= $6 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = CASE
             WHEN attempts >= $6 THEN next_attempt_at
             ELSE clock_timestamp() + ($5::bigint * interval '1 millisecond')
           END,
           last_error = $4,
           locked_at = NULL,
           completed_at = CASE WHEN attempts >= $6 THEN clock_timestamp() ELSE NULL END,
           updated_at = clock_timestamp()
       WHERE source_id = $1 AND event_id = $2 AND status = 'processing'
         AND attempts = $3
       RETURNING status`,
      [
        sourceId,
        eventId,
        expectedAttempt,
        error.slice(0, 1000),
        Math.max(1_000, retryDelayMs),
        Math.max(1, maxAttempts),
      ],
    );
    return updated.rows[0]?.status ?? null;
  }

  async getConnectorWebhookEvent(
    sourceId: string,
    eventId: string,
  ): Promise<StoredConnectorWebhookEvent | null> {
    const result = await this.pool.query<ConnectorWebhookEventRow>(
      `SELECT source_id, event_id, provider, body_hash, status, attempts,
              next_attempt_at, locked_at, last_error, metadata, result, created_at,
              updated_at, completed_at
       FROM ce_connector_webhook_events
       WHERE source_id = $1 AND event_id = $2`,
      [sourceId, eventId],
    );
    return result.rows[0] ? webhookEventFromRow(result.rows[0]) : null;
  }

  async getConnectorWebhookStatistics(): Promise<{
    pending: number;
    processing: number;
    succeeded: number;
    failed: number;
  }> {
    const result = await this.pool.query<{
      pending: string;
      processing: string;
      succeeded: string;
      failed: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'processing')::text AS processing,
         COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
       FROM ce_connector_webhook_events`,
    );
    return {
      pending: Number(result.rows[0]?.pending ?? 0),
      processing: Number(result.rows[0]?.processing ?? 0),
      succeeded: Number(result.rows[0]?.succeeded ?? 0),
      failed: Number(result.rows[0]?.failed ?? 0),
    };
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

  async createSnapshotJob(input: {
    workspaceId: string;
    principalId: string;
    operation: SnapshotJobOperation;
    snapshotName?: string | null;
    parameters?: Record<string, unknown>;
  }): Promise<StoredSnapshotJob> {
    const id = randomUUID();
    const result = await this.pool.query<SnapshotJobRow>(
      `INSERT INTO ce_snapshot_jobs(
         id, workspace_id, principal_id, operation, snapshot_name,
         parameters, status, progress
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'queued', $7::jsonb)
       RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                 parameters, status, progress, result, error, attempts,
                 locked_at, lock_token, next_attempt_at, created_at,
                 started_at, completed_at`,
      [
        id,
        input.workspaceId,
        input.principalId,
        input.operation,
        input.snapshotName ?? null,
        JSON.stringify(input.parameters ?? {}),
        JSON.stringify({ phase: "queued" }),
      ],
    );
    return snapshotJobFromRow(result.rows[0]);
  }

  /**
   * Queue a replication while collapsing concurrent manual/scheduled
   * requests onto the one active job for a workspace/target/snapshot tuple.
   * The partial unique index installed by schema v13 is the final arbiter;
   * the follow-up lookup makes the normal conflict path useful to callers.
   */
  async createSnapshotReplicationJob(input: {
    workspaceId: string;
    principalId: string;
    targetId: string;
    snapshotName: string;
    scheduleId?: string;
    scheduledFor?: string;
  }): Promise<SnapshotReplicationJobCreation> {
    validateSnapshotReplicationScheduleInput({
      targetId: input.targetId,
      snapshotName: input.snapshotName,
      mode: "manual",
    });
    const parameters = {
      target_id: input.targetId,
      ...(input.scheduleId ? { schedule_id: input.scheduleId } : {}),
      ...(input.scheduledFor ? { scheduled_for: input.scheduledFor } : {}),
      ...(input.scheduleId ? { trigger: "schedule" } : { trigger: "manual" }),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = randomUUID();
      try {
        const result = await this.pool.query<SnapshotJobRow>(
          `INSERT INTO ce_snapshot_jobs(
             id, workspace_id, principal_id, operation, snapshot_name,
             parameters, status, progress
           )
           VALUES ($1, $2, $3, 'replicate', $4, $5::jsonb, 'queued', $6::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                     parameters, status, progress, result, error, attempts,
                     locked_at, lock_token, next_attempt_at, created_at,
                     started_at, completed_at`,
          [
            id,
            input.workspaceId,
            input.principalId,
            input.snapshotName,
            JSON.stringify(parameters),
            JSON.stringify({ phase: "queued" }),
          ],
        );
        if (result.rows[0]) {
          return { job: snapshotJobFromRow(result.rows[0]), created: true };
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      const active = await this.pool.query<SnapshotJobRow>(
        `SELECT id, workspace_id, principal_id, operation, snapshot_name,
                parameters, status, progress, result, error, attempts,
                locked_at, lock_token, next_attempt_at, created_at,
                started_at, completed_at
         FROM ce_snapshot_jobs
         WHERE workspace_id = $1 AND operation = 'replicate'
           AND snapshot_name = $2
           AND parameters->>'target_id' = $3
           AND status IN ('queued', 'running')
         ORDER BY created_at, id
         LIMIT 1`,
        [input.workspaceId, input.snapshotName, input.targetId],
      );
      if (active.rows[0]) {
        return { job: snapshotJobFromRow(active.rows[0]), created: false };
      }
    }
    throw new Error("Replication job disappeared while resolving a concurrent request");
  }

  async upsertSnapshotReplicationSchedule(input: {
    workspaceId: string;
    principalId: string;
    targetId: string;
    snapshotName: string;
    mode: SnapshotReplicationScheduleMode;
    intervalMs?: number | null;
    nightlyAt?: string | null;
    timezone?: string;
    enabled?: boolean;
  }): Promise<StoredSnapshotReplicationSchedule> {
    const normalized = validateSnapshotReplicationScheduleInput(input);
    const id = randomUUID();
    const result = await this.pool.query<SnapshotReplicationScheduleRow>(
      `WITH db_clock AS (SELECT clock_timestamp() AS now)
       INSERT INTO ce_snapshot_replication_schedules(
         id, workspace_id, target_id, snapshot_name, mode, interval_ms,
         nightly_at, timezone, enabled, next_scheduled_at, created_by
       )
       SELECT $1, $2, $3, $4, $5, $6::bigint, $7::time, $8, $9::boolean,
              CASE
                WHEN $9::boolean = FALSE OR $5 = 'manual' THEN NULL
                WHEN $5 = 'interval' THEN
                  db_clock.now + ($6::bigint * interval '1 millisecond')
                ELSE
                  (
                    (
                      (db_clock.now AT TIME ZONE $8)::date
                      + CASE
                          WHEN (db_clock.now AT TIME ZONE $8)::time < $7::time
                          THEN 0 ELSE 1
                        END
                    ) + $7::time
                  ) AT TIME ZONE $8
              END,
              $10
       FROM db_clock
       ON CONFLICT (workspace_id, target_id, snapshot_name)
       DO UPDATE SET
         mode = EXCLUDED.mode,
         interval_ms = EXCLUDED.interval_ms,
         nightly_at = EXCLUDED.nightly_at,
         timezone = EXCLUDED.timezone,
         enabled = EXCLUDED.enabled,
         next_scheduled_at = EXCLUDED.next_scheduled_at,
         updated_at = clock_timestamp()
       RETURNING id, workspace_id, target_id, snapshot_name, mode, interval_ms,
                 nightly_at, timezone, enabled, next_scheduled_at,
                 last_scheduled_at, last_job_id, created_by, created_at, updated_at`,
      [
        id,
        input.workspaceId,
        input.targetId,
        input.snapshotName,
        input.mode,
        normalized.intervalMs,
        normalized.nightlyAt,
        normalized.timezone,
        normalized.enabled,
        input.principalId,
      ],
    );
    return snapshotReplicationScheduleFromRow(result.rows[0]);
  }

  async listSnapshotReplicationSchedules(
    workspaceId: string,
  ): Promise<StoredSnapshotReplicationSchedule[]> {
    const result = await this.pool.query<SnapshotReplicationScheduleRow>(
      `SELECT id, workspace_id, target_id, snapshot_name, mode, interval_ms,
              nightly_at, timezone, enabled, next_scheduled_at,
              last_scheduled_at, last_job_id, created_by, created_at, updated_at
       FROM ce_snapshot_replication_schedules
       WHERE workspace_id = $1
       ORDER BY target_id, snapshot_name`,
      [workspaceId],
    );
    return result.rows.map(snapshotReplicationScheduleFromRow);
  }

  async getSnapshotReplicationSchedule(
    workspaceId: string,
    targetId: string,
    snapshotName: string,
  ): Promise<StoredSnapshotReplicationSchedule | null> {
    const result = await this.pool.query<SnapshotReplicationScheduleRow>(
      `SELECT id, workspace_id, target_id, snapshot_name, mode, interval_ms,
              nightly_at, timezone, enabled, next_scheduled_at,
              last_scheduled_at, last_job_id, created_by, created_at, updated_at
       FROM ce_snapshot_replication_schedules
       WHERE workspace_id = $1 AND target_id = $2 AND snapshot_name = $3`,
      [workspaceId, targetId, snapshotName],
    );
    return result.rows[0] ? snapshotReplicationScheduleFromRow(result.rows[0]) : null;
  }

  async setSnapshotReplicationScheduleEnabled(
    workspaceId: string,
    targetId: string,
    snapshotName: string,
    enabled: boolean,
  ): Promise<StoredSnapshotReplicationSchedule | null> {
    const result = await this.pool.query<SnapshotReplicationScheduleRow>(
      `WITH db_clock AS (SELECT clock_timestamp() AS now)
       UPDATE ce_snapshot_replication_schedules AS schedule
       SET enabled = $4::boolean,
           next_scheduled_at = CASE
             WHEN $4::boolean = FALSE OR schedule.mode = 'manual' THEN NULL
             WHEN schedule.mode = 'interval' THEN
               db_clock.now + (schedule.interval_ms * interval '1 millisecond')
             ELSE
               (
                 (
                   (db_clock.now AT TIME ZONE schedule.timezone)::date
                   + CASE
                       WHEN (db_clock.now AT TIME ZONE schedule.timezone)::time
                              < schedule.nightly_at
                       THEN 0 ELSE 1
                     END
                 ) + schedule.nightly_at
               ) AT TIME ZONE schedule.timezone
           END,
           updated_at = clock_timestamp()
       FROM db_clock
       WHERE schedule.workspace_id = $1 AND schedule.target_id = $2
         AND schedule.snapshot_name = $3
         AND (schedule.mode <> 'manual' OR $4::boolean = FALSE)
       RETURNING schedule.id, schedule.workspace_id, schedule.target_id,
                 schedule.snapshot_name, schedule.mode, schedule.interval_ms,
                 schedule.nightly_at, schedule.timezone, schedule.enabled,
                 schedule.next_scheduled_at, schedule.last_scheduled_at,
                 schedule.last_job_id, schedule.created_by, schedule.created_at,
                 schedule.updated_at`,
      [workspaceId, targetId, snapshotName, enabled],
    );
    return result.rows[0] ? snapshotReplicationScheduleFromRow(result.rows[0]) : null;
  }

  async deleteSnapshotReplicationSchedule(
    workspaceId: string,
    targetId: string,
    snapshotName: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ce_snapshot_replication_schedules
       WHERE workspace_id = $1 AND target_id = $2 AND snapshot_name = $3`,
      [workspaceId, targetId, snapshotName],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Claim due policies and create at most one active job per policy tuple. */
  async scheduleDueSnapshotReplicationJobs(
    targetIds: readonly string[],
    limit = 32,
  ): Promise<StoredSnapshotJob[]> {
    const ids = [...new Set(targetIds)].filter((id) =>
      SNAPSHOT_REPLICATION_TARGET_ID_RE.test(id),
    );
    if (!ids.length) return [];
    const safeLimit = Math.min(128, Math.max(1, Math.floor(limit)));
    const client = await this.pool.connect();
    const created: StoredSnapshotJob[] = [];
    try {
      await client.query("BEGIN");
      const due = await client.query<SnapshotReplicationScheduleRow & {
        database_now: string | Date;
      }>(
        `SELECT id, workspace_id, target_id, snapshot_name, mode, interval_ms,
                nightly_at, timezone, enabled, next_scheduled_at,
                last_scheduled_at, last_job_id, created_by, created_at, updated_at,
                clock_timestamp() AS database_now
         FROM ce_snapshot_replication_schedules
         WHERE enabled = TRUE AND next_scheduled_at <= clock_timestamp()
           AND target_id = ANY($1::text[])
         ORDER BY next_scheduled_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [ids, safeLimit],
      );
      for (const schedule of due.rows) {
        const nowText = iso(schedule.database_now);
        const dueText = iso(schedule.next_scheduled_at);
        if (!nowText || !dueText) continue;
        const now = new Date(nowText);
        const dueAt = new Date(dueText);
        let nextScheduledAt: Date;
        if (schedule.mode === "interval") {
          const intervalMs = Number(schedule.interval_ms);
          const periods = Math.max(
            1,
            Math.floor(Math.max(0, now.getTime() - dueAt.getTime()) / intervalMs) + 1,
          );
          nextScheduledAt = new Date(dueAt.getTime() + periods * intervalMs);
        } else {
          const next = await client.query<{ next_scheduled_at: string | Date }>(
            `SELECT (
               (
                 (($1::timestamptz AT TIME ZONE $3)::date
                   + CASE
                       WHEN ($1::timestamptz AT TIME ZONE $3)::time < $2::time
                       THEN 0 ELSE 1
                     END
                 ) + $2::time
               ) AT TIME ZONE $3
             ) AS next_scheduled_at`,
            [now, schedule.nightly_at, schedule.timezone],
          );
          const value = next.rows[0]?.next_scheduled_at;
          if (!value) continue;
          nextScheduledAt = new Date(iso(value)!);
        }
        const parameters = {
          target_id: schedule.target_id,
          schedule_id: schedule.id,
          scheduled_for: dueAt.toISOString(),
          trigger: "schedule",
        };
        let jobRow: SnapshotJobRow | undefined;
        let createdJobId: string | null = null;
        for (let attempt = 0; attempt < 2 && !jobRow; attempt += 1) {
          const jobId = randomUUID();
          const inserted = await client.query<SnapshotJobRow>(
            `INSERT INTO ce_snapshot_jobs(
               id, workspace_id, principal_id, operation, snapshot_name,
               parameters, status, progress
             ) VALUES ($1, $2, $3, 'replicate', $4, $5::jsonb, 'queued', $6::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                       parameters, status, progress, result, error, attempts,
                       locked_at, lock_token, next_attempt_at, created_at,
                       started_at, completed_at`,
            [
              jobId,
              schedule.workspace_id,
              schedule.created_by,
              schedule.snapshot_name,
              JSON.stringify(parameters),
              JSON.stringify({ phase: "queued", trigger: "schedule" }),
            ],
          );
          jobRow = inserted.rows[0];
          if (jobRow) {
            createdJobId = jobId;
            break;
          }
          const active = await client.query<SnapshotJobRow>(
            `SELECT id, workspace_id, principal_id, operation, snapshot_name,
                    parameters, status, progress, result, error, attempts,
                    locked_at, lock_token, next_attempt_at, created_at,
                    started_at, completed_at
             FROM ce_snapshot_jobs
             WHERE workspace_id = $1 AND operation = 'replicate'
               AND snapshot_name = $2
               AND parameters->>'target_id' = $3
               AND status IN ('queued', 'running')
             ORDER BY created_at, id
             LIMIT 1`,
            [schedule.workspace_id, schedule.snapshot_name, schedule.target_id],
          );
          jobRow = active.rows[0];
        }
        if (!jobRow) {
          throw new Error(
            "Active replication disappeared while materializing a schedule",
          );
        }
        await client.query(
          `UPDATE ce_snapshot_replication_schedules
           SET last_scheduled_at = clock_timestamp(),
               last_job_id = $2,
               next_scheduled_at = $3::timestamptz,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [schedule.id, jobRow.id, nextScheduledAt.toISOString()],
        );
        if (jobRow.id === createdJobId) created.push(snapshotJobFromRow(jobRow));
      }
      await client.query("COMMIT");
      return created;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getSnapshotReplicationPublication(
    jobId: string,
    attemptToken: string,
  ): Promise<StoredSnapshotReplicationPublication | null> {
    const result = await this.pool.query<SnapshotReplicationPublicationRow>(
      `SELECT publication.job_id, publication.publication_sequence,
              publication.source_manifest,
              publication.source_manifest_sha256, publication.pinned_at
       FROM ce_snapshot_replication_publications AS publication
       JOIN ce_snapshot_jobs AS job ON job.id = publication.job_id
       WHERE publication.job_id = $1
         AND job.operation = 'replicate'
         AND job.status = 'running'
         AND job.lock_token = $2`,
      [jobId, attemptToken],
    );
    return result.rows[0]
      ? snapshotReplicationPublicationFromRow(result.rows[0])
      : null;
  }

  async pinSnapshotReplicationPublication(
    jobId: string,
    attemptToken: string,
    input: {
      sourceManifest: Record<string, unknown>;
      sourceManifestSha256: string;
    },
  ): Promise<StoredSnapshotReplicationPublication | null> {
    return this.pinSnapshotReplicationPublicationWithLoader(
      jobId,
      attemptToken,
      async () => input,
    );
  }

  async pinSnapshotReplicationPublicationWithLoader(
    jobId: string,
    attemptToken: string,
    loadSource: () => Promise<{
      sourceManifest: Record<string, unknown>;
      sourceManifestSha256: string;
    }>,
  ): Promise<StoredSnapshotReplicationPublication | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM ce_snapshot_jobs WHERE id = $1`,
        [jobId],
      );
      if (!owner.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`contextengine:snapshot-artifacts:${owner.rows[0].workspace_id}`],
      );
      const existing = await client.query<SnapshotReplicationPublicationRow>(
        `SELECT publication.job_id, publication.publication_sequence,
                publication.source_manifest,
                publication.source_manifest_sha256, publication.pinned_at
         FROM ce_snapshot_replication_publications AS publication
         JOIN ce_snapshot_jobs AS job ON job.id = publication.job_id
         WHERE publication.job_id = $1
           AND job.operation = 'replicate'
           AND job.status = 'running'
           AND job.lock_token = $2`,
        [jobId, attemptToken],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return snapshotReplicationPublicationFromRow(existing.rows[0]);
      }
      const input = await loadSource();
      let sourceManifestJson: string;
      try {
        const serialized = JSON.stringify(input.sourceManifest);
        if (typeof serialized !== "string") throw new Error("not an object");
        sourceManifestJson = serialized;
      } catch {
        throw new Error(
          "Snapshot replication publication manifest is not JSON serializable",
        );
      }
      if (
        !input.sourceManifest ||
        Array.isArray(input.sourceManifest) ||
        Buffer.byteLength(sourceManifestJson) > 256 * 1024 ||
        !/^[0-9a-f]{64}$/.test(input.sourceManifestSha256)
      ) {
        throw new Error("Snapshot replication publication is invalid");
      }
      const active = await client.query(
        `SELECT id
         FROM ce_snapshot_jobs
         WHERE id = $1 AND operation = 'replicate'
           AND status = 'running' AND lock_token = $2
         FOR UPDATE`,
        [jobId, attemptToken],
      );
      if (!active.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      let publication = await client.query<SnapshotReplicationPublicationRow>(
        `SELECT job_id, publication_sequence, source_manifest,
                source_manifest_sha256, pinned_at
         FROM ce_snapshot_replication_publications
         WHERE job_id = $1`,
        [jobId],
      );
      if (!publication.rows[0]) {
        publication = await client.query<SnapshotReplicationPublicationRow>(
          `INSERT INTO ce_snapshot_replication_publications(
             job_id, source_manifest, source_manifest_sha256
           ) VALUES ($1, $2::jsonb, $3)
           RETURNING job_id, publication_sequence, source_manifest,
                     source_manifest_sha256, pinned_at`,
          [
            jobId,
            sourceManifestJson,
            input.sourceManifestSha256,
          ],
        );
      }
      await client.query("COMMIT");
      return snapshotReplicationPublicationFromRow(publication.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async withSnapshotReplicationArtifactGuard<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`contextengine:snapshot-artifacts:${workspaceId}`],
      );
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async isSnapshotJobAttemptActive(
    jobId: string,
    attemptToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ce_snapshot_jobs
         WHERE id = $1 AND status = 'running' AND lock_token = $2
       ) AS active`,
      [jobId, attemptToken],
    );
    return result.rows[0]?.active ?? false;
  }

  async isSnapshotReplicationPublicationCurrent(
    jobId: string,
    attemptToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query<{ current: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM ce_snapshot_replication_publications AS publication
         JOIN ce_snapshot_jobs AS job ON job.id = publication.job_id
         WHERE publication.job_id = $1
           AND job.operation = 'replicate'
           AND job.status = 'running'
           AND job.lock_token = $2
           AND NOT EXISTS (
             SELECT 1
             FROM ce_snapshot_replication_publications AS newer_publication
             JOIN ce_snapshot_jobs AS newer_job
               ON newer_job.id = newer_publication.job_id
             WHERE newer_publication.publication_sequence
                     > publication.publication_sequence
               AND newer_job.workspace_id = job.workspace_id
               AND newer_job.snapshot_name = job.snapshot_name
               AND newer_job.parameters->>'target_id'
                     = job.parameters->>'target_id'
           )
       ) AS current`,
      [jobId, attemptToken],
    );
    return result.rows[0]?.current ?? false;
  }

  /** Serialize the short external manifest CAS with lease/terminal transitions. */
  async withSnapshotReplicationPublicationGuard<T>(
    jobId: string,
    attemptToken: string,
    operation: () => Promise<T>,
  ): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT publication.job_id
         FROM ce_snapshot_replication_publications AS publication
         JOIN ce_snapshot_jobs AS job ON job.id = publication.job_id
         WHERE publication.job_id = $1
           AND job.operation = 'replicate'
           AND job.status = 'running'
           AND job.lock_token = $2
           AND NOT EXISTS (
             SELECT 1
             FROM ce_snapshot_replication_publications AS newer_publication
             JOIN ce_snapshot_jobs AS newer_job
               ON newer_job.id = newer_publication.job_id
             WHERE newer_publication.publication_sequence
                     > publication.publication_sequence
               AND newer_job.workspace_id = job.workspace_id
               AND newer_job.snapshot_name = job.snapshot_name
               AND newer_job.parameters->>'target_id'
                     = job.parameters->>'target_id'
           )
         FOR UPDATE OF job`,
        [jobId, attemptToken],
      );
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listRetainedSnapshotReplicationArtifactKeys(
    workspaceId: string,
  ): Promise<string[]> {
    const result = await this.pool.query<{ artifact_key: string }>(
      `SELECT DISTINCT publication.source_manifest->'artifact'->>'key' AS artifact_key
       FROM ce_snapshot_replication_publications AS publication
       JOIN ce_snapshot_jobs AS job ON job.id = publication.job_id
       WHERE job.workspace_id = $1
         AND job.operation = 'replicate'
         AND (
           job.status IN ('queued', 'running')
           OR (
             job.status = 'failed'
             AND job.completed_at
                   >= clock_timestamp() - interval '7 days'
           )
         )
         AND jsonb_typeof(publication.source_manifest->'artifact') = 'object'
         AND jsonb_typeof(publication.source_manifest->'artifact'->'key') = 'string'`,
      [workspaceId],
    );
    return result.rows.map((row) => row.artifact_key);
  }

  async getSnapshotJob(jobId: string): Promise<StoredSnapshotJob | null> {
    const result = await this.pool.query<SnapshotJobRow>(
      `SELECT id, workspace_id, principal_id, operation, snapshot_name,
              parameters, status, progress, result, error, attempts,
              locked_at, lock_token, next_attempt_at, created_at,
              started_at, completed_at
       FROM ce_snapshot_jobs WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
  }

  async listSnapshotJobAttempts(
    jobId: string,
    options: { limit?: number; before?: number | string } = {},
  ): Promise<StoredSnapshotJobAttempt[]> {
    const limit = boundedHistoryLimit(options.limit);
    const before =
      options.before === undefined
        ? null
        : parseSnapshotHistoryCursor(String(options.before), "before");
    const result = await this.pool.query<SnapshotJobAttemptRow>(
      `SELECT job_id, attempt, budget_attempt, status, progress, result, error,
              backfilled, started_at, last_heartbeat_at, completed_at
       FROM ce_snapshot_job_attempts
       WHERE job_id = $1
         AND ($2::bigint IS NULL OR attempt < $2::bigint)
       ORDER BY attempt DESC
       LIMIT $3`,
      [jobId, before, limit],
    );
    return result.rows.map(snapshotJobAttemptFromRow);
  }

  async listSnapshotJobEvents(
    jobId: string,
    afterEventId: number | string = "0",
    limit = 100,
  ): Promise<StoredSnapshotJobEvent[]> {
    const cursor = parseSnapshotHistoryCursor(String(afterEventId), "after");
    const result = await this.pool.query<SnapshotJobEventRow>(
      `SELECT event_id, job_id, attempt, kind, status, attempts, details,
              progress, result, error, next_attempt_at, started_at,
              completed_at, backfilled, created_at
       FROM ce_snapshot_job_events
       WHERE job_id = $1 AND event_id > $2::bigint
       ORDER BY event_id ASC
       LIMIT $3`,
      [jobId, cursor, boundedHistoryLimit(limit)],
    );
    return result.rows.map(snapshotJobEventFromRow);
  }

  async getLatestSnapshotJobEvent(
    jobId: string,
  ): Promise<StoredSnapshotJobEvent | null> {
    const result = await this.pool.query<SnapshotJobEventRow>(
      `SELECT event_id, job_id, attempt, kind, status, attempts, details,
              progress, result, error, next_attempt_at, started_at,
              completed_at, backfilled, created_at
       FROM ce_snapshot_job_events
       WHERE job_id = $1
       ORDER BY event_id DESC
       LIMIT 1`,
      [jobId],
    );
    return result.rows[0] ? snapshotJobEventFromRow(result.rows[0]) : null;
  }

  async listLatestSnapshotReplicationJobs(
    workspaceId: string,
  ): Promise<StoredSnapshotJob[]> {
    const result = await this.pool.query<SnapshotJobRow>(
      `SELECT DISTINCT ON (parameters->>'target_id', snapshot_name)
              id, workspace_id, principal_id, operation, snapshot_name,
              parameters, status, progress, result, error, attempts,
              locked_at, lock_token, next_attempt_at, created_at,
              started_at, completed_at
       FROM ce_snapshot_jobs
       WHERE workspace_id = $1 AND operation = 'replicate'
       ORDER BY parameters->>'target_id', snapshot_name, created_at DESC, id DESC`,
      [workspaceId],
    );
    return result.rows.map(snapshotJobFromRow);
  }

  async snapshotReplicationMetrics(
    workspaceId: string,
  ): Promise<SnapshotReplicationMetrics[]> {
    const result = await this.pool.query<{
      target_id: string;
      queued: string | number;
      running: string | number;
      succeeded: string | number;
      failed: string | number;
      retries: string | number;
      average_duration_ms: string | number | null;
      total_artifact_bytes: string | number | null;
      average_artifact_bytes: string | number | null;
      largest_artifact_bytes: string | number | null;
      average_throughput_bytes_per_second: string | number | null;
      consecutive_failures: string | number;
      replication_lag_ms: string | number | null;
      last_succeeded_at: string | Date | null;
      last_failed_at: string | Date | null;
    }>(
      `WITH replication_jobs AS (
         SELECT jobs.*,
                jobs.parameters->>'target_id' AS target_id,
                CASE
                  WHEN jsonb_typeof(jobs.result->'artifact_bytes') = 'number'
                  THEN (jobs.result->>'artifact_bytes')::numeric
                  ELSE NULL
                END AS artifact_bytes,
                CASE
                  WHEN jsonb_typeof(jobs.result->'transfer_duration_ms') = 'number'
                  THEN (jobs.result->>'transfer_duration_ms')::numeric
                  ELSE NULL
                END AS transfer_duration_ms,
                COALESCE(jobs.result->>'publication_status', 'published')
                  <> 'superseded' AS effective_publication
         FROM ce_snapshot_jobs AS jobs
         WHERE jobs.workspace_id = $1 AND jobs.operation = 'replicate'
       ), latest_success AS (
         SELECT target_id, MAX(completed_at) AS completed_at
         FROM replication_jobs
         WHERE status = 'succeeded' AND effective_publication
         GROUP BY target_id
       )
       SELECT jobs.target_id,
              COUNT(*) FILTER (WHERE jobs.status = 'queued') AS queued,
              COUNT(*) FILTER (WHERE jobs.status = 'running') AS running,
              COUNT(*) FILTER (
                WHERE jobs.status = 'succeeded' AND jobs.effective_publication
              ) AS succeeded,
              COUNT(*) FILTER (
                WHERE jobs.status = 'failed'
                  AND COALESCE(jobs.progress->>'phase', '') <> 'superseded'
              ) AS failed,
              COALESCE(SUM(GREATEST(jobs.attempts - 1, 0)), 0) AS retries,
              AVG(EXTRACT(EPOCH FROM (jobs.completed_at - jobs.started_at)) * 1000)
                FILTER (
                  WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                ) AS average_duration_ms,
              COALESCE(SUM(jobs.artifact_bytes)
                FILTER (
                  WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                ), 0) AS total_artifact_bytes,
              AVG(jobs.artifact_bytes)
                FILTER (
                  WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                ) AS average_artifact_bytes,
              MAX(jobs.artifact_bytes)
                FILTER (
                  WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                ) AS largest_artifact_bytes,
              CASE
                WHEN COALESCE(SUM(jobs.transfer_duration_ms)
                  FILTER (
                    WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                  ), 0) > 0
                THEN COALESCE(SUM(jobs.artifact_bytes)
                  FILTER (
                    WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                  ), 0) * 1000
                  / SUM(jobs.transfer_duration_ms)
                    FILTER (
                      WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                    )
                ELSE NULL
              END AS average_throughput_bytes_per_second,
              COUNT(*) FILTER (
                WHERE jobs.status = 'failed'
                  AND COALESCE(jobs.progress->>'phase', '') <> 'superseded'
                  AND jobs.completed_at >= COALESCE(
                    latest_success.completed_at,
                    '-infinity'::timestamptz
                  )
              ) AS consecutive_failures,
              MAX(jobs.completed_at)
                FILTER (
                  WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                ) AS last_succeeded_at,
              MAX(jobs.completed_at)
                FILTER (
                  WHERE jobs.status = 'failed'
                    AND COALESCE(jobs.progress->>'phase', '') <> 'superseded'
                ) AS last_failed_at,
              EXTRACT(EPOCH FROM (
                clock_timestamp()
                - MAX(jobs.completed_at) FILTER (
                    WHERE jobs.status = 'succeeded' AND jobs.effective_publication
                  )
              )) * 1000 AS replication_lag_ms
       FROM replication_jobs AS jobs
       LEFT JOIN latest_success ON latest_success.target_id = jobs.target_id
       GROUP BY jobs.target_id, latest_success.completed_at
       ORDER BY jobs.target_id`,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      targetId: row.target_id,
      queued: Number(row.queued),
      running: Number(row.running),
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
      retries: Number(row.retries),
      averageDurationMs:
        row.average_duration_ms === null ? null : Number(row.average_duration_ms),
      totalArtifactBytes: Number(row.total_artifact_bytes ?? 0),
      averageArtifactBytes:
        row.average_artifact_bytes === null
          ? null
          : Number(row.average_artifact_bytes),
      largestArtifactBytes:
        row.largest_artifact_bytes === null
          ? null
          : Number(row.largest_artifact_bytes),
      averageThroughputBytesPerSecond:
        row.average_throughput_bytes_per_second === null
          ? null
          : Number(row.average_throughput_bytes_per_second),
      consecutiveFailures: Number(row.consecutive_failures),
      replicationLagMs:
        row.replication_lag_ms === null ? null : Number(row.replication_lag_ms),
      lastSucceededAt: iso(row.last_succeeded_at),
      lastFailedAt: iso(row.last_failed_at),
    }));
  }

  async listQueuedSnapshotJobs(leaseMs = 5 * 60_000): Promise<StoredSnapshotJob[]> {
    const result = await this.pool.query<SnapshotJobRow>(
      `SELECT id, workspace_id, principal_id, operation, snapshot_name,
              parameters, status, progress, result, error, attempts,
              locked_at, lock_token, next_attempt_at, created_at,
              started_at, completed_at
       FROM ce_snapshot_jobs
       WHERE (status = 'queued' AND next_attempt_at <= clock_timestamp())
          OR (status = 'running' AND locked_at < clock_timestamp() - ($1::bigint * interval '1 millisecond'))
       ORDER BY created_at, id`,
      [leaseMs],
    );
    return result.rows.map(snapshotJobFromRow);
  }

  async claimSnapshotJob(
    jobId: string,
    leaseMs = 60_000,
  ): Promise<ClaimedSnapshotJob | null> {
    const client = await this.pool.connect();
    const token = randomUUID();
    try {
      await client.query("BEGIN");
      const selected = await client.query<SnapshotJobRow>(
        `SELECT id, workspace_id, principal_id, operation, snapshot_name,
                parameters, status, progress, result, error, attempts,
                locked_at, lock_token, next_attempt_at, created_at,
                started_at, completed_at
         FROM ce_snapshot_jobs
         WHERE id = $1
           AND ((status = 'queued' AND next_attempt_at <= clock_timestamp())
             OR (status = 'running' AND locked_at < clock_timestamp() - ($2::bigint * interval '1 millisecond')))
         FOR UPDATE SKIP LOCKED`,
        [jobId, leaseMs],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const updated = await client.query<SnapshotJobRow>(
        `UPDATE ce_snapshot_jobs
         SET status = 'running', attempts = attempts + 1, locked_at = clock_timestamp(),
             lock_token = $2, started_at = COALESCE(started_at, clock_timestamp()),
             progress = $3::jsonb, error = NULL, completed_at = NULL
         WHERE id = $1
         RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                   parameters, status, progress, result, error, attempts,
                   locked_at, lock_token, next_attempt_at, created_at,
                   started_at, completed_at`,
        [jobId, token, JSON.stringify({ phase: "starting" })],
      );
      await client.query("COMMIT");
      const claimed = updated.rows[0];
      if (!claimed) return null;
      return { ...snapshotJobFromRow(claimed), attemptToken: token };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSnapshotJobProgress(
    jobId: string,
    attemptToken: string,
    progress: Record<string, unknown>,
  ): Promise<StoredSnapshotJob | null> {
    const result = await this.pool.query<SnapshotJobRow>(
      `UPDATE ce_snapshot_jobs SET progress = $3::jsonb, locked_at = clock_timestamp()
       WHERE id = $1 AND lock_token = $2 AND status = 'running'
       RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                 parameters, status, progress, result, error, attempts,
                 locked_at, lock_token, next_attempt_at, created_at,
                 started_at, completed_at`,
      [jobId, attemptToken, JSON.stringify(progress)],
    );
    return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
  }

  async renewSnapshotJobLease(
    jobId: string,
    attemptToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ce_snapshot_jobs SET locked_at = clock_timestamp()
       WHERE id = $1 AND lock_token = $2 AND status = 'running'`,
      [jobId, attemptToken],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async completeSnapshotJob(
    jobId: string,
    attemptToken: string,
    resultPayload: Record<string, unknown>,
  ): Promise<StoredSnapshotJob | null> {
    const result = await this.pool.query<SnapshotJobRow>(
      `UPDATE ce_snapshot_jobs
       SET status = 'succeeded', result = $3::jsonb, progress = $4::jsonb,
           completed_at = clock_timestamp(), locked_at = NULL, lock_token = NULL
       WHERE id = $1 AND lock_token = $2 AND status = 'running'
       RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                 parameters, status, progress, result, error, attempts,
                 locked_at, lock_token, next_attempt_at, created_at,
                 started_at, completed_at`,
      [jobId, attemptToken, JSON.stringify(resultPayload), JSON.stringify({ phase: "done" })],
    );
    return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
  }

  async failSnapshotJob(
    jobId: string,
    attemptToken: string,
    message: string,
  ): Promise<StoredSnapshotJob | null> {
    const result = await this.pool.query<SnapshotJobRow>(
      `UPDATE ce_snapshot_jobs
       SET status = 'failed', error = $3, completed_at = clock_timestamp(),
           locked_at = NULL, lock_token = NULL, progress = $4::jsonb
       WHERE id = $1 AND lock_token = $2 AND status = 'running'
       RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                 parameters, status, progress, result, error, attempts,
                 locked_at, lock_token, next_attempt_at, created_at,
                 started_at, completed_at`,
      [jobId, attemptToken, message.slice(0, 4000), JSON.stringify({ phase: "failed" })],
    );
    return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
  }

  async scheduleSnapshotJobRetry(
    jobId: string,
    attemptToken: string,
    message: string,
    delayMs: number,
  ): Promise<StoredSnapshotJob | null> {
    const safeDelayMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(delayMs)));
    const result = await this.pool.query<SnapshotJobRow>(
      `UPDATE ce_snapshot_jobs
       SET status = 'queued', error = $3,
           next_attempt_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
           locked_at = NULL, lock_token = NULL, completed_at = NULL,
           progress = $5::jsonb
       WHERE id = $1 AND lock_token = $2 AND status = 'running'
       RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                 parameters, status, progress, result, error, attempts,
                 locked_at, lock_token, next_attempt_at, created_at,
                 started_at, completed_at`,
      [
        jobId,
        attemptToken,
        message.slice(0, 4000),
        safeDelayMs,
        JSON.stringify({ phase: "retry_wait", retry_in_ms: safeDelayMs }),
      ],
    );
    return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
  }

  async retrySnapshotJob(jobId: string): Promise<StoredSnapshotJob | null> {
    try {
      const result = await this.pool.query<SnapshotJobRow>(
        `UPDATE ce_snapshot_jobs
         SET status = 'queued', next_attempt_at = clock_timestamp(),
             attempts = CASE WHEN operation = 'replicate' THEN 0 ELSE attempts END,
             error = NULL, completed_at = NULL, locked_at = NULL,
             lock_token = NULL, progress = $2::jsonb
         WHERE id = $1 AND status = 'failed'
         RETURNING id, workspace_id, principal_id, operation, snapshot_name,
                   parameters, status, progress, result, error, attempts,
                   locked_at, lock_token, next_attempt_at, created_at,
                   started_at, completed_at`,
        [jobId, JSON.stringify({ phase: "queued", retry: true })],
      );
      return result.rows[0] ? snapshotJobFromRow(result.rows[0]) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
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
