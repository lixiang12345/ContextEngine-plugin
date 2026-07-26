import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

interface GateResult {
  passed: boolean;
  selectedSuites: number;
  successfulSuites: number;
  failedSuites: string[];
}

async function loadGate(): Promise<{
  evaluateBenchmarkSuites(input: {
    selectedSuiteIds: string[];
    suiteResults: Array<{ id: string; retrieval?: object; error?: string }>;
  }): GateResult;
  summarizeSuiteCoverage(
    selectedSuiteIds: string[],
    manifestSuiteIds: string[],
  ): {
    fullCoverage: boolean;
    missingSuites: string[];
    unexpectedSuites: string[];
  };
  evaluateScaleProductionProtocol(input: {
    selectedSuiteIds: string[];
    manifestSuiteIds: string[];
    modes: string[];
    repetitions: number;
    warmups: number;
    includeColdCli: boolean;
    canonicalManifest?: boolean;
    requireFullCoverage?: boolean;
    filteredRun?: boolean;
    validateOnly?: boolean;
  }): {
    passed: boolean;
    productionEligible: boolean;
    failures: string[];
    checks: Record<string, boolean>;
  };
  shouldPublishScaleLatest(input: {
    productionEligible: boolean;
    finalGatePassed: boolean;
  }): boolean;
}> {
  const url = pathToFileURL(
    new URL("../scripts/lib/benchmark-gate.mjs", import.meta.url).pathname,
  ).href;
  return import(url) as Promise<{
    evaluateBenchmarkSuites(input: {
      selectedSuiteIds: string[];
      suiteResults: Array<{ id: string; retrieval?: object; error?: string }>;
    }): GateResult;
    summarizeSuiteCoverage(
      selectedSuiteIds: string[],
      manifestSuiteIds: string[],
    ): {
      fullCoverage: boolean;
      missingSuites: string[];
      unexpectedSuites: string[];
    };
    evaluateScaleProductionProtocol(input: {
      selectedSuiteIds: string[];
      manifestSuiteIds: string[];
      modes: string[];
      repetitions: number;
      warmups: number;
      includeColdCli: boolean;
      canonicalManifest?: boolean;
      requireFullCoverage?: boolean;
      filteredRun?: boolean;
      validateOnly?: boolean;
    }): {
      passed: boolean;
      productionEligible: boolean;
      failures: string[];
      checks: Record<string, boolean>;
    };
    shouldPublishScaleLatest(input: {
      productionEligible: boolean;
      finalGatePassed: boolean;
    }): boolean;
  }>;
}

describe("benchmark suite gate", () => {
  it("passes only when every selected suite has a successful result", async () => {
    const { evaluateBenchmarkSuites } = await loadGate();
    assert.deepEqual(
      evaluateBenchmarkSuites({
        selectedSuiteIds: ["small", "medium"],
        suiteResults: [
          { id: "small", retrieval: {} },
          { id: "medium", retrieval: {} },
        ],
      }),
      {
        passed: true,
        selectedSuites: 2,
        successfulSuites: 2,
        failedSuites: [],
      },
    );
  });

  it("fails closed for zero successful or partially successful runs", async () => {
    const { evaluateBenchmarkSuites } = await loadGate();
    const zero = evaluateBenchmarkSuites({
      selectedSuiteIds: ["small", "medium"],
      suiteResults: [
        { id: "small", error: "index failed" },
        { id: "medium", error: "index failed" },
      ],
    });
    assert.equal(zero.passed, false);
    assert.equal(zero.successfulSuites, 0);
    assert.deepEqual(zero.failedSuites, ["small", "medium"]);

    const partial = evaluateBenchmarkSuites({
      selectedSuiteIds: ["small", "medium"],
      suiteResults: [
        { id: "small", retrieval: {} },
        { id: "medium", error: "search failed" },
      ],
    });
    assert.equal(partial.passed, false);
    assert.equal(partial.successfulSuites, 1);
    assert.deepEqual(partial.failedSuites, ["medium"]);
  });

  it("fails when a selected suite has duplicate result rows", async () => {
    const { evaluateBenchmarkSuites } = await loadGate();
    const result = evaluateBenchmarkSuites({
      selectedSuiteIds: ["small"],
      suiteResults: [
        { id: "small", retrieval: {} },
        { id: "small", retrieval: {} },
      ],
    });
    assert.equal(result.passed, false);
    assert.equal(result.successfulSuites, 0);
    assert.deepEqual(result.failedSuites, ["small"]);
  });

  it("defines full coverage as every manifest suite", async () => {
    const { summarizeSuiteCoverage } = await loadGate();
    const partial = summarizeSuiteCoverage(
      ["small-a", "small-b", "medium", "large"],
      ["small-a", "small-b", "small-c", "medium", "large"],
    );
    assert.equal(partial.fullCoverage, false);
    assert.deepEqual(partial.missingSuites, ["small-c"]);

    const complete = summarizeSuiteCoverage(
      ["large", "small-a", "small-b", "small-c", "medium"],
      ["small-a", "small-b", "small-c", "medium", "large"],
    );
    assert.equal(complete.fullCoverage, true);
    assert.deepEqual(complete.unexpectedSuites, []);
  });

  it("requires the complete production protocol before publishing latest", async () => {
    const { evaluateScaleProductionProtocol } = await loadGate();
    const base = {
      selectedSuiteIds: ["small", "medium", "large"],
      manifestSuiteIds: ["small", "medium", "large"],
      modes: ["neural", "bm25", "hybrid"],
      repetitions: 3,
      warmups: 1,
      includeColdCli: true,
    };
    const production = evaluateScaleProductionProtocol(base);
    assert.equal(production.passed, true);
    assert.equal(production.productionEligible, true);

    for (const override of [
      { modes: ["bm25", "hybrid"] },
      { modes: ["bm25", "hybrid", "neural", "bm25"] },
      { repetitions: 2 },
      { warmups: 0 },
      { includeColdCli: false },
      { canonicalManifest: false },
      { requireFullCoverage: false },
      { filteredRun: true },
      { validateOnly: true },
      { selectedSuiteIds: ["small", "medium"] },
    ]) {
      const result = evaluateScaleProductionProtocol({ ...base, ...override });
      assert.equal(result.productionEligible, false, JSON.stringify(override));
      assert.ok(result.failures.length > 0, JSON.stringify(override));
    }
  });

  it("publishes production latest only after both protocol and final gates pass", async () => {
    const { shouldPublishScaleLatest } = await loadGate();

    assert.equal(
      shouldPublishScaleLatest({
        productionEligible: true,
        finalGatePassed: true,
      }),
      true,
    );
    assert.equal(
      shouldPublishScaleLatest({
        productionEligible: true,
        finalGatePassed: false,
      }),
      false,
    );
    assert.equal(
      shouldPublishScaleLatest({
        productionEligible: false,
        finalGatePassed: true,
      }),
      false,
    );
  });
});
