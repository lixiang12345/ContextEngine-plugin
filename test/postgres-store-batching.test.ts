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
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    query: client.query,
    connect: async () => client,
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
    assert.match(queries[0].text, /c\.language <> 'git-commit'/);
    assert.deepEqual(queries[0].values, [
      "workspace",
      "billing | credential",
      ["private", "private/public"],
      ["deny", "allow"],
      "allow",
      20,
    ]);
  });

  it("keeps commit lineage available when no source policy is active", async () => {
    const { store, queries } = capturingStore();

    await store.ftsSearch("commit history", 20);

    assert.equal(queries.length, 1);
    assert.doesNotMatch(queries[0].text, /language <> 'git-commit'/);
  });

  it("bounds ordinary long FTS queries to four distinctive terms", async () => {
    const { store, queries } = capturingStore();

    await store.ftsSearch(
      "Kubelet synchronizes pods runs admission handlers and manages node status",
      20,
    );

    assert.equal(queries[0].values[1],
      "kubelet | synchronizes | admission | handlers");
  });

  it("groups generic or repeated concept leads into anchors and support", async () => {
    const { store, queries } = capturingStore();

    await store.ftsSearch(
      "create the kube apiserver delegation chain and install APIs",
      20,
    );
    await store.ftsSearch(
      "deployment controller syncs replica sets and rolls out deployments",
      20,
    );

    assert.equal(
      queries[0].values[1],
      "(delegation | apiserver) & (install | create | chain | kube | ap)",
    );
    assert.equal(
      queries[1].values[1],
      "(deployments | deployment) & (controller | replica | syncs | rolls | sets)",
    );
  });

  it("prioritizes a short explicit identifier in bounded PostgreSQL FTS", async () => {
    const { store, queries } = capturingStore();

    await store.ftsSearch(
      "generic API server Config completes secure serving authentication and admission",
      20,
      undefined,
      ["Config", "server"],
    );

    assert.equal(
      queries[0].values[1],
      "(config | server) & (authentication | completes | admission | generic | serving | secure)",
    );
  });

  it("searches a bounded symbol set in one database round trip", async () => {
    const { store, queries } = capturingStore();
    const names = Array.from({ length: 200 }, (_, index) => `Symbol${index}`);

    await store.searchSymbols(names, 20);

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /unnest\(\$2::text\[\]\)/);
    assert.match(queries[0].text, /CROSS JOIN LATERAL/);
    assert.match(queries[0].text, /s\.name_lower LIKE '%' \|\| hints\.name \|\| '%'/);
    assert.match(queries[0].text, /GROUP BY s\.chunk_id/);
    assert.match(queries[0].text, /LIMIT \$3/);
    assert.match(queries[0].text, /MAX\(hint_score\) \+ LEAST/);
    assert.match(queries[0].text, /SUM\(hint_score\) - MAX\(hint_score\)/);
    assert.equal((queries[0].values[1] as string[]).length, 128);
    assert.equal(queries[0].values.at(-1), 20);
  });

  it("uses indexed exact symbol lookup for graph expansion", async () => {
    const { store, queries } = capturingStore();

    await store.expandGraph([chunk("seed", "SeedHandler")], 20);

    assert.match(queries[0].text, /s\.name_lower = ANY\(\$2::text\[\]\)/);
    assert.doesNotMatch(queries[0].text, /LIKE|position|starts_with/);
    assert.equal(queries[0].values.at(-1), 20);
  });

  it("searches path hints at file granularity before choosing one chunk", async () => {
    const { store, queries } = capturingStore();

    await store.searchByPathHints(["server"], 20);

    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /FROM ce_files f/);
    assert.match(queries[0].text, /c\.path = f\.path/);
    assert.match(queries[0].text, /ORDER BY c\.start_line, c\.id/);
    assert.doesNotMatch(
      queries[0].text,
      /FROM ce_chunks c\s+WHERE[^]*lower\(c\.path\) LIKE/,
    );
  });

  it("refreshes planner statistics with bounded statement and lock timeouts", async () => {
    const { store, queries } = capturingStore();

    assert.equal(await store.refreshPlannerStatistics(12_000), true);

    assert.equal(queries[0].text, "BEGIN");
    assert.match(queries[1].text, /set_config\('statement_timeout'/);
    assert.deepEqual(queries[1].values, ["12000ms", "5000ms"]);
    assert.deepEqual(
      queries.slice(2, -1).map((query) => query.text),
      [
        "ANALYZE ce_files",
        "ANALYZE ce_chunks",
        "ANALYZE ce_symbols",
        "ANALYZE ce_imports",
        "ANALYZE ce_embeddings",
      ],
    );
    assert.equal(queries.at(-1)?.text, "COMMIT");
  });
});
