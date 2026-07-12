import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeQuery, toFtsQuery } from "../src/search/query-analyzer.js";

describe("query analyzer", () => {
  it("detects symbol intent for identifiers", () => {
    const q = analyzeQuery("analyzeQuery");
    assert.equal(q.intent, "symbol");
    assert.ok(q.identifiers.some((i) => i.includes("analyzeQuery") || i === "analyzeQuery"));
  });

  it("detects history intent", () => {
    const q = analyzeQuery("when was payment webhook introduced in git history");
    assert.equal(q.intent, "history");
    assert.equal(q.prefersCommits, true);
  });

  it("builds FTS query", () => {
    const q = analyzeQuery("hybrid search fusion");
    const fts = toFtsQuery(q);
    assert.ok(fts.includes("hybrid") || fts.includes("search"));
  });
});
