import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEmbeddingReady,
  isRerankReady,
} from "../src/util/model-health.js";

describe("model health schemas", () => {
  it("accepts the bundled server health response", () => {
    const health = {
      ok: true,
      embed_loaded: true,
      rerank_loaded: true,
    };
    assert.equal(isEmbeddingReady(health), true);
    assert.equal(isRerankReady(health), true);
  });

  it("accepts the deployed v2 health response", () => {
    const health = {
      status: "ok",
      device: "cuda",
      embedding_model: "Qwen/Qwen3-Embedding-0.6B",
      reranker_model: "Qwen/Qwen3-Reranker-0.6B",
    };
    assert.equal(isEmbeddingReady(health), true);
    assert.equal(isRerankReady(health), true);
  });

  it("rejects partial or unhealthy responses", () => {
    assert.equal(isEmbeddingReady({ status: "ok" }), false);
    assert.equal(isRerankReady({ ok: true, rerank_loaded: false }), false);
  });
});
