/**
 * Evaluate a benchmark run without discarding partial failure evidence.
 * A selected suite counts as successful only when exactly one result satisfies
 * the supplied success predicate.
 */
export function evaluateBenchmarkSuites({
  selectedSuiteIds,
  suiteResults,
  isSuccessful = (result) => Boolean(result?.retrieval),
}) {
  const selected = [...new Set(selectedSuiteIds)];
  const selectedSet = new Set(selected);
  const resultsBySuite = new Map(selected.map((id) => [id, []]));

  for (const result of suiteResults) {
    if (!result || !selectedSet.has(result.id)) continue;
    resultsBySuite.get(result.id).push(result);
  }

  const successful = new Set();
  const failed = new Set();
  for (const id of selected) {
    const results = resultsBySuite.get(id);
    if (results.length === 1 && isSuccessful(results[0])) successful.add(id);
    else failed.add(id);
  }

  return {
    passed: selected.length > 0 && failed.size === 0,
    selectedSuites: selected.length,
    successfulSuites: successful.size,
    failedSuites: [...failed],
  };
}

export function summarizeSuiteCoverage(selectedSuiteIds, manifestSuiteIds) {
  const selected = [...new Set(selectedSuiteIds)];
  const manifest = [...new Set(manifestSuiteIds)];
  const selectedSet = new Set(selected);
  const manifestSet = new Set(manifest);
  const missingSuites = manifest.filter((id) => !selectedSet.has(id));
  const unexpectedSuites = selected.filter((id) => !manifestSet.has(id));
  return {
    fullCoverage:
      selected.length === manifest.length &&
      missingSuites.length === 0 &&
      unexpectedSuites.length === 0,
    selectedSuites: selected,
    manifestSuites: manifest,
    missingSuites,
    unexpectedSuites,
  };
}

const PRODUCTION_MODES = ["bm25", "hybrid", "neural"];

/**
 * A report is production evidence only when it exercises the entire manifest
 * with the full retrieval protocol. Development and filtered runs may still
 * have useful local gates, but must never replace the production-latest report.
 */
export function evaluateScaleProductionProtocol({
  selectedSuiteIds,
  manifestSuiteIds,
  modes,
  repetitions,
  warmups,
  includeColdCli,
  canonicalManifest = true,
  requireFullCoverage = true,
  filteredRun = false,
  validateOnly = false,
}) {
  const coverage = summarizeSuiteCoverage(selectedSuiteIds, manifestSuiteIds);
  const selectedModes = [...new Set(modes)];
  const exactModes =
    modes.length === PRODUCTION_MODES.length &&
    selectedModes.length === PRODUCTION_MODES.length &&
    PRODUCTION_MODES.every((mode) => selectedModes.includes(mode));
  const checks = {
    canonicalManifest: canonicalManifest === true,
    fullCoverage: coverage.fullCoverage,
    fullCoverageGate: requireFullCoverage === true,
    unfiltered: !filteredRun,
    executableRun: !validateOnly,
    exactModes,
    repetitions: Number.isInteger(repetitions) && repetitions >= 3,
    warmups: Number.isInteger(warmups) && warmups >= 1,
    coldCli: includeColdCli === true,
  };
  const failures = [];
  if (!checks.canonicalManifest) {
    failures.push("production evidence requires the canonical scale manifest");
  }
  if (!checks.fullCoverage) {
    failures.push(
      `manifest coverage incomplete${
        coverage.missingSuites.length
          ? `; missing ${coverage.missingSuites.join(",")}`
          : ""
      }`,
    );
  }
  if (!checks.fullCoverageGate) {
    failures.push("full-coverage gate is explicitly disabled");
  }
  if (!checks.unfiltered) failures.push("suite/tier filters are active");
  if (!checks.executableRun) failures.push("validate-only run is not production evidence");
  if (!checks.exactModes) {
    failures.push(`modes must be exactly ${PRODUCTION_MODES.join(",")}`);
  }
  if (!checks.repetitions) failures.push("at least 3 measured repetitions are required");
  if (!checks.warmups) failures.push("at least 1 warmup is required");
  if (!checks.coldCli) failures.push("cold CLI measurement is required");
  return {
    passed: failures.length === 0,
    productionEligible: failures.length === 0,
    requiredModes: [...PRODUCTION_MODES],
    checks,
    coverage,
    failures,
  };
}

/**
 * The production-latest pointer is trusted release evidence. A run may satisfy
 * the execution protocol and still fail a quality, latency, resource, model,
 * or suite gate, so protocol eligibility alone is not sufficient to publish.
 */
export function shouldPublishScaleLatest({
  productionEligible,
  finalGatePassed,
}) {
  return productionEligible === true && finalGatePassed === true;
}
