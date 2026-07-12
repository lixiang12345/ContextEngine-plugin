import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blendNeuralScores,
  formatRerankDocument,
  resolveNeuralRerankConfig,
} from "../src/search/neural-rerank.js";

describe("neural rerank helpers", () => {
  it("formatRerankDocument includes path and truncates", () => {
    const text = formatRerankDocument({
      path: "src/pay.ts",
      symbol: "processPayment",
      language: "typescript",
      content: "export function processPayment() { return 1; }\n".repeat(50),
      maxChars: 120,
    });
    assert.match(text, /path: src\/pay\.ts/);
    assert.match(text, /symbol: processPayment/);
    assert.ok(text.length <= 120);
  });

  it("blendNeuralScores lifts high neural scores", () => {
    const cands = [
      { id: "a", final: 0.5, channels: {} as { neural?: number } },
      { id: "b", final: 0.5, channels: {} as { neural?: number } },
    ];
    const scores = new Map([
      ["a", 0.1],
      ["b", 0.9],
    ]);
    blendNeuralScores(cands, scores, 0.5);
    assert.ok(cands[1].final > cands[0].final);
    assert.equal(cands[0].channels.neural, 0.1);
    assert.equal(cands[1].channels.neural, 0.9);
  });

  it("resolveNeuralRerankConfig respects enable flag", () => {
    const prev = {
      enable: process.env.CONTEXTENGINE_NEURAL_RERANK,
      key: process.env.OPENAI_API_KEY,
      base: process.env.OPENAI_BASE_URL,
    };
    try {
      delete process.env.CONTEXTENGINE_NEURAL_RERANK;
      delete process.env.OPENAI_API_KEY;
      assert.equal(resolveNeuralRerankConfig(), undefined);

      process.env.CONTEXTENGINE_NEURAL_RERANK = "1";
      process.env.OPENAI_API_KEY = "test-key";
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:18000/v1";
      const cfg = resolveNeuralRerankConfig();
      assert.ok(cfg);
      assert.equal(cfg!.apiKey, "test-key");
      assert.equal(cfg!.baseUrl, "http://127.0.0.1:18000/v1");
      assert.ok(cfg!.topN >= 2);
      assert.ok(cfg!.weight > 0 && cfg!.weight < 1);
    } finally {
      if (prev.enable === undefined) delete process.env.CONTEXTENGINE_NEURAL_RERANK;
      else process.env.CONTEXTENGINE_NEURAL_RERANK = prev.enable;
      if (prev.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prev.base;
    }
  });
});
