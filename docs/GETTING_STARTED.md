# Getting started — three paths

Pick **one** path. You can always upgrade later (BM25 → cloud embed → self-host GPU).

```text
                    ┌─────────────────────┐
                    │ Need semantic / NL? │
                    └──────────┬──────────┘
               no              │              yes
                ▼              │               ▼
        Path A: BM25-only      │     Have a GPU + want best open quality?
        (works offline)        │               │
                               │        yes    │    no / prefer API
                               │         ▼     │     ▼
                               │   Path C:     │  Path B: OpenAI-compatible
                               │   Qwen3 GPU   │  cloud / proxy embed
                               │   (prod bar)  │
```

| Path | GPU? | Quality | Best for |
|------|------|---------|----------|
| **A. BM25-only** | No | Good on identifiers / exact terms | Offline, quick trial, CI |
| **B. Cloud / proxy embed** | No | Strong conceptual queries | Most users |
| **C. Self-host Qwen3** | Yes (~2.2 GB) | **Production bar** we measured | Air-gapped / cost control / multi-lang |

Measured multi-lang bar (Path C): **Top5≈0.98, MRR≈0.93** — see [MULTILANG_BENCH.md](./MULTILANG_BENCH.md).

---

## Shared prerequisites

- **Node.js ≥ 22.5** (uses built-in `node:sqlite`)
- Git (for clone)

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install
npm run build
# optional global CLI:
npm link
```

Index lives at: `<repo>/.contextengine/index.db`

---

## Path A — BM25 only (fastest)

No API keys. Lexical + symbol + feature rerank still run.

```bash
cd /path/to/your/project
contextengine index
contextengine search "processPayment"
contextengine context "Add retry to payment webhook"
contextengine status
```

**MCP (Claude Code):**

```bash
claude mcp add contextengine -- node /absolute/path/to/ContextEngine-plugin/dist/mcp-server.js
```

**MCP (Cursor / JSON):** copy [examples/cursor.mcp.json](../examples/cursor.mcp.json), replace absolute paths:

```json
{
  "mcpServers": {
    "contextengine": {
      "command": "node",
      "args": ["/absolute/path/to/ContextEngine-plugin/dist/mcp-server.js"],
      "env": {
        "CONTEXTENGINE_ROOT": "/absolute/path/to/your/repo",
        "CONTEXTENGINE_AUTO_INDEX": "1"
      }
    }
  }
}
```

---

## Path B — Cloud / OpenAI-compatible embeddings

Any server that exposes `POST /v1/embeddings`.

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1          # or your proxy
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small      # or voyage-code-3, etc.

# optional aliases:
# CONTEXTENGINE_EMBEDDING_API_KEY / _BASE_URL / _MODEL

cd /path/to/your/project
contextengine index          # writes dense vectors into SQLite
contextengine search "how does auth middleware work" --mode auto
```

Model picks: [EMBEDDINGS.md](./EMBEDDINGS.md) · download list: [MODELS_DOWNLOAD.md](./MODELS_DOWNLOAD.md)

**MCP env example (add to the JSON above):**

```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_BASE_URL": "https://api.openai.com/v1",
  "OPENAI_EMBEDDING_MODEL": "text-embedding-3-small",
  "CONTEXTENGINE_ROOT": "/absolute/path/to/your/repo",
  "CONTEXTENGINE_AUTO_INDEX": "1"
}
```

---

## Path C — Self-host Qwen3 on GPU (production path)

This is the stack used for the multi-language production numbers.

| Piece | Value |
|-------|--------|
| Embed | `Qwen/Qwen3-Embedding-0.6B` |
| Rerank API (optional) | `Qwen/Qwen3-Reranker-0.6B` |
| Server | `scripts/embed_rerank_server.py` |
| VRAM | ~2.2–2.5 GB both loaded |

**Full ops guide:** [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md)

Short version:

```bash
# --- on GPU host ---
# 1) install deps + download models (see deploy doc)
# 2) start API
export EMBED_MODEL=/path/to/Qwen3-Embedding-0.6B
export RERANK_MODEL=/path/to/Qwen3-Reranker-0.6B   # optional
export CE_API_KEY=ce-local-key
python -m uvicorn scripts.embed_rerank_server:app --host 127.0.0.1 --port 8000 --workers 1

# --- on laptop ---
ssh -L 18000:127.0.0.1:8000 user@gpu-host

export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8
export CONTEXTENGINE_EMBED_MAX_CHARS=3000

contextengine index
contextengine search "how does authentication work" --mode auto
```

**MCP env for Path C:**

```json
{
  "CONTEXTENGINE_ROOT": "/absolute/path/to/your/repo",
  "CONTEXTENGINE_AUTO_INDEX": "1",
  "OPENAI_BASE_URL": "http://127.0.0.1:18000/v1",
  "OPENAI_API_KEY": "ce-local-key",
  "OPENAI_EMBEDDING_MODEL": "Qwen/Qwen3-Embedding-0.6B",
  "CONTEXTENGINE_EMBED_BATCH": "8",
  "CONTEXTENGINE_EMBED_MAX_CHARS": "3000"
}
```

> Neural `/v1/rerank` is available on the GPU server but **not** wired into the default search path. Ranking today is hybrid FTS + symbol + semantic + code-aware feature scorer.

---

## Agent tools (MCP)

| Tool | When to use |
|------|-------------|
| `get_task_context` / `codebase_retrieval` | First call for a coding task (packed hits under token budget) |
| `codebase_search` | Follow-up / narrower queries |
| `get_file_context` | Read a known path / line range |
| `index_status` | Stats |
| `reindex_workspace` | After large refactors if auto-index is off |

Tip: **retrieve → edit**, not grep-loop.

Templates:

- [examples/claude-code.mcp.json](../examples/claude-code.mcp.json)
- [examples/cursor.mcp.json](../examples/cursor.mcp.json)
- [examples/contextengineignore.example](../examples/contextengineignore.example)

---

## Configuration cheat sheet

| Variable | Purpose |
|----------|---------|
| `CONTEXTENGINE_ROOT` | Workspace root for MCP |
| `CONTEXTENGINE_DATA_DIR` | Override index directory |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = index on first MCP use if missing |
| `CONTEXTENGINE_COMMIT_LIMIT` | Recent commits to index (default `80`, `0` = off) |
| `CONTEXTENGINE_EXCLUDE` | Extra ignore globs |
| `OPENAI_API_KEY` / `CONTEXTENGINE_EMBEDDING_API_KEY` | Enable embeddings |
| `OPENAI_BASE_URL` / `CONTEXTENGINE_EMBEDDING_BASE_URL` | Embeddings API base (must include `/v1` host path as used by the server) |
| `OPENAI_EMBEDDING_MODEL` / `CONTEXTENGINE_EMBEDDING_MODEL` | Model id |
| `CONTEXTENGINE_EMBED_BATCH` | Chunks per embed request (default `8`; lower on OOM) |
| `CONTEXTENGINE_EMBED_MAX_CHARS` | Truncate chunk text before embed |
| `CONTEXTENGINE_EMBED_QUERY_INSTRUCT` | Override query instruct prefix (Qwen3-style) |

Full CLI: see root [README.md](../README.md).

---

## Verify install

```bash
# unit tests (no GPU)
npm test

# self-eval against this repo (BM25 or embed if configured)
npm run eval:self

# multi-language suite (needs Path B or C embeddings)
npm run bench:multilang
```

Bench methodology and saved numbers: [MULTILANG_BENCH.md](./MULTILANG_BENCH.md) · [EVALUATION.md](../EVALUATION.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `node:sqlite` / engine errors | Upgrade to **Node ≥ 22.5** |
| Search only finds exact tokens | Enable Path B or C embeddings, then **re-index** |
| `Embedding API 5xx` / CUDA OOM | `CONTEXTENGINE_EMBED_BATCH=4` or `1`; restart uvicorn |
| MCP finds wrong repo | Set `CONTEXTENGINE_ROOT` or `cwd` to the workspace |
| Index empty / stale | `contextengine index` or MCP `reindex_workspace` |
| Tunnel works but client fails | `OPENAI_BASE_URL` should be `http://127.0.0.1:18000/v1` (with `/v1`) |
| Too much noise from tests/vendor | Add `.contextengineignore` / `.augmentignore` (see examples) |

---

## What this is / isn’t

**Is:** portable retrieval layer (CLI + MCP + library) for coding agents.  
**Isn’t:** multi-tenant SaaS, 100M-LOC monorepo product, or a drop-in Augment commercial replacement.

Honest scope: [COMPARISON.md](../COMPARISON.md) · design: [ARCHITECTURE.md](../ARCHITECTURE.md).
