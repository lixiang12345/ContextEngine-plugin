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

- **Node.js ≥ 22.5**
- **PostgreSQL with pgvector** (or the included local Compose service)
- Git (for clone)

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install
npm run build
# optional global CLI:
npm link
```

Start the local service once, or point `CONTEXTENGINE_DATABASE_URL` at an existing
PostgreSQL server:

```bash
npm run db:up
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
```

Indexes live in PostgreSQL and are isolated by workspace root. SQLite is only a legacy
migration source.

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
        "CONTEXTENGINE_AUTO_INDEX": "1",
        "CONTEXTENGINE_MCP_WATCH": "1"
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
contextengine index          # writes dense vectors into pgvector
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

> Neural `/v1/rerank` is an optional second stage, disabled by default. Set
> `CONTEXTENGINE_NEURAL_RERANK=1` only after the API benchmark confirms meaningful score
> spread; the default remains hybrid FTS + symbol + semantic + code-aware feature scoring.

---

## Agent tools (MCP)

| Tool | When to use |
|------|-------------|
| `codebase-retrieval` / `codebase_retrieval` / `get_task_context` | Augment-compatible first call for a coding task (packed hits under token budget) |
| `codebase_search` | Follow-up / narrower queries |
| `get_file_context` | Read a known path / line range |
| `index_status` | Stats |
| `reindex_workspace` | After large refactors if auto-index is off |

Tip: **retrieve → edit**, not grep-loop.

The MCP watcher is enabled by default and monitors the workspace plus any
`CONTEXTENGINE_EXTRA_ROOTS` (`name:path,name:path`) entries. It debounces file
changes and refreshes the search index. Set `CONTEXTENGINE_MCP_WATCH=0` to
disable it; when disabled, `CONTEXTENGINE_AUTO_INDEX=1` controls first-use
index creation if no index exists.

Templates:

- [examples/claude-code.mcp.json](../examples/claude-code.mcp.json)
- [examples/cursor.mcp.json](../examples/cursor.mcp.json)
- [examples/contextengineignore.example](../examples/contextengineignore.example)

---

## Configuration cheat sheet

| Variable | Purpose |
|----------|---------|
| `CONTEXTENGINE_ROOT` | Workspace root for MCP |
| `CONTEXTENGINE_EXTRA_ROOTS` | Optional comma-separated `name:path` roots to index and watch |
| `CONTEXTENGINE_DATABASE_URL` / `DATABASE_URL` | Required PostgreSQL connection URL |
| `CONTEXTENGINE_DATA_DIR` | Legacy SQLite directory used only by `migrate-sqlite` |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = index on first MCP use if missing |
| `CONTEXTENGINE_MCP_WATCH` | MCP watcher; enabled by default, `0`/`false` disables |
| `CONTEXTENGINE_COMMIT_LIMIT` | Recent commits to index (default `80`, `0` = off) |
| `CONTEXTENGINE_SEARCH_SEMANTIC_TIMEOUT_MS` / `_RERANK_TIMEOUT_MS` | Per-query model timeout budgets (default `2000` ms) |
| `CONTEXTENGINE_SEARCH_BREAKER_FAILURE_THRESHOLD` / `_COOLDOWN_MS` | Model circuit threshold/cooldown (default `3` / `30000` ms) |
| `CONTEXTENGINE_EXCLUDE` | Extra ignore globs |
| `OPENAI_API_KEY` / `CONTEXTENGINE_EMBEDDING_API_KEY` | Enable embeddings |
| `OPENAI_BASE_URL` / `CONTEXTENGINE_EMBEDDING_BASE_URL` | Embeddings API origin or `/v1` base; both forms are accepted |
| `OPENAI_EMBEDDING_MODEL` / `CONTEXTENGINE_EMBEDDING_MODEL` | Model id |
| `CONTEXTENGINE_EMBED_BATCH` | Chunks per embed request (default `8`; lower on OOM) |
| `CONTEXTENGINE_EMBED_MAX_CHARS` | Truncate chunk text before embed |
| `CONTEXTENGINE_EMBED_QUERY_INSTRUCT` | Override query instruct prefix (Qwen3-style) |
| `CONTEXTENGINE_EMBEDDING_INPUT_TYPE` | `1` sends Qwen3 v2 `input_type=document/query`; leave unset for generic OpenAI gateways |
| `CONTEXTENGINE_API_TIMEOUT_MS` / `_RETRIES` | Remote API timeout (default `120000`) and bounded retries (default `2`) |
| `CONTEXTENGINE_NEURAL_RERANK` | `1` = optional neural `/v1/rerank` second stage |
| `CONTEXTENGINE_RERANK_MODEL` | Rerank model (default Qwen3-Reranker-0.6B) |
| `CONTEXTENGINE_RERANK_TOP_N` / `_WEIGHT` | Candidates + blend weight |
| `CONTEXTENGINE_RERANK_INSTRUCTION` | Optional task instruction for rerank APIs that support it |

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

# public endpoint smoke benchmark (embedding + rerank)
npm run bench:api
```

Bench methodology and saved numbers: [MULTILANG_BENCH.md](./MULTILANG_BENCH.md) · [EVALUATION.md](../EVALUATION.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| PostgreSQL / pgvector error | Start `npm run db:up` or set `CONTEXTENGINE_DATABASE_URL` to a pgvector-enabled server |
| Search only finds exact tokens | Enable Path B or C embeddings, then **re-index** |
| `Embedding API 5xx` / CUDA OOM | `CONTEXTENGINE_EMBED_BATCH=4` or `1`; restart uvicorn |
| MCP finds wrong repo | Set `CONTEXTENGINE_ROOT` or `cwd` to the workspace |
| Index empty / stale | `contextengine index` or MCP `reindex_workspace` |
| Tunnel works but client fails | Set the current tunnel origin or its `/v1` base; ContextEngine accepts either |
| Too much noise from tests/vendor | Add `.contextengineignore` / `.augmentignore` (see examples) |

---

## What this is / isn’t

**Is:** portable retrieval layer (CLI + MCP + library) for coding agents.  
**Isn’t:** multi-tenant SaaS, 100M-LOC monorepo product, or a drop-in Augment commercial replacement.

Honest scope: [COMPARISON.md](../COMPARISON.md) · design: [ARCHITECTURE.md](../ARCHITECTURE.md).
