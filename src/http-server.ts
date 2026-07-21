#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z, ZodError } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { loadDotEnv, resolveDatabaseUrl, resolveEngineConfig } from "./config.js";
import { observabilityDashboardHtml } from "./dashboard.js";
import { ContextEngine } from "./engine.js";
import {
  GitHubConnectorClient,
} from "./connectors/github.js";
import { GitHubSourceConnector } from "./connectors/github-plugin.js";
import {
  SourceConnectorError,
  SourceConnectorRegistry,
  type SourceConnectorPlugin,
} from "./connectors/types.js";
import { createRetrievalMcpServer } from "./mcp-tools.js";
import {
  ConnectorSyncConflictError,
  ConnectorSyncCoordinator,
} from "./server/connector-sync.js";
import {
  createHttpAuthenticator,
  type HttpApiKeyConfig,
  type HttpBearerAuthenticator,
  type HttpPrincipal,
} from "./server/http-auth.js";
import { IndexJobRunner } from "./server/index-job-runner.js";
import {
  testEmbeddingConnection,
  testRerankerConnection,
} from "./server/model-connection-test.js";
import { RequestTelemetry } from "./server/request-telemetry.js";
import {
  MemoryMcpSessionStore,
  PostgresMcpSessionStore,
  type McpSessionStore,
  type McpSessionStoreKind,
} from "./server/mcp-session-store.js";
import {
  RuntimeModelConfiguration,
  type EmbeddingConfigurationUpdate,
  type ModelConfigurationUpdate,
  type RerankerConfigurationUpdate,
} from "./server/runtime-configuration.js";
import {
  MissingBlobError,
  RevisionConflictError,
  SyncPlanConflictError,
  SyncPlanExpiredError,
  type StoredIndexJob,
  type StoredConnectorSource,
  type StoredWorkspace,
  type WorkspacePermission,
  WorkspaceNotFoundError,
  WorkspaceRepository,
  workspacePermissionAllows,
  type SyncChange,
} from "./server/workspace-repository.js";
import type { SearchHit } from "./types.js";
import type { IndexGenerationStatus } from "./store/postgres-store.js";
import { sha256 } from "./util/hash.js";

const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
const DEFAULT_MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MCP_MAX_SESSIONS = 128;
const MAX_BATCH_BLOBS = 16;

export interface HttpServerOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  apiKeys?: HttpApiKeyConfig[];
  databaseUrl?: string;
  allowUnauthenticated?: boolean;
  allowLocalWorkspaces?: boolean;
  localRootAllowlist?: string[];
  maxBlobBytes?: number;
  mcpSessionIdleTtlMs?: number;
  mcpMaxSessions?: number;
  mcpSessionStore?: McpSessionStoreKind;
  disableEmbeddings?: boolean;
  githubToken?: string;
  githubApiBaseUrl?: string;
  githubTimeoutMs?: number;
  /** Additional read-only source providers available under /sources/{provider}. */
  connectorPlugins?: readonly SourceConnectorPlugin[];
  /** Exact browser origins allowed to call the HTTP API, or ["*"]. */
  corsOrigins?: readonly string[];
}

export interface HttpServerHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const hashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected SHA-256 hex");
const positiveInteger = z.number().int().min(1);
const nonNegativeInteger = z.number().int().min(0);
const optionalHttpUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      // Zod can continue refinements after a preceding `.url()` issue.
      return false;
    }
  }, "Model base URL must use http:// or https://")
  .optional();
const embeddingConfigurationSchema = z.object({
  enabled: z.boolean(),
  base_url: optionalHttpUrl,
  model: z.string().trim().min(1).max(300).optional(),
  dimensions: z.number().int().min(1).max(65_536).nullable().optional(),
  authentication: z.enum(["bearer", "none"]),
  api_key: z.string().max(4096).optional(),
  batch_size: z.number().int().min(1).max(1024),
  max_input_chars: z.number().int().min(100).max(1_000_000),
  input_type: z.boolean(),
});
const rerankerConfigurationSchema = z.object({
  enabled: z.boolean(),
  base_url: optionalHttpUrl,
  model: z.string().trim().min(1).max(300).optional(),
  authentication: z.enum(["bearer", "none"]),
  api_key: z.string().max(4096).optional(),
  top_n: z.number().int().min(2).max(64),
  weight: z.number().min(0.05).max(0.85),
  max_document_chars: z.number().int().min(200).max(1_000_000),
  instruction: z.string().max(4000).nullable().optional(),
});
const modelConfigurationSchema = z
  .object({
    embedding: embeddingConfigurationSchema.optional(),
    reranker: rerankerConfigurationSchema.optional(),
  })
  .refine((value) => value.embedding || value.reranker, {
    message: "At least one model configuration is required",
  });
const modelConnectionTestSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("embedding"),
    embedding: embeddingConfigurationSchema,
  }),
  z.object({
    target: z.literal("reranker"),
    reranker: rerankerConfigurationSchema,
  }),
]);

function embeddingConfigurationUpdate(
  input: z.infer<typeof embeddingConfigurationSchema>,
): EmbeddingConfigurationUpdate {
  return {
    enabled: input.enabled,
    baseUrl: input.base_url,
    model: input.model,
    dimensions: input.dimensions,
    authentication: input.authentication,
    apiKey: input.api_key,
    batchSize: input.batch_size,
    maxInputChars: input.max_input_chars,
    inputType: input.input_type,
  };
}

function rerankerConfigurationUpdate(
  input: z.infer<typeof rerankerConfigurationSchema>,
): RerankerConfigurationUpdate {
  return {
    enabled: input.enabled,
    baseUrl: input.base_url,
    model: input.model,
    authentication: input.authentication,
    apiKey: input.api_key,
    topN: input.top_n,
    weight: input.weight,
    maxDocumentChars: input.max_document_chars,
    instruction: input.instruction,
  };
}

const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    source_mode: z.enum(["blob", "local"]).default("blob"),
    local_root: z.string().min(1).max(4096).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source_mode === "local" && !value.local_root) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["local_root"],
        message: "local_root is required for a local workspace",
      });
    }
    if (value.source_mode === "blob" && value.local_root) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["local_root"],
        message: "local_root is only valid for a local workspace",
      });
    }
  });

const syncChangeSchema = z
  .object({
    op: z.enum(["upsert", "delete", "rename"]),
    path: z.string().min(1).max(4096),
    old_path: z.string().min(1).max(4096).optional(),
    blob_hash: hashSchema.optional(),
    language: z.string().trim().min(1).max(80).optional(),
    mtime_ms: nonNegativeInteger.optional(),
    size: nonNegativeInteger.optional(),
    root_alias: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.op === "upsert" && !value.blob_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blob_hash"],
        message: "blob_hash is required for an upsert",
      });
    }
    if (value.op === "rename" && !value.old_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["old_path"],
        message: "old_path is required for a rename",
      });
    }
  });

const syncPlanSchema = z.object({
  base_revision: nonNegativeInteger,
  changes: z.array(syncChangeSchema).min(1).max(20_000),
});

const syncCommitSchema = z.object({
  sync_id: z.string().uuid(),
  auto_index: z.boolean().default(true),
});

const batchBlobSchema = z.object({
  blobs: z
    .array(
      z.object({
        sha256: hashSchema,
        content_base64: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_BATCH_BLOBS),
});

const httpApiKeysSchema = z.array(
  z.object({
    principal_id: z.string().trim().min(1).max(200),
    token: z.string().min(1).max(4096),
    role: z.enum(["user", "operator"]).optional(),
    admin: z.boolean().optional(),
  }),
);
const workspacePermissionSchema = z.object({
  permission: z.enum(["reader", "writer", "owner"]),
});
function readBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveOption(value: number, name: string): number {
  const normalized = Math.floor(value);
  if (!Number.isFinite(value) || value <= 0 || normalized < 1) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return normalized;
}

function mcpSessionStoreFromEnv(value: string | undefined): McpSessionStoreKind {
  const normalized = value?.trim().toLowerCase() || "postgres";
  if (normalized === "postgres" || normalized === "memory") return normalized;
  throw new Error("CONTEXTENGINE_MCP_SESSION_STORE must be postgres or memory");
}

function normalizeCorsOrigins(values: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (value === "*") {
      origins.add(value);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid CORS origin: ${value}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== value
    ) {
      throw new Error(`CORS origin must be an exact HTTP(S) origin: ${value}`);
    }
    origins.add(parsed.origin);
  }
  if (origins.has("*") && origins.size > 1) {
    throw new Error("CORS wildcard cannot be combined with explicit origins");
  }
  return [...origins];
}

function apiKeysFromEnv(value: string | undefined): HttpApiKeyConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CONTEXTENGINE_HTTP_API_KEYS must be valid JSON");
  }
  const entries = httpApiKeysSchema.parse(parsed);
  return entries.map((entry) => ({
    principalId: entry.principal_id,
    token: entry.token,
    role: entry.role,
    admin: entry.admin,
  }));
}

function normalizedRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new HttpError(400, "path must be a non-empty relative path");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "path must not contain empty, . or .. segments");
  }
  return normalized;
}

function toSyncChange(input: z.infer<typeof syncChangeSchema>): SyncChange {
  return {
    op: input.op,
    path: normalizedRelativePath(input.path),
    oldPath: input.old_path ? normalizedRelativePath(input.old_path) : undefined,
    blobHash: input.blob_hash?.toLowerCase(),
    language: input.language,
    mtimeMs: input.mtime_ms,
    size: input.size,
    rootAlias: input.root_alias,
  };
}

function workspacePayload(workspace: StoredWorkspace): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    source_mode: workspace.sourceMode,
    local_root: workspace.localRoot,
    revision: workspace.revision,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  };
}

function jobPayload(job: StoredIndexJob): Record<string, unknown> {
  return {
    id: job.id,
    workspace_id: job.workspaceId,
    revision: job.revision,
    mode: job.mode,
    changed_paths: job.changedPaths,
    deleted_paths: job.deletedPaths,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
  };
}

function connectorSourcePayload(source: StoredConnectorSource): Record<string, unknown> {
  return {
    id: source.id,
    workspace_id: source.workspaceId,
    provider: source.provider,
    external_id: source.externalId,
    config: source.config,
    cursor: source.cursor,
    cursor_version: source.cursorVersion,
    upstream_revision: source.upstreamRevision,
    status: source.status,
    last_error: source.lastError,
    last_synced_at: source.lastSyncedAt,
    created_by: source.createdBy,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
  };
}

function hitPayload(hit: SearchHit): Record<string, unknown> {
  return {
    path: hit.chunk.path,
    start_line: hit.chunk.startLine,
    end_line: hit.chunk.endLine,
    symbol: hit.chunk.symbol ?? null,
    language: hit.chunk.language,
    content: hit.chunk.content,
    preview: hit.preview,
    score: Number(hit.score.toFixed(6)),
    source: hit.source,
    intent: hit.intent ?? null,
    channels: hit.channels ?? null,
    degraded_channels: hit.degradedChannels ?? [],
  };
}

function generationPayload(status: IndexGenerationStatus): Record<string, unknown> {
  return {
    generation_id: status.generationId,
    source_revision: status.sourceRevision,
    indexed_revision: status.indexedRevision,
    pending_revision: status.pendingRevision,
    status: status.status,
    updated_at: status.updatedAt,
  };
}

function sliceFile(
  sourcePath: string,
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): Record<string, unknown> {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  return {
    path: sourcePath,
    content: lines.slice(start - 1, end).join("\n"),
    start_line: start,
    end_line: end,
  };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function mcpError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

function html(response: ServerResponse, payload: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  );
  response.end(payload);
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader("location", location);
  response.setHeader("cache-control", "no-store");
  response.end();
}

function queryLimit(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(400, `Expected an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function errorPayload(error: unknown): {
  status: number;
  payload: Record<string, unknown>;
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      payload: {
        error: {
          code: error.name,
          message: error.message,
          details: error.details ?? null,
        },
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      payload: {
        error: {
          code: "validation_error",
          message: "Request validation failed",
          details: error.issues,
        },
      },
    };
  }
  if (error instanceof WorkspaceNotFoundError) {
    return {
      status: 404,
      payload: { error: { code: "workspace_not_found", message: error.message } },
    };
  }
  if (error instanceof RevisionConflictError) {
    return {
      status: 409,
      payload: { error: { code: "revision_conflict", message: error.message } },
    };
  }
  if (error instanceof MissingBlobError) {
    return {
      status: 409,
      payload: {
        error: {
          code: "missing_blobs",
          message: error.message,
          missing_blobs: error.hashes,
        },
      },
    };
  }
  if (error instanceof SyncPlanConflictError) {
    return {
      status: 409,
      payload: { error: { code: "sync_plan_conflict", message: error.message } },
    };
  }
  if (error instanceof SyncPlanExpiredError) {
    return {
      status: 409,
      payload: { error: { code: "sync_plan_expired", message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    payload: { error: { code: "internal_error", message } },
  };
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) {
      request.destroy();
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const body = await readRequestBody(request, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "ContextEngine HTTP API",
      version: "0.4.0",
      description:
        "Workspace-scoped code indexing and retrieval. All /v1 endpoints require Bearer authentication.",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": { get: { summary: "Service health" } },
      "/dashboard": { get: { summary: "Embedded observability dashboard" } },
      "/v1/capabilities": { get: { summary: "Service capabilities" } },
      "/v1/observability/overview": {
        get: { summary: "Service, workspace, request, and index-job observations" },
      },
      "/v1/observability/configuration": {
        put: { summary: "Apply process-local model configuration" },
      },
      "/v1/observability/configuration/test": {
        post: { summary: "Test unsaved embedding or reranker configuration" },
      },
      "/v1/workspaces": {
        get: { summary: "List workspaces" },
        post: { summary: "Create a blob or local workspace" },
      },
      "/v1/workspaces/{workspaceId}": {
        get: { summary: "Get workspace" },
        delete: { summary: "Delete workspace and index" },
      },
      "/v1/workspaces/{workspaceId}/sync/plan": {
        post: { summary: "Create a content-addressed file sync plan" },
      },
      "/v1/workspaces/{workspaceId}/acl": {
        get: { summary: "List workspace principal permissions" },
      },
      "/v1/workspaces/{workspaceId}/acl/{principalId}": {
        put: { summary: "Grant or update a workspace permission" },
        delete: { summary: "Revoke a workspace permission" },
      },
      "/v1/workspaces/{workspaceId}/sources": {
        get: { summary: "List connector sources and synchronization state" },
      },
      "/v1/workspaces/{workspaceId}/sources/{provider}": {
        post: { summary: "Attach a registered read-only source provider" },
      },
      "/v1/workspaces/{workspaceId}/sources/{sourceId}": {
        get: { summary: "Get connector source state" },
      },
      "/v1/workspaces/{workspaceId}/sources/{sourceId}/sync": {
        post: { summary: "Synchronize and queue indexing for a connector source" },
      },
      "/v1/blobs/{sha256}": {
        put: { summary: "Upload a raw source Blob after SHA-256 verification" },
      },
      "/v1/blobs:batch": {
        post: { summary: "Upload base64 source Blobs in batches" },
      },
      "/v1/workspaces/{workspaceId}/sync/commit": {
        post: { summary: "Commit a sync plan and optionally queue incremental indexing" },
      },
      "/v1/workspaces/{workspaceId}/index-jobs": {
        post: { summary: "Queue an index or rebuild job" },
      },
      "/v1/index-jobs/{jobId}": { get: { summary: "Get index job status" } },
      "/v1/index-jobs/{jobId}/events": {
        get: { summary: "Stream index job state over server-sent events" },
      },
      "/v1/workspaces/{workspaceId}/search": {
        post: { summary: "Structured hybrid code search" },
      },
      "/v1/workspaces/{workspaceId}/context": {
        post: { summary: "Pack task context for an agent" },
      },
      "/v1/workspaces/{workspaceId}/file": {
        get: { summary: "Read a synchronized source file or line range" },
      },
      "/v1/workspaces/{workspaceId}/mcp": {
        post: { summary: "MCP Streamable HTTP initialize or tool request" },
        get: { summary: "MCP Streamable HTTP event stream" },
        delete: { summary: "Close an MCP Streamable HTTP session" },
      },
    },
  };
}

interface McpHttpSession {
  workspaceId: string;
  principalId: string;
  server: ReturnType<typeof createRetrievalMcpServer>;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  activeRequests: number;
}

class HttpContextService {
  private readonly repository: WorkspaceRepository;
  private readonly runner: IndexJobRunner;
  private readonly connectorSync: ConnectorSyncCoordinator;
  private readonly connectorRegistry: SourceConnectorRegistry;
  private readonly corsOrigins: ReadonlySet<string>;
  private readonly telemetry = new RequestTelemetry();
  private readonly engines = new Map<string, ContextEngine>();
  private readonly modelConfiguration = new RuntimeModelConfiguration();
  private readonly authenticator: HttpBearerAuthenticator;
  private readonly aclEnabled: boolean;
  private readonly allowLocalWorkspaces: boolean;
  private readonly localRootAllowlist: string[];
  private readonly maxBlobBytes: number;
  private readonly mcpSessionIdleTtlMs: number;
  private readonly mcpMaxSessions: number;
  private readonly mcpSessionStore: McpSessionStore;
  private readonly mcpSessionMetrics = {
    initialize: 0,
    resume: 0,
    close: 0,
    capacityRejection: 0,
    lookupRejection: 0,
    unknownRejection: 0,
    expiredRejection: 0,
    closedRejection: 0,
    principalMismatch: 0,
    lookupCount: 0,
    lookupLatencyMsTotal: 0,
    lookupLatencyMsMax: 0,
  };
  private readonly databaseUrl: string;
  private readonly disableEmbeddings: boolean;
  private readonly mcpSessions = new Map<string, McpHttpSession>();
  private readonly mcpSessionCleanupTimer: NodeJS.Timeout;
  private pendingMcpInitializations = 0;

  private constructor(
    repository: WorkspaceRepository,
    authenticator: HttpBearerAuthenticator,
    aclEnabled: boolean,
    options: Required<
      Pick<
        HttpServerOptions,
        | "databaseUrl"
        | "allowLocalWorkspaces"
        | "localRootAllowlist"
        | "maxBlobBytes"
        | "mcpSessionIdleTtlMs"
        | "mcpMaxSessions"
        | "mcpSessionStore"
        | "disableEmbeddings"
        | "githubTimeoutMs"
        | "corsOrigins"
      >
    > &
      Pick<
        HttpServerOptions,
        "githubToken" | "githubApiBaseUrl" | "connectorPlugins"
      >,
  ) {
    this.repository = repository;
    this.authenticator = authenticator;
    this.aclEnabled = aclEnabled;
    this.allowLocalWorkspaces = options.allowLocalWorkspaces;
    this.localRootAllowlist = options.localRootAllowlist.map((root) => {
      const resolved = path.resolve(root);
      try {
        return realpathSync.native(resolved);
      } catch {
        // Preserve invalid entries so a misconfigured allowlist fails closed.
        return resolved;
      }
    });
    this.maxBlobBytes = options.maxBlobBytes;
    this.mcpSessionIdleTtlMs = options.mcpSessionIdleTtlMs;
    this.mcpMaxSessions = options.mcpMaxSessions;
    this.mcpSessionStore = options.mcpSessionStore === "postgres"
      ? new PostgresMcpSessionStore(
          repository,
          options.mcpSessionIdleTtlMs,
          options.mcpMaxSessions,
        )
      : new MemoryMcpSessionStore(
          options.mcpSessionIdleTtlMs,
          options.mcpMaxSessions,
        );
    this.corsOrigins = new Set(options.corsOrigins);
    this.databaseUrl = options.databaseUrl;
    this.disableEmbeddings = options.disableEmbeddings;
    this.runner = new IndexJobRunner({
      repository,
      engineFor: (workspace) => this.engineFor(workspace),
    });
    const github = new GitHubConnectorClient({
      token: options.githubToken,
      apiBaseUrl: options.githubApiBaseUrl,
      timeoutMs: options.githubTimeoutMs,
    });
    this.connectorRegistry = new SourceConnectorRegistry([
      new GitHubSourceConnector(github),
      ...(options.connectorPlugins ?? []),
    ]);
    this.connectorSync = new ConnectorSyncCoordinator({
      repository,
      runner: this.runner,
      connectors: this.connectorRegistry,
      maxBlobBytes: options.maxBlobBytes,
      secrets: options.githubToken ? [options.githubToken] : [],
    });
    const cleanupIntervalMs = Math.max(
      1_000,
      Math.min(60_000, Math.floor(this.mcpSessionIdleTtlMs / 2)),
    );
    this.mcpSessionCleanupTimer = setInterval(() => {
      void this.pruneExpiredMcpSessions().catch((error: unknown) => {
        console.error(
          "[mcp http] session cleanup failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }, cleanupIntervalMs);
    this.mcpSessionCleanupTimer.unref();
  }

  static async create(options: HttpServerOptions): Promise<HttpContextService> {
    const databaseUrl = options.databaseUrl ?? resolveDatabaseUrl();
    if (!databaseUrl) {
      throw new Error("CONTEXTENGINE_DATABASE_URL is required for the HTTP server");
    }
    const allowUnauthenticated =
      options.allowUnauthenticated ??
      readBoolean(process.env.CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED);
    const apiKey =
      options.apiKey ?? (process.env.CONTEXTENGINE_HTTP_API_KEY?.trim() || undefined);
    const apiKeys = options.apiKeys ?? apiKeysFromEnv(process.env.CONTEXTENGINE_HTTP_API_KEYS);
    const authenticator = createHttpAuthenticator({
      apiKey,
      apiKeys,
      allowUnauthenticated,
    });
    const mcpSessionIdleTtlMs = positiveOption(
      options.mcpSessionIdleTtlMs ??
        numberFromEnv(
          process.env.CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS,
          DEFAULT_MCP_SESSION_IDLE_TTL_MS,
        ),
      "mcpSessionIdleTtlMs",
    );
    const mcpMaxSessions = positiveOption(
      options.mcpMaxSessions ??
        numberFromEnv(
          process.env.CONTEXTENGINE_MCP_MAX_SESSIONS,
          DEFAULT_MCP_MAX_SESSIONS,
        ),
      "mcpMaxSessions",
    );
    const repository = await WorkspaceRepository.open(databaseUrl);
    const service = new HttpContextService(repository, authenticator, apiKeys.length > 0, {
      databaseUrl,
      allowLocalWorkspaces:
        options.allowLocalWorkspaces ??
        readBoolean(process.env.CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES),
      localRootAllowlist:
        options.localRootAllowlist ??
        (process.env.CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST ?? "")
          .split(path.delimiter)
          .map((value) => value.trim())
          .filter(Boolean),
      maxBlobBytes:
        options.maxBlobBytes ??
        numberFromEnv(process.env.CONTEXTENGINE_HTTP_MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES),
      mcpSessionIdleTtlMs,
      mcpMaxSessions,
      mcpSessionStore:
        options.mcpSessionStore ??
        mcpSessionStoreFromEnv(process.env.CONTEXTENGINE_MCP_SESSION_STORE),
      disableEmbeddings: options.disableEmbeddings ?? false,
      githubToken:
        options.githubToken ?? (process.env.CONTEXTENGINE_GITHUB_TOKEN?.trim() || undefined),
      githubApiBaseUrl:
        options.githubApiBaseUrl ??
        (process.env.CONTEXTENGINE_GITHUB_API_BASE_URL?.trim() || undefined),
      githubTimeoutMs: positiveOption(
        options.githubTimeoutMs ??
          numberFromEnv(process.env.CONTEXTENGINE_GITHUB_TIMEOUT_MS, 30_000),
        "githubTimeoutMs",
      ),
      connectorPlugins: options.connectorPlugins,
      corsOrigins: normalizeCorsOrigins(
        options.corsOrigins ??
          (process.env.CONTEXTENGINE_HTTP_CORS_ORIGINS ?? "").split(","),
      ),
    });
    await service.runner.start();
    return service;
  }

  async close(): Promise<void> {
    clearInterval(this.mcpSessionCleanupTimer);
    const sessions = [...new Set(this.mcpSessions.values())];
    this.mcpSessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.transport.close();
        } finally {
          await session.server.close();
        }
      }),
    );
    await Promise.all([...this.engines.values()].map((engine) => engine.close()));
    this.engines.clear();
    await this.repository.close();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.applyCors(request, response)) return;
    const requestUrl = new URL(request.url ?? "/", "http://contextengine.local");
    const pathname = requestUrl.pathname;
    const observeRequest =
      pathname !== "/" &&
      pathname !== "/dashboard" &&
      pathname !== "/favicon.ico" &&
      pathname !== "/v1/observability/overview";
    const timing = observeRequest ? this.telemetry.begin() : null;
    try {
      if (request.method === "GET" && pathname === "/") {
        redirect(response, "/dashboard");
        return;
      }
      if (request.method === "GET" && pathname === "/dashboard") {
        html(response, observabilityDashboardHtml());
        return;
      }
      if (request.method === "GET" && pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET" && pathname === "/health") {
        await this.repository.health();
        json(response, 200, {
          ok: true,
          service: "contextengine",
          storage: "postgresql+pgvector",
        });
        return;
      }
      if (request.method === "GET" && (pathname === "/openapi.json" || pathname === "/docs")) {
        json(response, 200, openApiDocument());
        return;
      }
      const principal = this.authenticator.authenticate(request);
      if (!principal) {
        throw new HttpError(401, "Missing or invalid Bearer API key");
      }

      const mcpMatch = /^\/v1\/workspaces\/([^/]+)\/mcp$/.exec(pathname);
      if (
        mcpMatch &&
        (request.method === "POST" ||
          request.method === "GET" ||
          request.method === "DELETE")
      ) {
        await this.handleMcpRequest(
          decodeURIComponent(mcpMatch[1]),
          principal,
          request,
          response,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/v1/capabilities") {
        json(response, 200, {
          storage: "postgresql+pgvector",
          transports: ["http", "mcp-stdio", "mcp-streamable-http"],
          workspace_source_modes: ["blob", "local"],
          connectors: this.connectorRegistry.list().map((item) => item.provider),
          connector_plugins: this.connectorRegistry.list().map((item) => ({
            provider: item.provider,
            display_name: item.displayName,
          })),
          authorization: {
            principals: true,
            workspace_acl: this.aclEnabled,
            permissions: ["reader", "writer", "owner"],
          },
          sync: {
            content_addressed_blobs: true,
            revisioned_commits: true,
            resumable_missing_blob_check: true,
          },
          indexing: {
            async_jobs: true,
            server_sent_events: true,
            incremental: true,
          },
          retrieval: ["search", "context", "file", "codebase-retrieval"],
          mcp: {
            transport: "streamable-http",
            endpoint_template: "/v1/workspaces/{workspaceId}/mcp",
            authentication: "bearer",
            tools: ["codebase-retrieval"],
            session_idle_ttl_ms: this.mcpSessionIdleTtlMs,
            max_sessions: this.mcpMaxSessions,
          },
          observability: {
            dashboard: "/dashboard",
            overview: "/v1/observability/overview",
            request_payload_capture: false,
          },
        });
        return;
      }

      if (request.method === "GET" && pathname === "/v1/observability/overview") {
        this.requireAdmin(principal);
        const requestLimit = queryLimit(
          requestUrl.searchParams.get("request_limit"),
          60,
          120,
        );
        const jobLimit = queryLimit(
          requestUrl.searchParams.get("job_limit"),
          25,
          100,
        );
        const [workspaces, jobs, mcpSessions] = await Promise.all([
          this.repository.listWorkspaces(),
          this.repository.listRecentIndexJobs(jobLimit),
          this.mcpSessionStore.statistics(),
        ]);
        const observedWorkspaces = await Promise.all(
          workspaces.map(async (workspace) => {
            try {
              const sources = await this.repository.listConnectorSources(workspace.id);
              const engine = this.engineFor(workspace);
              const indexed = await engine.hasIndex();
              return {
                workspace: workspacePayload(workspace),
                sources: sources.map(connectorSourcePayload),
                indexed,
                stats: indexed ? await engine.stats() : null,
                error: null,
              };
            } catch {
              // A deleted or temporarily unavailable local root must not make
              // the whole observability response unusable.
              return {
                workspace: workspacePayload(workspace),
                sources: [],
                indexed: false,
                stats: null,
                error: "Workspace root unavailable",
              };
            }
          }),
        );
        const memory = process.memoryUsage();
        const requests = this.telemetry.snapshot(requestLimit);
        json(response, 200, {
          generated_at: new Date().toISOString(),
          service: {
            status: "online",
            storage: "postgresql+pgvector",
            uptime_seconds: this.telemetry.uptimeSeconds(),
            node_version: process.version,
            pid: process.pid,
            authentication_required: this.authenticator.policy.authenticationRequired,
            memory: {
              rss_bytes: memory.rss,
              heap_used_bytes: memory.heapUsed,
              heap_total_bytes: memory.heapTotal,
              external_bytes: memory.external,
            },
          },
          configuration: this.configurationSnapshot(),
          requests: {
            active: requests.active,
            total: requests.total,
            errors: requests.errors,
            error_rate: requests.errorRate,
            average_ms: requests.averageMs,
            p95_ms: requests.p95Ms,
            routes: requests.routes.map((route) => ({
              method: route.method,
              route: route.route,
              requests: route.requests,
              errors: route.errors,
              average_ms: route.averageMs,
              p95_ms: route.p95Ms,
            })),
            recent: requests.recent.map((item) => ({
              id: item.id,
              method: item.method,
              route: item.route,
              status: item.status,
              duration_ms: item.durationMs,
              started_at: item.startedAt,
            })),
          },
          mcp_sessions: {
            store: this.mcpSessionStore.kind,
            ...mcpSessions,
            initialize: this.mcpSessionMetrics.initialize,
            resume: this.mcpSessionMetrics.resume,
            takeover: 0,
            close: this.mcpSessionMetrics.close,
            lease_conflict: 0,
            capacity_rejection: this.mcpSessionMetrics.capacityRejection,
            lookup_rejection: this.mcpSessionMetrics.lookupRejection,
            unknown_rejection: this.mcpSessionMetrics.unknownRejection,
            expired_rejection: this.mcpSessionMetrics.expiredRejection,
            closed_rejection: this.mcpSessionMetrics.closedRejection,
            principal_mismatch: this.mcpSessionMetrics.principalMismatch,
            lookup_average_ms: this.mcpSessionMetrics.lookupCount > 0
              ? Number((
                  this.mcpSessionMetrics.lookupLatencyMsTotal /
                  this.mcpSessionMetrics.lookupCount
                ).toFixed(3))
              : 0,
            lookup_max_ms: Number(this.mcpSessionMetrics.lookupLatencyMsMax.toFixed(3)),
          },
          workspaces: observedWorkspaces,
          jobs: jobs.map(jobPayload),
        });
        return;
      }

      if (
        request.method === "POST" &&
        pathname === "/v1/observability/configuration/test"
      ) {
        this.requireAdmin(principal);
        const input = modelConnectionTestSchema.parse(
          await readJsonBody(request, 64 * 1024),
        );
        if (input.target === "embedding") {
          if (this.disableEmbeddings) {
            throw new HttpError(409, "Embedding is disabled by the server");
          }
          let config;
          try {
            config = this.modelConfiguration.embeddingCandidate(
              embeddingConfigurationUpdate(input.embedding),
            );
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error ? error.message : String(error),
            );
          }
          try {
            const result = await testEmbeddingConnection(config, {
              inputType: input.embedding.input_type,
              maxInputChars: input.embedding.max_input_chars,
            });
            json(response, 200, {
              ok: true,
              target: input.target,
              model: result.model,
              latency_ms: Number(result.latencyMs.toFixed(1)),
              details: result.details,
              tested_at: new Date().toISOString(),
            });
          } catch (error) {
            throw new HttpError(
              502,
              `Embedding test failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          return;
        }

        let config;
        try {
          config = this.modelConfiguration.rerankerCandidate(
            rerankerConfigurationUpdate(input.reranker),
          );
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          const result = await testRerankerConnection(config);
          json(response, 200, {
            ok: true,
            target: input.target,
            model: result.model,
            latency_ms: Number(result.latencyMs.toFixed(1)),
            details: result.details,
            tested_at: new Date().toISOString(),
          });
        } catch (error) {
          throw new HttpError(
            502,
            `Reranker test failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return;
      }

      if (
        request.method === "PUT" &&
        pathname === "/v1/observability/configuration"
      ) {
        this.requireAdmin(principal);
        if (this.runner.isBusy()) {
          throw new HttpError(
            409,
            "Model configuration cannot change while index jobs are queued or running",
          );
        }
        const input = modelConfigurationSchema.parse(
          await readJsonBody(request, 64 * 1024),
        );
        let result: ReturnType<RuntimeModelConfiguration["update"]>;
        try {
          result = this.modelConfiguration.update({
            embedding: input.embedding
              ? embeddingConfigurationUpdate(input.embedding)
              : undefined,
            reranker: input.reranker
              ? rerankerConfigurationUpdate(input.reranker)
              : undefined,
          } satisfies ModelConfigurationUpdate);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.reloadEngines();
        json(response, 200, {
          ok: true,
          changed: result.changed,
          reindex_required: result.reindexRequired,
          applied_at: new Date().toISOString(),
          configuration: this.configurationSnapshot(),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/v1/workspaces") {
        const workspaces = principal.admin
          ? await this.repository.listWorkspaces()
          : await this.repository.listWorkspacesForPrincipal(principal.principalId);
        json(response, 200, { workspaces: workspaces.map(workspacePayload) });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/workspaces") {
        const input = createWorkspaceSchema.parse(
          await readJsonBody(request, 64 * 1024),
        );
        const localRoot =
          input.source_mode === "local"
            ? this.resolveLocalRoot(input.local_root!)
            : undefined;
        const workspace = await this.repository.createWorkspace({
          name: input.name,
          sourceMode: input.source_mode,
          localRoot,
          ownerPrincipalId: this.aclEnabled ? principal.principalId : undefined,
        });
        json(response, 201, { workspace: workspacePayload(workspace) });
        return;
      }

      const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/.exec(pathname);
      if (workspaceMatch) {
        const workspaceId = decodeURIComponent(workspaceMatch[1]);
        if (request.method === "GET") {
          const workspace = await this.requireWorkspaceAccess(
            principal,
            workspaceId,
            "reader",
          );
          json(response, 200, { workspace: workspacePayload(workspace) });
          return;
        }
        if (request.method === "DELETE") {
          await this.requireWorkspaceAccess(principal, workspaceId, "owner");
          await this.closeEngine(workspaceId);
          await this.repository.deleteWorkspace(workspaceId);
          json(response, 200, { ok: true });
          return;
        }
      }

      const statusMatch = /^\/v1\/workspaces\/([^/]+)\/status$/.exec(pathname);
      if (request.method === "GET" && statusMatch) {
        const workspace = await this.requireWorkspaceAccess(
          principal,
          decodeURIComponent(statusMatch[1]),
          "reader",
        );
        const engine = this.engineFor(workspace);
        const indexed = await engine.hasIndex();
        const stats = indexed ? await engine.stats() : null;
        json(response, 200, {
          workspace: workspacePayload(workspace),
          indexed,
          stats,
        });
        return;
      }

      const aclListMatch = /^\/v1\/workspaces\/([^/]+)\/acl$/.exec(pathname);
      if (request.method === "GET" && aclListMatch) {
        const workspaceId = decodeURIComponent(aclListMatch[1]);
        await this.requireWorkspaceAccess(principal, workspaceId, "owner");
        const entries = await this.repository.listWorkspaceAcl(workspaceId);
        json(response, 200, {
          acl: entries.map((entry) => ({
            principal_id: entry.principalId,
            permission: entry.permission,
          })),
        });
        return;
      }

      const aclMemberMatch = /^\/v1\/workspaces\/([^/]+)\/acl\/([^/]+)$/.exec(
        pathname,
      );
      if (aclMemberMatch && (request.method === "PUT" || request.method === "DELETE")) {
        const workspaceId = decodeURIComponent(aclMemberMatch[1]);
        const memberId = decodeURIComponent(aclMemberMatch[2]).trim();
        if (!memberId || memberId.length > 200 || /[\u0000-\u001f\u007f]/.test(memberId)) {
          throw new HttpError(400, "principalId is invalid");
        }
        await this.requireWorkspaceAccess(principal, workspaceId, "owner");
        if (request.method === "PUT") {
          const input = workspacePermissionSchema.parse(
            await readJsonBody(request, 64 * 1024),
          );
          if (
            memberId === principal.principalId &&
            !principal.admin &&
            input.permission !== "owner"
          ) {
            throw new HttpError(409, "An owner cannot downgrade its active credential");
          }
          await this.repository.setWorkspacePermission(
            workspaceId,
            memberId,
            input.permission,
          );
          json(response, 200, {
            principal_id: memberId,
            permission: input.permission,
          });
          return;
        }
        if (memberId === principal.principalId && !principal.admin) {
          throw new HttpError(409, "An owner cannot revoke its active credential");
        }
        await this.repository.removeWorkspacePermission(workspaceId, memberId);
        json(response, 200, { ok: true });
        return;
      }

      const sourcesMatch = /^\/v1\/workspaces\/([^/]+)\/sources$/.exec(pathname);
      if (request.method === "GET" && sourcesMatch) {
        const workspaceId = decodeURIComponent(sourcesMatch[1]);
        await this.requireWorkspaceAccess(principal, workspaceId, "reader");
        const sources = await this.repository.listConnectorSources(workspaceId);
        json(response, 200, { sources: sources.map(connectorSourcePayload) });
        return;
      }

      const createSourceMatch = /^\/v1\/workspaces\/([^/]+)\/sources\/([^/]+)$/.exec(
        pathname,
      );
      if (request.method === "POST" && createSourceMatch) {
        const workspaceId = decodeURIComponent(createSourceMatch[1]);
        const provider = decodeURIComponent(createSourceMatch[2]);
        await this.requireWorkspaceAccess(principal, workspaceId, "owner");
        const connector = this.connectorRegistry.get(provider);
        if (!connector) throw new HttpError(404, "Connector provider not found");
        let config: Record<string, unknown>;
        let externalId: string;
        try {
          config = connector.validateConfig(await readJsonBody(request, 64 * 1024));
          if (!config || Array.isArray(config) || typeof config !== "object") {
            throw new Error("Connector configuration must be a JSON object");
          }
          if (JSON.stringify(config) === undefined) {
            throw new Error("Connector configuration must be JSON-serializable");
          }
          externalId = connector.externalId(config).trim();
          if (
            !externalId ||
            externalId.length > 500 ||
            /[\u0000-\u001f\u007f]/.test(externalId)
          ) {
            throw new Error("Connector external id is invalid");
          }
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        let source: StoredConnectorSource;
        try {
          source = await this.repository.createConnectorSource({
            workspaceId,
            provider: connector.provider,
            externalId,
            config,
            createdBy: principal.principalId,
          });
        } catch (error) {
          if (error instanceof WorkspaceNotFoundError) throw error;
          throw new HttpError(
            409,
            error instanceof Error ? error.message : String(error),
          );
        }
        json(response, 201, { source: connectorSourcePayload(source) });
        return;
      }

      const sourceMatch = /^\/v1\/workspaces\/([^/]+)\/sources\/([^/]+)$/.exec(
        pathname,
      );
      if (request.method === "GET" && sourceMatch) {
        const workspaceId = decodeURIComponent(sourceMatch[1]);
        await this.requireWorkspaceAccess(principal, workspaceId, "reader");
        const source = await this.repository.getConnectorSource(
          workspaceId,
          decodeURIComponent(sourceMatch[2]),
        );
        if (!source) throw new HttpError(404, "Connector source not found");
        json(response, 200, { source: connectorSourcePayload(source) });
        return;
      }

      const sourceSyncMatch =
        /^\/v1\/workspaces\/([^/]+)\/sources\/([^/]+)\/sync$/.exec(pathname);
      if (request.method === "POST" && sourceSyncMatch) {
        const workspaceId = decodeURIComponent(sourceSyncMatch[1]);
        const sourceId = decodeURIComponent(sourceSyncMatch[2]);
        await this.requireWorkspaceAccess(principal, workspaceId, "writer");
        const source = await this.repository.getConnectorSource(workspaceId, sourceId);
        if (!source) throw new HttpError(404, "Connector source not found");
        try {
          const result = await this.connectorSync.sync(workspaceId, sourceId);
          json(response, result.noop ? 200 : 202, {
            source: connectorSourcePayload(result.source),
            noop: result.noop,
            revision: result.revision,
            changed_paths: result.changedPaths,
            deleted_paths: result.deletedPaths,
            skipped_oversized: result.skippedOversized,
            index_job: result.indexJob ? jobPayload(result.indexJob) : null,
          });
        } catch (error) {
          if (error instanceof ConnectorSyncConflictError) {
            throw new HttpError(409, error.message);
          }
          if (error instanceof SourceConnectorError) {
            throw new HttpError(502, error.message);
          }
          throw error;
        }
        return;
      }

      const syncPlanMatch = /^\/v1\/workspaces\/([^/]+)\/sync\/plan$/.exec(pathname);
      if (request.method === "POST" && syncPlanMatch) {
        const workspaceId = decodeURIComponent(syncPlanMatch[1]);
        await this.requireWorkspaceAccess(principal, workspaceId, "writer");
        if (await this.repository.workspaceHasConnector(workspaceId)) {
          throw new HttpError(409, "Use the attached connector to synchronize this workspace");
        }
        const input = syncPlanSchema.parse(await readJsonBody(request, 8 * 1024 * 1024));
        const paths = new Set<string>();
        const changes = input.changes.map((change) => {
          const normalized = toSyncChange(change);
          const uniqueKey =
            normalized.op === "rename"
              ? `${normalized.op}:${normalized.oldPath}:${normalized.path}`
              : `${normalized.op}:${normalized.path}`;
          if (paths.has(uniqueKey)) {
            throw new HttpError(400, `Duplicate sync change: ${uniqueKey}`);
          }
          paths.add(uniqueKey);
          return normalized;
        });
        const plan = await this.repository.createSyncPlan(
          workspaceId,
          input.base_revision,
          changes,
          15 * 60 * 1000,
          !this.aclEnabled,
        );
        json(response, 201, {
          sync_id: plan.id,
          workspace_id: plan.workspaceId,
          base_revision: plan.baseRevision,
          missing_blobs: plan.missingBlobs,
          expires_at: plan.expiresAt,
        });
        return;
      }

      const blobMatch = /^\/v1\/blobs\/([0-9a-fA-F]{64})$/.exec(pathname);
      if (request.method === "PUT" && blobMatch) {
        const content = await readRequestBody(request, this.maxBlobBytes);
        if (!content.length) throw new HttpError(400, "Blob content must not be empty");
        if (this.aclEnabled) {
          const syncId = requestUrl.searchParams.get("sync_id");
          if (!syncId) throw new HttpError(400, "sync_id is required for Blob upload");
          const workspaceId = await this.repository.getSyncWorkspaceId(syncId);
          if (!workspaceId) throw new HttpError(404, "Sync session not found");
          await this.requireWorkspaceAccess(principal, workspaceId, "writer");
          await this.repository.putBlobForSync(
            workspaceId,
            syncId,
            blobMatch[1].toLowerCase(),
            content,
          );
        } else {
          await this.repository.putBlob(blobMatch[1].toLowerCase(), content);
        }
        json(response, 201, {
          ok: true,
          sha256: blobMatch[1].toLowerCase(),
          bytes: content.length,
        });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/blobs:batch") {
        const input = batchBlobSchema.parse(
          await readJsonBody(request, this.maxBlobBytes * MAX_BATCH_BLOBS),
        );
        const uploaded: Array<{ sha256: string; bytes: number }> = [];
        let scopedSync: { id: string; workspaceId: string } | null = null;
        if (this.aclEnabled) {
          const syncId = requestUrl.searchParams.get("sync_id");
          if (!syncId) throw new HttpError(400, "sync_id is required for Blob upload");
          const workspaceId = await this.repository.getSyncWorkspaceId(syncId);
          if (!workspaceId) throw new HttpError(404, "Sync session not found");
          await this.requireWorkspaceAccess(principal, workspaceId, "writer");
          scopedSync = { id: syncId, workspaceId };
        }
        for (const blob of input.blobs) {
          const content = Buffer.from(blob.content_base64, "base64");
          if (!content.length || content.length > this.maxBlobBytes) {
            throw new HttpError(413, "A batch blob is empty or exceeds the configured size limit");
          }
          if (scopedSync) {
            await this.repository.putBlobForSync(
              scopedSync.workspaceId,
              scopedSync.id,
              blob.sha256.toLowerCase(),
              content,
            );
          } else {
            await this.repository.putBlob(blob.sha256.toLowerCase(), content);
          }
          uploaded.push({ sha256: blob.sha256.toLowerCase(), bytes: content.length });
        }
        json(response, 201, { uploaded });
        return;
      }

      const syncCommitMatch = /^\/v1\/workspaces\/([^/]+)\/sync\/commit$/.exec(pathname);
      if (request.method === "POST" && syncCommitMatch) {
        const workspaceId = decodeURIComponent(syncCommitMatch[1]);
        await this.requireWorkspaceAccess(principal, workspaceId, "writer");
        const input = syncCommitSchema.parse(await readJsonBody(request, 64 * 1024));
        const commit = await this.repository.commitSync(workspaceId, input.sync_id, {
          allowGlobalBlobs: !this.aclEnabled,
          createIndexJob: input.auto_index,
        });
        const job = commit.indexJob ?? null;
        if (job) this.runner.enqueue(job.id);
        json(response, 200, {
          ok: true,
          revision: commit.revision,
          changed_paths: commit.changedPaths,
          deleted_paths: commit.deletedPaths,
          index_job: job ? jobPayload(job) : null,
        });
        return;
      }

      const indexJobCreateMatch = /^\/v1\/workspaces\/([^/]+)\/index-jobs$/.exec(pathname);
      if (request.method === "POST" && indexJobCreateMatch) {
        const workspaceId = decodeURIComponent(indexJobCreateMatch[1]);
        const workspace = await this.requireWorkspaceAccess(
          principal,
          workspaceId,
          "writer",
        );
        const input = z
          .object({ mode: z.enum(["incremental", "rebuild"]).default("incremental") })
          .parse(await readJsonBody(request, 64 * 1024));
        const job = await this.repository.createIndexJob({
          workspaceId,
          revision: workspace.revision,
          mode: input.mode,
          changedPaths: null,
          deletedPaths: [],
        });
        this.runner.enqueue(job.id);
        json(response, 202, { job: jobPayload(job) });
        return;
      }

      const jobEventMatch = /^\/v1\/index-jobs\/([^/]+)\/events$/.exec(pathname);
      if (request.method === "GET" && jobEventMatch) {
        const jobId = decodeURIComponent(jobEventMatch[1]);
        const job = await this.repository.getIndexJob(jobId);
        if (!job) throw new HttpError(404, `Index job not found: ${jobId}`);
        await this.requireWorkspaceAccess(principal, job.workspaceId, "reader");
        this.streamJobEvents(request, response, job);
        return;
      }

      const jobMatch = /^\/v1\/index-jobs\/([^/]+)$/.exec(pathname);
      if (request.method === "GET" && jobMatch) {
        const job = await this.repository.getIndexJob(decodeURIComponent(jobMatch[1]));
        if (!job) throw new HttpError(404, "Index job not found");
        await this.requireWorkspaceAccess(principal, job.workspaceId, "reader");
        json(response, 200, { job: jobPayload(job) });
        return;
      }

      const searchMatch = /^\/v1\/workspaces\/([^/]+)\/search$/.exec(pathname);
      if (request.method === "POST" && searchMatch) {
        const workspace = await this.requireWorkspaceAccess(
          principal,
          decodeURIComponent(searchMatch[1]),
          "reader",
        );
        const input = z
          .object({
            query: z.string().trim().min(1).max(20_000),
            top_k: positiveInteger.max(40).default(10),
            path_prefix: z.string().min(1).max(4096).optional(),
            language: z.string().min(1).max(80).optional(),
            mode: z.enum(["auto", "bm25", "semantic", "hybrid"]).default("auto"),
            expand_graph: z.boolean().optional(),
            include_commits: z.boolean().optional(),
            neural_rerank: z.boolean().optional(),
          })
          .parse(await readJsonBody(request, 128 * 1024));
        const engine = await this.requireIndexedEngine(workspace);
        const hits = await engine.search({
          query: input.query,
          topK: input.top_k,
          pathPrefix: input.path_prefix,
          language: input.language,
          mode: input.mode,
          expandGraph: input.expand_graph,
          includeCommits: input.include_commits,
          neuralRerank: input.neural_rerank,
        });
        const index = await engine.indexStatus();
        json(response, 200, {
          count: hits.length,
          index: generationPayload(index),
          degraded_channels: [
            ...new Set(hits.flatMap((hit) => hit.degradedChannels ?? [])),
          ],
          results: hits.map(hitPayload),
        });
        return;
      }

      const contextMatch = /^\/v1\/workspaces\/([^/]+)\/context$/.exec(pathname);
      if (request.method === "POST" && contextMatch) {
        const workspace = await this.requireWorkspaceAccess(
          principal,
          decodeURIComponent(contextMatch[1]),
          "reader",
        );
        const input = z
          .object({
            task: z.string().trim().min(1).max(20_000).optional(),
            information_request: z.string().trim().min(1).max(20_000).optional(),
            informationRequest: z.string().trim().min(1).max(20_000).optional(),
            top_k: positiveInteger.max(40).optional(),
            max_tokens: positiveInteger.optional(),
            path_prefix: z.string().min(1).max(4096).optional(),
          })
          .parse(await readJsonBody(request, 128 * 1024));
        const task = input.task ?? input.information_request ?? input.informationRequest;
        if (!task) throw new HttpError(400, "task or information_request is required");
        const engine = await this.requireIndexedEngine(workspace);
        const packed = await engine.getTaskContext({
          task,
          topK: input.top_k ?? 14,
          maxTokens: input.max_tokens,
          pathPrefix: input.path_prefix,
          diversify: true,
        });
        const index = await engine.indexStatus();
        json(response, 200, {
          task: packed.task,
          index: generationPayload(index),
          degraded_channels: packed.degradedChannels ?? [],
          packed_text: packed.packedText,
          estimated_tokens: packed.estimatedTokens,
          truncated: packed.truncated,
          hits: packed.hits.map(hitPayload),
        });
        return;
      }

      const fileMatch = /^\/v1\/workspaces\/([^/]+)\/file$/.exec(pathname);
      if (request.method === "GET" && fileMatch) {
        const workspace = await this.requireWorkspaceAccess(
          principal,
          decodeURIComponent(fileMatch[1]),
          "reader",
        );
        const sourcePath = normalizedRelativePath(
          requestUrl.searchParams.get("path") ?? "",
        );
        const startLine = parseLineParam(requestUrl.searchParams.get("start_line"));
        const endLine = parseLineParam(requestUrl.searchParams.get("end_line"));
        const file =
          workspace.sourceMode === "local"
            ? this.engineFor(workspace).getFileContext(sourcePath, startLine, endLine)
            : await this.readBlobFile(workspace.id, sourcePath, startLine, endLine);
        if (!file) throw new HttpError(404, `File not found or binary: ${sourcePath}`);
        json(response, 200, file);
        return;
      }

      throw new HttpError(404, `No route for ${request.method ?? "GET"} ${pathname}`);
    } catch (error) {
      const mapped = errorPayload(error);
      json(response, mapped.status, mapped.payload);
    } finally {
      if (timing) {
        this.telemetry.complete(
          request.method,
          pathname,
          response.statusCode,
          timing,
        );
      }
    }
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): boolean {
    if (this.corsOrigins.size === 0) return false;
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!origin) {
      if (request.method === "OPTIONS" && this.corsOrigins.size > 0) {
        response.statusCode = 204;
        response.end();
        return true;
      }
      return false;
    }
    const wildcard = this.corsOrigins.has("*");
    if (!wildcard && !this.corsOrigins.has(origin)) {
      json(response, 403, { error: { code: "cors_origin_denied", message: "Origin is not allowed" } });
      return true;
    }
    response.setHeader("access-control-allow-origin", wildcard ? "*" : origin);
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "Authorization,Content-Type,Accept,Mcp-Session-Id,Mcp-Protocol-Version,Last-Event-ID",
    );
    response.setHeader("access-control-expose-headers", "Mcp-Session-Id,Retry-After");
    if (!wildcard) response.setHeader("vary", "Origin");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return true;
    }
    return false;
  }

  private async handleMcpRequest(
    workspaceId: string,
    principal: HttpPrincipal,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.mcpSessionStore.kind === "postgres") {
      await this.handleDurableMcpRequest(workspaceId, principal, request, response);
      return;
    }
    await this.handleMemoryMcpRequest(workspaceId, principal, request, response);
  }

  private async handleDurableMcpRequest(
    workspaceId: string,
    principal: HttpPrincipal,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await this.mcpSessionStore.pruneExpired();
    try {
      await this.requireWorkspaceAccess(principal, workspaceId, "reader");
    } catch {
      mcpError(response, 404, "MCP workspace was not found");
      return;
    }

    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const sessionIdHash = sessionId ? sha256(sessionId) : undefined;
    const sessionInput = sessionIdHash
      ? { sessionIdHash, workspaceId, principalId: principal.principalId }
      : undefined;

    if (request.method === "GET") {
      response.setHeader("allow", "POST, DELETE");
      mcpError(response, 405, "MCP SSE streams are unavailable for reconstructed sessions");
      return;
    }

    if (request.method === "DELETE") {
      if (!sessionInput) {
        mcpError(response, 400, "A valid mcp-session-id is required");
        return;
      }
      if (await this.mcpSessionStore.close(sessionInput)) {
        this.mcpSessionMetrics.close += 1;
      }
      response.statusCode = 200;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      mcpError(response, 405, "Method not allowed");
      return;
    }

    const body = await readJsonBody(request, 128 * 1024);
    if (isInitializeRequest(body)) {
      if (sessionInput) {
        mcpError(response, 400, "The initialize request must not include mcp-session-id");
        return;
      }
      const sessionIdForTransport = randomUUID();
      const requestedVersion = body.params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
      const created = await this.mcpSessionStore.create({
        sessionIdHash: sha256(sessionIdForTransport),
        workspaceId,
        principalId: principal.principalId,
        protocolVersion,
      });
      if (!created) {
        this.mcpSessionMetrics.capacityRejection += 1;
        response.setHeader("retry-after", "1");
        mcpError(response, 429, "MCP session capacity has been reached");
        return;
      }
      this.mcpSessionMetrics.initialize += 1;

      const server = createRetrievalMcpServer(
        {
          ensureReady: async () => {
            const workspace = await this.requireWorkspaceAccess(
              principal,
              workspaceId,
              "reader",
            );
            return this.requireIndexedEngine(workspace);
          },
        },
        { includeLegacyAlias: false },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionIdForTransport,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        if (response.statusCode >= 400) {
          await this.mcpSessionStore.close({
            sessionIdHash: sha256(sessionIdForTransport),
            workspaceId,
            principalId: principal.principalId,
          });
        }
      } catch (error) {
        await this.mcpSessionStore.close({
          sessionIdHash: sha256(sessionIdForTransport),
          workspaceId,
          principalId: principal.principalId,
        });
        if (!response.headersSent) {
          mcpError(response, 500, error instanceof Error ? error.message : String(error));
        }
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
      return;
    }

    if (!sessionInput) {
      mcpError(response, 400, "A valid mcp-session-id is required");
      return;
    }
    const lookupStartedAt = performance.now();
    const session = await this.mcpSessionStore.touch(sessionInput);
    const lookupLatencyMs = performance.now() - lookupStartedAt;
    this.mcpSessionMetrics.lookupCount += 1;
    this.mcpSessionMetrics.lookupLatencyMsTotal += lookupLatencyMs;
    this.mcpSessionMetrics.lookupLatencyMsMax = Math.max(
      this.mcpSessionMetrics.lookupLatencyMsMax,
      lookupLatencyMs,
    );
    if (!session) {
      this.mcpSessionMetrics.lookupRejection += 1;
      const reason = await this.mcpSessionStore.classifyRejection(sessionInput);
      if (reason === "principal_mismatch") {
        this.mcpSessionMetrics.principalMismatch += 1;
      } else if (reason === "expired") {
        this.mcpSessionMetrics.expiredRejection += 1;
      } else if (reason === "closed") {
        this.mcpSessionMetrics.closedRejection += 1;
      } else {
        this.mcpSessionMetrics.unknownRejection += 1;
      }
      mcpError(response, 404, "MCP session was not found or has expired");
      return;
    }
    this.mcpSessionMetrics.resume += 1;
    const protocolHeader = request.headers["mcp-protocol-version"];
    const protocolVersion = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;
    if (protocolVersion && protocolVersion !== session.protocolVersion) {
      mcpError(response, 400, "MCP protocol version does not match the initialized session");
      return;
    }
    await this.handleFreshMcpPost(
      principal,
      workspaceId,
      request,
      response,
      body,
    );
  }

  private async handleFreshMcpPost(
    principal: HttpPrincipal,
    workspaceId: string,
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = createRetrievalMcpServer(
      {
        ensureReady: async () => {
          const workspace = await this.requireWorkspaceAccess(
            principal,
            workspaceId,
            "reader",
          );
          return this.requireIndexedEngine(workspace);
        },
      },
      { includeLegacyAlias: false },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transport.onerror = (error) => {
      console.error("[mcp http]", error.message);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        mcpError(response, 500, error instanceof Error ? error.message : String(error));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  private async handleMemoryMcpRequest(
    workspaceId: string,
    principal: HttpPrincipal,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await this.pruneExpiredMcpSessions();
    try {
      await this.requireWorkspaceAccess(principal, workspaceId, "reader");
    } catch {
      mcpError(response, 404, "MCP workspace was not found");
      return;
    }
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    const existing = sessionId ? this.mcpSessions.get(sessionId) : undefined;

    if (
      existing &&
      (existing.workspaceId !== workspaceId ||
        existing.principalId !== principal.principalId)
    ) {
      this.mcpSessionMetrics.lookupRejection += 1;
      this.mcpSessionMetrics.principalMismatch += 1;
      mcpError(response, 404, "MCP session does not belong to this workspace");
      return;
    }

    if (existing) {
      const touched = await this.mcpSessionStore.touch({
        sessionIdHash: sha256(sessionId!),
        workspaceId,
        principalId: principal.principalId,
      });
      if (!touched) {
        this.mcpSessionMetrics.lookupRejection += 1;
        const reason = await this.mcpSessionStore.classifyRejection({
          sessionIdHash: sha256(sessionId!),
          workspaceId,
          principalId: principal.principalId,
        });
        if (reason === "expired") this.mcpSessionMetrics.expiredRejection += 1;
        else if (reason === "closed") this.mcpSessionMetrics.closedRejection += 1;
        else this.mcpSessionMetrics.unknownRejection += 1;
        mcpError(response, 404, "MCP session was not found or has expired");
        return;
      }
      this.mcpSessionMetrics.resume += 1;
      existing.lastSeenAt = Date.now();
      existing.activeRequests += 1;
      try {
        await existing.transport.handleRequest(request, response);
      } finally {
        existing.activeRequests = Math.max(0, existing.activeRequests - 1);
        existing.lastSeenAt = Date.now();
      }
      return;
    }

    if (sessionId) {
      this.mcpSessionMetrics.lookupRejection += 1;
      this.mcpSessionMetrics.unknownRejection += 1;
      mcpError(response, 404, "MCP session was not found or has expired");
      return;
    }

    if (request.method !== "POST") {
      mcpError(response, 400, "A valid mcp-session-id is required");
      return;
    }

    const body = await readJsonBody(request, 128 * 1024);
    if (!isInitializeRequest(body)) {
      mcpError(response, 400, "The first MCP request must be initialize");
      return;
    }

    // Validate the workspace before allocating a long-lived MCP session. The
    // retrieval tool itself resolves the engine lazily so an unindexed
    // workspace can still complete MCP initialization and return a useful
    // error/hint from the tool call.
    if (
      this.mcpSessions.size + this.pendingMcpInitializations >=
      this.mcpMaxSessions
    ) {
      this.mcpSessionMetrics.capacityRejection += 1;
      response.setHeader("retry-after", "1");
      mcpError(response, 429, "MCP session capacity has been reached");
      return;
    }

    this.pendingMcpInitializations += 1;
    let session: McpHttpSession | undefined;
    let initializedSessionId: string | undefined;
    const requestedVersion = body.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
    const server = createRetrievalMcpServer(
      {
        ensureReady: async () => {
          const workspace = await this.requireWorkspaceAccess(
            principal,
            workspaceId,
            "reader",
          );
          return this.requireIndexedEngine(workspace);
        },
      },
      { includeLegacyAlias: false },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // JSON responses are easier for remote coding clients and remain fully
      // compliant with the Streamable HTTP transport.
      enableJsonResponse: true,
      onsessioninitialized: async (newSessionId) => {
        if (!session) return;
        const created = await this.mcpSessionStore.create({
          sessionIdHash: sha256(newSessionId),
          workspaceId,
          principalId: principal.principalId,
          protocolVersion,
        });
        if (!created) throw new Error("MCP session capacity has been reached");
        initializedSessionId = newSessionId;
        session.lastSeenAt = Date.now();
        this.mcpSessions.set(newSessionId, session);
        this.mcpSessionMetrics.initialize += 1;
      },
      onsessionclosed: async (closedSessionId) => {
        const closed = this.mcpSessions.get(closedSessionId);
        if (!closed) return;
        this.mcpSessions.delete(closedSessionId);
        if (await this.mcpSessionStore.close({
          sessionIdHash: sha256(closedSessionId),
          workspaceId: closed.workspaceId,
          principalId: closed.principalId,
        })) {
          this.mcpSessionMetrics.close += 1;
        }
        void closed.server.close().catch(() => undefined);
      },
    });
    session = {
      workspaceId,
      principalId: principal.principalId,
      server,
      transport,
      lastSeenAt: Date.now(),
      activeRequests: 1,
    };
    transport.onerror = (error) => {
      // Keep protocol errors out of the JSON response once headers are sent,
      // but retain a concise server-side diagnostic for operators.
      console.error("[mcp http]", error.message);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      session.lastSeenAt = Date.now();
    } catch (error) {
      if (
        initializedSessionId &&
        this.mcpSessions.get(initializedSessionId) === session
      ) {
        this.mcpSessions.delete(initializedSessionId);
      }
      if (!response.headersSent) {
        mcpError(
          response,
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    } finally {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      this.pendingMcpInitializations = Math.max(
        0,
        this.pendingMcpInitializations - 1,
      );
    }
  }

  private async pruneExpiredMcpSessions(now = Date.now()): Promise<void> {
    if (this.mcpSessionStore.kind === "postgres") {
      await this.mcpSessionStore.pruneExpired();
      return;
    }
    await this.mcpSessionStore.pruneExpired();
    const expired = [...this.mcpSessions.entries()].filter(
      ([, session]) =>
        session.activeRequests === 0 &&
        now - session.lastSeenAt >= this.mcpSessionIdleTtlMs,
    );
    await Promise.all(
      expired.map(([sessionId, session]) =>
        this.closeMcpSession(sessionId, session),
      ),
    );
  }

  private async closeMcpSession(
    sessionId: string,
    session: McpHttpSession,
  ): Promise<void> {
    if (this.mcpSessions.get(sessionId) !== session) return;
    this.mcpSessions.delete(sessionId);
    if (await this.mcpSessionStore.close({
      sessionIdHash: sha256(sessionId),
      workspaceId: session.workspaceId,
      principalId: session.principalId,
    })) {
      this.mcpSessionMetrics.close += 1;
    }
    try {
      await session.transport.close();
    } finally {
      await session.server.close();
    }
  }

  private requireAdmin(principal: HttpPrincipal): void {
    if (!principal.admin) {
      throw new HttpError(403, "Operator access is required");
    }
  }

  private async requireWorkspaceAccess(
    principal: HttpPrincipal,
    workspaceId: string,
    required: WorkspacePermission,
  ): Promise<StoredWorkspace> {
    if (principal.admin) {
      return this.repository.requireWorkspace(workspaceId);
    }
    const permission = await this.repository.getWorkspacePermission(
      workspaceId,
      principal.principalId,
    );
    if (!workspacePermissionAllows(permission, required)) {
      throw new HttpError(404, "Workspace not found");
    }
    return this.repository.requireWorkspace(workspaceId);
  }

  private resolveLocalRoot(input: string): string {
    if (!this.allowLocalWorkspaces) {
      throw new HttpError(
        403,
        "Local workspaces are disabled; use a blob workspace for remote clients",
      );
    }
    const requestedRoot = path.resolve(input);
    if (!existsSync(requestedRoot)) {
      throw new HttpError(400, `Local root does not exist: ${requestedRoot}`);
    }
    let root: string;
    try {
      root = realpathSync.native(requestedRoot);
      if (!statSync(root).isDirectory()) {
        throw new HttpError(400, `Local root is not a directory: ${root}`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `Local root cannot be resolved: ${requestedRoot}`);
    }
    if (
      this.localRootAllowlist.length > 0 &&
      !this.localRootAllowlist.some(
        (allowed) => root === allowed || root.startsWith(`${allowed}${path.sep}`),
      )
    ) {
      throw new HttpError(403, "Local root is outside CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST");
    }
    return root;
  }

  private engineFor(workspace: StoredWorkspace): ContextEngine {
    const root =
      workspace.sourceMode === "local" && workspace.localRoot
        // Re-resolve on every access. A local directory can be replaced after
        // workspace creation; checking the current real path keeps the
        // allowlist effective even when an engine is already cached.
        ? this.resolveLocalRoot(workspace.localRoot)
        : path.join(process.cwd(), ".contextengine-http", workspace.id);
    const existing = this.engines.get(workspace.id);
    if (existing) return existing;
    const config = resolveEngineConfig({
      root,
      workspaceId: workspace.id,
      databaseUrl: this.databaseUrl,
    });
    const modelConfig = this.modelConfiguration.engineConfig();
    config.embeddings = modelConfig.embeddings;
    config.neuralRerank = modelConfig.neuralRerank;
    if (this.disableEmbeddings) config.embeddings = undefined;
    const engine = new ContextEngine(config);
    this.engines.set(workspace.id, engine);
    return engine;
  }

  private async requireIndexedEngine(workspace: StoredWorkspace): Promise<ContextEngine> {
    const engine = this.engineFor(workspace);
    if (!(await engine.hasIndex())) {
      throw new HttpError(
        409,
        "Workspace has no indexed source yet; commit a sync with auto_index or create an index job",
      );
    }
    return engine;
  }

  private async closeEngine(workspaceId: string): Promise<void> {
    const engine = this.engines.get(workspaceId);
    this.engines.delete(workspaceId);
    if (engine) await engine.close();
  }

  private async reloadEngines(): Promise<void> {
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.all(engines.map((engine) => engine.close()));
  }

  private configurationSnapshot(): Record<string, unknown> {
    return this.modelConfiguration.snapshot({
      databaseUrl: this.databaseUrl,
      httpApiKey: this.authenticator.policy.authenticationRequired
        ? "configured"
        : undefined,
      allowUnauthenticated: !this.authenticator.policy.authenticationRequired,
      allowLocalWorkspaces: this.allowLocalWorkspaces,
      localRootAllowlistCount: this.localRootAllowlist.length,
      maxBlobBytes: this.maxBlobBytes,
      mcpSessionIdleTtlMs: this.mcpSessionIdleTtlMs,
      mcpMaxSessions: this.mcpMaxSessions,
      mcpSessionStore: this.mcpSessionStore.kind,
      corsOriginsCount: this.corsOrigins.size,
      disableEmbeddings: this.disableEmbeddings,
    });
  }

  private async readBlobFile(
    workspaceId: string,
    sourcePath: string,
    startLine: number | undefined,
    endLine: number | undefined,
  ): Promise<Record<string, unknown> | null> {
    const source = await this.repository.readSourceFile(workspaceId, sourcePath);
    if (!source) return null;
    return sliceFile(source.path, source.content, startLine, endLine);
  }

  private streamJobEvents(
    request: IncomingMessage,
    response: ServerResponse,
    initial: StoredIndexJob,
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (job: StoredIndexJob): void => {
      response.write(`event: job\ndata: ${JSON.stringify({ job: jobPayload(job) })}\n\n`);
    };
    send(initial);
    const unsubscribe = this.runner.subscribe(initial.id, send);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
  }
}

function parseLineParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "start_line and end_line must be positive integers");
  }
  return parsed;
}

export async function startHttpServer(
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const service = await HttpContextService.create(options);
  const host = options.host ?? process.env.CONTEXTENGINE_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? numberFromEnv(process.env.CONTEXTENGINE_HTTP_PORT, 8787);
  const server = createServer((request, response) => {
    void service.handle(request, response);
  });
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await service.close();
    server.close();
    throw new Error("HTTP server did not expose a TCP address");
  }
  const displayHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : address.address;
  const url = `http://${displayHost}:${address.port}`;
  return {
    url,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await service.close();
    },
  };
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith("http-server.ts") ||
    process.argv[1].endsWith("http-server.js") ||
    process.argv[1].includes("contextengine-http"));

if (isDirect) {
  loadDotEnv();
  startHttpServer()
    .then((handle) => {
      console.log(`ContextEngine HTTP server listening at ${handle.url}`);
      const stop = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
