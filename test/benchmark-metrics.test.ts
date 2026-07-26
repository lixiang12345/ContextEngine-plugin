import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const metrics = import("../scripts/lib/benchmark-metrics.mjs") as Promise<{
  percentile(values: number[], quantile: number): number | null;
  parseNonNegativeMetric(value: unknown): number | null;
  groupResourceHealthTargets(
    targets: Array<{ role: string; healthUrl: string }>,
  ): Array<{ healthUrl: string; roles: string[] }>;
  evaluateRetrievalCase(
    paths: string[],
    gold: { expectPaths: string[]; hardNegativePaths?: string[] },
    topK: number,
  ): Record<string, number | boolean>;
  validateGoldCases(
    cases: unknown[],
    paths: string[],
    options?: { sourceRoot: string; maxFileBytes: number },
  ): { valid: boolean; errors: string[] };
  evaluateModeThresholds(
    result: Record<string, unknown>,
    thresholds: Record<string, number>,
  ): { passed: boolean; failures: string[] };
}>;

describe("benchmark metrics", () => {
  it("accepts only non-empty finite nonnegative resource samples", async () => {
    const { parseNonNegativeMetric } = await metrics;
    assert.equal(parseNonNegativeMetric(0), 0);
    assert.equal(parseNonNegativeMetric("2.5"), 2.5);
    for (const value of [null, undefined, "", "  ", -1, Infinity, NaN, false, {}]) {
      assert.equal(parseNonNegativeMetric(value), null, String(value));
    }
  });

  it("keeps separate model health services and deduplicates a shared service", async () => {
    const { groupResourceHealthTargets } = await metrics;
    assert.deepEqual(
      groupResourceHealthTargets([
        { role: "embedding", healthUrl: "http://models.test/health" },
        { role: "reranker", healthUrl: "http://models.test/health" },
      ]),
      [
        {
          healthUrl: "http://models.test/health",
          roles: ["embedding", "reranker"],
        },
      ],
    );
    assert.equal(
      groupResourceHealthTargets([
        { role: "embedding", healthUrl: "http://embed.test/health" },
        { role: "reranker", healthUrl: "http://rerank.test/health" },
      ]).length,
      2,
    );
  });

  it("uses nearest-rank percentiles", async () => {
    const { percentile } = await metrics;
    assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
    assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
    assert.equal(percentile([], 0.95), null);
  });

  it("scores relevant paths and hard negatives independently", async () => {
    const { evaluateRetrievalCase } = await metrics;
    assert.deepEqual(
      evaluateRetrievalCase(
        ["src/other.ts", "src/target.ts", "src/negative.ts"],
        {
          expectPaths: ["src/target.ts"],
          hardNegativePaths: ["src/negative.ts"],
        },
        3,
      ),
      {
        recallAtK: 1,
        mrr: 0.5,
        ndcgAtK: 1 / Math.log2(3),
        top1: false,
        top3: true,
        top5: true,
        hardNegativeTop1: false,
        hardNegativeAtK: true,
      },
    );
  });

  it("matches complete normalized paths instead of suffixes or substrings", async () => {
    const { evaluateRetrievalCase } = await metrics;
    const result = evaluateRetrievalCase(
      [
        "vendor/src/target.ts",
        "src/target.ts.bak",
        ".\\src\\target.ts",
        "src/negative.ts.extra",
      ],
      {
        expectPaths: ["src/target.ts"],
        hardNegativePaths: ["src/negative.ts"],
      },
      4,
    );
    assert.equal(result.mrr, 1 / 3);
    assert.equal(result.hardNegativeAtK, false);
  });

  it("deduplicates chunk paths before computing file-level ranking", async () => {
    const { evaluateRetrievalCase } = await metrics;
    const result = evaluateRetrievalCase(
      ["src/target.ts", "src/target.ts", "src/other.ts"],
      { expectPaths: ["src/target.ts", "src/other.ts"] },
      2,
    );
    assert.equal(result.recallAtK, 1);
    assert.equal(result.ndcgAtK, 1);
  });

  it("rejects absent or overlapping gold paths", async () => {
    const { validateGoldCases } = await metrics;
    const result = validateGoldCases(
      [
        {
          id: "case",
          query: "query",
          expectPaths: ["target.ts"],
          hardNegativePaths: ["target.ts", "missing.ts"],
        },
      ],
      ["src/target.ts"],
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /absent/);
    assert.match(result.errors.join("\n"), /overlap/);
  });

  it("rejects gold files that the configured index limit would skip", async () => {
    const { validateGoldCases } = await metrics;
    const root = mkdtempSync(path.join(tmpdir(), "ce-bench-gold-"));
    writeFileSync(path.join(root, "large.ts"), "x".repeat(32));
    const result = validateGoldCases(
      [{ id: "large", query: "large", expectPaths: ["large.ts"] }],
      ["large.ts"],
      { sourceRoot: root, maxFileBytes: 16 },
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /exceeds maxFileBytes=16/);
  });

  it("requires exact canonical gold paths", async () => {
    const { validateGoldCases } = await metrics;
    const suffixOnly = validateGoldCases(
      [{ id: "suffix", query: "suffix", expectPaths: ["target.ts"] }],
      ["src/target.ts"],
    );
    assert.equal(suffixOnly.valid, false);
    assert.match(suffixOnly.errors.join("\n"), /path target\.ts is absent/);

    const nonCanonical = validateGoldCases(
      [{ id: "path", query: "path", expectPaths: ["src\\target.ts"] }],
      ["src/target.ts"],
    );
    assert.equal(nonCanonical.valid, false);
    assert.match(nonCanonical.errors.join("\n"), /canonical relative path/);
  });

  it("fails resource gates when a required sample is missing", async () => {
    const { evaluateModeThresholds } = await metrics;
    const result = evaluateModeThresholds(
      {
        retrieval: {},
        latency: {},
        resources: { peakLocalRssMb: 128, peakRemoteVramGb: null },
      },
      { maxLocalRssMb: 256, maxRemoteVramGb: 10.5 },
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, [
      "remote VRAM GB sample is missing or non-finite",
    ]);
  });

  it("fails when any required remote service lacks VRAM coverage", async () => {
    const { evaluateModeThresholds } = await metrics;
    const incomplete = evaluateModeThresholds(
      {
        retrieval: {},
        latency: {},
        resources: {
          peakRemoteVramGb: 3,
          remoteCoveragePassed: false,
        },
      },
      { maxRemoteVramGb: 10.5 },
    );
    assert.equal(incomplete.passed, false);
    assert.deepEqual(incomplete.failures, [
      "remote VRAM coverage is incomplete",
    ]);

    const complete = evaluateModeThresholds(
      {
        retrieval: {},
        latency: {},
        resources: {
          peakRemoteVramGb: 3,
          remoteCoveragePassed: true,
        },
      },
      { maxRemoteVramGb: 10.5 },
    );
    assert.equal(complete.passed, true);
  });

  it("enforces the Top3 quality floor independently of Top5", async () => {
    const { evaluateModeThresholds } = await metrics;
    const result = evaluateModeThresholds(
      {
        retrieval: { top3Accuracy: 0.8, top5Accuracy: 1 },
        latency: {},
        resources: {},
      },
      { minTop3: 0.9, minTop5: 0.9 },
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, ["Top3 0.8000 < 0.9000"]);
  });
});
