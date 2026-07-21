import {
  SourceConnectorRegistry,
  type ConnectorSnapshot,
} from "../connectors/types.js";
import type { IndexJobRunner } from "./index-job-runner.js";
import {
  type ConnectorSyncAttempt,
  type StoredConnectorFile,
  type StoredConnectorSource,
  type StoredIndexJob,
  type SyncChange,
  WorkspaceRepository,
} from "./workspace-repository.js";
import { sha256 } from "../util/hash.js";

export interface ConnectorSyncCoordinatorOptions {
  repository: WorkspaceRepository;
  runner: Pick<IndexJobRunner, "enqueue">;
  connectors: SourceConnectorRegistry;
  maxBlobBytes: number;
  downloadConcurrency?: number;
  secrets?: readonly string[];
}

export interface ConnectorSyncResult {
  source: StoredConnectorSource;
  noop: boolean;
  revision: number;
  changedPaths: string[];
  deletedPaths: string[];
  skippedOversized: number;
  indexJob: StoredIndexJob | null;
}

export class ConnectorSyncConflictError extends Error {
  constructor(message = "Connector source changed or is already syncing") {
    super(message);
    this.name = "ConnectorSyncConflictError";
  }
}

function boundedConcurrency(input: number | undefined): number {
  if (input === undefined) return 6;
  if (!Number.isInteger(input) || input < 1 || input > 32) {
    throw new Error("Connector download concurrency must be from 1 to 32");
  }
  return input;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await operation(values[index]);
      }
    }),
  );
  return output;
}

function redactedMessage(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.slice(0, 1000);
}

function connectorSecrets(
  connector: { secrets?: (config: Readonly<Record<string, unknown>>) => readonly string[] },
  config: Readonly<Record<string, unknown>>,
): readonly string[] {
  try {
    return connector.secrets?.(config) ?? [];
  } catch {
    return [];
  }
}

function validatedSnapshot(snapshot: ConnectorSnapshot): ConnectorSnapshot {
  if (!snapshot || typeof snapshot.revision !== "string" || !snapshot.revision) {
    throw new Error("Connector snapshot revision is missing or invalid");
  }
  if (!Array.isArray(snapshot.files) || snapshot.files.length > 20_000) {
    throw new Error("Connector snapshot exceeds the 20,000 file limit");
  }
  if (!snapshot.cursor || Array.isArray(snapshot.cursor) || typeof snapshot.cursor !== "object") {
    throw new Error("Connector snapshot cursor is missing or invalid");
  }
  const paths = new Set<string>();
  const files = snapshot.files.map((file) => {
    const path = typeof file.path === "string"
      ? file.path.replaceAll("\\", "/").replace(/^\.\//, "")
      : "";
    const segments = path.split("/");
    if (
      !path ||
      path.length > 4096 ||
      path.startsWith("/") ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      paths.has(path)
    ) {
      throw new Error("Connector snapshot contains an unsafe or duplicate file path");
    }
    if (typeof file.revision !== "string" || !file.revision) {
      throw new Error(`Connector file revision is invalid for ${path}`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Connector file size is invalid for ${path}`);
    }
    paths.add(path);
    return { path, revision: file.revision, bytes: file.bytes };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { revision: snapshot.revision, cursor: snapshot.cursor, files };
}

export class ConnectorSyncCoordinator {
  private readonly repository: WorkspaceRepository;
  private readonly runner: Pick<IndexJobRunner, "enqueue">;
  private readonly connectors: SourceConnectorRegistry;
  private readonly maxBlobBytes: number;
  private readonly downloadConcurrency: number;
  private readonly secrets: readonly string[];

  constructor(options: ConnectorSyncCoordinatorOptions) {
    this.repository = options.repository;
    this.runner = options.runner;
    this.connectors = options.connectors;
    this.maxBlobBytes = options.maxBlobBytes;
    this.downloadConcurrency = boundedConcurrency(options.downloadConcurrency);
    this.secrets = options.secrets ?? [];
  }

  async sync(
    workspaceId: string,
    sourceId: string,
  ): Promise<ConnectorSyncResult> {
    const source = await this.repository.getConnectorSource(workspaceId, sourceId);
    if (!source) throw new Error("Connector source was not found");
    const connector = this.connectors.require(source.provider);
    const started = await this.repository.beginConnectorSync(
      workspaceId,
      sourceId,
      source.cursorVersion,
    );
    if (!started) throw new ConnectorSyncConflictError();

    const attempt: ConnectorSyncAttempt = {
      sourceId,
      expectedCursorVersion: started.cursorVersion,
      syncAttemptId: started.syncAttemptId,
    };
    let leaseLost = false;
    let renewingLease = false;
    const renewLease = async (): Promise<boolean> => {
      const renewed = await this.repository.renewConnectorSyncLease(workspaceId, attempt);
      if (!renewed) leaseLost = true;
      return renewed;
    };
    const heartbeat = setInterval(() => {
      if (leaseLost || renewingLease) return;
      renewingLease = true;
      void renewLease()
        // A failed heartbeat is retried at the next protected boundary. The
        // token checks on plan/commit still prevent a stale worker from writing.
        .catch(() => undefined)
        .finally(() => {
          renewingLease = false;
        });
    }, 5 * 60 * 1000);
    heartbeat.unref();
    const requireLease = async (): Promise<void> => {
      if (leaseLost || !(await renewLease())) {
        throw new ConnectorSyncConflictError("Connector synchronization lease expired or was taken over");
      }
    };

    let committed = false;
    try {
      const config = started.config;
      const [workspace, previousFiles, rawSnapshot] = await Promise.all([
        this.repository.requireWorkspace(workspaceId),
        this.repository.listConnectorFiles(sourceId),
        connector.listFiles(config, started.cursor),
      ]);
      const snapshot = validatedSnapshot(rawSnapshot);
      const rootAlias = connector.rootAlias(config).trim();
      if (!rootAlias || rootAlias.length > 100 || /[\u0000-\u001f\u007f]/.test(rootAlias)) {
        throw new Error("Connector root alias is invalid");
      }
      const previous = new Map(previousFiles.map((file) => [file.path, file]));
      const candidates = snapshot.files.filter((file) => {
        const prior = previous.get(file.path);
        return (
          file.bytes <= this.maxBlobBytes &&
          (prior?.remoteRevision !== file.revision || prior.contentHash === null)
        );
      });
      const downloaded = await mapConcurrent(
        candidates,
        this.downloadConcurrency,
        async (file) => {
          const content = await connector.readFile(config, file);
          if (content.length !== file.bytes) {
            throw new Error(`Connector snapshot and file sizes differ for ${file.path}`);
          }
          return { file, content, contentHash: sha256(content) };
        },
      );
      const downloadByPath = new Map(downloaded.map((item) => [item.file.path, item]));
      const contentByHash = new Map(
        downloaded.map((item) => [item.contentHash, item.content] as const),
      );
      const currentFiles: StoredConnectorFile[] = [];
      const changes: SyncChange[] = [];
      let skippedOversized = 0;

      for (const file of snapshot.files) {
        const prior = previous.get(file.path);
        if (file.bytes > this.maxBlobBytes) {
          skippedOversized += 1;
          currentFiles.push({
            sourceId,
            path: file.path,
            remoteRevision: file.revision,
            contentHash: null,
            bytes: file.bytes,
          });
          if (prior?.contentHash) changes.push({ op: "delete", path: file.path });
          continue;
        }
        const fetched = downloadByPath.get(file.path);
        const contentHash = fetched?.contentHash ?? prior?.contentHash ?? null;
        if (!contentHash) {
          throw new Error(`Connector content is unavailable for ${file.path}`);
        }
        currentFiles.push({
          sourceId,
          path: file.path,
          remoteRevision: file.revision,
          contentHash,
          bytes: file.bytes,
        });
        if (fetched && fetched.contentHash !== prior?.contentHash) {
          changes.push({
            op: "upsert",
            path: file.path,
            blobHash: contentHash,
            size: file.bytes,
            mtimeMs: 0,
            rootAlias,
          });
        }
      }
      const currentPaths = new Set(snapshot.files.map((file) => file.path));
      for (const prior of previousFiles) {
        if (!currentPaths.has(prior.path) && prior.contentHash) {
          changes.push({ op: "delete", path: prior.path });
        }
      }

      if (changes.length > 20_000) {
        throw new Error("Connector sync exceeds the 20,000 change limit");
      }

      const cursor = snapshot.cursor;
      if (changes.length === 0) {
        await requireLease();
        const completed = await this.repository.completeConnectorNoop(
          workspaceId,
          attempt,
          cursor,
          snapshot.revision,
          currentFiles,
        );
        if (!completed) throw new ConnectorSyncConflictError();
        committed = true;
        return {
          source: completed,
          noop: true,
          revision: workspace.revision,
          changedPaths: [],
          deletedPaths: [],
          skippedOversized,
          indexJob: null,
        };
      }

      const plan = await this.repository.createSyncPlan(
        workspaceId,
        workspace.revision,
        changes,
        15 * 60 * 1000,
        false,
        attempt,
      );
      await mapConcurrent(plan.missingBlobs, this.downloadConcurrency, async (hash) => {
        const content = contentByHash.get(hash);
        if (!content) throw new Error("A connector Blob required by the sync plan is unavailable");
        await this.repository.putBlobForSync(
          workspaceId,
          plan.id,
          hash,
          content,
          attempt,
        );
      });
      await requireLease();
      const commit = await this.repository.commitSync(workspaceId, plan.id, {
        createIndexJob: true,
        connector: {
          sourceId,
          expectedCursorVersion: started.cursorVersion,
          syncAttemptId: started.syncAttemptId,
          cursor,
          upstreamRevision: snapshot.revision,
          files: currentFiles,
        },
      });
      committed = true;
      if (commit.indexJob) this.runner.enqueue(commit.indexJob.id);
      const completed = await this.repository.getConnectorSource(workspaceId, sourceId);
      if (!completed) throw new Error("Connector source disappeared after sync");
      return {
        source: completed,
        noop: false,
        revision: commit.revision,
        changedPaths: commit.changedPaths,
        deletedPaths: commit.deletedPaths,
        skippedOversized,
        indexJob: commit.indexJob ?? null,
      };
    } catch (error) {
      if (!committed) {
        await this.repository.failConnectorSync(
          workspaceId,
          attempt,
          redactedMessage(error, [
            ...this.secrets,
            ...connectorSecrets(connector, started.config),
          ]),
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Backwards-compatible alias for callers introduced before provider plugins. */
  syncGitHub(workspaceId: string, sourceId: string): Promise<ConnectorSyncResult> {
    return this.sync(workspaceId, sourceId);
  }
}
