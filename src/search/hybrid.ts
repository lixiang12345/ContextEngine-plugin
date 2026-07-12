import type { CodeChunk, SearchHit, SearchOptions } from "../types.js";
import { Bm25Index } from "./bm25.js";
import {
  cosineSimilarity,
  type EmbeddingProvider,
} from "../embeddings/provider.js";

export interface HybridSearchInput {
  chunks: CodeChunk[];
  embeddings?: Array<{ chunkId: string; vector: number[] }>;
  embedder?: EmbeddingProvider | null;
}

function previewOf(content: string, max = 220): string {
  const one = content.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

function rrfFuse(
  lists: Array<Array<{ id: string; score: number }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const add = 1 / (k + rank + 1);
      fused.set(item.id, (fused.get(item.id) ?? 0) + add);
    });
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export class HybridSearcher {
  private chunksById = new Map<string, CodeChunk>();
  private bm25 = new Bm25Index();
  private embeddings = new Map<string, number[]>();
  private embedder: EmbeddingProvider | null = null;

  load(input: HybridSearchInput): void {
    this.chunksById.clear();
    this.bm25.clear();
    this.embeddings.clear();
    this.embedder = input.embedder ?? null;

    for (const c of input.chunks) {
      this.chunksById.set(c.id, c);
      // Boost path + symbol by repeating them (helps filename / API intent queries).
      const blob = [
        c.path,
        c.path,
        c.symbol ?? "",
        c.symbol ?? "",
        c.language,
        c.content,
      ].join("\n");
      this.bm25.add(c.id, blob);
    }
    this.bm25.build();

    for (const e of input.embeddings ?? []) {
      this.embeddings.set(e.chunkId, e.vector);
    }
  }

  get hasSemantic(): boolean {
    return this.embeddings.size > 0 && this.embedder !== null;
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const topK = opts.topK ?? 8;
    const mode = opts.mode ?? "auto";

    let pool = [...this.chunksById.values()];
    if (opts.pathPrefix) {
      const p = opts.pathPrefix.replace(/^\.\//, "");
      pool = pool.filter(
        (c) => c.path === p || c.path.startsWith(p.replace(/\/?$/, "/")) || c.path.startsWith(p),
      );
    }
    if (opts.language) {
      pool = pool.filter((c) => c.language === opts.language);
    }
    const allowed = new Set(pool.map((c) => c.id));

    const wantSemantic =
      (mode === "semantic" || mode === "hybrid" || mode === "auto") &&
      this.hasSemantic;
    const wantBm25 = mode !== "semantic" || !wantSemantic;

    const lists: Array<Array<{ id: string; score: number }>> = [];
    let source: SearchHit["source"] = "bm25";

    if (wantBm25) {
      const bm = this.bm25
        .search(opts.query, Math.max(topK * 4, 20))
        .filter((r) => allowed.has(r.id));
      lists.push(bm);
      source = "bm25";
    }

    if (wantSemantic && this.embedder) {
      try {
        const [qVec] = await this.embedder.embed([opts.query]);
        const sem: Array<{ id: string; score: number }> = [];
        for (const [id, vec] of this.embeddings) {
          if (!allowed.has(id)) continue;
          sem.push({ id, score: cosineSimilarity(qVec, vec) });
        }
        sem.sort((a, b) => b.score - a.score);
        lists.push(sem.slice(0, Math.max(topK * 4, 20)));
        source = wantBm25 ? "hybrid" : "semantic";
      } catch {
        // fall back to BM25 only
        source = "bm25";
      }
    }

    if (lists.length === 0) return [];

    const fused =
      lists.length === 1 ? lists[0] : rrfFuse(lists);

    return fused.slice(0, topK).flatMap(({ id, score }) => {
      const chunk = this.chunksById.get(id);
      if (!chunk) return [];
      return [
        {
          chunk,
          score,
          source,
          preview: previewOf(chunk.content),
        },
      ];
    });
  }
}
