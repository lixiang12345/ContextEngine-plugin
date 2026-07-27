import { statSync } from "node:fs";
import path from "node:path";

export function parseNonNegativeMetric(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function groupResourceHealthTargets(targets) {
  const grouped = new Map();
  for (const target of targets) {
    if (!target?.healthUrl || !target?.role) continue;
    const current = grouped.get(target.healthUrl) || {
      healthUrl: target.healthUrl,
      roles: new Set(),
    };
    current.roles.add(target.role);
    grouped.set(target.healthUrl, current);
  }
  return [...grouped.values()].map((target) => ({
    healthUrl: target.healthUrl,
    roles: [...target.roles].sort(),
  }));
}

export function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function summarizeLatency(values) {
  if (!values.length) {
    return { samples: 0, minMs: null, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    samples: values.length,
    minMs: Math.min(...values),
    meanMs: sum / values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

function normalizedResultPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isCanonicalGoldPath(value) {
  if (typeof value !== "string" || !value) return false;
  if (value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function pathMatches(candidate, labels) {
  const normalized = normalizedResultPath(candidate);
  return labels.some((label) => normalized === label);
}

export function evaluateRetrievalCase(paths, gold, topK) {
  const expected = gold.expectPaths;
  const hardNegatives = gold.hardNegativePaths || [];
  const ranked = [];
  const seen = new Set();
  for (const candidate of paths) {
    const normalized = normalizedResultPath(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ranked.push(normalized);
    if (ranked.length === topK) break;
  }
  const relevantRanks = ranked
    .map((path, index) => (pathMatches(path, expected) ? index + 1 : null))
    .filter((value) => value !== null);
  const matchedExpected = expected.filter((label) =>
    ranked.some((candidate) => pathMatches(candidate, [label])),
  );
  const dcg = ranked.reduce(
    (total, path, index) =>
      total + (pathMatches(path, expected) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealHits = Math.min(expected.length, topK);
  let idealDcg = 0;
  for (let index = 0; index < idealHits; index += 1) {
    idealDcg += 1 / Math.log2(index + 2);
  }
  return {
    recallAtK: matchedExpected.length / expected.length,
    mrr: relevantRanks.length ? 1 / relevantRanks[0] : 0,
    ndcgAtK: idealDcg ? Math.min(1, dcg / idealDcg) : 0,
    top1: relevantRanks[0] === 1,
    top3: relevantRanks.some((rank) => rank <= 3),
    top5: relevantRanks.some((rank) => rank <= 5),
    hardNegativeTop1:
      ranked.length > 0 && pathMatches(ranked[0], hardNegatives),
    hardNegativeAtK: ranked.some((path) => pathMatches(path, hardNegatives)),
  };
}

export function summarizeRetrievalCases(rows) {
  if (!rows.length) {
    return {
      cases: 0,
      meanRecallAtK: 0,
      meanMrr: 0,
      meanNdcgAtK: 0,
      top1Accuracy: 0,
      top3Accuracy: 0,
      top5Accuracy: 0,
      hardNegativeTop1Rate: 0,
      hardNegativeAtKRate: 0,
    };
  }
  const mean = (key) =>
    rows.reduce((total, row) => total + Number(row[key]), 0) / rows.length;
  return {
    cases: rows.length,
    meanRecallAtK: mean("recallAtK"),
    meanMrr: mean("mrr"),
    meanNdcgAtK: mean("ndcgAtK"),
    top1Accuracy: mean("top1"),
    top3Accuracy: mean("top3"),
    top5Accuracy: mean("top5"),
    hardNegativeTop1Rate: mean("hardNegativeTop1"),
    hardNegativeAtKRate: mean("hardNegativeAtK"),
  };
}

export function validateGoldCases(cases, trackedPaths, options = {}) {
  const errors = [];
  const ids = new Set();
  const tracked = new Set(trackedPaths.map(normalizedResultPath));
  if (!Array.isArray(cases) || cases.length === 0) {
    return { valid: false, cases: 0, errors: ["gold cases must be a non-empty array"] };
  }
  for (const [index, entry] of cases.entries()) {
    const label = `case[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: expected object`);
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      errors.push(`${label}: missing id`);
    } else if (ids.has(entry.id)) {
      errors.push(`${label}: duplicate id ${entry.id}`);
    } else {
      ids.add(entry.id);
    }
    if (typeof entry.query !== "string" || !entry.query.trim()) {
      errors.push(`${label}: missing query`);
    }
    for (const field of ["expectPaths", "hardNegativePaths"]) {
      const values = entry[field];
      if (field === "expectPaths" && (!Array.isArray(values) || values.length === 0)) {
        errors.push(`${label}: expectPaths must be non-empty`);
        continue;
      }
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
        errors.push(`${label}: ${field} must contain non-empty strings`);
        continue;
      }
      if (new Set(values).size !== values.length) {
        errors.push(`${label}: ${field} must not contain duplicate paths`);
      }
      for (const value of values) {
        if (!isCanonicalGoldPath(value)) {
          errors.push(`${label}: ${field} path ${value} must be a canonical relative path`);
          continue;
        }
        if (!tracked.has(value)) {
          errors.push(`${label}: ${field} path ${value} is absent`);
        } else if (options.sourceRoot && options.maxFileBytes) {
          let indexable = false;
          try {
            const stat = statSync(path.join(options.sourceRoot, value));
            indexable = stat.isFile() && stat.size <= options.maxFileBytes;
          } catch {
            indexable = false;
          }
          if (!indexable) {
            errors.push(
              `${label}: ${field} path ${value} exceeds maxFileBytes=${options.maxFileBytes}`,
            );
          }
        }
      }
    }
    const hardNegatives = new Set(entry.hardNegativePaths || []);
    const overlap = (entry.expectPaths || []).filter((expected) =>
      hardNegatives.has(expected),
    );
    if (overlap.length) errors.push(`${label}: positive and hard-negative paths overlap`);
  }
  return { valid: errors.length === 0, cases: cases.length, errors };
}

export function evaluateModeThresholds(result, thresholds) {
  const failures = [];
  const checkMin = (actual, minimum, label) => {
    if (minimum === undefined) return;
    if (!Number.isFinite(actual)) {
      failures.push(`${label} sample is missing or non-finite`);
    } else if (actual < minimum) {
      failures.push(`${label} ${actual.toFixed(4)} < ${minimum.toFixed(4)}`);
    }
  };
  const checkMax = (actual, maximum, label) => {
    if (maximum === undefined) return;
    if (!Number.isFinite(actual)) {
      failures.push(`${label} sample is missing or non-finite`);
    } else if (actual > maximum) {
      failures.push(`${label} ${actual.toFixed(2)} > ${maximum.toFixed(2)}`);
    }
  };
  checkMin(result.retrieval?.meanRecallAtK, thresholds.minRecallAtK, "Recall@k");
  checkMin(result.retrieval?.meanMrr, thresholds.minMrr, "MRR");
  checkMin(result.retrieval?.meanNdcgAtK, thresholds.minNdcgAtK, "nDCG@k");
  checkMin(result.retrieval?.top3Accuracy, thresholds.minTop3, "Top3");
  checkMin(result.retrieval?.top5Accuracy, thresholds.minTop5, "Top5");
  checkMax(
    result.retrieval?.hardNegativeTop1Rate,
    thresholds.maxHardNegativeTop1Rate,
    "hard-negative Top1 rate",
  );
  checkMax(result.latency?.p95Ms, thresholds.maxSteadyP95Ms, "steady P95 ms");
  checkMax(result.coldCli?.p95Ms, thresholds.maxColdP95Ms, "cold CLI P95 ms");
  checkMin(
    result.throughputQueriesPerSecond,
    thresholds.minQueryThroughputPerSecond,
    "query throughput/s",
  );
  if (result.index && !result.index.reused) {
    checkMin(
      result.index.chunksPerSecond,
      thresholds.minIndexChunksPerSecond,
      "index chunks/s",
    );
  }
  checkMax(result.resources?.peakLocalRssMb, thresholds.maxLocalRssMb, "local RSS MB");
  if (
    thresholds.maxRemoteVramGb !== undefined &&
    result.resources?.remoteCoveragePassed === false
  ) {
    failures.push("remote VRAM coverage is incomplete");
  } else {
    checkMax(
      result.resources?.peakRemoteVramGb,
      thresholds.maxRemoteVramGb,
      "remote VRAM GB",
    );
  }
  return { passed: failures.length === 0, failures };
}
