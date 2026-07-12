# Roadmap

## Phase 1 — Core (0.1.x) ✅

- [x] Language-aware code chunking
- [x] BM25 lexical index
- [x] Optional OpenAI-compatible embeddings
- [x] Hybrid fusion (RRF)
- [x] SQLite storage + incremental file hashing
- [x] CLI: index / search / context / status / serve
- [x] MCP tools for coding agents
- [x] Library exports + tests

## Phase 2 — Graph & history (0.2.x) ✅

- [x] Import / symbol graph expansion on search
- [x] Watch-mode incremental indexer (`contextengine watch`)
- [x] Commit lineage: recent commits as searchable pseudo-chunks
- [x] Brace/indent-aware unit chunking (pure JS, no native tree-sitter)

## Phase 3 — Productization (0.3.x) ✅

- [x] Retrieval eval harness + self-eval cases (`contextengine eval`)
- [x] Multi-repo profiles (`contextengine profile`)
- [x] Example MCP configs (Claude Code / Cursor)
- [x] CONTRIBUTING + release checklist
- [x] GitHub Actions CI
- [x] Index export / import for offline share
- [x] COMPARISON vs Augment Context Engine

## Phase 4 — Augment-class quality (0.4.x) ✅

- [x] Query analyzer + intent routing
- [x] SQLite FTS5 scalable BM25
- [x] Symbol table + path channel
- [x] Feature rerank + RRF + MMR pack
- [x] Two-stage semantic (candidate → embed score)
- [x] Multi-root / docs roots
- [x] `codebase_retrieval` MCP primary tool
- [x] MRR + nDCG eval metrics

## Future (optional)

- [ ] Code-specialized embeddings / hard-negative training
- [ ] SCIP / tsc / gopls symbol providers
- [ ] HTTP docs / wiki connectors + auto-sync
- [ ] Distributed / remote index for huge monorepos
- [ ] Open PR-generation benchmark suite
- [ ] npm publish automation
