# Contributing

Thanks for helping improve ContextEngine.

## Setup

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install
npm run build
npm test
```

Requires **Node.js ≥ 22.5**.

## Project layout

```text
src/
  chunker/       # file → CodeChunk
  search/        # BM25 + hybrid fusion
  embeddings/    # OpenAI-compatible provider
  graph/         # symbol / import graph
  lineage/       # git commit harvesting
  indexer/       # crawl + watch
  store/         # SQLite
  eval/          # retrieval eval harness
  config/        # multi-repo profiles
  engine.ts      # public API
  cli.ts         # CLI
  mcp-server.ts  # MCP stdio server
```

## Guidelines

1. Keep the core **dependency-light** (no native addons beyond Node builtins).
2. Prefer agent-friendly outputs: **path + line range + content**.
3. Add/adjust tests under `test/` for behavior changes.
4. Run `npm test && npm run build` before opening a PR.
5. Optional: `npm run eval:self` after retrieval changes.

## Release checklist

- [ ] Bump `version` in `package.json` and CLI/MCP banners
- [ ] Update `README.md` / `ROADMAP.md`
- [ ] `npm test && npm run eval:self`
- [ ] Tag and push
