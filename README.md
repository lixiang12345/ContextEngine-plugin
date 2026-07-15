# ContextEngine Plugin

**Portable, Augment-class codebase context for AI coding agents.**

Multi-signal retrieval (PostgreSQL FTS + symbols + path + pgvector + graph + MMR) so agents spend fewer tokens grepping and more turns shipping correct changes.

**中文文档：** [README.zh-CN.md](./README.zh-CN.md)

See [ARCHITECTURE.md](./ARCHITECTURE.md) and honest [COMPARISON.md](./COMPARISON.md) vs Augment.

**New here?** Start with the path that matches your setup:

| Path | Doc |
|------|-----|
| BM25-only / cloud embed / self-host GPU | **[docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md)** |
| GPU ops (Qwen3 embed+rerank) | [docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md) |
| Multi-lang IR numbers | [docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md) |
| Remote IDE / HTTP sync API | [docs/HTTP_API.md](./docs/HTTP_API.md) |

```bash
# index
npx contextengine-plugin index

# search
npx contextengine-plugin search "stripe payment webhook"

# pack context for a task
npx contextengine-plugin context "Add logging to payment requests"
```

---

## Why this exists

Most coding agents explore large repos with repeated `grep` / `find` tool calls. That wastes tokens and still misses the right files.

**ContextEngine** is a small, self-contained retrieval layer:

| Capability | Status |
|------------|--------|
| Query understanding | Intent + identifier / path extraction |
| Lexical search | PostgreSQL `tsvector` + GIN (scales) |
| Symbol search | Exact / prefix symbol table |
| Semantic search | Optional embeddings, **two-stage** on candidates |
| Fusion + rerank | RRF + code-aware feature scorer |
| Diversity pack | MMR by path under token budget |
| Symbol / import graph | Expand related files |
| Multi-root | Code + docs/extra repos in one index |
| Commit lineage | Recent git history chunks |
| Watch mode | Debounced incremental re-index |
| MCP | `codebase_retrieval` (primary) + search/file/index tools |
| HTTP | Authenticated workspace sync, index jobs, retrieval, and SSE progress |
| Eval | Recall@k, **MRR**, **nDCG@k** |

**Honest comparison with Augment:** [COMPARISON.md](./COMPARISON.md) · **Design:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Install

### Requirements

- **Node.js ≥ 22.5**
- **PostgreSQL with pgvector** (local Compose is included)

### From source (this repo)

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install
npm run build
npm link   # optional: expose `contextengine` globally
```

### As a library

```bash
npm install contextengine-plugin
```

```ts
import { ContextEngine } from "contextengine-plugin";

const engine = ContextEngine.open({ root: process.cwd() });
await engine.index();
const hits = await engine.search({ query: "auth middleware" });
```

---

## Quick start

### 1. Index a workspace

```bash
# From this repository, start the included local pgvector service once:
npm run db:up
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine

contextengine index
# or
contextengine index /path/to/repo
```

Indexes are stored in PostgreSQL. The workspace absolute root is the namespace, so one
database can safely hold many repositories without loading their vectors into process
memory.

`data-dir` is retained only to locate legacy SQLite indexes for one-time migration.

### 2. Search

```bash
contextengine search "how is rate limiting implemented"
contextengine search "processPayment" --mode bm25 -k 5
```

### 3. Pack agent context

```bash
contextengine context "Add retry logic to the payment webhook"
```

### 4. Status

```bash
contextengine status
```

---

## Semantic search (optional)

Without an API key, ContextEngine runs in **BM25-only** mode (still useful).

With an OpenAI-compatible embeddings endpoint:

```bash
export OPENAI_API_KEY=sk-...
# optional overrides:
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small

contextengine index   # embeds new/changed chunks
contextengine search "checkout timeout" --mode hybrid
```

Also accepted:

- `CONTEXTENGINE_EMBEDDING_API_KEY`
- `CONTEXTENGINE_EMBEDDING_BASE_URL`
- `CONTEXTENGINE_EMBEDDING_MODEL`

Works with OpenAI, many proxies, and local servers that expose `/v1/embeddings` (e.g. Ollama-compatible gateways).
The base URL may be either the origin (for example, `https://gateway.example.com`) or the
versioned base (`https://gateway.example.com/v1`); ContextEngine normalizes both forms.

### Self-host Qwen3 on GPU (production path)

Validated stack for multi-language semantic search (~2.2 GB VRAM):

| Role | Model |
|------|--------|
| Embedding | `Qwen/Qwen3-Embedding-0.6B` |
| Reranker (optional API) | `Qwen/Qwen3-Reranker-0.6B` |

```bash
# On GPU host — see full guide
# docs/DEPLOY_EMBED_RERANK.md  +  scripts/embed_rerank_server.py

# On laptop (SSH tunnel):
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8
# Optional: include the deployed /v1/rerank stage in searches.
# export CONTEXTENGINE_NEURAL_RERANK=1
# export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
contextengine index
```

**Deploy guide:** [docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md) ·  
**Multi-lang bench (Top5≈0.98, MRR≈0.93):** [docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)

---

## MCP integration

ContextEngine speaks **Model Context Protocol** over stdio.

### Claude Code

```bash
claude mcp add contextengine -- node /absolute/path/to/ContextEngine-plugin/dist/mcp-server.js
```

Or after `npm link`:

```bash
claude mcp add contextengine -- contextengine-mcp
```

Environment (optional):

```bash
export CONTEXTENGINE_ROOT=/path/to/repo
export CONTEXTENGINE_AUTO_INDEX=1
export OPENAI_API_KEY=...
```

### Cursor / other MCP clients

Add an MCP server entry pointing at:

```text
command: node
args: ["/absolute/path/to/ContextEngine-plugin/dist/mcp-server.js"]
```

Set `cwd` to the workspace you want indexed (or set `CONTEXTENGINE_ROOT`).

### Tools exposed

| Tool | Purpose |
|------|---------|
| `codebase_search` | Hybrid search → path, lines, symbol, content |
| `get_task_context` | Pack ranked chunks under a token budget |
| `get_file_context` | Read a file / line range |
| `index_status` | Index stats |
| `reindex_workspace` | Incremental re-index |

**Agent tip:** call `get_task_context` first, then edit. Use `codebase_search` for follow-up queries.

---

## HTTP service

The same retrieval core is available as an authenticated HTTP service for remote
IDE clients. Source files are content-addressed Blobs in PostgreSQL; a client syncs
only changed hashes, commits a workspace revision, and observes a background index
job before querying.

```bash
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
export CONTEXTENGINE_HTTP_API_KEY="$(openssl rand -base64 32)"

contextengine-http
# GET /health, GET /openapi.json
# all /v1 routes use Authorization: Bearer <key>
```

Core endpoints are workspace create/list, `/sync/plan`, `PUT /blobs/{sha256}`,
`/sync/commit`, `/index-jobs`, `/search`, `/context`, and `/file`.

See the complete client contract, payloads, SSE job stream, and packaged IntelliJ
plugin mapping in [docs/HTTP_API.md](./docs/HTTP_API.md).

---

## CLI reference

```text
contextengine index [root] [--quiet]
contextengine search <query> [-k N] [--mode auto|bm25|semantic|hybrid] [--path-prefix p] [--json]
contextengine context <task> [--max-tokens N] [--json]
contextengine status
contextengine clear-index
contextengine migrate-sqlite <legacy-index.db>
contextengine watch [root] [--debounce 800]   # live re-index
contextengine serve [--auto-index]            # MCP stdio
contextengine http [--host 127.0.0.1] [--port 8787]  # authenticated HTTP service
contextengine eval [--self | --cases file.json] [--reindex]
contextengine profile list|add|use …
```

### Retrieval output

ContextEngine is model-neutral. It retrieves, reranks, deduplicates, and formats
the complete evidence selected by `topK` without inspecting model names or
context-window sizes. Callers may provide `maxTokens` / `max_tokens` when they
explicitly need a smaller packed payload; omitting it returns all selected hits.

---

## Configuration

| Env | Meaning |
|-----|---------|
| `CONTEXTENGINE_DATABASE_URL` / `DATABASE_URL` | **Required** PostgreSQL connection URL; pgvector is enabled automatically |
| `CONTEXTENGINE_ROOT` | Workspace root for MCP |
| `CONTEXTENGINE_DATA_DIR` | Legacy SQLite directory used only by `migrate-sqlite` |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = index on first MCP use if missing |
| `CONTEXTENGINE_HTTP_API_KEY` | Required Bearer key for HTTP service |
| `CONTEXTENGINE_HTTP_HOST` / `_PORT` | HTTP bind address and port |
| `CONTEXTENGINE_HTTP_MAX_BLOB_BYTES` | Max bytes per synced source Blob (default 2 MiB) |
| `CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES` | Allow server-local workspace roots (default off) |
| `CONTEXTENGINE_COMMIT_LIMIT` | How many recent commits to index (default `80`, `0` = off) |
| `OPENAI_API_KEY` / `CONTEXTENGINE_EMBEDDING_API_KEY` | Enable embeddings |
| `OPENAI_BASE_URL` / `CONTEXTENGINE_EMBEDDING_BASE_URL` | Embeddings API base |
| `OPENAI_EMBEDDING_MODEL` / `CONTEXTENGINE_EMBEDDING_MODEL` | Model name |
| `CONTEXTENGINE_EMBED_BATCH` | Embed batch size (default `8`) |
| `CONTEXTENGINE_EMBED_MAX_CHARS` | Truncate chunk text before embed |
| `CONTEXTENGINE_NEURAL_RERANK` | `1` = enable optional neural `/v1/rerank` second stage |
| `CONTEXTENGINE_RERANK_MODEL` | Rerank model id (default `Qwen/Qwen3-Reranker-0.6B`) |
| `CONTEXTENGINE_RERANK_BASE_URL` | Rerank API base (defaults to embed base) |
| `CONTEXTENGINE_RERANK_TOP_N` | Candidates sent to reranker (default `20`) |
| `CONTEXTENGINE_RERANK_WEIGHT` | Blend weight into final score (default `0.32`) |

### Ignore / exclude rules (Augment-compatible)

Indexing **filters** files like Augment Context Connectors:

1. **Built-in smart filters** — `node_modules/`, `vendor/`, `dist/`, `build/`, `target/`, binaries, locks, `.env` secrets, IDE junk, …
2. **`.gitignore`** (root + nested directory rules)
3. **`.augmentignore`** (same semantics as Augment; supports `!` re-include)
4. **`.contextengineignore`** (product-specific)
5. **CLI / env** — `contextengine index --exclude 'vendor/**' '**/*.generated.*'` or `CONTEXTENGINE_EXCLUDE=...`

Example `.augmentignore` (from Augment docs pattern):

```bash
# re-include something that is gitignored
!some-tracked-deps/

# exclude fixtures / local data
data/test.json
*.tmp
```

---

## Library API

```ts
import { ContextEngine } from "contextengine-plugin";

const engine = ContextEngine.open({ root: "/repo" });

await engine.index((p) => console.log(p.phase, p.filesDone));
const stats = await engine.stats();
const hits = await engine.search({ query: "…", topK: 8, mode: "auto" });
const packed = await engine.getTaskContext({
  task: "…",
  // Optional caller-controlled transport cap: maxTokens: 16_000,
});
await engine.close();
```

---

## Multi-repo profiles

```bash
contextengine profile add app --root ~/work/my-app
contextengine profile add api --root ~/work/my-api
contextengine profile use app
contextengine profile list
```

Writes `contextengine.profiles.json` (see `examples/contextengine.profiles.example.json`).

## Eval

```bash
# Built-in cases against this repository
contextengine eval --self --reindex

# Custom cases
contextengine eval --cases examples/eval.sample.json --root /path/to/repo

# Mid-size practice (Express 4.x layout) — IR metrics + incremental timing
# git clone --depth 1 --branch 4.21.2 https://github.com/expressjs/express.git /tmp/express4
node scripts/practice-eval.mjs --root /tmp/express4 --cases examples/eval.express.json
```

Practice report (methodology + multi-repo suite + watch): **[EVALUATION.md](./EVALUATION.md)**.  
Code embedding model choices: **[docs/EMBEDDINGS.md](./docs/EMBEDDINGS.md)**.  
GPU embed + rerank deploy: **[docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md)**.  
Multi-language IR metrics: **[docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)**.

```bash
# Multi-repo mid-size suite (clones under /tmp/ce-bench)
node scripts/bench-suite.mjs

# Multi-language OSS suite (needs embeddings endpoint)
npm run bench:multilang

# Remote API smoke benchmark: 10 query languages × 10 code languages,
# validates /health, /v1/embeddings, and /v1/rerank.
npm run bench:api
```

For temporary Colab / TryCloudflare deployments, set the current base URL and API key
only in a local `.env` or shell session. The runner preflights the remote server before
cloning repositories, so an expired tunnel cannot produce a misleading score.
## Development

```bash
npm install
npm run build
npm test
npm run eval:self
npm run cli -- index
npm run mcp
```

---

## Roadmap

### Phase 1 — ✅ `0.1.0`

- Hybrid BM25 + optional embeddings
- Incremental PostgreSQL + pgvector index
- MCP + CLI + library
- Task context packing

### Phase 2 — ✅ `0.2.0`

- Symbol / import graph expansion on search
- Watch-mode incremental indexer
- Commit lineage (recent git history in the index)

### Phase 3 — ✅ `0.3.x`

- Eval harness (`contextengine eval --self`)
- Multi-repo profiles (`contextengine profile`)
- Example MCP configs under `examples/`
- CI, index export/import, comparison doc vs Augment

### Phase 4 — ✅ `0.4.0` (Augment-class stack)

- PostgreSQL FTS + symbol + path multi-signal retrieval
- Query analyzer, feature rerank, MMR pack
- Multi-root / docs roots
- `codebase_retrieval` MCP tool
- MRR + nDCG metrics

---

## vs Augment Context Engine

We are an **open portable component**, not a full commercial context platform.

| | This repo | Augment |
|--|-----------|---------|
| Custom code retrieval models | ❌ BYO embeddings | ✅ |
| Multi-source (docs/wikis/org) | ❌ | ✅ |
| Monorepo / enterprise scale | ⚠️ medium | ✅ |
| Open source / offline | ✅ | ❌ product |
| MCP + hybrid search | ✅ | ✅ |

Details: **[COMPARISON.md](./COMPARISON.md)**.

## Design notes

1. **Agent-native, not chat-native** — results always include path + line range for grounded edits.
2. **Works offline** — BM25 alone is a valid mode; embeddings are an upgrade.
3. **Database-native retrieval** — pgvector handles vector persistence and ANN; only candidate chunks enter Node memory.
4. **Composable** — use as MCP plugin, CLI, or embed in your own agent loop.
5. **Honest scope** — optimize for ownership and hackability; do not claim Augment parity.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Acknowledgements

Inspired by the broader “context engineering” movement and products like Augment Context Engine, Sourcegraph, and the MCP ecosystem. This project aims to be a **small, open, portable** building block rather than a full IDE suite.
