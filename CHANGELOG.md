# Changelog

## Unreleased

- Added a multi-stage production Docker image and a complete Docker Compose deployment for the HTTP service plus PostgreSQL/pgvector, including health checks and persistent volumes.
- Added a self-contained `/dashboard` observability UI with workspace/index health, recent jobs, process metrics, route latency/error telemetry, and a live retrieval probe.
- Added authenticated `GET /v1/observability/overview`; request telemetry records only normalized routes, status codes, and timings, never request payloads or API keys.
- Retrieval output is model-neutral: ContextEngine no longer tracks model names, context windows, or reserved output tokens.
- Library, CLI, MCP, and HTTP retrieval entrypoints return all reranked `topK` hits by default; explicit `max_tokens` remains an optional caller-controlled transport cap.
- Natural-language queries no longer classify ordinary prose words as code symbols; structured identifiers and acronyms still route through the symbol channel.
- Chunk-level candidates are collapsed and reranked at file level so evidence spread across class headers and methods can compete with repetitive documentation.
- Lexical retrieval keeps a deeper candidate pool before file aggregation so large files with evidence spread across methods are not truncated prematurely.
- MMR no longer treats a shared deep source/package prefix as near-duplicate content, preserving relevant files from the same subsystem.
- Diversified search now returns at most the requested `topK` unique file representatives, improving recall without duplicate chunks consuming result slots.

- Optional neural `/v1/rerank` second stage (`CONTEXTENGINE_NEURAL_RERANK=1`) blended after hybrid+feature scoring
- Production hybrid retrieval defaults (auto → hybrid when embeddings exist)
- Stronger multi-lang implementation-first rerank (tests/headers/docs penalties)
- Adaptive embedding batch + `CONTEXTENGINE_EMBED_MAX_CHARS` for 12GB GPUs
- Default ignores for heavy `jvmTest` / android test / testdata trees
- Docs: GPU deploy guide, getting-started paths, multilang bench refresh
- Ship `scripts/embed_rerank_server.py` (OpenAI-compatible embed + optional Qwen3 rerank)

## 0.4.0 — Augment-class retrieval stack

- Multi-signal retrieval: FTS5 BM25 + symbol table + path hints + optional two-stage semantic
- Query analyzer (symbol / path / concept / history intents)
- Feature reranker + RRF fusion + MMR diversity packing
- Multi-root indexing (`--extra docs:path`, `CONTEXTENGINE_EXTRA_ROOTS`)
- Primary MCP tool: `codebase_retrieval` (Augment-style)
- Eval metrics: Recall@k, MRR, nDCG@k
- Architecture doc: `ARCHITECTURE.md`

## 0.3.1

- CI workflow (build, test, self-eval)
- Brace-aware unit chunking for TS/JS/Go/Rust/Java-like languages
- Index export / import for offline index sharing
- `COMPARISON.md` — gap analysis vs Augment Context Engine
- Package files include examples + docs; bin shebang ensure on build

## 0.3.0

- Retrieval eval harness (`contextengine eval`)
- Multi-repo profiles (`contextengine profile`)
- Example MCP configs for Claude Code / Cursor
- CONTRIBUTING guide

## 0.2.0

- Symbol / import graph expansion on search
- Commit lineage (recent git history as searchable chunks)
- Watch-mode incremental indexer

## 0.1.0

- Hybrid BM25 + optional OpenAI-compatible embeddings
- SQLite incremental index
- MCP server + CLI + library API
