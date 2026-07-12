import type { CodeChunk } from "../types.js";
import { shortId, sha256 } from "../util/hash.js";
import { languageForPath } from "../util/fs.js";

/** Language-aware splitting patterns: start of a likely top-level unit. */
const SPLIT_PATTERNS: Record<string, RegExp> = {
  typescript:
    /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+/m,
  tsx: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+/m,
  javascript:
    /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+/m,
  python:
    /^(?:async\s+)?(?:def|class)\s+|^@\w+/m,
  go: /^(?:func|type|const|var)\s+/m,
  rust: /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|const|type)\s+/m,
  java:
    /^(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|record|void|\w+)\s+\w+/m,
  ruby: /^(?:module|class|def)\s+/m,
  csharp:
    /^(?:public|private|protected|internal|static|sealed|abstract|\s)*(?:class|interface|struct|enum|record|void|\w+)\s+\w+/m,
  markdown: /^#{1,3}\s+/m,
};

const SYMBOL_EXTRACTORS: Array<{ re: RegExp; group: number }> = [
  { re: /(?:function|class|interface|type|enum|def|fn|struct|trait|mod)\s+([A-Za-z_][\w]*)/, group: 1 },
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
 * Split source into overlapping, symbol-aware chunks.
 * Pure JS — no native tree-sitter dependency (Phase 1).
 * Phase 2 may add AST-aware chunking for higher precision.
 */
export function chunkFile(
  relPath: string,
  content: string,
  maxChunkChars: number,
): CodeChunk[] {
  const language = languageForPath(relPath);
  const lines = splitLines(content);
  if (lines.length === 0) return [];

  const pattern = SPLIT_PATTERNS[language];
  const unitStarts: number[] = [0];

  if (pattern) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Only treat as split if line looks like a unit start at modest indentation
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= 2 && pattern.test(line)) {
        unitStarts.push(i);
      }
    }
  }

  // Also force-split very long runs by line budget
  const maxLines = Math.max(40, Math.floor(maxChunkChars / 40));
  const refined: number[] = [];
  for (let u = 0; u < unitStarts.length; u++) {
    const start = unitStarts[u];
    const end = u + 1 < unitStarts.length ? unitStarts[u + 1] : lines.length;
    refined.push(start);
    for (let s = start + maxLines; s < end; s += maxLines) {
      refined.push(s);
    }
  }

  const chunks: CodeChunk[] = [];
  const overlap = 4;

  for (let i = 0; i < refined.length; i++) {
    const startLine = Math.max(0, refined[i] - (i === 0 ? 0 : 0));
    let endLine =
      i + 1 < refined.length
        ? refined[i + 1]
        : lines.length;

    // Extend small trailing fragments into previous when possible is skipped for simplicity
    let slice = lines.slice(startLine, endLine);
    let text = slice.join("\n");

    // Merge tiny leftovers into previous chunk
    if (text.trim().length < 40 && chunks.length > 0 && i === refined.length - 1) {
      const prev = chunks[chunks.length - 1];
      const merged = lines.slice(prev.startLine - 1, endLine).join("\n");
      prev.content = merged;
      prev.endLine = endLine;
      prev.hash = sha256(merged);
      prev.symbol = extractSymbol(merged) ?? prev.symbol;
      continue;
    }

    // Soft-enforce char limit by shrinking end
    while (text.length > maxChunkChars * 1.4 && endLine - startLine > 12) {
      endLine -= Math.ceil((endLine - startLine) / 5);
      slice = lines.slice(startLine, endLine);
      text = slice.join("\n");
    }

    // Apply small overlap from previous for context continuity
    let finalStart = startLine;
    if (i > 0 && overlap > 0) {
      finalStart = Math.max(0, startLine - overlap);
      text = lines.slice(finalStart, endLine).join("\n");
    }

    if (!text.trim()) continue;

    const start1 = finalStart + 1;
    const end1 = endLine;
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

  // Fallback: whole file as one chunk if nothing produced
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
