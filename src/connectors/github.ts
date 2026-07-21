const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES = 20_000;

export interface GitHubTreeFile {
  path: string;
  revision: string;
  bytes: number;
}

export interface GitHubTreeSnapshot {
  revision: string;
  files: GitHubTreeFile[];
}

export interface GitHubConnectorClientOptions {
  token?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxFiles?: number;
  fetch?: typeof fetch;
}

interface GitHubTreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: unknown;
}

interface GitHubBlobResponse {
  content?: unknown;
  encoding?: unknown;
  size?: unknown;
}

export class GitHubConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConnectorError";
  }
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("GitHub connector limits must be positive integers");
  }
  return value;
}

function safeApiBaseUrl(input: string | undefined): string {
  const parsed = new URL(input ?? DEFAULT_GITHUB_API_BASE_URL);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("GitHub API base URL must use http or https");
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "[::1]"
  ) {
    throw new Error("GitHub API base URL must use https unless it is loopback");
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
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
}

function expectedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubConnectorError(`GitHub ${label} is missing or invalid`);
  }
  return value;
}

export class GitHubConnectorClient {
  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;
  private readonly requestFetch: typeof fetch;

  constructor(options: GitHubConnectorClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.apiBaseUrl = safeApiBaseUrl(options.apiBaseUrl);
    this.timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxFiles = boundedPositive(options.maxFiles, DEFAULT_MAX_FILES);
    this.requestFetch = options.fetch ?? fetch;
  }

  async getTree(owner: string, repository: string, ref: string): Promise<GitHubTreeSnapshot> {
    const payload = await this.requestJson<GitHubTreeResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
        `/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      "tree request",
    );
    if (payload.truncated === true) {
      throw new GitHubConnectorError(
        "GitHub returned a truncated repository tree; narrow the repository before syncing",
      );
    }
    if (!Array.isArray(payload.tree)) {
      throw new GitHubConnectorError("GitHub tree response is missing its entries");
    }
    const files: GitHubTreeFile[] = [];
    const paths = new Set<string>();
    for (const raw of payload.tree) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.type !== "blob") continue;
      const path = normalizedGitPath(item.path);
      if (!path) {
        throw new GitHubConnectorError("GitHub tree contains an unsafe file path");
      }
      if (paths.has(path)) {
        throw new GitHubConnectorError("GitHub tree contains duplicate file paths");
      }
      const revision = expectedString(item.sha, "Blob revision");
      const bytes = Number(item.size);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new GitHubConnectorError("GitHub tree contains an invalid Blob size");
      }
      paths.add(path);
      files.push({ path, revision, bytes });
      if (files.length > this.maxFiles) {
        throw new GitHubConnectorError(
          `GitHub repository exceeds the ${this.maxFiles} file sync limit`,
        );
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
      revision: expectedString(payload.sha, "tree revision"),
      files,
    };
  }

  async getBlob(owner: string, repository: string, revision: string): Promise<Buffer> {
    const payload = await this.requestJson<GitHubBlobResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
        `/git/blobs/${encodeURIComponent(revision)}`,
      "Blob request",
    );
    if (payload.encoding !== "base64" || typeof payload.content !== "string") {
      throw new GitHubConnectorError("GitHub Blob response is not base64 encoded");
    }
    const content = Buffer.from(payload.content.replace(/\s+/g, ""), "base64");
    const expectedBytes = Number(payload.size);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw new GitHubConnectorError("GitHub Blob response has an invalid size");
    }
    if (content.length !== expectedBytes) {
      throw new GitHubConnectorError("GitHub Blob response size does not match its content");
    }
    return content;
  }

  private async requestJson<T>(path: string, operation: string): Promise<T> {
    let response: Response;
    try {
      response = await this.requestFetch(`${this.apiBaseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ContextEngine-Connector",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      throw new GitHubConnectorError(`GitHub ${operation} failed: ${message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GitHubConnectorError(
        `GitHub ${operation} failed with HTTP ${response.status}: ${this.redact(text).slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitHubConnectorError(`GitHub ${operation} returned invalid JSON`);
    }
  }

  private redact(value: string): string {
    return this.token ? value.replaceAll(this.token, "[redacted]") : value;
  }
}
