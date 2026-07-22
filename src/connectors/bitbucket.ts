import { SourceConnectorError, type ConnectorFileSnapshot } from "./types.js";

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org/2.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_METADATA_CONCURRENCY = 8;
const PAGE_SIZE = 100;

export interface BitbucketTreeSnapshot {
  revision: string;
  files: ConnectorFileSnapshot[];
}

export interface BitbucketConnectorClientOptions {
  token?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxFiles?: number;
  metadataConcurrency?: number;
  fetch?: typeof fetch;
}

interface CommitResponse {
  hash?: unknown;
}

interface TreePage {
  values?: unknown;
  next?: unknown;
}

export class BitbucketConnectorError extends SourceConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "BitbucketConnectorError";
  }
}

function boundedPositive(value: number | undefined, fallback: number, max: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Bitbucket ${label} must be from 1 to ${max}`);
  }
  return value;
}

function safeApiBaseUrl(input: string | undefined): string {
  const url = new URL(input ?? DEFAULT_API_BASE_URL);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Bitbucket API base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Bitbucket API base URL must not contain credentials");
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "[::1]"
  ) {
    throw new Error("Bitbucket API base URL must use https unless it is loopback");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function safePath(input: unknown): string | null {
  if (typeof input !== "string" || !input || input.length > 4096) return null;
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  return path;
}

function commitHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new BitbucketConnectorError("Bitbucket commit hash is missing or invalid");
  }
  return value.toLowerCase();
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function boundedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new BitbucketConnectorError("Bitbucket response exceeds the configured byte limit");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BitbucketConnectorError("Bitbucket response exceeds the configured byte limit");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await operation(values[index]);
    }
  }));
  return output;
}

export class BitbucketConnectorClient {
  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;
  private readonly metadataConcurrency: number;
  private readonly requestFetch: typeof fetch;

  constructor(options: BitbucketConnectorClientOptions = {}) {
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
    workspace: string,
    repository: string,
    ref: string,
    previousCommit: string | null = null,
    previousFiles: readonly ConnectorFileSnapshot[] = [],
  ): Promise<BitbucketTreeSnapshot> {
    const basePath = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}`;
    const commit = await this.requestJson<CommitResponse>(
      `${basePath}/commit/${encodeURIComponent(ref)}`,
      "commit request",
      1024 * 1024,
    );
    const revision = commitHash(commit.hash);
    if (previousCommit === revision) {
      return {
        revision,
        files: [...previousFiles].sort((a, b) => a.path.localeCompare(b.path)),
      };
    }

    const files: Array<{ path: string; listedBytes: number | null }> = [];
    const directories = [""];
    const seenDirectories = new Set([""]);
    const seenPaths = new Set<string>();
    let treeEntries = 0;
    let pages = 0;
    const maxTreeEntries = this.maxFiles * 2;
    const maxPages = Math.ceil(maxTreeEntries / PAGE_SIZE) + this.maxFiles;

    while (directories.length) {
      const directory = directories.shift()!;
      let next: string | null = `${this.apiBaseUrl}${basePath}/src/${revision}/` +
        `${directory ? encodedPath(directory) : ""}?pagelen=${PAGE_SIZE}`;
      while (next) {
        pages += 1;
        if (pages > maxPages) {
          throw new BitbucketConnectorError("Bitbucket source pagination exceeds the limit");
        }
        const page: TreePage = await this.requestJson<TreePage>(
          this.safeNextUrl(next, `${basePath}/src/${revision}/`),
          "source tree request",
          5 * 1024 * 1024,
          true,
        );
        if (!Array.isArray(page.values)) {
          throw new BitbucketConnectorError("Bitbucket source page is missing values");
        }
        if (page.values.length > PAGE_SIZE) {
          throw new BitbucketConnectorError("Bitbucket source page exceeds pagelen");
        }
        for (const raw of page.values) {
          treeEntries += 1;
          if (treeEntries > maxTreeEntries) {
            throw new BitbucketConnectorError(
              `Bitbucket repository exceeds the ${maxTreeEntries} tree-entry limit`,
            );
          }
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          const path = safePath(item.path);
          if (!path) throw new BitbucketConnectorError("Bitbucket tree contains an unsafe path");
          if (item.type === "commit_directory") {
            if (!seenDirectories.has(path)) {
              seenDirectories.add(path);
              directories.push(path);
            }
            continue;
          }
          if (item.type !== "commit_file") continue;
          if (seenPaths.has(path)) {
            throw new BitbucketConnectorError("Bitbucket tree contains a duplicate file path");
          }
          seenPaths.add(path);
          const listed = Number(item.size);
          files.push({
            path,
            listedBytes: Number.isSafeInteger(listed) && listed >= 0 ? listed : null,
          });
          if (files.length > this.maxFiles) {
            throw new BitbucketConnectorError(
              `Bitbucket repository exceeds the ${this.maxFiles} file sync limit`,
            );
          }
        }
        next = page.next === undefined
          ? null
          : this.safeNextUrl(page.next, `${basePath}/src/${revision}/`);
      }
      directories.sort((a, b) => a.localeCompare(b));
    }

    const snapshots = await mapConcurrent(files, this.metadataConcurrency, async (file) => {
      const response = await this.request(
        `${basePath}/src/${revision}/${encodedPath(file.path)}`,
        "file metadata request",
        "HEAD",
      );
      if (!response.ok) throw await this.httpError("file metadata request", response);
      const etag = response.headers.get("etag")?.trim();
      if (!etag || etag.length > 500 || /[\u0000-\u001f\u007f]/.test(etag)) {
        throw new BitbucketConnectorError("Bitbucket file ETag is missing or invalid");
      }
      const declared = response.headers.get("content-length");
      const bytes: number | null = declared === null ? file.listedBytes : Number(declared);
      if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new BitbucketConnectorError("Bitbucket file size is missing or invalid");
      }
      return { path: file.path, revision: etag, bytes };
    });
    snapshots.sort((a, b) => a.path.localeCompare(b.path));
    return { revision, files: snapshots };
  }

  async getFile(
    workspace: string,
    repository: string,
    commit: string,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const revision = commitHash(commit);
    const path = safePath(file.path);
    if (!path || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new BitbucketConnectorError("Bitbucket file snapshot is invalid");
    }
    const response = await this.request(
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}` +
        `/src/${revision}/${encodedPath(path)}`,
      "file request",
      "GET",
    );
    if (!response.ok) throw await this.httpError("file request", response);
    const etag = response.headers.get("etag")?.trim();
    if (!etag || etag !== file.revision) {
      throw new BitbucketConnectorError("Bitbucket file ETag does not match the snapshot");
    }
    const content = await boundedBuffer(response, file.bytes);
    if (content.length !== file.bytes) {
      throw new BitbucketConnectorError("Bitbucket file size does not match its metadata");
    }
    return content;
  }

  private safeNextUrl(input: unknown, expectedPathPrefix: string): string {
    if (typeof input !== "string" || input.length > 4096) {
      throw new BitbucketConnectorError("Bitbucket pagination next URL is invalid");
    }
    const url = new URL(input, this.apiBaseUrl);
    const base = new URL(this.apiBaseUrl);
    const expected = `${base.pathname.replace(/\/$/, "")}${expectedPathPrefix}`;
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(expected) ||
      url.hash
    ) {
      throw new BitbucketConnectorError("Bitbucket pagination next URL left the API scope");
    }
    return url.toString();
  }

  private async requestJson<T>(
    pathOrUrl: string,
    operation: string,
    maxBytes: number,
    absolute = false,
  ): Promise<T> {
    const response = await this.request(pathOrUrl, operation, "GET", absolute);
    const body = await boundedBuffer(response, maxBytes);
    if (!response.ok) throw this.httpErrorFromBody(operation, response.status, body);
    try {
      return JSON.parse(body.toString("utf8")) as T;
    } catch {
      throw new BitbucketConnectorError(`Bitbucket ${operation} returned invalid JSON`);
    }
  }

  private async request(
    pathOrUrl: string,
    operation: string,
    method: "GET" | "HEAD",
    absolute = false,
  ): Promise<Response> {
    try {
      return await this.requestFetch(absolute ? pathOrUrl : `${this.apiBaseUrl}${pathOrUrl}`, {
        method,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "User-Agent": "ContextEngine-Connector",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      throw new BitbucketConnectorError(`Bitbucket ${operation} failed: ${message}`);
    }
  }

  private async httpError(operation: string, response: Response): Promise<BitbucketConnectorError> {
    const body = await boundedBuffer(response, 64 * 1024);
    return this.httpErrorFromBody(operation, response.status, body);
  }

  private httpErrorFromBody(operation: string, status: number, body: Buffer) {
    return new BitbucketConnectorError(
      `Bitbucket ${operation} failed with HTTP ${status}: ` +
        this.redact(body.toString("utf8")).slice(0, 300),
    );
  }

  private redact(value: string) {
    return this.token ? value.replaceAll(this.token, "[redacted]") : value;
  }
}
