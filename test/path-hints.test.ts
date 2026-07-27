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
    assert.equal(basenameQueryAffinity("util/Futures.java", futures), 0.95);
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
    assert.equal(
      basenameQueryAffinity(
        "compiler/typescript.ts",
        analyzeQuery("TypeScript diagnostics"),
      ),
      0,
    );
  });

  it("keeps exact basenames ahead of plural variants", () => {
    const query = analyzeQuery("Future implementation details");
    assert.equal(basenameQueryAffinity("util/Future.java", query), 1);
    assert.equal(basenameQueryAffinity("util/Futures.java", query), 0.8);
  });

  it("treats a strong identifier's exact basename as decisive", () => {
    const query = analyzeQuery(
      "SuggestController triggers code completion and manages the widget",
    );
    assert.equal(
      basenameQueryAffinity("suggest/suggestController.ts", query),
      1.75,
    );
    assert.ok(
      basenameQueryAffinity("suggest/suggestController.ts", query) >
        basenameQueryAffinity("suggest/suggestWidgetAdapter.ts", query),
    );
  });

  it("adds and scores adjacent directory/basename evidence", () => {
    const hints = inferPathHints(
      analyzeQuery(
        "generic API server Config completes secure serving authentication",
      ),
    );

    assert.ok(hints.includes("server/config"));
    assert.equal(
      scorePathHint("staging/src/pkg/server/config.go", "server/config"),
      4,
    );
  });

  it("uses the component noun after a short project qualifier", () => {
    const hints = inferPathHints(
      analyzeQuery("read Koa request headers and accepted types"),
    );
    assert.ok(hints.includes("request"));
  });

  it("scores exact, segmented, and morphological-prefix basenames", () => {
    assert.equal(scorePathHint("lib/request.js", "request"), 3.2);
    assert.equal(scorePathHint("util/Futures.java", "future"), 3.1);
    assert.equal(scorePathHint("lib/is-stream.js", "stream"), 2.9);
    assert.equal(scorePathHint("compiler/emitter.ts", "emit"), 2.7);
    assert.equal(scorePathHint("docs/request-guide.md", "request"), 2.9);
    assert.equal(scorePathHint("lib/response.js", "request"), 2);
  });
});
