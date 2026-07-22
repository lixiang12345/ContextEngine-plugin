import { SourceConnectorError, type ConnectorFileSnapshot } from "./types.js";

const DEFAULT_GITLAB_API_BASE_URL = "https://gitlab.com/api/v4";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_METADATA_CONCURRENCY = 8;
const PAGE_SIZE = 100;

export interface GitLabTreeFile {
  path: string;
  revision: string;
  bytes: number;
}

export interface GitLabTreeSnapshot {
  revision: string;
  files: GitLabTreeFile[];
}

export interface GitLabConnectorClientOptions {
  token?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxFiles?: number;
  metadataConcurrency?: number;
  fetch?: typeof fetch;
}

interface GitLabCommitResponse {
  id?: unknown;
}

interface GitLabBlobResponse {
  content?: unknown;
  encoding?: unknown;
  sha?: unknown;
  size?: unknown;
}

interface GitLabTreeEntry {
  id?: unknown;
  path?: unknown;
  type?: unknown;
}

export class GitLabConnectorError extends SourceConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "GitLabConnectorError";
  }
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`GitLab ${label} must be from 1 to ${maximum}`);
  }
  return value;
}

function safeApiBaseUrl(input: string | undefined): string {
  const parsed = new URL(input ?? DEFAULT_GITLAB_API_BASE_URL);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("GitLab API base URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("GitLab API base URL must not contain credentials");
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "[::1]"
  ) {
    throw new Error("GitLab API base URL must use https unless it is loopback");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizedGitPath(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) {
    return null;
  }
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return null;
  }
  return path;
}

function objectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) {
    throw new GitLabConnectorError(`GitLab ${label} is missing or invalid`);
  }
  return value.toLowerCase();
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await operation(values[index]);
      }
    },
  ));
  return output;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GitLabConnectorError("GitLab response exceeds the configured byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new GitLabConnectorError("GitLab response exceeds the configured byte limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}

export class GitLabConnectorClient {
  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;
  private readonly metadataConcurrency: number;
  private readonly requestFetch: typeof fetch;

  constructor(options: GitLabConnectorClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.apiBaseUrl = safeApiBaseUrl(options.apiBaseUrl);
    this.timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000, "timeout");
    this.maxFiles = boundedPositive(options.maxFiles, DEFAULT_MAX_FILES, 20_000, "file limit");
    this.metadataConcurrency = boundedPositive(
      options.metadataConcurrency,
      DEFAULT_METADATA_CONCURRENCY,
      32,
      "metadata concurrency",
    );
    this.requestFetch = options.fetch ?? fetch;
  }

  async getTree(
    project: string,
    ref: string,
    previousFiles: readonly ConnectorFileSnapshot[] = [],
  ): Promise<GitLabTreeSnapshot> {
    const projectId = encodeURIComponent(project);
    const commit = await this.requestJson<GitLabCommitResponse>(
      `/projects/${projectId}/repository/commits/${encodeURIComponent(ref)}?stats=false`,
      "commit request",
      1024 * 1024,
    );
    const revision = objectId(commit.id, "commit revision");
    const entries: Array<{ path: string; revision: string }> = [];
    const paths = new Set<string>();
    const maxTreeEntries = this.maxFiles * 2;
    const maximumPages = Math.ceil(maxTreeEntries / PAGE_SIZE) + 1;
    let treeEntries = 0;
    for (let page = 1; page <= maximumPages; page++) {
      const payload = await this.requestJson<unknown>(
        `/projects/${projectId}/repository/tree?recursive=true&per_page=${PAGE_SIZE}` +
          `&page=${page}&ref=${encodeURIComponent(revision)}`,
        "tree request",
        5 * 1024 * 1024,
      );
      if (!Array.isArray(payload)) {
        throw new GitLabConnectorError("GitLab tree response is missing its entries");
      }
      if (payload.length > PAGE_SIZE) {
        throw new GitLabConnectorError("GitLab tree page exceeds the requested page size");
      }
      for (const raw of payload) {
        treeEntries += 1;
        if (treeEntries > maxTreeEntries) {
          throw new GitLabConnectorError(
            `GitLab repository exceeds the ${maxTreeEntries} tree-entry limit`,
          );
        }
        if (!raw || typeof raw !== "object") continue;
        const item = raw as GitLabTreeEntry;
        if (item.type !== "blob") continue;
        const path = normalizedGitPath(item.path);
        if (!path) throw new GitLabConnectorError("GitLab tree contains an unsafe file path");
        if (paths.has(path)) {
          throw new GitLabConnectorError("GitLab tree contains duplicate file paths");
        }
        paths.add(path);
        entries.push({ path, revision: objectId(item.id, "Blob revision") });
        if (entries.length > this.maxFiles) {
          throw new GitLabConnectorError(
            `GitLab repository exceeds the ${this.maxFiles} file sync limit`,
          );
        }
      }
      if (payload.length < PAGE_SIZE) break;
      if (page === maximumPages) {
        throw new GitLabConnectorError("GitLab repository tree pagination exceeds the limit");
      }
    }
    const previous = new Map(previousFiles.map((file) => [file.path, file]));
    const files = await mapConcurrent(entries, this.metadataConcurrency, async (entry) => {
      const prior = previous.get(entry.path);
      const bytes = prior?.revision === entry.revision
        ? prior.bytes
        : await this.getFileSize(projectId, entry.path, revision, entry.revision);
      return { ...entry, bytes };
    });
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { revision, files };
  }

  async getBlob(project: string, revision: string, expectedBytes: number): Promise<Buffer> {
    const blobId = objectId(revision, "Blob revision");
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw new GitLabConnectorError("GitLab expected Blob size is invalid");
    }
    const maximumResponseBytes = Math.max(
      1024 * 1024,
      Math.ceil(expectedBytes * 4 / 3) + 64 * 1024,
    );
    const payload = await this.requestJson<GitLabBlobResponse>(
      `/projects/${encodeURIComponent(project)}/repository/blobs/${blobId}`,
      "Blob request",
      maximumResponseBytes,
    );
    if (payload.encoding !== "base64" || typeof payload.content !== "string") {
      throw new GitLabConnectorError("GitLab Blob response is not base64 encoded");
    }
    if (objectId(payload.sha, "Blob response revision") !== blobId) {
      throw new GitLabConnectorError("GitLab Blob response revision does not match the tree");
    }
    const declaredBytes = Number(payload.size);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== expectedBytes) {
      throw new GitLabConnectorError("GitLab Blob response size does not match the tree");
    }
    const encoded = payload.content.replace(/\s+/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new GitLabConnectorError("GitLab Blob response contains invalid base64");
    }
    const content = Buffer.from(encoded, "base64");
    if (content.length !== expectedBytes) {
      throw new GitLabConnectorError("GitLab Blob response size does not match its content");
    }
    return content;
  }

  private async getFileSize(
    encodedProject: string,
    path: string,
    ref: string,
    expectedRevision: string,
  ): Promise<number> {
    const response = await this.request(
      `/projects/${encodedProject}/repository/files/${encodeURIComponent(path)}` +
        `?ref=${encodeURIComponent(ref)}`,
      "file metadata request",
      "HEAD",
    );
    if (!response.ok) {
      const text = await boundedText(response, 64 * 1024);
      throw this.httpError("file metadata request", response.status, text);
    }
    const revision = response.headers.get("x-gitlab-blob-id");
    if (objectId(revision, "file metadata revision") !== expectedRevision) {
      throw new GitLabConnectorError("GitLab file metadata revision does not match the tree");
    }
    const bytes = Number(response.headers.get("x-gitlab-size"));
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new GitLabConnectorError("GitLab file metadata size is invalid");
    }
    return bytes;
  }

  private async requestJson<T>(
    path: string,
    operation: string,
    maxBytes: number,
  ): Promise<T> {
    const response = await this.request(path, operation, "GET");
    const text = await boundedText(response, maxBytes);
    if (!response.ok) throw this.httpError(operation, response.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitLabConnectorError(`GitLab ${operation} returned invalid JSON`);
    }
  }

  private async request(
    path: string,
    operation: string,
    method: "GET" | "HEAD",
  ): Promise<Response> {
    try {
      return await this.requestFetch(`${this.apiBaseUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "User-Agent": "ContextEngine-Connector",
          ...(this.token ? { "PRIVATE-TOKEN": this.token } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      throw new GitLabConnectorError(`GitLab ${operation} failed: ${message}`);
    }
  }

  private httpError(operation: string, status: number, body: string): GitLabConnectorError {
    return new GitLabConnectorError(
      `GitLab ${operation} failed with HTTP ${status}: ${this.redact(body).slice(0, 300)}`,
    );
  }

  private redact(value: string): string {
    return this.token ? value.replaceAll(this.token, "[redacted]") : value;
  }
}
