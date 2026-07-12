import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { CodeChunk, IndexStats } from "../types.js";
import { ensureDir } from "../util/fs.js";
import path from "node:path";
import {
  bufferToVector,
  vectorToBuffer,
} from "../embeddings/provider.js";

const INDEX_VERSION = 2;

function rowToChunk(r: {
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
    id: r.id,
    path: r.path,
    language: r.language,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    symbol: r.symbol ?? undefined,
    hash: r.hash,
  };
}

export class SqliteStore {
  readonly dbPath: string;
  private db: DatabaseSync;
  private ftsReady = false;

  constructor(dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        root_alias TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        symbol TEXT,
        hash TEXT NOT NULL,
        root_alias TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_lang ON chunks(language);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol);

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'def',
        PRIMARY KEY (name_lower, path, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name_lower);
      CREATE INDEX IF NOT EXISTS idx_symbols_chunk ON symbols(chunk_id);
    `);

    this.ensureFts();
    this.setMeta("index_version", String(INDEX_VERSION));
  }

  private ensureFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          chunk_id UNINDEXED,
          path,
          symbol,
          content,
          tokenize = 'porter unicode61'
        );
      `);
      this.ftsReady = true;
    } catch {
      // FTS5 unavailable — lexical search falls back to in-memory BM25
      this.ftsReady = false;
    }
  }

  get hasFts(): boolean {
    return this.ftsReady;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getFileHash(relPath: string): string | null {
    const row = this.db
      .prepare("SELECT hash FROM files WHERE path = ?")
      .get(relPath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  listFilePaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM files").all() as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  upsertFile(meta: {
    path: string;
    hash: string;
    language: string;
    mtimeMs: number;
    size: number;
    rootAlias?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO files(path, hash, language, mtime_ms, size, root_alias)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           language = excluded.language,
           mtime_ms = excluded.mtime_ms,
           size = excluded.size,
           root_alias = excluded.root_alias`,
      )
      .run(
        meta.path,
        meta.hash,
        meta.language,
        meta.mtimeMs,
        meta.size,
        meta.rootAlias ?? "",
      );
  }

  deleteFile(relPath: string): void {
    const chunkIds = (
      this.db
        .prepare("SELECT id FROM chunks WHERE path = ?")
        .all(relPath) as Array<{ id: string }>
    ).map((r) => r.id);

    for (const id of chunkIds) {
      this.db.prepare("DELETE FROM embeddings WHERE chunk_id = ?").run(id);
      this.db.prepare("DELETE FROM symbols WHERE chunk_id = ?").run(id);
      if (this.ftsReady) {
        this.db
          .prepare("DELETE FROM chunks_fts WHERE chunk_id = ?")
          .run(id);
      }
    }
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(relPath);
  }

  replaceChunksForFile(relPath: string, chunks: CodeChunk[], rootAlias = ""): void {
    // wipe previous
    const oldIds = (
      this.db
        .prepare("SELECT id FROM chunks WHERE path = ?")
        .all(relPath) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of oldIds) {
      this.db.prepare("DELETE FROM embeddings WHERE chunk_id = ?").run(id);
      this.db.prepare("DELETE FROM symbols WHERE chunk_id = ?").run(id);
      if (this.ftsReady) {
        this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(id);
      }
    }
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);

    const insert = this.db.prepare(
      `INSERT INTO chunks(id, path, language, start_line, end_line, content, symbol, hash, root_alias)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.ftsReady
      ? this.db.prepare(
          `INSERT INTO chunks_fts(chunk_id, path, symbol, content) VALUES (?, ?, ?, ?)`,
        )
      : null;
    const insertSym = this.db.prepare(
      `INSERT OR REPLACE INTO symbols(name, name_lower, path, chunk_id, start_line, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const c of chunks) {
      insert.run(
        c.id,
        c.path,
        c.language,
        c.startLine,
        c.endLine,
        c.content,
        c.symbol ?? null,
        c.hash,
        rootAlias,
      );
      insertFts?.run(c.id, c.path, c.symbol ?? "", c.content);
      if (c.symbol) {
        insertSym.run(
          c.symbol,
          c.symbol.toLowerCase(),
          c.path,
          c.id,
          c.startLine,
          "def",
        );
      }
      // Extract additional defs into symbol table
      for (const name of extractDefNames(c.content)) {
        insertSym.run(name, name.toLowerCase(), c.path, c.id, c.startLine, "def");
      }
    }
  }

  /** Rebuild FTS from chunks table (after import or migration). */
  rebuildFts(): void {
    if (!this.ftsReady) return;
    this.db.exec("DELETE FROM chunks_fts");
    const rows = this.db
      .prepare(`SELECT id, path, symbol, content FROM chunks`)
      .all() as Array<{
      id: string;
      path: string;
      symbol: string | null;
      content: string;
    }>;
    const ins = this.db.prepare(
      `INSERT INTO chunks_fts(chunk_id, path, symbol, content) VALUES (?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.id, r.path, r.symbol ?? "", r.content);
    }
  }

  ftsSearch(
    matchQuery: string,
    limit: number,
  ): Array<{ id: string; score: number }> {
    if (!this.ftsReady || !matchQuery.trim()) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT chunk_id AS id, bm25(chunks_fts) AS rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(matchQuery, limit) as Array<{ id: string; rank: number }>;
      // bm25() in FTS5: lower (more negative) is better — invert
      return rows.map((r) => ({
        id: r.id,
        score: -r.rank,
      }));
    } catch {
      // malformed MATCH — try simplified
      return [];
    }
  }

  searchSymbols(
    names: string[],
    limit: number,
  ): Array<{ id: string; score: number }> {
    if (!names.length) return [];
    const scores = new Map<string, number>();
    for (const name of names) {
      const lower = name.toLowerCase();
      const exact = this.db
        .prepare(
          `SELECT chunk_id, name_lower FROM symbols WHERE name_lower = ? LIMIT ?`,
        )
        .all(lower, limit) as Array<{ chunk_id: string; name_lower: string }>;
      for (const r of exact) {
        scores.set(r.chunk_id, Math.max(scores.get(r.chunk_id) ?? 0, 3));
      }
      const prefix = this.db
        .prepare(
          `SELECT chunk_id FROM symbols WHERE name_lower LIKE ? LIMIT ?`,
        )
        .all(`${lower}%`, limit) as Array<{ chunk_id: string }>;
      for (const r of prefix) {
        scores.set(r.chunk_id, Math.max(scores.get(r.chunk_id) ?? 0, 1.5));
      }
      if (lower.length >= 4) {
        const fuzzy = this.db
          .prepare(
            `SELECT chunk_id FROM symbols WHERE name_lower LIKE ? LIMIT ?`,
          )
          .all(`%${lower}%`, limit) as Array<{ chunk_id: string }>;
        for (const r of fuzzy) {
          scores.set(r.chunk_id, Math.max(scores.get(r.chunk_id) ?? 0, 0.8));
        }
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  searchByPathHints(
    hints: string[],
    limit: number,
  ): Array<{ id: string; score: number }> {
    if (!hints.length) return [];
    const scores = new Map<string, number>();
    for (const hint of hints) {
      const h = `%${hint.replace(/%/g, "")}%`;
      const rows = this.db
        .prepare(
          `SELECT id FROM chunks WHERE path LIKE ? LIMIT ?`,
        )
        .all(h, limit) as Array<{ id: string }>;
      for (const r of rows) {
        scores.set(r.id, Math.max(scores.get(r.id) ?? 0, 2));
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getAllChunks(): CodeChunk[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, language, start_line, end_line, content, symbol, hash
         FROM chunks`,
      )
      .all() as Array<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>;
    return rows.map(rowToChunk);
  }

  getChunk(id: string): CodeChunk | null {
    const r = this.db
      .prepare(
        `SELECT id, path, language, start_line, end_line, content, symbol, hash
         FROM chunks WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          path: string;
          language: string;
          start_line: number;
          end_line: number;
          content: string;
          symbol: string | null;
          hash: string;
        }
      | undefined;
    return r ? rowToChunk(r) : null;
  }

  getChunksByIds(ids: string[]): CodeChunk[] {
    const out: CodeChunk[] = [];
    for (const id of ids) {
      const c = this.getChunk(id);
      if (c) out.push(c);
    }
    return out;
  }

  chunkCount(): number {
    return (
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
          n: number;
        }
      ).n ?? 0
    );
  }

  upsertEmbedding(chunkId: string, model: string, vector: number[]): void {
    this.db
      .prepare(
        `INSERT INTO embeddings(chunk_id, model, dim, vector)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           model = excluded.model,
           dim = excluded.dim,
           vector = excluded.vector`,
      )
      .run(chunkId, model, vector.length, vectorToBuffer(vector));
  }

  getEmbeddings(model?: string): Array<{ chunkId: string; vector: number[] }> {
    const rows = model
      ? (this.db
          .prepare(`SELECT chunk_id, vector FROM embeddings WHERE model = ?`)
          .all(model) as Array<{ chunk_id: string; vector: Buffer }>)
      : (this.db
          .prepare(`SELECT chunk_id, vector FROM embeddings`)
          .all() as Array<{ chunk_id: string; vector: Buffer }>);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      vector: bufferToVector(Buffer.from(r.vector)),
    }));
  }

  getEmbeddingsForIds(
    ids: string[],
    model?: string,
  ): Array<{ chunkId: string; vector: number[] }> {
    const out: Array<{ chunkId: string; vector: number[] }> = [];
    for (const id of ids) {
      const row = model
        ? (this.db
            .prepare(
              `SELECT chunk_id, vector FROM embeddings WHERE chunk_id = ? AND model = ?`,
            )
            .get(id, model) as { chunk_id: string; vector: Buffer } | undefined)
        : (this.db
            .prepare(
              `SELECT chunk_id, vector FROM embeddings WHERE chunk_id = ?`,
            )
            .get(id) as { chunk_id: string; vector: Buffer } | undefined);
      if (row) {
        out.push({
          chunkId: row.chunk_id,
          vector: bufferToVector(Buffer.from(row.vector)),
        });
      }
    }
    return out;
  }

  chunksMissingEmbeddings(model: string): CodeChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.language, c.start_line, c.end_line, c.content, c.symbol, c.hash
         FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
         WHERE e.chunk_id IS NULL`,
      )
      .all(model) as Array<{
      id: string;
      path: string;
      language: string;
      start_line: number;
      end_line: number;
      content: string;
      symbol: string | null;
      hash: string;
    }>;
    return rows.map(rowToChunk);
  }

  stats(root: string): IndexStats {
    const chunkCount = this.chunkCount();
    const fileCount =
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as {
          n: number;
        }
      ).n ?? 0;
    const embRow = this.db
      .prepare(
        `SELECT model, COUNT(*) AS n FROM embeddings GROUP BY model LIMIT 1`,
      )
      .get() as { model: string; n: number } | undefined;
    return {
      root,
      dbPath: this.dbPath,
      chunkCount,
      fileCount,
      hasEmbeddings: Boolean(embRow && embRow.n > 0),
      embeddingModel: embRow?.model ?? null,
      lastIndexedAt: this.getMeta("last_indexed_at"),
      indexVersion: Number(this.getMeta("index_version") ?? INDEX_VERSION),
      hasFts: this.ftsReady,
    };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

const DEF_NAME_RE =
  /(?:function\*?|class|interface|type|enum|def|fn|struct|trait|mod|fun)\s+([A-Za-z_][\w]*)/g;

function extractDefNames(content: string): string[] {
  const names = new Set<string>();
  DEF_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEF_NAME_RE.exec(content))) {
    names.add(m[1]);
  }
  return [...names];
}

export function openStore(dbPath: string): SqliteStore {
  return new SqliteStore(dbPath);
}

export function storeExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
