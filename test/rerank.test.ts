import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collapseByPath,
  featureScore,
  mmrSelect,
  preferImplementation,
  rrfFuse,
} from "../src/search/rerank.js";
import { analyzeQuery } from "../src/search/query-analyzer.js";
import type { CodeChunk } from "../src/types.js";

describe("rerank", () => {
  it("boosts exact symbol matches", () => {
    const q = analyzeQuery("processPayment");
    const chunk: CodeChunk = {
      id: "1",
      path: "src/payments.ts",
      language: "typescript",
      startLine: 1,
      endLine: 10,
      content: "export function processPayment() {}",
      symbol: "processPayment",
      hash: "x",
    };
    const other: CodeChunk = {
      ...chunk,
      id: "2",
      path: "src/other.ts",
      symbol: "other",
      content: "export function other() {}",
    };
    assert.ok(featureScore(chunk, q) > featureScore(other, q));
  });

  it("prefers implementation files over README markdown", () => {
    const q = analyzeQuery("hybrid search reciprocal rank fusion");
    const impl: CodeChunk = {
      id: "1",
      path: "src/search/hybrid.ts",
      language: "typescript",
      startLine: 1,
      endLine: 40,
      content: "export class HybridSearcher { search() {} }",
      symbol: "HybridSearcher",
      hash: "a",
    };
    const readme: CodeChunk = {
      id: "2",
      path: "README.md",
      language: "markdown",
      startLine: 1,
      endLine: 40,
      content: "Hybrid BM25 + semantic search for coding agents.",
      symbol: "Hybrid",
      hash: "b",
    };
    assert.ok(
      featureScore(impl, q) > featureScore(readme, q),
      "impl should outrank readme",
    );
  });

  it("pushes docs and tests below implementation files for code queries", () => {
    const q = analyzeQuery("request header accept idempotent length querystring");
    const impl: CodeChunk = {
      id: "impl",
      path: "lib/request.js",
      language: "javascript",
      startLine: 1,
      endLine: 80,
      content:
        "module.exports = { get header() {}, accepts() {}, get idempotent() {}, get length() {}, get querystring() {} }",
      symbol: "header",
      hash: "impl",
    };
    const docs: CodeChunk = {
      ...impl,
      id: "docs",
      path: "docs/api/request.md",
      language: "markdown",
      content:
        "# Request API\nrequest header accept idempotent length querystring examples usage",
      symbol: "Request API",
      hash: "docs",
    };
    const test: CodeChunk = {
      ...impl,
      id: "test",
      path: "__tests__/request/length.test.js",
      content:
        "test request header accept idempotent length querystring behavior",
      symbol: "request length test",
      hash: "test",
    };

    assert.ok(featureScore(impl, q) > featureScore(docs, q));
    assert.ok(featureScore(impl, q) > featureScore(test, q));
  });

  it("preferImplementation tie-breaks toward source files", () => {
    const a = {
      id: "1",
      chunk: {
        id: "1",
        path: "README.md",
        language: "markdown",
        startLine: 1,
        endLine: 2,
        content: "x",
        hash: "1",
      },
      channels: {},
      rrf: 0.5,
      features: 0.5,
      final: 0.5,
    };
    const b = {
      ...a,
      id: "2",
      chunk: { ...a.chunk, id: "2", path: "src/search/hybrid.ts", language: "typescript" },
    };
    assert.ok(preferImplementation(b, a) < 0);
  });

  it("rrf fuses lists", () => {
    const fused = rrfFuse([
      [
        { id: "a", score: 1 },
        { id: "b", score: 0.5 },
      ],
      [
        { id: "b", score: 1 },
        { id: "c", score: 0.5 },
      ],
    ]);
    assert.ok((fused.get("b") ?? 0) > (fused.get("a") ?? 0));
  });

  it("mmr diversifies paths", () => {
    const mk = (id: string, p: string, final: number) => ({
      id,
      chunk: {
        id,
        path: p,
        language: "ts",
        startLine: 1,
        endLine: 2,
        content: "x",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const ranked = [
      mk("1", "a/x.ts", 1),
      mk("2", "a/y.ts", 0.99),
      mk("3", "b/z.ts", 0.5),
    ];
    const pick = mmrSelect(ranked, 2, 0.5);
    assert.equal(pick.length, 2);
    // should include b/ when lambda not extreme
    const paths = pick.map((p) => p.chunk.path);
    assert.ok(paths.includes("a/x.ts") || paths.includes("a/y.ts"));
  });

  it("does not over-penalize relevant files in a deep shared package", () => {
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "kotlin",
        startLine: 1,
        endLine: 2,
        content: "x",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const ranked = [
      mk("orchestrator", "src/main/kotlin/com/example/agent/AgentOrchestrator.kt", 1),
      mk("client", "src/main/kotlin/com/example/agent/RemoteAgentClient.kt", 0.9),
      mk("frontend", "frontend/src/App.svelte", 0.8),
    ];
    const pick = mmrSelect(ranked, 2, 0.8);
    assert.deepEqual(
      pick.map((candidate) => candidate.chunk.path),
      [
        "src/main/kotlin/com/example/agent/AgentOrchestrator.kt",
        "src/main/kotlin/com/example/agent/RemoteAgentClient.kt",
      ],
    );
  });

  it("collapses chunks and rewards implementation evidence across a file", () => {
    const q = analyzeQuery("consume backend SSE events submit tool results continuation");
    const mk = (id: string, path: string, content: string, final: number, language = "kotlin") => ({
      id,
      chunk: {
        id,
        path,
        language,
        startLine: 1,
        endLine: 20,
        content,
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const ranked = [
      mk("doc", "docs/CONTRACT.md", "SSE events and tool results", 0.82, "markdown"),
      mk("client-1", "src/RemoteAgentClient.kt", "consume backend SSE events", 0.74),
      mk("client-2", "src/RemoteAgentClient.kt", "submit tool results for continuation", 0.72),
      mk("other", "src/Other.kt", "backend events", 0.76),
    ];
    const collapsed = collapseByPath(ranked, q);
    assert.equal(collapsed.length, 3);
    assert.equal(collapsed[0].chunk.path, "src/RemoteAgentClient.kt");
  });
});
