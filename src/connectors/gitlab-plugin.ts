import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  GitLabConnectorClient,
  GitLabConnectorError,
} from "./gitlab.js";
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
  SourceConnectorWebhookHandler,
  VerifiedConnectorWebhookEvent,
} from "./types.js";

interface GitLabSourceConfig extends Record<string, unknown> {
  project: string;
  ref: string;
}

export interface GitLabWebhookOptions {
  signingToken?: string;
  secretToken?: string;
  now?: () => number;
  timestampToleranceMs?: number;
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
    throw new GitLabConnectorError(`GitLab ${key} is invalid`);
  }
  return value.trim();
}

function gitLabConfig(input: unknown): GitLabSourceConfig {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new GitLabConnectorError("GitLab source configuration must be an object");
  }
  const value = input as Record<string, unknown>;
  const project = stringField(value, "project", 512);
  if (
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project) ||
    project.split("/").some((segment) => segment.length > 255)
  ) {
    throw new GitLabConnectorError("GitLab project must be a namespace/project path");
  }
  return {
    project,
    ref: value.ref === undefined ? "HEAD" : stringField(value, "ref", 255),
  };
}

export class GitLabSourceConnector implements SourceConnectorPlugin {
  readonly provider = "gitlab";
  readonly displayName = "GitLab";
  readonly webhook?: SourceConnectorWebhookHandler;

  constructor(
    private readonly client: GitLabConnectorClient,
    webhookOptions: GitLabWebhookOptions = {},
  ) {
    const signingToken = webhookOptions.signingToken?.trim() || undefined;
    const secretToken = webhookOptions.secretToken?.trim() || undefined;
    if (signingToken || secretToken) {
      this.webhook = gitLabWebhookHandler({
        signingToken,
        secretToken,
        now: webhookOptions.now,
        timestampToleranceMs: webhookOptions.timestampToleranceMs,
      });
    }
  }

  validateConfig(input: unknown): GitLabSourceConfig {
    return gitLabConfig(input);
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    return gitLabConfig(config).project;
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    return `gitlab:${this.externalId(config)}`.slice(0, 100);
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    _previousCursor: Readonly<Record<string, unknown>> | null,
    previousFiles: readonly ConnectorFileSnapshot[] = [],
  ): Promise<ConnectorSnapshot> {
    const value = gitLabConfig(config);
    const tree = await this.client.getTree(value.project, value.ref, previousFiles);
    return {
      revision: tree.revision,
      files: tree.files,
      cursor: { ref: value.ref, commit_sha: tree.revision },
    };
  }

  readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const value = gitLabConfig(config);
    return this.client.getBlob(value.project, file.revision, file.bytes);
  }
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  return headers[name]?.trim() ?? "";
}

function signingKey(token: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    throw new Error("GitLab webhook signing token must use the whsec_ format");
  }
  const encoded = token.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  if (
    key.length < 16 ||
    key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("GitLab webhook signing token is invalid");
  }
  return key;
}

function gitLabWebhookHandler(options: GitLabWebhookOptions): SourceConnectorWebhookHandler {
  if (!options.signingToken && !options.secretToken) {
    throw new Error("GitLab webhook authentication is not configured");
  }
  const signingSecret = options.signingToken ? signingKey(options.signingToken) : null;
  const secretToken = options.secretToken;
  if (secretToken && (secretToken.length < 16 || /[\u0000-\u001f\u007f]/.test(secretToken))) {
    throw new Error("GitLab webhook secret token must contain at least 16 safe characters");
  }
  const now = options.now ?? (() => Date.now());
  const tolerance = options.timestampToleranceMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(tolerance) || tolerance < 1_000 || tolerance > 24 * 60 * 60 * 1000) {
    throw new Error("GitLab webhook timestamp tolerance is invalid");
  }
  const handler: SourceConnectorWebhookHandler = {
    verify(request): VerifiedConnectorWebhookEvent {
      const delivery = header(request.headers, "webhook-id") ||
        header(request.headers, "idempotency-key") ||
        header(request.headers, "x-gitlab-event-uuid");
      if (!delivery || delivery.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(delivery)) {
        throw new GitLabConnectorError("GitLab webhook delivery id is invalid");
      }
      const receivedSignature = header(request.headers, "webhook-signature");
      if (receivedSignature) {
        if (!signingSecret) throw new GitLabConnectorError("GitLab webhook signature is not configured");
        const timestamp = header(request.headers, "webhook-timestamp");
        const timestampSeconds = Number(timestamp);
        if (!/^\d{1,12}$/.test(timestamp) || !Number.isSafeInteger(timestampSeconds)) {
          throw new GitLabConnectorError("GitLab webhook timestamp is invalid");
        }
        if (Math.abs(now() - timestampSeconds * 1000) > tolerance) {
          throw new GitLabConnectorError("GitLab webhook timestamp is too old or too far in the future");
        }
        const message = Buffer.concat([
          Buffer.from(`${delivery}.${timestamp}.`, "utf8"),
          request.body,
        ]);
        const expected = `v1,${createHmac("sha256", signingSecret)
          .update(message)
          .digest("base64")}`;
        const valid = receivedSignature.split(/\s+/).some((candidate) => {
          const expectedBytes = Buffer.from(expected);
          const candidateBytes = Buffer.from(candidate);
          return expectedBytes.length === candidateBytes.length &&
            timingSafeEqual(expectedBytes, candidateBytes);
        });
        if (!valid) throw new GitLabConnectorError("GitLab webhook signature is invalid");
      } else {
        const receivedToken = header(request.headers, "x-gitlab-token");
        if (!secretToken || !receivedToken || !constantTimeStringEqual(secretToken, receivedToken)) {
          throw new GitLabConnectorError("GitLab webhook token is invalid");
        }
      }
      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString("utf8"));
      } catch {
        throw new GitLabConnectorError("GitLab webhook body is invalid");
      }
      if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        throw new GitLabConnectorError("GitLab webhook body is invalid");
      }
      const value = payload as Record<string, unknown>;
      const project = value.project;
      if (!project || Array.isArray(project) || typeof project !== "object") {
        throw new GitLabConnectorError("GitLab webhook project is invalid");
      }
      const projectValue = project as Record<string, unknown>;
      const externalId = projectValue.path_with_namespace;
      if (
        typeof externalId !== "string" ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(externalId) ||
        externalId.length > 512
      ) {
        throw new GitLabConnectorError("GitLab webhook project is invalid");
      }
      const ref = value.ref;
      const after = value.after;
      const eventName = header(request.headers, "x-gitlab-event");
      const isPush = value.object_kind === "push" || eventName.toLowerCase() === "push hook";
      const deleted = typeof after === "string" && /^0+$/.test(after);
      const defaultBranch = projectValue.default_branch;
      return {
        id: delivery,
        externalId,
        action: isPush && !deleted ? "sync" : "ignore",
        metadata: {
          ref: typeof ref === "string" && ref.length <= 512 ? ref : null,
          default_branch:
            typeof defaultBranch === "string" && defaultBranch.length <= 255
              ? defaultBranch
              : null,
        },
      };
    },
    matchesConfig(event, config): boolean {
      if (event.action !== "sync") return false;
      const value = gitLabConfig(config);
      const ref = event.metadata?.ref;
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return false;
      const configuredRef = value.ref === "HEAD"
        ? event.metadata?.default_branch
        : value.ref;
      return typeof configuredRef === "string" &&
        ref === `refs/heads/${configuredRef}`;
    },
  };
  return Object.freeze(handler);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
