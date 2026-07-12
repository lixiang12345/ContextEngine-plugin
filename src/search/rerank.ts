import type { CodeChunk } from "../types.js";
import type { AnalyzedQuery } from "./query-analyzer.js";
import { tokenize } from "./bm25.js";

export interface RankedCandidate {
  id: string;
  chunk: CodeChunk;
  /** Channel scores before fusion */
  channels: {
    fts?: number;
    symbol?: number;
    path?: number;
    semantic?: number;
    graph?: number;
    neural?: number;
  };
  rrf: number;
  features: number;
  final: number;
}

/** Reciprocal Rank Fusion over ranked id lists. */
export function rrfFuse(
  lists: Array<Array<{ id: string; score: number }>>,
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

const IMPL_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|svelte)$/i;

const DOC_NOISE =
  /^(readme|changelog|contributing|license|roadmap|architecture|comparison|evaluation|agents)(\.|$)/i;

/**
 * Code-aware feature score — implementation-first ranking.
 * Higher is better.
 */
export function featureScore(chunk: CodeChunk, q: AnalyzedQuery): number {
  let score = 0;
  const pathLower = chunk.path.toLowerCase();
  const base = pathLower.split("/").pop() ?? pathLower;
  const symbolLower = (chunk.symbol ?? "").toLowerCase();
  const contentTok = new Set(tokenize(chunk.content.slice(0, 4000)));
  const pathTok = new Set(tokenize(chunk.path));
  const isImpl =
    IMPL_EXT.test(chunk.path) &&
    chunk.language !== "markdown" &&
    chunk.language !== "git-commit";

  // Exact / fuzzy identifier hits
  for (const id of q.identifiers) {
    const idL = id.toLowerCase();
    if (symbolLower === idL) score += 1.35;
    else if (symbolLower.includes(idL)) score += 0.75;
    if (base.includes(idL)) score += 0.55;
    if (chunk.content.includes(id)) score += isImpl ? 0.55 : 0.3;
    else if (chunk.content.toLowerCase().includes(idL)) {
      score += isImpl ? 0.3 : 0.15;
    }
  }

  // Path hints
  for (const hint of q.pathHints) {
    if (pathLower.includes(hint.toLowerCase())) score += 0.95;
  }

  // Token overlap (content + path)
  let overlap = 0;
  for (const t of q.tokens) {
    if (contentTok.has(t)) overlap += 1;
    if (pathTok.has(t)) overlap += 1.5;
  }
  score += Math.min(1.6, overlap * (isImpl ? 0.14 : 0.1));

  // --- Implementation-first penalties / boosts ---
  if (
    /(^|\/)(examples?|demo|samples?|fixtures?|benchmarks?|fuzzing|testdata|test-data)(\/|$)/i.test(
      chunk.path,
    )
  ) {
    score -= 1.45;
  }
  // Multi-lang test layouts: jvmTest, androidHostTest, *_test.go, *_test.rs, *Test.java
  if (
    /(^|\/)(test|tests|__tests__|spec|jvmTest|androidHostTest|androidTest|commonTest|hostTest|androidMain)(\/|$)/i.test(
      chunk.path,
    )
  ) {
    score -= 1.35;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(chunk.path)) score -= 1.2;
  if (/_test\.(c|cc|cpp|cxx|go|rs|java|kt|kts|py)$/i.test(chunk.path)) {
    score -= 1.25;
  }
  if (/(_test|Test|Tests)\.(java|kt|kts|go|rs|py|c|cc|cpp)$/i.test(chunk.path)) {
    score -= 1.25;
  }
  if (/\b(test|spec|mock|fixture|bench)\b/i.test(chunk.path)) score -= 0.4;
  // Prefer .c/.cc implementation over headers when scores are close
  if (/\.(h|hpp|hxx|hh)$/i.test(chunk.path) && q.intent !== "path") {
    score -= 0.55;
  }
  // Prefer primary source files over cluster/commands JSON in redis-like trees
  if (/\.json$/i.test(chunk.path) && q.intent !== "path") score -= 0.9;

  // Docs / marketing / eval writeups steal Top-1 on conceptual queries
  if (
    /(^|\/)(docs?|documentation|guide|guides|website|bench|benchmark|examples)(\/|$)/i.test(
      chunk.path,
    )
  ) {
    score -= 1.15;
  }
  // Root-level project markdown (README, ROADMAP, COMPARISON, …)
  if (
    chunk.language === "markdown" ||
    /\.mdx?$/i.test(chunk.path) ||
    DOC_NOISE.test(base)
  ) {
    // Keep a little signal for pure doc questions, crush for code tasks
    if (q.intent === "symbol" || q.intent === "path") score -= 1.35;
    else if (q.intent === "history") score -= 0.35;
    else score -= 1.05;
  }
  if (/\.d\.ts$/i.test(chunk.path) || /(^|\/)typings?(\/|$)/i.test(chunk.path)) {
    score -= 0.85;
  }

  // Primary source trees
  if (
    /(^|\/)(lib|src|source|app|pkg|internal|core|db|table|util|commonJvmAndroid|jvmMain|main)(\/|$)/i.test(
      chunk.path,
    )
  ) {
    score += 0.95;
  }
  // Implementation file extension boost
  if (isImpl) score += 0.8;
  // Prefer .c/.cc/.go/.java production sources over adjacent tests/headers
  if (/\.(c|cc|cpp|go|java|kt|rs|py|ts|js)$/i.test(chunk.path)) score += 0.25;

  // Basename match
  const baseNoExt = base.replace(/\.[^.]+$/, "");
  for (const t of q.tokens) {
    if (t.length >= 4 && baseNoExt === t) score += 0.5;
  }
  for (const id of q.identifiers) {
    if (baseNoExt.toLowerCase() === id.toLowerCase()) score += 0.7;
  }

  if (chunk.language === "git-commit") {
    score += q.prefersCommits ? 0.7 : -0.85;
  }

  // Dense symbol-bearing implementation chunks
  if (isImpl && chunk.symbol && chunk.content.length < 2800) score += 0.2;
  if (isImpl && chunk.content.length > 80 && chunk.content.length < 3500) {
    score += 0.1;
  }

  return score;
}

export function combineFinal(
  rrf: number,
  features: number,
  semanticNorm: number,
  intent: AnalyzedQuery["intent"],
  hasSemantic = true,
): number {
  // When dense vectors are available, trust them heavily for concept/mixed.
  // Features keep symbol/path sharp and crush docs. Lexical RRF is secondary.
  let wRrf = 0.22;
  let wFeat = 0.33;
  let wSem = 0.45;
  if (!hasSemantic || semanticNorm <= 0) {
    wRrf = 0.45;
    wFeat = 0.55;
    wSem = 0;
  } else if (intent === "symbol" || intent === "path") {
    wFeat = 0.48;
    wSem = 0.28;
    wRrf = 0.24;
  } else if (intent === "concept") {
    // Need both: semantic finds paraphrases, features crush tests/docs
    wSem = 0.4;
    wFeat = 0.4;
    wRrf = 0.2;
  } else if (intent === "history") {
    wFeat = 0.5;
    wRrf = 0.32;
    wSem = 0.18;
  } else if (intent === "mixed") {
    wSem = 0.38;
    wFeat = 0.4;
    wRrf = 0.22;
  }
  // Feature tanh keeps large positive impl boosts from dominating completely
  let score =
    wRrf * rrf + wFeat * Math.tanh(features / 2.2) + wSem * semanticNorm;
  // Extra lift when semantic and implementation features agree
  if (hasSemantic && semanticNorm >= 0.85 && features >= 0.8) {
    score += 0.06;
  }
  return score;
}

/**
 * Maximal Marginal Relevance — diversify packed results by path.
 * Prefer keeping implementation hits when scores are close.
 */
export function mmrSelect(
  ranked: RankedCandidate[],
  k: number,
  lambda = 0.78,
): RankedCandidate[] {
  if (ranked.length <= k) return ranked;
  const selected: RankedCandidate[] = [];
  const rest = [...ranked];

  while (selected.length < k && rest.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const cand = rest[i];
      const rel = cand.final;
      let maxSim = 0;
      for (const s of selected) {
        const sim = pathSimilarity(cand.chunk.path, s.chunk.path);
        if (sim > maxSim) maxSim = sim;
      }
      // Slight preference for implementation when diversifying
      const implBonus = IMPL_EXT.test(cand.chunk.path) ? 0.02 : 0;
      const mmr = lambda * rel - (1 - lambda) * maxSim + implBonus;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(rest.splice(bestIdx, 1)[0]);
  }
  return selected;
}

function pathSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const pa = a.split("/");
  const pb = b.split("/");
  let common = 0;
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] === pb[i]) common++;
    else break;
  }
  if (pa[pa.length - 1] === pb[pb.length - 1]) return 0.85;
  return common / Math.max(pa.length, pb.length);
}

/** Stable tie-break: prefer implementation paths when finals are close. */
export function preferImplementation(a: RankedCandidate, b: RankedCandidate): number {
  const da = a.final - b.final;
  if (Math.abs(da) > 0.02) return da > 0 ? -1 : 1;
  const ia = IMPL_EXT.test(a.chunk.path) ? 1 : 0;
  const ib = IMPL_EXT.test(b.chunk.path) ? 1 : 0;
  if (ia !== ib) return ib - ia;
  return a.chunk.path.localeCompare(b.chunk.path);
}
