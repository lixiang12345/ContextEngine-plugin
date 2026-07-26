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

/**
 * Primary-preserving fusion. The primary ranking is kept whole and in order —
 * decomposition can therefore never displace or demote a result the proven
 * single-query path would have returned (a fixed-corpus A/B showed rank-based
 * fusion evicting gold files with subquery noise). Subqueries contribute only
 * discoveries: chunks absent from the primary list, appended after it by
 * their reciprocal-rank score, bounded to roughly a fifth of the requested
 * depth. Channel evidence from subqueries is unioned onto shared hits so the
 * trace still explains every contributor.
 */
export function fuseSubqueryHits(
  primary: SearchHit[],
  subqueries: TaskSubquery[],
  subqueryHits: SearchHit[][],
  limit: number,
): { hits: SearchHit[]; contributions: SubqueryContribution[] } {
  const keyOf = (hit: SearchHit) =>
    hit.chunk.id || `${hit.chunk.path}:${hit.chunk.startLine}`;
  const primaryKeys = new Set(primary.map(keyOf));
  const boosted = new Map<string, Set<number>>();
  const discoveries = new Map<
    string,
    { hit: SearchHit; score: number; fromSubquery: Set<number> }
  >();

  subqueryHits.forEach((hits, index) => {
    hits.forEach((hit, rank) => {
      const key = keyOf(hit);
      const increment = 1 / (RRF_K + rank + 1);
      if (primaryKeys.has(key)) {
        const sources = boosted.get(key) ?? new Set<number>();
        sources.add(index);
        boosted.set(key, sources);
        return;
      }
      const entry = discoveries.get(key);
      if (entry) {
        entry.score += increment;
        entry.fromSubquery.add(index);
        if (hit.channels) {
          entry.hit.channels = { ...hit.channels, ...entry.hit.channels };
        }
      } else {
        discoveries.set(key, {
          hit,
          score: increment,
          fromSubquery: new Set([index]),
        });
      }
    });
  });

  // Union subquery channel evidence onto the primary hits they also matched.
  const merged = primary.map((hit) => {
    const sources = boosted.get(keyOf(hit));
    if (!sources) return hit;
    let channels = hit.channels;
    for (const index of sources) {
      const match = subqueryHits[index]?.find((entry) => keyOf(entry) === keyOf(hit));
      if (match?.channels) channels = { ...match.channels, ...channels };
    }
    return channels === hit.channels ? hit : { ...hit, channels };
  });

  const appendBudget = Math.max(1, Math.ceil(limit / 5));
  const appended = [...discoveries.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, appendBudget);

  const contributions = subqueries.map((subquery, index) => ({
    query: subquery.query,
    reason: subquery.reason,
    hits: subqueryHits[index]?.length ?? 0,
    contributed: appended.filter((entry) => entry.fromSubquery.has(index)).length,
  }));
  // Scores are not comparable across queries, and downstream packing orders
  // file groups by their best hit score. Re-score discoveries strictly below
  // the primary floor so an appended chunk can extend the pack but can never
  // reorder the files the primary ranking chose.
  const primaryFloor = merged.length
    ? Math.min(...merged.map((entry) => entry.score))
    : 0;
  const rescored = appended.map((entry, index) => ({
    ...entry.hit,
    score: primaryFloor - (index + 1) * 1e-6,
  }));
  return { hits: [...merged, ...rescored], contributions };
}
