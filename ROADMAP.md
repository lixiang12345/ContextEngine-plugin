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

## Future (optional, not blocking 1.0-usable)

- [ ] Code-specialized embeddings / hard-negative training
- [ ] SCIP / tsc / gopls symbol providers
- [ ] Docs / wiki connectors
- [ ] Distributed / remote index for huge monorepos
- [ ] npm publish automation
