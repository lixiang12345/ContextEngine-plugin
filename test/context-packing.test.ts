import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContextEngine } from "../src/engine";
import type { SearchHit, SearchOptions } from "../src/types";

class StubContextEngine extends ContextEngine {
  constructor(private readonly stubHits: SearchHit[]) {
    super({
      root: "/repo",
      dataDir: "/tmp/contextengine-vendor-test",
      maxFileBytes: 1_000_000,
      maxChunkChars: 20_000,
    });
  }

  override async search(_opts: SearchOptions): Promise<SearchHit[]> {
    return this.stubHits;
  }
}

function hit(id: string, path: string, content: string, score: number): SearchHit {
  return {
    chunk: {
      id,
      path,
      language: "typescript",
      startLine: 1,
      endLine: content.split("\n").length,
      content,
      hash: `hash-${id}`,
    },
    score,
    source: "hybrid",
    preview: content.slice(0, 120),
  };
}

describe("context packing", () => {
  const hits = [
    hit(
      "alpha",
      "src/alpha.ts",
      "export const alpha = 1;\n".repeat(20),
      0.98,
    ),
    hit(
      "beta",
      "src/beta.ts",
      "export const beta = 2;\n".repeat(20),
      0.91,
    ),
  ];

  test("returns every reranked hit when no caller cap is supplied", async () => {
    const engine = new StubContextEngine(hits);

    const result = await engine.getTaskContext({ task: "alpha beta", topK: 2 });

    assert.equal(result.hits.length, 2);
    assert.equal(result.truncated, false);
    assert.match(result.packedText, /src\/alpha\.ts/);
    assert.match(result.packedText, /src\/beta\.ts/);
  });

  test("honors an explicit caller-provided token cap", async () => {
    const engine = new StubContextEngine(hits);

    const result = await engine.getTaskContext({
      task: "alpha beta",
      topK: 2,
      maxTokens: 300,
    });

    assert.equal(result.hits.length, 1);
    assert.equal(result.truncated, true);
    assert.match(result.packedText, /src\/alpha\.ts/);
    assert.doesNotMatch(result.packedText, /src\/beta\.ts/);
  });
});
