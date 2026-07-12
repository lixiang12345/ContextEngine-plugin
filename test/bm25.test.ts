import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bm25Index, tokenize } from "../src/search/bm25.js";

describe("tokenize", () => {
  it("splits camelCase and paths", () => {
    const tokens = tokenize("processPaymentRequest api/payments.ts");
    assert.ok(tokens.includes("process"));
    assert.ok(tokens.includes("payment"));
    assert.ok(tokens.includes("request"));
    assert.ok(tokens.includes("api"));
    assert.ok(tokens.includes("payments"));
  });
});

describe("Bm25Index", () => {
  it("ranks relevant docs higher", () => {
    const idx = new Bm25Index();
    idx.add("1", "user authentication login password");
    idx.add("2", "payment webhook stripe invoice billing");
    idx.add("3", "random unrelated content about css colors");
    idx.build();
    const hits = idx.search("stripe payment webhook", 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].id, "2");
  });
});
