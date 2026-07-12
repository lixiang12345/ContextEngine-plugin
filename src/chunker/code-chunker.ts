import type { CodeChunk } from "../types.js";
import { shortId, sha256 } from "../util/hash.js";
import { languageForPath } from "../util/fs.js";

/** Language-aware splitting patterns: start of a likely top-level unit. */
const SPLIT_PATTERNS: Record<string, RegExp> = {
  typescript:
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+/,
  tsx: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+/,
  javascript:
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+/,
  python: /^(?:async\s+)?(?:def|class)\s+|^@\w+/,
  go: /^(?:func|type|const|var)\s+/,
  rust: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|const|type)\s+/,
  java:
    /^(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|record)\s+\w+/,
  kotlin:
    /^(?:public|private|protected|internal|\s)*(?:fun|class|interface|object|data class|sealed class)\s+/,
  ruby: /^(?:module|class|def)\s+/,
  csharp:
    /^(?:public|private|protected|internal|static|sealed|abstract|\s)*(?:class|interface|struct|enum|record)\s+\w+/,
  markdown: /^#{1,3}\s+/,
};

/** Languages where brace matching improves unit boundaries. */
const BRACE_LANGS = new Set([
  "typescript",
  "tsx",
  "javascript",
  "go",
  "rust",
  "java",
  "kotlin",
  "csharp",
  "c",
  "cpp",
]);

const SYMBOL_EXTRACTORS: Array<{ re: RegExp; group: number }> = [
  {
    re: /(?:function\*?|class|interface|type|enum|def|fn|struct|trait|mod|fun)\s+([A-Za-z_][\w]*)/,
    group: 1,
  },
  { re: /(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/, group: 1 },
  { re: /^#+\s+(.+)$/m, group: 1 },
];

function extractSymbol(content: string): string | undefined {
  for (const { re, group } of SYMBOL_EXTRACTORS) {
    const m = content.match(re);
    if (m?.[group]) return m[group].trim().slice(0, 120);
  }
  return undefined;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Scan from a declaration line and return the exclusive end line index
 * after the matching brace / indent block (best-effort, pure JS).
 */
function unitEndLine(
  lines: string[],
  start: number,
  language: string,
): number {
  if (language === "python" || language === "ruby") {
    const baseIndent = lines[start].match(/^\s*/)?.[0].length ?? 0;
    let i = start + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "" || line.trim().startsWith("#")) {
        i++;
        continue;
      }
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      i++;
    }
    return i;
  }

  if (!BRACE_LANGS.has(language)) {
    return Math.min(lines.length, start + 80);
  }

  let depth = 0;
  let seen = false;
  let inStr: '"' | "'" | "`" | null = null;
  let escape = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inStr) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "/" && next === "/") break; // line comment
      if (ch === "/" && next === "*") {
        // skip block comments naively across lines
        const close = line.indexOf("*/", j + 2);
        if (close >= 0) {
          j = close + 1;
          continue;
        }
        break;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") {
        depth--;
        if (seen && depth <= 0) return i + 1;
      }
    }
    // const/type aliases without braces: end at next blank or declaration-ish
    if (!seen && i > start) {
      const t = line.trim();
      if (t === "" || /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|func|fn|pub)\b/.test(t)) {
        return i;
      }
      if (i - start > 30) return i + 1;
    }
  }
  return lines.length;
}

function findUnitStarts(
  lines: string[],
  language: string,
  pattern?: RegExp,
): number[] {
  if (!pattern) return [];
  const starts: number[] = [];
  const maxIndent = language === "python" || language === "ruby" ? 0 : 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent > maxIndent) continue;
    // Clone regex so lastIndex never leaks across lines
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(line.trimStart())) starts.push(i);
  }
  return starts;
}

/**
 * Split source into overlapping, symbol-aware chunks.
 * Pure JS — brace/indent aware units (no native tree-sitter).
 */
export function chunkFile(
  relPath: string,
  content: string,
  maxChunkChars: number,
): CodeChunk[] {
  const language = languageForPath(relPath);
  const lines = splitLines(content);
  if (lines.length === 0 || !content.trim()) return [];

  const pattern = SPLIT_PATTERNS[language];
  const maxLines = Math.max(40, Math.floor(maxChunkChars / 40));
  const ranges: Array<{ start: number; end: number }> = [];

  if (pattern) {
    const starts = findUnitStarts(lines, language, pattern);
    if (starts.length === 0) {
      ranges.push({ start: 0, end: lines.length });
    } else {
      // Leading preamble (imports) before first unit
      if (starts[0] > 0) {
        ranges.push({ start: 0, end: starts[0] });
      }
      for (let s = 0; s < starts.length; s++) {
        const start = starts[s];
        let end = unitEndLine(lines, start, language);
        // Don't overrun next unit start
        if (s + 1 < starts.length) {
          end = Math.min(end, starts[s + 1]);
        }
        // Force-split oversized units
        if (end - start > maxLines) {
          for (let p = start; p < end; p += maxLines) {
            ranges.push({ start: p, end: Math.min(end, p + maxLines) });
          }
        } else if (end > start) {
          ranges.push({ start, end });
        }
      }
      // Trailing after last unit
      const lastEnd = ranges.length ? ranges[ranges.length - 1].end : 0;
      if (lastEnd < lines.length) {
        ranges.push({ start: lastEnd, end: lines.length });
      }
    }
  } else {
    for (let p = 0; p < lines.length; p += maxLines) {
      ranges.push({ start: p, end: Math.min(lines.length, p + maxLines) });
    }
  }

  // Only fold tiny preamble/trailer fragments into neighbors — never merge
  // adjacent real units (small functions must stay separate for search).
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const text = lines.slice(r.start, r.end).join("\n").trim();
    const isFragment = text.length > 0 && text.length < 24 && !/\b(function|class|def|fn|func|interface|type|enum)\b/.test(text);
    if (isFragment && merged.length > 0) {
      merged[merged.length - 1].end = r.end;
    } else if (text.length > 0) {
      merged.push({ ...r });
    }
  }

  const chunks: CodeChunk[] = [];
  const overlap = 3;

  for (let i = 0; i < merged.length; i++) {
    let { start, end } = merged[i];
    if (i > 0) start = Math.max(0, start - overlap);

    let text = lines.slice(start, end).join("\n");
    while (text.length > maxChunkChars * 1.5 && end - start > 12) {
      end -= Math.ceil((end - start) / 5);
      text = lines.slice(start, end).join("\n");
    }
    if (!text.trim()) continue;

    const start1 = start + 1;
    const end1 = end;
    const id = shortId(relPath, String(start1), String(end1), sha256(text).slice(0, 8));

    chunks.push({
      id,
      path: relPath,
      language,
      startLine: start1,
      endLine: end1,
      content: text,
      symbol: extractSymbol(text),
      hash: sha256(text),
    });
  }

  if (chunks.length === 0 && content.trim()) {
    const text = content.slice(0, maxChunkChars * 2);
    const end1 = Math.min(lines.length, splitLines(text).length);
    chunks.push({
      id: shortId(relPath, "1", String(end1)),
      path: relPath,
      language,
      startLine: 1,
      endLine: end1,
      content: text,
      symbol: extractSymbol(text),
      hash: sha256(text),
    });
  }

  return chunks;
}
