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

  it("does not treat ordinary prose as symbol identifiers", () => {
    const q = analyzeQuery("pause an agent tool call for user approval and resume after the decision");
    assert.deepEqual(q.identifiers, []);
    assert.equal(q.intent, "concept");
    assert.equal(q.tokens.includes("and"), false);
    assert.equal(q.tokens.includes("the"), false);
  });

  it("keeps structured and acronym identifiers", () => {
    const q = analyzeQuery("start ContextEngine and consume SSE JSON events with analyzeQuery");
    assert.ok(q.identifiers.includes("ContextEngine"));
    assert.ok(q.identifiers.includes("SSE"));
    assert.ok(q.identifiers.includes("JSON"));
    assert.ok(q.identifiers.includes("analyzeQuery"));
  });

  it("keeps conventional single-letter-prefixed interface identifiers", () => {
    const q = analyzeQuery(
      "IFileService resolves reads writes watches and registers providers",
    );
    assert.deepEqual(q.identifiers, ["IFileService"]);
    assert.equal(q.intent, "mixed");
  });

  it("recognizes a single PascalCase class without treating question words as symbols", () => {
    const q = analyzeQuery("Where is Optional implemented and transformed?");
    assert.ok(q.identifiers.includes("Optional"));
    assert.equal(q.identifiers.includes("Where"), false);
    assert.equal(q.intent, "symbol");
  });

  it("recognizes short TitleCase project qualifiers", () => {
    const q = analyzeQuery("read Koa request headers and accepted types");
    assert.deepEqual(q.identifiers, ["Koa"]);
  });
});
