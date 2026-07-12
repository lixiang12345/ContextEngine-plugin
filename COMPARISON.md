# ContextEngine vs Augment Code Context Engine

This document is an honest capability gap analysis.  
**ContextEngine-plugin** is an open, portable retrieval layer.  
**Augment Context Engine** is a commercial, productized context platform.

Last updated: 2026-07-13 (based on public Augment product pages / MCP docs).

---

## One-line positioning

| | **This project (ContextEngine-plugin)** | **Augment Context Engine** |
|--|----------------------------------------|----------------------------|
| What it is | Open-source hybrid retrieval + MCP for any agent | Hosted + local enterprise context platform with custom models |
| Goal | Portable building block you own | Maximize agent PR quality on large real codebases |
| License / model | MIT, self-host | Commercial (free tier for MCP queries) |

---

## Feature comparison

| Capability | ContextEngine-plugin | Augment Context Engine | Gap severity |
|------------|----------------------|------------------------|--------------|
| MCP for Claude Code / Cursor / Zed | ✅ stdio MCP tools | ✅ polished multi-client MCP | Low |
| Hybrid lexical + semantic search | ✅ BM25 + optional embeddings + RRF | ✅ specialized semantic retrieval | **High** (model quality) |
| Code-native embeddings | ⚠️ Bring-your-own OpenAI-compatible API | ✅ **paired / trained retrieval models** for code | **High** |
| Real-time local indexing | ✅ hash incremental + `watch` | ✅ local indexer, “next query reflects edits” | Medium |
| Large monorepo scale | ⚠️ SQLite in-process; OK for small–medium | ✅ production indexing at monorepo scale | **High** |
| Multi-repo / org index | ⚠️ local multi-**profiles** (switch roots) | ✅ multi-repo connectors, org-wide index | **High** |
| Non-code sources (docs, wikis, tickets) | ❌ not built | ✅ Context Connectors (docs, GitHub/GitLab, …) | **High** |
| Commit / history context | ✅ recent git log as searchable chunks | ✅ deeper Context Lineage / history products | Medium |
| Symbol / dependency awareness | ⚠️ lightweight import/symbol graph | ✅ deeper codebase understanding (proprietary) | **High** |
| Team index sharing | ⚠️ file export/import of SQLite | ✅ share indexes across team | Medium |
| Enterprise security / auth | ❌ none | ✅ private repos, proof-of-possession, trust center | **High** |
| Benchmarked agent quality lift | ⚠️ small self-eval harness | ✅ published PR benchmarks (e.g. Elasticsearch 300 PRs) | **High** |
| Agent quality / token efficiency claims | Not claimed | Claims fewer tool calls, faster completion | Product |
| Open source / self-host | ✅ | ❌ (product) | Our advantage |
| Offline / no SaaS | ✅ BM25-only works offline | Partial (local indexer, cloud product) | Our advantage |
| Cost | Free infra; pay only if you use embedding API | Product pricing / free query tier | Depends |
| Extensibility as a library | ✅ TypeScript API | SDK for connectors (closed ecosystem) | Our advantage |

---

## Where Augment is clearly ahead

### 1. Retrieval model quality (largest moat)

Augment invests in **code-specific embedding + retrieval models** trained as a pair.  
We use generic BM25 + optional third-party embeddings (`text-embedding-3-small` etc.).

On large, ambiguous monorepos this gap shows up as:

- more false positives
- weaker “intent → right module” jumps
- less stable ranking across languages

### 2. Scale & production indexing

Augment’s indexer is built for **huge repos**, multi-branch/org sync, CI auto-sync.  
Our stack is **single-process SQLite** — fine for personal/team repos, not a drop-in for multi-million-LOC multi-tenant index.

### 3. Multi-source context

Augment indexes **code + docs sites + internal wikis + multi-git hosts**.  
We only index **local filesystem + recent git commits**.

### 4. Measured agent outcomes

Augment publishes end-to-end agent quality lifts (correctness, completeness, fewer turns).  
We ship a **path-recall eval harness**, not a PR-generation benchmark.

### 5. Enterprise packaging

Auth, multi-tenant isolation, shared org indexes, support, compliance — Augment product surface. We are a library/CLI.

---

## Where this project can be “better” or preferable

| Dimension | Why you might pick ContextEngine-plugin |
|-----------|----------------------------------------|
| **Ownership** | Full source, MIT, runs entirely on your machine |
| **Privacy** | Code need never leave the laptop (BM25-only mode) |
| **Cost** | No seat license; optional embedding API only |
| **Hackability** | Embed in custom agents, change ranking/chunking freely |
| **Simplicity** | One Node binary path; no account required |
| **Portability** | Same MCP tools across tools; no vendor lock-in |

For **small/medium repos** and agents that already grep well, hybrid BM25 + light graph expansion already removes a lot of blind exploration. That is the intended sweet spot.

---

## Architecture contrast (simplified)

```text
Augment (product)
  connectors → cloud/local index → custom retrieval models → MCP/IDE
  + enterprise control plane + eval flywheel on real PRs

ContextEngine-plugin (this repo)
  walk files → chunk → SQLite (BM25 memory + optional vectors)
  → hybrid search + graph expand + commit chunks → MCP/CLI
```

We intentionally **do not** try to clone the full control plane.  
We clone the **agent-facing retrieval contract**: “give me the right slices for this task.”

---

## Quantitative honesty (what we have / don’t)

| Metric | Us | Augment (public) |
|--------|----|------------------|
| Self-repo path recall eval | ✅ `contextengine eval --self` | Not comparable |
| 300-PR Elasticsearch agent eval | ❌ | ✅ published |
| Token / tool-call reduction study | ❌ | ✅ claimed in product |
| Index latency on 10k files | Reasonable (local) | Optimized product |

---

## Closing the gap (priority order)

If this project continues, the highest ROI vs Augment is **not** “more MCP tools”:

1. **Better code embeddings** (fine-tuned or strong code models + hard-negative mining)
2. **Structure-first retrieval** (SCIP/LSIF/tsc symbols, call graph) before pure vectors
3. **Task-aware packing** (edit surface vs explanation surface)
4. **Golden task suite** on real open-source PRs (open version of their eval)
5. **Docs/wiki connectors** (second source type)
6. Only then: distributed/remote index for huge monorepos

---

## Bottom line

- **Augment Context Engine** = commercial **context platform** with model + scale + multi-source + enterprise moat.  
- **ContextEngine-plugin** = open **context component** that is already useful as MCP/CLI/library for personal and team agents.

We are **not feature-parity** and should not claim to be.  
We **are** a credible open alternative for the core loop: *index → retrieve → pack → feed agent*, with a clear path to improve quality without becoming a SaaS clone.

Repository: https://github.com/lixiang12345/ContextEngine-plugin
