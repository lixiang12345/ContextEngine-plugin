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
export { OidcJwtAuthenticator } from "./server/oidc-auth.js";
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
export { FilesystemSnapshotStore } from "./snapshots/filesystem-store.js";
export { S3SnapshotStore } from "./snapshots/s3-store.js";
export { snapshotStoreFromLocation } from "./snapshots/config.js";
export { snapshotReplicationTargetsFromJson } from "./snapshots/config.js";
export type {
  S3CommandClient,
  S3SnapshotStoreOptions,
} from "./snapshots/s3-store.js";
export {
  exportIndexSnapshot,
  importIndexSnapshot,
  listIndexSnapshots,
  deleteIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  loadIndexSnapshotManifest,
  parseSnapshotManifest,
  pruneIndexSnapshots,
  replicateIndexSnapshot,
  SnapshotNotFoundError,
  SNAPSHOT_FORMAT_VERSION,
} from "./snapshots/snapshot.js";
export type {
  ConditionalSnapshotObjectStore,
  SnapshotConditionalWriteResult,
  SnapshotObjectMetadata,
  SnapshotObjectRequestOptions,
  SnapshotObjectStore,
  SnapshotObjectVersion,
  SnapshotObjectWriteCondition,
} from "./snapshots/object-store.js";
export {
  PrefixedSnapshotObjectStore,
  supportsConditionalSnapshotWrites,
} from "./snapshots/object-store.js";
export type {
  LoadedSnapshotManifest,
  SnapshotManifest,
  SnapshotPublicationGuard,
  SnapshotExportResult,
  SnapshotImportResult,
  SnapshotReplicationResult,
  SnapshotReplicationPublication,
} from "./snapshots/snapshot.js";
export {
  WorkspaceRepository,
  SnapshotHistoryCursorError,
  type StoredSnapshotReplicationPublication,
  WorkspaceNotFoundError,
  RevisionConflictError,
  MissingBlobError,
  sourcePathAllowed,
} from "./server/workspace-repository.js";
export {
  SnapshotJobRunner,
  type SnapshotJobRunnerOptions,
  type SnapshotJobListener,
} from "./server/snapshot-job-runner.js";
export {
  SnapshotJobEventFeed,
  PostgresSnapshotJobEventWakeup,
  type SnapshotJobHistoryReader,
  type SnapshotJobEventWakeup,
  type SnapshotJobEventFeedOptions,
  type SnapshotJobEventBatch,
  type PostgresSnapshotJobEventWakeupOptions,
} from "./server/snapshot-job-events.js";
export { migrateSqliteIndex } from "./store/migrate-sqlite.js";
export {
  createEmbeddingProvider,
  CODE_RETRIEVAL_QUERY_INSTRUCT,
} from "./embeddings/provider.js";
export { buildSymbolGraph, expandViaGraph } from "./graph/symbol-graph.js";
export { GitHubConnectorClient, GitHubConnectorError } from "./connectors/github.js";
export { GitHubSourceConnector } from "./connectors/github-plugin.js";
export { GitLabConnectorClient, GitLabConnectorError } from "./connectors/gitlab.js";
export {
  GitLabSourceConnector,
} from "./connectors/gitlab-plugin.js";
export type { GitLabConnectorClientOptions } from "./connectors/gitlab.js";
export type { GitLabWebhookOptions } from "./connectors/gitlab-plugin.js";
export { BitbucketConnectorClient, BitbucketConnectorError } from "./connectors/bitbucket.js";
export { BitbucketSourceConnector } from "./connectors/bitbucket-plugin.js";
export type { BitbucketConnectorClientOptions } from "./connectors/bitbucket.js";
export {
  WebsiteConnectorError,
  WebsiteSourceConnector,
} from "./connectors/website.js";
export type { WebsiteSourceConnectorOptions } from "./connectors/website.js";
export {
  SourceConnectorError,
  SourceConnectorRegistry,
} from "./connectors/types.js";
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
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  ConnectorWebhookRequest,
  SourceConnectorPlugin,
  SourceConnectorWebhookHandler,
  VerifiedConnectorWebhookEvent,
} from "./connectors/types.js";

export type {
  CodeChunk,
  SearchHit,
  SearchOptions,
  TaskContextOptions,
  PackedContext,
  PackingPolicy,
  RetrievalTrace,
  IndexStats,
  EngineConfig,
  EmbeddingsConfig,
  IndexProgress,
  IndexRoot,
  SourceAccessEffect,
  SourcePathPolicy,
  SourcePathRule,
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
  OidcAuthenticatorOptions,
  OidcJwtAlgorithm,
} from "./server/oidc-auth.js";
export type {
  IndexJobMode,
  IndexJobStatus,
  SnapshotJobOperation,
  SnapshotJobStatus,
  SnapshotJobAttemptStatus,
  SnapshotJobEventKind,
  SnapshotReplicationMetrics,
  SnapshotReplicationScheduleMode,
  SnapshotReplicationJobCreation,
  StoredSnapshotJob,
  StoredSnapshotJobAttempt,
  StoredSnapshotJobEvent,
  StoredSnapshotReplicationSchedule,
  ClaimedSnapshotJob,
  ConnectorProvider,
  ConnectorWebhookEventStatus,
  ConnectorSyncAttempt,
  ConnectorSyncCommit,
  ConnectorSyncLease,
  StoredIndexJob,
  StoredConnectorFile,
  StoredConnectorSource,
  StoredConnectorWebhookEvent,
  StoredSourceDocument,
  StoredSourceAccessPolicy,
  StoredWorkspace,
  SyncChange,
  SyncOperation,
  WorkspacePermission,
  WorkspaceSourceMode,
} from "./server/workspace-repository.js";
