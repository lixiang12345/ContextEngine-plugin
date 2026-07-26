import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeQuery } from "../src/search/query-analyzer.js";
import {
  basenameQueryAffinity,
  inferPathHints,
  scorePathHint,
} from "../src/search/path-hints.js";

describe("path hints", () => {
  it("infers bounded path candidates from explicit paths and identifiers", () => {
    const hints = inferPathHints(
      analyzeQuery("find src/request.ts for RequestHeaders parsing"),
      4,
    );

    assert.equal(hints.length, 4);
    assert.ok(hints.includes("src/request.ts"));
    assert.ok(hints.includes("headers"));
  });

  it("scores direct basename words more strongly than identifier fragments", () => {
    const emitter = analyzeQuery(
      "emit transformed TypeScript nodes and source maps to JavaScript",
    );
    const futures = analyzeQuery(
      "combine asynchronous ListenableFuture operations",
    );

    assert.equal(basenameQueryAffinity("compiler/emitter.ts", emitter), 0.8);
    assert.equal(basenameQueryAffinity("compiler/types.ts", emitter), 0);
    assert.equal(basenameQueryAffinity("util/Futures.java", futures), 1.15);
    assert.equal(
      basenameQueryAffinity(
        "services/services.ts",
        analyzeQuery("create language service completions"),
      ),
      1.75,
    );
    assert.equal(
      basenameQueryAffinity(
        "compiler/moduleNameResolver.ts",
        analyzeQuery("resolve module names with node package exports"),
      ),
      1.6,
    );
    assert.equal(
      basenameQueryAffinity(
        "compiler/moduleSpecifiers.ts",
        analyzeQuery("resolve module names with node package exports"),
      ),
      0.92,
    );
  });

  it("keeps lower-camel method identifiers out of the path channel", () => {
    assert.deepEqual(
      inferPathHints(
        analyzeQuery("checkArgument checkState and checkNotNull failure messages"),
      ),
      [],
    );
    assert.deepEqual(inferPathHints(analyzeQuery("TypeScript diagnostics")), []);
  });

  it("scores exact, segmented, and morphological-prefix basenames", () => {
    assert.equal(scorePathHint("lib/request.js", "request"), 3.2);
    assert.equal(scorePathHint("lib/is-stream.js", "stream"), 2.9);
    assert.equal(scorePathHint("compiler/emitter.ts", "emit"), 2.7);
    assert.equal(scorePathHint("docs/request-guide.md", "request"), 2.9);
    assert.equal(scorePathHint("lib/response.js", "request"), 2);
  });
});
