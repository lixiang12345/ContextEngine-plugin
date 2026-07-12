# Multi-language semantic retrieval benchmark

**Date:** 2026-07-12 (production re-run)  
**Engine:** ContextEngine-plugin (hybrid auto + implementation-first scoring + multi-lang chunker)  
**Embedding:** `Qwen/Qwen3-Embedding-0.6B` @ RTX 3080 Ti (`OPENAI_BASE_URL` SSH tunnel)  
**Deploy guide:** [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md)

## Scope of validation

| Tier | What we ran | Scale |
|------|-------------|-------|
| Self TS repo | strategy lock-in + unit tests | ~500 chunks |
| Multi-lang mid OSS | 9 repos, gold path labels | ~20–2000 files/repo |

This is **mid-size OSS**, not 100M-LOC monorepos.

## Repos (mainstream languages)

| Lang | Repo | Suite id | Notes |
|------|------|----------|-------|
| JavaScript | expressjs/express@4.21.2 | express-js | HTTP framework |
| Go | gin-gonic/gin | gin-go | HTTP |
| Go | spf13/cobra | cobra-go | CLI |
| Python | psf/requests | requests-py | HTTP client (`src/requests`) |
| C | redis/redis@7.2.5 | redis-c | `src/` only |
| C++ | google/leveldb | leveldb-cpp | storage engine |
| Java | google/guava@v33.3.1 | guava-java | `guava/src` |
| Kotlin | square/okhttp | okhttp-kotlin | main module sources |
| Rust | tokio-rs/axum | axum-rust | `axum/src` |

## Production suite results (semantic ON)

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

## How to re-run

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8   # safer on 12GB GPUs
npm run bench:multilang
```

GPU server: [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md).

## Follow-ups

- Prefer production sources over `*_test.*` / `jvmTest` more aggressively (partially done)
- Optional tree-sitter peer dependency for C/Java method precision
- Per-lang gold sets expanded beyond 6–14 queries
- Wire neural `/v1/rerank` as optional second stage (server ready; not default in search path)
