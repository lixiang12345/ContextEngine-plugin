#!/usr/bin/env node
/**
 * Multi-repo mid-size benchmark suite.
 *
 * Default targets (cloned under /tmp/ce-bench if missing):
 *   express@4.21.2, commander.js, koa, got
 *
 * Usage:
 *   node scripts/bench-suite.mjs
 *   BENCH_ROOT=/tmp/ce-bench node scripts/bench-suite.mjs
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const benchRoot = process.env.BENCH_ROOT || "/tmp/ce-bench";
const outDir = path.join(repoRoot, "eval-results");

const suites = [
  {
    id: "express4",
    clone: {
      url: "https://github.com/expressjs/express.git",
      dir: "express",
      ref: "4.21.2",
    },
    cases: "examples/eval.express.json",
  },
  {
    id: "commander",
    clone: {
      url: "https://github.com/tj/commander.js.git",
      dir: "commander",
    },
    cases: "examples/eval.commander.json",
  },
  {
    id: "koa",
    clone: {
      url: "https://github.com/koajs/koa.git",
      dir: "koa",
    },
    cases: "examples/eval.koa.json",
  },
  {
    id: "got",
    clone: {
      url: "https://github.com/sindresorhus/got.git",
      dir: "got",
    },
    cases: "examples/eval.got.json",
  },
];

function ensureClone(spec) {
  const dest = path.join(benchRoot, spec.dir);
  mkdirSync(benchRoot, { recursive: true });
  if (!existsSync(dest)) {
    console.log(`Cloning ${spec.url} → ${dest}`);
    const r = spawnSync("git", ["clone", "--depth", "1", spec.url, dest], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`clone failed: ${spec.url}`);
  }
  if (spec.ref) {
    spawnSync("git", ["fetch", "--depth", "1", "origin", "tag", spec.ref], {
      cwd: dest,
      stdio: "inherit",
    });
    spawnSync("git", ["checkout", spec.ref], { cwd: dest, stdio: "inherit" });
  }
  return dest;
}

// build first
console.log("Building…");
const build = spawnSync("npm", ["run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const summaries = [];

for (const suite of suites) {
  console.log(`\n######## ${suite.id} ########`);
  const root = ensureClone(suite.clone);
  const cases = path.join(repoRoot, suite.cases);
  const r = spawnSync(
    "node",
    [
      path.join(repoRoot, "scripts/practice-eval.mjs"),
      "--root",
      root,
      "--cases",
      cases,
      "--out",
      outDir,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`Suite ${suite.id} failed`);
    process.exit(r.status ?? 1);
  }
  const resultFile = path.join(outDir, `practice-${path.basename(root)}.json`);
  if (existsSync(resultFile)) {
    const data = JSON.parse(readFileSync(resultFile, "utf8"));
    summaries.push({
      id: suite.id,
      root,
      corpus: data.corpus,
      retrieval: data.retrieval,
      incremental: data.incremental,
    });
  }
}

const macro = {
  suites: summaries.length,
  meanRecallAtK:
    summaries.reduce((s, x) => s + x.retrieval.meanRecallAtK, 0) /
    summaries.length,
  meanMrr:
    summaries.reduce((s, x) => s + x.retrieval.meanMrr, 0) / summaries.length,
  meanNdcgAtK:
    summaries.reduce((s, x) => s + x.retrieval.meanNdcgAtK, 0) /
    summaries.length,
  meanTop1:
    summaries.reduce((s, x) => s + x.retrieval.top1Accuracy, 0) /
    summaries.length,
  meanTop3:
    summaries.reduce((s, x) => s + x.retrieval.top3Accuracy, 0) /
    summaries.length,
  meanTop5:
    summaries.reduce((s, x) => s + x.retrieval.top5Accuracy, 0) /
    summaries.length,
  embeddingsEnabled: summaries.some((s) => s.corpus.hasEmbeddings),
  evaluatedAt: new Date().toISOString(),
  engineVersion: "0.4.0",
};

const suiteOut = {
  meta: {
    note: "Multi-repo mid-size IR benchmark (no agent PR generation). Embeddings off unless OPENAI_API_KEY / CONTEXTENGINE_EMBEDDING_* set.",
    embeddingKeysPresent: {
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
      CONTEXTENGINE_EMBEDDING_API_KEY: Boolean(
        process.env.CONTEXTENGINE_EMBEDDING_API_KEY,
      ),
    },
  },
  macro,
  suites: summaries,
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "suite-summary.json");
writeFileSync(outPath, JSON.stringify(suiteOut, null, 2));
console.log("\n======== MACRO ========");
console.log(JSON.stringify(macro, null, 2));
console.log(`Wrote ${outPath}`);
