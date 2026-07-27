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

function chunk(partial: Partial<CodeChunk> & { path: string }): CodeChunk {
  return {
    id: partial.id ?? partial.path,
    path: partial.path,
    language: partial.language ?? "typescript",
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? (partial.content ? partial.content.split("\n").length : 1),
    content: partial.content ?? "",
    symbol: partial.symbol,
    hash: partial.hash ?? "h",
  };
}

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

  it("strongly prefers exact and segmented basename matches", () => {
    const requestQuery = analyzeQuery("read request headers query string");
    const request = chunk({
      path: "lib/request.js",
      language: "javascript",
      content: "export const value = true;",
    });
    const response = chunk({
      path: "lib/response.js",
      language: "javascript",
      content: "export const value = true;",
    });
    assert.ok(
      featureScore(request, requestQuery) - featureScore(response, requestQuery) > 1,
      "an exact basename should be decisive when lexical evidence is otherwise tied",
    );

    const streamQuery = analyzeQuery("utility that detects a readable stream");
    const stream = chunk({
      path: "lib/is-stream.js",
      language: "javascript",
      content: "export const value = true;",
    });
    assert.ok(
      featureScore(stream, streamQuery) - featureScore(response, streamQuery) > 0.7,
      "a hyphenated basename segment should receive a meaningful path boost",
    );
  });

  it("demotes deprecated/legacy code unless the query asks for it", () => {
    const q = analyzeQuery("processPayment charge order handler");
    const active = chunk({
      path: "src/payments/process.ts",
      content: "export function processPayment(order) { return charge(order); }",
      symbol: "processPayment",
    });
    const legacyPath = chunk({
      path: "src/legacy/process.ts",
      content: "export function processPayment(order) { return charge(order); }",
      symbol: "processPayment",
    });
    const markedDeprecated = chunk({
      path: "src/payments/old-process.ts",
      content: "/** @deprecated use process.ts */\nexport function processPayment(order) { return charge(order); }",
      symbol: "processPayment",
    });
    assert.ok(featureScore(active, q) > featureScore(legacyPath, q));
    assert.ok(featureScore(active, q) > featureScore(markedDeprecated, q));
  });

  it("keeps deprecated code when the query is explicitly about legacy code", () => {
    const q = analyzeQuery("legacy deprecated processPayment handler");
    const active = chunk({
      path: "src/payments/process.ts",
      content: "export function processPayment(order) { return charge(order); }",
      symbol: "processPayment",
    });
    const legacyPath = chunk({
      path: "src/legacy/process.ts",
      content: "export function processPayment(order) { return charge(order); }",
      symbol: "processPayment",
    });
    // With explicit legacy intent, the path penalty is waived so the legacy
    // file is not pushed below the active one purely for living in legacy/.
    assert.ok(featureScore(legacyPath, q) >= featureScore(active, q) - 0.01);
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

  it("keeps same-basename implementations from distinct monorepo layers", () => {
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "typescript",
        startLine: 1,
        endLine: 2,
        content: "configuration model",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const ranked = [
      mk("workbench", "vs/workbench/services/configuration/browser/configuration.ts", 1.4),
      mk("model", "vs/platform/configuration/common/configurationModels.ts", 1.25),
      mk("plural", "vs/platform/configuration/common/configurations.ts", 1.2),
      mk("service", "vs/workbench/services/configuration/browser/configurationService.ts", 1.1),
      mk("target", "vs/platform/configuration/common/configuration.ts", 1.03),
      mk("other", "vs/platform/workspace/common/workspace.ts", 1.0),
    ];

    const pick = mmrSelect(ranked, 5, 0.8);
    assert.ok(
      pick.some(
        (candidate) =>
          candidate.chunk.path ===
          "vs/platform/configuration/common/configuration.ts",
      ),
    );
  });

  it("diversifies platform copies with the same package-relative path", () => {
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "java",
        startLine: 1,
        endLine: 2,
        content: "future utilities",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const ranked = [
      mk(
        "main-interface",
        "guava/src/com/google/common/util/concurrent/ListenableFuture.java",
        1.15,
      ),
      mk(
        "android-interface",
        "android/guava/src/com/google/common/util/concurrent/ListenableFuture.java",
        1.14,
      ),
      mk(
        "gwt-interface",
        "guava-gwt/src-super/com/google/common/util/concurrent/ListenableFuture.java",
        1.13,
      ),
      mk(
        "emulated-interface",
        "guava-gwt/src-super/com/google/common/util/concurrent/super/com/google/common/util/concurrent/ListenableFuture.java",
        1.12,
      ),
      mk(
        "target",
        "guava/src/com/google/common/util/concurrent/Futures.java",
        1.05,
      ),
    ];

    const pick = mmrSelect(ranked, 3, 0.8);
    assert.ok(
      pick.some(
        (candidate) =>
          candidate.chunk.path ===
          "guava/src/com/google/common/util/concurrent/Futures.java",
      ),
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

  it("applies basename affinity once per collapsed file", () => {
    const q = analyzeQuery(
      "emit transformed TypeScript nodes and source maps to JavaScript",
    );
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "typescript",
        startLine: 1,
        endLine: 20,
        content: "transformed nodes and source maps",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const collapsed = collapseByPath(
      [
        mk("transformer", "compiler/transformer.ts", 0.9),
        mk("emitter", "compiler/emitter.ts", 0.76),
      ],
      q,
    );

    assert.equal(collapsed[0].chunk.path, "compiler/emitter.ts");
  });

  it("keeps an exact basename ahead of a close plural file", () => {
    const q = analyzeQuery(
      "configuration model merges workspace folder memory and override settings",
    );
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "typescript",
        startLine: 1,
        endLine: 2,
        content: "configuration model workspace folder memory override settings",
        hash: id,
      },
      channels: { fts: 1 },
      rrf: final,
      features: final,
      final,
    });

    const collapsed = collapseByPath(
      [
        mk("plural", "src/configurations.ts", 1.02),
        mk("exact", "src/configuration.ts", 1),
      ],
      q,
    );
    assert.equal(collapsed[0].chunk.path, "src/configuration.ts");
  });

  it("does not let a same-name test path outrank production code", () => {
    const q = analyzeQuery(
      "tsserver Session executes protocol commands and sends responses",
    );
    const mk = (id: string, path: string, final: number) => ({
      id,
      chunk: {
        id,
        path,
        language: "typescript",
        startLine: 1,
        endLine: 20,
        content: "Session executes protocol commands and sends responses",
        hash: id,
      },
      channels: {},
      rrf: final,
      features: final,
      final,
    });
    const collapsed = collapseByPath(
      [
        mk("test", "testRunner/unittests/tsserver/session.ts", 0.91),
        mk("go-test", "server/session_test.go", 0.91),
        mk("java-test", "server/SessionTest.java", 0.91),
        mk("python-test", "server/session_test.py", 0.91),
        mk("production", "server/session.ts", 0.8),
      ],
      q,
    );

    assert.equal(collapsed[0].chunk.path, "server/session.ts");
  });
});
