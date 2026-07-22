# Changelog

## Unreleased

- Hardened the workspace rules loader against symlink escape. Rule files are now
  canonicalized with `realpathSync` and rejected when their real path falls
  outside the workspace root, mirroring the containment discipline `getFileContext`
  already enforces. Prevents a malicious repo from planting a rule file that
  symlinks to a secret elsewhere on disk (e.g. `~/.ssh/id_rsa`) and leaking its
  contents into packed context.
- Scoped the workspace rules scan by source mode over HTTP. Blob-backed
  workspaces have a synthetic root that never holds `AGENTS.md` / `.augment/rules`
  files, so `POST /context` no longer runs a per-request rules disk scan for them
  unless the caller explicitly sets `include_rules: true`; local workspaces still
  load rules by default. An explicit `include_rules` value always wins.
- Added an active-vs-deprecated ranking signal to the feature scorer. Clearly
  retired code — `legacy/`, `deprecated/`, `vendor/` paths, `.old`/`.bak`
  filenames, and `@deprecated`/`Obsolete` markers — is demoted so current
  implementations rank first, unless the query is explicitly about legacy or
  deprecated code (mirrors the existing test/docs intent guards).
- Added a workspace rules layer that grounds packed context in repository
  conventions the way Augment loads team knowledge. `getTaskContext` discovers
  `AGENTS.md`, `CLAUDE.md`, and `.augment/rules` / `.cursor/rules` entries,
  merges them by precedence (root convention files always apply; directory
  rules default to agent-requested, honoring an `alwaysApply` frontmatter flag),
  and prepends a bounded rules preamble (at most a quarter of the token budget)
  ahead of the retrieved code. The applied rules and their scope are recorded in
  `RetrievalTrace.rules` and surfaced across the CLI (`context`, `--no-rules`),
  HTTP (`include_rules`), MCP (`include_rules`), and the dashboard trace panel.
  Opt out with `includeRules: false`. No rule files means no behavior change.

- Updated `COMPARISON.md` to reflect shipped capability: added honest
  "Context curation / packing" and "Retrieval transparency" rows to the feature
  table, and corrected the roadmap so extractive packing with explicit token
  budgets is marked shipped (model-backed summarization stays deliberately
  deferred to preserve exact path+line+content provenance).

- Added a `--summary` flag to `contextengine eval` that prints a compact,
  scannable report to stderr (pass rate, mean recall/MRR/nDCG, top-1/3/5,
  mean/p95 latency, and a per-case line) while keeping the full JSON on stdout
  for pipelines. With `--trace` the summary also lists channel case counts,
  degraded channels, mean packed tokens, and the generation count.
- Added the analyzer's understood concepts (identifiers and expanded query
  terms) to the retrieval trace as `RetrievalTrace.concepts`, surfaced as an
  "Understood" chip row in the dashboard trace panel and a `concepts:` field in
  the `context` CLI summary — the "understood:" breakdown of what the engine
  extracted from the query. Also fixed the dashboard token-budget gauge, which
  never rendered because `renderTrace` did not accept the requested budget.
- Added a max-tokens control and a token-budget gauge to the dashboard retrieval
  probe. Packed views can now set an explicit output cap so the `raw` and
  `extractive` policies can be exercised from the UI, and the trace panel renders
  a fill bar of estimated-vs-budget tokens (with near/over tones and a capped
  marker) instead of a bare token count.
- Surfaced per-channel retrieval confidence in the dashboard retrieval probe.
  Each ranked hit now shows which channels matched it (keyword/symbol/path/
  semantic/graph/neural) with their normalized score as a percentage, plus a
  degraded-channel marker — the "why did I get this result" breakdown, from the
  per-channel scores the search API already returns.
- Made the `extractive` packing policy pack across passages instead of stopping
  at the first reduced block. A clean salient-line elision keeps every
  query-relevant line, so under a tight token budget it now fits the salient
  lines of more distinct files; only a lossy mid-content cut still ends packing.
  This lets `extractive` carry more task-relevant evidence per budget than `raw`.
- Added a failure-injection test for the search-races-promotion retry: when a
  generation is promoted between a query's preflight check and its post-search
  staleness check, the engine must refresh and retry once rather than pair hits
  with a retired generation's provenance. The test forces that exact interleaving
  and fails if the single retry is removed.
- Added an optional `--trace` mode to `contextengine eval`. Each case captures a
  reproducible retrieval trace (intent, contributing channels, degraded channels,
  packed tokens, serving generation) and the report gains a `traceSummary`:
  per-channel case counts, distinct degraded channels, mean packed tokens, and
  the index generations that served the run. IR metrics (recall/MRR/nDCG) stay on
  the same code path, so enabling trace mode never changes them.
- Surfaced the packing policy and retrieval trace over HTTP and the dashboard.
  `POST /v1/workspaces/{id}/context` accepts a `packing` input and returns the
  applied `packing` plus the full `trace`; the dashboard retrieval probe adds a
  View selector (ranked hits vs packed raw/extractive) that renders the packed
  context and a trace panel (intent, channels, candidate→packed counts, tokens,
  generation).
- Added a reproducible retrieval trace on every packed response
  (`PackedContext.trace`). It records the query intent, the retrieval channels
  that contributed, degraded channels, candidate/packed/file counts, estimated
  tokens, the packing policy, and the serving index generation/revision — the
  same axes needed to compare runs across models and budgets. Surfaced in the
  `context` CLI summary and full JSON output; exported as `RetrievalTrace`.
- Added a pluggable context packing policy (`raw` | `extractive`). Under a tight
  token budget the `extractive` policy keeps the query-salient lines of a passage
  plus one line of surrounding context and elides the rest, instead of the `raw`
  leading-character fit that can truncate before reaching the relevant symbol.
  Exposed through `getTaskContext`/`codebaseRetrieval`, the `context --packing`
  CLI flag, and the `codebase-retrieval` MCP `packing` argument; `PackedContext`
  now reports the applied policy. Default remains `raw` (no external model).
- Added schema v15 durable snapshot job attempts and immutable event history.
  Job mutations append history in the same PostgreSQL transaction, lease
  takeover closes the replaced attempt, and a lifetime attempt sequence stays
  monotonic even when a replication retry budget resets. Snapshot SSE now
  replays across instances with decimal `Last-Event-ID` cursors, terminal EOF,
  a reconnecting PostgreSQL wakeup plus polling fallback, bounded shutdown, and
  an owner-only attempt history API. Wakeup transport is publicly pluggable;
  PostgreSQL remains the atomic event source of truth.
- Added schema v14 replication publication fencing with immutable per-job
  source manifest pins, decimal monotonic sequences, filesystem/S3 conditional
  writes, CAS conflict rechecks, lease-loss cancellation, idempotent/superseded
  outcomes, and bounded GC retention for retryable pinned artifacts. Minimal
  custom stores remain compatible and explicitly report best-effort fencing.
- Added schema v13 durable snapshot replication schedules with manual,
  interval, and IANA-timezone nightly policies, database-clock pause/resume,
  cross-instance `SKIP LOCKED` materialization, active-job deduplication, and
  owner-managed HTTP APIs.
- Added durable replication transfer metrics and target health summaries:
  artifact bytes, effective throughput, database-clock lag, consecutive
  failures, and bounded alert metadata without credentials or raw store paths.
- Added schema v11/v12 leased snapshot jobs and named replication targets with
  restart recovery, attempt-token fencing, bounded exponential retry, verified
  artifact copying, manifest-last publication, and workspace-prefixed stores.
- Added a production-oriented static website source connector with public-HTTPS
  DNS pinning, same-origin/path-prefix and robots enforcement, bounded redirects,
  pages/depth/bytes, searchable HTML-to-text conversion, validator-based
  incremental cursors, and HTTP/PostgreSQL end-to-end coverage.
- Added a bounded GitLab source connector with ref-to-commit resolution,
  paginated tree walking, metadata HEAD sizing, validated Blob reads, token
  redaction, Standard Webhooks HMAC-SHA256 verification, legacy token migration,
  durable webhook integration, and HTTP/PostgreSQL end-to-end coverage.
- Added a Bitbucket Cloud source connector with commit-pinned paginated source
  traversal, same-origin next-link validation, ETag/size metadata, bounded raw
  reads, token redaction, HMAC `repo:push` webhooks, and HTTP/PostgreSQL tests.
- Added schema v9 source-scoped CI trigger tokens: one-time token issuance,
  SHA-256-only persistence, expiration/revocation, per-source rate limits,
  durable idempotent `/ci/sync`, and provider-neutral GitHub Actions/GitLab
  CI/Bitbucket Pipelines documentation.
- Added schema v10 CI provenance metadata with strict provider/run/ref/commit/
  repository validation, terminal audit results, and installable GitHub Actions,
  GitLab CI, and Bitbucket Pipelines templates via `ci-template`.
- Added versioned team index snapshots with MVCC-consistent paged export,
  content-addressed gzip artifacts, strict manifest/record/checksum validation,
  atomic generation import, pluggable filesystem/S3-compatible stores, and
  safe list/delete, age/count retention pruning, and unreferenced-artifact GC.
- Added owner-managed HTTP snapshot routes with workspace-scoped object prefixes,
  synchronous export/import, list/delete/prune/gc operations, explicit `503`
  behavior when the store is unconfigured, and ACL/HTTP integration coverage.
- Added schema v8 persistent connector webhook events, a provider-neutral signed
  webhook contract, GitHub HMAC-SHA256 push handling, delivery/body replay
  protection, database-clock worker recovery, bounded retries, and attempt
  fencing around terminal event updates.
- Added schema v7 source/path ACL policies with most-specific prefix precedence,
  owner-managed HTTP APIs, SQL-level filtering across lexical/semantic/graph
  retrieval, direct file-read enforcement, and live policy re-resolution for
  every Remote MCP tool call.
- Added composable OAuth 2.0/OIDC JWT authentication alongside existing API
  keys, with exact issuer/audience and lifetime validation, explicit algorithm
  allowlists, HTTPS discovery/JWKS caching and rotation refresh, stable
  issuer+subject principals, and server-configured operator-group mapping.
- Added a public source connector plugin SDK and registry, adapted GitHub as the
  built-in provider, generalized HTTP source creation and synchronization, and
  added schema v6 provider ids plus third-party plugin end-to-end coverage.
- Added an opt-in exact-origin CORS policy with preflight handling and MCP header exposure.
- Added schema v5 durable Remote MCP sessions: hashed session identifiers,
  database-clock TTL and global capacity, cross-instance JSON POST handling,
  restart recovery, idempotent close, aggregate metrics, explicit memory-mode
  rollback, and two-instance race/restart coverage. GET/SSE is explicitly 405.
- Added multi-principal constant-time Bearer authentication, workspace reader/writer/owner ACLs, principal-bound MCP sessions, admin-only observability/model controls, and workspace-scoped Blob possession proofs.
- Added a read-only GitHub repository connector with bounded tree/Blob reads, incremental cursor-based synchronization, atomic source/index-job commits, source status APIs, dashboard sync controls, and credential redaction.
- Added versioned PostgreSQL migrations through schema v4 for workspace ACLs, Blob grants, connector sources/files, durable connector attempt leases, database-clock sync-session TTL fencing, concurrent Blob uploads, sync-plan ownership fencing, and rolling-upgrade transition guards, including cross-process migration and end-to-end isolation regression coverage.
- Added a multi-stage production Docker image and a complete Docker Compose deployment for the HTTP service plus PostgreSQL/pgvector, including health checks and persistent volumes.
- Added a self-contained `/dashboard` observability UI with workspace/index health, recent jobs, process metrics, route latency/error telemetry, and a live retrieval probe.
- Refreshed the dashboard with responsive cards, light/dark themes, keyboard search focus, loading feedback, toast notifications, API-key visibility controls, and copyable result locations.
- Added authenticated `GET /v1/observability/overview`; request telemetry records only normalized routes, status codes, and timings, never request payloads or API keys.
- Hardened local file access and HTTP workspace roots with real-path boundary checks, and added an opt-in policy for private-network model endpoints to reduce path traversal and SSRF exposure.
- Bounded unmatched telemetry routes to a single normalized label and bound Docker Compose PostgreSQL to loopback by default.
- Parallelized independent lexical retrieval channels and hybrid lexical/semantic lookup, capped identifier/path fan-out, and made explicit semantic search fall back to lexical results when embeddings are unavailable.
- Added Unicode-aware tokenization with accent folding and CJK bigrams for multilingual lexical search.
- Batched PostgreSQL chunk, symbol, import, and embedding writes and switched missing-vector scans to keyset pagination to reduce indexing round trips.
- Added a schema-local PostgreSQL version marker so independently started workers skip already-applied DDL, with a cross-process lock regression test.
- Made local and Blob-backed indexing close database pools reliably, clear stale entries for unreadable, oversized, deleted, or binary replacements, and enforce limits from authoritative Blob byte sizes.
- CI now exercises the PostgreSQL/pgvector integration suites and self-evaluation against a real service; builds clean stale `dist` output before compilation.
- Retrieval output is model-neutral: ContextEngine no longer tracks model names, context windows, or reserved output tokens.
- Library, CLI, MCP, and HTTP retrieval entrypoints return all reranked `topK` hits by default; explicit `max_tokens` remains an optional caller-controlled transport cap.
- Natural-language queries no longer classify ordinary prose words as code symbols; structured identifiers and acronyms still route through the symbol channel.
- Chunk-level candidates are collapsed and reranked at file level so evidence spread across class headers and methods can compete with repetitive documentation.
- Lexical retrieval keeps a deeper candidate pool before file aggregation so large files with evidence spread across methods are not truncated prematurely.
- MMR no longer treats a shared deep source/package prefix as near-duplicate content, preserving relevant files from the same subsystem.
- Diversified search now returns at most the requested `topK` unique file representatives, improving recall without duplicate chunks consuming result slots.
- Added `contextengine eval-pr` for isolated baseline/context agent runs with hidden fail-to-pass tests, bounded tracked/untracked patch capture, structured usage metrics, and JSON/Markdown reports.
- Hardened PR evaluation with a separate sanitized baseline-oracle workspace, raw/agent-prompt/context evidence hashes, all `none x packed` comparisons, resolved base/gold commit reporting, and POSIX process-group cleanup (Windows uses a direct-child fallback).
- Added repetition-aware `case@repetition` pairing plus a three-case fixed historical PR corpus with pinned base/gold commits, unique new-test-file oracles, and a CI fail-to-pass validation command.

- Optional neural `/v1/rerank` second stage (`CONTEXTENGINE_NEURAL_RERANK=1`) blended after hybrid+feature scoring
- Production hybrid retrieval defaults (auto → hybrid when embeddings exist)
- Stronger multi-lang implementation-first rerank (tests/headers/docs penalties)
- Adaptive embedding batch + `CONTEXTENGINE_EMBED_MAX_CHARS` for 12GB GPUs
- Default ignores for heavy `jvmTest` / android test / testdata trees
- Docs: GPU deploy guide, getting-started paths, multilang bench refresh
- Ship `scripts/embed_rerank_server.py` (OpenAI-compatible embed + optional Qwen3 rerank)

## 0.4.0 — Augment-class retrieval stack

- Multi-signal retrieval: FTS5 BM25 + symbol table + path hints + optional two-stage semantic
- Query analyzer (symbol / path / concept / history intents)
- Feature reranker + RRF fusion + MMR diversity packing
- Multi-root indexing (`--extra docs:path`, `CONTEXTENGINE_EXTRA_ROOTS`)
- Primary MCP tool: `codebase_retrieval` (Augment-style)
- Eval metrics: Recall@k, MRR, nDCG@k
- Architecture doc: `ARCHITECTURE.md`

## 0.3.1

- CI workflow (build, test, self-eval)
- Brace-aware unit chunking for TS/JS/Go/Rust/Java-like languages
- Index export / import for offline index sharing
- `COMPARISON.md` — gap analysis vs Augment Context Engine
- Package files include examples + docs; bin shebang ensure on build

## 0.3.0

- Retrieval eval harness (`contextengine eval`)
- Multi-repo profiles (`contextengine profile`)
- Example MCP configs for Claude Code / Cursor
- CONTRIBUTING guide

## 0.2.0

- Symbol / import graph expansion on search
- Commit lineage (recent git history as searchable chunks)
- Watch-mode incremental indexer

## 0.1.0

- Hybrid BM25 + optional OpenAI-compatible embeddings
- SQLite incremental index
- MCP server + CLI + library API
