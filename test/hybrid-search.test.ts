import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HybridSearcher } from "../src/search/hybrid.js";
import type { SqliteStore } from "../src/store/sqlite-store.js";
import type { CodeChunk } from "../src/types.js";

function chunk(
  id: string,
  path: string,
  content: string,
  symbol?: string,
): CodeChunk {
  return {
    id,
    path,
    language: "kotlin",
    startLine: 1,
    endLine: 20,
    content,
    symbol,
    hash: id,
  };
}

describe("HybridSearcher", () => {
  it("keeps enough lexical candidates for cross-chunk file evidence", async () => {
    const distractors = Array.from({ length: 70 }, (_, index) =>
      chunk(
        `distractor-${index}`,
        `src/Distractor${index}.kt`,
        "consume backend event handler",
        `Distractor${index}`,
      ),
    );
    const clientChunks = [
      chunk(
        "remote-client-events",
        "src/RemoteAgentClient.kt",
        "consume backend SSE agent events from the response stream",
        "readEvents",
      ),
      chunk(
        "remote-client-tools",
        "src/RemoteAgentClient.kt",
        "submit tool results for continuation of the remote run",
        "submitToolResult",
      ),
    ];
    const chunks = [...distractors, ...clientChunks];
    const orderedHits = chunks.map((item, index) => ({
      id: item.id,
      score: chunks.length - index,
    }));
    const store = {
      hasFts: true,
      ftsSearch: (_query: string, limit: number) => orderedHits.slice(0, limit),
      searchSymbols: () => [],
      searchByPathHints: () => [],
    } as unknown as SqliteStore;

    const searcher = new HybridSearcher();
    searcher.load({ chunks, store });
    const hits = await searcher.search({
      query: "consume backend SSE agent events and submit tool results for continuation",
      mode: "bm25",
      topK: 8,
      diversify: false,
      expandGraph: false,
    });

    assert.ok(
      hits.some((hit) => hit.chunk.path === "src/RemoteAgentClient.kt"),
      "the target file should survive chunk retrieval and file-level aggregation",
    );
    assert.equal(new Set(hits.map((hit) => hit.chunk.path)).size, hits.length);
  });
});
