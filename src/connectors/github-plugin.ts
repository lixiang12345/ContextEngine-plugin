import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  GitHubConnectorClient,
  GitHubConnectorError,
} from "./github.js";
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
  SourceConnectorWebhookHandler,
  VerifiedConnectorWebhookEvent,
} from "./types.js";

interface GitHubSourceConfig extends Record<string, unknown> {
  owner: string;
  repository: string;
  ref: string;
}

function stringField(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GitHubConnectorError(`GitHub ${key} is invalid`);
  }
  return value.trim();
}

function githubConfig(input: unknown): GitHubSourceConfig {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new GitHubConnectorError("GitHub source configuration must be an object");
  }
  const value = input as Record<string, unknown>;
  const owner = stringField(value, "owner", 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new GitHubConnectorError("GitHub owner is invalid");
  }
  const repository = stringField(value, "repository", 100);
  if (repository.includes("/")) {
    throw new GitHubConnectorError("GitHub repository is invalid");
  }
  return {
    owner,
    repository,
    ref: value.ref === undefined ? "HEAD" : stringField(value, "ref", 255),
  };
}

export class GitHubSourceConnector implements SourceConnectorPlugin {
  readonly provider = "github";
  readonly displayName = "GitHub";

  readonly webhook?: SourceConnectorWebhookHandler;

  constructor(
    private readonly client: GitHubConnectorClient,
    webhookSecret?: string,
  ) {
    const secret = webhookSecret?.trim();
    if (secret && secret.length < 16) {
      throw new Error("GitHub webhook secret must contain at least 16 characters");
    }
    if (secret) this.webhook = githubWebhookHandler(secret);
  }

  validateConfig(input: unknown): GitHubSourceConfig {
    return githubConfig(input);
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    const value = githubConfig(config);
    return `${value.owner}/${value.repository}`;
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    return `github:${this.externalId(config)}`.slice(0, 100);
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    _previousCursor: Readonly<Record<string, unknown>> | null,
  ): Promise<ConnectorSnapshot> {
    const value = githubConfig(config);
    const tree = await this.client.getTree(value.owner, value.repository, value.ref);
    return {
      revision: tree.revision,
      files: tree.files,
      cursor: { ref: value.ref, tree_sha: tree.revision },
    };
  }

  readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const value = githubConfig(config);
    return this.client.getBlob(value.owner, value.repository, file.revision);
  }
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  return headers[name]?.trim() ?? "";
}

function githubWebhookHandler(secret: string): SourceConnectorWebhookHandler {
  const secretBytes = Buffer.from(secret, "utf8");
  const handler: SourceConnectorWebhookHandler = {
    verify(request): VerifiedConnectorWebhookEvent {
      const signature = header(request.headers, "x-hub-signature-256");
      if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
        throw new GitHubConnectorError("GitHub webhook signature is invalid");
      }
      const expected = createHmac("sha256", secretBytes)
        .update(request.body)
        .digest();
      const candidate = Buffer.from(signature.slice("sha256=".length), "hex");
      if (!timingSafeEqual(expected, candidate)) {
        throw new GitHubConnectorError("GitHub webhook signature is invalid");
      }
      const delivery = header(request.headers, "x-github-delivery");
      if (!delivery || delivery.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(delivery)) {
        throw new GitHubConnectorError("GitHub webhook delivery id is invalid");
      }
      const eventName = header(request.headers, "x-github-event");
      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString("utf8"));
      } catch {
        throw new GitHubConnectorError("GitHub webhook body is invalid");
      }
      if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        throw new GitHubConnectorError("GitHub webhook body is invalid");
      }
      const value = payload as Record<string, unknown>;
      const repository = value.repository;
      if (!repository || Array.isArray(repository) || typeof repository !== "object") {
        throw new GitHubConnectorError("GitHub webhook repository is invalid");
      }
      const repositoryValue = repository as Record<string, unknown>;
      const externalId = repositoryValue.full_name;
      if (
        typeof externalId !== "string" ||
        !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(externalId) ||
        externalId.length > 140
      ) {
        throw new GitHubConnectorError("GitHub webhook repository is invalid");
      }
      const defaultBranch = repositoryValue.default_branch;
      const ref = value.ref;
      const deleted = value.deleted === true;
      return {
        id: delivery,
        externalId,
        action: eventName === "push" && !deleted ? "sync" : "ignore",
        metadata: {
          ref: typeof ref === "string" && ref.length <= 300 ? ref : null,
          default_branch:
            typeof defaultBranch === "string" && defaultBranch.length <= 255
              ? defaultBranch
              : null,
        },
      };
    },
    matchesConfig(event, config): boolean {
      if (event.action !== "sync") return false;
      const value = githubConfig(config);
      const ref = event.metadata?.ref;
      if (typeof ref !== "string") return false;
      const configuredRef = value.ref === "HEAD"
        ? event.metadata?.default_branch
        : value.ref;
      if (typeof configuredRef !== "string" || !configuredRef) return false;
      return ref === configuredRef || ref === `refs/heads/${configuredRef}`;
    },
  };
  return Object.freeze(handler);
}
