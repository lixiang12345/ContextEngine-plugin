# Changelog

## Unreleased

- Added multi-principal constant-time Bearer authentication, workspace reader/writer/owner ACLs, principal-bound MCP sessions, admin-only observability/model controls, and workspace-scoped Blob possession proofs.
- Added a read-only GitHub repository connector with bounded tree/Blob reads, incremental cursor-based synchronization, atomic source/index-job commits, source status APIs, dashboard sync controls, and credential redaction.
- Added versioned PostgreSQL migrations through schema v4 for workspace ACLs, Blob grants, connector sources/files, durable connector attempt leases, database-clock sync-session TTL fencing, concurrent Blob uploads, sync-plan ownership fencing, and rolling-upgrade transition guards, including cross-process migration and end-to-end isolation regression coverage.
- Added a multi-stage production Docker image and a complete Docker Compose deployment for the HTTP service plus PostgreSQL/pgvector, including health checks and persistent volumes.
- Added a self-contained `/dashboard` observability UI with workspace/index health, recent jobs, process metrics, route latency/error telemetry, and a live retrieval probe.
- Refreshed the dashboard with responsive cards, light/dark themes, keyboard search focus, loading feedback, toast notifications, API-key visibility controls, and copyable result locations.
- Added authenticated `GET /v1/observability/overview`; request telemetry records only normalized routes, status codes, and timings, never request payloads or API keys.
- Hardened local file access and HTTP workspace roots with real-path boundary checks, and added an opt-in policy for private-network model endpoints to reduce path traversal and SSRF exposure.
- Bounded unmatched telemetry routes to a single normalized label and bound Docker Compose PostgreSQL to loopback by default.
- Parallelized independent lexical retrieval channels and hybrid lexical/semantic lookup, capped identifier/path fan-out, and made explicit semantic search fall back to lexical results when embeddings are unavailable.
- Added Unicode-aware tokenization with accent folding and CJK bigrams for multilingual lexical search.
- Batched PostgreSQL chunk, symbol, import, and embedding writes and switched missing-vector scans to keyset pagination to reduce indexing round trips.
- Added a schema-local PostgreSQL version marker so independently started workers skip already-applied DDL, with a cross-process lock regression test.
- Made local and Blob-backed indexing close database pools reliably, clear stale entries for unreadable, oversized, deleted, or binary replacements, and enforce limits from authoritative Blob byte sizes.
- CI now exercises the PostgreSQL/pgvector integration suites and self-evaluation against a real service; builds clean stale `dist` output before compilation.
- Retrieval output is model-neutral: ContextEngine no longer tracks model names, context windows, or reserved output tokens.
- Library, CLI, MCP, and HTTP retrieval entrypoints return all reranked `topK` hits by default; explicit `max_tokens` remains an optional caller-controlled transport cap.
- Natural-language queries no longer classify ordinary prose words as code symbols; structured identifiers and acronyms still route through the symbol channel.
- Chunk-level candidates are collapsed and reranked at file level so evidence spread across class headers and methods can compete with repetitive documentation.
- Lexical retrieval keeps a deeper candidate pool before file aggregation so large files with evidence spread across methods are not truncated prematurely.
- MMR no longer treats a shared deep source/package prefix as near-duplicate content, preserving relevant files from the same subsystem.
- Diversified search now returns at most the requested `topK` unique file representatives, improving recall without duplicate chunks consuming result slots.
- Added `contextengine eval-pr` for isolated baseline/context agent runs with hidden fail-to-pass tests, bounded tracked/untracked patch capture, structured usage metrics, and JSON/Markdown reports.
- Hardened PR evaluation with a separate sanitized baseline-oracle workspace, raw/agent-prompt/context evidence hashes, all `none x packed` comparisons, resolved base/gold commit reporting, and POSIX process-group cleanup (Windows uses a direct-child fallback).
- Added repetition-aware `case@repetition` pairing plus a three-case fixed historical PR corpus with pinned base/gold commits, unique new-test-file oracles, and a CI fail-to-pass validation command.

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
