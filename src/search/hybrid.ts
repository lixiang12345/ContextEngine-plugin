import type { CodeChunk, SearchHit, SearchOptions } from "../types.js";
import { Bm25Index, tokenize } from "./bm25.js";
import {
  cosineSimilarity,
  type EmbeddingVector,
  type EmbeddingProvider,
} from "../embeddings/provider.js";
import {
  buildSymbolGraph,
  expandViaGraph,
  type SymbolGraph,
} from "../graph/symbol-graph.js";
import { analyzeQuery, toFtsQuery } from "./query-analyzer.js";
import {
  collapseByPath,
  combineFinal,
  featureScore,
  mmrSelect,
  preferImplementation,
  rrfFuse,
  type RankedCandidate,
} from "./rerank.js";
import {
  blendNeuralScores,
  formatRerankDocument,
  neuralRerankScores,
  type NeuralRerankConfig,
} from "./neural-rerank.js";
import type { SqliteStore } from "../store/sqlite-store.js";

export interface HybridSearchInput {
  chunks: CodeChunk[];
  embeddings?: Array<{ chunkId: string; vector: EmbeddingVector }>;
  embedder?: EmbeddingProvider | null;
  /** When set, use FTS5 + symbol tables for scalable retrieval */
  store?: SqliteStore | null;
  /** Optional neural / cross-encoder rerank (Phase 5 alignment). */
  neuralRerank?: NeuralRerankConfig | null;
}

function previewOf(content: string, max = 220): string {
  const one = content.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

/**
 * Multi-signal hybrid searcher (v0.4):
 * FTS5 + symbol + path + optional two-stage semantic + feature rerank + graph + MMR.
 */
export class HybridSearcher {
  private chunksById = new Map<string, CodeChunk>();
  private bm25 = new Bm25Index();
  private embeddings = new Map<string, EmbeddingVector>();
  private embedder: EmbeddingProvider | null = null;
  private graph: SymbolGraph | null = null;
  private store: SqliteStore | null = null;
  private neuralRerank: NeuralRerankConfig | null = null;
  private useMemoryBm25 = true;

  load(input: HybridSearchInput): void {
    this.chunksById.clear();
    this.bm25.clear();
    this.embeddings.clear();
    this.embedder = input.embedder ?? null;
    this.store = input.store ?? null;
    this.neuralRerank = input.neuralRerank ?? null;

    const useFts = Boolean(this.store?.hasFts);
    this.useMemoryBm25 = !useFts;

    for (const c of input.chunks) {
      this.chunksById.set(c.id, c);
      if (this.useMemoryBm25) {
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
    }
    if (this.useMemoryBm25) this.bm25.build();
    this.graph = buildSymbolGraph(input.chunks);

    for (const e of input.embeddings ?? []) {
      this.embeddings.set(e.chunkId, e.vector);
    }
  }

  get hasSemantic(): boolean {
    return this.embeddings.size > 0 && this.embedder !== null;
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const topK = opts.topK ?? 8;
    // Production strategy: with embeddings use hybrid (FTS+symbol+semantic)
    // so exact identifiers and path cues still fire; without embeddings use bm25.
    // Soft doc/test penalties + query-instruct embeddings keep Top-1 on impl files.
    const requested = opts.mode ?? "auto";
    const mode: "bm25" | "semantic" | "hybrid" =
      requested === "auto"
        ? this.hasSemantic
          ? "hybrid"
          : "bm25"
        : requested === "bm25" ||
            requested === "semantic" ||
            requested === "hybrid"
          ? requested
          : "bm25";
    const analyzed = analyzeQuery(opts.query);
    // File-level reranking needs several chunks from the same file so it can
    // combine evidence spread across methods. Keep the lexical pool broader
    // than the final file count; otherwise large source files disappear before
    // collapseByPath gets a chance to aggregate their evidence.
    const candidateLimit = Math.max(topK * 16, 128);

    let poolIds: Set<string> | null = null;
    if (opts.pathPrefix || opts.language || opts.includeCommits === false) {
      poolIds = new Set(
        [...this.chunksById.values()]
          .filter((c) => {
            if (opts.includeCommits === false && c.language === "git-commit") {
              return false;
            }
            if (opts.language && c.language !== opts.language) return false;
            if (opts.pathPrefix) {
              const p = opts.pathPrefix.replace(/^\.\//, "");
              if (
                !(
                  c.path === p ||
                  c.path.startsWith(p.replace(/\/?$/, "/")) ||
                  c.path.startsWith(p)
                )
              ) {
                return false;
              }
            }
            return true;
          })
          .map((c) => c.id),
      );
    }

    const allow = (id: string) => !poolIds || poolIds.has(id);

    const lists: Array<Array<{ id: string; score: number }>> = [];
    const channelFts = new Map<string, number>();
    const channelSymbol = new Map<string, number>();
    const channelPath = new Map<string, number>();
    const channelSem = new Map<string, number>();

    const wantLexical = mode !== "semantic";
    const wantSemantic =
      (mode === "semantic" || mode === "hybrid") && this.hasSemantic;

    // --- Channel 1: FTS5 or memory BM25 ---
    if (wantLexical) {
      if (this.store?.hasFts) {
        const ftsQ = toFtsQuery(analyzed);
        const ftsHits = this.store
          .ftsSearch(ftsQ, candidateLimit)
          .filter((r) => allow(r.id));
        for (const h of ftsHits) channelFts.set(h.id, h.score);
        if (ftsHits.length) lists.push(ftsHits);
      } else {
        const bm = this.bm25
          .search(opts.query, candidateLimit)
          .filter((r) => allow(r.id));
        for (const h of bm) channelFts.set(h.id, h.score);
        if (bm.length) lists.push(bm);
      }
    }

    // --- Channel 2: exact / fuzzy symbols ---
    if (wantLexical && analyzed.identifiers.length) {
      let symHits: Array<{ id: string; score: number }> = [];
      if (this.store) {
        symHits = this.store
          .searchSymbols(analyzed.identifiers, candidateLimit)
          .filter((r) => allow(r.id));
      } else {
        // memory fallback
        const scores = new Map<string, number>();
        for (const c of this.chunksById.values()) {
          if (!allow(c.id)) continue;
          const sym = (c.symbol ?? "").toLowerCase();
          for (const id of analyzed.identifiers) {
            const idL = id.toLowerCase();
            if (sym === idL) scores.set(c.id, 3);
            else if (sym.includes(idL))
              scores.set(c.id, Math.max(scores.get(c.id) ?? 0, 1.5));
            else if (c.content.includes(id))
              scores.set(c.id, Math.max(scores.get(c.id) ?? 0, 0.8));
          }
        }
        symHits = [...scores.entries()]
          .map(([id, score]) => ({ id, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, candidateLimit);
      }
      for (const h of symHits) channelSymbol.set(h.id, h.score);
      if (symHits.length) lists.push(symHits);
    }

    // --- Channel 3: path hints ---
    const inferredPathHints = new Set(analyzed.pathHints);
    for (const identifier of analyzed.identifiers) {
      inferredPathHints.add(identifier);
      for (const part of tokenize(identifier)) {
        if (part.length >= 4) inferredPathHints.add(part);
      }
    }
    if (wantLexical && inferredPathHints.size) {
      let pathHits: Array<{ id: string; score: number }> = [];
      if (this.store) {
        pathHits = this.store
          .searchByPathHints([...inferredPathHints], candidateLimit)
          .filter((r) => allow(r.id));
      } else {
        const scores = new Map<string, number>();
        for (const c of this.chunksById.values()) {
          if (!allow(c.id)) continue;
          for (const hint of inferredPathHints) {
            if (c.path.toLowerCase().includes(hint.toLowerCase())) {
              scores.set(c.id, 2);
            }
          }
        }
        pathHits = [...scores.entries()].map(([id, score]) => ({ id, score }));
      }
      for (const h of pathHits) channelPath.set(h.id, h.score);
      if (pathHits.length) lists.push(pathHits);
    }

    // --- Channel 4: two-stage semantic (query-instruct embedding) ---
    if (wantSemantic && this.embedder) {
      try {
        const embedQuery =
          this.embedder.embedQuery?.bind(this.embedder) ??
          this.embedder.embed.bind(this.embedder);
        const [qVec] = await embedQuery([opts.query]);
        // Stage-1 candidates: union of lexical channels, or all if small corpus
        let candIds = new Set<string>();
        for (const list of lists) {
          for (const item of list.slice(0, Math.max(topK * 5, 30))) {
            candIds.add(item.id);
          }
        }
        const total = this.chunksById.size;
        if (candIds.size < 10 || total <= 400 || mode === "semantic") {
          // full scan for small indexes or pure semantic mode
          candIds = new Set(
            [...this.chunksById.keys()].filter((id) => allow(id)),
          );
        }

        const sem: Array<{ id: string; score: number }> = [];
        for (const id of candIds) {
          if (!allow(id)) continue;
          const vec = this.embeddings.get(id);
          if (!vec) continue;
          // Soft-penalize pure docs in the semantic channel itself
          const chunk = this.chunksById.get(id);
          let s = cosineSimilarity(qVec, vec);
          if (chunk) {
            if (
              chunk.language === "markdown" ||
              /\.mdx?$/i.test(chunk.path)
            ) {
              s *= 0.82;
            }
            if (
              /\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(chunk.path) &&
              chunk.language !== "markdown"
            ) {
              s *= 1.04;
            }
          }
          sem.push({ id, score: s });
        }
        sem.sort((a, b) => b.score - a.score);
        const topSem = sem.slice(0, candidateLimit);
        for (const h of topSem) channelSem.set(h.id, h.score);
        if (topSem.length) lists.push(topSem);
      } catch {
        // ignore semantic failures
      }
    }

    if (lists.length === 0) return [];

    const rrfMap = rrfFuse(lists);
    // Normalize RRF
    let maxRrf = 0;
    for (const v of rrfMap.values()) maxRrf = Math.max(maxRrf, v);
    let maxSem = 0;
    for (const v of channelSem.values()) maxSem = Math.max(maxSem, v);

    const candidates: RankedCandidate[] = [];
    for (const [id, rrf] of rrfMap) {
      if (!allow(id)) continue;
      const chunk = this.chunksById.get(id);
      if (!chunk) continue;
      if (
        opts.includeCommits === false &&
        chunk.language === "git-commit"
      ) {
        continue;
      }
      // Drop commit noise early unless history intent
      if (
        chunk.language === "git-commit" &&
        !analyzed.prefersCommits &&
        analyzed.intent !== "history"
      ) {
        continue;
      }
      const feat = featureScore(chunk, analyzed);
      const semN = maxSem > 0 ? (channelSem.get(id) ?? 0) / maxSem : 0;
      const rrfN = maxRrf > 0 ? rrf / maxRrf : 0;
      const hasSem = channelSem.size > 0;
      const final = combineFinal(
        rrfN,
        feat,
        semN,
        analyzed.intent,
        hasSem,
      );
      candidates.push({
        id,
        chunk,
        channels: {
          fts: channelFts.get(id),
          symbol: channelSymbol.get(id),
          path: channelPath.get(id),
          semantic: channelSem.get(id),
        },
        rrf: rrfN,
        features: feat,
        final,
      });
    }

    candidates.sort(preferImplementation);

    // Optional neural / cross-encoder rerank on top candidates (Augment-class second stage)
    const wantNeural =
      opts.neuralRerank === true
        ? this.neuralRerank !== null
        : opts.neuralRerank === false
          ? false
          : this.neuralRerank !== null;
    if (wantNeural && this.neuralRerank && candidates.length > 1) {
      try {
        const cfg = this.neuralRerank;
        const slice = candidates.slice(0, Math.min(cfg.topN, candidates.length));
        const docs = slice.map((c) => ({
          id: c.id,
          text: formatRerankDocument({
            path: c.chunk.path,
            symbol: c.chunk.symbol,
            language: c.chunk.language,
            content: c.chunk.content,
            maxChars: cfg.maxDocChars,
          }),
        }));
        const scores = await neuralRerankScores(cfg, opts.query, docs);
        blendNeuralScores(slice, scores, cfg.weight);
        // Re-sort full list: blended slice keeps new finals; rest unchanged
        candidates.sort(preferImplementation);
      } catch {
        // Neural rerank is best-effort; keep feature/hybrid ranking
      }
    }

    // Graph expansion on top seeds (implementation-only edges preferred)
    const expandN = Math.max(4, Math.floor(topK / 2));
    const seedIds = candidates.slice(0, topK).map((c) => c.id);
    if (opts.expandGraph !== false && this.graph && seedIds.length > 0) {
      const extra = expandViaGraph(
        this.graph,
        seedIds,
        this.chunksById,
        expandN,
      );
      for (const id of extra) {
        if (!allow(id) || candidates.some((c) => c.id === id)) continue;
        const chunk = this.chunksById.get(id);
        if (!chunk) continue;
        if (
          chunk.language === "git-commit" &&
          !analyzed.prefersCommits
        ) {
          continue;
        }
        if (chunk.language === "markdown") continue;
        const feat = featureScore(chunk, analyzed);
        const hasSem = channelSem.size > 0;
        candidates.push({
          id,
          chunk,
          channels: { graph: 1 },
          rrf: 0.2,
          features: feat,
          final:
            combineFinal(0.2, feat, 0, analyzed.intent, hasSem) * 0.9,
        });
      }
      candidates.sort(preferImplementation);
    }

    const diversify = opts.diversify !== false;
    const fileCandidates = collapseByPath(candidates, analyzed);
    // When semantic is strong, diversify less aggressively (keep best ranks)
    const lambda = channelSem.size > 0 ? 0.88 : 0.8;
    const pick = diversify
      ? mmrSelect(fileCandidates, topK, lambda)
      : fileCandidates.slice(0, topK);

    const source: SearchHit["source"] =
      channelSem.size && (channelFts.size || channelSymbol.size)
        ? "hybrid"
        : channelSem.size
          ? "semantic"
          : "bm25";

    return pick.slice(0, topK).map((c) => ({
      chunk: c.chunk,
      score: c.final,
      source,
      preview: previewOf(c.chunk.content),
      channels: c.channels,
      intent: analyzed.intent,
    }));
  }
}
