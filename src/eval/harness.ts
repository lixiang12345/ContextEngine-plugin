import { performance } from "node:perf_hooks";
import type { ContextEngine } from "../engine.js";

export interface EvalCase {
  id: string;
  query: string;
  expectPaths: string[];
  expectSymbols?: string[];
  topK?: number;
}

export interface EvalCaseResult {
  id: string;
  query: string;
  hitPaths: string[];
  recallAtK: number;
  /** Reciprocal rank of first relevant path (0 if none) */
  mrr: number;
  /** nDCG@k treating expected paths as graded 1 */
  ndcgAtK: number;
  pathHits: number;
  expected: number;
  symbolHits: number;
  latencyMs: number;
  top1Hit: boolean;
  top3Hit: boolean;
  top5Hit: boolean;
  passed: boolean;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  meanRecallAtK: number;
  meanMrr: number;
  meanNdcgAtK: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  top1Accuracy: number;
  top3Accuracy: number;
  top5Accuracy: number;
  cases: EvalCaseResult[];
}

function dcg(rels: number[]): number {
  let s = 0;
  for (let i = 0; i < rels.length; i++) {
    s += rels[i] / Math.log2(i + 2);
  }
  return s;
}

function ndcgAtK(hitPaths: string[], expectPaths: string[], k: number): number {
  const rels = hitPaths.slice(0, k).map((p) =>
    expectPaths.some((e) => p.includes(e)) ? 1 : 0,
  );
  const ideal = [
    ...Array(Math.min(expectPaths.length, k)).fill(1),
    ...Array(Math.max(0, k - expectPaths.length)).fill(0),
  ].slice(0, k);
  const idcg = dcg(ideal);
  if (idcg <= 0) return 0;
  return Math.min(1, dcg(rels) / idcg);
}

function mrrOf(hitPaths: string[], expectPaths: string[]): number {
  for (let i = 0; i < hitPaths.length; i++) {
    if (expectPaths.some((e) => hitPaths[i].includes(e))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[rank];
}

export async function runEval(
  engine: ContextEngine,
  cases: EvalCase[],
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];

  for (const c of cases) {
    const topK = c.topK ?? 8;
    const started = performance.now();
    const hits = await engine.search({
      query: c.query,
      topK,
      mode: "auto",
      expandGraph: true,
      diversify: true,
    });
    const latencyMs = Math.max(0, performance.now() - started);
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
    const mrr = mrrOf(hitPaths, c.expectPaths);
    const ndcgAtKScore = ndcgAtK(hitPaths, c.expectPaths, topK);
    const isRelevant = (path: string): boolean =>
      c.expectPaths.some((expectedPath) => path.includes(expectedPath));
    const top1Hit = hitPaths.slice(0, 1).some(isRelevant);
    const top3Hit = hitPaths.slice(0, 3).some(isRelevant);
    const top5Hit = hitPaths.slice(0, 5).some(isRelevant);

    let symbolHits = 0;
    for (const sym of c.expectSymbols ?? []) {
      if (hitSymbols.some((s) => s.includes(sym.toLowerCase()))) symbolHits++;
    }

    const passed =
      pathHits === expected &&
      mrr > 0 &&
      (c.expectSymbols?.length
        ? symbolHits >= Math.min(1, c.expectSymbols.length)
        : true);

    results.push({
      id: c.id,
      query: c.query,
      hitPaths,
      recallAtK,
      mrr,
      ndcgAtK: ndcgAtKScore,
      pathHits,
      expected,
      symbolHits,
      latencyMs: Number(latencyMs.toFixed(3)),
      top1Hit,
      top3Hit,
      top5Hit,
      passed,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const n = results.length || 1;
  const latencies = results.map((result) => result.latencyMs);

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    meanRecallAtK: results.reduce((s, r) => s + r.recallAtK, 0) / n,
    meanMrr: results.reduce((s, r) => s + r.mrr, 0) / n,
    meanNdcgAtK: results.reduce((s, r) => s + r.ndcgAtK, 0) / n,
    meanLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / n,
    p95LatencyMs: percentile(latencies, 0.95),
    top1Accuracy: results.filter((result) => result.top1Hit).length / n,
    top3Accuracy: results.filter((result) => result.top3Hit).length / n,
    top5Accuracy: results.filter((result) => result.top5Hit).length / n,
    cases: results,
  };
}

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
    {
      id: "symbol-exact",
      query: "analyzeQuery",
      expectPaths: ["src/search/query-analyzer.ts"],
      expectSymbols: ["analyzeQuery"],
    },
    {
      id: "rerank",
      query: "featureScore mmrSelect code-aware ranking",
      expectPaths: ["src/search/rerank.ts"],
    },
    {
      id: "postgres-store",
      query: "PostgreSQL pgvector tsvector HNSW vector search store",
      expectPaths: ["src/store/postgres-store.ts"],
    },
  ];
}
