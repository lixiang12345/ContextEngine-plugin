#!/usr/bin/env node
// Retrieval-level A/B over the fixed task-retrieval corpus
// (benchmarks/task-retrieval/contextengine-v1.json): for each case, index the
// repository at its pinned baseRef with the CURRENT engine and compare gold
// recall / best rank / MRR with and without task-subquery fusion.
//
//   CONTEXTENGINE_DATABASE_URL=postgres://… node scripts/eval-task-retrieval.mjs [--cases id1,id2]
//
// Fails closed: a missing baseRef, a gold path absent at base, or an indexing
// failure aborts the run instead of reporting a partial green.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repo, "benchmarks/task-retrieval/contextengine-v1.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const databaseUrl = process.env.CONTEXTENGINE_DATABASE_URL;
if (!databaseUrl) {
  console.error("CONTEXTENGINE_DATABASE_URL is required");
  process.exit(2);
}
const onlyCases = process.argv.includes("--cases")
  ? new Set(process.argv[process.argv.indexOf("--cases") + 1].split(","))
  : null;

const cli = (args, cwd) =>
  execFileSync("node", ["--import", "tsx", path.join(repo, "src/cli.ts"), ...args], {
    cwd: cwd ?? repo,
    env: {
      ...process.env,
      CONTEXTENGINE_DATABASE_URL: databaseUrl,
      // Blank every fallback in the model resolution chains so the comparison
      // runs deterministically on the lexical channels only.
      CONTEXTENGINE_EMBEDDING_BASE_URL: "",
      CONTEXTENGINE_EMBEDDING_MODEL: "",
      CONTEXTENGINE_EMBEDDING_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_EMBEDDING_MODEL: "",
      EMBEDDING_API_KEY: "",
      CONTEXTENGINE_NEURAL_RERANK: "",
      CONTEXTENGINE_RERANK_BASE_URL: "",
      CONTEXTENGINE_RERANK_MODEL: "",
      CONTEXTENGINE_RERANK_API_KEY: "",
    },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });

const metrics = (packed, goldPaths) => {
  const seen = [];
  for (const hit of packed.hits) {
    if (!seen.includes(hit.chunk.path)) seen.push(hit.chunk.path);
  }
  const ranks = goldPaths
    .map((gold) => seen.indexOf(gold))
    .filter((rank) => rank !== -1)
    .map((rank) => rank + 1);
  return {
    recall: ranks.length / goldPaths.length,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    mrr: ranks.length ? 1 / Math.min(...ranks) : 0,
  };
};

const rows = [];
for (const testCase of manifest.cases) {
  if (onlyCases && !onlyCases.has(testCase.id)) continue;
  execFileSync("git", ["cat-file", "-e", testCase.baseRef], { cwd: repo });
  const worktree = mkdtempSync(path.join(os.tmpdir(), `ce-task-retrieval-${testCase.id}-`));
  rmSync(worktree, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", worktree, testCase.baseRef], {
    cwd: repo,
  });
  try {
    for (const gold of testCase.goldPaths) {
      if (!existsSync(path.join(worktree, gold))) {
        throw new Error(`${testCase.id}: gold path ${gold} does not exist at ${testCase.baseRef}`);
      }
    }
    console.error(`[${testCase.id}] indexing ${testCase.baseRef.slice(0, 12)}…`);
    cli(["index", worktree]);
    const variants = {};
    for (const [variant, extra] of [
      ["single", ["--no-subqueries"]],
      ["subqueries", []],
    ]) {
      const packed = JSON.parse(
        cli([
          "context",
          testCase.prompt,
          "--root",
          worktree,
          "--top-k",
          String(manifest.topK ?? 20),
          "--json",
          ...extra,
        ]),
      );
      variants[variant] = {
        ...metrics(packed, testCase.goldPaths),
        plan:
          packed.trace?.subqueries?.map(
            (subquery) => `${subquery.reason}:+${subquery.contributed}`,
          ) ?? [],
      };
    }
    rows.push({ id: testCase.id, facets: testCase.facets, gold: testCase.goldPaths.length, ...variants });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
  }
}

console.log(JSON.stringify(rows, null, 2));
let improved = 0;
let regressed = 0;
for (const row of rows) {
  const recallDelta = row.subqueries.recall - row.single.recall;
  const mrrDelta = row.subqueries.mrr - row.single.mrr;
  const direction =
    recallDelta > 0 || (recallDelta === 0 && mrrDelta > 1e-9)
      ? "improved"
      : recallDelta < 0 || mrrDelta < -1e-9
        ? "REGRESSED"
        : "unchanged";
  if (direction === "improved") improved += 1;
  if (direction === "REGRESSED") regressed += 1;
  console.error(
    `${row.id} [${row.facets}] gold=${row.gold}: ` +
      `single recall=${row.single.recall.toFixed(2)} rank=${row.single.bestRank} | ` +
      `subq recall=${row.subqueries.recall.toFixed(2)} rank=${row.subqueries.bestRank} ` +
      `(${direction}) plan=[${row.subqueries.plan.join(",")}]`,
  );
}
console.error(
  `net: ${improved} improved, ${regressed} regressed, ${rows.length - improved - regressed} unchanged`,
);
process.exit(regressed > improved ? 1 : 0);
