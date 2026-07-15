import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { resolveEngineConfig } from "../src/config.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { migrateSqliteIndex } from "../src/store/migrate-sqlite.js";
import { PostgresStore } from "../src/store/postgres-store.js";

const describePostgres =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL
    ? describe
    : describe.skip;

describePostgres("SQLite to PostgreSQL migration", () => {
  let root: string;
  let dataDir: string;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "ce-exp-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), `export const x = 1;\n`);
    const legacy = new SqliteStore(path.join(dataDir, "index.db"));
    legacy.upsertFile({
      path: "src/a.ts",
      hash: "legacy-file",
      language: "typescript",
      mtimeMs: Date.now(),
      size: 20,
    });
    legacy.replaceChunksForFile("src/a.ts", [
      {
        id: "legacy-chunk",
        path: "src/a.ts",
        language: "typescript",
        startLine: 1,
        endLine: 1,
        content: "export const x = 1;",
        symbol: "x",
        hash: "legacy-chunk",
      },
    ]);
    legacy.upsertEmbedding("legacy-chunk", "legacy-model", [0.1, 0.2, 0.3]);
    legacy.close();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("moves chunks and BLOB vectors into pgvector", async () => {
    const dbPath = path.join(dataDir, "index.db");
    const result = await migrateSqliteIndex(
      dbPath,
      resolveEngineConfig({ root, dataDir }),
    );
    assert.equal(result.filesMigrated, 1);
    assert.equal(result.chunksMigrated, 1);
    assert.equal(result.embeddingsMigrated, 1);
    assert.deepEqual(result.embeddingDimensions, [3]);

    const engine = ContextEngine.open({ root, dataDir });
    const stats = await engine.stats();
    assert.equal(stats.chunkCount, 1);
    assert.equal(stats.hasEmbeddings, true);
    const hits = await engine.search({
      query: "export x",
      topK: 2,
      mode: "bm25",
    });
    assert.equal(hits[0]?.chunk.id, "legacy-chunk");
    await engine.close();

    const config = resolveEngineConfig({ root, dataDir });
    const store = await PostgresStore.open({
      databaseUrl: config.databaseUrl!,
      workspaceId: root,
    });
    const nearest = await store.semanticSearch(
      [0.1, 0.2, 0.3],
      "legacy-model",
      1,
    );
    assert.equal(nearest[0]?.id, "legacy-chunk");
    await store.close();
  });
});
