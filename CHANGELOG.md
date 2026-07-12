# Changelog

## Unreleased

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
