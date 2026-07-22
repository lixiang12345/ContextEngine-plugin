export interface ConnectorFileSnapshot {
  path: string;
  revision: string;
  bytes: number;
}

export interface ConnectorSnapshot {
  revision: string;
  files: ConnectorFileSnapshot[];
  cursor: Record<string, unknown>;
}

export interface ConnectorWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export interface VerifiedConnectorWebhookEvent {
  /** Provider delivery id used for persistent idempotency. */
  readonly id: string;
  /** Must exactly match SourceConnectorPlugin.externalId(config). */
  readonly externalId: string;
  readonly action: "sync" | "ignore";
  /** Bounded, non-secret provider metadata used only for config matching. */
  readonly metadata?: Readonly<Record<string, string | boolean | null>>;
}

export interface SourceConnectorWebhookHandler {
  verify(request: ConnectorWebhookRequest): VerifiedConnectorWebhookEvent;
  matchesConfig(
    event: VerifiedConnectorWebhookEvent,
    config: Readonly<Record<string, unknown>>,
  ): boolean;
}

/**
 * A read-only content source. Core synchronization owns hashing, diffing,
 * leases, Blob persistence and index promotion; plugins only enumerate and
 * read immutable source revisions.
 */
export interface SourceConnectorPlugin {
  readonly provider: string;
  readonly displayName: string;
  validateConfig(input: unknown): Record<string, unknown>;
  externalId(config: Readonly<Record<string, unknown>>): string;
  rootAlias(config: Readonly<Record<string, unknown>>): string;
  listFiles(
    config: Readonly<Record<string, unknown>>,
    previousCursor: Readonly<Record<string, unknown>> | null,
    /** Core-owned prior metadata; useful for avoiding repeated upstream stat calls. */
    previousFiles?: readonly ConnectorFileSnapshot[],
  ): Promise<ConnectorSnapshot>;
  readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer>;
  secrets?(config: Readonly<Record<string, unknown>>): readonly string[];
  /** Optional signed webhook adapter. Core owns inbox idempotency and retries. */
  readonly webhook?: SourceConnectorWebhookHandler;
}

export class SourceConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConnectorError";
  }
}

const providerPattern = /^[a-z][a-z0-9_-]{0,62}$/;

export class SourceConnectorRegistry {
  private readonly plugins = new Map<string, SourceConnectorPlugin>();

  constructor(plugins: readonly SourceConnectorPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: SourceConnectorPlugin): void {
    if (!providerPattern.test(plugin.provider)) {
      throw new Error(
        `Connector provider must match ${providerPattern.source}: ${plugin.provider}`,
      );
    }
    if (!plugin.displayName.trim()) {
      throw new Error(`Connector ${plugin.provider} must have a display name`);
    }
    if (this.plugins.has(plugin.provider)) {
      throw new Error(`Connector provider is already registered: ${plugin.provider}`);
    }
    this.plugins.set(plugin.provider, plugin);
  }

  get(provider: string): SourceConnectorPlugin | undefined {
    return this.plugins.get(provider);
  }

  require(provider: string): SourceConnectorPlugin {
    const plugin = this.get(provider);
    if (!plugin) throw new SourceConnectorError(`Unsupported connector provider: ${provider}`);
    return plugin;
  }

  list(): Array<{ provider: string; displayName: string }> {
    return [...this.plugins.values()]
      .map((plugin) => ({
        provider: plugin.provider,
        displayName: plugin.displayName,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }
}
