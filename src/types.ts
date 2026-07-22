/** A contiguous, searchable slice of source code. */
export interface CodeChunk {
  id: string;
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  /** Optional symbol / heading extracted from the chunk. */
  symbol?: string;
  /** Content hash for incremental indexing. */
  hash: string;
}

export interface SearchHit {
  chunk: CodeChunk;
  score: number;
  /** bm25 | semantic | hybrid */
  source: "bm25" | "semantic" | "hybrid";
  preview: string;
  /** Per-channel scores when multi-signal retrieval is used */
  channels?: {
    fts?: number;
    symbol?: number;
    path?: number;
    semantic?: number;
    graph?: number;
    /** Neural / cross-encoder rerank (optional) */
    neural?: number;
  };
  intent?: string;
  /** Optional channels that were unavailable and forced a degraded result. */
  degradedChannels?: string[];
}

export interface IndexStats {
  root: string;
  dbPath: string;
  chunkCount: number;
  fileCount: number;
  hasEmbeddings: boolean;
  embeddingModel: string | null;
  lastIndexedAt: string | null;
  indexVersion: number;
  hasFts?: boolean;
  /** Immutable index generation currently serving queries. */
  generationId?: string | null;
  /** Revision observed from the source workspace when indexing started. */
  sourceRevision?: string | null;
  /** Revision of the generation currently serving queries. */
  indexedRevision?: string | null;
  /** Revision being built by an in-flight generation, if any. */
  pendingRevision?: string | null;
}

export interface EmbeddingsConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
}

/** Additional root to index (multi-repo / docs). */
export interface IndexRoot {
  /** Short alias used as path prefix when multiple roots exist. */
  name: string;
  /** Absolute path */
  path: string;
  /** code | docs */
  kind?: "code" | "docs";
}

export interface EngineConfig {
  /** Absolute path to the primary workspace / repo root. */
  root: string;
  /**
   * Stable database namespace for this workspace. Local CLI/MCP runs default
   * to `root`; HTTP workspaces use an opaque server-generated id.
   */
  workspaceId?: string;
  /** PostgreSQL connection URL; pgvector is required for runtime storage. */
  databaseUrl?: string;
  /** Extra roots (other repos, docs trees). */
  extraRoots?: IndexRoot[];
  /** Legacy SQLite data directory, used only by the migration command. */
  dataDir: string;
  embeddings?: EmbeddingsConfig;
  /**
   * Optional neural / cross-encoder rerank (CONTEXTENGINE_NEURAL_RERANK=1).
   * Resolved at engine open time from env.
   */
  neuralRerank?: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    topN: number;
    weight: number;
    maxDocChars: number;
    instruction?: string;
  };
  /** Max file size in bytes to index. */
  maxFileBytes: number;
  /** Preferred max characters per chunk. */
  maxChunkChars: number;
  /**
   * Extra gitignore-style exclude patterns (CLI --exclude / CONTEXTENGINE_EXCLUDE).
   * Applied on top of defaults + .gitignore + .augmentignore + .contextengineignore.
   */
  extraIgnores?: string[];
}

export interface SearchOptions {
  query: string;
  topK?: number;
  pathPrefix?: string;
  /** Server-enforced source visibility policy; omitted means unrestricted. */
  sourceAccess?: SourcePathPolicy;
  language?: string;
  /** Prefer semantic if available; falls back to BM25. */
  mode?: "auto" | "bm25" | "semantic" | "hybrid";
  /** Expand results via import/symbol graph (default true). */
  expandGraph?: boolean;
  /** Include git commit lineage chunks (default true). */
  includeCommits?: boolean;
  /** MMR path diversity when packing ranking (default true). */
  diversify?: boolean;
  /**
   * Override neural rerank for this call.
   * undefined = use engine default; false = force off; true = force on if configured.
   */
  neuralRerank?: boolean;
}

/**
 * How passages are reduced when the packed context would exceed the token
 * budget.
 * - `raw`: keep each passage's leading characters (fast, lossy at the tail).
 * - `extractive`: keep the lines that match the query, dropping unrelated
 *   lines first so the surviving budget carries more task-relevant evidence.
 */
export type PackingPolicy = "raw" | "extractive";

export interface TaskContextOptions {
  task: string;
  topK?: number;
  /** Optional caller-controlled cap for the returned packed context. */
  maxTokens?: number;
  pathPrefix?: string;
  /** Server-enforced source visibility policy; omitted means unrestricted. */
  sourceAccess?: SourcePathPolicy;
  /** Use MMR diversification (default true). */
  diversify?: boolean;
  /** Passage reduction strategy under a token budget (default `raw`). */
  packing?: PackingPolicy;
}

export type SourceAccessEffect = "allow" | "deny";

export interface SourcePathRule {
  pathPrefix: string;
  effect: SourceAccessEffect;
}

/** Most-specific path rule wins; equal-specificity deny wins. */
export interface SourcePathPolicy {
  defaultAccess: SourceAccessEffect;
  rules: readonly SourcePathRule[];
}

/**
 * Reproducible retrieval trace for one packed response. Lets evals and agents
 * compare runs on the same axes Augment reports: which index generation and
 * revision served the query, which retrieval channels contributed, what was
 * degraded, and how many candidates survived into the pack.
 */
export interface RetrievalTrace {
  /** Query intent classified by the analyzer (symbol/path/concept/...). */
  intent: string;
  /**
   * Salient concepts the analyzer extracted from the query — identifiers and
   * expanded terms the retrieval channels actually keyed on. Surfaces "what the
   * engine understood" for a query without exposing internal scoring.
   */
  concepts: string[];
  /** Retrieval channels that produced a score on at least one candidate. */
  channels: string[];
  /** Channels that were unavailable and forced a degraded result. */
  degradedChannels: string[];
  /** Candidates retrieved before packing. */
  candidateCount: number;
  /** Candidates that survived into the packed context. */
  packedCount: number;
  /** Distinct files represented in the pack. */
  fileCount: number;
  /** Estimated tokens in the packed text. */
  estimatedTokens: number;
  /** Whether the pack was capped by the token budget. */
  truncated: boolean;
  /** Passage reduction strategy applied. */
  packing: PackingPolicy;
  /** Immutable index generation that served the query. */
  generationId?: string;
  /** Revision of the generation currently serving queries. */
  indexedRevision?: string;
  /** Revision observed from the source workspace. */
  sourceRevision?: string;
  /** Revision of an in-flight generation, if any. */
  pendingRevision?: string;
  /** When the serving generation was indexed. */
  indexedAt?: string;
}

export interface PackedContext {
  task: string;
  hits: SearchHit[];
  packedText: string;
  estimatedTokens: number;
  truncated: boolean;
  degradedChannels?: string[];
  /** Passage reduction strategy applied to this pack. */
  packing?: PackingPolicy;
  /** Reproducible retrieval trace for evals and cross-run comparison. */
  trace?: RetrievalTrace;
}

export interface IndexProgress {
  phase: "scan" | "chunk" | "embed" | "write" | "done";
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  message?: string;
}
