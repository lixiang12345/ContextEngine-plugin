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
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const benchRoot = process.env.BENCH_ROOT || "/tmp/ce-bench-ml";
const outDir = path.join(repoRoot, "eval-results");
const cli = path.join(repoRoot, "dist/cli.js");

/** @type {Array<{id:string,lang:string,clone:{url:string,dir:string,ref?:string},cases:string,pathPrefix?:string,rootSubdir?:string}>} */
const suites = [
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
    clone: { url: "https://github.com/gin-gonic/gin.git", dir: "gin" },
    cases: "examples/eval.gin.json",
  },
  {
    id: "cobra-go",
    lang: "go",
    clone: { url: "https://github.com/spf13/cobra.git", dir: "cobra" },
    cases: "examples/eval.cobra.json",
  },
  {
    id: "requests-py",
    lang: "python",
    clone: {
      url: "https://github.com/psf/requests.git",
      dir: "requests",
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
    },
    cases: "examples/eval.axum.json",
    rootSubdir: "axum/src",
  },
];

function ensureClone(spec) {
  const dest = path.join(benchRoot, spec.dir);
  mkdirSync(benchRoot, { recursive: true });
  if (!existsSync(dest)) {
    console.log(`Cloning ${spec.url} → ${dest}`);
    let r;
    if (spec.ref) {
      r = spawnSync(
        "git",
        ["clone", "--depth", "1", "--branch", spec.ref, spec.url, dest],
        { stdio: "inherit" },
      );
      if (r.status !== 0) {
        // fallback: clone then checkout tag
        spawnSync("git", ["clone", "--depth", "1", spec.url, dest], {
          stdio: "inherit",
        });
        spawnSync("git", ["fetch", "--depth", "1", "origin", "tag", spec.ref], {
          cwd: dest,
          stdio: "inherit",
        });
        spawnSync("git", ["checkout", spec.ref], { cwd: dest, stdio: "inherit" });
      }
    } else {
      r = spawnSync("git", ["clone", "--depth", "1", spec.url, dest], {
        stdio: "inherit",
      });
      if (r.status !== 0) throw new Error(`clone failed: ${spec.url}`);
    }
  }
  return dest;
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

const hasEmbed = Boolean(
  process.env.OPENAI_API_KEY || process.env.CONTEXTENGINE_EMBEDDING_API_KEY,
);
console.log(
  hasEmbed
    ? `Embeddings: ON model=${process.env.OPENAI_EMBEDDING_MODEL || process.env.CONTEXTENGINE_EMBEDDING_MODEL || "default"} base=${process.env.OPENAI_BASE_URL || "default"}`
    : "Embeddings: OFF (BM25/features only)",
);

const suiteResults = [];

for (const suite of suites) {
  console.log(`\n######## ${suite.id} (${suite.lang}) ########`);
  let cloneRoot;
  try {
    cloneRoot = ensureClone(suite.clone);
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

  const dataDir = path.join(cloneRoot, ".contextengine-ml");
  // clean prior index for fair re-embed
  spawnSync("rm", ["-rf", dataDir]);

  const t0 = performance.now();
  const idx = runCli(["index", root, "--data-dir", dataDir, "--quiet"], repoRoot);
  const indexMs = performance.now() - t0;
  const idxJson = parseJsonBlob(idx.stdout) || {};
  console.log(
    `  indexed files=${idxJson.filesScanned ?? "?"} chunks+=${idxJson.chunksWritten ?? "?"} embeds+=${idxJson.embeddingsWritten ?? "?"} (${Math.round(indexMs)}ms)`,
  );

  const cases = JSON.parse(
    readFileSync(path.join(repoRoot, suite.cases), "utf8"),
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
      "--data-dir",
      dataDir,
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

  const n = caseRows.length || 1;
  const summary = {
    id: suite.id,
    lang: suite.lang,
    root,
    hasEmbeddings: hasEmbed,
    index: {
      filesScanned: idxJson.filesScanned,
      chunksWritten: idxJson.chunksWritten,
      embeddingsWritten: idxJson.embeddingsWritten,
      indexMs: Math.round(indexMs),
    },
    retrieval: {
      cases: caseRows.length,
      meanRecallAtK: caseRows.reduce((s, r) => s + r.recallAtK, 0) / n,
      meanMrr: caseRows.reduce((s, r) => s + r.mrr, 0) / n,
      meanNdcgAtK: caseRows.reduce((s, r) => s + r.ndcgAtK, 0) / n,
      top1Accuracy: caseRows.filter((r) => r.successTop1).length / n,
      top3Accuracy: caseRows.filter((r) => r.successTop3).length / n,
      top5Accuracy: caseRows.filter((r) => r.successTop5).length / n,
      meanSearchLatencyMs: searchMs / n,
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
  hasEmbeddings: hasEmbed,
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
    embedding: {
      enabled: hasEmbed,
      base: process.env.OPENAI_BASE_URL || null,
      model:
        process.env.OPENAI_EMBEDDING_MODEL ||
        process.env.CONTEXTENGINE_EMBEDDING_MODEL ||
        null,
    },
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
