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
}

export interface EmbeddingsConfig {
  apiKey: string;
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
  /** Extra roots (other repos, docs trees). */
  extraRoots?: IndexRoot[];
  /** Directory that stores the SQLite index (default: <root>/.contextengine). */
  dataDir: string;
  embeddings?: EmbeddingsConfig;
  /**
   * Optional neural / cross-encoder rerank (CONTEXTENGINE_NEURAL_RERANK=1).
   * Resolved at engine open time from env.
   */
  neuralRerank?: {
    apiKey: string;
    baseUrl: string;
    model: string;
    topN: number;
    weight: number;
    maxDocChars: number;
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

export interface TaskContextOptions {
  task: string;
  topK?: number;
  /** Optional caller-controlled cap for the returned packed context. */
  maxTokens?: number;
  pathPrefix?: string;
  /** Use MMR diversification (default true). */
  diversify?: boolean;
}

export interface PackedContext {
  task: string;
  hits: SearchHit[];
  packedText: string;
  estimatedTokens: number;
  truncated: boolean;
}

export interface IndexProgress {
  phase: "scan" | "chunk" | "embed" | "write" | "done";
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  message?: string;
}
