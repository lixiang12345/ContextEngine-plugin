import type { ContextEngine } from "../engine.js";

export interface EvalCase {
  /** Unique id */
  id: string;
  /** Natural language query / task */
  query: string;
  /** Paths that should appear in top results (substring match on path) */
  expectPaths: string[];
  /** Optional symbols that should appear */
  expectSymbols?: string[];
  topK?: number;
}

export interface EvalCaseResult {
  id: string;
  query: string;
  hitPaths: string[];
  recallAtK: number;
  pathHits: number;
  expected: number;
  symbolHits: number;
  passed: boolean;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  meanRecallAtK: number;
  cases: EvalCaseResult[];
}

/**
 * Lightweight retrieval eval: did we surface the right files for each task?
 */
export async function runEval(
  engine: ContextEngine,
  cases: EvalCase[],
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];

  for (const c of cases) {
    const topK = c.topK ?? 8;
    const hits = await engine.search({
      query: c.query,
      topK,
      mode: "auto",
      expandGraph: true,
    });
    const hitPaths = hits.map((h) => h.chunk.path);
    const hitSymbols = hits
      .map((h) => h.chunk.symbol?.toLowerCase())
      .filter(Boolean) as string[];

    let pathHits = 0;
    for (const expected of c.expectPaths) {
      if (hitPaths.some((p) => p.includes(expected))) pathHits++;
    }
    const expected = c.expectPaths.length || 1;
    const recallAtK = pathHits / expected;

    let symbolHits = 0;
    for (const sym of c.expectSymbols ?? []) {
      if (hitSymbols.some((s) => s.includes(sym.toLowerCase()))) symbolHits++;
    }

    const passed =
      pathHits === expected &&
      (c.expectSymbols?.length
        ? symbolHits >= Math.min(1, c.expectSymbols.length)
        : true);

    results.push({
      id: c.id,
      query: c.query,
      hitPaths,
      recallAtK,
      pathHits,
      expected,
      symbolHits,
      passed,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const meanRecallAtK =
    results.reduce((s, r) => s + r.recallAtK, 0) / (results.length || 1);

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    meanRecallAtK,
    cases: results,
  };
}

/** Built-in smoke cases targeting this repository's own sources. */
export function defaultSelfEvalCases(): EvalCase[] {
  return [
    {
      id: "bm25",
      query: "BM25 lexical ranking tokenize",
      expectPaths: ["src/search/bm25.ts"],
    },
    {
      id: "hybrid",
      query: "hybrid search reciprocal rank fusion embeddings",
      expectPaths: ["src/search/hybrid.ts"],
    },
    {
      id: "mcp",
      query: "MCP server codebase_search tool for agents",
      expectPaths: ["src/mcp-server.ts"],
    },
    {
      id: "chunker",
      query: "split source code into chunks by function class",
      expectPaths: ["src/chunker/code-chunker.ts"],
    },
    {
      id: "commits",
      query: "git commit lineage harvest history",
      expectPaths: ["src/lineage/commits.ts"],
    },
  ];
}
