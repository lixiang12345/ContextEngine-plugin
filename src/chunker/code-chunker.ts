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

interface ChunkRange {
  start: number;
  end: number;
  prefix?: string;
  symbol?: string;
  noOverlap?: boolean;
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
    re: /(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|mod|fun|protocol|extension|namespace|record|object|actor)\s+([A-Za-z_$][\w$]*)/,
    group: 1,
  },
  { re: /(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*=/, group: 1 },
  { re: /func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, group: 1 },
  { re: /\bfunc\s+\([^)]*\)\s+([A-Za-z_$][\w$]*)\s*\(/, group: 1 },
  {
    re: /^\s*(?:(?:public|private|protected|internal|static|readonly|override|abstract|async|get|set|final|open|suspend)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\([^;{}]*\)\s*(?::[^{]+)?\{/m,
    group: 1,
  },
  {
    re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|override|virtual|async|open|sealed|extern)\s+)*(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/m,
    group: 1,
  },
  {
    re: /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/m,
    group: 1,
  },
  {
    re: /\b(?:exports|module\.exports|prototype)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    group: 1,
  },
  {
    re: /^\s*(?!(?:if|for|while|switch|catch|return)\b)(?:(?:static|inline|extern|const|unsigned|signed|volatile|constexpr|virtual|explicit|friend)\s+)*(?:[\w:<>*&~\s]+?)\s+([A-Za-z_~][\w]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/m,
    group: 1,
  },
  { re: /\b([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*\{/, group: 1 },
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
  "constructor",
  "describe",
  "for",
  "if",
  "it",
  "return",
  "switch",
  "test",
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

export function extractSymbolNames(content: string, language: string): string[] {
  const source = symbolSource(content, language);
  const names = new Set<string>();
  for (const { re, group } of SYMBOL_EXTRACTORS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    for (const match of source.matchAll(new RegExp(re.source, flags))) {
      const value = match[group]?.trim().slice(0, 120);
      if (value && !NON_SYMBOL_NAMES.has(value.toLowerCase())) names.add(value);
    }
  }
  return [...names];
}

function extractSymbol(content: string, language: string): string | undefined {
  return extractSymbolNames(content, language)[0];
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

function commentMarker(language: string): string {
  return language === "python" || language === "ruby" || language === "markdown"
    ? "#"
    : "//";
}

function containerContextPrefix(
  lines: string[],
  start: number,
  language: string,
): { prefix: string; symbol: string | undefined } {
  let symbol: string | undefined;
  let oneLine = "";
  for (let i = start; i < Math.min(lines.length, start + 12); i++) {
    const line = lines[i] ?? "";
    if (isCommentOrBlank(line, profileFor(language).commentPrefixes)) continue;
    if (isDecoratorLine(line, language)) continue;
    oneLine = line.trim().replace(/\s+/g, " ");
    symbol = extractSymbol(oneLine, language);
    break;
  }
  const label = symbol ? `${symbol} (${oneLine})` : oneLine;
  return {
    prefix: label
      ? `${commentMarker(language)} Context: ${label.slice(0, 180)}\n`
      : "",
    symbol,
  };
}

function memberNameFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || /^(?:if|for|while|switch|catch|return|else|do)\b/.test(trimmed)) {
    return null;
  }

  const patterns: Array<{ re: RegExp; group: number }> = [
    {
      re: /^(?:(?:public|private|protected|internal|static|final|open|suspend|override|abstract|inline|operator)\s+)*fun\s+([A-Za-z_$][\w$]*)\s*\(/,
      group: 1,
    },
    {
      re: /^(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|extern)\s+)*fn\s+([A-Za-z_$][\w$]*)\s*\(/,
      group: 1,
    },
    {
      re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
      group: 1,
    },
    {
      re: /^(?:(?:private|protected|override|final|abstract|implicit)\s+)*def\s+([A-Za-z_$][\w$]*)\s*[(:=]/,
      group: 1,
    },
    {
      re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
      group: 1,
    },
    {
      re: /^(?:(?:public|private|protected|internal|static|readonly|override|abstract|async|get|set|final|open|suspend)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\([^;{}]*\)\s*(?::[^{]+)?\{/,
      group: 1,
    },
    {
      re: /^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|override|virtual|async|open|sealed|extern)\s+)*(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{]+)?\{/,
      group: 1,
    },
    {
      re: /^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
      group: 1,
    },
  ];

  for (const { re, group } of patterns) {
    const match = trimmed.match(re);
    const name = match?.[group];
    if (name && !NON_SYMBOL_NAMES.has(name.toLowerCase())) return name;
  }
  return null;
}

function splitOversizedUnit(
  lines: string[],
  start: number,
  end: number,
  language: string,
  profile: LangProfile,
  maxLines: number,
  maxChunkChars: number,
): ChunkRange[] {
  const context = containerContextPrefix(lines, start, language);
  const containerIndent = lineIndent(lines[start] ?? "");
  const candidates: Array<{
    line: number;
    start: number;
    end: number;
    indent: number;
    name: string;
  }> = [];

  for (let i = start + 1; i < end; i++) {
    const indent = lineIndent(lines[i]);
    if (indent <= containerIndent) continue;
    const name = memberNameFromLine(lines[i]);
    if (!name) continue;
    const memberEnd = Math.min(end, unitEndLine(lines, i, language, profile));
    if (memberEnd <= i) continue;
    candidates.push({
      line: i,
      start: Math.max(start + 1, attachHeader(lines, i, language, profile)),
      end: memberEnd,
      indent,
      name,
    });
  }

  if (candidates.length < 2) return [];

  const minIndent = Math.min(...candidates.map((candidate) => candidate.indent));
  const members = candidates
    .filter((candidate) => candidate.indent <= minIndent + 2)
    .sort((left, right) => left.line - right.line);
  if (members.length < 2) return [];

  const ranges: ChunkRange[] = [];
  const firstMemberStart = members[0].start;
  if (firstMemberStart > start) {
    ranges.push({
      start,
      end: firstMemberStart,
      symbol: context.symbol,
      noOverlap: true,
    });
  }

  let previousEnd = start;
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member.line < previousEnd) continue;
    const nextStart = members[i + 1]?.start ?? end;
    const memberEnd = Math.min(member.end, nextStart);
    const symbol = context.symbol ? `${context.symbol}.${member.name}` : member.name;
    const prefix = context.prefix;

    if (memberEnd - member.start > maxLines) {
      for (let p = member.start; p < memberEnd; p += maxLines) {
        ranges.push({
          start: p,
          end: Math.min(memberEnd, p + maxLines),
          prefix,
          symbol,
          noOverlap: true,
        });
      }
    } else {
      const text = lines.slice(member.start, memberEnd).join("\n");
      if (text.length > maxChunkChars * 1.5 && memberEnd - member.start > 12) {
        for (let p = member.start; p < memberEnd; p += maxLines) {
          ranges.push({
            start: p,
            end: Math.min(memberEnd, p + maxLines),
            prefix,
            symbol,
            noOverlap: true,
          });
        }
      } else {
        ranges.push({
          start: member.start,
          end: memberEnd,
          prefix,
          symbol,
          noOverlap: true,
        });
      }
    }
    previousEnd = Math.max(previousEnd, memberEnd);
  }

  if (previousEnd < end - 1) {
    ranges.push({
      start: previousEnd,
      end,
      prefix: context.prefix,
      symbol: context.symbol,
      noOverlap: true,
    });
  }

  return ranges.filter((range) => range.end > range.start);
}

function lineSplitRange(start: number, end: number, maxLines: number): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  for (let p = start; p < end; p += maxLines) {
    ranges.push({ start: p, end: Math.min(end, p + maxLines) });
  }
  return ranges;
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
  const ranges: ChunkRange[] = [];
  const starts = findUnitStarts(lines, language, profile);

  if (starts.length === 0) {
    const splitUnit =
      lines.length > maxLines || content.length > maxChunkChars * 1.5
        ? splitOversizedUnit(
            lines,
            0,
            lines.length,
            language,
            profile,
            maxLines,
            maxChunkChars,
          )
        : [];
    ranges.push(
      ...(splitUnit.length ? splitUnit : lineSplitRange(0, lines.length, maxLines)),
    );
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
      const unitText = lines.slice(start, end).join("\n");
      if (end - start > maxLines || unitText.length > maxChunkChars * 1.5) {
        const splitUnit = splitOversizedUnit(
          lines,
          start,
          end,
          language,
          profile,
          maxLines,
          maxChunkChars,
        );
        ranges.push(
          ...(splitUnit.length ? splitUnit : lineSplitRange(start, end, maxLines)),
        );
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
  const merged: ChunkRange[] = [];
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const text = lines.slice(r.start, r.end).join("\n").trim();
    const isFragment =
      text.length > 0 &&
      text.length < 28 &&
      !/\b(function|class|def|fn|func|interface|type|enum|struct|impl|trait|module|namespace)\b/i.test(
        text,
      );
    if (r.prefix || r.symbol) {
      merged.push({ ...r });
    } else if (isFragment && merged.length > 0) {
      merged[merged.length - 1].end = r.end;
    } else if (text.length > 0) {
      merged.push({ ...r });
    }
  }

  const chunks: CodeChunk[] = [];
  const overlap = 2;

  for (let i = 0; i < merged.length; i++) {
    const range = merged[i];
    let { start, end } = range;
    if (i > 0 && !range.noOverlap) start = Math.max(0, start - overlap);

    let text = `${range.prefix ?? ""}${lines.slice(start, end).join("\n")}`;
    while (text.length > maxChunkChars * 1.5 && end - start > 12) {
      end -= Math.ceil((end - start) / 5);
      text = `${range.prefix ?? ""}${lines.slice(start, end).join("\n")}`;
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
      symbol: range.symbol ?? extractSymbol(text, language),
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
