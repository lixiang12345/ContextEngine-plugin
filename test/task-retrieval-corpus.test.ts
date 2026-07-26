import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface CorpusManifest {
  schemaVersion: number;
  topK: number;
  repositories?: Record<string, string>;
  cases: Array<{
    id: string;
    repo?: string;
    facets: string;
    baseRef: string;
    prompt: string;
    goldPaths: string[];
  }>;
}

const load = (name: string): CorpusManifest =>
  JSON.parse(
    readFileSync(path.join(root, "benchmarks/task-retrieval", name), "utf8"),
  ) as CorpusManifest;

const manifests: Array<[string, CorpusManifest]> = [
  ["contextengine-v1.json", load("contextengine-v1.json")],
  ["public-v1.json", load("public-v1.json")],
];

describe("task-retrieval corpus manifests", () => {
  it("declare bounded, well-formed case sets", () => {
    for (const [name, manifest] of manifests) {
      assert.equal(manifest.schemaVersion, 1, name);
      assert.ok(manifest.topK >= 5 && manifest.topK <= 50, name);
      assert.ok(manifest.cases.length >= 6, name);
      const ids = manifest.cases.map((entry) => entry.id);
      assert.equal(new Set(ids).size, ids.length, `${name}: case ids must be unique`);
    }
  });

  it("pin full 40-hex base revisions with contained, non-empty gold sets", () => {
    for (const [name, manifest] of manifests) {
      for (const entry of manifest.cases) {
        assert.match(entry.baseRef, /^[0-9a-f]{40}$/, `${name}/${entry.id}`);
        assert.ok(entry.goldPaths.length >= 1, `${name}/${entry.id}`);
        assert.ok(
          entry.prompt.split(/\s+/).length >= 12,
          `${name}/${entry.id}: prompt too short`,
        );
        for (const gold of entry.goldPaths) {
          assert.ok(
            !gold.startsWith("..") && !path.isAbsolute(gold),
            `${name}/${entry.id}: gold escapes the repository`,
          );
        }
      }
    }
  });

  it("resolve every external repo key against the repositories map", () => {
    for (const [name, manifest] of manifests) {
      for (const entry of manifest.cases) {
        if (!entry.repo) continue;
        const url = manifest.repositories?.[entry.repo];
        assert.ok(url, `${name}/${entry.id}: repo key ${entry.repo} unmapped`);
        assert.match(url, /^https:\/\//, `${name}/${entry.id}: non-https clone URL`);
      }
    }
  });

  it("never leak a gold path into its prompt", () => {
    for (const [name, manifest] of manifests) {
      for (const entry of manifest.cases) {
        for (const gold of entry.goldPaths) {
          assert.ok(
            !entry.prompt.includes(gold),
            `${name}/${entry.id}: prompt contains gold path ${gold}`,
          );
          const basename = path.basename(gold);
          assert.ok(
            !entry.prompt.includes(basename),
            `${name}/${entry.id}: prompt contains gold basename ${basename}`,
          );
        }
      }
    }
  });

  it("cover multi-facet cases, not only single-file prompts", () => {
    for (const [name, manifest] of manifests) {
      const multiFile = manifest.cases.filter((entry) => entry.goldPaths.length >= 2);
      assert.ok(
        multiFile.length >= 4,
        `${name}: corpus must keep enough cross-module cases to measure decomposition`,
      );
    }
  });
});
