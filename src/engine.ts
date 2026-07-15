import path from "node:path";
import type {
  EngineConfig,
  IndexRoot,
  IndexStats,
  PackedContext,
  SearchHit,
  SearchOptions,
  TaskContextOptions,
} from "./types.js";
import { resolveEngineConfig } from "./config.js";
import {
  indexWorkspace,
  parseExtraRootsFromEnv,
  type IndexResult,
} from "./indexer/indexer.js";
import { PostgresStore } from "./store/postgres-store.js";
import { PostgresHybridSearcher } from "./search/postgres-hybrid.js";
import { createEmbeddingProvider } from "./embeddings/provider.js";
import { readTextFile } from "./util/fs.js";
import { analyzeQuery } from "./search/query-analyzer.js";
import { resolveRetrievalBudget } from "./retrieval-budget.js";

/**
 * High-level Context Engine API (v0.4 multi-signal retrieval).
 */
export class ContextEngine {
  readonly config: EngineConfig;
  private store: PostgresStore | null = null;
  private storeOpening: Promise<PostgresStore> | null = null;
  private searcher: PostgresHybridSearcher | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  static open(opts: {
    root?: string;
    workspaceId?: string;
    dataDir?: string;
    databaseUrl?: string;
    extraRoots?: IndexRoot[];
  } = {}): ContextEngine {
    const cfg = resolveEngineConfig(opts);
    if (opts.extraRoots) cfg.extraRoots = opts.extraRoots;
    else if (!cfg.extraRoots?.length) {
      const envRoots = parseExtraRootsFromEnv();
      if (envRoots.length) cfg.extraRoots = envRoots;
    }
    return new ContextEngine(cfg);
  }

  get dbPath(): string {
    return "PostgreSQL (pgvector)";
  }

  async index(
    onProgress?: Parameters<typeof indexWorkspace>[1],
  ): Promise<IndexResult> {
    await this.close();
    const result = await indexWorkspace(this.config, onProgress);
    await this.reloadSearcher();
    return result;
  }

  async stats(): Promise<IndexStats> {
    const store = await this.ensureStore();
    return store.stats(this.config.root);
  }

  async hasIndex(): Promise<boolean> {
    const store = await this.ensureStore();
    return (await store.chunkCount()) > 0;
  }

  async clearIndex(): Promise<void> {
    const store = await this.ensureStore();
    await store.clearWorkspace();
    this.searcher = null;
  }

  /** Reload database-backed search state after an external index job. */
  async refresh(): Promise<void> {
    await this.reloadSearcher();
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const searcher = await this.ensureSearcher();
    return searcher.search(opts);
  }

  /**
   * Pack high-signal context for an engineering task (MMR + budget).
   * Primary agent entrypoint — mirrors Augment-style "retrieve then edit".
   */
  async getTaskContext(opts: TaskContextOptions): Promise<PackedContext> {
    const topK = opts.topK ?? 12;
    const budget = resolveRetrievalBudget({
      maxTokens: opts.maxTokens,
      contextWindowTokens: opts.contextWindowTokens,
      reservedOutputTokens: opts.reservedOutputTokens,
    });
    const maxTokens = budget.maxTokens;
    const analyzed = analyzeQuery(opts.task);

    const hits = await this.search({
      query: opts.task,
      topK,
      pathPrefix: opts.pathPrefix,
      mode: "auto",
      diversify: opts.diversify !== false,
      includeCommits: analyzed.prefersCommits ? true : undefined,
    });

    const parts: string[] = [
      `# Task context`,
      ``,
      `Task: ${opts.task}`,
      `Intent: ${analyzed.intent}`,
      analyzed.identifiers.length
        ? `Identifiers: ${analyzed.identifiers.slice(0, 8).join(", ")}`
        : null,
      ``,
      `Retrieved ${hits.length} chunks (multi-signal rank + diversity).`,
      ``,
    ].filter((x): x is string => x !== null);

    let tokens = estimateTokens(parts.join("\n"));
    let truncated = false;
    const used: SearchHit[] = [];
    const pathCounts = new Map<string, number>();

    for (const hit of hits) {
      // Soft cap: avoid flooding same file unless high score
      const pathCount = pathCounts.get(hit.chunk.path) ?? 0;
      if (pathCount >= 2 && hit.score < 0.55 && used.length >= 3) continue;

      const block = formatHit(hit);
      const blockTokens = estimateTokens(block);
      if (tokens + blockTokens > maxTokens && used.length > 0) {
        truncated = true;
        break;
      }
      parts.push(block);
      tokens += blockTokens;
      used.push(hit);
      pathCounts.set(hit.chunk.path, pathCount + 1);
    }

    return {
      task: opts.task,
      hits: used,
      packedText: parts.join("\n"),
      estimatedTokens: tokens,
      truncated,
      budget,
    };
  }

  /**
   * Augment-style single-shot codebase retrieval for agents.
   */
  async codebaseRetrieval(
    informationRequest: string,
    opts?: {
      topK?: number;
      maxTokens?: number;
      contextWindowTokens?: number;
      reservedOutputTokens?: number;
    },
  ): Promise<PackedContext> {
    return this.getTaskContext({
      task: informationRequest,
      topK: opts?.topK ?? 14,
      maxTokens: opts?.maxTokens,
      contextWindowTokens: opts?.contextWindowTokens,
      reservedOutputTokens: opts?.reservedOutputTokens,
      diversify: true,
    });
  }

  getFileContext(
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): { path: string; content: string; startLine: number; endLine: number } | null {
    // Support multi-root prefixed paths: main/src/x.ts or docs/guide.md
    const extras = this.config.extraRoots ?? [];
    if (extras.length > 0 || relPath.includes("/")) {
      const first = relPath.split("/")[0];
      if (first === "main") {
        const rest = relPath.slice("main/".length);
        return readRange(path.join(this.config.root, rest), relPath, startLine, endLine);
      }
      const match = extras.find((r) => r.name === first);
      if (match) {
        const rest = relPath.slice(first.length + 1);
        return readRange(path.join(match.path, rest), relPath, startLine, endLine);
      }
    }
    return readRange(
      path.join(this.config.root, relPath),
      relPath,
      startLine,
      endLine,
    );
  }

  async close(): Promise<void> {
    const opening = this.storeOpening;
    const store = this.store ?? (opening ? await opening : null);
    this.store = null;
    this.searcher = null;
    if (store) await store.close();
  }

  private async ensureStore(): Promise<PostgresStore> {
    if (this.store) return this.store;
    if (!this.storeOpening) {
      if (!this.config.databaseUrl) {
        throw new Error(
          "CONTEXTENGINE_DATABASE_URL is required (PostgreSQL with pgvector).",
        );
      }
      this.storeOpening = PostgresStore.open({
        databaseUrl: this.config.databaseUrl,
        workspaceId: this.config.workspaceId ?? this.config.root,
      })
        .then((store) => {
          this.store = store;
          return store;
        })
        .finally(() => {
          this.storeOpening = null;
        });
    }
    return this.storeOpening;
  }

  private async ensureSearcher(): Promise<PostgresHybridSearcher> {
    if (!this.searcher) {
      await this.reloadSearcher();
    }
    return this.searcher!;
  }

  private async reloadSearcher(): Promise<void> {
    const store = await this.ensureStore();
    const embedder = createEmbeddingProvider(this.config.embeddings);
    const stats = await store.stats(this.config.root);
    const searcher = new PostgresHybridSearcher();
    searcher.load({
      embedder,
      store,
      hasEmbeddings: stats.hasEmbeddings,
      neuralRerank: this.config.neuralRerank ?? null,
    });
    this.searcher = searcher;
  }
}

function readRange(
  abs: string,
  displayPath: string,
  startLine?: number,
  endLine?: number,
): { path: string; content: string; startLine: number; endLine: number } | null {
  const text = readTextFile(abs);
  if (text === null) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const s = Math.max(1, startLine ?? 1);
  const e = Math.min(lines.length, endLine ?? lines.length);
  const slice = lines.slice(s - 1, e).join("\n");
  return { path: displayPath, content: slice, startLine: s, endLine: e };
}

function formatHit(hit: SearchHit): string {
  const { chunk, score, source, channels, intent } = hit;
  const ch = channels
    ? Object.entries(channels)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
        .join(" ")
    : "";
  return [
    `## ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    chunk.symbol ? `symbol: ${chunk.symbol}` : null,
    `lang: ${chunk.language} · score: ${score.toFixed(4)} · via: ${source}${intent ? ` · intent: ${intent}` : ""}${ch ? ` · ${ch}` : ""}`,
    "```" + (chunk.language === "tsx" ? "tsx" : chunk.language),
    chunk.content,
    "```",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
