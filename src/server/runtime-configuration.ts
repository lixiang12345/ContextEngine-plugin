import { resolveEmbeddingsConfig, resolveEngineConfig } from "../config.js";
import type { EmbeddingsConfig } from "../types.js";
import {
  resolveNeuralRerankConfig,
  type NeuralRerankConfig,
} from "../search/neural-rerank.js";
import {
  PRIVATE_MODEL_URL_OPT_IN,
  validateRuntimeModelBaseUrl,
} from "./model-endpoint-policy.js";

export interface EmbeddingConfigurationUpdate {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  dimensions?: number | null;
  authentication: "bearer" | "none";
  apiKey?: string;
  batchSize: number;
  maxInputChars: number;
  inputType: boolean;
}

export interface RerankerConfigurationUpdate {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  authentication: "bearer" | "none";
  apiKey?: string;
  topN: number;
  weight: number;
  maxDocumentChars: number;
  instruction?: string | null;
}

export interface ModelConfigurationUpdate {
  embedding?: EmbeddingConfigurationUpdate;
  reranker?: RerankerConfigurationUpdate;
}

export interface RuntimeConfigurationOptions {
  databaseUrl: string;
  httpApiKey?: string;
  allowUnauthenticated: boolean;
  allowLocalWorkspaces: boolean;
  localRootAllowlistCount: number;
  maxBlobBytes: number;
  mcpSessionIdleTtlMs?: number;
  mcpMaxSessions?: number;
  mcpSessionStore?: "postgres" | "memory";
  corsOriginsCount?: number;
  snapshotStoreConfigured?: boolean;
  snapshotReplicationTargetCount?: number;
  snapshotJobPollIntervalMs?: number;
  disableEmbeddings: boolean;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() || "");
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

function secretHint(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "configured";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "configured";
  }
}

function databaseTarget(databaseUrl: string): {
  engine: string;
  host: string;
  port: string | null;
  database: string;
  tls: boolean;
} {
  try {
    const url = new URL(databaseUrl);
    return {
      engine: url.protocol.replace(/:$/, "") || "postgresql",
      host: url.hostname || "configured",
      port: url.port || null,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "configured",
      tls: /^(require|verify-ca|verify-full)$/i.test(
        url.searchParams.get("sslmode") || "",
      ),
    };
  } catch {
    return {
      engine: "postgresql",
      host: "configured",
      port: null,
      database: "configured",
      tls: false,
    };
  }
}

function sameEmbeddingIndex(
  left: EmbeddingsConfig | undefined,
  right: EmbeddingsConfig | undefined,
  leftInputType: boolean,
  rightInputType: boolean,
  leftMaxInputChars: number,
  rightMaxInputChars: number,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    leftInputType === rightInputType &&
    leftMaxInputChars === rightMaxInputChars
  );
}

export class RuntimeModelConfiguration {
  private embedding: EmbeddingsConfig | undefined;
  private reranker: NeuralRerankConfig | undefined;
  private readonly startupModelBaseUrls: string[];

  constructor() {
    this.embedding = resolveEmbeddingsConfig();
    this.reranker = resolveNeuralRerankConfig();
    this.startupModelBaseUrls = [
      this.embedding?.baseUrl,
      this.reranker?.baseUrl,
    ].filter((value): value is string => Boolean(value));
  }

  embeddingCandidate(
    update: EmbeddingConfigurationUpdate,
  ): EmbeddingsConfig {
    const candidate = this.resolveEmbedding(update);
    if (!candidate) {
      throw new Error("Embedding must be enabled before testing");
    }
    return candidate;
  }

  rerankerCandidate(
    update: RerankerConfigurationUpdate,
  ): NeuralRerankConfig {
    const candidate = this.resolveReranker(update);
    if (!candidate) {
      throw new Error("Reranker must be enabled before testing");
    }
    return candidate;
  }

  engineConfig(): {
    embeddings: EmbeddingsConfig | undefined;
    neuralRerank: NeuralRerankConfig | undefined;
  } {
    return {
      embeddings: this.embedding,
      neuralRerank: this.reranker,
    };
  }

  update(input: ModelConfigurationUpdate): {
    changed: boolean;
    reindexRequired: boolean;
  } {
    const previousEmbedding = this.embedding;
    const previousInputType = truthy(
      process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE,
    );
    const previousMaxInputChars = positiveInteger(
      process.env.CONTEXTENGINE_EMBED_MAX_CHARS,
      4_000,
      100,
    );
    // Validate every section before mutating process state. A combined form
    // submission must be all-or-nothing when one section fails validation.
    const nextEmbedding = input.embedding
      ? this.resolveEmbedding(input.embedding)
      : this.embedding;
    const nextReranker = input.reranker
      ? this.resolveReranker(input.reranker, nextEmbedding)
      : this.reranker;
    const changed = Boolean(input.embedding || input.reranker);

    if (input.embedding) {
      this.embedding = nextEmbedding;
      process.env.CONTEXTENGINE_EMBED_BATCH = String(input.embedding.batchSize);
      process.env.CONTEXTENGINE_EMBED_MAX_CHARS = String(
        input.embedding.maxInputChars,
      );
      process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE = input.embedding.inputType
        ? "1"
        : "0";
    }
    if (input.reranker) this.reranker = nextReranker;

    const currentInputType = truthy(
      process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE,
    );
    const currentMaxInputChars = positiveInteger(
      process.env.CONTEXTENGINE_EMBED_MAX_CHARS,
      4_000,
      100,
    );
    return {
      changed,
      reindexRequired: !sameEmbeddingIndex(
        previousEmbedding,
        this.embedding,
        previousInputType,
        currentInputType,
        previousMaxInputChars,
        currentMaxInputChars,
      ),
    };
  }

  private resolveEmbedding(
    update: EmbeddingConfigurationUpdate,
  ): EmbeddingsConfig | undefined {
    if (!update.enabled) return undefined;
    const current = this.embedding;
    const apiKey =
      update.authentication === "none"
        ? undefined
        : update.apiKey?.trim() || current?.apiKey;
    if (update.authentication === "bearer" && !apiKey) {
      throw new Error("Embedding API key is required for Bearer authentication");
    }
    const rawBaseUrl =
      update.baseUrl?.trim() ||
      current?.baseUrl ||
      (apiKey ? "https://api.openai.com/v1" : "");
    if (!rawBaseUrl) {
      throw new Error(
        "Embedding base URL is required when authentication is disabled",
      );
    }
    return {
      apiKey,
      baseUrl: this.validateBaseUrl(rawBaseUrl),
      model:
        update.model?.trim() ||
        current?.model ||
        "text-embedding-3-small",
      dimensions: update.dimensions ?? undefined,
    };
  }

  private resolveReranker(
    update: RerankerConfigurationUpdate,
    embedding = this.embedding,
  ): NeuralRerankConfig | undefined {
    if (!update.enabled) return undefined;
    const current = this.reranker;
    const apiKey =
      update.authentication === "none"
        ? undefined
        : update.apiKey?.trim() ||
          current?.apiKey ||
          embedding?.apiKey;
    if (update.authentication === "bearer" && !apiKey) {
      throw new Error("Reranker API key is required for Bearer authentication");
    }
    const rawBaseUrl =
      update.baseUrl?.trim() ||
      current?.baseUrl ||
      embedding?.baseUrl ||
      (apiKey ? "https://api.openai.com/v1" : "");
    if (!rawBaseUrl) {
      throw new Error(
        "Reranker base URL is required when authentication is disabled",
      );
    }
    return {
      apiKey,
      baseUrl: this.validateBaseUrl(rawBaseUrl),
      model:
        update.model?.trim() ||
        current?.model ||
        "Qwen/Qwen3-Reranker-0.6B",
      topN: update.topN,
      weight: update.weight,
      maxDocChars: update.maxDocumentChars,
      instruction: update.instruction?.trim() || undefined,
    };
  }

  snapshot(
    options: RuntimeConfigurationOptions,
  ): Record<string, unknown> {
    const engineConfig = resolveEngineConfig({
      root: process.cwd(),
      databaseUrl: options.databaseUrl,
    });
    const embeddingState = options.disableEmbeddings
      ? "disabled_by_server"
      : this.embedding
        ? "enabled"
        : "disabled";

    return {
      mutability: "process",
      embedding: {
        state: embeddingState,
        model: this.embedding?.model ?? null,
        base_url: this.embedding
          ? safeEndpoint(this.embedding.baseUrl)
          : null,
        dimensions: this.embedding?.dimensions ?? null,
        authentication: this.embedding
          ? this.embedding.apiKey
            ? "bearer"
            : "none"
          : "disabled",
        api_key_hint: secretHint(this.embedding?.apiKey),
        batch_size: positiveInteger(
          process.env.CONTEXTENGINE_EMBED_BATCH,
          8,
          1,
        ),
        max_input_chars: positiveInteger(
          process.env.CONTEXTENGINE_EMBED_MAX_CHARS,
          4_000,
          100,
        ),
        input_type: truthy(process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE),
        query_instruction:
          process.env.CONTEXTENGINE_EMBED_QUERY_INSTRUCT?.trim() || "default",
      },
      reranker: {
        state: this.reranker ? "enabled" : "disabled",
        model: this.reranker?.model ?? null,
        base_url: this.reranker
          ? safeEndpoint(this.reranker.baseUrl)
          : null,
        authentication: this.reranker
          ? this.reranker.apiKey
            ? "bearer"
            : "none"
          : "disabled",
        api_key_hint: secretHint(this.reranker?.apiKey),
        top_n: this.reranker?.topN ?? 20,
        weight: this.reranker?.weight ?? 0.32,
        max_document_chars: this.reranker?.maxDocChars ?? 1_800,
        instruction: this.reranker?.instruction ?? null,
      },
      model_api: {
        timeout_ms: boundedInteger(
          process.env.CONTEXTENGINE_API_TIMEOUT_MS,
          120_000,
          1_000,
          600_000,
        ),
        retries: boundedInteger(
          process.env.CONTEXTENGINE_API_RETRIES,
          2,
          0,
          5,
        ),
        runtime_base_url_policy: {
          protocols: ["http", "https"],
          url_credentials: "blocked",
          private_network_targets: truthy(
            process.env[PRIVATE_MODEL_URL_OPT_IN],
          )
            ? "allowed_by_server_opt_in"
            : "blocked_except_startup_configuration",
          private_network_opt_in_env: PRIVATE_MODEL_URL_OPT_IN,
        },
      },
      indexing: {
        max_file_bytes: engineConfig.maxFileBytes,
        max_chunk_chars: engineConfig.maxChunkChars,
      },
      http: {
        authentication: options.allowUnauthenticated
          ? "none"
          : options.httpApiKey
            ? "bearer"
            : "unavailable",
        max_blob_bytes: options.maxBlobBytes,
        mcp_session_idle_ttl_ms: options.mcpSessionIdleTtlMs ?? null,
        mcp_max_sessions: options.mcpMaxSessions ?? null,
        mcp_session_store: options.mcpSessionStore ?? null,
        cors_origins_count: options.corsOriginsCount ?? 0,
        local_workspaces: options.allowLocalWorkspaces,
        local_root_allowlist_count: options.localRootAllowlistCount,
        snapshot_store_configured: options.snapshotStoreConfigured ?? false,
        snapshot_replication_target_count:
          options.snapshotReplicationTargetCount ?? 0,
        snapshot_job_poll_interval_ms: options.snapshotJobPollIntervalMs ?? null,
      },
      storage: databaseTarget(options.databaseUrl),
    };
  }

  private validateBaseUrl(rawBaseUrl: string): string {
    return validateRuntimeModelBaseUrl(rawBaseUrl, {
      allowPrivateNetwork: truthy(process.env[PRIVATE_MODEL_URL_OPT_IN]),
      trustedBaseUrls: this.startupModelBaseUrls,
    });
  }
}
