import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { CodeChunk, IndexStats } from "../types.js";
import { ensureDir } from "../util/fs.js";
import path from "node:path";
import {
  bufferToVector,
  vectorToBuffer,
} from "../embeddings/provider.js";

const INDEX_VERSION = 1;

export class SqliteStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
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
        size INTEGER NOT NULL
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
        FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_lang ON chunks(language);

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
      );
    `);
    this.setMeta("index_version", String(INDEX_VERSION));
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO files(path, hash, language, mtime_ms, size)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           language = excluded.language,
           mtime_ms = excluded.mtime_ms,
           size = excluded.size`,
      )
      .run(meta.path, meta.hash, meta.language, meta.mtimeMs, meta.size);
  }

  deleteFile(relPath: string): void {
    // embeddings cascade via chunk delete if FK cascade works; be explicit
    this.db
      .prepare(
        `DELETE FROM embeddings WHERE chunk_id IN
         (SELECT id FROM chunks WHERE path = ?)`,
      )
      .run(relPath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(relPath);
  }

  replaceChunksForFile(relPath: string, chunks: CodeChunk[]): void {
    this.db
      .prepare(
        `DELETE FROM embeddings WHERE chunk_id IN
         (SELECT id FROM chunks WHERE path = ?)`,
      )
      .run(relPath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);

    const insert = this.db.prepare(
      `INSERT INTO chunks(id, path, language, start_line, end_line, content, symbol, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    }
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
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      language: r.language,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      symbol: r.symbol ?? undefined,
      hash: r.hash,
    }));
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
    if (!r) return null;
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

  getChunksByIds(ids: string[]): CodeChunk[] {
    const out: CodeChunk[] = [];
    for (const id of ids) {
      const c = this.getChunk(id);
      if (c) out.push(c);
    }
    return out;
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
          .prepare(
            `SELECT chunk_id, vector FROM embeddings WHERE model = ?`,
          )
          .all(model) as Array<{ chunk_id: string; vector: Buffer }>)
      : (this.db
          .prepare(`SELECT chunk_id, vector FROM embeddings`)
          .all() as Array<{ chunk_id: string; vector: Buffer }>);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      vector: bufferToVector(Buffer.from(r.vector)),
    }));
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
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      language: r.language,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      symbol: r.symbol ?? undefined,
      hash: r.hash,
    }));
  }

  stats(root: string): IndexStats {
    const chunkCount =
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
          n: number;
        }
      ).n ?? 0;
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

export function openStore(dbPath: string): SqliteStore {
  return new SqliteStore(dbPath);
}

export function storeExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
