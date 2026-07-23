import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EmbeddingProvider } from "../src/embeddings/provider.js";
import { PostgresHybridSearcher } from "../src/search/postgres-hybrid.js";
import type { PostgresStore } from "../src/store/postgres-store.js";
import type { CodeChunk } from "../src/types.js";

type SearchStoreOverrides = Partial<
  Pick<
    PostgresStore,
    | "ftsSearch"
    | "searchSymbols"
    | "searchByPathHints"
    | "semanticSearch"
    | "getChunksByIds"
    | "expandGraph"
  >
>;

function chunk(id: string, path = `src/${id}.ts`): CodeChunk {
  return {
    id,
    path,
    language: "typescript",
    startLine: 1,
    endLine: 3,
    content: `export function ${id}() { return "${id}"; }`,
    symbol: id,
    hash: id,
  };
}

function fakeStore(
  chunks: CodeChunk[],
  overrides: SearchStoreOverrides = {},
): PostgresStore {
  const byId = new Map(chunks.map((item) => [item.id, item]));
  return {
    ftsSearch: async () => [],
    searchSymbols: async () => [],
    searchByPathHints: async () => [],
    semanticSearch: async () => [],
    getChunksByIds: async (ids: string[]) =>
      ids.flatMap((id) => {
        const item = byId.get(id);
        return item ? [item] : [];
      }),
    expandGraph: async () => [],
    ...overrides,
  } as unknown as PostgresStore;
}

describe("PostgresHybridSearcher", () => {
  it("runs hybrid retrieval channels concurrently and caps query fanout", async () => {
    const lexicalChunk = chunk("lexical");
    const started = new Set<string>();
    const symbols = Array.from({ length: 40 }, (_, index) => `SymbolName${index}`);
    const paths = Array.from(
      { length: 40 },
      (_, index) => `src/module${index}/file${index}.ts`,
    );
    let symbolArgs: string[] = [];
    let pathArgs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const store = fakeStore([lexicalChunk], {
      ftsSearch: async () => {
        started.add("fts");
        await gate;
        return [{ id: lexicalChunk.id, score: 1 }];
      },
      searchSymbols: async (names) => {
        started.add("symbol");
        symbolArgs = names;
        await gate;
        return [];
      },
      searchByPathHints: async (hints) => {
        started.add("path");
        pathArgs = hints;
        await gate;
        return [];
      },
      semanticSearch: async () => {
        started.add("semantic");
        await gate;
        return [];
      },
    });
    const embedder: EmbeddingProvider = {
      model: "test-embedding",
      embed: async () => {
        started.add("embed");
        return [[1, 0]];
      },
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, embedder, hasEmbeddings: true });

    const pending = searcher.search({
      query: [...symbols, ...paths].join(" "),
      mode: "hybrid",
      topK: 4,
      diversify: false,
      expandGraph: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedBeforeRelease = new Set(started);
    const capturedSymbols = [...symbolArgs];
    const capturedPaths = [...pathArgs];
    release();
    const hits = await pending;

    assert.deepEqual(
      startedBeforeRelease,
      new Set(["fts", "symbol", "path", "embed", "semantic"]),
      "all independent channels should start before any channel completes",
    );
    assert.equal(capturedSymbols.length, 12);
    assert.deepEqual(capturedSymbols, symbols.slice(0, 12));
    assert.equal(capturedPaths.length, 24);
    assert.deepEqual(capturedPaths, paths.slice(0, 24));
    assert.equal(hits[0]?.chunk.id, lexicalChunk.id);
  });

  it("falls back to lexical retrieval when semantic embeddings are unavailable", async () => {
    const lexicalChunk = chunk("lexicalFallback");
    let ftsCalls = 0;
    let semanticCalls = 0;
    const store = fakeStore([lexicalChunk], {
      ftsSearch: async () => {
        ftsCalls += 1;
        return [{ id: lexicalChunk.id, score: 1 }];
      },
      semanticSearch: async () => {
        semanticCalls += 1;
        return [];
      },
    });
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, hasEmbeddings: false });

    const hits = await searcher.search({
      query: "payment processor",
      mode: "semantic",
      expandGraph: false,
      diversify: false,
    });

    assert.equal(ftsCalls, 1);
    assert.equal(semanticCalls, 0);
    assert.equal(hits[0]?.chunk.id, lexicalChunk.id);
    assert.equal(hits[0]?.source, "bm25");
  });

  it("fails closed for commit candidates and graph expansion under a source policy", async () => {
    const visible = chunk("visibleImplementation");
    const directCommit: CodeChunk = {
      ...chunk("directCommit", ".git/commits/abc1234"),
      language: "git-commit",
      content: "subject: rotate privateBillingCredential",
    };
    const expandedCommit: CodeChunk = {
      ...chunk("expandedCommit", ".git/commits/def5678"),
      language: "git-commit",
      content: "subject: expose denied/path.ts",
    };
    const store = fakeStore([visible, directCommit, expandedCommit], {
      ftsSearch: async () => [
        { id: directCommit.id, score: 2 },
        { id: visible.id, score: 1 },
      ],
      expandGraph: async () => [expandedCommit],
    });
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, hasEmbeddings: false });

    const hits = await searcher.search({
      query: "commit history privateBillingCredential",
      mode: "bm25",
      diversify: false,
      sourceAccess: { defaultAccess: "allow", rules: [] },
    });

    assert.deepEqual(hits.map((hit) => hit.chunk.id), [visible.id]);
  });

  it("keeps commit candidates available without a source policy", async () => {
    const commit: CodeChunk = {
      ...chunk("visibleCommit", ".git/commits/abc1234"),
      language: "git-commit",
      content: "commit abc1234\nsubject: improve commit history",
    };
    const store = fakeStore([commit], {
      ftsSearch: async () => [{ id: commit.id, score: 1 }],
    });
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, hasEmbeddings: false });

    const hits = await searcher.search({
      query: "show commit history",
      mode: "bm25",
      diversify: false,
      expandGraph: false,
    });

    assert.equal(hits[0]?.chunk.id, commit.id);
  });

  it("falls back to lexical retrieval when query embedding fails", async () => {
    const lexicalChunk = chunk("embeddingFailureFallback");
    let ftsCalls = 0;
    let semanticCalls = 0;
    const store = fakeStore([lexicalChunk], {
      ftsSearch: async () => {
        ftsCalls += 1;
        return [{ id: lexicalChunk.id, score: 1 }];
      },
      semanticSearch: async () => {
        semanticCalls += 1;
        return [];
      },
    });
    const embedder: EmbeddingProvider = {
      model: "failing-embedding",
      embed: async () => {
        throw new Error("embedding service unavailable");
      },
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, embedder, hasEmbeddings: true });

    const hits = await searcher.search({
      query: "payment processor",
      mode: "semantic",
      expandGraph: false,
      diversify: false,
    });

    assert.equal(ftsCalls, 1);
    assert.equal(semanticCalls, 0);
    assert.equal(hits[0]?.chunk.id, lexicalChunk.id);
    assert.equal(hits[0]?.source, "bm25");
  });

  it("aborts a hung query embedding at the semantic budget and returns lexical hits", async () => {
    const lexicalChunk = chunk("semanticTimeoutFallback");
    let aborted = false;
    let semanticCalls = 0;
    const store = fakeStore([lexicalChunk], {
      ftsSearch: async () => [{ id: lexicalChunk.id, score: 1 }],
      semanticSearch: async () => {
        semanticCalls += 1;
        return [];
      },
    });
    const embedder: EmbeddingProvider = {
      model: "hung-embedding",
      embed: async (_texts, options) =>
        new Promise<number[][]>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({
      store,
      embedder,
      hasEmbeddings: true,
      reliability: {
        semanticTimeoutMs: 25,
        failureThreshold: 3,
        cooldownMs: 60_000,
      },
    });

    const startedAt = Date.now();
    const hits = await searcher.search({
      query: "payment processor",
      mode: "hybrid",
      expandGraph: false,
      diversify: false,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(aborted, true);
    assert.equal(semanticCalls, 0);
    assert.equal(hits[0]?.chunk.id, lexicalChunk.id);
    assert.equal(hits[0]?.source, "bm25");
    assert.ok(elapsedMs < 500, `semantic fallback took ${elapsedMs}ms`);
  });

  it("opens the semantic circuit after consecutive embedding failures", async () => {
    const lexicalChunk = chunk("semanticCircuitFallback");
    let embedCalls = 0;
    const store = fakeStore([lexicalChunk], {
      ftsSearch: async () => [{ id: lexicalChunk.id, score: 1 }],
    });
    const embedder: EmbeddingProvider = {
      model: "failing-embedding",
      embed: async () => {
        embedCalls += 1;
        throw new Error("embedding unavailable");
      },
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({
      store,
      embedder,
      hasEmbeddings: true,
      reliability: {
        semanticTimeoutMs: 50,
        failureThreshold: 2,
        cooldownMs: 60_000,
      },
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const hits = await searcher.search({
        query: "payment processor",
        mode: "hybrid",
        expandGraph: false,
        diversify: false,
      });
      assert.equal(hits[0]?.chunk.id, lexicalChunk.id);
      assert.equal(hits[0]?.source, "bm25");
    }

    assert.equal(embedCalls, 2, "the open circuit must skip the third model call");
  });

  it("resets accumulated semantic failures after a successful model call", async () => {
    const lexicalChunk = chunk("semanticResetLexical");
    const semanticChunk = chunk("semanticResetDense");
    let embedCalls = 0;
    const store = fakeStore([lexicalChunk, semanticChunk], {
      ftsSearch: async () => [{ id: lexicalChunk.id, score: 1 }],
      semanticSearch: async () => [{ id: semanticChunk.id, score: 0.9 }],
    });
    const embedder: EmbeddingProvider = {
      model: "recovering-embedding",
      embed: async () => {
        embedCalls += 1;
        if (embedCalls === 1 || embedCalls === 3 || embedCalls === 4) {
          throw new Error("temporary embedding failure");
        }
        return [[1, 0]];
      },
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({
      store,
      embedder,
      hasEmbeddings: true,
      reliability: {
        semanticTimeoutMs: 50,
        failureThreshold: 2,
        cooldownMs: 60_000,
      },
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const hits = await searcher.search({
        query: "payment processor",
        mode: "hybrid",
        expandGraph: false,
        diversify: false,
      });
      assert.ok(hits.length > 0);
    }

    assert.equal(
      embedCalls,
      4,
      "the success on call two must reset the first failure before calls three and four reopen the circuit",
    );
  });

  it("times out neural reranking and opens its independent circuit", async () => {
    let rerankRequests = 0;
    const first = chunk("rerankFirst");
    const second = chunk("rerankSecond");
    const store = fakeStore([first, second], {
      ftsSearch: async () => [
        { id: first.id, score: 1 },
        { id: second.id, score: 0.8 },
      ],
    });
    const searcher = new PostgresHybridSearcher(
      async (_config, _query, _documents, options = {}) => {
        rerankRequests += 1;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    );
    searcher.load({
      store,
      hasEmbeddings: false,
      neuralRerank: {
        baseUrl: "http://reranker.invalid/v1",
        model: "hung-reranker",
        topN: 2,
        weight: 0.3,
        maxDocChars: 1_000,
      },
      reliability: {
        rerankTimeoutMs: 25,
        failureThreshold: 2,
        cooldownMs: 60_000,
      },
    });

    const startedAt = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const hits = await searcher.search({
        query: "implementation",
        mode: "bm25",
        expandGraph: false,
        diversify: false,
      });
      assert.equal(hits.length, 2);
      assert.equal(hits.every((hit) => hit.channels?.neural === undefined), true);
    }
    const elapsedMs = Date.now() - startedAt;

    assert.equal(
      rerankRequests,
      2,
      "semantic failures must not affect the separate rerank circuit, which opens after its own failures",
    );
    assert.ok(elapsedMs < 750, `rerank fallback took ${elapsedMs}ms`);
  });

  it("does not run lexical channels when explicit semantic retrieval succeeds", async () => {
    const semanticChunk = chunk("semanticOnly");
    let ftsCalls = 0;
    const store = fakeStore([semanticChunk], {
      ftsSearch: async () => {
        ftsCalls += 1;
        return [];
      },
      semanticSearch: async () => [{ id: semanticChunk.id, score: 0.9 }],
    });
    const embedder: EmbeddingProvider = {
      model: "test-embedding",
      embed: async () => [[1, 0]],
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, embedder, hasEmbeddings: true });

    const hits = await searcher.search({
      query: "payment processor",
      mode: "semantic",
      expandGraph: false,
      diversify: false,
    });

    assert.equal(ftsCalls, 0);
    assert.equal(hits[0]?.chunk.id, semanticChunk.id);
    assert.equal(hits[0]?.source, "semantic");
  });

  it("labels path and semantic evidence as hybrid", async () => {
    const sharedChunk = chunk("pathSemantic", "src/payments/processor.ts");
    const store = fakeStore([sharedChunk], {
      searchByPathHints: async () => [{ id: sharedChunk.id, score: 0.7 }],
      semanticSearch: async () => [{ id: sharedChunk.id, score: 0.9 }],
    });
    const embedder: EmbeddingProvider = {
      model: "test-embedding",
      embed: async () => [[1, 0]],
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({ store, embedder, hasEmbeddings: true });

    const hits = await searcher.search({
      query: "src/payments processor",
      mode: "hybrid",
      expandGraph: false,
      diversify: false,
    });

    assert.equal(hits[0]?.chunk.id, sharedChunk.id);
    assert.equal(hits[0]?.source, "hybrid");
  });
});
