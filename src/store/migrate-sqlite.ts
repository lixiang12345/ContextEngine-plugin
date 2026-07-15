import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CodeChunk, EngineConfig } from "../types.js";
import { bufferToVector } from "../embeddings/provider.js";
import { PostgresStore } from "./postgres-store.js";

interface LegacyFile {
  path: string;
  hash: string;
  language: string;
  mtime_ms: number;
  size: number;
  root_alias: string;
}

interface LegacyChunk {
  id: string;
  path: string;
  language: string;
  start_line: number;
  end_line: number;
  content: string;
  symbol: string | null;
  hash: string;
  root_alias: string;
}

interface LegacyEmbedding {
  chunk_id: string;
  model: string;
  dim: number;
  vector: Buffer;
}

export interface SqliteMigrationResult {
  ok: true;
  source: string;
  workspace: string;
  filesMigrated: number;
  chunksMigrated: number;
  embeddingsMigrated: number;
  embeddingDimensions: number[];
}

/**
 * One-time migration for ContextEngine v2 SQLite indexes. SQLite remains
 * read-only input here; PostgreSQL + pgvector is the sole runtime store.
 */
export async function migrateSqliteIndex(
  sourcePath: string,
  config: EngineConfig,
): Promise<SqliteMigrationResult> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Legacy SQLite index not found: ${sourcePath}`);
  }
  if (!config.databaseUrl) {
    throw new Error(
      "CONTEXTENGINE_DATABASE_URL is required to migrate into PostgreSQL.",
    );
  }

  const legacy = new DatabaseSync(sourcePath);
  let store: PostgresStore | null = null;
  try {
    const files = legacy
      .prepare(
        `SELECT path, hash, language, mtime_ms, size, root_alias FROM files`,
      )
      .all() as unknown as LegacyFile[];
    const rows = legacy
      .prepare(
        `SELECT id, path, language, start_line, end_line, content, symbol, hash, root_alias
         FROM chunks
         ORDER BY path, start_line`,
      )
      .all() as unknown as LegacyChunk[];
    const embeddings = legacy
      .prepare(`SELECT chunk_id, model, dim, vector FROM embeddings`)
      .all() as unknown as LegacyEmbedding[];
    const meta = legacy
      .prepare(`SELECT key, value FROM meta`)
      .all() as Array<{ key: string; value: string }>;

    const chunksByPath = new Map<string, CodeChunk[]>();
    const rootAliases = new Map<string, string>();
    for (const row of rows) {
      const chunks = chunksByPath.get(row.path) ?? [];
      chunks.push({
        id: row.id,
        path: row.path,
        language: row.language,
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
        symbol: row.symbol ?? undefined,
        hash: row.hash,
      });
      chunksByPath.set(row.path, chunks);
      rootAliases.set(row.path, row.root_alias ?? "");
    }

    store = await PostgresStore.open({
      databaseUrl: config.databaseUrl,
      workspaceId: config.root,
    });
    await store.clearWorkspace();

    await store.transaction(async (tx) => {
      for (const file of files) {
        await tx.upsertFile({
          path: file.path,
          hash: file.hash,
          language: file.language,
          mtimeMs: file.mtime_ms,
          size: file.size,
          rootAlias: file.root_alias ?? "",
        });
      }
      for (const [relPath, chunks] of chunksByPath) {
        await tx.replaceChunksForFile(
          relPath,
          chunks,
          rootAliases.get(relPath) ?? "",
        );
      }
      for (const embedding of embeddings) {
        const vector = bufferToVector(Buffer.from(embedding.vector));
        await tx.upsertEmbedding(
          embedding.chunk_id,
          embedding.model,
          vector,
        );
      }
    });

    for (const item of meta) {
      if (item.key !== "root" && item.key !== "index_version") {
        await store.setMeta(item.key, item.value);
      }
    }
    const dimensions = [
      ...new Set(embeddings.map((embedding) => embedding.dim)),
    ].sort((a, b) => a - b);
    for (const dim of dimensions) await store.ensureVectorIndex(dim);

    return {
      ok: true,
      source: sourcePath,
      workspace: config.root,
      filesMigrated: files.length,
      chunksMigrated: rows.length,
      embeddingsMigrated: embeddings.length,
      embeddingDimensions: dimensions,
    };
  } finally {
    legacy.close();
    await store?.close();
  }
}
