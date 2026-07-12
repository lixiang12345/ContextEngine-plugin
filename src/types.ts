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
}

export interface EmbeddingsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
}

export interface EngineConfig {
  /** Absolute path to the workspace / repo root. */
  root: string;
  /** Directory that stores the SQLite index (default: <root>/.contextengine). */
  dataDir: string;
  embeddings?: EmbeddingsConfig;
  /** Max file size in bytes to index. */
  maxFileBytes: number;
  /** Preferred max characters per chunk. */
  maxChunkChars: number;
}

export interface SearchOptions {
  query: string;
  topK?: number;
  pathPrefix?: string;
  language?: string;
  /** Prefer semantic if available; falls back to BM25. */
  mode?: "auto" | "bm25" | "semantic" | "hybrid";
}

export interface TaskContextOptions {
  task: string;
  topK?: number;
  maxTokens?: number;
  pathPrefix?: string;
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
