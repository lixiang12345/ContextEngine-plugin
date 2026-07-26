import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { analyzeQuery } from "../src/search/query-analyzer.js";
import {
  MAX_SUBQUERIES,
  MAX_SUBQUERY_CHARS,
  fuseSubqueryHits,
  planTaskSubqueries,
} from "../src/search/task-subqueries.js";
import type { SearchHit } from "../src/types.js";

function hit(id: string, pathName: string, score: number, channels?: SearchHit["channels"]): SearchHit {
  return {
    chunk: {
      id,
      path: pathName,
      language: "ts",
      startLine: 1,
      endLine: 10,
      content: "content",
    },
    score,
    source: "bm25",
    preview: "content",
    channels,
  };
}

describe("task subquery planner", () => {
  it("keeps the single-query path for short or focused queries", () => {
    assert.deepEqual(planTaskSubqueries(analyzeQuery("renewSnapshotJobLease")), []);
    assert.deepEqual(planTaskSubqueries(analyzeQuery("fix login bug")), []);
    assert.deepEqual(
      planTaskSubqueries(analyzeQuery("src/server/snapshot-job-runner.ts")),
      [],
    );
  });

  it("decomposes a mixed symbol+path+concept task into bounded facets", () => {
    const plan = planTaskSubqueries(
      analyzeQuery(
        "Fix the retry budget in SnapshotJobRunner so replication failures in src/server/snapshot-job-runner.ts stop consuming attempts. Capacity errors must fail fast instead of retrying forever.",
      ),
    );
    assert.ok(plan.length >= 2, JSON.stringify(plan));
    assert.ok(plan.length <= MAX_SUBQUERIES);
    for (const subquery of plan) {
      assert.ok(subquery.query.length <= MAX_SUBQUERY_CHARS);
      assert.ok(subquery.query.length >= 3);
    }
    const reasons = new Set(plan.map((subquery) => subquery.reason));
    assert.ok(reasons.has("identifier"), "identifier facet expected");
    assert.ok(reasons.has("path") || reasons.has("clause"), "path or clause facet expected");
    const identifierFacet = plan.find((subquery) => subquery.reason === "identifier");
    assert.equal(identifierFacet?.query, "SnapshotJobRunner");
  });

  it("adds a history facet for regression-style tasks", () => {
    const plan = planTaskSubqueries(
      analyzeQuery(
        "Why did replicateIndexSnapshot regress after the publication fencing commit? Explain when the retry behavior around scheduleSnapshotJobRetry was introduced and what changed.",
      ),
    );
    const history = plan.find((subquery) => subquery.reason === "history");
    assert.ok(history, JSON.stringify(plan));
    assert.match(history.query, /history/);
    assert.match(history.query, /replicateIndexSnapshot/);
  });

  it("deduplicates facets whose token sets are contained in another", () => {
    const plan = planTaskSubqueries(
      analyzeQuery(
        "Explain how loadWorkspaceRules loadWorkspaceRules discovers AGENTS.md rule files and how loadWorkspaceRules precedence sorting decides which rules apply first in the engine.",
      ),
    );
    const queries = plan.map((subquery) => subquery.query.toLowerCase());
    assert.equal(new Set(queries).size, queries.length, JSON.stringify(plan));
  });
});

describe("subquery rank fusion", () => {
  it("keeps the primary consensus on top but surfaces subquery discoveries", () => {
    const primary = [hit("a", "src/a.ts", 9), hit("b", "src/b.ts", 8), hit("c", "src/c.ts", 7)];
    const subqueries = [
      { query: "GoldSymbol", reason: "identifier" as const },
      { query: "src/gold", reason: "path" as const },
    ];
    const fused = fuseSubqueryHits(
      primary,
      subqueries,
      [
        [hit("gold", "src/gold/target.ts", 5, { symbol: 3 }), hit("a", "src/a.ts", 4)],
        [hit("gold", "src/gold/target.ts", 6, { path: 2 })],
      ],
      4,
    );
    assert.equal(fused.hits[0].chunk.id, "a", "primary top hit must stay on top");
    const goldRank = fused.hits.findIndex((entry) => entry.chunk.id === "gold");
    assert.ok(goldRank >= 0 && goldRank < 4, "subquery discovery must enter the fused list");
    assert.deepEqual(
      fused.contributions.map((entry) => [entry.reason, entry.hits, entry.contributed]),
      [
        ["identifier", 2, 2],
        ["path", 1, 1],
      ],
    );
    const gold = fused.hits[goldRank];
    assert.ok(gold.channels?.symbol, "channel evidence from subqueries is preserved");
  });

  it("bounds the fused list at the requested limit", () => {
    const primary = Array.from({ length: 12 }, (_value, index) =>
      hit(`p${index}`, `src/p${index}.ts`, 12 - index),
    );
    const fused = fuseSubqueryHits(primary, [], [], 5);
    assert.equal(fused.hits.length, 5);
  });
});

const describePostgres =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL
    ? describe
    : describe.skip;

describePostgres("task subqueries end to end", () => {
  let root: string;
  let dataDir: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-subquery-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src", "billing"), { recursive: true });
    mkdirSync(path.join(root, "src", "notify"), { recursive: true });
    // The gold file matches the task only through its focused facets: the
    // identifier facet (InvoiceLedgerReconciler) and the path facet
    // (src/billing). The broad task sentence itself is dominated by decoy
    // vocabulary, which is exactly the failure mode fusion must fix.
    writeFileSync(
      path.join(root, "src", "billing", "reconciler.ts"),
      `export class InvoiceLedgerReconciler {\n  reconcile(entries: number[]) {\n    return entries.reduce((sum, entry) => sum + entry, 0);\n  }\n}\n`,
    );
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(
        path.join(root, "src", "notify", `digest-${index}.ts`),
        `// customer notification digest pipeline stage ${index}\n` +
          `export function sendDigestStage${index}() {\n` +
          `  // schedule customer email notification digest batches nightly\n` +
          `  return "customer email notification digest schedule nightly batches";\n` +
          `}\n`,
      );
    }
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fuses facet subqueries into the pack and records the trace", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    try {
      await engine.index();
      const task =
        "Schedule the nightly customer email notification digest batches, and make InvoiceLedgerReconciler in src/billing reconcile ledger entries before the digest is sent.";
      const packed = await engine.getTaskContext({ task, topK: 6 });
      assert.ok(packed.trace?.subqueries?.length, "trace must record the subquery plan");
      for (const entry of packed.trace.subqueries) {
        assert.ok(entry.query.length <= MAX_SUBQUERY_CHARS);
        assert.ok(["identifier", "path", "clause", "history"].includes(entry.reason));
        assert.ok(entry.hits >= 0);
      }
      const packedPaths = packed.hits.map((entry) => entry.chunk.path);
      assert.ok(
        packedPaths.includes("src/billing/reconciler.ts"),
        `gold file missing from ${JSON.stringify(packedPaths)}`,
      );

      const single = await engine.getTaskContext({ task, topK: 6, subqueries: false });
      assert.equal(single.trace?.subqueries, undefined);
    } finally {
      await engine.close();
    }
  });

  it("falls back to the single-query path when a subquery hop fails", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    try {
      const task =
        "Schedule the nightly customer email notification digest batches, and make InvoiceLedgerReconciler in src/billing reconcile ledger entries before the digest is sent.";
      const originalSearch = engine.search.bind(engine);
      let calls = 0;
      engine.search = async (opts) => {
        calls += 1;
        // The primary query succeeds; every subquery hop dies.
        if (calls > 1) throw new Error("subquery hop unavailable");
        return originalSearch(opts);
      };
      const packed = await engine.getTaskContext({ task, topK: 6 });
      assert.ok(calls > 1, "subquery hops must have been attempted");
      assert.equal(packed.trace?.subqueries, undefined);
      assert.ok(packed.hits.length > 0, "primary result must survive the fallback");
    } finally {
      await engine.close();
    }
  });
});
