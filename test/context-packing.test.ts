import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContextEngine } from "../src/engine";
import type { SearchHit, SearchOptions } from "../src/types";

class StubContextEngine extends ContextEngine {
  constructor(
    private readonly stubHits: SearchHit[],
    freshness?: {
      indexedAt?: string;
      indexVersion?: number;
      generationId?: string;
      sourceRevision?: string;
      indexedRevision?: string;
      pendingRevision?: string;
    },
  ) {
    super({
      root: "/repo",
      dataDir: "/tmp/contextengine-test",
      maxFileBytes: 1_000_000,
      maxChunkChars: 20_000,
    });
    if (freshness) Object.assign(this, { indexFreshness: freshness });
  }

  override async search(_opts: SearchOptions): Promise<SearchHit[]> {
    return this.stubHits;
  }
}

function hit(
  id: string,
  path: string,
  content: string,
  score: number,
  range: { startLine?: number; endLine?: number } = {},
  hash = `hash-${id}`,
): SearchHit {
  return {
    chunk: {
      id,
      path,
      language: "typescript",
      startLine: range.startLine ?? 1,
      endLine: range.endLine ?? content.split("\n").length,
      content,
      hash,
    },
    score,
    source: "hybrid",
    preview: content.slice(0, 120),
  };
}

describe("context packing", () => {
  const hits = [
    hit(
      "alpha",
      "src/alpha.ts",
      "export const alpha = 1;\n".repeat(20),
      0.98,
    ),
    hit(
      "beta",
      "src/beta.ts",
      "export const beta = 2;\n".repeat(20),
      0.91,
    ),
  ];

  test("returns every reranked hit when no caller cap is supplied", async () => {
    const engine = new StubContextEngine(hits);

    const result = await engine.getTaskContext({ task: "alpha beta", topK: 2 });

    assert.equal(result.hits.length, 2);
    assert.equal(result.truncated, false);
    assert.match(result.packedText, /src\/alpha\.ts/);
    assert.match(result.packedText, /src\/beta\.ts/);
  });

  test("honors an explicit caller-provided token cap", async () => {
    const engine = new StubContextEngine(hits);

    const result = await engine.getTaskContext({
      task: "alpha beta",
      topK: 2,
      maxTokens: 300,
    });

    assert.equal(result.truncated, true);
    assert.ok(result.hits.length >= 1);
    assert.ok(result.estimatedTokens <= 300);
    assert.ok(result.packedText.length <= 300 * 4);
    assert.match(result.packedText, /src\/alpha\.ts/);
    assert.match(result.packedText, /content truncated to token budget/);
    assert.match(result.packedText, /"path":"src\/alpha\.ts"/);
    assert.match(result.packedText, /"lines":\{"start":1,"end":21\}/);
    assert.match(result.packedText, /"hash":"hash-alpha"/);
  });

  test("packs complementary passages from one file in ranked rounds", async () => {
    const engine = new StubContextEngine([
      hit(
        "alpha-primary",
        "src/alpha.ts",
        "export function firstAlpha() { return 1; }",
        0.99,
        { startLine: 1, endLine: 5 },
      ),
      hit(
        "alpha-duplicate",
        "src/alpha.ts",
        "export function duplicateAlpha() { return 2; }",
        0.97,
        { startLine: 1, endLine: 5 },
      ),
      hit(
        "alpha-secondary",
        "src/alpha.ts",
        "export function secondAlpha() { return 3; }",
        0.95,
        { startLine: 20, endLine: 24 },
      ),
      hit(
        "beta-primary",
        "src/beta.ts",
        "export function beta() { return 4; }",
        0.9,
        { startLine: 1, endLine: 4 },
      ),
    ]);

    const result = await engine.getTaskContext({ task: "alpha beta", topK: 4 });

    assert.deepEqual(
      result.hits.map((item) => item.chunk.id),
      ["alpha-primary", "beta-primary", "alpha-secondary"],
    );
    assert.match(result.packedText, /src\/alpha\.ts:20-24/);
    assert.doesNotMatch(result.packedText, /alpha-duplicate/);
  });

  test("truncates the first oversized passage without exceeding the cap", async () => {
    const engine = new StubContextEngine([
      hit(
        "oversized",
        "src/oversized.ts",
        "export const oversized = true;\n".repeat(500),
        1,
        { startLine: 1, endLine: 500 },
      ),
    ]);

    const result = await engine.getTaskContext({
      task: "inspect oversized",
      topK: 1,
      maxTokens: 120,
    });

    assert.equal(result.hits.length, 1);
    assert.equal(result.truncated, true);
    assert.ok(result.estimatedTokens <= 120);
    assert.ok(result.packedText.length <= 120 * 4);
    assert.match(result.packedText, /content truncated to token budget/);

    const provenanceOnly = await engine.getTaskContext({
      task: "inspect oversized",
      topK: 1,
      maxTokens: 40,
    });
    assert.equal(provenanceOnly.hits.length, 1);
    assert.ok(provenanceOnly.estimatedTokens <= 40);
    assert.match(provenanceOnly.packedText, /"hash":"hash-oversized"/);
  });

  test("includes index freshness in stable passage provenance when available", async () => {
    const engine = new StubContextEngine(
      [hit("fresh", "src/fresh.ts", "export const fresh = true;", 1)],
      {
        indexedAt: "2026-07-20T12:00:00.000Z",
        indexVersion: 3,
        generationId: "generation-7",
        sourceRevision: "source-rev",
        indexedRevision: "indexed-rev",
        pendingRevision: "pending-rev",
      },
    );

    const result = await engine.getTaskContext({ task: "freshness", topK: 1 });

    assert.match(result.packedText, /"indexed_at":"2026-07-20T12:00:00.000Z"/);
    assert.match(result.packedText, /"index_version":3/);
    assert.match(result.packedText, /"generation_id":"generation-7"/);
    assert.match(result.packedText, /"source_revision":"source-rev"/);
    assert.match(result.packedText, /"indexed_revision":"indexed-rev"/);
    assert.match(result.packedText, /"pending_revision":"pending-rev"/);
  });

  test("reports a reproducible retrieval trace with generation and channels", async () => {
    const scored: SearchHit = {
      chunk: {
        id: "traced",
        path: "src/traced.ts",
        language: "typescript",
        startLine: 1,
        endLine: 1,
        content: "export const traced = true;",
        hash: "hash-traced",
      },
      score: 0.9,
      source: "hybrid",
      preview: "export const traced = true;",
      channels: { fts: 0.5, semantic: 0.7 },
      degradedChannels: ["graph"],
    };
    const engine = new StubContextEngine([scored], {
      generationId: "generation-7",
      indexedRevision: "indexed-rev",
      sourceRevision: "source-rev",
      indexedAt: "2026-07-20T12:00:00.000Z",
    });

    const result = await engine.getTaskContext({ task: "traced", topK: 1 });

    assert.ok(result.trace);
    assert.equal(result.trace.generationId, "generation-7");
    assert.equal(result.trace.indexedRevision, "indexed-rev");
    assert.equal(result.trace.candidateCount, 1);
    assert.equal(result.trace.packedCount, 1);
    assert.equal(result.trace.fileCount, 1);
    assert.equal(result.trace.packing, "raw");
    assert.deepEqual([...result.trace.channels].sort(), ["fts", "semantic"]);
    assert.deepEqual(result.trace.degradedChannels, ["graph"]);
    assert.equal(result.trace.estimatedTokens, result.estimatedTokens);
  });

  test("extractive packing keeps query-salient lines a raw cap would drop", async () => {
    // The salient line (processPayment) sits at the tail; a raw leading-char
    // fit under a tight budget would truncate before reaching it.
    const filler = "const unrelatedNoise = 0;\n".repeat(40);
    const content = `${filler}export function processPayment(order) {\n  return charge(order);\n}\n`;
    const engine = new StubContextEngine([
      hit("pay", "src/payments.ts", content, 1, { startLine: 1, endLine: 44 }),
    ]);

    const raw = await engine.getTaskContext({
      task: "where is processPayment defined",
      topK: 1,
      maxTokens: 220,
      packing: "raw",
    });
    const extractive = await engine.getTaskContext({
      task: "where is processPayment defined",
      topK: 1,
      maxTokens: 220,
      packing: "extractive",
    });

    assert.equal(extractive.packing, "extractive");
    assert.ok(extractive.packedText.length <= 220 * 4);
    // Raw truncation loses the salient symbol; extractive preserves it.
    assert.doesNotMatch(raw.packedText, /processPayment\(order\)/);
    assert.match(extractive.packedText, /processPayment\(order\)/);
    assert.match(extractive.packedText, /unrelated lines omitted/);
  });

  test("extractive packing reports the raw policy by default", async () => {
    const engine = new StubContextEngine([
      hit("a", "src/a.ts", "export const a = 1;", 1),
    ]);

    const result = await engine.getTaskContext({ task: "a", topK: 1 });

    assert.equal(result.packing, "raw");
  });

  test("extractive packing fits salient lines from more files than raw", async () => {
    // Two files, each with a salient line buried under filler. Under a tight
    // budget, raw fills up on the first file's leading characters and stops;
    // extractive elides each file's unrelated lines so both salient lines fit.
    const bulk = (tag: string) =>
      `${"const filler = 0;\n".repeat(30)}export function ${tag}Handler(req) {\n  return handle(req);\n}\n${"const more = 1;\n".repeat(10)}`;
    const engine = new StubContextEngine([
      hit("first", "src/first.ts", bulk("payment"), 0.98, {
        startLine: 1,
        endLine: 44,
      }),
      hit("second", "src/second.ts", bulk("refund"), 0.95, {
        startLine: 1,
        endLine: 44,
      }),
    ]);

    const raw = await engine.getTaskContext({
      task: "paymentHandler refundHandler",
      topK: 2,
      maxTokens: 260,
      packing: "raw",
    });
    const extractive = await engine.getTaskContext({
      task: "paymentHandler refundHandler",
      topK: 2,
      maxTokens: 260,
      packing: "extractive",
    });

    // Raw stops after the first file; extractive keeps both files' salient lines.
    assert.equal(raw.hits.length, 1);
    assert.ok(extractive.hits.length >= 2);
    assert.match(extractive.packedText, /paymentHandler\(req\)/);
    assert.match(extractive.packedText, /refundHandler\(req\)/);
    assert.ok(extractive.trace);
    assert.ok(extractive.trace.fileCount >= 2);
  });
});
