# Evaluation practice report

**Date:** 2026-07-13 · **Engine:** ContextEngine-plugin v0.4.0  
**Question:** Have we validated on mid-size repos? How do others evaluate? How does auto-reindex work?

---

## 1. What the industry measures

| Style | Who | What they score | What it proves |
|-------|-----|-----------------|----------------|
| **IR / code search** | [CodeSearchNet](https://github.com/github/CodeSearchNet) (GitHub + MSR) | **nDCG** on NL→code (docstring / human queries) | Ranking quality of retrieval models |
| **Agent end-to-end** | [Augment Context Engine](https://www.augmentcode.com/blog/context-engine-mcp-now-live) | Prompt → full PR quality (correctness, completeness, reuse, …) on **300 Elasticsearch PRs × 3 prompts = 900 runs** | Context helps *agents ship better PRs* (not just search) |
| **Repo task suites** | SWE-bench family, etc. | Issue → patch pass tests | Full agent loop (retrieval is one component) |
| **Practical mid-repo RAG** | Many open RAG tools | **Recall@k / MRR / Hit@k** on hand-labeled “query → must-hit files” | Fast regression signal for context engines |

We implement the **practical IR layer** (Recall / MRR / nDCG / Top‑k hit) on real mid-size OSS, which is the right first gate.  
We do **not** yet run Augment-style 900 PR-generation trials (needs an agent harness + judge + budget).

---

## 2. What we practiced

### A. This repository (small)

- ~20–25 source files under `src/`, ~5k lines of project docs+code  
- Built-in: `contextengine eval --self`  
- Result (v0.4): **8/8** cases, mean Recall@k = **1.0**, mean MRR ≈ **0.84–0.90**

This only proves the engine works on its own sources — **not** mid-size production code.

### B. Express 4.21.2 (true mid-size OSS target)

| Corpus | Value |
|--------|-------|
| Repo | `expressjs/express` tag **4.21.2** |
| JS files | ~152 tracked sources (+ tests/examples ≈ 201 indexed paths) |
| Approx. JS LOC | ~**23k** |
| Index | ~**1077** chunks, FTS5 on, **no embeddings** (BM25+symbol+rerank only) |
| Cold index time | ~**165 ms** on this machine |
| Cases | 14 hand-labeled NL/symbol/path queries → expected `lib/*` paths |

Cases live in `examples/eval.express.json`.  
Runner: `node scripts/practice-eval.mjs --root <express4> --cases examples/eval.express.json`.

#### Retrieval results (no API embeddings)

| Metric | Score |
|--------|------:|
| mean **Recall@k** | **0.93** |
| mean **MRR** | **0.89** |
| mean **nDCG@k** | **0.92** |
| **Top-1** path accuracy | **0.79** |
| **Top-3** path accuracy | **1.00** |
| **Top-5** path accuracy | **1.00** |
| mean search latency | **~4 ms** / query |
| cases with full expected-path recall | **12/14 (86%)** |

Raw JSON: `eval-results/practice-express4.json`.

#### What failed / was soft

- Multi-expect cases (`createApplication` → express+application; error wiring) often hit **one** of two gold paths → Recall 0.5 but MRR 1.0 (still useful for agents).  
- Some NL queries rank **tests** high before `lib/` (Top-1 miss, Top-3 hit) — mitigated by demoting `examples/` and `test/` in the feature reranker.

#### False start: Express 5.x default branch

`express@5` **removed** `lib/router` / `lib/middleware` from the main tree (router lives in dependencies).  
Our first gold labels assumed Express 4 layout → **Recall ~0.54** was a **label/layout mismatch**, not a pure model failure. Always pin the corpus revision when evaluating.

---

## 3. Incremental index practice

Same Express 4 run measured re-index behavior:

| Scenario | filesIndexed | chunksWritten | duration |
|----------|-------------:|--------------:|---------:|
| Re-index, **no file change** | 0 | 0 | ~**34 ms** |
| Edit **one** file (`lib/application.js`) | **1** | ~34 (that file’s chunks) | ~**43 ms** |
| Restore file + re-index | 1 | (rewrite) | ~**43 ms** |

Mechanism: per-file **content SHA-256**; unchanged files are skipped. Commit lineage is rewritten only when the recent commit-hash set changes.

---

## 4. Watch / auto-rebuild practice

Synthetic FS test (`fs.watch` + debounce 300ms):

1. Initial index of empty project with `src/a.ts`  
2. Add `src/b.ts` → re-index with `filesIndexed=1`  
3. Edit `src/a.ts` → re-index with `filesIndexed=1`  

Watch **does** pick up creates/edits and runs the same incremental `indexWorkspace`.

### How auto-index is supposed to work (current design)

```text
contextengine watch
    │
    ▼
node:fs.watch(root, { recursive: true })
    │  ignore node_modules / .git / .contextengine / dist
    ▼
debounce (default 800ms)
    │
    ▼
indexWorkspace()   ← hash skip unchanged files
    │
    ▼
SQLite (+ FTS + symbols) updated
```

| Entry | Auto rebuild? |
|-------|----------------|
| `contextengine watch` | **Yes** (dedicated process) |
| `contextengine index` | Manual / CI |
| MCP `reindex_workspace` | Manual tool call by agent |
| MCP default server process | **No background watch** (agent must reindex or user runs `watch`) |
| Augment Local mode (product claim) | Local indexer keeps index live for “next query” |

**Gap vs Augment:** our MCP server does **not** yet embed a long-lived watcher; real-time is opt-in via `contextengine watch` (or agent calling `reindex_workspace` after large edits).

---

## 5. Honest conclusions

1. **Yes — mid-size practice was run** on Express 4 (~20k+ LOC), not only the toy self-repo.  
2. **Without embeddings**, multi-signal FTS + symbol + path-aware rerank already reaches **~0.9 MRR / ~1.0 Top-3** on this labeled set — good for mid-size libraries with clear `lib/` structure.  
3. Metrics match **common IR practice** (CodeSearchNet-style nDCG/MRR), **not** Augment’s PR-generation benchmark.  
4. **Incremental hash indexing works**; **watch works** when the watch process is running.  
5. Remaining gaps for “Augment-class ops”: embed MCP-side live indexing, multi-repo scale tests (100k+ files), and agent-level PR evals.

### Reproduce

```bash
# Express 4.21.2
git clone --depth 1 --branch 4.21.2 https://github.com/expressjs/express.git /tmp/express4
cd /path/to/ContextEngine-plugin && npm run build
node scripts/practice-eval.mjs --root /tmp/express4 --cases examples/eval.express.json

# Self
node dist/cli.js eval --self --reindex

# Watch demo
node dist/cli.js watch /tmp/express4
```

---

## 6. Multi-repo suite (cloned from GitHub, local)

**Command:** `node scripts/bench-suite.mjs`  
**Clones under:** `/tmp/ce-bench/`  
**Embeddings:** **off** (no API key in this environment)  
**Date:** 2026-07-13 · post path-demotion rerank

| Repo | Source | ~files | chunks | Recall@k | MRR | nDCG@k | Top-1 | Top-3 | Top-5 | lat |
|------|--------|-------:|-------:|---------:|----:|-------:|------:|------:|------:|----:|
| **express@4.21.2** | expressjs/express | 202 | 1077 | 0.93 | 0.89 | 0.93 | 0.79 | **1.00** | **1.00** | 4ms |
| **commander** | tj/commander.js | 216 | 950 | **1.00** | 0.64 | 0.69 | 0.40 | 0.80 | 0.90 | 7ms |
| **koa** | koajs/koa | 109 | 707 | 0.75 | 0.40 | 0.48 | 0.25 | 0.38 | 0.75 | 5ms |
| **got** | sindresorhus/got | 124 | 4076 | **1.00** | 0.73 | 0.86 | 0.50 | **1.00** | **1.00** | 7ms |
| **MACRO (mean)** | 4 suites | — | — | **0.92** | **0.67** | **0.74** | **0.48** | **0.79** | **0.91** | ~6ms |

Incremental (all suites): no-op reindex ~30–50ms; single-file edit reindex ~40–80ms, `filesIndexed=1`.

### Reading the numbers

- **Top-5 ≈ 0.91 macro** without embeddings is usable for mid-size Node libs.  
- **Top-1 ≈ 0.48** is the weak spot: docs (`koa/docs/api/*`), examples, typings, and tests still steal rank-1 on conceptual queries.  
- **Koa is hardest** here: rich markdown API docs share vocabulary with `lib/*` — this is exactly where a **code embedding** channel should lift MRR/Top-1.  
- **Express** remains the best-structured target for pure lexical multi-signal retrieval.

### Cases / runners

| File | Role |
|------|------|
| `examples/eval.express.json` | Express 4 labels |
| `examples/eval.commander.json` | Commander labels |
| `examples/eval.koa.json` | Koa labels |
| `examples/eval.got.json` | Got labels |
| `scripts/practice-eval.mjs` | Single-repo IR + incremental |
| `scripts/bench-suite.mjs` | Multi-repo clone + aggregate |
| `docs/EMBEDDINGS.md` | Which code embedding models to use |

```bash
node scripts/bench-suite.mjs
# with embeddings (recommended for Koa-like repos):
# export OPENAI_API_KEY=... ; export OPENAI_EMBEDDING_MODEL=text-embedding-3-small
# node scripts/bench-suite.mjs
```


## 7. Multi-language semantic bench (2026-07-12)

See **[docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)** and `eval-results/multilang-summary.json`.

**MACRO (9 suites, Qwen3-Embedding-0.6B):** mean Top1≈0.66, Top5≈0.93, MRR≈0.78, Recall≈0.93.

Languages covered: JS, Go, Python, C, C++, Java, Kotlin, Rust.
