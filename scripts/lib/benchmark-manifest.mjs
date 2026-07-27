const TIERS = new Set(["small", "medium", "large"]);
const MODES = new Set(["bm25", "hybrid", "neural"]);
const THRESHOLD_KEYS = new Set([
  "maxColdP95Ms",
  "maxHardNegativeTop1Rate",
  "maxLocalRssMb",
  "maxRemoteVramGb",
  "maxSteadyP95Ms",
  "minIndexChunksPerSecond",
  "minMrr",
  "minNdcgAtK",
  "minQueryThroughputPerSecond",
  "minRecallAtK",
  "minTop3",
  "minTop5",
]);
const PROBABILITY_THRESHOLDS = new Set([
  "maxHardNegativeTop1Rate",
  "minMrr",
  "minNdcgAtK",
  "minRecallAtK",
  "minTop3",
  "minTop5",
]);

export function validateScaleManifestSchema(value) {
  assertRecord(value, "scale manifest");
  assertKnownKeys(
    value,
    new Set(["version", "tierRules", "thresholds", "macroThresholds", "suites"]),
    "scale manifest",
  );
  if (value.version !== 1 || !Array.isArray(value.suites)) {
    throw new Error("scale manifest must have version=1 and suites[]");
  }

  assertRecord(value.tierRules, "tierRules");
  assertKnownKeys(value.tierRules, TIERS, "tierRules");
  for (const tier of TIERS) {
    validateTierRule(value.tierRules[tier], `tierRules.${tier}`);
  }

  assertRecord(value.thresholds, "thresholds");
  assertKnownKeys(
    value.thresholds,
    new Set(["defaults", "tiers", "modes"]),
    "thresholds",
  );
  validateThresholdBlock(value.thresholds.defaults, "thresholds.defaults");
  assertRecord(value.thresholds.tiers, "thresholds.tiers");
  assertKnownKeys(value.thresholds.tiers, TIERS, "thresholds.tiers");
  for (const tier of TIERS) {
    validateThresholdBlock(
      value.thresholds.tiers[tier],
      `thresholds.tiers.${tier}`,
    );
  }
  assertRecord(value.thresholds.modes, "thresholds.modes");
  assertKnownKeys(value.thresholds.modes, MODES, "thresholds.modes");
  for (const mode of MODES) {
    validateThresholdBlock(
      value.thresholds.modes[mode],
      `thresholds.modes.${mode}`,
    );
  }

  assertRecord(value.macroThresholds, "macroThresholds");
  assertKnownKeys(value.macroThresholds, MODES, "macroThresholds");
  for (const [mode, thresholds] of Object.entries(value.macroThresholds)) {
    validateThresholdBlock(thresholds, `macroThresholds.${mode}`);
  }

  for (const [index, suite] of value.suites.entries()) {
    const label = `suites[${index}]`;
    assertRecord(suite, label);
    assertKnownKeys(
      suite,
      new Set([
        "id",
        "tier",
        "language",
        "license",
        "licenseFile",
        "clone",
        "rootSubdir",
        "cases",
        "maxFileBytes",
      ]),
      label,
    );
    assertRecord(suite.clone, `${label}.clone`);
    assertKnownKeys(
      suite.clone,
      new Set(["url", "dir", "commit"]),
      `${label}.clone`,
    );
  }
}

function validateTierRule(value, label) {
  assertRecord(value, label);
  assertKnownKeys(
    value,
    new Set(["minIndexableBytes", "maxIndexableBytes"]),
    label,
  );
  for (const [key, metric] of Object.entries(value)) {
    assertNonNegativeFinite(metric, `${label}.${key}`);
  }
  if (
    value.minIndexableBytes !== undefined &&
    value.maxIndexableBytes !== undefined &&
    value.minIndexableBytes > value.maxIndexableBytes
  ) {
    throw new Error(`${label} minimum exceeds maximum`);
  }
}

function validateThresholdBlock(value, label) {
  assertRecord(value, label);
  assertKnownKeys(value, THRESHOLD_KEYS, label);
  for (const [key, metric] of Object.entries(value)) {
    assertNonNegativeFinite(metric, `${label}.${key}`);
    if (PROBABILITY_THRESHOLDS.has(key) && metric > 1) {
      throw new Error(`${label}.${key} must be between 0 and 1`);
    }
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`${label} has unknown key(s): ${unknown.sort().join(", ")}`);
  }
}

function assertNonNegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}
