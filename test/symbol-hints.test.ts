import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeQuery } from "../src/search/query-analyzer.js";
import { inferSymbolHints } from "../src/search/symbol-hints.js";

describe("symbol hints", () => {
  it("keeps explicit identifiers without natural-language fanout", () => {
    assert.deepEqual(
      inferSymbolHints(analyzeQuery("ImmutableList builder copyOf")),
      ["ImmutableList", "copyOf"],
    );
  });

  it("bounds concept-only symbol fallback to high-information terms", () => {
    assert.deepEqual(
      inferSymbolHints(
        analyzeQuery(
          "create the kube apiserver delegation chain and install APIs",
        ),
      ),
      [
        "serverchain",
        "serverdelegation",
        "kubeapiserver",
        "apiserverdelegation",
      ],
    );
  });

  it("does not append a broad natural term when compounds are available", () => {
    assert.deepEqual(
      inferSymbolHints(
        analyzeQuery(
          "configuration model merges workspace folder memory and override settings",
        ),
      ),
      ["configurationmodel", "modelmerges", "mergesworkspace"],
    );
  });
});
