#!/usr/bin/env node
/**
 * Practice evaluation runner for mid-size repos.
 * Metrics aligned with common IR practice (CodeSearchNet-style nDCG/MRR/Recall)
 * and agent-oriented path hit rates (Augment-style "did we surface the right files").
 *
 * Usage:
 *   node scripts/practice-eval.mjs --root /path/to/repo --cases examples/eval.express.json
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1] ?? def;
}

const root = path.resolve(flag("--root", process.cwd()));
const casesPath = path.resolve(
  flag("--cases", path.join(process.cwd(), "examples/eval.express.json")),
);
const outDir = path.resolve(flag("--out", path.join(process.cwd(), "eval-results")));
const topKDefault = Number(flag("--top-k", "10"));

const distEngine = path.join(process.cwd(), "dist/engine.js");
const { ContextEngine } = await import(pathToFileURL(distEngine).href);

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const engine = ContextEngine.open({ root });

console.log(`Root: ${root}`);
console.log(`Cases: ${cases.length} from ${casesPath}`);

const t0 = performance.now();
const indexResult = await engine.index((p) => {
  if (p.phase === "done" || p.filesDone % 50 === 0) {
    process.stdout.write(
      `\r  index ${p.phase} ${p.filesDone}/${p.filesTotal}   `,
    );
  }
});
process.stdout.write("\n");
const indexMs = performance.now() - t0;
const stats = engine.stats();

// --- retrieval metrics ---
function mrr(hitPaths, expect) {
  for (let i = 0; i < hitPaths.length; i++) {
    if (expect.some((e) => hitPaths[i].includes(e))) return 1 / (i + 1);
  }
  return 0;
}
function recall(hitPaths, expect) {
  if (!expect.length) return 0;
  let hit = 0;
  for (const e of expect) if (hitPaths.some((p) => p.includes(e))) hit++;
  return hit / expect.length;
}
function ndcg(hitPaths, expect, k) {
  const rels = hitPaths.slice(0, k).map((p) =>
    expect.some((e) => p.includes(e)) ? 1 : 0,
  );
  const dcg = rels.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
  const ideal = Array(Math.min(expect.length, k)).fill(1);
  const idcg = ideal.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
  return idcg <= 0 ? 0 : Math.min(1, dcg / idcg);
}

const caseResults = [];
let searchMsTotal = 0;

for (const c of cases) {
  const k = c.topK ?? topKDefault;
  const s0 = performance.now();
  const hits = await engine.search({
    query: c.query,
    topK: k,
    mode: "auto",
    expandGraph: true,
    diversify: true,
  });
  searchMsTotal += performance.now() - s0;
  const hitPaths = hits.map((h) => h.chunk.path);
  const r = {
    id: c.id,
    query: c.query,
    expectPaths: c.expectPaths,
    hitPaths: hitPaths.slice(0, k),
    top1: hitPaths[0] ?? null,
    recallAtK: recall(hitPaths, c.expectPaths),
    mrr: mrr(hitPaths, c.expectPaths),
    ndcgAtK: ndcg(hitPaths, c.expectPaths, k),
    successTop1: c.expectPaths.some((e) => (hitPaths[0] ?? "").includes(e)),
    successTop3: hitPaths
      .slice(0, 3)
      .some((p) => c.expectPaths.some((e) => p.includes(e))),
    successTop5: hitPaths
      .slice(0, 5)
      .some((p) => c.expectPaths.some((e) => p.includes(e))),
    latencyMs: performance.now() - s0,
  };
  caseResults.push(r);
  const mark = r.successTop5 ? "✓" : "✗";
  console.log(
    `  ${mark} ${c.id.padEnd(14)} R@k=${r.recallAtK.toFixed(2)} MRR=${r.mrr.toFixed(2)} nDCG=${r.ndcgAtK.toFixed(2)} top1=${r.top1}`,
  );
}

// --- incremental index experiment ---
const inc0 = performance.now();
const noop = await engine.index();
const incNoChangeMs = performance.now() - inc0;

function pickProbeFile() {
  const prefer = [
    "lib/application.js",
    "lib/command.js",
    "lib/context.js",
    "lib/option.js",
    "source/create.ts",
    "source/index.ts",
    "index.js",
  ];
  for (const rel of prefer) {
    if (existsSync(path.join(root, rel))) return rel;
  }
  for (const r of caseResults) {
    for (const p of r.hitPaths || []) {
      if (
        p &&
        !p.includes("test") &&
        !p.includes("example") &&
        existsSync(path.join(root, p))
      ) {
        return p;
      }
    }
  }
  return null;
}

const probeRel = pickProbeFile();
let afterChange = { filesIndexed: 0, chunksWritten: 0 };
let incChangeMs = 0;
let incRestoreMs = 0;
if (probeRel) {
  const probeAbs = path.join(root, probeRel);
  const original = readFileSync(probeAbs, "utf8");
  const marker = `\n// contextengine-eval-marker ${Date.now()}\n`;
  writeFileSync(probeAbs, original + marker);
  const ch0 = performance.now();
  afterChange = await engine.index();
  incChangeMs = performance.now() - ch0;
  writeFileSync(probeAbs, original);
  const ch1 = performance.now();
  await engine.index();
  incRestoreMs = performance.now() - ch1;
}

engine.close();

const n = caseResults.length || 1;
const report = {
  meta: {
    root,
    casesFile: casesPath,
    evaluatedAt: new Date().toISOString(),
    engineVersion: "0.4.0",
    notes:
      "Retrieval-only eval on a mid-size OSS repo (not full agent PR generation). Metrics follow IR practice (Recall/MRR/nDCG) similar in spirit to CodeSearchNet nDCG and Augment path-hit usefulness.",
  },
  corpus: {
    filesScanned: indexResult.filesScanned,
    filesIndexed: indexResult.filesIndexed,
    chunksWritten: indexResult.chunksWritten,
    chunkCount: stats.chunkCount,
    fileCount: stats.fileCount,
    hasFts: stats.hasFts,
    hasEmbeddings: stats.hasEmbeddings,
    indexMs: Math.round(indexMs),
  },
  retrieval: {
    cases: n,
    meanRecallAtK: caseResults.reduce((s, r) => s + r.recallAtK, 0) / n,
    meanMrr: caseResults.reduce((s, r) => s + r.mrr, 0) / n,
    meanNdcgAtK: caseResults.reduce((s, r) => s + r.ndcgAtK, 0) / n,
    top1Accuracy: caseResults.filter((r) => r.successTop1).length / n,
    top3Accuracy: caseResults.filter((r) => r.successTop3).length / n,
    top5Accuracy: caseResults.filter((r) => r.successTop5).length / n,
    meanSearchLatencyMs: searchMsTotal / n,
    passedAllExpected:
      caseResults.filter((r) => r.recallAtK >= 1).length / n,
  },
  incremental: {
    reindexNoChange: {
      durationMs: Math.round(incNoChangeMs),
      filesIndexed: noop.filesIndexed,
      chunksWritten: noop.chunksWritten,
    },
    reindexAfterOneFileEdit: {
      durationMs: Math.round(incChangeMs),
      filesIndexed: afterChange.filesIndexed,
      chunksWritten: afterChange.chunksWritten,
    },
    reindexAfterRestore: {
      durationMs: Math.round(incRestoreMs),
    },
  },
  cases: caseResults,
};

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `practice-${path.basename(root)}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log("\n=== Summary ===");
console.log(JSON.stringify({ corpus: report.corpus, retrieval: report.retrieval, incremental: report.incremental }, null, 2));
console.log(`\nWrote ${outFile}`);
