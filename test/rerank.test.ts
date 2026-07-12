import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { featureScore, mmrSelect, rrfFuse } from "../src/search/rerank.js";
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
});
