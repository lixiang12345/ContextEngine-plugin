import path from "node:path";
import type {
  EngineConfig,
  IndexStats,
  PackedContext,
  SearchHit,
  SearchOptions,
  TaskContextOptions,
} from "./types.js";
import { dbPathFor, resolveEngineConfig } from "./config.js";
import { indexWorkspace, type IndexResult } from "./indexer/indexer.js";
import { SqliteStore, storeExists } from "./store/sqlite-store.js";
import { HybridSearcher } from "./search/hybrid.js";
import { createEmbeddingProvider } from "./embeddings/provider.js";
import { readTextFile } from "./util/fs.js";

/**
 * High-level Context Engine API.
 * Safe to use from CLI, MCP, or as a library.
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
  } = {}): ContextEngine {
    return new ContextEngine(resolveEngineConfig(opts));
  }

  get dbPath(): string {
    return dbPathFor(this.config.dataDir);
  }

  async index(
    onProgress?: Parameters<typeof indexWorkspace>[1],
  ): Promise<IndexResult> {
    this.close();
    const result = await indexWorkspace(this.config, onProgress);
    // reopen after index
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
   * Pack high-signal context for a natural-language engineering task.
   * Designed for coding agents: path + line range + content under a token budget.
   */
  async getTaskContext(opts: TaskContextOptions): Promise<PackedContext> {
    const topK = opts.topK ?? 12;
    const maxTokens = opts.maxTokens ?? 6000;
    const hits = await this.search({
      query: opts.task,
      topK,
      pathPrefix: opts.pathPrefix,
      mode: "auto",
    });

    const parts: string[] = [
      `# Task context`,
      ``,
      `Task: ${opts.task}`,
      ``,
      `Retrieved ${hits.length} chunks (ranked).`,
      ``,
    ];

    let tokens = estimateTokens(parts.join("\n"));
    let truncated = false;
    const used: SearchHit[] = [];

    for (const hit of hits) {
      const block = formatHit(hit);
      const blockTokens = estimateTokens(block);
      if (tokens + blockTokens > maxTokens && used.length > 0) {
        truncated = true;
        break;
      }
      parts.push(block);
      tokens += blockTokens;
      used.push(hit);
    }

    return {
      task: opts.task,
      hits: used,
      packedText: parts.join("\n"),
      estimatedTokens: tokens,
      truncated,
    };
  }

  /** Read a file (optionally a line range) from the workspace. */
  getFileContext(
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): { path: string; content: string; startLine: number; endLine: number } | null {
    const abs = path.join(this.config.root, relPath);
    const text = readTextFile(abs);
    if (text === null) return null;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    const slice = lines.slice(s - 1, e).join("\n");
    return { path: relPath, content: slice, startLine: s, endLine: e };
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
    const model = embedder?.model ?? store.getMeta("embedding_model") ?? undefined;
    const searcher = new HybridSearcher();
    searcher.load({
      chunks: store.getAllChunks(),
      embeddings: store.getEmbeddings(model),
      embedder,
    });
    this.searcher = searcher;
  }
}

function formatHit(hit: SearchHit): string {
  const { chunk, score, source } = hit;
  const header = [
    `## ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    chunk.symbol ? `symbol: ${chunk.symbol}` : null,
    `lang: ${chunk.language} · score: ${score.toFixed(4)} · via: ${source}`,
    "```" + (chunk.language === "tsx" ? "tsx" : chunk.language),
    chunk.content,
    "```",
    "",
  ]
    .filter(Boolean)
    .join("\n");
  return header;
}

/** Rough token estimate (~4 chars / token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
