import { GitHubConnectorClient } from "../connectors/github.js";
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
  github: GitHubConnectorClient;
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

interface GitHubSourceConfig {
  owner: string;
  repository: string;
  ref: string;
}

function sourceConfig(source: StoredConnectorSource): GitHubSourceConfig {
  const owner = source.config.owner;
  const repository = source.config.repository;
  const ref = source.config.ref;
  if (
    typeof owner !== "string" ||
    typeof repository !== "string" ||
    typeof ref !== "string"
  ) {
    throw new Error("GitHub source configuration is invalid");
  }
  return { owner, repository, ref };
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

export class ConnectorSyncCoordinator {
  private readonly repository: WorkspaceRepository;
  private readonly runner: Pick<IndexJobRunner, "enqueue">;
  private readonly github: GitHubConnectorClient;
  private readonly maxBlobBytes: number;
  private readonly downloadConcurrency: number;
  private readonly secrets: readonly string[];

  constructor(options: ConnectorSyncCoordinatorOptions) {
    this.repository = options.repository;
    this.runner = options.runner;
    this.github = options.github;
    this.maxBlobBytes = options.maxBlobBytes;
    this.downloadConcurrency = boundedConcurrency(options.downloadConcurrency);
    this.secrets = options.secrets ?? [];
  }

  async syncGitHub(
    workspaceId: string,
    sourceId: string,
  ): Promise<ConnectorSyncResult> {
    const source = await this.repository.getConnectorSource(workspaceId, sourceId);
    if (!source) throw new Error("Connector source was not found");
    if (source.provider !== "github") {
      throw new Error(`Unsupported connector provider: ${source.provider}`);
    }
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
      const config = sourceConfig(started);
      const [workspace, previousFiles, tree] = await Promise.all([
        this.repository.requireWorkspace(workspaceId),
        this.repository.listConnectorFiles(sourceId),
        this.github.getTree(config.owner, config.repository, config.ref),
      ]);
      const previous = new Map(previousFiles.map((file) => [file.path, file]));
      const candidates = tree.files.filter((file) => {
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
          const content = await this.github.getBlob(
            config.owner,
            config.repository,
            file.revision,
          );
          if (content.length !== file.bytes) {
            throw new Error(`GitHub tree and Blob sizes differ for ${file.path}`);
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

      for (const file of tree.files) {
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
            rootAlias: `github:${config.owner}/${config.repository}`.slice(0, 100),
          });
        }
      }
      const currentPaths = new Set(tree.files.map((file) => file.path));
      for (const prior of previousFiles) {
        if (!currentPaths.has(prior.path) && prior.contentHash) {
          changes.push({ op: "delete", path: prior.path });
        }
      }

      if (changes.length > 20_000) {
        throw new Error("Connector sync exceeds the 20,000 change limit");
      }

      const cursor = { ref: config.ref, tree_sha: tree.revision };
      if (changes.length === 0) {
        await requireLease();
        const completed = await this.repository.completeConnectorNoop(
          workspaceId,
          attempt,
          cursor,
          tree.revision,
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
          upstreamRevision: tree.revision,
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
          redactedMessage(error, this.secrets),
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
