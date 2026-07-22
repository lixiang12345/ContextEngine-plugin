import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { PostgresStore } from "../src/store/postgres-store.js";
import type { CodeChunk } from "../src/types.js";

type CapturedQuery = { text: string; values: unknown[] };

function capturingStore(): {
  store: PostgresStore;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows: [] };
    },
  } as unknown as Pool;
  const StoreConstructor = PostgresStore as unknown as new (
    databaseUrl: string,
    workspaceId: string,
    pool: Pool,
    client: null,
  ) => PostgresStore;
  return {
    store: new StoreConstructor("postgresql://test", "workspace", pool, null),
    queries,
  };
}

function chunk(id: string, symbol: string): CodeChunk {
  return {
    id,
    path: "src/example.ts",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    content: `import { dependency } from "./dependency";\nexport function ${symbol}() { return dependency; }`,
    symbol,
    hash: `${id}-hash`,
  };
}

describe("PostgresStore batched writes", () => {
  it("writes chunks, symbols, and imports in bounded query batches", async () => {
    const { store, queries } = capturingStore();

    await store.replaceChunksForFile(
      "src/example.ts",
      [chunk("one", "firstHandler"), chunk("two", "secondHandler")],
      "main",
    );

    assert.equal(queries.length, 5);
    assert.match(queries[2].text, /jsonb_to_recordset/);
    assert.equal(JSON.parse(String(queries[2].values[1])).length, 2);
    assert.match(queries[3].text, /INSERT INTO ce_symbols/);
    assert.match(queries[4].text, /unnest\(\$3::text\[\]\)/);
  });

  it("upserts an embedding page in one query", async () => {
    const { store, queries } = capturingStore();

    await store.upsertEmbeddings("embedding-model", [
      { chunkId: "one", vector: [0.1, 0.2] },
      { chunkId: "two", vector: [0.3, 0.4] },
    ]);

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /jsonb_to_recordset/);
    const rows = JSON.parse(String(queries[0].values[2])) as unknown[];
    assert.equal(rows.length, 2);
  });

  it("uses keyset pagination for missing embeddings", async () => {
    const { store, queries } = capturingStore();

    await store.chunksMissingEmbeddings("embedding-model", 64, "chunk-100");

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /c\.id > \$3/);
    assert.deepEqual(queries[0].values, [
      "workspace",
      "embedding-model",
      "chunk-100",
      64,
    ]);
  });

  it("deletes one file with one database round trip", async () => {
    const { store, queries } = capturingStore();

    await store.deleteFile("src/example.ts");

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /WITH deleted_imports/);
  });

  it("pushes most-specific source ACL evaluation into retrieval SQL", async () => {
    const { store, queries } = capturingStore();

    await store.ftsSearch("billing credential", 20, {
      sourceAccess: {
        defaultAccess: "allow",
        rules: [
          { pathPrefix: "private", effect: "deny" },
          { pathPrefix: "private/public", effect: "allow" },
        ],
      },
    });

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /unnest\(\$3::text\[\], \$4::text\[\]\)/);
    assert.match(queries[0].text, /ORDER BY length\(rule\.path_prefix\) DESC/);
    assert.match(queries[0].text, /CASE rule\.effect WHEN 'deny' THEN 1/);
    assert.deepEqual(queries[0].values, [
      "workspace",
      "billing | credential",
      ["private", "private/public"],
      ["deny", "allow"],
      "allow",
      20,
    ]);
  });
});
