# Multi-language semantic retrieval benchmark

**Date:** 2026-07-12  
**Engine:** ContextEngine-plugin (semantic-first auto + implementation-first scoring + multi-lang chunker)  
**Embedding:** Qwen/Qwen3-Embedding-0.6B @ RTX 3080 Ti (`OPENAI_BASE_URL` tunnel)

## Scope of validation

| Tier | What we ran | Scale |
|------|-------------|-------|
| Self TS repo | full strategy lock-in | ~500 chunks |
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

## First full-suite results (semantic ON)

From `eval-results/multilang-summary.json` (initial run):

| Suite | Top1 | Top5 | MRR | Recall@k |
|-------|-----:|-----:|----:|---------:|
| express-js | 0.71 | 1.00 | 0.84 | 1.00 |
| gin-go | 0.88 | 1.00 | 0.94 | 1.00 |
| cobra-go | 0.67 | ~1.0 | 0.75 | 0.83 |
| requests-py | 0.83 | 1.00 | 0.92 | 1.00 |
| redis-c | 0.43 | ~0.9 | 0.67 | 1.00 |
| leveldb-cpp | 0.33 | ~0.8 | 0.55 | 0.89 |
| guava-java | **1.00** | 1.00 | **1.00** | 0.95 |
| okhttp-kotlin | 0.33 | low | 0.49 | 0.67 |
| axum-rust | 0.80 | 1.00 | 0.90 | 1.00 |
| **MACRO** | **0.66** | **0.93** | **0.78** | **0.93** |

### Reading

- **Strong:** Java (Guava), Go (Gin), Python (Requests), JS (Express Hit@5), Rust (Axum Hit@5)
- **Weaker Top1:** C/C++ (header/test noise), Kotlin (test sources polluted first pass)
- **Hit@5 often high** even when Top1 is imperfect — good enough for agent multi-hop, needs polish for single-shot

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

## Follow-ups

- Prefer production sources over `*_test.*` / `jvmTest` more aggressively (partially done)
- Optional tree-sitter peer dependency for C/Java method precision
- Per-lang gold sets expanded beyond 6–14 queries
