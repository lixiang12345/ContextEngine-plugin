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
export { startHttpServer } from "./http-server.js";
export {
  resolveEngineConfig,
  resolveEmbeddingsConfig,
  resolveNeuralRerankConfig,
  loadDotEnv,
} from "./config.js";
export { chunkFile } from "./chunker/code-chunker.js";
export { Bm25Index, tokenize } from "./search/bm25.js";
export { PostgresHybridSearcher } from "./search/postgres-hybrid.js";
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
export {
  indexWorkspace,
  indexVirtualWorkspace,
  parseExtraRootsFromEnv,
} from "./indexer/indexer.js";
export { watchAndIndex } from "./indexer/watch.js";
export { PostgresStore } from "./store/postgres-store.js";
export type { IndexGenerationStatus } from "./store/postgres-store.js";
export {
  WorkspaceRepository,
  WorkspaceNotFoundError,
  RevisionConflictError,
  MissingBlobError,
} from "./server/workspace-repository.js";
export { migrateSqliteIndex } from "./store/migrate-sqlite.js";
export {
  createEmbeddingProvider,
  CODE_RETRIEVAL_QUERY_INSTRUCT,
} from "./embeddings/provider.js";
export { buildSymbolGraph, expandViaGraph } from "./graph/symbol-graph.js";
export { harvestCommits, commitsToChunks, isGitRepo } from "./lineage/commits.js";
export { runEval, defaultSelfEvalCases } from "./eval/harness.js";
export {
  formatPrEvalReportMarkdown,
  loadPrEvalSuite,
  parsePrEvalSuite,
  runPrEvalCommand,
  runPrEvalSuite,
} from "./eval/pr-harness.js";
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
export type {
  PreparedPrContext,
  PrEvalAgentConfig,
  PrEvalAgentUsage,
  PrEvalCase,
  PrEvalCommandResult,
  PrEvalComparison,
  PrEvalContextConfig,
  PrEvalContextMode,
  PrEvalContextProvider,
  PrEvalContextProviderInput,
  PrEvalIsolationMode,
  PrEvalPatchStats,
  PrEvalProgress,
  PrEvalReport,
  PrEvalRunResult,
  PrEvalRunStatus,
  PrEvalSuite,
  PrEvalVariant,
  PrEvalVariantSummary,
  RunPrEvalOptions,
} from "./eval/pr-harness.js";
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
export type {
  VirtualIndexOptions,
  VirtualSourceDocument,
} from "./indexer/indexer.js";
export type { WatchHandle, WatchOptions } from "./indexer/watch.js";
export type {
  HttpServerHandle,
  HttpServerOptions,
} from "./http-server.js";
export type {
  IndexJobMode,
  IndexJobStatus,
  ConnectorProvider,
  ConnectorSyncAttempt,
  ConnectorSyncCommit,
  ConnectorSyncLease,
  StoredIndexJob,
  StoredConnectorFile,
  StoredConnectorSource,
  StoredSourceDocument,
  StoredWorkspace,
  SyncChange,
  SyncOperation,
  WorkspacePermission,
  WorkspaceSourceMode,
} from "./server/workspace-repository.js";
