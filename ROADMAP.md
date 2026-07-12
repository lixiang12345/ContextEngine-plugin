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
- [ ] Better TypeScript/Python AST chunking (tree-sitter optional peer)

## Phase 3 — Productization (0.3.x)

- [ ] Retrieval eval harness + golden tasks
- [ ] Multi-repo profiles
- [ ] Remote index sharing (optional)
- [ ] Published npm package CI
- [ ] Example configs for Claude Code / Cursor / Codex
