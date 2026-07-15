import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import pgvector from "pgvector/pg";
import path from "node:path";
import type { CodeChunk, IndexStats } from "../types.js";
import { extractImports } from "../graph/symbol-graph.js";
import { tokenize } from "../search/bm25.js";

const INDEX_VERSION = 3;
const SCHEMA_LOCK_ID = 842847321;

export interface StoreSearchFilter {
  pathPrefix?: string;
  language?: string;
  includeCommits?: boolean;
}

interface PostgresStoreOptions {
  databaseUrl: string;
  workspaceId: string;
}

interface FileMetadata {
  path: string;
  hash: string;
  language: string;
  mtimeMs: number;
  size: number;
  rootAlias?: string;
}

function rowToChunk(row: {
  id: string;
  path: string;
  language: string;
  start_line: number;
  end_line: number;
  content: string;
  symbol: string | null;
  hash: string;
}): CodeChunk {
  return {
    id: row.id,
    path: row.path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    symbol: row.symbol ?? undefined,
    hash: row.hash,
  };
}

function searchText(chunk: CodeChunk): string {
  return tokenize(
    [chunk.path, chunk.path, chunk.symbol ?? "", chunk.symbol ?? "", chunk.language, chunk.content].join(
      "\n",
    ),
  ).join(" ");
}

function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "postgresql://configured";
  }
}

function extractDefNames(content: string): string[] {
  const names = new Set<string>();
  const pattern =
    /(?:function\*?|class|interface|type|enum|def|fn|struct|trait|mod|fun)\s+([A-Za-z_][\w]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) names.add(match[1]);
  return [...names];
}

/**
 * Unified PostgreSQL store. Runtime vectors live in pgvector, never in a
 * SQLite BLOB or a process-wide in-memory map.
 */
export class PostgresStore {
  readonly databaseUrl: string;
  readonly workspaceId: string;
  private readonly pool: Pool;
  private readonly client: PoolClient | null;

  private constructor(
    databaseUrl: string,
    workspaceId: string,
    pool: Pool,
    client: PoolClient | null = null,
  ) {
    this.databaseUrl = databaseUrl;
    this.workspaceId = workspaceId;
    this.pool = pool;
    this.client = client;
  }

  static async open(options: PostgresStoreOptions): Promise<PostgresStore> {
    const pool = new Pool({
      connectionString: options.databaseUrl,
      max: Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8),
    });
    const store = new PostgresStore(options.databaseUrl, options.workspaceId, pool);
    try {
      await store.migrate();
    } catch (error) {
      await pool.end();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `PostgreSQL + pgvector is required. Set CONTEXTENGINE_DATABASE_URL and enable the vector extension. ${detail}`,
      );
    }
    return store;
  }

  /**
   * Create shared database objects without assigning index metadata to a
   * particular workspace. HTTP workspace/blob APIs use this before opening an
   * engine namespace.
   */
  static async ensureSchema(databaseUrl: string): Promise<void> {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.CONTEXTENGINE_PG_POOL_MAX || 8),
    });
    const store = new PostgresStore(databaseUrl, "", pool);
    try {
      await store.migrate(false);
    } finally {
      await pool.end();
    }
  }

  get hasFts(): boolean {
    return true;
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }

  async transaction<T>(fn: (store: PostgresStore) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(
        new PostgresStore(this.databaseUrl, this.workspaceId, this.pool, client),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.query<{ value: string }>(
      `SELECT value FROM ce_meta WHERE workspace_id = $1 AND key = $2`,
      [this.workspaceId, key],
    );
    return result.rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO ce_meta(workspace_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
      [this.workspaceId, key, value],
    );
  }

  async getFileHash(relPath: string): Promise<string | null> {
    const result = await this.query<{ hash: string }>(
      `SELECT hash FROM ce_files WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );
    return result.rows[0]?.hash ?? null;
  }

  async listFilePaths(): Promise<string[]> {
    const result = await this.query<{ path: string }>(
      `SELECT path FROM ce_files WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return result.rows.map((row) => row.path);
  }

  async upsertFile(meta: FileMetadata): Promise<void> {
    await this.query(
      `INSERT INTO ce_files(workspace_id, path, hash, language, mtime_ms, size, root_alias)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(workspace_id, path) DO UPDATE SET
         hash = excluded.hash,
         language = excluded.language,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         root_alias = excluded.root_alias`,
      [
        this.workspaceId,
        meta.path,
        meta.hash,
        meta.language,
        Math.round(meta.mtimeMs),
        meta.size,
        meta.rootAlias ?? "",
      ],
    );
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.query(
      `DELETE FROM ce_imports WHERE workspace_id = $1 AND source_path = $2`,
      [this.workspaceId, relPath],
    );
    await this.query(
      `DELETE FROM ce_chunks WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );
    await this.query(
      `DELETE FROM ce_files WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );
  }

  async replaceChunksForFile(
    relPath: string,
    chunks: CodeChunk[],
    rootAlias = "",
  ): Promise<void> {
    await this.query(
      `DELETE FROM ce_imports WHERE workspace_id = $1 AND source_path = $2`,
      [this.workspaceId, relPath],
    );
    await this.query(
      `DELETE FROM ce_chunks WHERE workspace_id = $1 AND path = $2`,
      [this.workspaceId, relPath],
    );

    for (const chunk of chunks) {
      await this.query(
        `INSERT INTO ce_chunks(
           workspace_id, id, path, language, start_line, end_line,
           content, symbol, hash, root_alias, search_vector
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           to_tsvector('simple', $11)
         )`,
        [
          this.workspaceId,
          chunk.id,
          chunk.path,
          chunk.language,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.symbol ?? null,
          chunk.hash,
          rootAlias,
          searchText(chunk),
        ],
      );

      const symbols = new Set<string>([
        ...(chunk.symbol ? [chunk.symbol] : []),
        ...extractDefNames(chunk.content),
      ]);
      for (const name of symbols) {
        await this.query(
          `INSERT INTO ce_symbols(
             workspace_id, name, name_lower, path, chunk_id, start_line, kind
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'def')
           ON CONFLICT(workspace_id, name_lower, path, chunk_id) DO NOTHING`,
          [
            this.workspaceId,
            name,
            name.toLowerCase(),
            chunk.path,
            chunk.id,
            chunk.startLine,
          ],
        );
      }
    }

    if (chunks.length) {
      const imports = extractImports(
        relPath,
        chunks.map((chunk) => chunk.content).join("\n"),
        chunks[0].language,
      ).slice(0, 256);
      for (const targetSpec of imports) {
        await this.query(
          `INSERT INTO ce_imports(workspace_id, source_path, target_spec)
           VALUES ($1, $2, $3)
           ON CONFLICT(workspace_id, source_path, target_spec) DO NOTHING`,
          [this.workspaceId, relPath, targetSpec],
        );
      }
    }
  }

  async ftsSearch(
    query: string,
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const terms = [...new Set(tokenize(query))].slice(0, 16);
    if (!terms.length) return [];
    const params: unknown[] = [this.workspaceId, terms.join(" | ")];
    const where = this.filterSql(params, filter, "c");
    params.push(limit);
    const result = await this.query<{ id: string; score: number }>(
      `SELECT c.id, ts_rank_cd(c.search_vector, to_tsquery('simple', $2)) AS score
       FROM ce_chunks c
       WHERE ${where} AND c.search_vector @@ to_tsquery('simple', $2)
       ORDER BY score DESC, c.path
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
  }

  async searchSymbols(
    names: string[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const scores = new Map<string, number>();
    for (const name of names) {
      const lower = name.toLowerCase();
      const params: unknown[] = [this.workspaceId, lower, `${lower}%`, `%${lower}%`];
      const where = this.filterSql(params, filter, "c");
      params.push(limit);
      const result = await this.query<{ id: string; score: number }>(
        `SELECT s.chunk_id AS id,
           MAX(
             CASE
               WHEN s.name_lower = $2 THEN 3.0
               WHEN s.name_lower LIKE $3 THEN 1.5
               WHEN length($2) >= 4 AND s.name_lower LIKE $4 THEN 0.8
               ELSE 0
             END
           ) AS score
         FROM ce_symbols s
         JOIN ce_chunks c
           ON c.workspace_id = s.workspace_id AND c.id = s.chunk_id
         WHERE s.workspace_id = $1
           AND (s.name_lower = $2 OR s.name_lower LIKE $3
             OR (length($2) >= 4 AND s.name_lower LIKE $4))
           AND ${where}
         GROUP BY s.chunk_id
         ORDER BY score DESC
         LIMIT $${params.length}`,
        params,
      );
      for (const row of result.rows) {
        scores.set(row.id, Math.max(scores.get(row.id) ?? 0, Number(row.score)));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async searchByPathHints(
    hints: string[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const scores = new Map<string, number>();
    for (const hint of hints) {
      const normalized = hint.trim().toLowerCase();
      if (normalized.length < 2) continue;
      const escaped = normalized.replace(/[\\%_]/g, "\\$&");
      const params: unknown[] = [this.workspaceId, `%${escaped}%`];
      const where = this.filterSql(params, filter, "c");
      params.push(limit * 2);
      const result = await this.query<{ id: string; path: string }>(
        `SELECT c.id, c.path
         FROM ce_chunks c
         WHERE ${where} AND lower(c.path) LIKE $2 ESCAPE '\\'
         ORDER BY length(c.path), c.path
         LIMIT $${params.length}`,
        params,
      );
      for (const row of result.rows) {
        const base = path.basename(row.path).toLowerCase();
        const stem = base.replace(/\.[^.]+$/, "");
        const score =
          stem === normalized
            ? 3.2
            : base.startsWith(`${normalized}.`)
              ? 3
              : 2;
        scores.set(row.id, Math.max(scores.get(row.id) ?? 0, score));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async semanticSearch(
    queryVector: ArrayLike<number>,
    model: string,
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<Array<{ id: string; score: number }>> {
    const dim = queryVector.length;
    if (!Number.isInteger(dim) || dim <= 0 || dim > 16_000) return [];
    const params: unknown[] = [
      this.workspaceId,
      model,
      dim,
      pgvector.toSql(Array.from(queryVector)),
    ];
    const where = this.filterSql(params, filter, "c");
    params.push(limit);
    const result = await this.query<{ id: string; score: number }>(
      `SELECT e.chunk_id AS id,
              1 - ((e.embedding::vector(${dim})) <=> $4::vector(${dim})) AS score
       FROM ce_embeddings e
       JOIN ce_chunks c
         ON c.workspace_id = e.workspace_id AND c.id = e.chunk_id
       WHERE e.workspace_id = $1
         AND e.model = $2
         AND e.dim = $3
         AND ${where}
       ORDER BY (e.embedding::vector(${dim})) <=> $4::vector(${dim})
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
  }

  async getChunksByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!ids.length) return [];
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT id, path, language, start_line, end_line, content, symbol, hash
       FROM ce_chunks
       WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [this.workspaceId, ids],
    );
    const byId = new Map(result.rows.map((row) => [row.id, rowToChunk(row)]));
    return ids.flatMap((id) => {
      const chunk = byId.get(id);
      return chunk ? [chunk] : [];
    });
  }

  async expandGraph(
    seedChunks: CodeChunk[],
    limit: number,
    filter?: StoreSearchFilter,
  ): Promise<CodeChunk[]> {
    if (!seedChunks.length || limit <= 0) return [];

    const seedIds = new Set(seedChunks.map((chunk) => chunk.id));
    const seedPaths = [...new Set(seedChunks.map((chunk) => chunk.path))];
    const symbols = new Set<string>();
    for (const chunk of seedChunks) {
      if (chunk.symbol) symbols.add(chunk.symbol);
      for (const name of extractDefNames(chunk.content)) symbols.add(name);
    }

    const ids: string[] = [];
    const addIds = (items: Array<{ id: string }>): void => {
      for (const item of items) {
        if (!seedIds.has(item.id) && !ids.includes(item.id)) ids.push(item.id);
      }
    };

    if (symbols.size) {
      addIds(await this.searchSymbols([...symbols], limit, filter));
    }

    const forward = await this.query<{ target_spec: string }>(
      `SELECT target_spec
       FROM ce_imports
       WHERE workspace_id = $1 AND source_path = ANY($2::text[])
       LIMIT $3`,
      [this.workspaceId, seedPaths, Math.max(limit * 8, 32)],
    );
    const specs = [...new Set(forward.rows.map((row) => row.target_spec))];
    if (specs.length) {
      const params: unknown[] = [this.workspaceId, specs];
      const where = this.filterSql(params, filter, "c");
      params.push(limit);
      const related = await this.query<{ id: string }>(
        `SELECT c.id
         FROM ce_chunks c
         WHERE ${where}
           AND EXISTS (
             SELECT 1
             FROM unnest($2::text[]) AS spec
             WHERE c.path = spec
                OR c.path LIKE spec || '.%'
                OR c.path LIKE spec || '/%'
                OR c.path LIKE '%' || '/' || spec || '/%'
           )
         ORDER BY c.path, c.start_line
         LIMIT $${params.length}`,
        params,
      );
      addIds(related.rows);
    }

    const seedPathSpecs = [
      ...new Set([
        ...seedPaths,
        ...seedPaths.map((value) => value.replace(/\.[^.]+$/, "")),
      ]),
    ];
    const reverse = await this.query<{ source_path: string }>(
      `SELECT DISTINCT source_path
       FROM ce_imports
       WHERE workspace_id = $1 AND target_spec = ANY($2::text[])
       LIMIT $3`,
      [this.workspaceId, seedPathSpecs, Math.max(limit * 4, 16)],
    );
    const importingPaths = [
      ...new Set(reverse.rows.map((row) => row.source_path)),
    ];
    if (importingPaths.length) {
      const params: unknown[] = [this.workspaceId, importingPaths];
      const where = this.filterSql(params, filter, "c");
      params.push(limit * 2);
      const related = await this.query<{ id: string }>(
        `SELECT c.id
         FROM ce_chunks c
         WHERE ${where} AND c.path = ANY($2::text[])
         ORDER BY c.path, c.start_line
         LIMIT $${params.length}`,
        params,
      );
      addIds(related.rows);
    }

    return this.getChunksByIds(ids.slice(0, limit));
  }

  async getAllChunks(): Promise<CodeChunk[]> {
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT id, path, language, start_line, end_line, content, symbol, hash
       FROM ce_chunks WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return result.rows.map(rowToChunk);
  }

  async chunkCount(): Promise<number> {
    const result = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ce_chunks WHERE workspace_id = $1`,
      [this.workspaceId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async upsertEmbedding(
    chunkId: string,
    model: string,
    vector: ArrayLike<number>,
  ): Promise<void> {
    await this.query(
      `INSERT INTO ce_embeddings(workspace_id, chunk_id, model, dim, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT(workspace_id, chunk_id) DO UPDATE SET
         model = excluded.model,
         dim = excluded.dim,
         embedding = excluded.embedding`,
      [
        this.workspaceId,
        chunkId,
        model,
        vector.length,
        pgvector.toSql(Array.from(vector)),
      ],
    );
  }

  async embeddingCount(model?: string): Promise<number> {
    const result = await this.query<{ n: string }>(
      model
        ? `SELECT COUNT(*)::text AS n
           FROM ce_embeddings WHERE workspace_id = $1 AND model = $2`
        : `SELECT COUNT(*)::text AS n FROM ce_embeddings WHERE workspace_id = $1`,
      model ? [this.workspaceId, model] : [this.workspaceId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async clearEmbeddings(): Promise<void> {
    await this.query(`DELETE FROM ce_embeddings WHERE workspace_id = $1`, [
      this.workspaceId,
    ]);
  }

  async clearWorkspace(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.query(`DELETE FROM ce_chunks WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_imports WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_files WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
      await tx.query(`DELETE FROM ce_meta WHERE workspace_id = $1`, [
        this.workspaceId,
      ]);
    });
  }

  async countChunksMissingEmbeddings(model: string): Promise<number> {
    const result = await this.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
       FROM ce_chunks c
       LEFT JOIN ce_embeddings e
         ON e.workspace_id = c.workspace_id
        AND e.chunk_id = c.id
        AND e.model = $2
       WHERE c.workspace_id = $1 AND e.chunk_id IS NULL`,
      [this.workspaceId, model],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async chunksMissingEmbeddings(
    model: string,
    limit = 32,
  ): Promise<CodeChunk[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 512));
    const result = await this.query<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>(
      `SELECT c.id, c.path, c.language, c.start_line, c.end_line,
              c.content, c.symbol, c.hash
       FROM ce_chunks c
       LEFT JOIN ce_embeddings e
         ON e.workspace_id = c.workspace_id
        AND e.chunk_id = c.id
        AND e.model = $2
       WHERE c.workspace_id = $1 AND e.chunk_id IS NULL
       ORDER BY c.id
       LIMIT $3`,
      [this.workspaceId, model, boundedLimit],
    );
    return result.rows.map(rowToChunk);
  }

  async ensureVectorIndex(dim: number): Promise<void> {
    if (!Number.isInteger(dim) || dim <= 0 || dim > 16_000) return;
    const indexName = `ce_embeddings_hnsw_${dim}`;
    const client = this.client ?? (await this.pool.connect());
    const release = !this.client;
    try {
      await client.query(`SELECT pg_advisory_lock(${SCHEMA_LOCK_ID})`);
      try {
        await client.query(
          `CREATE INDEX IF NOT EXISTS ${indexName}
           ON ce_embeddings
           USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)
           WHERE dim = ${dim}`,
        );
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${SCHEMA_LOCK_ID})`);
      }
    } finally {
      if (release) client.release();
    }
  }

  async stats(root: string): Promise<IndexStats> {
    const [chunks, files, embeddings, indexedAt, version] = await Promise.all([
      this.chunkCount(),
      this.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ce_files WHERE workspace_id = $1`,
        [this.workspaceId],
      ),
      this.query<{ model: string; n: string }>(
        `SELECT model, COUNT(*)::text AS n
         FROM ce_embeddings
         WHERE workspace_id = $1
         GROUP BY model
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [this.workspaceId],
      ),
      this.getMeta("last_indexed_at"),
      this.getMeta("index_version"),
    ]);
    return {
      root,
      dbPath: redactDatabaseUrl(this.databaseUrl),
      chunkCount: chunks,
      fileCount: Number(files.rows[0]?.n ?? 0),
      hasEmbeddings: Number(embeddings.rows[0]?.n ?? 0) > 0,
      embeddingModel: embeddings.rows[0]?.model ?? null,
      lastIndexedAt: indexedAt,
      indexVersion: Number(version ?? INDEX_VERSION),
      hasFts: true,
    };
  }

  private async migrate(setIndexVersion = true): Promise<void> {
    const client = this.client ?? (await this.pool.connect());
    const release = !this.client;
    try {
      // Extension creation is not race-safe across independent CLI/MCP processes.
      await client.query(`SELECT pg_advisory_lock(${SCHEMA_LOCK_ID})`);
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        await client.query(`
      CREATE TABLE IF NOT EXISTS ce_meta (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );

      CREATE TABLE IF NOT EXISTS ce_files (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        size BIGINT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, path)
      );

      CREATE TABLE IF NOT EXISTS ce_chunks (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        symbol TEXT,
        hash TEXT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT '',
        search_vector tsvector NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS ce_chunks_path_idx
        ON ce_chunks(workspace_id, path);
      CREATE INDEX IF NOT EXISTS ce_chunks_language_idx
        ON ce_chunks(workspace_id, language);
      CREATE INDEX IF NOT EXISTS ce_chunks_symbol_idx
        ON ce_chunks(workspace_id, symbol);
      CREATE INDEX IF NOT EXISTS ce_chunks_search_idx
        ON ce_chunks USING GIN(search_vector);

      CREATE TABLE IF NOT EXISTS ce_embeddings (
        workspace_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        embedding vector NOT NULL,
        PRIMARY KEY (workspace_id, chunk_id),
        FOREIGN KEY (workspace_id, chunk_id)
          REFERENCES ce_chunks(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ce_embeddings_model_idx
        ON ce_embeddings(workspace_id, model, dim);

      CREATE TABLE IF NOT EXISTS ce_symbols (
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'def',
        PRIMARY KEY (workspace_id, name_lower, path, chunk_id),
        FOREIGN KEY (workspace_id, chunk_id)
          REFERENCES ce_chunks(workspace_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ce_symbols_name_idx
        ON ce_symbols(workspace_id, name_lower);
      CREATE INDEX IF NOT EXISTS ce_symbols_chunk_idx
        ON ce_symbols(workspace_id, chunk_id);

      CREATE TABLE IF NOT EXISTS ce_imports (
        workspace_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_spec TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_path, target_spec)
      );
      CREATE INDEX IF NOT EXISTS ce_imports_source_idx
        ON ce_imports(workspace_id, source_path);
      CREATE INDEX IF NOT EXISTS ce_imports_target_idx
        ON ce_imports(workspace_id, target_spec);

      CREATE TABLE IF NOT EXISTS ce_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_mode TEXT NOT NULL CHECK (source_mode IN ('blob', 'local')),
        local_root TEXT,
        revision BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ce_source_blobs (
        hash TEXT PRIMARY KEY,
        content BYTEA NOT NULL,
        bytes BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (hash ~ '^[0-9a-f]{64}$')
      );

      CREATE TABLE IF NOT EXISTS ce_workspace_sources (
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        blob_hash TEXT NOT NULL REFERENCES ce_source_blobs(hash),
        language TEXT NOT NULL,
        mtime_ms BIGINT NOT NULL,
        size BIGINT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT 'main',
        revision BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, path)
      );
      CREATE INDEX IF NOT EXISTS ce_workspace_sources_blob_idx
        ON ce_workspace_sources(blob_hash);

      CREATE TABLE IF NOT EXISTS ce_sync_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        base_revision BIGINT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'committed', 'aborted')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ce_sync_sessions_workspace_idx
        ON ce_sync_sessions(workspace_id, status);

      CREATE TABLE IF NOT EXISTS ce_sync_changes (
        session_id TEXT NOT NULL REFERENCES ce_sync_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('upsert', 'delete', 'rename')),
        path TEXT NOT NULL,
        old_path TEXT,
        blob_hash TEXT,
        language TEXT,
        mtime_ms BIGINT,
        size BIGINT,
        root_alias TEXT,
        PRIMARY KEY (session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS ce_index_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES ce_workspaces(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('incremental', 'rebuild')),
        changed_paths JSONB,
        deleted_paths JSONB,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        progress JSONB,
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ce_index_jobs_workspace_idx
        ON ce_index_jobs(workspace_id, created_at DESC);
        `);
        if (setIndexVersion && this.workspaceId) {
          await client.query(
            `INSERT INTO ce_meta(workspace_id, key, value)
             VALUES ($1, 'index_version', $2)
             ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
            [this.workspaceId, String(INDEX_VERSION)],
          );
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${SCHEMA_LOCK_ID})`);
      }
    } finally {
      if (release) client.release();
    }
  }

  private filterSql(
    params: unknown[],
    filter: StoreSearchFilter | undefined,
    alias: string,
  ): string {
    const conditions = [`${alias}.workspace_id = $1`];
    if (filter?.pathPrefix) {
      const prefix = filter.pathPrefix
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
      params.push(prefix);
      conditions.push(
        `(${alias}.path = $${params.length} OR ${alias}.path LIKE $${params.length} || '/%')`,
      );
    }
    if (filter?.language) {
      params.push(filter.language);
      conditions.push(`${alias}.language = $${params.length}`);
    }
    if (filter?.includeCommits === false) {
      conditions.push(`${alias}.language <> 'git-commit'`);
    }
    return conditions.join(" AND ");
  }

  private query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client
      ? this.client.query<T>(text, values)
      : this.pool.query<T>(text, values);
  }
}
