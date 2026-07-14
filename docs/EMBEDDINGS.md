# Code embedding models for ContextEngine

This project works **without** embeddings (PostgreSQL FTS + symbols + feature rerank).
Embeddings close the gap on **conceptual / paraphrased** queries where pure lexical ranking loses to docs/tests.

**Download list (HF IDs + CLI):** [MODELS_DOWNLOAD.md](./MODELS_DOWNLOAD.md)

## What we need from a model

| Requirement | Why |
|-------------|-----|
| **Code-aware** (or code+NL dual) | Docstrings, identifiers, call sites |
| **OpenAI-compatible HTTP** `/v1/embeddings` | Current provider is drop-in |
| Stable dimensions per model | Enables a pgvector HNSW index per embedding dimension |
| Stable batch API | Index thousands of chunks |
| Ideally trained with **retrieval** objective | Not only next-token LM |

We do **not** need a generative coding model (Codex/Claude). We need a **bi-encoder / embedding** model.

## Recommended (priority order)

### 1. Best practical default (API)

| Model | Provider | Notes |
|-------|----------|--------|
| **`voyage-code-3`** | [Voyage AI](https://www.voyageai.com/) | Strong code retrieval; use Voyage’s OpenAI-compatible endpoint if available, or a thin proxy |
| **`text-embedding-3-large`** | OpenAI | Good general + code; not code-specialized but solid two-stage rerank |
| **`text-embedding-3-small`** | OpenAI | Cheap default already supported (`OPENAI_EMBEDDING_MODEL`) |
| **`jina-embeddings-v3` / jina-code** | Jina | Competitive OSS-friendly API |

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # or compatible proxy
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Prefer Voyage when you have a key (example — set their base URL):
# export CONTEXTENGINE_EMBEDDING_API_KEY=...
# export CONTEXTENGINE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1
# export CONTEXTENGINE_EMBEDDING_MODEL=voyage-code-3

contextengine index
```

### 2. Best open weights (local / self-host)

| Model | Notes |
|-------|--------|
| **`Qwen/Qwen3-Embedding-0.6B`** | **Production default** in our multi-lang bench (~2GB VRAM w/ reranker); instruct-aware |
| **`nomic-embed-code`** / Nomic code embeds | Strong open code retrieval line |
| **`jina-embeddings-v2-base-code`** | Code-focused, embed via TEI / local server |
| **`BAAI/bge-code-*`** (if available in your stack) | Code retrieval family |
| **`Salesforce/SFR-Embedding-Code`** | Research-grade code embedders |

**GPU deploy (Qwen3 embed + optional Qwen3 rerank):**  
→ full guide [DEPLOY_EMBED_RERANK.md](./DEPLOY_EMBED_RERANK.md) · server script `scripts/embed_rerank_server.py`

Serve any of these behind an **OpenAI-compatible** `/v1/embeddings` (e.g. our FastAPI server, [Ollama](https://ollama.com), [llama.cpp server](https://github.com/ggerganov/llama.cpp), [Hugging Face TEI](https://github.com/huggingface/text-embeddings-inference), [vLLM](https://github.com/vllm-project/vllm)):

```bash
# Production path used for multilang bench (SSH tunnel to GPU box)
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8
export CONTEXTENGINE_EMBED_MAX_CHARS=3000

# Or Ollama-style local:
# export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
# export OPENAI_API_KEY=ollama
# export OPENAI_EMBEDDING_MODEL=nomic-embed-text
```
### 3. What Augment has that we don’t

Augment trains **paired** query–code retrieval models on private + public code with hard negatives and agent-task feedback.  

To approach that with open stack:

1. Start from a strong code embedder (Voyage code / Jina code / Nomic code)  
2. Fine-tune with **in-batch + hard negative** pairs from your repos:  
   `(issue/PR description → files actually edited)`  
3. Keep our **two-stage** path: FTS candidates → embed rerank (cheap + accurate)

## How ContextEngine uses embeddings today

```text
index:  chunk text → embed → store a pgvector `vector` in PostgreSQL
query:  embed(query) once → PostgreSQL cosine KNN + lexical/symbol fusion
        fused with FTS + symbol + feature rerank (RRF)
```

Without an API key, semantic channel is **off**; FTS/symbol/rerank still run.

## Where vectors are stored

ContextEngine owns the retrieval index in PostgreSQL. One database can hold many
workspaces, isolated by the workspace absolute root:

```bash
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
```

The GPU/public embedding endpoint only generates vectors for a request; it does not
retain this workspace index. `--data-dir` is only for finding a legacy SQLite source when
running `contextengine migrate-sqlite`.

The runtime vector table is:

```sql
CREATE TABLE ce_embeddings (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id)
);
```

Each vector stays inside pgvector; the query uses database-side cosine KNN and an HNSW
index for its dimension. Node receives only the ranked candidate IDs and then fetches
their chunks, so a large repository does not require a process-wide vector map.

Legacy SQLite `float32` BLOB indexes can be imported once:

```bash
contextengine migrate-sqlite /path/to/.contextengine/index.db --root /path/to/repo
```

### Invalidation rules

The index records an `embedding_signature` containing the vector format version, model,
requested dimensions, Qwen query/document input mode, and maximum input length. When any
of those settings changes, ContextEngine clears stored embeddings and regenerates them on
the next `index` run. A legacy index without this signature is also rebuilt once. This
prevents mixing vectors produced by incompatible model settings.

## Sizing guide

| Corpus | Suggested model |
|--------|-----------------|
| < 50k LOC mid-size libs | `text-embedding-3-small` or local nomic/jina-code |
| Multi-repo / monorepo | `voyage-code-3` or `text-embedding-3-large` |
| Air-gapped | Local TEI + jina/nomic code embeds |
| Max quality research | Fine-tune code bi-encoder on your PR data |

## What we do **not** need

- GPT-4 / Claude as “embedding” (too slow/expensive for every chunk)  
- Full cross-encoder on entire corpus (use only optional top-20 rerank later)  
- Same model as chat agent (separation of concerns is fine)

## Current environment note

Multi-language production numbers (semantic ON, Qwen3-Embedding-0.6B):

| Metric | Macro mean |
|--------|------------|
| Top5 | ~0.98 |
| MRR | ~0.93 |
| Recall@k | ~1.00 |

See [MULTILANG_BENCH.md](./MULTILANG_BENCH.md) and `eval-results/multilang-summary.json`.

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
npm run bench:multilang
```
