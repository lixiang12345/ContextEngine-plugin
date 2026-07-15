#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { z, ZodError } from "zod";
import { loadDotEnv, resolveDatabaseUrl, resolveEngineConfig } from "./config.js";
import { ContextEngine } from "./engine.js";
import { IndexJobRunner } from "./server/index-job-runner.js";
import {
  MissingBlobError,
  RevisionConflictError,
  type StoredIndexJob,
  type StoredWorkspace,
  WorkspaceNotFoundError,
  WorkspaceRepository,
  type SyncChange,
} from "./server/workspace-repository.js";
import type { SearchHit } from "./types.js";

const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BLOBS = 16;

export interface HttpServerOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  databaseUrl?: string;
  allowUnauthenticated?: boolean;
  allowLocalWorkspaces?: boolean;
  localRootAllowlist?: string[];
  maxBlobBytes?: number;
  disableEmbeddings?: boolean;
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

function readBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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

function matchesBearer(
  request: IncomingMessage,
  apiKey: string | undefined,
  allowUnauthenticated: boolean,
): boolean {
  if (!apiKey) return allowUnauthenticated;
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const given = Buffer.from(request.headers.authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
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
      "/v1/capabilities": { get: { summary: "Service capabilities" } },
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
    },
  };
}

class HttpContextService {
  private readonly repository: WorkspaceRepository;
  private readonly runner: IndexJobRunner;
  private readonly engines = new Map<string, ContextEngine>();
  private readonly apiKey: string | undefined;
  private readonly allowUnauthenticated: boolean;
  private readonly allowLocalWorkspaces: boolean;
  private readonly localRootAllowlist: string[];
  private readonly maxBlobBytes: number;
  private readonly databaseUrl: string;
  private readonly disableEmbeddings: boolean;

  private constructor(
    repository: WorkspaceRepository,
    options: Required<
      Pick<
        HttpServerOptions,
        | "databaseUrl"
        | "allowUnauthenticated"
        | "allowLocalWorkspaces"
        | "localRootAllowlist"
        | "maxBlobBytes"
        | "disableEmbeddings"
      >
    > &
      Pick<HttpServerOptions, "apiKey">,
  ) {
    this.repository = repository;
    this.apiKey = options.apiKey;
    this.allowUnauthenticated = options.allowUnauthenticated;
    this.allowLocalWorkspaces = options.allowLocalWorkspaces;
    this.localRootAllowlist = options.localRootAllowlist.map((root) =>
      path.resolve(root),
    );
    this.maxBlobBytes = options.maxBlobBytes;
    this.databaseUrl = options.databaseUrl;
    this.disableEmbeddings = options.disableEmbeddings;
    this.runner = new IndexJobRunner({
      repository,
      engineFor: (workspace) => this.engineFor(workspace),
    });
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
    if (!apiKey && !allowUnauthenticated) {
      throw new Error(
        "CONTEXTENGINE_HTTP_API_KEY is required unless CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED=1",
      );
    }
    const repository = await WorkspaceRepository.open(databaseUrl);
    const service = new HttpContextService(repository, {
      databaseUrl,
      apiKey,
      allowUnauthenticated,
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
      disableEmbeddings: options.disableEmbeddings ?? false,
    });
    await service.runner.start();
    return service;
  }

  async close(): Promise<void> {
    await Promise.all([...this.engines.values()].map((engine) => engine.close()));
    this.engines.clear();
    await this.repository.close();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://contextengine.local");
    const pathname = requestUrl.pathname;
    try {
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
      if (!matchesBearer(request, this.apiKey, this.allowUnauthenticated)) {
        throw new HttpError(401, "Missing or invalid Bearer API key");
      }

      if (request.method === "GET" && pathname === "/v1/capabilities") {
        json(response, 200, {
          storage: "postgresql+pgvector",
          transports: ["http", "mcp-stdio"],
          workspace_source_modes: ["blob", "local"],
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
          retrieval: ["search", "context", "file"],
        });
        return;
      }

      if (request.method === "GET" && pathname === "/v1/workspaces") {
        const workspaces = await this.repository.listWorkspaces();
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
        });
        json(response, 201, { workspace: workspacePayload(workspace) });
        return;
      }

      const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/.exec(pathname);
      if (workspaceMatch) {
        const workspaceId = decodeURIComponent(workspaceMatch[1]);
        if (request.method === "GET") {
          const workspace = await this.repository.requireWorkspace(workspaceId);
          json(response, 200, { workspace: workspacePayload(workspace) });
          return;
        }
        if (request.method === "DELETE") {
          await this.closeEngine(workspaceId);
          await this.repository.deleteWorkspace(workspaceId);
          json(response, 200, { ok: true });
          return;
        }
      }

      const statusMatch = /^\/v1\/workspaces\/([^/]+)\/status$/.exec(pathname);
      if (request.method === "GET" && statusMatch) {
        const workspace = await this.repository.requireWorkspace(
          decodeURIComponent(statusMatch[1]),
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

      const syncPlanMatch = /^\/v1\/workspaces\/([^/]+)\/sync\/plan$/.exec(pathname);
      if (request.method === "POST" && syncPlanMatch) {
        const workspaceId = decodeURIComponent(syncPlanMatch[1]);
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
        await this.repository.putBlob(blobMatch[1].toLowerCase(), content);
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
        for (const blob of input.blobs) {
          const content = Buffer.from(blob.content_base64, "base64");
          if (!content.length || content.length > this.maxBlobBytes) {
            throw new HttpError(413, "A batch blob is empty or exceeds the configured size limit");
          }
          await this.repository.putBlob(blob.sha256.toLowerCase(), content);
          uploaded.push({ sha256: blob.sha256.toLowerCase(), bytes: content.length });
        }
        json(response, 201, { uploaded });
        return;
      }

      const syncCommitMatch = /^\/v1\/workspaces\/([^/]+)\/sync\/commit$/.exec(pathname);
      if (request.method === "POST" && syncCommitMatch) {
        const workspaceId = decodeURIComponent(syncCommitMatch[1]);
        const input = syncCommitSchema.parse(await readJsonBody(request, 64 * 1024));
        const commit = await this.repository.commitSync(workspaceId, input.sync_id);
        let job: StoredIndexJob | null = null;
        if (input.auto_index) {
          job = await this.repository.createIndexJob({
            workspaceId,
            revision: commit.revision,
            mode: "incremental",
            changedPaths: commit.changedPaths,
            deletedPaths: commit.deletedPaths,
          });
          this.runner.enqueue(job.id);
        }
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
        const input = z
          .object({ mode: z.enum(["incremental", "rebuild"]).default("incremental") })
          .parse(await readJsonBody(request, 64 * 1024));
        const workspace = await this.repository.requireWorkspace(workspaceId);
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
        this.streamJobEvents(request, response, job);
        return;
      }

      const jobMatch = /^\/v1\/index-jobs\/([^/]+)$/.exec(pathname);
      if (request.method === "GET" && jobMatch) {
        const job = await this.repository.getIndexJob(decodeURIComponent(jobMatch[1]));
        if (!job) throw new HttpError(404, "Index job not found");
        json(response, 200, { job: jobPayload(job) });
        return;
      }

      const searchMatch = /^\/v1\/workspaces\/([^/]+)\/search$/.exec(pathname);
      if (request.method === "POST" && searchMatch) {
        const workspace = await this.repository.requireWorkspace(
          decodeURIComponent(searchMatch[1]),
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
        json(response, 200, {
          count: hits.length,
          results: hits.map(hitPayload),
        });
        return;
      }

      const contextMatch = /^\/v1\/workspaces\/([^/]+)\/context$/.exec(pathname);
      if (request.method === "POST" && contextMatch) {
        const workspace = await this.repository.requireWorkspace(
          decodeURIComponent(contextMatch[1]),
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
        json(response, 200, {
          task: packed.task,
          packed_text: packed.packedText,
          estimated_tokens: packed.estimatedTokens,
          truncated: packed.truncated,
          hits: packed.hits.map(hitPayload),
        });
        return;
      }

      const fileMatch = /^\/v1\/workspaces\/([^/]+)\/file$/.exec(pathname);
      if (request.method === "GET" && fileMatch) {
        const workspace = await this.repository.requireWorkspace(
          decodeURIComponent(fileMatch[1]),
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
    }
  }

  private resolveLocalRoot(input: string): string {
    if (!this.allowLocalWorkspaces) {
      throw new HttpError(
        403,
        "Local workspaces are disabled; use a blob workspace for remote clients",
      );
    }
    const root = path.resolve(input);
    if (!existsSync(root)) throw new HttpError(400, `Local root does not exist: ${root}`);
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
    const existing = this.engines.get(workspace.id);
    if (existing) return existing;
    const root =
      workspace.sourceMode === "local" && workspace.localRoot
        ? workspace.localRoot
        : path.join(process.cwd(), ".contextengine-http", workspace.id);
    const config = resolveEngineConfig({
      root,
      workspaceId: workspace.id,
      databaseUrl: this.databaseUrl,
    });
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
