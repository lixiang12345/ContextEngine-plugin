#!/usr/bin/env node
/** Reproducible small/medium/large retrieval and capacity benchmark. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  evaluateBenchmarkSuites,
  evaluateScaleProductionProtocol,
  shouldPublishScaleLatest,
  summarizeSuiteCoverage,
} from "./lib/benchmark-gate.mjs";
import {
  evaluateModeThresholds,
  evaluateRetrievalCase,
  groupResourceHealthTargets,
  parseNonNegativeMetric,
  summarizeLatency,
  summarizeRetrievalCases,
  validateGoldCases,
} from "./lib/benchmark-metrics.mjs";
import { validateScaleManifestSchema } from "./lib/benchmark-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const canonicalManifestPath = path.join(
  repoRoot,
  "benchmarks/scale/manifest.json",
);
const manifestPath = path.resolve(
  process.env.BENCH_SCALE_MANIFEST || canonicalManifestPath,
);
const canonicalManifest = manifestPath === canonicalManifestPath;
const benchRoot = path.resolve(
  process.env.BENCH_ROOT || "/tmp/ce-bench-scale",
);
const runId =
  process.env.BENCH_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, "-");
const outDir = path.resolve(
  process.env.BENCH_OUT_DIR || path.join(repoRoot, "eval-results/scale", runId),
);
const latestPath = path.join(repoRoot, "eval-results/scale-summary.json");
const validateOnly = truthy(process.env.BENCH_SCALE_VALIDATE_ONLY);
const skipFetch = truthy(process.env.BENCH_SCALE_SKIP_FETCH);
const repetitions = configuredInteger(
  process.env.BENCH_SCALE_REPETITIONS,
  3,
  1,
  "BENCH_SCALE_REPETITIONS",
);
const warmups = configuredInteger(
  process.env.BENCH_SCALE_WARMUPS,
  1,
  0,
  "BENCH_SCALE_WARMUPS",
);
const includeColdCli = configuredBoolean(
  process.env.BENCH_SCALE_COLD_CLI,
  true,
  "BENCH_SCALE_COLD_CLI",
);
const gitTimeoutMs = configuredInteger(
  process.env.BENCH_SCALE_GIT_TIMEOUT_MS,
  180_000,
  1,
  "BENCH_SCALE_GIT_TIMEOUT_MS",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

validateManifest(manifest);
const manifestSha256 = sha256(readFileSync(manifestPath));
const repositoryState = captureRepositoryState(repoRoot);
const goldEvidence = collectGoldEvidence(manifest);
const requestedSuites = csvSet(process.env.BENCH_SCALE_SUITES);
const requestedTiers = csvSet(process.env.BENCH_SCALE_TIERS);
const selectedSuites = manifest.suites.filter(
  (suite) =>
    (!requestedSuites.size || requestedSuites.has(suite.id)) &&
    (!requestedTiers.size || requestedTiers.has(suite.tier)),
);
if (!selectedSuites.length) throw new Error("No scale suites selected");
for (const id of requestedSuites) {
  if (!manifest.suites.some((suite) => suite.id === id)) {
    throw new Error(`Unknown BENCH_SCALE_SUITES id: ${id}`);
  }
}

const requestedModes = (
  process.env.BENCH_SCALE_MODES || "bm25,hybrid,neural"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const modes = [...new Set(requestedModes)];
for (const mode of modes) {
  if (!new Set(["bm25", "hybrid", "neural"]).has(mode)) {
    throw new Error(`Unsupported BENCH_SCALE_MODES value: ${mode}`);
  }
}
if (!modes.length && !validateOnly) throw new Error("No scale modes selected");

mkdirSync(outDir, { recursive: true });
const filteredRun = requestedSuites.size > 0 || requestedTiers.size > 0;
const requireFullCoverage =
  process.env.BENCH_SCALE_REQUIRE_FULL_COVERAGE === "1" ||
  (!filteredRun && process.env.BENCH_SCALE_REQUIRE_FULL_COVERAGE !== "0");
const productionProtocol = evaluateScaleProductionProtocol({
  selectedSuiteIds: selectedSuites.map((suite) => suite.id),
  manifestSuiteIds: manifest.suites.map((suite) => suite.id),
  modes: requestedModes,
  repetitions,
  warmups,
  includeColdCli,
  canonicalManifest,
  requireFullCoverage,
  filteredRun,
  validateOnly,
});

let ContextEngine;
let semanticConfig;
let modelPreflight = { required: false, passed: true };
let healthTargets = [];
console.log("Building ContextEngine…");
const build = spawnSync("npm", ["run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
const { walkSourceFiles } = await import(
  pathToFileURL(path.join(repoRoot, "dist/util/fs.js")).href,
);
const { parseExcludeEnv } = await import(
  pathToFileURL(path.join(repoRoot, "dist/indexer/indexer.js")).href,
);
if (!validateOnly) {
  const library = await import(pathToFileURL(path.join(repoRoot, "dist/index.js")).href);
  ContextEngine = library.ContextEngine;
  library.loadDotEnv(repoRoot);
  if (!process.env.CONTEXTENGINE_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error("CONTEXTENGINE_DATABASE_URL or DATABASE_URL is required");
  }
  semanticConfig = captureSemanticConfig();
  modelPreflight = await preflightModels(semanticConfig, modes);
  healthTargets = modelPreflight.healthTargets || [];
}

const suiteResults = [];
for (const [suiteIndex, suite] of selectedSuites.entries()) {
  console.log(
    `\n######## ${suite.id} (${suite.tier}, ${suiteIndex + 1}/${selectedSuites.length}) ########`,
  );
  let clone;
  let suiteResult;
  try {
    clone = ensureClone(suite.clone);
    const sourceRoot = suite.rootSubdir
      ? path.join(clone.root, suite.rootSubdir)
      : clone.root;
    if (!existsSync(sourceRoot)) throw new Error(`source root missing: ${sourceRoot}`);
    const paths = trackedPaths(clone.root, suite.rootSubdir);
    const maxFileBytes = suite.maxFileBytes || 512 * 1024;
    const corpusStats = collectCorpusStats(
      clone.root,
      suite,
      paths,
      maxFileBytes,
      walkIndexableFiles,
    );
    const corpus = corpusStats.summary;
    const tierValidation = validateTier(manifest.tierRules[suite.tier], corpus);
    const cases = JSON.parse(readFileSync(path.resolve(repoRoot, suite.cases), "utf8"));
    const validationPaths = corpusStats.indexablePaths || paths;
    const goldValidation = validateGoldCases(cases, validationPaths, {
      sourceRoot,
      maxFileBytes,
    });
    if (!goldValidation.valid) {
      throw new Error(`gold validation failed: ${goldValidation.errors.join("; ")}`);
    }
    if (!tierValidation.valid) {
      throw new Error(`tier validation failed: ${tierValidation.errors.join("; ")}`);
    }
    console.log(
      `  validated commit=${clone.revision.slice(0, 12)} gold=${cases.length} tracked=${corpus.trackedFiles} indexable=${corpus.indexableFiles ?? "n/a"} bytes=${corpus.indexableBytes ?? corpus.trackedBytes}`,
    );

    suiteResult = {
      id: suite.id,
      tier: suite.tier,
      language: suite.language,
      repository: suite.clone.url,
      revision: clone.revision,
      repositoryState: {
        gitSha: clone.revision,
        expectedGitSha: suite.clone.commit,
        dirty: clone.dirty,
      },
      gold: goldEvidence[suite.id],
      root: sourceRoot,
      corpus,
      tierValidation,
      goldValidation,
      maxFileBytes,
      modes: {},
    };

    if (!validateOnly) {
      let currentIndexKind;
      let currentIndex;
      for (const mode of modes) {
        console.log(`  mode=${mode}`);
        applyModeEnvironment(mode, semanticConfig);
        const requiredIndexKind = mode === "bm25" ? "bm25" : "semantic";
        if (currentIndexKind !== requiredIndexKind) {
          currentIndex = await createIndex({
            ContextEngine,
            root: sourceRoot,
            maxFileBytes,
            kind: requiredIndexKind,
            healthTargets,
          });
          currentIndexKind = requiredIndexKind;
        }
        const index =
          currentIndex.ownerMode === undefined
            ? { ...currentIndex, ownerMode: mode, reused: false }
            : { ...currentIndex, ownerMode: currentIndex.ownerMode, reused: true };
        if (currentIndex.ownerMode === undefined) currentIndex.ownerMode = mode;

        const measured = await runSearchMode({
          ContextEngine,
          root: sourceRoot,
          maxFileBytes,
          cases,
          mode,
          healthTargets,
        });
        const resources = mergeResources(index.resources, measured.resources);
        const result = {
          mode,
          index: {
            filesScanned: index.filesScanned,
            filesIndexed: index.filesIndexed,
            chunksWritten: index.chunksWritten,
            embeddingsWritten: index.embeddingsWritten,
            durationMs: index.durationMs,
            chunksPerSecond: index.chunksPerSecond,
            indexableFiles: corpus.indexableFiles,
            indexableBytes: corpus.indexableBytes,
            sourceMbPerSecond:
              corpus.indexableBytes / 1024 / 1024 / (index.durationMs / 1000),
            generationId: index.generationId,
            hasEmbeddings: index.hasEmbeddings,
            reused: index.reused,
            ownerMode: index.ownerMode,
          },
          retrieval: measured.retrieval,
          latency: measured.latency,
          throughputQueriesPerSecond: measured.throughputQueriesPerSecond,
          coldCli: measured.coldCli,
          degradedChannels: measured.degradedChannels,
          cases: measured.cases,
          resources,
        };
        const thresholds = mergedThresholds(manifest, suite.tier, mode);
        const thresholdGate = evaluateModeThresholds(result, thresholds);
        const failures = [...thresholdGate.failures];
        if (measured.degradedChannels.length) {
          failures.push(`degraded channels: ${measured.degradedChannels.join(",")}`);
        }
        if (requiredIndexKind === "semantic" && !index.hasEmbeddings) {
          failures.push("semantic index has no embeddings");
        }
        if (
          !index.reused &&
          index.filesScanned !== corpus.indexableFiles
        ) {
          failures.push(
            `walker/index scan mismatch ${corpus.indexableFiles}/${index.filesScanned}`,
          );
        }
        if (
          requiredIndexKind === "semantic" &&
          !index.reused &&
          index.embeddingsWritten !== index.chunksWritten
        ) {
          failures.push(
            `embedding mismatch ${index.embeddingsWritten}/${index.chunksWritten}`,
          );
        }
        result.gate = { passed: failures.length === 0, failures, thresholds };
        result.status = result.gate.passed ? "passed" : "failed";
        suiteResult.modes[mode] = result;
        writeModeCheckpoint(suiteResult, mode);
        console.log(
          `    ${result.status} Recall=${result.retrieval.meanRecallAtK.toFixed(3)} MRR=${result.retrieval.meanMrr.toFixed(3)} nDCG=${result.retrieval.meanNdcgAtK.toFixed(3)} P95=${Math.round(result.latency.p95Ms)}ms`,
        );
      }
      suiteResult.rerankerComparison = compareReranker(suiteResult.modes);
      suiteResult.status = modes.every(
        (mode) => suiteResult.modes[mode]?.status === "passed",
      )
        ? "passed"
        : "failed";
    } else {
      suiteResult.status = "passed";
    }
    suiteResults.push(suiteResult);
    writeFileSync(
      path.join(outDir, `scale-${suite.id}.json`),
      JSON.stringify(suiteResult, null, 2),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  suite failed: ${message}`);
    suiteResults.push(
      suiteResult
        ? { ...suiteResult, status: "failed", error: message }
        : {
            id: suite.id,
            tier: suite.tier,
            language: suite.language,
            repository: suite.clone.url,
            revision: clone?.revision || suite.clone.commit,
            repositoryState: {
              gitSha: clone?.revision || null,
              expectedGitSha: suite.clone.commit,
              dirty: clone?.dirty ?? null,
            },
            gold: goldEvidence[suite.id],
            status: "failed",
            error: message,
          },
    );
  }
  writeCheckpoint();
}

const finalReport = buildReport(true);
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(finalReport, null, 2));
if (
  shouldPublishScaleLatest({
    productionEligible: productionProtocol.productionEligible,
    finalGatePassed: finalReport.gate.passed,
  })
) {
  writeFileSync(latestPath, JSON.stringify(finalReport, null, 2));
} else {
  console.log(
    "Production latest was not updated: run is not protocol-eligible or its final gate failed",
  );
}
console.log("\n======== SCALE GATE ========");
console.log(JSON.stringify(finalReport.gate, null, 2));
console.log(`Wrote ${path.join(outDir, "summary.json")}`);
if (!finalReport.gate.passed) process.exitCode = 1;

function buildReport(final) {
  const coverage = coverageSummary(selectedSuites, manifest.suites);
  const suiteGate = evaluateBenchmarkSuites({
    selectedSuiteIds: selectedSuites.map((suite) => suite.id),
    suiteResults,
    isSuccessful: (suite) => suite.status === "passed",
  });
  const macro = validateOnly ? {} : summarizeMacro(suiteResults, modes);
  const macroGate = {};
  for (const [mode, thresholds] of Object.entries(
    validateOnly ? {} : manifest.macroThresholds || {},
  )) {
    if (!modes.includes(mode)) continue;
    const row = macro.byMode?.[mode];
    if (!row) {
      macroGate[mode] = { passed: false, failures: ["mode has no results"] };
      continue;
    }
    macroGate[mode] = evaluateModeThresholds(
      {
        retrieval: row.retrieval,
        latency: row.latency,
        resources: {},
      },
      thresholds,
    );
  }
  const coveragePassed = !requireFullCoverage || coverage.fullCoverage;
  const protocolRequired = requireFullCoverage && !validateOnly;
  const protocolPassed = !protocolRequired || productionProtocol.passed;
  const macroPassed = Object.values(macroGate).every((gate) => gate.passed);
  const gate = {
    passed:
      suiteGate.passed &&
      coveragePassed &&
      protocolPassed &&
      macroPassed &&
      modelPreflight.passed,
    final,
    suites: suiteGate,
    coverage: { ...coverage, required: requireFullCoverage, passed: coveragePassed },
    productionProtocol: {
      ...productionProtocol,
      satisfied: productionProtocol.passed,
      required: protocolRequired,
      gatePassed: protocolPassed,
    },
    macro: macroGate,
    modelPreflightPassed: modelPreflight.passed,
  };
  return {
    meta: {
      benchmark: "ContextEngine multi-scale retrieval and capacity gate",
      runId,
      evaluatedAt: new Date().toISOString(),
      manifest: path.relative(repoRoot, manifestPath),
      canonicalManifest,
      manifestSha256,
      validateOnly,
      modes,
      requestedModes,
      repetitions,
      warmups,
      includeColdCli,
      selectedSuites: selectedSuites.map((suite) => suite.id),
      repository: repositoryState,
      gitTimeoutMs,
      gold: goldEvidence,
      productionLatestEligible: productionProtocol.productionEligible,
      model: modelPreflight.publicConfig || null,
    },
    modelPreflight: sanitizePreflight(modelPreflight),
    coverage,
    macro,
    gate,
    suites: suiteResults,
  };
}

function writeCheckpoint() {
  writeFileSync(
    path.join(outDir, "checkpoint.json"),
    JSON.stringify(buildReport(false), null, 2),
  );
}

function writeModeCheckpoint(suiteResult, mode) {
  writeFileSync(
    path.join(outDir, `checkpoint-${suiteResult.id}-${mode}.json`),
    JSON.stringify(
      {
        meta: {
          benchmark: "ContextEngine multi-scale retrieval and capacity gate",
          runId,
          evaluatedAt: new Date().toISOString(),
          manifestSha256,
          repository: repositoryState,
          gold: suiteResult.gold,
        },
        suite: {
          ...suiteResult,
          modes: { [mode]: suiteResult.modes[mode] },
        },
      },
      null,
      2,
    ),
  );
}

function validateManifest(value) {
  validateScaleManifestSchema(value);
  const ids = new Set();
  for (const suite of value.suites) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(suite.id || "") || ids.has(suite.id)) {
      throw new Error(`duplicate/invalid suite id ${suite.id}`);
    }
    ids.add(suite.id);
    if (!new Set(["small", "medium", "large"]).has(suite.tier)) {
      throw new Error(`suite ${suite.id} has invalid tier`);
    }
    if (!/^https:\/\/github\.com\/.+\.git$/.test(suite.clone?.url || "")) {
      throw new Error(`suite ${suite.id} must use a GitHub HTTPS clone URL`);
    }
    if (!/^[0-9a-f]{40}$/.test(suite.clone?.commit || "")) {
      throw new Error(`suite ${suite.id} must pin a 40-character commit`);
    }
    if (!suite.clone.dir || !suite.cases || !suite.license || !suite.licenseFile) {
      throw new Error(`suite ${suite.id} is missing clone/cases/license metadata`);
    }
    const casesPath = path.resolve(repoRoot, suite.cases);
    const goldRoot = `${path.join(repoRoot, "benchmarks/scale/gold")}${path.sep}`;
    if (!casesPath.startsWith(goldRoot) || path.extname(casesPath) !== ".json") {
      throw new Error(`suite ${suite.id} cases must be under benchmarks/scale/gold`);
    }
    if (
      suite.maxFileBytes !== undefined &&
      (!Number.isInteger(suite.maxFileBytes) ||
        suite.maxFileBytes <= 0 ||
        suite.maxFileBytes > 32 * 1024 * 1024)
    ) {
      throw new Error(`suite ${suite.id} has invalid maxFileBytes`);
    }
  }
}

function ensureClone(spec) {
  const root = path.join(benchRoot, spec.dir);
  mkdirSync(benchRoot, { recursive: true });
  if (!existsSync(path.join(root, ".git"))) {
    mkdirSync(root, { recursive: true });
    runGit(["init", root], benchRoot, true);
    runGit(["remote", "add", "origin", spec.url], root, true);
  }
  assertCleanClone(root);
  const origin = gitOutput(["remote", "get-url", "origin"], root);
  if (origin !== spec.url) {
    throw new Error(`unexpected origin ${origin}; expected ${spec.url}`);
  }
  if (!skipFetch || gitOutput(["rev-parse", "HEAD"], root, true) !== spec.commit) {
    runGit(["fetch", "--depth", "1", "origin", spec.commit], root, true);
    runGit(["checkout", "--detach", spec.commit], root, true);
  }
  const revision = gitOutput(["rev-parse", "HEAD"], root);
  if (revision !== spec.commit) {
    throw new Error(`checked out ${revision}; expected ${spec.commit}`);
  }
  assertCleanClone(root);
  return { root, revision, dirty: false };
}

function runGit(args, cwd, inherit = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : undefined,
    timeout: gitTimeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${gitFailureDetail(result)}`,
    );
  }
  return result;
}

function gitOutput(args, cwd, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: gitTimeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed: ${gitFailureDetail(result)}`);
  }
  return result.stdout.trim();
}

function gitFailureDetail(result) {
  if (result.error?.code === "ETIMEDOUT") {
    return `timed out after ${gitTimeoutMs}ms`;
  }
  const stderr = result.stderr ? String(result.stderr).trim() : "";
  const stdout = result.stdout ? String(result.stdout).trim() : "";
  return (
    result.error?.message ||
    stderr ||
    stdout ||
    `exit=${result.status ?? "none"} signal=${result.signal || "none"}`
  );
}

function assertCleanClone(root) {
  const status = gitOutput(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  if (status) {
    throw new Error(`benchmark clone is dirty: ${root}`);
  }
}

function captureRepositoryState(root) {
  return {
    gitSha: gitOutput(["rev-parse", "HEAD"], root),
    dirty: Boolean(
      gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], root),
    ),
  };
}

function collectGoldEvidence(value) {
  return Object.fromEntries(
    value.suites.map((suite) => {
      const absolute = path.resolve(repoRoot, suite.cases);
      return [
        suite.id,
        {
          path: path.relative(repoRoot, absolute).split(path.sep).join("/"),
          sha256: sha256(readFileSync(absolute)),
        },
      ];
    }),
  );
}

function trackedPaths(cloneRoot, rootSubdir) {
  const args = ["ls-files", "-z"];
  if (rootSubdir) args.push("--", rootSubdir);
  const result = spawnSync("git", args, {
    cwd: cloneRoot,
    encoding: "buffer",
    timeout: gitTimeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${gitFailureDetail(result)}`);
  }
  const prefix = rootSubdir ? `${rootSubdir.replace(/\/+$/, "")}/` : "";
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file));
}

function collectCorpusStats(
  cloneRoot,
  suite,
  paths,
  maxFileBytes,
  canonicalWalker,
) {
  const sourceRoot = suite.rootSubdir
    ? path.join(cloneRoot, suite.rootSubdir)
    : cloneRoot;
  let trackedBytes = 0;
  let presentFiles = 0;
  for (const relative of paths) {
    try {
      const stat = statSync(path.join(sourceRoot, relative));
      if (stat.isFile()) {
        presentFiles += 1;
        trackedBytes += stat.size;
      }
    } catch {
      // Symlinks or platform-specific paths remain in trackedFiles but not bytes.
    }
  }
  const licensePath = path.join(cloneRoot, suite.licenseFile);
  if (!existsSync(licensePath)) throw new Error(`license file missing: ${suite.licenseFile}`);
  const indexable = canonicalWalker
    ? canonicalWalker(sourceRoot, maxFileBytes)
    : null;
  return {
    indexablePaths: indexable?.map((file) => file.relPath) || null,
    summary: {
      trackedFiles: paths.length,
      presentFiles,
      trackedBytes,
      indexableFiles: indexable?.length ?? null,
      indexableBytes:
        indexable?.reduce((total, file) => total + file.size, 0) ?? null,
      indexableWalker: indexable ? "ContextEngine walkSourceFiles" : null,
      license: suite.license,
      licenseFile: suite.licenseFile,
      licenseSha256: sha256(readFileSync(licensePath)),
    },
  };
}

function walkIndexableFiles(root, maxFileBytes) {
  return walkSourceFiles(root, maxFileBytes, {
    extraIgnores: parseExcludeEnv(),
  });
}

function validateTier(rule, corpus) {
  const errors = [];
  if (!Number.isFinite(corpus.indexableBytes)) {
    errors.push("indexable byte count is unavailable");
    return { valid: false, rule, errors };
  }
  if (
    rule.minIndexableBytes &&
    corpus.indexableBytes < rule.minIndexableBytes
  ) {
    errors.push(
      `${corpus.indexableBytes} indexable bytes below ${rule.minIndexableBytes}`,
    );
  }
  if (
    rule.maxIndexableBytes &&
    corpus.indexableBytes > rule.maxIndexableBytes
  ) {
    errors.push(
      `${corpus.indexableBytes} indexable bytes above ${rule.maxIndexableBytes}`,
    );
  }
  return { valid: errors.length === 0, rule, errors };
}

async function createIndex({
  ContextEngine,
  root,
  maxFileBytes,
  kind,
  healthTargets,
}) {
  const cleanup = ContextEngine.open({ root, maxFileBytes });
  try {
    await cleanup.clearIndex();
  } finally {
    await cleanup.close();
  }
  const engine = ContextEngine.open({ root, maxFileBytes });
  const monitor = startResourceMonitor(healthTargets);
  const started = performance.now();
  try {
    const result = await engine.index();
    const durationMs = performance.now() - started;
    const stats = await engine.stats();
    const resources = await monitor.stop();
    return {
      ...result,
      durationMs,
      chunksPerSecond: result.chunksWritten / Math.max(0.001, durationMs / 1000),
      hasEmbeddings: stats.hasEmbeddings,
      kind,
      resources,
    };
  } catch (error) {
    await monitor.stop();
    throw error;
  } finally {
    await engine.close();
  }
}

async function runSearchMode({
  ContextEngine,
  root,
  maxFileBytes,
  cases,
  mode,
  healthTargets,
}) {
  const engine = ContextEngine.open({ root, maxFileBytes });
  const monitor = startResourceMonitor(healthTargets);
  const modeOption = mode === "bm25" ? "bm25" : "hybrid";
  const searchOptions = (entry) => ({
    query: entry.query,
    topK: entry.topK || 10,
    mode: modeOption,
    neuralRerank: mode === "neural",
  });
  const degraded = new Set();
  const caseRows = [];
  const latencySamples = [];
  let resources;
  try {
    for (let iteration = 0; iteration < warmups; iteration += 1) {
      for (const entry of cases) await engine.search(searchOptions(entry));
    }
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const entry of cases) {
        const started = performance.now();
        const hits = await engine.search(searchOptions(entry));
        const elapsed = performance.now() - started;
        latencySamples.push(elapsed);
        for (const hit of hits) {
          for (const channel of hit.degradedChannels || []) degraded.add(channel);
        }
        if (repetition === 0) {
          const paths = hits.map((hit) => hit.chunk?.path || "").filter(Boolean);
          caseRows.push({
            id: entry.id,
            query: entry.query,
            expectPaths: entry.expectPaths,
            hardNegativePaths: entry.hardNegativePaths || [],
            hitPaths: paths.slice(0, entry.topK || 10),
            ...evaluateRetrievalCase(paths, entry, entry.topK || 10),
          });
        }
      }
    }
  } finally {
    await engine.close();
    resources = await monitor.stop();
  }
  const latency = summarizeLatency(latencySamples);
  latency.samplesMs = latencySamples;
  let coldCli = null;
  if (includeColdCli) {
    const rows = cases.map((entry) => ({
      id: entry.id,
      ...runColdCli(root, entry, mode),
    }));
    const durations = rows.map((row) => row.durationMs);
    coldCli = {
      ...summarizeLatency(durations),
      samplesMs: durations,
      cases: rows,
    };
  }
  return {
    retrieval: summarizeRetrievalCases(caseRows),
    latency,
    throughputQueriesPerSecond:
      latencySamples.length /
      Math.max(0.001, latencySamples.reduce((sum, value) => sum + value, 0) / 1000),
    coldCli,
    degradedChannels: [...degraded].sort(),
    cases: caseRows,
    resources,
  };
}

function runColdCli(root, entry, mode) {
  const started = performance.now();
  const result = spawnSync(
    "node",
    [
      path.join(repoRoot, "dist/cli.js"),
      "search",
      entry.query,
      "--root",
      root,
      "-k",
      String(entry.topK || 10),
      "--mode",
      mode === "bm25" ? "bm25" : "hybrid",
      "--json",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: positiveInteger(process.env.BENCH_SCALE_CLI_TIMEOUT_MS, 120_000),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const durationMs = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(
      `cold CLI failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}`,
    );
  }
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("cold CLI returned invalid JSON search results");
  }
  return { durationMs, exitCode: result.status, resultCount: parsed.length };
}

function startResourceMonitor(healthTargets) {
  let peakLocalRssMb = process.memoryUsage().rss / 1024 / 1024;
  let localRssSamples = 1;
  const remoteTargets = healthTargets.map((target) => ({
    ...target,
    peakVramGb: null,
    samples: 0,
    inFlight: undefined,
  }));
  const cpuStarted = process.cpuUsage();
  const sampleTarget = (target) => {
    if (target.inFlight) return target.inFlight;
    target.inFlight = fetch(target.healthUrl, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => {
        const vramGb = parseNonNegativeMetric(health?.vram_alloc_gb);
        if (vramGb === null) return;
        target.samples += 1;
        target.peakVramGb = Math.max(target.peakVramGb ?? 0, vramGb);
      })
      .catch(() => undefined)
      .finally(() => {
        target.inFlight = undefined;
      });
    return target.inFlight;
  };
  const sample = async () => {
    peakLocalRssMb = Math.max(peakLocalRssMb, process.memoryUsage().rss / 1024 / 1024);
    localRssSamples += 1;
    await Promise.all(remoteTargets.map(sampleTarget));
  };
  void sample();
  const interval = setInterval(() => void sample(), 750);
  interval.unref();
  return {
    async stop() {
      clearInterval(interval);
      await sample();
      const cpu = process.cpuUsage(cpuStarted);
      const remoteServices = remoteTargets.map((target) => ({
        healthUrl: target.healthUrl,
        roles: target.roles,
        peakVramGb: target.peakVramGb,
        samples: target.samples,
      }));
      const remotePeaks = remoteServices
        .map((target) => target.peakVramGb)
        .filter((value) => Number.isFinite(value));
      return {
        peakLocalRssMb,
        peakRemoteVramGb: remotePeaks.length
          ? remotePeaks.reduce((sum, value) => sum + value, 0)
          : null,
        localRssSamples,
        remoteVramSamples: remoteServices.reduce(
          (sum, target) => sum + target.samples,
          0,
        ),
        remoteTargetCount: remoteServices.length,
        remoteCoveragePassed:
          remoteServices.length > 0 &&
          remoteServices.every((target) => target.samples > 0),
        remoteServices,
        localCpuMs: (cpu.user + cpu.system) / 1000,
      };
    },
  };
}

function mergeResources(...rows) {
  const present = rows.filter(Boolean);
  const localRss = present
    .map((row) => row.peakLocalRssMb)
    .filter((value) => Number.isFinite(value));
  const services = new Map();
  for (const row of present) {
    for (const target of row.remoteServices || []) {
      const current = services.get(target.healthUrl) || {
        healthUrl: target.healthUrl,
        roles: new Set(),
        peakVramGb: null,
        samples: 0,
      };
      for (const role of target.roles || []) current.roles.add(role);
      if (Number.isFinite(target.peakVramGb)) {
        current.peakVramGb = Math.max(
          current.peakVramGb ?? 0,
          target.peakVramGb,
        );
      }
      current.samples += target.samples || 0;
      services.set(target.healthUrl, current);
    }
  }
  const remoteServices = [...services.values()].map((target) => ({
    ...target,
    roles: [...target.roles].sort(),
  }));
  const remoteVram = remoteServices
    .map((target) => target.peakVramGb)
    .filter((value) => Number.isFinite(value));
  return {
    peakLocalRssMb: localRss.length ? Math.max(...localRss) : null,
    peakRemoteVramGb: remoteVram.length
      ? remoteVram.reduce((sum, value) => sum + value, 0)
      : null,
    localRssSamples: present.reduce(
      (sum, row) => sum + (row.localRssSamples || 0),
      0,
    ),
    remoteVramSamples: remoteServices.reduce(
      (sum, target) => sum + target.samples,
      0,
    ),
    remoteTargetCount: remoteServices.length,
    remoteCoveragePassed:
      remoteServices.length > 0 &&
      remoteServices.every((target) => target.samples > 0),
    remoteServices,
    localCpuMs: present.reduce((sum, row) => sum + (row.localCpuMs || 0), 0),
  };
}

function captureSemanticConfig() {
  const keys = [
    "CONTEXTENGINE_EMBEDDING_API_KEY",
    "CONTEXTENGINE_EMBEDDING_BASE_URL",
    "CONTEXTENGINE_EMBEDDING_MODEL",
    "CONTEXTENGINE_RERANK_API_KEY",
    "CONTEXTENGINE_RERANK_BASE_URL",
    "CONTEXTENGINE_RERANK_MODEL",
    "CONTEXTENGINE_RERANK_INSTRUCTION",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_EMBEDDING_MODEL",
    "OPENAI_RERANK_MODEL",
    "EMBEDDING_API_KEY",
  ];
  return {
    env: Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    embeddingKey:
      process.env.CONTEXTENGINE_EMBEDDING_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.EMBEDDING_API_KEY?.trim(),
    embeddingBase:
      process.env.CONTEXTENGINE_EMBEDDING_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim(),
    embeddingModel:
      process.env.CONTEXTENGINE_EMBEDDING_MODEL ||
      process.env.OPENAI_EMBEDDING_MODEL ||
      "text-embedding-3-small",
    rerankKey:
      process.env.CONTEXTENGINE_RERANK_API_KEY?.trim() ||
      process.env.CONTEXTENGINE_EMBEDDING_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim(),
    rerankBase:
      process.env.CONTEXTENGINE_RERANK_BASE_URL?.trim() ||
      process.env.CONTEXTENGINE_EMBEDDING_BASE_URL?.trim() ||
      process.env.OPENAI_BASE_URL?.trim(),
    rerankModel:
      process.env.CONTEXTENGINE_RERANK_MODEL ||
      process.env.OPENAI_RERANK_MODEL ||
      "Qwen/Qwen3-Reranker-0.6B",
  };
}

function applyModeEnvironment(mode, config) {
  for (const [key, value] of Object.entries(config.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (mode === "bm25") {
    for (const key of [
      "CONTEXTENGINE_EMBEDDING_API_KEY",
      "CONTEXTENGINE_EMBEDDING_BASE_URL",
      "CONTEXTENGINE_RERANK_API_KEY",
      "CONTEXTENGINE_RERANK_BASE_URL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "EMBEDDING_API_KEY",
    ]) {
      process.env[key] = "";
    }
  }
  process.env.CONTEXTENGINE_NEURAL_RERANK = mode === "neural" ? "1" : "0";
}

async function preflightModels(config, selectedModes) {
  const required = selectedModes.some((mode) => mode !== "bm25");
  if (!required) return { required, passed: true, healthTargets: [] };
  if (!config.embeddingKey || !config.embeddingBase) {
    throw new Error("hybrid/neural modes require embedding API key and base URL");
  }
  const embeddingBase = normalizeBase(config.embeddingBase);
  const embeddingHealthUrl = healthFromBase(embeddingBase);
  const embeddingHealth = await fetchJson(embeddingHealthUrl);
  if (!embeddingHealth.embed_loaded) {
    throw new Error("embedding health did not report embed_loaded");
  }
  const rawHealthTargets = [
    { role: "embedding", healthUrl: embeddingHealthUrl },
  ];
  const embedding = await fetchJson(`${embeddingBase}/embeddings`, {
    key: config.embeddingKey,
    body: { model: config.embeddingModel, input: "code retrieval scale preflight" },
  });
  const dimension = embedding.data?.[0]?.embedding?.length;
  if (!dimension) throw new Error("embedding preflight returned no vector");
  let rerank = null;
  let rerankBase = null;
  let rerankHealth = null;
  if (selectedModes.includes("neural")) {
    if (!config.rerankKey || !config.rerankBase) {
      throw new Error("neural mode requires rerank API key and base URL");
    }
    rerankBase = normalizeBase(config.rerankBase);
    const rerankHealthUrl = healthFromBase(rerankBase);
    rerankHealth =
      rerankHealthUrl === embeddingHealthUrl
        ? embeddingHealth
        : await fetchJson(rerankHealthUrl);
    if (!rerankHealth.rerank_loaded) {
      throw new Error("reranker health did not report rerank_loaded");
    }
    rawHealthTargets.push({ role: "reranker", healthUrl: rerankHealthUrl });
    const response = await fetchJson(`${rerankBase}/rerank`, {
      key: config.rerankKey,
      body: {
        model: config.rerankModel,
        query: "find the authentication implementation",
        documents: ["authentication middleware", "CSS color utility"],
        top_n: 2,
      },
    });
    const scores = (response.results || []).map((row) => Number(row.relevance_score));
    if (scores.length !== 2 || new Set(scores.map((score) => score.toFixed(8))).size < 2) {
      throw new Error("rerank preflight did not produce meaningful score spread");
    }
    rerank = { scores, model: config.rerankModel };
  }
  return {
    required,
    passed: true,
    healthTargets: groupResourceHealthTargets(rawHealthTargets),
    health: {
      embedding: embeddingHealth,
      reranker: rerankHealth,
    },
    embedding: { dimension, model: config.embeddingModel },
    rerank,
    publicConfig: {
      embeddingBase,
      embeddingModel: config.embeddingModel,
      rerankBase,
      rerankModel: config.rerankModel,
    },
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.body ? "POST" : "GET",
    headers: {
      ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function normalizeBase(raw) {
  const value = raw.replace(/\/+$/, "");
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

function healthFromBase(base) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "/health");
  url.search = "";
  return url.toString();
}

function sanitizePreflight(preflight) {
  if (!preflight.required) return { required: false, passed: preflight.passed };
  return {
    required: true,
    passed: preflight.passed,
    healthTargets: preflight.healthTargets,
    health: preflight.health,
    embedding: preflight.embedding,
    rerank: preflight.rerank,
  };
}

function mergedThresholds(value, tier, mode) {
  return {
    ...(value.thresholds?.defaults || {}),
    ...(value.thresholds?.tiers?.[tier] || {}),
    ...(value.thresholds?.modes?.[mode] || {}),
  };
}

function compareReranker(modeRows) {
  const hybrid = modeRows.hybrid;
  const neural = modeRows.neural;
  if (!hybrid || !neural) return null;
  const delta = {
    recallAtK:
      neural.retrieval.meanRecallAtK - hybrid.retrieval.meanRecallAtK,
    mrr: neural.retrieval.meanMrr - hybrid.retrieval.meanMrr,
    ndcgAtK:
      neural.retrieval.meanNdcgAtK - hybrid.retrieval.meanNdcgAtK,
    top5: neural.retrieval.top5Accuracy - hybrid.retrieval.top5Accuracy,
    p95Ms: neural.latency.p95Ms - hybrid.latency.p95Ms,
  };
  const nonRegressing = [delta.recallAtK, delta.mrr, delta.ndcgAtK, delta.top5].every(
    (value) => value >= -0.01,
  );
  const hasQualityGain =
    delta.recallAtK > 0.005 || delta.mrr > 0.005 || delta.ndcgAtK > 0.005;
  return {
    delta,
    nonRegressing,
    hasQualityGain,
    recommendation:
      nonRegressing && hasQualityGain ? "candidate-for-default" : "keep-opt-in",
  };
}

function summarizeMacro(results, selectedModes) {
  const byMode = {};
  for (const mode of selectedModes) {
    const rows = results.map((suite) => suite.modes?.[mode]).filter(Boolean);
    if (!rows.length) continue;
    const mean = (selector) =>
      rows.reduce((sum, row) => sum + selector(row), 0) / rows.length;
    const latencySamples = rows.flatMap((row) => row.latency.samplesMs || []);
    byMode[mode] = {
      suites: rows.length,
      retrieval: {
        meanRecallAtK: mean((row) => row.retrieval.meanRecallAtK),
        meanMrr: mean((row) => row.retrieval.meanMrr),
        meanNdcgAtK: mean((row) => row.retrieval.meanNdcgAtK),
        top1Accuracy: mean((row) => row.retrieval.top1Accuracy),
        top3Accuracy: mean((row) => row.retrieval.top3Accuracy),
        top5Accuracy: mean((row) => row.retrieval.top5Accuracy),
        hardNegativeTop1Rate: mean(
          (row) => row.retrieval.hardNegativeTop1Rate,
        ),
        hardNegativeAtKRate: mean((row) => row.retrieval.hardNegativeAtKRate),
      },
      latency: summarizeLatency(latencySamples),
      throughputQueriesPerSecond: mean(
        (row) => row.throughputQueriesPerSecond,
      ),
    };
  }
  return { byMode };
}

function coverageSummary(selected, all) {
  const count = (rows, tier) => rows.filter((suite) => suite.tier === tier).length;
  const selectedCounts = {
    small: count(selected, "small"),
    medium: count(selected, "medium"),
    large: count(selected, "large"),
  };
  const available = {
    small: count(all, "small"),
    medium: count(all, "medium"),
    large: count(all, "large"),
  };
  const exact = summarizeSuiteCoverage(
    selected.map((suite) => suite.id),
    all.map((suite) => suite.id),
  );
  return {
    selected: selectedCounts,
    available,
    ...exact,
  };
}

function parseJson(text) {
  const indices = [text.indexOf("["), text.indexOf("{")].filter((index) => index >= 0);
  if (!indices.length) return null;
  try {
    return JSON.parse(text.slice(Math.min(...indices)));
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function csvSet(value) {
  return new Set(
    (value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

function configuredInteger(value, fallback, minimum, name) {
  if (value === undefined || value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return number;
}

function configuredBoolean(value, fallback, name) {
  if (value === undefined || value.trim() === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  throw new Error(`${name} must be a boolean value`);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
