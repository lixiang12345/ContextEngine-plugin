# Multi-language semantic retrieval benchmark

**Date:** 2026-07-12 (production re-run)  
**Engine:** ContextEngine-plugin (hybrid auto + implementation-first scoring + multi-lang chunker)  
**Embedding:** `Qwen/Qwen3-Embedding-0.6B` @ RTX 3080 Ti (`OPENAI_BASE_URL` SSH tunnel)  
**Deploy guide:** [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md)

## Is this a real benchmark?

**It is a project-owned, reproducible offline IR regression benchmark on real cloned
OSS**, not a mocked score or a third-party leaderboard.

| Claim | Evidence |
|-------|----------|
| Real repos | GitHub clones under `/tmp/ce-bench-ml/*` (Express, Gin, Redis, Guava, …), detached at immutable refs |
| Real embeddings | `hasEmbeddings: true`, model `Qwen/Qwen3-Embedding-0.6B`, base tunnel `http://127.0.0.1:18000/v1` |
| Real metrics | Recall@k / MRR / nDCG / Top1–5 from human-authored path-substring gold cases in `examples/eval.*.json` |
| Artifacts on disk | `eval-results/multilang-summary.json` + per-suite JSON (timestamp `2026-07-12T20:45:02Z`) |
| Runner | `npm run bench:multilang` → `scripts/bench-multilang.mjs` |

**What it is not:** a public leaderboard (MTEB/CoIR), a human-judged relevance corpus, or
a 100M-LOC monorepo stress test. Gold labels are path substrings we authored (5–14
queries/repo), so they verify file retrieval rather than graded passage relevance. Keeping
the GPU on is **not** required to preserve saved numbers — they are written to disk.

### Reproducibility guardrails

Before indexing, the runner fetches each repository's configured immutable ref, checks it
out detached, then validates every case:

1. unique, non-empty case id and query;
2. non-empty `expectPaths` string array;
3. every expected path substring matches a tracked file under the suite's indexed root.

Any failed validation fails that suite instead of publishing a misleading metric. The result
JSON records the resolved revision and `goldValidation` result. The top-level metadata states
whether all selected suites were pinned and validated.

## Scope of validation

| Tier | What we ran | Scale |
|------|-------------|-------|
| Self TS repo | strategy lock-in + unit tests | ~500 chunks |
| Multi-lang mid OSS | 9 repos in the saved run; 10 suites in the current runner | ~20–2000 files/repo |

This is **mid-size OSS**, not 100M-LOC monorepos.

## Repos (mainstream languages)

| Lang | Repo | Suite id | Notes |
|------|------|----------|-------|
| TypeScript | sindresorhus/got@v14.4.5 | got-ts | HTTP client |
| JavaScript | expressjs/express@4.21.2 | express-js | HTTP framework |
| Go | gin-gonic/gin@`34dac209` | gin-go | HTTP |
| Go | spf13/cobra@`adbc8813` | cobra-go | CLI |
| Python | psf/requests@`f361ead0` | requests-py | HTTP client (`src/requests`) |
| C | redis/redis@7.2.5 | redis-c | `src/` only |
| C++ | google/leveldb@`7ee830d0` | leveldb-cpp | storage engine |
| Java | google/guava@v33.3.1 | guava-java | `guava/src` |
| Kotlin | square/okhttp@`63e3caa7` | okhttp-kotlin | main module sources |
| Rust | tokio-rs/axum@`b859fc0a` | axum-rust | `axum/src` |

## Latest public T4 results (semantic ON)

Evaluated on **2026-07-15 CST** (`2026-07-14T16:43:54.631Z`) against a temporary
public deployment backed by a Tesla T4. The endpoint ran
`Qwen/Qwen3-Embedding-0.6B` with Qwen v2 `input_type=document/query`; the API returned
1024-dimensional vectors. All suites used real remote embeddings, pinned repository
revisions, and path-gold relevance labels.

| Suite | Top1 | Top5 | MRR | Recall@k |
|-------|-----:|-----:|----:|---------:|
| got-ts | 0.90 | 0.90 | 0.91 | 1.00 |
| express-js | 0.86 | 1.00 | 0.93 | 1.00 |
| gin-go | **1.00** | **1.00** | **1.00** | **1.00** |
| cobra-go | 0.83 | 1.00 | 0.92 | 1.00 |
| requests-py | 0.83 | 1.00 | 0.92 | 1.00 |
| redis-c | 0.57 | 0.71 | 0.67 | 0.86 |
| leveldb-cpp | 0.83 | 1.00 | 0.89 | 1.00 |
| guava-java | 0.86 | 0.86 | 0.86 | 0.86 |
| okhttp-kotlin | **1.00** | **1.00** | **1.00** | **1.00** |
| axum-rust | 0.80 | 1.00 | 0.90 | 1.00 |
| **MACRO** | **0.85** | **0.95** | **0.90** | **0.97** |

The fast API benchmark on the same deployment matched **10/10** multilingual
query-to-code pairs at Top1. The rerank endpoint was reachable but produced tied scores
for all 10 cases (Top1 0.10 from stable input ordering), so neural rerank was disabled
for the full-suite run. Availability and HTTP 200 alone are not evidence that a reranker
is usable; enable it only after `npm run bench:api` reports meaningful score spread.

## Focused post-optimization regression

On **2026-07-15 CST** (`2026-07-14T17:12:53.975Z`), the public T4 deployment was used
to re-index the two previous weak suites from scratch. This is a focused two-suite
regression result, **not** a replacement for the all-language macro above.

| Suite | Revision | Cases | Top1 | Top5 | MRR | Recall@k |
|-------|----------|------:|-----:|-----:|----:|---------:|
| Redis C | `f60370ce` | 7 | **0.86** | **1.00** | **0.93** | **1.00** |
| Guava Java | `df9602b6` | 7 | **1.00** | **1.00** | **1.00** | **1.00** |
| Focused macro | — | 14 | **0.93** | **1.00** | **0.96** | **1.00** |

Compared with the prior T4 table, Redis improved from Top1 0.57 / Recall 0.86 and Guava
from Top1 0.86 / Recall 0.86. The changes tested here are comment-safe C symbol
extraction, detection of ordinary C top-level functions such as `main`, and recognition
of single PascalCase identifiers such as `Optional` for symbol/path recall.

## Historical production suite results (semantic ON)

From `eval-results/multilang-summary.json` (evaluated `2026-07-12T20:45:02Z`):

| Suite | Top1 | Top5 | MRR | Recall@k |
|-------|-----:|-----:|----:|---------:|
| express-js | 0.86 | 1.00 | 0.93 | 0.96 |
| gin-go | **1.00** | 1.00 | **1.00** | 1.00 |
| cobra-go | 0.83 | 1.00 | 0.92 | 1.00 |
| requests-py | **1.00** | 1.00 | **1.00** | 1.00 |
| redis-c | 0.71 | ~0.9 | 0.77 | 1.00 |
| leveldb-cpp | 0.83 | 1.00 | 0.92 | 1.00 |
| guava-java | 0.86 | 1.00 | 0.93 | 1.00 |
| okhttp-kotlin | **1.00** | 1.00 | **1.00** | 1.00 |
| axum-rust | 0.80 | 1.00 | 0.90 | 1.00 |
| **MACRO** | **~0.88** | **~0.98** | **~0.93** | **~1.00** |

Exact macro means in the JSON:

| Metric | Value |
|--------|------:|
| mean Recall@k | **0.996** |
| mean MRR | **0.929** |
| mean nDCG@k | **0.978** |
| mean Top1 | **0.877** |
| mean Top3 | **0.968** |
| mean Top5 | **0.984** |

### Reading

- **Strong:** Go (Gin/Cobra), Python (Requests), Kotlin (OkHttp), JS Hit@5, Java Guava Hit@5  
- **Weaker Top1:** C (Redis networking aliases / cluster noise), occasional test-file Top1 on NL queries  
- **Hit@5 ≈ 0.98** — solid for agent multi-hop; Top1 still improvable with tree-sitter / larger gold sets  

### What changed vs first pass

Earlier full-suite macro was roughly **Top1 0.66 / MRR 0.78**. Production re-run after:

1. Hybrid auto mode (FTS + symbol + semantic) instead of pure semantic  
2. Stronger test/docs/header penalties and primary-source boosts  
3. Query-instruct embeddings for Qwen3  
4. Adaptive embed batch + ignore of heavy `jvmTest` / android test trees  
5. Multi-language structural chunking  

## Chunking evaluation (research)

**Yes — chunk rules should differ by language** (structure cues differ).

Best practice consensus for **code search / agent RAG** (not line-completion):

1. Prefer **AST / structural units** (function, method, type, class) over fixed token windows  
2. Attach **comments / decorators / attributes** to the following unit  
3. Keep **imports/package preamble** as a small header chunk  
4. Soft-split oversized units; avoid mid-statement cuts  
5. Carry **path + symbol + language** into the embed text / BM25 fields  

Our implementation: language profiles in `src/chunker/code-chunker.ts` (brace vs indent vs markdown), documented in `docs/CHUNKING.md`.  
Not full tree-sitter (no native deps); heuristic structure is the current best cost/quality tradeoff.

## Remote API compatibility benchmark

`npm run bench:api` is a fast guardrail for a newly deployed public endpoint. It checks:

- `GET /health`, then authenticated `POST /v1/embeddings` and `POST /v1/rerank`
- 10 natural-language queries: English, Chinese, Japanese, Korean, Spanish, French,
  German, Portuguese, Arabic, and Hindi
- 10 code-language snippets: TypeScript, Python, Go, Rust, Java, C++, C#, Ruby, PHP,
  and Swift

It writes `eval-results/api-multilingual-summary.json`. This measures remote API and
model compatibility, not full-repository retrieval quality. The report also records
rerank score spread so an all-tied but HTTP-successful endpoint is not treated as a
working second-stage ranker.

## How to re-run

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8   # safer on 12GB GPUs
# Enable only after the API benchmark reports meaningful rerank score spread.
# export CONTEXTENGINE_NEURAL_RERANK=1
# export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B

# Fast deployment validation. The root origin or its /v1 base both work.
npm run bench:api

# Filter the full suite while iterating, then remove BENCH_SUITES for all suites.
BENCH_SUITES=got-ts,requests-py npm run bench:multilang
npm run bench:multilang
```

GPU server: [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md).

The full runner performs the same remote preflight before cloning. It records the
actual embedding writes, pinned revision, failed cases, and rerank state, rather than
inferring quality from the mere presence of an API key.

## Follow-ups

- Prefer production sources over `*_test.*` / `jvmTest` more aggressively (partially done)
- Optional tree-sitter peer dependency for C/Java method precision
- Per-lang gold sets expanded beyond 6–14 queries
- Expand per-language gold sets and add human relevance judgments / hard negatives
- Benchmark larger corpus sizes and tune pgvector HNSW parameters before claiming very-large-monorepo capacity
