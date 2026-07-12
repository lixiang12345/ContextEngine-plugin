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
| Lexical | SQLite **FTS5** BM25 over path/symbol/content | Scales past in-memory maps; monorepo-ready |
| Exact structure | Symbol table + path basename boost | Beats pure vectors on “find `processPayment`” |
| Semantic | Optional embeddings, **two-stage**: FTS candidates → embed rerank | Quality of hybrid without scanning all vectors every time |
| Fusion | Reciprocal Rank Fusion across channels | Robust when one channel is wrong |
| Rerank | Feature scorer (symbol/path/ident/overlap/lang) | Cheap “code-aware” ranking without a cross-encoder |
| Expand | Import/symbol graph | Related files Augment-style |
| Pack | MMR diversity + token budget | Fewer tokens, less duplicate noise |
| Multi-source | Multi-root + docs roots in one index | Partial multi-source story |
| Eval | Recall + MRR + nDCG@k | Continuous quality bar |

## What remains behind Augment (honest)

1. Custom paired code retrieval models  
2. Org-scale connectors (Jira, Confluence, multi-host)  
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
      FTS5 BM25    Symbol/Path    Semantic*
         │             │             │
         └─────────────┼─────────────┘
                       ▼
                    RRF fuse
                       ▼
                 Feature rerank
                       ▼
                 Graph expand
                       ▼
                  MMR pack ──► agent / MCP
```

\*Semantic: embed query once; score only top‑N FTS/symbol candidates when corpus is large.
