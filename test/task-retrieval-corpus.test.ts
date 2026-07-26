import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(
    path.join(root, "benchmarks/task-retrieval/contextengine-v1.json"),
    "utf8",
  ),
) as {
  schemaVersion: number;
  topK: number;
  cases: Array<{
    id: string;
    facets: string;
    baseRef: string;
    prompt: string;
    goldPaths: string[];
  }>;
};

describe("task-retrieval corpus manifest", () => {
  it("declares a bounded, well-formed case set", () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.topK >= 5 && manifest.topK <= 50);
    assert.ok(manifest.cases.length >= 6);
    const ids = manifest.cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
  });

  it("pins full 40-hex base revisions with non-empty gold sets", () => {
    for (const entry of manifest.cases) {
      assert.match(entry.baseRef, /^[0-9a-f]{40}$/, entry.id);
      assert.ok(entry.goldPaths.length >= 1, entry.id);
      assert.ok(entry.prompt.split(/\s+/).length >= 12, `${entry.id}: prompt too short`);
      for (const gold of entry.goldPaths) {
        assert.match(gold, /^src\//, `${entry.id}: gold outside src/`);
      }
    }
  });

  it("never leaks a gold path into its prompt", () => {
    for (const entry of manifest.cases) {
      for (const gold of entry.goldPaths) {
        assert.ok(
          !entry.prompt.includes(gold),
          `${entry.id}: prompt contains gold path ${gold}`,
        );
        const basename = path.basename(gold);
        assert.ok(
          !entry.prompt.includes(basename),
          `${entry.id}: prompt contains gold basename ${basename}`,
        );
      }
    }
  });

  it("covers multi-facet cases, not only single-file prompts", () => {
    const multiFile = manifest.cases.filter((entry) => entry.goldPaths.length >= 3);
    assert.ok(
      multiFile.length >= 4,
      "corpus must keep enough cross-module cases to measure decomposition",
    );
  });
});
