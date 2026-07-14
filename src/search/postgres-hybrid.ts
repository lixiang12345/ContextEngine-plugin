import type { SearchHit, SearchOptions } from "../types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type {
  PostgresStore,
  StoreSearchFilter,
} from "../store/postgres-store.js";
import { tokenize } from "./bm25.js";
import { analyzeQuery } from "./query-analyzer.js";
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

export interface PostgresHybridSearchInput {
  store: PostgresStore;
  embedder?: EmbeddingProvider | null;
  hasEmbeddings: boolean;
  neuralRerank?: NeuralRerankConfig | null;
}

function previewOf(content: string, max = 220): string {
  const one = content.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

/**
 * Database-first hybrid retrieval. PostgreSQL returns ranked candidate IDs and
 * chunks only after filtering, so large repositories are never fully loaded.
 */
export class PostgresHybridSearcher {
  private store: PostgresStore | null = null;
  private embedder: EmbeddingProvider | null = null;
  private hasEmbeddings = false;
  private neuralRerank: NeuralRerankConfig | null = null;

  load(input: PostgresHybridSearchInput): void {
    this.store = input.store;
    this.embedder = input.embedder ?? null;
    this.hasEmbeddings = input.hasEmbeddings;
    this.neuralRerank = input.neuralRerank ?? null;
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    if (!this.store) throw new Error("PostgreSQL searcher is not loaded");

    const topK = opts.topK ?? 8;
    const requested = opts.mode ?? "auto";
    const mode: "bm25" | "semantic" | "hybrid" =
      requested === "auto"
        ? this.hasEmbeddings && this.embedder
          ? "hybrid"
          : "bm25"
        : requested;
    const analyzed = analyzeQuery(opts.query);
    const candidateLimit = Math.max(topK * 16, 128);
    const filter: StoreSearchFilter = {
      pathPrefix: opts.pathPrefix,
      language: opts.language,
      includeCommits: opts.includeCommits,
    };

    const lists: Array<Array<{ id: string; score: number }>> = [];
    const channelFts = new Map<string, number>();
    const channelSymbol = new Map<string, number>();
    const channelPath = new Map<string, number>();
    const channelSem = new Map<string, number>();
    const wantLexical = mode !== "semantic";
    const wantSemantic =
      (mode === "semantic" || mode === "hybrid") &&
      this.hasEmbeddings &&
      this.embedder !== null;

    if (wantLexical) {
      const ftsHits = await this.store.ftsSearch(opts.query, candidateLimit, filter);
      for (const hit of ftsHits) channelFts.set(hit.id, hit.score);
      if (ftsHits.length) lists.push(ftsHits);
    }

    if (wantLexical && analyzed.identifiers.length) {
      const symbolHits = await this.store.searchSymbols(
        analyzed.identifiers,
        candidateLimit,
        filter,
      );
      for (const hit of symbolHits) channelSymbol.set(hit.id, hit.score);
      if (symbolHits.length) lists.push(symbolHits);
    }

    const pathHints = new Set(analyzed.pathHints);
    for (const identifier of analyzed.identifiers) {
      pathHints.add(identifier);
      for (const part of tokenize(identifier)) {
        if (part.length >= 4) pathHints.add(part);
      }
    }
    if (wantLexical && pathHints.size) {
      const pathHits = await this.store.searchByPathHints(
        [...pathHints],
        candidateLimit,
        filter,
      );
      for (const hit of pathHits) channelPath.set(hit.id, hit.score);
      if (pathHits.length) lists.push(pathHits);
    }

    if (wantSemantic && this.embedder) {
      try {
        const embedQuery =
          this.embedder.embedQuery?.bind(this.embedder) ??
          this.embedder.embed.bind(this.embedder);
        const [queryVector] = await embedQuery([opts.query]);
        const semanticHits = await this.store.semanticSearch(
          queryVector,
          this.embedder.model,
          candidateLimit,
          filter,
        );
        for (const hit of semanticHits) channelSem.set(hit.id, hit.score);
        if (semanticHits.length) lists.push(semanticHits);
      } catch {
        // Keep lexical retrieval available when the remote embedding API fails.
      }
    }

    if (!lists.length) return [];
    const rrfMap = rrfFuse(lists);
    const chunks = await this.store.getChunksByIds([...rrfMap.keys()]);
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    let maxRrf = 0;
    for (const value of rrfMap.values()) maxRrf = Math.max(maxRrf, value);
    let maxSem = 0;
    for (const value of channelSem.values()) maxSem = Math.max(maxSem, value);

    const candidates: RankedCandidate[] = [];
    for (const [id, rrf] of rrfMap) {
      const chunk = chunksById.get(id);
      if (!chunk) continue;
      if (
        chunk.language === "git-commit" &&
        (!analyzed.prefersCommits || opts.includeCommits === false)
      ) {
        continue;
      }
      const features = featureScore(chunk, analyzed);
      const semantic = maxSem > 0 ? (channelSem.get(id) ?? 0) / maxSem : 0;
      const rrfScore = maxRrf > 0 ? rrf / maxRrf : 0;
      candidates.push({
        id,
        chunk,
        channels: {
          fts: channelFts.get(id),
          symbol: channelSymbol.get(id),
          path: channelPath.get(id),
          semantic: channelSem.get(id),
        },
        rrf: rrfScore,
        features,
        final: combineFinal(
          rrfScore,
          features,
          semantic,
          analyzed.intent,
          channelSem.size > 0,
        ),
      });
    }

    candidates.sort(preferImplementation);
    if (opts.expandGraph !== false && candidates.length) {
      const expanded = await this.store.expandGraph(
        candidates.slice(0, Math.max(topK * 2, 8)).map((candidate) => candidate.chunk),
        Math.max(topK * 2, 12),
        filter,
      );
      const known = new Set(candidates.map((candidate) => candidate.id));
      for (const chunk of expanded) {
        if (known.has(chunk.id)) continue;
        known.add(chunk.id);
        const features = featureScore(chunk, analyzed);
        candidates.push({
          id: chunk.id,
          chunk,
          channels: { graph: 0.5 },
          rrf: 0.12,
          features,
          final: combineFinal(0.12, features, 0, analyzed.intent, false),
        });
      }
    }
    candidates.sort(preferImplementation);
    await this.applyNeuralRerank(candidates, opts);

    const fileCandidates = collapseByPath(candidates, analyzed);
    const lambda = channelSem.size > 0 ? 0.88 : 0.8;
    const selected =
      opts.diversify === false
        ? fileCandidates.slice(0, topK)
        : mmrSelect(fileCandidates, topK, lambda);
    const source: SearchHit["source"] =
      channelSem.size && (channelFts.size || channelSymbol.size)
        ? "hybrid"
        : channelSem.size
          ? "semantic"
          : "bm25";

    return selected.slice(0, topK).map((candidate) => ({
      chunk: candidate.chunk,
      score: candidate.final,
      source,
      preview: previewOf(candidate.chunk.content),
      channels: candidate.channels,
      intent: analyzed.intent,
    }));
  }

  private async applyNeuralRerank(
    candidates: RankedCandidate[],
    opts: SearchOptions,
  ): Promise<void> {
    const enabled =
      opts.neuralRerank === true
        ? this.neuralRerank !== null
        : opts.neuralRerank === false
          ? false
          : this.neuralRerank !== null;
    if (!enabled || !this.neuralRerank || candidates.length < 2) return;

    try {
      const config = this.neuralRerank;
      const slice = candidates.slice(0, Math.min(config.topN, candidates.length));
      const scores = await neuralRerankScores(
        config,
        opts.query,
        slice.map((candidate) => ({
          id: candidate.id,
          text: formatRerankDocument({
            path: candidate.chunk.path,
            symbol: candidate.chunk.symbol,
            language: candidate.chunk.language,
            content: candidate.chunk.content,
            maxChars: config.maxDocChars,
          }),
        })),
      );
      blendNeuralScores(slice, scores, config.weight);
      candidates.sort(preferImplementation);
    } catch {
      // Neural rerank is optional; retain the deterministic hybrid order.
    }
  }
}
