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
import { dbPathFor, resolveEngineConfig } from "./config.js";
import {
  indexWorkspace,
  parseExtraRootsFromEnv,
  type IndexResult,
} from "./indexer/indexer.js";
import { SqliteStore, storeExists } from "./store/sqlite-store.js";
import { HybridSearcher } from "./search/hybrid.js";
import { createEmbeddingProvider } from "./embeddings/provider.js";
import { readTextFile } from "./util/fs.js";
import { analyzeQuery } from "./search/query-analyzer.js";

/**
 * High-level Context Engine API (v0.4 multi-signal retrieval).
 */
export class ContextEngine {
  readonly config: EngineConfig;
  private store: SqliteStore | null = null;
  private searcher: HybridSearcher | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  static open(opts: {
    root?: string;
    dataDir?: string;
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
    return dbPathFor(this.config.dataDir);
  }

  async index(
    onProgress?: Parameters<typeof indexWorkspace>[1],
  ): Promise<IndexResult> {
    this.close();
    const result = await indexWorkspace(this.config, onProgress);
    this.ensureStore();
    this.reloadSearcher();
    return result;
  }

  stats(): IndexStats {
    const store = this.ensureStore();
    return store.stats(this.config.root);
  }

  hasIndex(): boolean {
    return storeExists(this.dbPath);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const searcher = this.ensureSearcher();
    return searcher.search(opts);
  }

  /**
   * Pack high-signal context for an engineering task (MMR + budget).
   * Primary agent entrypoint — mirrors Augment-style "retrieve then edit".
   */
  async getTaskContext(opts: TaskContextOptions): Promise<PackedContext> {
    const topK = opts.topK ?? 12;
    const maxTokens = opts.maxTokens ?? 6000;
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
    };
  }

  /**
   * Augment-style single-shot codebase retrieval for agents.
   */
  async codebaseRetrieval(
    informationRequest: string,
    opts?: { topK?: number; maxTokens?: number },
  ): Promise<PackedContext> {
    return this.getTaskContext({
      task: informationRequest,
      topK: opts?.topK ?? 14,
      maxTokens: opts?.maxTokens ?? 8000,
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

  close(): void {
    this.store?.close();
    this.store = null;
    this.searcher = null;
  }

  private ensureStore(): SqliteStore {
    if (!this.store) {
      if (!storeExists(this.dbPath)) {
        throw new Error(
          `No index found at ${this.dbPath}. Run: contextengine index`,
        );
      }
      this.store = new SqliteStore(this.dbPath);
    }
    return this.store;
  }

  private ensureSearcher(): HybridSearcher {
    if (!this.searcher) {
      this.reloadSearcher();
    }
    return this.searcher!;
  }

  private reloadSearcher(): void {
    const store = this.ensureStore();
    const embedder = createEmbeddingProvider(this.config.embeddings);
    const model =
      embedder?.model ?? store.getMeta("embedding_model") ?? undefined;
    const searcher = new HybridSearcher();
    // For large indexes keep chunks in memory for graph/feature scoring;
    // FTS/symbol queries hit SQLite.
    searcher.load({
      chunks: store.getAllChunks(),
      embeddings: store.getEmbeddings(model),
      embedder,
      store,
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
