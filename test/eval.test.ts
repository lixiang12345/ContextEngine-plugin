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
});
