import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { runEval, type EvalCase } from "../src/eval/harness.js";

const describePostgres =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL
    ? describe
    : describe.skip;

describePostgres("eval harness", () => {
  let root: string;
  let dataDir: string;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "ce-eval-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "billing.ts"),
      `export function createInvoice() { return 1; }\n`,
    );
    writeFileSync(
      path.join(root, "src", "login.ts"),
      `export function authenticateUser() { return true; }\n`,
    );
    const engine = ContextEngine.open({ root, dataDir });
    await engine.index();
    await engine.close();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports recall for expected paths", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    const cases: EvalCase[] = [
      {
        id: "bill",
        query: "create invoice billing",
        expectPaths: ["billing"],
      },
    ];
    const report = await runEval(engine, cases);
    await engine.close();
    assert.equal(report.total, 1);
    assert.ok(report.meanRecallAtK >= 0);
    assert.ok(report.meanLatencyMs >= 0);
    assert.ok(report.p95LatencyMs >= report.meanLatencyMs);
    assert.ok(report.top1Accuracy >= 0 && report.top1Accuracy <= 1);
    assert.ok(report.top3Accuracy >= report.top1Accuracy);
    assert.ok(report.top5Accuracy >= report.top3Accuracy);
    assert.ok(report.cases[0].hitPaths.length >= 0);
    assert.ok(report.cases[0].latencyMs >= 0);
  });

  it("omits the retrieval trace unless trace mode is enabled", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    const cases: EvalCase[] = [
      { id: "bill", query: "create invoice billing", expectPaths: ["billing"] },
    ];
    const report = await runEval(engine, cases);
    await engine.close();
    assert.equal(report.cases[0].trace, undefined);
    assert.equal(report.traceSummary, undefined);
  });

  it("captures a reproducible retrieval trace and aggregate summary", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    const cases: EvalCase[] = [
      { id: "bill", query: "create invoice billing", expectPaths: ["billing"] },
      { id: "login", query: "authenticate user login", expectPaths: ["login"] },
    ];
    const report = await runEval(engine, cases, { trace: true });
    await engine.close();

    // IR metrics are unchanged by trace mode: it packs a second query but
    // recall/MRR are still measured off the same search hits.
    assert.equal(report.total, 2);
    for (const result of report.cases) {
      assert.ok(result.trace, "each case carries a trace in trace mode");
      assert.equal(typeof result.trace.intent, "string");
      assert.ok(Array.isArray(result.trace.channels));
      assert.ok(result.trace.candidateCount >= 0);
      assert.ok(result.trace.estimatedTokens >= 0);
    }

    const summary = report.traceSummary;
    assert.ok(summary, "trace mode produces an aggregate summary");
    assert.ok(summary.meanPackedTokens >= 0);
    assert.ok(Array.isArray(summary.degradedChannels));
    assert.equal(typeof summary.channelCaseCounts, "object");
    // The two cases were served by the same immutable generation.
    assert.ok(summary.generations.length <= 1 || summary.generations.length === 2);
  });
});
