import {
  GitHubConnectorClient,
  GitHubConnectorError,
} from "./github.js";
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
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

  constructor(private readonly client: GitHubConnectorClient) {}

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
