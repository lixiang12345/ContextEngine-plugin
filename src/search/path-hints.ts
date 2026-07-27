import path from "node:path";
import { tokenize } from "./bm25.js";
import type { AnalyzedQuery } from "./query-analyzer.js";

const MIN_NATURAL_HINT_LENGTH = 4;
const LANGUAGE_QUALIFIERS = new Set([
  "csharp",
  "golang",
  "java",
  "javascript",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "swift",
  "typescript",
]);

export function isLanguageQualifier(value: string): boolean {
  return LANGUAGE_QUALIFIERS.has(value.trim().toLowerCase());
}

/**
 * Build a bounded path-retrieval vocabulary. Explicit paths and structured
 * identifiers are split into useful basename fragments without letting every
 * prose token create another database path scan.
 */
export function inferPathHints(
  query: AnalyzedQuery,
  maxHints = 24,
): string[] {
  const hints = new Set<string>();
  const add = (value: string): boolean => {
    if (hints.size >= maxHints) return false;
    const normalized = value.trim().toLowerCase();
    if (normalized.length >= 2) hints.add(normalized);
    return hints.size < maxHints;
  };

  for (const hint of query.pathHints) {
    if (!add(hint)) return [...hints];
  }
  for (const identifier of query.identifiers) {
    const normalized = identifier.toLowerCase();
    if (
      isLanguageQualifier(normalized) ||
      !/^[A-Z]/.test(identifier)
    ) {
      continue;
    }
    if (!add(identifier)) return [...hints];
    for (const part of tokenize(identifier)) {
      if (part.length >= MIN_NATURAL_HINT_LENGTH && !add(part)) {
        return [...hints];
      }
    }
  }
  for (const identifier of query.identifiers) {
    if (
      !/^[A-Z]/.test(identifier) ||
      isLanguageQualifier(identifier)
    ) {
      continue;
    }
    for (const part of tokenize(identifier)) {
      const index = query.tokens.indexOf(part);
      if (part.length < MIN_NATURAL_HINT_LENGTH) {
        const next = index >= 0 ? query.tokens[index + 1] : undefined;
        if (
          next &&
          next.length >= MIN_NATURAL_HINT_LENGTH &&
          !add(next)
        ) {
          return [...hints];
        }
        continue;
      }
      const previous = index > 0 ? query.tokens[index - 1] : undefined;
      if (
        previous &&
        previous.length >= 3 &&
        !isLanguageQualifier(previous) &&
        !add(`${previous}/${part}`)
      ) {
        return [...hints];
      }
    }
  }
  return [...hints];
}

/**
 * Return file-level affinity for basename words stated directly by the user.
 * This is applied once after chunk collapse, so a large file is not rewarded
 * once per matching chunk. Identifier fragments receive a smaller fallback
 * affinity for cases such as ListenableFuture -> Futures.java.
 */
export function basenameQueryAffinity(
  filePath: string,
  query: AnalyzedQuery,
): number {
  const rawBase = path.basename(filePath);
  const rawStem = rawBase.replace(/\.[^.]+$/, "");
  const stem = rawStem.toLowerCase();
  const parts = new Set(tokenize(rawStem));
  const parent = path.basename(path.dirname(filePath)).toLowerCase();
  const directWords = new Set(
    (query.raw.match(/[A-Za-z0-9_-]+/g) ?? [])
      .map((word) => word.toLowerCase())
      .filter(
        (word) =>
          word.length >= MIN_NATURAL_HINT_LENGTH &&
          !isLanguageQualifier(word),
      ),
  );
  let affinity = 0;
  for (const word of directWords) {
    if (stem === word) affinity = Math.max(affinity, 1);
    else if (stem === `${word}s` || stem === `${word}es`) {
      affinity = Math.max(affinity, 0.8);
    }
    else if (parts.has(word)) affinity = Math.max(affinity, 0.92);
    else if (stem.startsWith(word)) affinity = Math.max(affinity, 0.8);
  }
  const matchedParts = [...parts].filter((part) =>
    [...directWords].some(
      (word) =>
        part === word ||
        (part.length >= MIN_NATURAL_HINT_LENGTH &&
          word.length >= MIN_NATURAL_HINT_LENGTH &&
          (part.startsWith(word) || word.startsWith(part))),
    ),
  ).length;
  if (matchedParts >= 2) {
    affinity = Math.max(
      affinity,
      Math.min(1.75, 1 + (matchedParts - 1) * 0.3),
    );
  }
  if (
    parent === stem &&
    [...directWords].some(
      (word) => stem === `${word}s` || stem === `${word}es`,
    )
  ) {
    affinity = Math.max(affinity, 1.75);
  }
  for (const identifier of query.identifiers) {
    if (isLanguageQualifier(identifier)) continue;
    const normalizedIdentifier = identifier.toLowerCase();
    const strongIdentifier =
      /[a-z0-9][A-Z]/.test(identifier) ||
      (/^[A-Z][a-z0-9]+$/.test(identifier) && identifier.length >= 7);
    if (strongIdentifier && stem === normalizedIdentifier) {
      affinity = Math.max(affinity, 1.75);
    }
    const identifierParts = tokenize(identifier);
    for (const part of identifierParts) {
      if (part.length < MIN_NATURAL_HINT_LENGTH) continue;
      if (stem === part) affinity = Math.max(affinity, 0.85);
      else if (stem === `${part}s` || stem === `${part}es`) {
        // A standalone plural utility basename (Future -> Futures.java) is a
        // more specific destination than a larger compound that merely
        // contains the same identifier part. Keep it below an exact word
        // match while giving it enough separation from compound prefixes.
        affinity = Math.max(
          affinity,
          identifierParts.length > 1 ? 0.95 : 0.78,
        );
      }
      else if (parts.has(part)) affinity = Math.max(affinity, 0.78);
      else if (stem.startsWith(part)) affinity = Math.max(affinity, 0.6);
    }
  }
  return affinity;
}

/** Score how specifically a path basename matches one inferred hint. */
export function scorePathHint(filePath: string, hint: string): number {
  const normalized = hint.trim().toLowerCase();
  const normalizedPath = filePath.replaceAll("\\", "/").toLowerCase();
  const normalizedPathStem = normalizedPath.replace(/\.[^./]+$/, "");
  const rawBase = path.basename(filePath);
  const rawStem = rawBase.replace(/\.[^.]+$/, "");
  const base = rawBase.toLowerCase();
  const stem = rawStem.toLowerCase();
  if (
    normalized.includes("/") &&
    `/${normalizedPathStem}/`.includes(`/${normalized}/`)
  ) {
    return 4;
  }
  if (stem === normalized) return 3.2;
  if (stem === `${normalized}s` || stem === `${normalized}es`) return 3.1;
  if (base.startsWith(`${normalized}.`)) return 3;
  if (tokenize(rawStem).includes(normalized)) return 2.9;
  if (
    normalized.length >= MIN_NATURAL_HINT_LENGTH &&
    stem.startsWith(normalized)
  ) {
    return 2.7;
  }
  return 2;
}
