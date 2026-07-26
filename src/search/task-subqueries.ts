import type { SearchHit } from "../types.js";
import type { AnalyzedQuery } from "./query-analyzer.js";

/**
 * Deterministic task-query decomposition. A long, multi-facet task is split
 * into a few focused subqueries (symbol, path, clause, history facets) that
 * run as additional retrieval hops and fuse with the primary ranking. No
 * model is involved and nothing beyond the caller's own query text is used,
 * so the plan is reproducible and leaks no source content.
 */
export interface TaskSubquery {
  query: string;
  reason: "identifier" | "path" | "clause" | "history";
}

/** Hard caps demanded by the prototype gate: bounded count, bounded length,
 * and a bounded total character budget across the whole plan. */
export const MAX_SUBQUERIES = 4;
export const MAX_SUBQUERY_CHARS = 120;
export const MAX_PLAN_CHARS = 360;

const MIN_TASK_TOKENS = 8;
const MIN_TASK_CHARS = 60;
const MAX_IDENTIFIER_FACETS = 2;
const MAX_CLAUSE_FACETS = 2;
const MIN_CLAUSE_TOKENS = 3;

/**
 * Plan focused subqueries for a task-style query. Short or single-facet
 * queries return an empty plan, keeping the proven single-query path.
 */
export function planTaskSubqueries(analyzed: AnalyzedQuery): TaskSubquery[] {
  const raw = analyzed.raw.trim();
  if (analyzed.tokens.length < MIN_TASK_TOKENS && raw.length < MIN_TASK_CHARS) {
    return [];
  }
  if (analyzed.intent === "symbol" || analyzed.intent === "path") {
    // Already a focused query; a decomposition could only dilute it.
    return [];
  }

  const candidates: TaskSubquery[] = [];

  // Identifier facets: the most distinctive symbols retrieve on their own.
  const identifiers = [...analyzed.identifiers]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_IDENTIFIER_FACETS);
  for (const identifier of identifiers) {
    candidates.push({ query: identifier, reason: "identifier" });
  }

  // History facet: a "why/when/regression" task pairs its identifiers with
  // the commit channel explicitly. Planned right after identifiers because it
  // is the highest-signal facet for such tasks and must survive the cap.
  if (analyzed.prefersCommits && analyzed.identifiers.length) {
    candidates.push({
      query: `${analyzed.identifiers.slice(0, 2).join(" ")} history`,
      reason: "history",
    });
  }

  // Path facets: anchor a path fragment to the leading concept tokens so the
  // path channel gets a query it can win on.
  for (const pathHint of analyzed.pathHints.slice(0, 1)) {
    const concepts = analyzed.tokens
      .filter((token) => !pathHint.toLowerCase().includes(token))
      .slice(0, 3);
    candidates.push({
      query: [pathHint, ...concepts].join(" "),
      reason: "path",
    });
  }

  // Clause facets: sentences and conjunction clauses of a compound task each
  // describe one sub-problem worth its own retrieval pass.
  const clauses = splitClauses(raw);
  if (clauses.length >= 2) {
    for (const clause of clauses.slice(0, MAX_CLAUSE_FACETS)) {
      candidates.push({ query: clause, reason: "clause" });
    }
  }

  // Bound, normalize, and de-duplicate: a subquery must add tokens the kept
  // set does not already cover, and the whole plan stays within its budget.
  const kept: TaskSubquery[] = [];
  const keptTokenSets: Array<Set<string>> = [];
  let planChars = 0;
  for (const candidate of candidates) {
    if (kept.length >= MAX_SUBQUERIES) break;
    const query = candidate.query.trim().slice(0, MAX_SUBQUERY_CHARS).trim();
    if (query.length < 3) continue;
    if (planChars + query.length > MAX_PLAN_CHARS) continue;
    const tokens = new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
    if (tokens.size === 0) continue;
    // Drop a candidate only when it adds no tokens over an already-kept
    // facet; a broader query that subsumes a kept one still adds signal
    // (e.g. the history facet pairing kept identifiers with the commit
    // channel).
    const duplicate = keptTokenSets.some((existing) => isSubset(tokens, existing));
    if (duplicate) continue;
    kept.push({ ...candidate, query });
    keptTokenSets.push(tokens);
    planChars += query.length;
  }
  // A single subquery cannot beat the primary query it was derived from; only
  // a genuine multi-facet decomposition is worth the extra retrieval passes.
  return kept.length >= 2 ? kept : [];
}

function isSubset(candidate: Set<string>, other: Set<string>): boolean {
  if (candidate.size > other.size) return false;
  for (const token of candidate) if (!other.has(token)) return false;
  return true;
}

function splitClauses(raw: string): string[] {
  return raw
    .split(/(?<=[.;!?])\s+|\bso that\b|\bwhile keeping\b|\bwithout\b|,\s+(?:and|then)\s+|\band then\b/i)
    .map((clause) => clause.trim().replace(/^[,.;\s]+|[,.;\s]+$/g, ""))
    .filter(
      (clause) =>
        clause.split(/\s+/).filter((token) => token.length >= 2).length >=
        MIN_CLAUSE_TOKENS,
    );
}

export interface SubqueryContribution {
  query: string;
  reason: TaskSubquery["reason"];
  /** Candidates this subquery retrieved on its own. */
  hits: number;
  /** Fused candidates this subquery discovered or boosted. */
  contributed: number;
}

const RRF_K = 60;
const PRIMARY_WEIGHT = 1;
const SUBQUERY_WEIGHT = 0.45;

/**
 * Weighted reciprocal-rank fusion of the primary ranking with each subquery
 * ranking. The primary query dominates; subqueries can surface files the
 * broad query buried, but cannot displace a strong primary consensus.
 */
export function fuseSubqueryHits(
  primary: SearchHit[],
  subqueries: TaskSubquery[],
  subqueryHits: SearchHit[][],
  limit: number,
): { hits: SearchHit[]; contributions: SubqueryContribution[] } {
  const scores = new Map<string, { hit: SearchHit; score: number; fromSubquery: Set<number> }>();
  const fold = (hits: SearchHit[], weight: number, subqueryIndex: number | null) => {
    hits.forEach((hit, rank) => {
      const key = hit.chunk.id || `${hit.chunk.path}:${hit.chunk.startLine}`;
      const entry = scores.get(key);
      const increment = weight / (RRF_K + rank + 1);
      if (entry) {
        entry.score += increment;
        if (subqueryIndex !== null) {
          entry.fromSubquery.add(subqueryIndex);
          // Union channel evidence so the trace explains every contributor.
          if (hit.channels) {
            entry.hit.channels = { ...hit.channels, ...entry.hit.channels };
          }
        }
      } else {
        scores.set(key, {
          hit,
          score: increment,
          fromSubquery: subqueryIndex === null ? new Set() : new Set([subqueryIndex]),
        });
      }
    });
  };
  fold(primary, PRIMARY_WEIGHT, null);
  subqueryHits.forEach((hits, index) => fold(hits, SUBQUERY_WEIGHT, index));

  const fused = [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  const contributions = subqueries.map((subquery, index) => ({
    query: subquery.query,
    reason: subquery.reason,
    hits: subqueryHits[index]?.length ?? 0,
    contributed: fused.filter((entry) => entry.fromSubquery.has(index)).length,
  }));
  return { hits: fused.map((entry) => entry.hit), contributions };
}
