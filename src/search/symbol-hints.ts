import type { AnalyzedQuery } from "./query-analyzer.js";

const NATURAL_SYMBOL_STOP_WORDS = new Set([
  "build",
  "create",
  "find",
  "handle",
  "handles",
  "implement",
  "implementation",
  "install",
  "manage",
  "manages",
  "return",
  "returns",
  "show",
  "using",
  "value",
  "values",
]);

const SYMBOL_COMPOUND_SUFFIXES = [
  "controller",
  "provider",
  "scheduler",
  "handler",
  "manager",
  "resolver",
  "runtime",
  "server",
  "service",
  "client",
  "cache",
  "store",
];

/**
 * Preserve explicit identifiers. For concept-only queries, add at most three
 * high-information natural terms so symbols such as CreateServerChain remain
 * reachable without opening unbounded fuzzy-search fanout.
 */
export function inferSymbolHints(
  query: AnalyzedQuery,
  maxIdentifiers = 12,
  maxNaturalTerms = 4,
): string[] {
  const identifiers = [...new Set(query.identifiers)].slice(0, maxIdentifiers);
  if (identifiers.length) return identifiers;
  const terms = query.tokens.filter(
    (token) =>
      token.length >= 4 && !NATURAL_SYMBOL_STOP_WORDS.has(token),
  );
  const compounds = terms
    .slice(0, -1)
    .map((term, index) => term + terms[index + 1])
    .filter((term) => term.length <= 64)
    .slice(0, 3);
  const suffixCompounds: string[] = [];
  for (const [index, term] of terms.entries()) {
    const suffix = SYMBOL_COMPOUND_SUFFIXES.find(
      (candidate) => term !== candidate && term.endsWith(candidate),
    );
    if (!suffix) continue;
    for (const later of terms.slice(index + 1, index + 4)) {
      suffixCompounds.push(suffix + later);
    }
  }
  suffixCompounds.sort((left, right) => left.length - right.length);
  const structured = [...new Set([...suffixCompounds, ...compounds])];
  return (structured.length ? structured : [...new Set(terms)]).slice(
    0,
    maxNaturalTerms,
  );
}
