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
  /** Optional overrides for tests or embedded deployments. */
  reliability?: Partial<PostgresHybridReliabilityOptions>;
}

export interface PostgresHybridReliabilityOptions {
  semanticTimeoutMs: number;
  rerankTimeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
}

type RetrievalHit = { id: string; score: number };

interface LexicalChannelHits {
  fts: RetrievalHit[];
  symbol: RetrievalHit[];
  path: RetrievalHit[];
}

// Each symbol/path term currently maps to an independent PostgreSQL query.
// Bound user-controlled fanout until those store calls are implemented as
// set-based SQL queries.
const MAX_IDENTIFIER_HINTS = 12;
const MAX_PATH_HINTS = 24;
const DEFAULT_MODEL_TIMEOUT_MS = 2_000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

function boundedNumber(
  value: number | string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function reliabilityOptions(
  overrides: Partial<PostgresHybridReliabilityOptions> | undefined,
): PostgresHybridReliabilityOptions {
  return {
    semanticTimeoutMs: boundedNumber(
      overrides?.semanticTimeoutMs ??
        process.env.CONTEXTENGINE_SEARCH_SEMANTIC_TIMEOUT_MS,
      DEFAULT_MODEL_TIMEOUT_MS,
      1,
      120_000,
    ),
    rerankTimeoutMs: boundedNumber(
      overrides?.rerankTimeoutMs ??
        process.env.CONTEXTENGINE_SEARCH_RERANK_TIMEOUT_MS,
      DEFAULT_MODEL_TIMEOUT_MS,
      1,
      120_000,
    ),
    failureThreshold: boundedNumber(
      overrides?.failureThreshold ??
        process.env.CONTEXTENGINE_SEARCH_BREAKER_FAILURE_THRESHOLD,
      DEFAULT_BREAKER_FAILURE_THRESHOLD,
      1,
      20,
    ),
    cooldownMs: boundedNumber(
      overrides?.cooldownMs ??
        process.env.CONTEXTENGINE_SEARCH_BREAKER_COOLDOWN_MS,
      DEFAULT_BREAKER_COOLDOWN_MS,
      1,
      10 * 60_000,
    ),
  };
}

class ModelCallTimeoutError extends Error {
  constructor(channel: "semantic" | "rerank", timeoutMs: number) {
    super(`${channel} model call exceeded ${timeoutMs}ms`);
    this.name = "ModelCallTimeoutError";
  }
}

async function withinModelBudget<T>(
  channel: "semantic" | "rerank",
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ModelCallTimeoutError(channel, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Small per-process breaker. Once the cooldown elapses, exactly one request is
 * admitted as a half-open probe so a recovering model is not stampede-tested.
 */
class FailureCircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  tryAcquire(now = Date.now()): boolean {
    if (this.openUntil === 0) return true;
    if (now < this.openUntil || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probeInFlight = false;
  }

  recordFailure(now = Date.now()): void {
    this.probeInFlight = false;
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }
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
  private reliability = reliabilityOptions(undefined);
  private semanticBreaker = new FailureCircuitBreaker(
    this.reliability.failureThreshold,
    this.reliability.cooldownMs,
  );
  private rerankBreaker = new FailureCircuitBreaker(
    this.reliability.failureThreshold,
    this.reliability.cooldownMs,
  );

  constructor(
    private readonly rerankScores: typeof neuralRerankScores = neuralRerankScores,
  ) {}

  load(input: PostgresHybridSearchInput): void {
    this.store = input.store;
    this.embedder = input.embedder ?? null;
    this.hasEmbeddings = input.hasEmbeddings;
    this.neuralRerank = input.neuralRerank ?? null;
    this.reliability = reliabilityOptions(input.reliability);
    this.semanticBreaker = new FailureCircuitBreaker(
      this.reliability.failureThreshold,
      this.reliability.cooldownMs,
    );
    this.rerankBreaker = new FailureCircuitBreaker(
      this.reliability.failureThreshold,
      this.reliability.cooldownMs,
    );
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    if (!this.store) throw new Error("PostgreSQL searcher is not loaded");
    const store = this.store;

    const topK = opts.topK ?? 8;
    const requested = opts.mode ?? "auto";
    const mode: "bm25" | "semantic" | "hybrid" =
      requested === "auto"
        ? this.hasEmbeddings && this.embedder
          ? "hybrid"
          : "bm25"
        : requested;
    const degradedChannels = new Set<string>();
    const analyzed = analyzeQuery(opts.query);
    const candidateLimit = Math.max(topK * 16, 128);
    const filter: StoreSearchFilter = {
      pathPrefix: opts.pathPrefix,
      sourceAccess: opts.sourceAccess,
      language: opts.language,
      includeCommits: opts.includeCommits,
    };

    const identifiers = analyzed.identifiers.slice(0, MAX_IDENTIFIER_HINTS);
    const pathHints = new Set<string>();
    const addPathHint = (hint: string): boolean => {
      if (pathHints.size >= MAX_PATH_HINTS) return false;
      const value = hint.trim();
      if (value) pathHints.add(value);
      return pathHints.size < MAX_PATH_HINTS;
    };
    for (const hint of analyzed.pathHints) {
      if (!addPathHint(hint)) break;
    }
    if (pathHints.size < MAX_PATH_HINTS) {
      for (const identifier of identifiers) {
        if (!addPathHint(identifier)) break;
        for (const part of tokenize(identifier)) {
          if (part.length >= 4 && !addPathHint(part)) break;
        }
        if (pathHints.size >= MAX_PATH_HINTS) break;
      }
    }

    const searchLexical = async (): Promise<LexicalChannelHits> => {
      const [fts, symbol, path] = await Promise.all([
        store.ftsSearch(opts.query, candidateLimit, filter),
        identifiers.length
          ? store.searchSymbols(identifiers, candidateLimit, filter)
          : Promise.resolve([]),
        pathHints.size
          ? store.searchByPathHints(
              [...pathHints],
              candidateLimit,
              filter,
            )
          : Promise.resolve([]),
      ]);
      return { fts, symbol, path };
    };

    const searchSemantic = async (): Promise<RetrievalHit[]> => {
      const embedder = this.embedder;
      if (!this.hasEmbeddings || !embedder) {
        if (mode === "semantic" || mode === "hybrid") {
          degradedChannels.add("semantic");
        }
        return [];
      }
      if (!this.semanticBreaker.tryAcquire()) {
        degradedChannels.add("semantic");
        return [];
      }

      let queryVector: number[] | undefined;
      try {
        const embedQuery =
          embedder.embedQuery?.bind(embedder) ?? embedder.embed.bind(embedder);
        [queryVector] = await withinModelBudget(
          "semantic",
          this.reliability.semanticTimeoutMs,
          (signal) =>
            embedQuery([opts.query], {
              signal,
              timeoutMs: this.reliability.semanticTimeoutMs,
              retries: 0,
            }),
        );
        if (!queryVector?.length) {
          throw new Error("Embedding API returned an empty query vector");
        }
        this.semanticBreaker.recordSuccess();
      } catch {
        this.semanticBreaker.recordFailure();
        degradedChannels.add("semantic");
        return [];
      }

      try {
        return await store.semanticSearch(
          queryVector,
          embedder.model,
          candidateLimit,
          filter,
        );
      } catch {
        // PostgreSQL/vector failures also degrade to lexical retrieval, but do
        // not poison the model circuit after a successful embedding call.
        degradedChannels.add("semantic");
        return [];
      }
    };

    let lexicalHits: LexicalChannelHits | null = null;
    let semanticHits: RetrievalHit[] = [];
    if (mode === "hybrid") {
      [lexicalHits, semanticHits] = await Promise.all([
        searchLexical(),
        searchSemantic(),
      ]);
    } else if (mode === "semantic") {
      semanticHits = await searchSemantic();
      if (!semanticHits.length) lexicalHits = await searchLexical();
    } else {
      lexicalHits = await searchLexical();
    }

    const lists: Array<Array<{ id: string; score: number }>> = [];
    const channelFts = new Map<string, number>();
    const channelSymbol = new Map<string, number>();
    const channelPath = new Map<string, number>();
    const channelSem = new Map<string, number>();

    if (lexicalHits) {
      for (const hit of lexicalHits.fts) channelFts.set(hit.id, hit.score);
      for (const hit of lexicalHits.symbol) channelSymbol.set(hit.id, hit.score);
      for (const hit of lexicalHits.path) channelPath.set(hit.id, hit.score);
      if (lexicalHits.fts.length) lists.push(lexicalHits.fts);
      if (lexicalHits.symbol.length) lists.push(lexicalHits.symbol);
      if (lexicalHits.path.length) lists.push(lexicalHits.path);
    }
    for (const hit of semanticHits) channelSem.set(hit.id, hit.score);
    if (semanticHits.length) lists.push(semanticHits);

    if (!lists.length) return [];
    const rrfMap = rrfFuse(lists);
    const chunks = await store.getChunksByIds([...rrfMap.keys()]);
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    let maxRrf = 0;
    for (const value of rrfMap.values()) maxRrf = Math.max(maxRrf, value);
    let maxSem = 0;
    for (const value of channelSem.values()) maxSem = Math.max(maxSem, value);

    const candidates: RankedCandidate[] = [];
    for (const [id, rrf] of rrfMap) {
      const chunk = chunksById.get(id);
      if (!chunk) continue;
      // Defense in depth for alternate/test stores that do not apply the SQL
      // filter. Commit chunks contain metadata for multiple source paths and
      // are hidden whenever a source policy is active.
      if (opts.sourceAccess && chunk.language === "git-commit") continue;
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
      const expanded = await store.expandGraph(
        candidates.slice(0, Math.max(topK * 2, 8)).map((candidate) => candidate.chunk),
        Math.max(topK * 2, 12),
        filter,
      );
      const known = new Set(candidates.map((candidate) => candidate.id));
      for (const chunk of expanded) {
        if (known.has(chunk.id)) continue;
        if (opts.sourceAccess && chunk.language === "git-commit") continue;
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
    await this.applyNeuralRerank(candidates, opts, degradedChannels);

    const fileCandidates = collapseByPath(candidates, analyzed);
    const lambda = channelSem.size > 0 ? 0.88 : 0.8;
    const selected =
      opts.diversify === false
        ? fileCandidates.slice(0, topK)
        : mmrSelect(fileCandidates, topK, lambda);
    const source: SearchHit["source"] =
      channelSem.size &&
      (channelFts.size || channelSymbol.size || channelPath.size)
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
      degradedChannels: degradedChannels.size
        ? [...degradedChannels]
        : undefined,
    }));
  }

  private async applyNeuralRerank(
    candidates: RankedCandidate[],
    opts: SearchOptions,
    degradedChannels: Set<string>,
  ): Promise<void> {
    const enabled =
      opts.neuralRerank === true
        ? this.neuralRerank !== null
        : opts.neuralRerank === false
          ? false
          : this.neuralRerank !== null;
    if (!enabled || !this.neuralRerank || candidates.length < 2) return;
    if (!this.rerankBreaker.tryAcquire()) {
      degradedChannels.add("rerank");
      return;
    }

    try {
      const config = this.neuralRerank;
      const slice = candidates.slice(0, Math.min(config.topN, candidates.length));
      const documents = slice.map((candidate) => ({
        id: candidate.id,
        text: formatRerankDocument({
          path: candidate.chunk.path,
          symbol: candidate.chunk.symbol,
          language: candidate.chunk.language,
          content: candidate.chunk.content,
          maxChars: config.maxDocChars,
        }),
      }));
      const scores = await withinModelBudget(
        "rerank",
        this.reliability.rerankTimeoutMs,
        (signal) =>
          this.rerankScores(config, opts.query, documents, {
            signal,
            timeoutMs: this.reliability.rerankTimeoutMs,
            retries: 0,
            requireScores: true,
          }),
      );
      this.rerankBreaker.recordSuccess();
      blendNeuralScores(slice, scores, config.weight);
      candidates.sort(preferImplementation);
    } catch {
      // Neural rerank is optional; retain the deterministic hybrid order.
      this.rerankBreaker.recordFailure();
      degradedChannels.add("rerank");
    }
  }
}
