# Architecture — competing with Augment-class context quality

## Goal

Match **agent-facing retrieval quality** of Augment Context Engine on small–large
local codebases without a proprietary embedding model or cloud control plane.

We cannot clone their trained models overnight. We **can** clone the system
pattern that makes those models effective:

```text
understand query → multi-signal retrieve → fuse → rerank → expand → pack
```

## Quality stack (v0.4)

| Layer | Implementation | Why it closes the gap |
|-------|----------------|------------------------|
| Query analysis | Identifiers, intent (symbol/path/concept/history), term expand | Structure-first like humans navigate code |
| Lexical | PostgreSQL `tsvector` + GIN over path/symbol/content | Scales past in-memory maps; database-side filtering |
| Exact structure | Symbol table + path basename boost | Beats pure vectors on “find `processPayment`” |
| Semantic | Optional embeddings, pgvector cosine KNN + HNSW | Quality of hybrid without loading all vectors into Node |
| Fusion | Reciprocal Rank Fusion across channels | Robust when one channel is wrong |
| Rerank | Feature scorer (symbol/path/ident/overlap/lang) | Cheap “code-aware” ranking without a cross-encoder |
| Neural rerank | Optional `/v1/rerank` blend on top-N (`CONTEXTENGINE_NEURAL_RERANK`) | Cross-encoder style second stage when GPU server is available |
| Expand | PostgreSQL import/symbol graph around retrieved candidates | Related files without a full in-memory graph |
| Pack | MMR diversity + token budget + pluggable `raw`/`extractive` policy | Fewer tokens, less duplicate noise; extractive keeps query-salient lines under a tight cap |
| Multi-source | Multi-root + provider-neutral source plugin SDK; GitHub built in | Extensible without weakening sync fencing |
| Eval | Recall + MRR + nDCG@k | Continuous quality bar |

## What remains behind Augment (honest)

1. Custom paired code retrieval models  
2. Built-in GitLab/Bitbucket/web/Jira/Confluence connectors and webhooks
3. Enterprise auth / shared cloud indexes  
4. Published PR-generation benchmarks  

Those are product/company investments. v0.4 maximizes **open, local quality**.

## Data flow

```text
                ┌─────────────┐
  query ───────►│ QueryAnalyzer│
                └──────┬──────┘
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
 PostgreSQL FTS   Symbol/Path    pgvector KNN*
         │             │             │
         └─────────────┼─────────────┘
                       ▼
                    RRF fuse
                       ▼
                 Feature rerank
                       ▼
              Neural rerank* (opt-in)
                       ▼
                 Graph expand
                       ▼
                  MMR pack ──► agent / MCP
```

\*Neural: `POST /v1/rerank` on top-N candidates; disabled unless `CONTEXTENGINE_NEURAL_RERANK=1`.

\*Semantic: embed query once; PostgreSQL scores the vector column and returns only top
candidates. HNSW is created per stored vector dimension.

## Transport and persistence

```text
local agent ── stdio MCP ─────────────────┐
                                           ▼
remote IDE ── HTTP Bearer API ── Blob plan/commit ──► PostgreSQL
                                           │             ├─ workspace revisions
                                           │             ├─ source Blobs + manifest
                                           │             ├─ chunks / FTS / symbols
                                           │             └─ pgvector embeddings
                                           ▼
                                    serialized index jobs
                                           ▼
                                  same ContextEngine retrieval core
```

The HTTP server does not accept a remote caller's filesystem path for Blob
workspaces. It stores a SHA-256-verified file Blob and a versioned manifest first,
then indexes changed files in a background job. This keeps large repositories
database-backed and lets IDE clients synchronize incrementally without a
process-wide vector cache.

See [docs/HTTP_API.md](./docs/HTTP_API.md) for the client contract.
