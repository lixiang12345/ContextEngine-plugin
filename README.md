# ContextEngine Plugin

**Portable codebase context for AI coding agents.**

Index your repository once. Give any MCP-compatible agent (Claude Code, Cursor, Codex, Zed, …) hybrid **BM25 + semantic** retrieval so it spends fewer tokens grepping and more turns shipping correct changes.

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
| Code chunking | Language-aware heuristics (TS/JS/Python/Go/Rust/Java/MD/…) |
| Lexical search | BM25 over path + symbol + content |
| Semantic search | Optional OpenAI-compatible embeddings |
| Fusion | Reciprocal Rank Fusion (hybrid) |
| Symbol / import graph | Expand hits via related files & symbols (Phase 2) |
| Commit lineage | Recent git history as searchable context (Phase 2) |
| Watch mode | Debounced incremental re-index (`contextengine watch`) |
| Storage | Local SQLite (`node:sqlite`, no native compile) |
| Agent interface | MCP tools + CLI + library API |
| Incremental index | Content-hash skip for unchanged files |

Phase 3 adds eval harness & multi-repo polish — see [ROADMAP](#roadmap).

---

## Install

### Requirements

- **Node.js ≥ 22.5** (uses built-in `node:sqlite`)

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
contextengine index
# or
contextengine index /path/to/repo
```

Index data is stored in:

```text
<repo>/.contextengine/index.db
```

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

## CLI reference

```text
contextengine index [root] [--data-dir dir] [--quiet]
contextengine search <query> [-k N] [--mode auto|bm25|semantic|hybrid] [--path-prefix p] [--json]
contextengine context <task> [--max-tokens N] [--json]
contextengine status
contextengine watch [root] [--debounce 800]   # live re-index
contextengine serve [--auto-index]            # MCP stdio
contextengine eval [--self | --cases file.json] [--reindex]
contextengine profile list|add|use …
```

---

## Configuration

| Env | Meaning |
|-----|---------|
| `CONTEXTENGINE_ROOT` | Workspace root for MCP |
| `CONTEXTENGINE_DATA_DIR` | Override index directory |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = index on first MCP use if missing |
| `CONTEXTENGINE_COMMIT_LIMIT` | How many recent commits to index (default `80`, `0` = off) |
| `OPENAI_API_KEY` / `CONTEXTENGINE_EMBEDDING_API_KEY` | Enable embeddings |
| `OPENAI_BASE_URL` / `CONTEXTENGINE_EMBEDDING_BASE_URL` | Embeddings API base |
| `OPENAI_EMBEDDING_MODEL` / `CONTEXTENGINE_EMBEDDING_MODEL` | Model name |

Ignore rules: respects `.gitignore` plus built-in defaults (`node_modules`, `dist`, binaries, …).  
Optional: `.contextengineignore` (gitignore syntax).

---

## Library API

```ts
import { ContextEngine } from "contextengine-plugin";

const engine = ContextEngine.open({ root: "/repo" });

await engine.index((p) => console.log(p.phase, p.filesDone));
const stats = engine.stats();
const hits = await engine.search({ query: "…", topK: 8, mode: "auto" });
const packed = await engine.getTaskContext({
  task: "…",
  maxTokens: 6000,
});
engine.close();
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
```

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
- Incremental SQLite index
- MCP + CLI + library
- Task context packing

### Phase 2 — ✅ `0.2.0`

- Symbol / import graph expansion on search
- Watch-mode incremental indexer
- Commit lineage (recent git history in the index)

### Phase 3 — ✅ `0.3.0`

- Eval harness (`contextengine eval --self`)
- Multi-repo profiles (`contextengine profile`)
- Example MCP configs under `examples/`

---

## Design notes

1. **Agent-native, not chat-native** — results always include path + line range for grounded edits.
2. **Works offline** — BM25 alone is a valid mode; embeddings are an upgrade.
3. **Zero native addons** — Node 22 `node:sqlite` only; easy to install.
4. **Composable** — use as MCP plugin, CLI, or embed in your own agent loop.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Acknowledgements

Inspired by the broader “context engineering” movement and products like Augment Context Engine, Sourcegraph, and the MCP ecosystem. This project aims to be a **small, open, portable** building block rather than a full IDE suite.
