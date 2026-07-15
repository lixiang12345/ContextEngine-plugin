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
export {
  resolveEngineConfig,
  resolveEmbeddingsConfig,
  resolveNeuralRerankConfig,
  loadDotEnv,
} from "./config.js";
export { chunkFile } from "./chunker/code-chunker.js";
export { Bm25Index, tokenize } from "./search/bm25.js";
export { HybridSearcher } from "./search/hybrid.js";
export { analyzeQuery, toFtsQuery } from "./search/query-analyzer.js";
export {
  featureScore,
  combineFinal,
  mmrSelect,
  preferImplementation,
  rrfFuse,
} from "./search/rerank.js";
export {
  blendNeuralScores,
  formatRerankDocument,
  neuralRerankScores,
} from "./search/neural-rerank.js";
export { indexWorkspace, parseExtraRootsFromEnv } from "./indexer/indexer.js";
export { watchAndIndex } from "./indexer/watch.js";
export { SqliteStore } from "./store/sqlite-store.js";
export { exportIndex, importIndex } from "./store/export-import.js";
export {
  createEmbeddingProvider,
  CODE_RETRIEVAL_QUERY_INSTRUCT,
} from "./embeddings/provider.js";
export { buildSymbolGraph, expandViaGraph } from "./graph/symbol-graph.js";
export { harvestCommits, commitsToChunks, isGitRepo } from "./lineage/commits.js";
export { runEval, defaultSelfEvalCases } from "./eval/harness.js";
export {
  loadProfiles,
  saveProfiles,
  upsertProfile,
  resolveProfile,
} from "./config/profiles.js";

export type {
  EvalCase,
  EvalCaseResult,
  EvalReport,
} from "./eval/harness.js";
export type { RepoProfile, MultiRepoConfig } from "./config/profiles.js";
export type { AnalyzedQuery, QueryIntent } from "./search/query-analyzer.js";

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
  IndexRoot,
} from "./types.js";
