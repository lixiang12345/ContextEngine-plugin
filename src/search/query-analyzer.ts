import { tokenize } from "./bm25.js";

export type QueryIntent =
  | "symbol"
  | "path"
  | "concept"
  | "history"
  | "mixed";

export interface AnalyzedQuery {
  raw: string;
  intent: QueryIntent;
  /** CamelCase / snake_case / dotted identifiers extracted from the query */
  identifiers: string[];
  /** Lowercased tokens for lexical match */
  tokens: string[];
  /** Extra terms to OR into FTS (path hints, split idents) */
  expandedTerms: string[];
  /** Likely path fragments (foo/bar, src/x) */
  pathHints: string[];
  prefersCommits: boolean;
}

const IDENT_RE =
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][A-Z0-9_]{1,}\b|\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+\b/g;

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "where",
]);

const PATH_HINT_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|md)\b/g;

function splitIdent(ident: string): string[] {
  return tokenize(ident);
}

/**
 * Lightweight query understanding — structure-first routing for retrieval.
 */
export function analyzeQuery(raw: string): AnalyzedQuery {
  const identifiers = new Set<string>();
  const pathHints = new Set<string>();

  for (const m of raw.matchAll(PATH_HINT_RE)) {
    pathHints.add(m[0]);
  }
  for (const m of raw.matchAll(IDENT_RE)) {
    const id = m[0];
    // skip pure stop-ish short words later
    if (id.length >= 3) identifiers.add(id);
  }

  const tokens = tokenize(raw).filter((token) => !QUERY_STOP_WORDS.has(token));
  const expanded = new Set<string>(tokens);
  for (const id of identifiers) {
    for (const p of splitIdent(id)) expanded.add(p);
  }
  for (const p of pathHints) {
    for (const part of p.split(/[/.]/)) {
      if (part.length >= 2) expanded.add(part.toLowerCase());
    }
  }

  const prefersCommits =
    /\b(commit|history|why|when|blame|lineage|changelog|introduced|regression)\b/i.test(
      raw,
    );

  let intent: QueryIntent = "concept";
  const hasStrongIdent = [...identifiers].some(
    (id) => /[A-Z]/.test(id) || id.includes("_") || id.length >= 8,
  );
  if (prefersCommits) intent = "history";
  else if (pathHints.size > 0 && hasStrongIdent) intent = "mixed";
  else if (pathHints.size > 0) intent = "path";
  else if (hasStrongIdent && tokens.length <= 6) intent = "symbol";
  else if (hasStrongIdent) intent = "mixed";

  return {
    raw,
    intent,
    identifiers: [...identifiers],
    tokens,
    expandedTerms: [...expanded],
    pathHints: [...pathHints],
    prefersCommits,
  };
}

/** Build an FTS5 MATCH query string from analysis. */
export function toFtsQuery(analyzed: AnalyzedQuery): string {
  const terms = new Set<string>();
  for (const t of analyzed.expandedTerms) {
    if (t.length < 2) continue;
    // escape FTS special chars
    const clean = t.replace(/["*]/g, "").replace(/'/g, "''");
    if (clean) terms.add(clean);
  }
  for (const id of analyzed.identifiers) {
    const clean = id.replace(/["*]/g, "").replace(/'/g, "''");
    if (clean.length >= 2) terms.add(clean);
  }
  if (terms.size === 0) {
    const fallback = analyzed.raw
      .replace(/[^\w\s.-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    return fallback.map((t) => `"${t}"`).join(" OR ") || '""';
  }
  // Prefer AND of distinctive idents when symbol-like, else OR bag
  if (analyzed.intent === "symbol" && analyzed.identifiers.length > 0) {
    const id = analyzed.identifiers[0].replace(/["*']/g, "");
    const parts = splitIdent(id).filter((p) => p.length >= 2);
    if (parts.length >= 2) {
      return parts.map((p) => `"${p}"`).join(" AND ");
    }
    return `"${id}"`;
  }
  return [...terms]
    .slice(0, 16)
    .map((t) => `"${t}"`)
    .join(" OR ");
}
