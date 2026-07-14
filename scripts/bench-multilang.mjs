#!/usr/bin/env node
/**
 * Multi-language semantic retrieval benchmark.
 *
 * Clones mainstream-language repos, indexes with optional embeddings,
 * runs gold-path eval cases, writes eval-results/multilang-summary.json.
 *
 * Usage:
 *   # with embeddings (recommended):
 *   export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
 *   export OPENAI_API_KEY=ce-local-key
 *   export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
 *   node scripts/bench-multilang.mjs
 *
 *   BENCH_ROOT=/tmp/ce-bench-ml node scripts/bench-multilang.mjs
 *   BENCH_SUITES=got-ts,requests-py node scripts/bench-multilang.mjs
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const benchRoot = process.env.BENCH_ROOT || "/tmp/ce-bench-ml";
const outDir = process.env.BENCH_OUT_DIR || path.join(repoRoot, "eval-results");
const cli = path.join(repoRoot, "dist/cli.js");
const embeddingApiKey =
  process.env.CONTEXTENGINE_EMBEDDING_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.EMBEDDING_API_KEY;
const embeddingApiBase =
  process.env.CONTEXTENGINE_EMBEDDING_BASE_URL ||
  process.env.OPENAI_BASE_URL;
const embeddingModel =
  process.env.CONTEXTENGINE_EMBEDDING_MODEL ||
  process.env.OPENAI_EMBEDDING_MODEL ||
  "Qwen/Qwen3-Embedding-0.6B";

function truthy(value) {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

/** @type {Array<{id:string,lang:string,clone:{url:string,dir:string,ref?:string},cases:string,pathPrefix?:string,rootSubdir?:string}>} */
const suites = [
  {
    id: "got-ts",
    lang: "typescript",
    clone: {
      url: "https://github.com/sindresorhus/got.git",
      dir: "got",
      ref: "v14.4.5",
    },
    cases: "examples/eval.got.json",
  },
  {
    id: "express-js",
    lang: "javascript",
    clone: {
      url: "https://github.com/expressjs/express.git",
      dir: "express",
      ref: "4.21.2",
    },
    cases: "examples/eval.express.json",
  },
  {
    id: "gin-go",
    lang: "go",
    clone: {
      url: "https://github.com/gin-gonic/gin.git",
      dir: "gin",
      ref: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    },
    cases: "examples/eval.gin.json",
  },
  {
    id: "cobra-go",
    lang: "go",
    clone: {
      url: "https://github.com/spf13/cobra.git",
      dir: "cobra",
      ref: "adbc8813901bba65827259daa8e22ff94ec1f30e",
    },
    cases: "examples/eval.cobra.json",
  },
  {
    id: "requests-py",
    lang: "python",
    clone: {
      url: "https://github.com/psf/requests.git",
      dir: "requests",
      ref: "f361ead047be5cb873174218582f7d8b9fcd9f49",
    },
    cases: "examples/eval.requests.json",
    rootSubdir: "src/requests",
  },
  {
    id: "redis-c",
    lang: "c",
    clone: {
      url: "https://github.com/redis/redis.git",
      dir: "redis",
      ref: "7.2.5",
    },
    cases: "examples/eval.redis.json",
    rootSubdir: "src",
  },
  {
    id: "leveldb-cpp",
    lang: "cpp",
    clone: {
      url: "https://github.com/google/leveldb.git",
      dir: "leveldb",
      ref: "7ee830d02b623e8ffe0b95d59a74db1e58da04c5",
    },
    cases: "examples/eval.leveldb.json",
  },
  {
    id: "guava-java",
    lang: "java",
    clone: {
      url: "https://github.com/google/guava.git",
      dir: "guava",
      ref: "v33.3.1",
    },
    cases: "examples/eval.guava.json",
    rootSubdir: "guava/src",
  },
  {
    id: "okhttp-kotlin",
    lang: "kotlin",
    clone: {
      url: "https://github.com/square/okhttp.git",
      dir: "okhttp",
      ref: "63e3caa7c7248fa38af7ba3375470446e2fb5574",
    },
    cases: "examples/eval.okhttp.json",
    // Main library sources only (avoid jvmTest noise)
    rootSubdir: "okhttp/src/commonJvmAndroid",
  },
  {
    id: "axum-rust",
    lang: "rust",
    clone: {
      url: "https://github.com/tokio-rs/axum.git",
      dir: "axum-repo",
      ref: "b859fc0aec43aaad143b2a8e0bdf3b84efc2e056",
    },
    cases: "examples/eval.axum.json",
    rootSubdir: "axum/src",
  },
];

const requestedSuites = new Set(
  (process.env.BENCH_SUITES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const requestedLanguages = new Set(
  (process.env.BENCH_LANGUAGES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const selectedSuites = suites.filter(
  (suite) =>
    (requestedSuites.size === 0 || requestedSuites.has(suite.id)) &&
    (requestedLanguages.size === 0 || requestedLanguages.has(suite.lang)),
);
if (!selectedSuites.length) {
  throw new Error("No benchmark suites match BENCH_SUITES/BENCH_LANGUAGES");
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function gitOutput(args, cwd) {
  return runGit(args, cwd).stdout.trim();
}

function ensureClone(spec) {
  if (!spec.ref) {
    throw new Error(`suite clone must use an immutable ref: ${spec.url}`);
  }
  const dest = path.join(benchRoot, spec.dir);
  mkdirSync(benchRoot, { recursive: true });
  if (!existsSync(dest)) {
    console.log(`Initializing ${spec.url} → ${dest}`);
    runGit(["init", dest], benchRoot, { stdio: "inherit" });
    runGit(["remote", "add", "origin", spec.url], dest, { stdio: "inherit" });
  }

  const remote = gitOutput(["remote", "get-url", "origin"], dest);
  if (remote !== spec.url) {
    throw new Error(
      `existing benchmark clone has unexpected origin: ${remote} (expected ${spec.url})`,
    );
  }

  console.log(`  pin ${spec.ref}`);
  runGit(["fetch", "--depth", "1", "origin", spec.ref], dest, {
    stdio: "inherit",
  });
  const target = gitOutput(["rev-parse", "FETCH_HEAD^{commit}"], dest);
  if (revisionFor(dest) !== target) {
    runGit(["checkout", "--detach", target], dest, { stdio: "inherit" });
  }
  return { root: dest, revision: target };
}

function runCli(args, cwd) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function revisionFor(root) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function trackedPaths(cloneRoot, rootSubdir) {
  const all = gitOutput(["ls-files", "--full-name"], cloneRoot)
    .split("\n")
    .filter(Boolean);
  if (!rootSubdir) return all;
  const prefix = `${rootSubdir.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  return all
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
}

function validateGoldCases(cases, sourcePaths) {
  if (!Array.isArray(cases)) {
    return {
      valid: false,
      cases: 0,
      trackedPaths: sourcePaths.length,
      errors: ["gold case file must contain a JSON array"],
    };
  }
  const errors = [];
  const ids = new Set();
  for (const [index, entry] of cases.entries()) {
    const label = `case[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: expected an object`);
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      errors.push(`${label}: missing non-empty id`);
    } else if (ids.has(entry.id)) {
      errors.push(`${label}: duplicate id "${entry.id}"`);
    } else {
      ids.add(entry.id);
    }
    if (typeof entry.query !== "string" || !entry.query.trim()) {
      errors.push(`${label}: missing non-empty query`);
    }
    if (
      !Array.isArray(entry.expectPaths) ||
      entry.expectPaths.length === 0 ||
      entry.expectPaths.some(
        (expected) => typeof expected !== "string" || !expected.trim(),
      )
    ) {
      errors.push(`${label}: expectPaths must be a non-empty string array`);
      continue;
    }
    for (const expected of entry.expectPaths) {
      if (!sourcePaths.some((file) => file.includes(expected))) {
        errors.push(`${label}: gold path "${expected}" is absent at this revision`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    cases: cases.length,
    trackedPaths: sourcePaths.length,
    errors,
  };
}

function parseJsonBlob(text) {
  for (const ch of ["{", "["]) {
    const i = text.indexOf(ch);
    if (i >= 0) {
      try {
        return JSON.parse(text.slice(i));
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

function mrr(paths, expect) {
  for (let i = 0; i < paths.length; i++) {
    if (expect.some((e) => paths[i].includes(e))) return 1 / (i + 1);
  }
  return 0;
}
function recall(paths, expect) {
  if (!expect.length) return 0;
  let h = 0;
  for (const e of expect) if (paths.some((p) => p.includes(e))) h++;
  return h / expect.length;
}
function ndcg(paths, expect, k) {
  const rels = paths.slice(0, k).map((p) =>
    expect.some((e) => p.includes(e)) ? 1 : 0,
  );
  const dcg = rels.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
  const ideal = Array(Math.min(expect.length, k)).fill(1);
  const idcg = ideal.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
  return idcg <= 0 ? 0 : Math.min(1, dcg / idcg);
}

console.log("Building…");
const build = spawnSync("npm", ["run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

let preflight = {
  attempted: false,
  embeddingReady: false,
  rerankReady: false,
};
let hasEmbed = Boolean(embeddingApiKey && embeddingApiBase);
const neuralRerankEnabled = truthy(process.env.CONTEXTENGINE_NEURAL_RERANK);
if (hasEmbed && process.env.BENCH_API_PREFLIGHT === "0") {
  preflight.embeddingReady = true;
}
if (hasEmbed && process.env.BENCH_API_PREFLIGHT !== "0") {
  preflight.attempted = true;
  try {
    const { apiOriginFromBaseUrl, normalizeOpenAIBaseUrl, openAIEndpoint } =
      await import(
        pathToFileURL(path.join(repoRoot, "dist/util/api-url.js")).href
      );
    const { requestJson } = await import(
      pathToFileURL(path.join(repoRoot, "dist/util/http-json.js")).href
    );
    const { isEmbeddingReady } = await import(
      pathToFileURL(path.join(repoRoot, "dist/util/model-health.js")).href
    );
    const base = normalizeOpenAIBaseUrl(embeddingApiBase);
    const health = await requestJson(`${apiOriginFromBaseUrl(base)}/health`, {
      label: "Benchmark model health check",
      timeoutMs: 15_000,
      retries: 0,
    });
    if (!isEmbeddingReady(health)) {
      throw new Error("health response did not report a loaded embedder");
    }
    await requestJson(openAIEndpoint(base, "embeddings"), {
      label: "Benchmark embedding preflight",
      apiKey: embeddingApiKey,
      body: { model: embeddingModel, input: "semantic code retrieval preflight" },
    });
    preflight.embeddingReady = true;

    if (neuralRerankEnabled) {
      const rerankBase =
        process.env.CONTEXTENGINE_RERANK_BASE_URL || embeddingApiBase;
      const rerankKey =
        process.env.CONTEXTENGINE_RERANK_API_KEY || embeddingApiKey;
      const rerankModel =
        process.env.CONTEXTENGINE_RERANK_MODEL ||
        process.env.OPENAI_RERANK_MODEL ||
        "Qwen/Qwen3-Reranker-0.6B";
      const rerankInstruction =
        process.env.CONTEXTENGINE_RERANK_INSTRUCTION?.trim();
      const rerank = await requestJson(
        openAIEndpoint(normalizeOpenAIBaseUrl(rerankBase), "rerank"),
        {
          label: "Benchmark rerank preflight",
          apiKey: rerankKey,
          body: {
            model: rerankModel,
            query: "find authentication",
            documents: ["authentication middleware", "image utility"],
            top_n: 2,
            ...(rerankInstruction ? { instruction: rerankInstruction } : {}),
          },
        },
      );
      if (!Array.isArray(rerank.results) || rerank.results.length === 0) {
        throw new Error("rerank response contained no results");
      }
      preflight.rerankReady = true;
    }
  } catch (error) {
    console.error(
      `Remote benchmark preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
console.log(
  hasEmbed
    ? `Embeddings: ON model=${embeddingModel} base=${embeddingApiBase}`
    : "Embeddings: OFF (BM25/features only)",
);
if (neuralRerankEnabled) {
  console.log(
    `Neural rerank: ${preflight.rerankReady ? "ON" : "requested but not preflighted"}`,
  );
}

const suiteResults = [];

for (const suite of selectedSuites) {
  console.log(`\n######## ${suite.id} (${suite.lang}) ########`);
  let cloneRoot;
  let revision;
  try {
    ({ root: cloneRoot, revision } = ensureClone(suite.clone));
  } catch (e) {
    console.error("clone failed", e);
    suiteResults.push({
      id: suite.id,
      lang: suite.lang,
      error: String(e),
    });
    continue;
  }

  const root = suite.rootSubdir
    ? path.join(cloneRoot, suite.rootSubdir)
    : cloneRoot;
  if (!existsSync(root)) {
    console.error(`root missing: ${root}`);
    suiteResults.push({
      id: suite.id,
      lang: suite.lang,
      error: `root missing ${root}`,
    });
    continue;
  }

  let cases;
  try {
    cases = JSON.parse(readFileSync(path.join(repoRoot, suite.cases), "utf8"));
  } catch (error) {
    const message = `could not read gold cases: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    suiteResults.push({
      id: suite.id,
      lang: suite.lang,
      revision,
      error: message,
    });
    continue;
  }
  const goldValidation = validateGoldCases(
    cases,
    trackedPaths(cloneRoot, suite.rootSubdir),
  );
  if (!goldValidation.valid) {
    const error = `gold validation failed: ${goldValidation.errors.join("; ")}`;
    console.error(error);
    suiteResults.push({
      id: suite.id,
      lang: suite.lang,
      revision,
      goldValidation,
      error,
    });
    continue;
  }
  console.log(
    `  gold validated: ${goldValidation.cases} cases against ${goldValidation.trackedPaths} tracked paths`,
  );

  // Clean this workspace namespace in PostgreSQL for a fair re-embed.
  const clear = runCli(["clear-index", "--root", root], repoRoot);
  if (clear.status !== 0) {
    const error = (clear.stderr || clear.stdout || `clear-index exited ${clear.status}`)
      .trim()
      .slice(0, 1000);
    console.error(`clear-index failed: ${error}`);
    suiteResults.push({ id: suite.id, lang: suite.lang, error });
    continue;
  }

  const t0 = performance.now();
  const idx = runCli(["index", root, "--quiet"], repoRoot);
  const indexMs = performance.now() - t0;
  const idxJson = parseJsonBlob(idx.stdout) || {};
  if (idx.status !== 0) {
    const error = (idx.stderr || idx.stdout || `index exited ${idx.status}`)
      .trim()
      .slice(0, 1000);
    console.error(`index failed: ${error}`);
    suiteResults.push({ id: suite.id, lang: suite.lang, error });
    continue;
  }
  if (
    hasEmbed &&
    Number(idxJson.chunksWritten || 0) > 0 &&
    Number(idxJson.embeddingsWritten || 0) !== Number(idxJson.chunksWritten)
  ) {
    const error = `embedding count mismatch: chunks=${idxJson.chunksWritten} embeddings=${idxJson.embeddingsWritten}`;
    console.error(error);
    suiteResults.push({ id: suite.id, lang: suite.lang, error });
    continue;
  }
  console.log(
    `  indexed files=${idxJson.filesScanned ?? "?"} chunks+=${idxJson.chunksWritten ?? "?"} embeds+=${idxJson.embeddingsWritten ?? "?"} (${Math.round(indexMs)}ms)`,
  );

  const caseRows = [];
  let searchMs = 0;

  for (const c of cases) {
    const k = c.topK ?? 8;
    const s0 = performance.now();
    const args = [
      "search",
      c.query,
      "--root",
      root,
      "-k",
      String(k),
      "--mode",
      "auto",
      "--json",
    ];
    if (suite.pathPrefix) {
      args.push("--path-prefix", suite.pathPrefix);
    }
    const sr = runCli(args, repoRoot);
    searchMs += performance.now() - s0;
    if (sr.status !== 0) {
      const error = (sr.stderr || sr.stdout || `search exited ${sr.status}`)
        .trim()
        .slice(0, 1000);
      console.error(`  search failed for ${c.id}: ${error}`);
      caseRows.push({
        id: c.id,
        query: c.query,
        expectPaths: c.expectPaths || [],
        error,
      });
      continue;
    }
    const hits = parseJsonBlob(sr.stdout) || [];
    const paths = hits.map((h) => h.chunk?.path || "").filter(Boolean);
    const expect = c.expectPaths || [];
    const row = {
      id: c.id,
      query: c.query,
      expectPaths: expect,
      top1: paths[0] || null,
      hitPaths: paths.slice(0, k),
      recallAtK: recall(paths, expect),
      mrr: mrr(paths, expect),
      ndcgAtK: ndcg(paths, expect, k),
      successTop1: expect.some((e) => (paths[0] || "").includes(e)),
      successTop3: paths
        .slice(0, 3)
        .some((p) => expect.some((e) => p.includes(e))),
      successTop5: paths
        .slice(0, 5)
        .some((p) => expect.some((e) => p.includes(e))),
      source: hits[0]?.source || null,
    };
    caseRows.push(row);
    const mark = row.successTop5 ? "✓" : "✗";
    console.log(
      `  ${mark} ${c.id.padEnd(14)} R=${row.recallAtK.toFixed(2)} MRR=${row.mrr.toFixed(2)} top1=${row.top1}`,
    );
  }

  const successfulRows = caseRows.filter((row) => !row.error);
  if (!successfulRows.length) {
    suiteResults.push({
      id: suite.id,
      lang: suite.lang,
      error: "all searches failed",
    });
    continue;
  }
  const summary = {
    id: suite.id,
    lang: suite.lang,
    root,
    revision,
    goldValidation,
    hasEmbeddings: hasEmbed && Number(idxJson.embeddingsWritten || 0) > 0,
    neuralRerankEnabled,
    index: {
      filesScanned: idxJson.filesScanned,
      chunksWritten: idxJson.chunksWritten,
      embeddingsWritten: idxJson.embeddingsWritten,
      indexMs: Math.round(indexMs),
    },
    retrieval: {
      cases: successfulRows.length,
      failedCases: caseRows.length - successfulRows.length,
      meanRecallAtK:
        successfulRows.reduce((s, r) => s + r.recallAtK, 0) /
        successfulRows.length,
      meanMrr:
        successfulRows.reduce((s, r) => s + r.mrr, 0) / successfulRows.length,
      meanNdcgAtK:
        successfulRows.reduce((s, r) => s + r.ndcgAtK, 0) /
        successfulRows.length,
      top1Accuracy:
        successfulRows.filter((r) => r.successTop1).length /
        successfulRows.length,
      top3Accuracy:
        successfulRows.filter((r) => r.successTop3).length /
        successfulRows.length,
      top5Accuracy:
        successfulRows.filter((r) => r.successTop5).length /
        successfulRows.length,
      meanSearchLatencyMs: searchMs / successfulRows.length,
    },
    cases: caseRows,
  };
  suiteResults.push(summary);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, `multilang-${suite.id}.json`),
    JSON.stringify(summary, null, 2),
  );
}

const okSuites = suiteResults.filter((s) => s.retrieval);
const macro = {
  suites: okSuites.length,
  hasEmbeddings: okSuites.some((suite) => suite.hasEmbeddings),
  neuralRerankEnabled:
    neuralRerankEnabled && okSuites.some((suite) => suite.neuralRerankEnabled),
  meanRecallAtK:
    okSuites.reduce((s, x) => s + x.retrieval.meanRecallAtK, 0) /
    (okSuites.length || 1),
  meanMrr:
    okSuites.reduce((s, x) => s + x.retrieval.meanMrr, 0) /
    (okSuites.length || 1),
  meanNdcgAtK:
    okSuites.reduce((s, x) => s + x.retrieval.meanNdcgAtK, 0) /
    (okSuites.length || 1),
  meanTop1:
    okSuites.reduce((s, x) => s + x.retrieval.top1Accuracy, 0) /
    (okSuites.length || 1),
  meanTop3:
    okSuites.reduce((s, x) => s + x.retrieval.top3Accuracy, 0) /
    (okSuites.length || 1),
  meanTop5:
    okSuites.reduce((s, x) => s + x.retrieval.top5Accuracy, 0) /
    (okSuites.length || 1),
  byLang: {},
  evaluatedAt: new Date().toISOString(),
};

for (const s of okSuites) {
  if (!macro.byLang[s.lang]) macro.byLang[s.lang] = [];
  macro.byLang[s.lang].push({
    id: s.id,
    top1: s.retrieval.top1Accuracy,
    mrr: s.retrieval.meanMrr,
    recall: s.retrieval.meanRecallAtK,
  });
}

const out = {
  meta: {
    note: "Multi-language semantic retrieval bench (path gold labels).",
    benchmarkStandard: {
      corpus: "real open-source repositories checked out at immutable refs",
      labels: "human-authored path-substring relevance labels",
      metrics: ["Recall@k", "MRR", "nDCG@k", "Top1", "Top3", "Top5"],
      revisionsPinned: selectedSuites.every((suite) => Boolean(suite.clone.ref)),
      goldPathValidation: {
        passedSuites: suiteResults.filter(
          (suite) => suite.goldValidation?.valid,
        ).length,
        selectedSuites: selectedSuites.length,
        allPassed:
          suiteResults.length === selectedSuites.length &&
          suiteResults.every((suite) => suite.goldValidation?.valid),
      },
      limitations:
        "This is a project regression benchmark, not an external leaderboard or human-judged retrieval corpus.",
    },
    embedding: {
      requested: Boolean(embeddingApiKey && embeddingApiBase),
      enabled: hasEmbed && preflight.embeddingReady,
      base: embeddingApiBase || null,
      model: embeddingApiKey ? embeddingModel : null,
    },
    neuralRerank: {
      requested: neuralRerankEnabled,
      enabled: neuralRerankEnabled && preflight.rerankReady,
    },
    preflight,
  },
  macro,
  suites: suiteResults,
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "multilang-summary.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\n======== MACRO ========");
console.log(JSON.stringify(macro, null, 2));
console.log(`Wrote ${outPath}`);
