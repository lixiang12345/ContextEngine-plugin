/**
 * ContextEngine — portable codebase context for AI coding agents.
 *
 * @example
 * ```ts
 * import { ContextEngine } from "contextengine-plugin";
 *
 * const engine = ContextEngine.open({ root: process.cwd() });
 * await engine.index();
 * const hits = await engine.search({ query: "payment webhook handler" });
 * const packed = await engine.getTaskContext({
 *   task: "Add logging to payment requests",
 * });
 * ```
 */

export { ContextEngine, estimateTokens } from "./engine.js";
export { resolveEngineConfig, resolveEmbeddingsConfig, loadDotEnv } from "./config.js";
export { chunkFile } from "./chunker/code-chunker.js";
export { Bm25Index, tokenize } from "./search/bm25.js";
export { HybridSearcher } from "./search/hybrid.js";
export { indexWorkspace } from "./indexer/indexer.js";
export { SqliteStore } from "./store/sqlite-store.js";
export { createEmbeddingProvider } from "./embeddings/provider.js";

export type {
  CodeChunk,
  SearchHit,
  SearchOptions,
  TaskContextOptions,
  PackedContext,
  IndexStats,
  EngineConfig,
  EmbeddingsConfig,
  IndexProgress,
} from "./types.js";
