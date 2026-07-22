# ContextEngine vs Augment Code Context Engine

This document is an honest capability gap analysis.  
**ContextEngine-plugin** is an open, portable retrieval layer.  
**Augment Context Engine** is a commercial, productized context platform.

Last updated: 2026-07-22 · ContextEngine **v0.4.0** (based on public Augment product pages / MCP, SDK, connector, rules, and permissions docs).

For the detailed capability-to-code audit and staged roadmap, see
[docs/AUGMENT_ALIGNMENT.md](./docs/AUGMENT_ALIGNMENT.md).

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
| MCP for Claude Code / Cursor / Zed | ✅ stdio MCP, `codebase-retrieval`, default live watcher | ✅ local + hosted MCP with multi-client setup | Low–Medium |
| Remote MCP over HTTP | ✅ workspace-scoped Streamable HTTP, Bearer auth, bounded session lifecycle | ✅ hosted/connector HTTP MCP with OAuth/API key and deployment options | **Medium** |
| Hybrid lexical + semantic search | ✅ PostgreSQL FTS + pgvector + symbol + path + RRF + feature rerank | ✅ specialized semantic retrieval | **Medium** (model still theirs) |
| Context curation / packing | ✅ MMR diversity + token budget + pluggable `raw`/`extractive` policy (extractive keeps query-salient lines across passages) | ✅ "compresses context without losing critical information" | Low–Medium |
| Retrieval transparency | ✅ per-response trace (intent, understood concepts, contributing/degraded channels, candidate→packed counts, token budget, generation) across CLI/HTTP/dashboard/eval | ✅ product UI shows intent, match-type confidence, coverage, token usage | Low |
| Code-native embeddings | ⚠️ BYO OpenAI-compatible; two-stage rerank | ✅ **paired / trained retrieval models** for code | **High** |
| Real-time local indexing | ✅ hash incremental + `watch` | ✅ local indexer, “next query reflects edits” | Medium |
| Large monorepo scale | ⚠️ PostgreSQL + pgvector; avoids full vector maps, still needs scale testing | ✅ production indexing at monorepo scale | **High** |
| Multi-repo / org index | ✅ multi-root + profiles + HTTP workspaces | ✅ multi-repo connectors, org-wide index | Medium–High |
| Non-code sources (docs, wikis, tickets) | ⚠️ provider-neutral plugin SDK and content-addressed Blobs; GitHub built in | ✅ packaged website and GitHub/GitLab/Bitbucket connectors | **Medium–High** |
| Commit / history context | ✅ recent git log as searchable chunks | ✅ deeper Context Lineage / history products | Medium |
| Symbol / dependency awareness | ✅ symbol table + import graph expand | ✅ deeper codebase understanding (proprietary) | Medium |
| Team index sharing | ✅ shared PostgreSQL workspace namespaces | ✅ S3/object-store sharing and hosted team indexes | Medium–High |
| Enterprise security / auth | ⚠️ Bearer auth, root allowlist, path/URL boundary checks | ✅ source permissions, policy controls, proof-of-possession, trust center | **High** |
| Benchmarked agent quality lift | ⚠️ Recall/MRR/nDCG plus repeated paired PR orchestration and a 3-case fixed internal corpus; no real-model result yet | ✅ published PR benchmarks (e.g. Elasticsearch 300 PRs) | **High** |
| Agent quality / token efficiency claims | Not claimed | Claims fewer tool calls, faster completion | Product claim; not independently reproduced |
| Open source / self-host | ✅ | ❌ (product) | Our advantage |
| Offline / no SaaS | ✅ BM25-only works offline | Partial (local indexer, cloud product) | Our advantage |
| Cost | Free infra; pay only if you use embedding API | Product pricing / free query tier | Depends |
| Extensibility as a library | ✅ TypeScript API plus source connector plugin contract | ✅ TypeScript/Python SDK and open-source Context Connectors | Different strengths |

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
Our stack is **PostgreSQL + pgvector** — suitable for shared local/team deployment and
avoids full in-process vector maps, but is not yet a drop-in for multi-million-LOC,
multi-tenant indexing.

### 3. Multi-source context

Augment packages **code + docs sites + multi-git hosts** and exposes DirectContext.
We now provide a provider-neutral connector contract and built-in GitHub support,
but still lack packaged GitLab/Bitbucket/website/wiki/ticket plugins.

### 4. Measured agent outcomes

Augment publishes end-to-end agent quality lifts (correctness, completeness, fewer turns).  
We now ship both a **path-recall eval harness** and a V1 PR orchestration runner
for isolated Git repositories, repeated paired baseline/context execution,
tests, patch statistics, optional agent metrics, and a fixed three-task corpus
from this repository's history. We have not yet published controlled real-model
runs, a broad public PR corpus, or an Augment-comparable result.

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
  walk files → chunk → PostgreSQL FTS + pgvector
  → hybrid search + candidate-local graph expand + commit chunks → MCP/CLI
```

We intentionally **do not** try to clone the full control plane.  
We clone the **agent-facing retrieval contract**: “give me the right slices for this task.”

---

## Quantitative honesty (what we have / don’t)

| Metric | Us | Augment (public) |
|--------|----|------------------|
| Self-repo path recall eval | ✅ `contextengine eval --self` | Not comparable |
| PR task orchestration | ✅ repetition-aware V1 paired runner and reports | ✅ internal/product benchmark stack |
| Fixed PR corpus | ⚠️ 3 internal historical tasks | ✅ published Elasticsearch study |
| Repeated controlled model results | ❌ not published yet | ✅ published study |
| 300-PR Elasticsearch agent eval | ❌ | ✅ published |
| Token / tool-call reduction study | ❌ | ✅ claimed in product; not independently reproduced |
| Index latency on 10k files | Reasonable (local) | Optimized product |

---

## Closing the gap (priority order)

If this project continues, the highest ROI vs Augment is **not** “more MCP tools”:

1. **Expand the seed corpus into a reproducible public corpus and run matched-model trials** (fixed commits, repetitions, token/tool-call trace, P95, test outcome)
2. **Connector and webhook SDK** (Git providers, websites, tickets, external docs)
3. **Source-level ACL and provenance proof** before exposing shared indexes
4. **Structure-first retrieval and stronger code embeddings** (SCIP/LSIF/call graph + hard negatives)
5. **Task-aware packing**: extractive policy and explicit token budgets shipped; model-backed summarization still open (deliberately deferred — it would trade away the exact path+line+content provenance agents rely on)
6. **Distributed generation storage and remote index sharing** for very large monorepos

---

## Bottom line

- **Augment Context Engine** = commercial **context platform** with model + scale + multi-source + enterprise moat.  
- **ContextEngine-plugin** = open **context component** that is already useful as MCP/CLI/library for personal and team agents.

We are **not feature-parity** and should not claim to be.  
We **are** a credible open alternative for the core loop: *index → retrieve → pack → feed agent*, with a clear path to improve quality without becoming a SaaS clone.

Repository: https://github.com/lixiang12345/ContextEngine-plugin
