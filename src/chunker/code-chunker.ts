import type { CodeChunk } from "../types.js";
import { shortId, sha256 } from "../util/hash.js";
import { languageForPath } from "../util/fs.js";

/**
 * Language-aware code chunking for retrieval.
 *
 * Policy (see docs/CHUNKING.md):
 * - Prefer structural units (function/class/type) over fixed token windows
 * - Language-specific start rules + brace or indent end detection
 * - Attach leading comments/decorators; keep import preamble
 * - Soft-split oversized units; merge tiny trailers
 */

type EndMode = "brace" | "indent" | "line";

interface LangProfile {
  /** Line starts a new top-level unit when indent is shallow. */
  start: RegExp;
  end: EndMode;
  /** Max indent (spaces) still considered "top-level" for starts. */
  maxStartIndent: number;
  /** Comment line prefixes to attach above a unit. */
  commentPrefixes: string[];
}

const PROFILES: Record<string, LangProfile> = {
  typescript: {
    start:
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  tsx: {
    start:
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  javascript: {
    start:
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  python: {
    start: /^(?:async\s+)?(?:def|class)\s+|^(?:@[\w\.]+)/,
    end: "indent",
    maxStartIndent: 0,
    commentPrefixes: ["#"],
  },
  go: {
    start: /^(?:func|type|const|var)\s+/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  rust: {
    start:
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|const|type|static)\s+/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "///", "/*", "*", "*/", "#["],
  },
  java: {
    start:
      /^(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|@\w+(?:\([^)]*\))?)\s+)*(?:class|interface|enum|record|@interface)\s+\w+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "@"],
  },
  kotlin: {
    start:
      /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|inner|companion|suspend|override|final)\s+)*(?:fun|class|interface|object|enum\s+class|data\s+class|sealed\s+class)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "@"],
  },
  scala: {
    start:
      /^(?:(?:private|protected|override|final|abstract|sealed|case|implicit|lazy)\s+)*(?:class|object|trait|def|val|var|type)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "@"],
  },
  csharp: {
    start:
      /^(?:(?:public|private|protected|internal|static|sealed|abstract|partial|async|override|virtual|extern)\s+)*(?:class|interface|struct|enum|record|namespace|void|[\w<>,\[\]]+)\s+\w+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "["],
  },
  c: {
    start:
      /^(?:#\s*(?:include|define|ifdef|ifndef|endif|pragma)\b)|^(?:typedef\s+)?(?:struct|enum|union)\s+\w+|^(?!(?:if|for|while|switch)\b)(?:(?:static|inline|extern|const|unsigned|signed|volatile|_Noreturn)\s+)*(?:struct\s+\w+|enum\s+\w+|union\s+\w+|[A-Za-z_][\w]*)(?:\s+|\s*\*+\s*)[A-Za-z_][\w]*\s*\(/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  cpp: {
    start:
      /^(?:#\s*(?:include|define|ifdef|ifndef|endif|pragma)\b)|^(?:namespace\s+)|^(?:template\s*<)|^(?:(?:inline|static|virtual|constexpr|explicit|friend|const|volatile)\s+)*(?:class|struct|enum|using)\s+|^(?:(?:template\s*<[^;{]*>\s*)?(?:[\w:<>\*&~\s]+)\s+[A-Za-z_~][\w]*\s*\()/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  "objective-c": {
    start: /^(?:@interface|@implementation|@protocol)\b|^(?:[-+]\s*\()/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  "objective-cpp": {
    start: /^(?:@interface|@implementation|@protocol)\b|^(?:[-+]\s*\()/,
    end: "brace",
    maxStartIndent: 0,
    commentPrefixes: ["//", "/*", "*", "*/"],
  },
  swift: {
    start:
      /^(?:(?:public|private|internal|open|fileprivate|static|final|override|mutating|async)\s+)*(?:func|class|struct|enum|protocol|extension|actor|typealias)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "@"],
  },
  dart: {
    start:
      /^(?:(?:abstract|class|mixin|extension|enum|typedef|mixin)\s+)|^(?:(?:static|final|const|Future|void|[\w<>,\s\?]+)\s+)?[A-Za-z_][\w]*\s*\(/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "/*", "*", "*/", "@"],
  },
  php: {
    start:
      /^(?:(?:public|private|protected|static|final|abstract)\s+)*(?:function|class|interface|trait|enum)\s+/,
    end: "brace",
    maxStartIndent: 2,
    commentPrefixes: ["//", "#", "/*", "*", "*/"],
  },
  ruby: {
    start: /^(?:module|class|def)\s+/,
    end: "indent",
    maxStartIndent: 0,
    commentPrefixes: ["#"],
  },
  markdown: {
    start: /^#{1,3}\s+/,
    end: "line",
    maxStartIndent: 0,
    commentPrefixes: [],
  },
};

const SYMBOL_EXTRACTORS: Array<{ re: RegExp; group: number }> = [
  {
    re: /(?:function\*?|class|interface|type|enum|def|fn|struct|trait|mod|fun|protocol|extension|namespace|record|object|actor)\s+([A-Za-z_][\w]*)/,
    group: 1,
  },
  { re: /(?:const|let|var|val)\s+([A-Za-z_][\w]*)\s*=/, group: 1 },
  { re: /func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, group: 1 },
  { re: /\b([A-Za-z_][\w]*)\s*\([^;{]*\)\s*\{/, group: 1 },
  { re: /^#+\s+(.+)$/m, group: 1 },
];

function profileFor(language: string): LangProfile {
  return (
    PROFILES[language] ?? {
      start: /^(?:function|class|def|fn|func|struct|type|interface|enum)\s+/i,
      end: "brace",
      maxStartIndent: 2,
      commentPrefixes: ["//", "#", "/*", "*"],
    }
  );
}

const NON_SYMBOL_NAMES = new Set([
  "catch",
  "for",
  "if",
  "return",
  "switch",
  "while",
]);

function symbolSource(content: string, language: string): string {
  if (language === "markdown") return content;
  let source = content
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .replace(/\/\/.*$/gm, "");
  if (language === "python" || language === "ruby") {
    source = source.replace(/^\s*#.*$/gm, "");
  }
  return source;
}

function extractSymbol(content: string, language: string): string | undefined {
  const source = symbolSource(content, language);
  for (const { re, group } of SYMBOL_EXTRACTORS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    for (const match of source.matchAll(new RegExp(re.source, flags))) {
      const value = match[group]?.trim().slice(0, 120);
      if (value && !NON_SYMBOL_NAMES.has(value.toLowerCase())) return value;
    }
  }
  return undefined;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function lineIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function isCommentOrBlank(line: string, prefixes: string[]): boolean {
  const t = line.trim();
  if (!t) return true;
  return prefixes.some((p) => t.startsWith(p));
}

function isDecoratorLine(line: string, language: string): boolean {
  const t = line.trim();
  if (language === "python") return t.startsWith("@");
  if (language === "java" || language === "kotlin" || language === "csharp") {
    return t.startsWith("@") || t.startsWith("[");
  }
  if (language === "rust") return t.startsWith("#[") || t.startsWith("#!");
  if (language === "go") return t.startsWith("//go:");
  return false;
}

function unitEndLine(
  lines: string[],
  start: number,
  language: string,
  profile: LangProfile,
): number {
  if (profile.end === "indent") {
    const baseIndent = lineIndent(lines[start]);
    let i = start + 1;
    // skip decorator-only starts: find real def/class then indent-close
    while (i < lines.length && isDecoratorLine(lines[i - 1] ?? "", language)) {
      /* handled by attaching decorators above */
      break;
    }
    // If start is decorator, end of unit is after the following def/class block
    let bodyStart = start;
    if (isDecoratorLine(lines[start], language)) {
      let j = start + 1;
      while (j < lines.length && (isCommentOrBlank(lines[j], profile.commentPrefixes) || isDecoratorLine(lines[j], language))) {
        j++;
      }
      bodyStart = j < lines.length ? j : start;
    }
    const indent0 = lineIndent(lines[bodyStart] ?? lines[start]);
    i = bodyStart + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (isCommentOrBlank(line, profile.commentPrefixes)) {
        i++;
        continue;
      }
      if (lineIndent(line) <= indent0 && lineIndent(line) <= baseIndent) break;
      i++;
    }
    return i;
  }

  if (profile.end === "line") {
    // markdown: until next same-or-higher heading
    const m = lines[start].match(/^(#{1,6})\s+/);
    const level = m ? m[1].length : 1;
    let i = start + 1;
    while (i < lines.length) {
      const hm = lines[i].match(/^(#{1,6})\s+/);
      if (hm && hm[1].length <= level) break;
      i++;
    }
    return i;
  }

  // brace mode
  let depth = 0;
  let seen = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    inLineComment = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j++;
        }
        continue;
      }
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
      if (ch === "/" && next === "/") {
        inLineComment = true;
        break;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === "[") {
        bracketDepth++;
      } else if (ch === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (ch === "{") {
        // A declaration may contain lambdas or object literals inside its
        // parameter list before the actual function/class body opens.
        if (depth === 0 && parenDepth === 0 && bracketDepth === 0) {
          seen = true;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (seen && depth <= 0) return i + 1;
      }
    }
    // declarations without braces (typedef one-liners, go const)
    if (!seen && i > start) {
      const t = line.trim();
      if (
        t === "" ||
        profile.start.test(t) ||
        (lineIndent(line) <= profile.maxStartIndent && profile.start.test(line.replace(/^\s+/, "")))
      ) {
        return i;
      }
      if (i - start > 40) return i + 1;
    }
  }
  return lines.length;
}

function findUnitStarts(
  lines: string[],
  language: string,
  profile: LangProfile,
): number[] {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = lineIndent(line);
    if (indent > profile.maxStartIndent) continue;
    // skip pure comments
    if (isCommentOrBlank(line, profile.commentPrefixes) && !isDecoratorLine(line, language)) {
      continue;
    }
    const re = new RegExp(profile.start.source, profile.start.flags);
    const trimmed = line.replace(/^\s+/, "");
    if (re.test(trimmed)) starts.push(i);
  }
  return starts;
}

/** Expand start upward to include attached comments/decorators. */
function attachHeader(
  lines: string[],
  start: number,
  language: string,
  profile: LangProfile,
): number {
  let s = start;
  while (s > 0) {
    const prev = lines[s - 1];
    if (isCommentOrBlank(prev, profile.commentPrefixes) || isDecoratorLine(prev, language)) {
      s--;
      continue;
    }
    break;
  }
  return s;
}

/**
 * Split source into overlapping, structure-aware chunks.
 */
export function chunkFile(
  relPath: string,
  content: string,
  maxChunkChars: number,
): CodeChunk[] {
  const language = languageForPath(relPath);
  const profile = profileFor(language);
  const lines = splitLines(content);
  if (lines.length === 0 || !content.trim()) return [];

  const maxLines = Math.max(40, Math.floor(maxChunkChars / 40));
  const ranges: Array<{ start: number; end: number }> = [];
  const starts = findUnitStarts(lines, language, profile);

  if (starts.length === 0) {
    for (let p = 0; p < lines.length; p += maxLines) {
      ranges.push({ start: p, end: Math.min(lines.length, p + maxLines) });
    }
  } else {
    // preamble before first unit
    const firstAttached = attachHeader(lines, starts[0], language, profile);
    if (firstAttached > 0) {
      ranges.push({ start: 0, end: firstAttached });
    }
    for (let s = 0; s < starts.length; s++) {
      const rawStart = starts[s];
      const start = attachHeader(lines, rawStart, language, profile);
      let end = unitEndLine(lines, rawStart, language, profile);
      if (s + 1 < starts.length) {
        const nextAttached = attachHeader(lines, starts[s + 1], language, profile);
        end = Math.min(end, nextAttached);
      }
      if (end <= start) continue;
      if (end - start > maxLines) {
        for (let p = start; p < end; p += maxLines) {
          ranges.push({ start: p, end: Math.min(end, p + maxLines) });
        }
      } else {
        ranges.push({ start, end });
      }
    }
    const lastEnd = ranges.length ? ranges[ranges.length - 1].end : 0;
    if (lastEnd < lines.length) {
      ranges.push({ start: lastEnd, end: lines.length });
    }
  }

  // Merge tiny non-code fragments only
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const text = lines.slice(r.start, r.end).join("\n").trim();
    const isFragment =
      text.length > 0 &&
      text.length < 28 &&
      !/\b(function|class|def|fn|func|interface|type|enum|struct|impl|trait|module|namespace)\b/i.test(
        text,
      );
    if (isFragment && merged.length > 0) {
      merged[merged.length - 1].end = r.end;
    } else if (text.length > 0) {
      merged.push({ ...r });
    }
  }

  const chunks: CodeChunk[] = [];
  const overlap = 2;

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
    const id = shortId(
      relPath,
      String(start1),
      String(end1),
      sha256(text).slice(0, 8),
    );

    chunks.push({
      id,
      path: relPath,
      language,
      startLine: start1,
      endLine: end1,
      content: text,
      symbol: extractSymbol(text, language),
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
      symbol: extractSymbol(text, language),
      hash: sha256(text),
    });
  }

  return chunks;
}
