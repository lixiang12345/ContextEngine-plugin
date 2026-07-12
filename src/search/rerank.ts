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
  };
  rrf: number;
  features: number;
  final: number;
}

function norm(map: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of map.values()) max = Math.max(max, v);
  if (max <= 0) return map;
  const out = new Map<string, number>();
  for (const [k, v] of map) out.set(k, v / max);
  return out;
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

/**
 * Code-aware feature score. Compensates for generic embeddings.
 * Higher is better, roughly 0..1+ .
 */
export function featureScore(chunk: CodeChunk, q: AnalyzedQuery): number {
  let score = 0;
  const pathLower = chunk.path.toLowerCase();
  const base = pathLower.split("/").pop() ?? pathLower;
  const symbolLower = (chunk.symbol ?? "").toLowerCase();
  const contentTok = new Set(tokenize(chunk.content.slice(0, 4000)));
  const pathTok = new Set(tokenize(chunk.path));

  // Exact / fuzzy identifier hits
  for (const id of q.identifiers) {
    const idL = id.toLowerCase();
    if (symbolLower === idL) score += 1.2;
    else if (symbolLower.includes(idL)) score += 0.7;
    if (base.includes(idL)) score += 0.5;
    if (chunk.content.includes(id)) score += 0.45;
    else if (chunk.content.toLowerCase().includes(idL)) score += 0.25;
  }

  // Path hints
  for (const hint of q.pathHints) {
    if (pathLower.includes(hint.toLowerCase())) score += 0.9;
  }

  // Token overlap (content + path)
  let overlap = 0;
  for (const t of q.tokens) {
    if (contentTok.has(t)) overlap += 1;
    if (pathTok.has(t)) overlap += 1.5;
  }
  score += Math.min(1.5, overlap * 0.12);

  // Prefer implementation over examples/tests/docs (critical on mid-size repos
  // like Express/Commander/Koa where docs & examples flood lexical matches).
  if (/(^|\/)(examples?|demo|samples?|fixtures?)(\/|$)/i.test(chunk.path)) {
    score -= 1.1;
  }
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(chunk.path)) {
    score -= 0.7;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(chunk.path)) score -= 0.7;
  if (/\b(test|spec|mock|fixture)\b/i.test(chunk.path)) score -= 0.2;
  // API markdown / guides often mirror symbol names and steal Top-1 without embeddings
  if (/(^|\/)(docs?|documentation|guide|guides|website|bench|benchmark)(\/|$)/i.test(chunk.path)) {
    score -= 0.9;
  }
  if (/\.d\.ts$/i.test(chunk.path) || /(^|\/)typings?(\/|$)/i.test(chunk.path)) {
    score -= 0.75;
  }
  if (chunk.language === "markdown") {
    score -= q.intent === "symbol" ? 0.55 : 0.35;
  }
  // Boost primary source trees common in small/mid repos
  if (/(^|\/)(lib|src|source|app|pkg|internal)(\/|$)/i.test(chunk.path)) {
    score += 0.55;
  }
  // Basename exact-ish match for last path segment without extension
  const baseNoExt = base.replace(/\.[^.]+$/, "");
  for (const t of q.tokens) {
    if (t.length >= 4 && baseNoExt === t) score += 0.45;
  }
  for (const id of q.identifiers) {
    if (baseNoExt.toLowerCase() === id.toLowerCase()) score += 0.6;
  }
  if (chunk.language === "git-commit") {
    score += q.prefersCommits ? 0.6 : -0.4;
  }

  // Density: shorter focused chunks with symbol often better
  if (chunk.symbol && chunk.content.length < 2500) score += 0.1;

  return score;
}

export function combineFinal(
  rrf: number,
  features: number,
  semanticNorm: number,
  intent: AnalyzedQuery["intent"],
): number {
  // Intent-weighted blend
  let wRrf = 0.45;
  let wFeat = 0.4;
  let wSem = 0.15;
  if (intent === "symbol" || intent === "path") {
    wFeat = 0.55;
    wRrf = 0.35;
    wSem = 0.1;
  } else if (intent === "concept") {
    wSem = 0.35;
    wRrf = 0.35;
    wFeat = 0.3;
  } else if (intent === "history") {
    wFeat = 0.5;
    wRrf = 0.4;
    wSem = 0.1;
  }
  return wRrf * rrf + wFeat * Math.tanh(features / 2) + wSem * semanticNorm;
}

/**
 * Maximal Marginal Relevance — diversify packed results by path.
 */
export function mmrSelect(
  ranked: RankedCandidate[],
  k: number,
  lambda = 0.7,
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
      const mmr = lambda * rel - (1 - lambda) * maxSim;
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

export { norm };
