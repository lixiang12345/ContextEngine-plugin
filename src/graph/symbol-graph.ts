import path from "node:path";
import type { CodeChunk } from "../types.js";

export interface SymbolNode {
  /** Fully-qualified-ish key: path#symbol or path */
  key: string;
  path: string;
  symbol?: string;
  chunkIds: string[];
}

export interface SymbolGraph {
  /** symbol name (lower) -> keys */
  bySymbol: Map<string, string[]>;
  /** path -> keys defined in file */
  byPath: Map<string, string[]>;
  /** path -> imported relative paths / modules */
  imports: Map<string, string[]>;
  nodes: Map<string, SymbolNode>;
}

const IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+|require\s*\(\s*|from\s+)['"]([^'"]+)['"]/g;
const PYTHON_IMPORT_RE =
  /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
const GO_IMPORT_RE = /import\s+(?:\(([^)]+)\)|"([^"]+)")/g;

const DEF_PATTERNS: RegExp[] = [
  /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_][\w]*)/g,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/g,
  /(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_][\w]*)/g,
  /(?:async\s+)?def\s+([A-Za-z_][\w]*)/g,
  /func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,
];

function addToMultiMap(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) list.push(value);
  map.set(key, list);
}

function extractDefs(content: string): string[] {
  const names = new Set<string>();
  for (const re of DEF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      names.add(m[1]);
    }
  }
  return [...names];
}

function extractImports(filePath: string, content: string, language: string): string[] {
  const out = new Set<string>();
  const dir = path.posix.dirname(filePath.split(path.sep).join("/"));

  if (
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "vue" ||
    language === "svelte"
  ) {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(content))) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(dir, spec));
        out.add(resolved);
      } else {
        out.add(spec);
      }
    }
  } else if (language === "python") {
    PYTHON_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PYTHON_IMPORT_RE.exec(content))) {
      const mod = m[1] || m[2];
      if (mod) out.add(mod.replace(/\./g, "/"));
    }
  } else if (language === "go") {
    GO_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GO_IMPORT_RE.exec(content))) {
      const block = m[1] || m[2] || "";
      for (const line of block.split("\n")) {
        const mm = line.match(/"([^"]+)"/);
        if (mm) out.add(mm[1]);
      }
    }
  }

  return [...out];
}

/** Build a lightweight symbol/import graph from chunks (no compiler required). */
export function buildSymbolGraph(chunks: CodeChunk[]): SymbolGraph {
  const graph: SymbolGraph = {
    bySymbol: new Map(),
    byPath: new Map(),
    imports: new Map(),
    nodes: new Map(),
  };

  // Group content by path for import extraction
  const byPathContent = new Map<string, { language: string; content: string }>();
  for (const c of chunks) {
    const prev = byPathContent.get(c.path);
    if (!prev) {
      byPathContent.set(c.path, { language: c.language, content: c.content });
    } else {
      prev.content += "\n" + c.content;
    }

    const defs = c.symbol ? [c.symbol, ...extractDefs(c.content)] : extractDefs(c.content);
    const uniqueDefs = [...new Set(defs.filter(Boolean))];
    if (uniqueDefs.length === 0) {
      const key = c.path;
      let node = graph.nodes.get(key);
      if (!node) {
        node = { key, path: c.path, chunkIds: [] };
        graph.nodes.set(key, node);
      }
      if (!node.chunkIds.includes(c.id)) node.chunkIds.push(c.id);
      addToMultiMap(graph.byPath, c.path, key);
    } else {
      for (const sym of uniqueDefs) {
        const key = `${c.path}#${sym}`;
        let node = graph.nodes.get(key);
        if (!node) {
          node = { key, path: c.path, symbol: sym, chunkIds: [] };
          graph.nodes.set(key, node);
        }
        if (!node.chunkIds.includes(c.id)) node.chunkIds.push(c.id);
        addToMultiMap(graph.bySymbol, sym.toLowerCase(), key);
        addToMultiMap(graph.byPath, c.path, key);
      }
    }
  }

  for (const [p, meta] of byPathContent) {
    const imports = extractImports(p, meta.content, meta.language);
    graph.imports.set(p, imports);
  }

  return graph;
}

/**
 * Expand a set of seed chunk ids via:
 * - same-file symbols
 * - files that import / are imported by seed files
 * - same symbol name definitions elsewhere
 */
export function expandViaGraph(
  graph: SymbolGraph,
  seedChunkIds: string[],
  chunksById: Map<string, CodeChunk>,
  limit = 12,
): string[] {
  const seedPaths = new Set<string>();
  const seedSymbols = new Set<string>();
  for (const id of seedChunkIds) {
    const c = chunksById.get(id);
    if (!c) continue;
    seedPaths.add(c.path);
    if (c.symbol) seedSymbols.add(c.symbol.toLowerCase());
    for (const d of extractDefs(c.content)) seedSymbols.add(d.toLowerCase());
  }

  const relatedPaths = new Set<string>(seedPaths);

  // Follow imports from seed files
  for (const p of seedPaths) {
    for (const imp of graph.imports.get(p) ?? []) {
      // Match relative imports against known paths
      for (const known of graph.byPath.keys()) {
        if (
          known === imp ||
          known.startsWith(imp) ||
          known.replace(/\.[^.]+$/, "") === imp ||
          known.includes(imp)
        ) {
          relatedPaths.add(known);
        }
      }
    }
  }

  // Reverse: files that import seed paths
  for (const [p, imps] of graph.imports) {
    for (const imp of imps) {
      for (const seed of seedPaths) {
        const seedNoExt = seed.replace(/\.[^.]+$/, "");
        if (
          seed === imp ||
          seed.startsWith(imp) ||
          seedNoExt.endsWith(imp) ||
          seed.includes(imp)
        ) {
          relatedPaths.add(p);
        }
      }
    }
  }

  const expanded: string[] = [];
  const seen = new Set(seedChunkIds);

  // Same-symbol defs
  for (const sym of seedSymbols) {
    for (const key of graph.bySymbol.get(sym) ?? []) {
      const node = graph.nodes.get(key);
      if (!node) continue;
      for (const id of node.chunkIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        expanded.push(id);
        if (expanded.length >= limit) return expanded;
      }
    }
  }

  // Related files' primary chunks
  for (const p of relatedPaths) {
    if (seedPaths.has(p)) continue;
    for (const key of graph.byPath.get(p) ?? []) {
      const node = graph.nodes.get(key);
      if (!node) continue;
      for (const id of node.chunkIds.slice(0, 2)) {
        if (seen.has(id)) continue;
        seen.add(id);
        expanded.push(id);
        if (expanded.length >= limit) return expanded;
      }
    }
  }

  return expanded;
}
