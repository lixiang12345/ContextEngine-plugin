import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BitbucketConnectorClient,
  BitbucketConnectorError,
} from "./bitbucket.js";
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
  SourceConnectorWebhookHandler,
  VerifiedConnectorWebhookEvent,
} from "./types.js";

interface BitbucketSourceConfig extends Record<string, unknown> {
  workspace: string;
  repository: string;
  ref: string;
}

function field(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new BitbucketConnectorError(`Bitbucket ${key} is invalid`);
  return value.trim();
}

function bitbucketConfig(input: unknown): BitbucketSourceConfig {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new BitbucketConnectorError("Bitbucket source configuration must be an object");
  }
  const value = input as Record<string, unknown>;
  const workspace = field(value, "workspace", 100);
  const repository = field(value, "repository", 100);
  if (!/^[A-Za-z0-9_.-]+$/.test(workspace) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new BitbucketConnectorError("Bitbucket workspace or repository is invalid");
  }
  return {
    workspace,
    repository,
    ref: value.ref === undefined ? "HEAD" : field(value, "ref", 255),
  };
}

export class BitbucketSourceConnector implements SourceConnectorPlugin {
  readonly provider = "bitbucket";
  readonly displayName = "Bitbucket Cloud";
  readonly webhook?: SourceConnectorWebhookHandler;
  private readonly locations = new Map<string, string>();

  constructor(
    private readonly client: BitbucketConnectorClient,
    webhookSecret?: string,
  ) {
    const secret = webhookSecret?.trim();
    if (secret && (secret.length < 16 || /[\u0000-\u001f\u007f]/.test(secret))) {
      throw new Error("Bitbucket webhook secret must contain at least 16 safe characters");
    }
    if (secret) this.webhook = bitbucketWebhook(secret);
  }

  validateConfig(input: unknown): BitbucketSourceConfig {
    return bitbucketConfig(input);
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    const value = bitbucketConfig(config);
    return `${value.workspace}/${value.repository}`;
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    return `bitbucket:${this.externalId(config)}`.slice(0, 100);
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    previousCursor: Readonly<Record<string, unknown>> | null,
    previousFiles: readonly ConnectorFileSnapshot[] = [],
  ): Promise<ConnectorSnapshot> {
    const value = bitbucketConfig(config);
    const previousCommit = previousCursor?.kind === "bitbucket-v1" &&
        typeof previousCursor.commit_hash === "string"
      ? previousCursor.commit_hash
      : null;
    const tree = await this.client.getTree(
      value.workspace,
      value.repository,
      value.ref,
      previousCommit,
      previousFiles,
    );
    for (const file of tree.files) {
      const key = this.locationKey(value, file);
      this.locations.delete(key);
      this.locations.set(key, tree.revision);
    }
    while (this.locations.size > 50_000) {
      const oldest = this.locations.keys().next().value;
      if (!oldest) break;
      this.locations.delete(oldest);
    }
    return {
      revision: tree.revision,
      files: tree.files,
      cursor: { kind: "bitbucket-v1", ref: value.ref, commit_hash: tree.revision },
    };
  }

  readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const value = bitbucketConfig(config);
    const commit = this.locations.get(this.locationKey(value, file));
    if (!commit) {
      throw new BitbucketConnectorError("Bitbucket file location is unavailable for this snapshot");
    }
    return this.client.getFile(value.workspace, value.repository, commit, file);
  }

  private locationKey(
    config: BitbucketSourceConfig,
    file: Readonly<ConnectorFileSnapshot>,
  ): string {
    return `${config.workspace}/${config.repository}\0${file.path}\0${file.revision}`;
  }
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string {
  return headers[name]?.trim() ?? "";
}

function bitbucketWebhook(secret: string): SourceConnectorWebhookHandler {
  const key = Buffer.from(secret, "utf8");
  const handler: SourceConnectorWebhookHandler = {
    verify(request): VerifiedConnectorWebhookEvent {
      const signature = header(request.headers, "x-hub-signature");
      if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
        throw new BitbucketConnectorError("Bitbucket webhook signature is invalid");
      }
      const expected = createHmac("sha256", key).update(request.body).digest();
      const candidate = Buffer.from(signature.slice(7), "hex");
      if (!timingSafeEqual(expected, candidate)) {
        throw new BitbucketConnectorError("Bitbucket webhook signature is invalid");
      }
      const id = header(request.headers, "x-request-uuid");
      if (!id || id.length > 200 || !/^[A-Za-z0-9{}._:-]+$/.test(id)) {
        throw new BitbucketConnectorError("Bitbucket webhook delivery id is invalid");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString("utf8"));
      } catch {
        throw new BitbucketConnectorError("Bitbucket webhook body is invalid");
      }
      if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        throw new BitbucketConnectorError("Bitbucket webhook body is invalid");
      }
      const value = payload as Record<string, unknown>;
      const repository = value.repository;
      if (!repository || Array.isArray(repository) || typeof repository !== "object") {
        throw new BitbucketConnectorError("Bitbucket webhook repository is invalid");
      }
      const repositoryValue = repository as Record<string, unknown>;
      const externalId = repositoryValue.full_name;
      if (
        typeof externalId !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(externalId) ||
        externalId.length > 201
      ) throw new BitbucketConnectorError("Bitbucket webhook repository is invalid");
      const branches: string[] = [];
      const push = value.push;
      if (push && !Array.isArray(push) && typeof push === "object") {
        const changes = (push as Record<string, unknown>).changes;
        if (Array.isArray(changes) && changes.length <= 100) {
          for (const change of changes) {
            if (!change || Array.isArray(change) || typeof change !== "object") continue;
            const changed = change as Record<string, unknown>;
            const target = changed.new;
            if (!target || Array.isArray(target) || typeof target !== "object") continue;
            const targetValue = target as Record<string, unknown>;
            if (targetValue.type !== "branch" || typeof targetValue.name !== "string") continue;
            if (targetValue.name.length <= 255) branches.push(targetValue.name);
          }
        }
      }
      const mainBranch = repositoryValue.mainbranch;
      const defaultBranch = mainBranch && !Array.isArray(mainBranch) && typeof mainBranch === "object"
        ? (mainBranch as Record<string, unknown>).name
        : null;
      const event = header(request.headers, "x-event-key");
      const uniqueBranches = [...new Set(branches)].sort();
      return {
        id,
        externalId,
        action: event === "repo:push" && branches.length ? "sync" : "ignore",
        metadata: {
          branches: JSON.stringify(uniqueBranches.slice(0, 15)),
          all_branches: uniqueBranches.length > 15,
          default_branch:
            typeof defaultBranch === "string" && defaultBranch.length <= 255
              ? defaultBranch
              : null,
        },
      };
    },
    matchesConfig(event, config): boolean {
      if (event.action !== "sync") return false;
      const value = bitbucketConfig(config);
      let branches: unknown;
      try {
        branches = JSON.parse(String(event.metadata?.branches ?? ""));
      } catch {
        return false;
      }
      if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== "string")) {
        return false;
      }
      const ref = value.ref === "HEAD" ? event.metadata?.default_branch : value.ref;
      return typeof ref === "string" &&
        (event.metadata?.all_branches === true || branches.includes(ref));
    },
  };
  return Object.freeze(handler);
}
