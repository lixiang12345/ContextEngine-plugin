# HTTP service and IDE sync API

ContextEngine now offers two transports over the same PostgreSQL-backed retrieval
core:

- **MCP stdio** for local coding agents (`contextengine-mcp`).
- **HTTP** for remote IDE clients and service integrations (`contextengine-http`).

The HTTP service keeps source content, file manifests, chunks, and pgvector
embeddings in PostgreSQL. It does not keep an entire repository or all vectors in
Node.js memory.

## Start

```bash
npm run db:up
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
export CONTEXTENGINE_HTTP_API_KEY=replace-with-a-long-random-secret

npm run build
contextengine-http
# or: contextengine http --port 8787
```

The server binds `127.0.0.1:8787` by default. It refuses to start without an API
key or OIDC issuer/audience unless `CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED=1`
is explicitly set.

Public routes:

- `GET /health`
- `GET /dashboard`
- `GET /openapi.json`

All `/v1/*` routes require:

```http
Authorization: Bearer <API-key-or-OIDC-access-token>
```

An invalid credential returns `401` with `WWW-Authenticate: Bearer`. Raw access
tokens are never stored in principals, MCP session metadata, telemetry, or logs.

## Docker deployment

The included Compose stack builds the production image, waits for PostgreSQL
and pgvector to become healthy, and then starts the HTTP service:

```bash
export CONTEXTENGINE_HTTP_API_KEY="$(openssl rand -base64 32)"
docker compose up -d --build
```

The host HTTP port defaults to `8790` and can be changed with
`CONTEXTENGINE_DOCKER_HTTP_PORT`. The host bind address defaults to
`127.0.0.1`; set `CONTEXTENGINE_DOCKER_HTTP_BIND_HOST=0.0.0.0` only for a
trusted remote deployment. Embedding and rerank settings are read from the
project `.env` file and passed to the application container.

## Observability

`GET /v1/observability/overview` returns a bounded operational snapshot for the
embedded dashboard:

- process uptime and memory usage
- normalized per-route request counts, errors, average latency, and p95 latency
- recent requests without bodies, query text, source content, or API keys
- workspace index status and aggregate file/chunk statistics
- recent asynchronous index jobs

Optional query parameters are `request_limit` (1-120, default 60) and
`job_limit` (1-100, default 25). The dashboard is served at `/dashboard`, stores
the Bearer key only in browser `sessionStorage`, and performs same-origin requests.

## Remote workspace sync

Remote IDE clients should use a `blob` workspace. `local` workspaces are a
server-owner feature, disabled by default, and must not be created from an
untrusted public client.

### 1. Create a workspace

```http
POST /v1/workspaces
Content-Type: application/json

{"name":"my-repository","source_mode":"blob"}
```

```json
{
  "workspace": {
    "id": "c0142df0-...",
    "name": "my-repository",
    "source_mode": "blob",
    "local_root": null,
    "revision": 0
  }
}
```

`revision` is the optimistic-concurrency value used for every file sync.

### Principal and workspace permissions

For multi-user deployments, configure `CONTEXTENGINE_HTTP_API_KEYS` as a JSON
array of `{principal_id, token, role?}` entries. `role: "operator"` grants
service-wide administration; regular users receive `owner` on workspaces they
create. Workspace permissions are ordered `reader < writer < owner`:

```http
GET /v1/workspaces/{workspaceId}/acl
PUT /v1/workspaces/{workspaceId}/acl/{principalId}
Content-Type: application/json

{"permission":"reader"}
```

`DELETE /v1/workspaces/{workspaceId}/acl/{principalId}` revokes access
immediately, including active MCP sessions. Unauthorized workspace and job IDs
return `404`. The legacy `CONTEXTENGINE_HTTP_API_KEY` remains a service-wide
operator credential for backward compatibility. `GET /v1/capabilities` returns
the caller's stable `authorization.current_principal.principal_id`, which is the
value used by ACL routes.

### OAuth 2.0 / OIDC access tokens

Configure `CONTEXTENGINE_OIDC_ISSUER` and `CONTEXTENGINE_OIDC_AUDIENCE` together.
The service discovers the provider's JWKS endpoint and verifies signed JWT access
tokens. Set `CONTEXTENGINE_OIDC_JWKS_URL` to use an explicit endpoint instead.
Issuer, JWKS, and discovery URLs must use HTTPS. API keys continue to work while
OIDC is enabled.

```bash
export CONTEXTENGINE_OIDC_ISSUER=https://identity.example.com/realms/acme
export CONTEXTENGINE_OIDC_AUDIENCE=contextengine-api
export CONTEXTENGINE_OIDC_ALLOWED_ALGORITHMS=RS256
export CONTEXTENGINE_OIDC_GROUPS_CLAIM=groups
export CONTEXTENGINE_OIDC_OPERATOR_GROUPS=contextengine-operators
```

The verifier checks the signature, exact issuer, accepted audience, `exp`,
optional `nbf`/`iat`, non-empty subject, key use, key operations, key type, and an
explicit algorithm allowlist. JWKS responses have bounded size/key count and a
bounded cache TTL; an unknown `kid` triggers one rate-limited refresh for key
rotation. Redirects and non-HTTPS key endpoints are rejected.

OIDC principal IDs are stable hashes of the verified issuer and subject. Normal
access-token rotation therefore does not invalidate workspace ACLs or Remote MCP
sessions, while the raw subject is not exposed through the API. A verified OIDC
caller is a regular user unless a value in the configured groups claim exactly
matches `CONTEXTENGINE_OIDC_OPERATOR_GROUPS`. Token-provided `role`, `admin`, or
unconfigured group claims never grant operator access.

### Source and path access policies

Workspace owners can restrict an existing workspace member to source paths:

```http
PUT /v1/workspaces/{workspaceId}/source-acl/{principalId}
Content-Type: application/json

{
  "default_access": "deny",
  "rules": [
    {"path_prefix":"src/public","effect":"allow"},
    {"path_prefix":"src/public/internal","effect":"deny"}
  ]
}
```

`GET /v1/workspaces/{workspaceId}/source-acl` lists policies and
`DELETE /v1/workspaces/{workspaceId}/source-acl/{principalId}` removes one,
restoring the backward-compatible unrestricted default for that workspace
member. Removing the member's workspace ACL entry cascades its source policy.
The target must already have workspace access, and each policy is limited to 256
normalized relative path prefixes.

The most-specific matching prefix wins; an exact-length deny wins a tie. If no
rule matches, `default_access` is used. Operators bypass source policies. The
policy is pushed into PostgreSQL lexical, semantic, path/symbol, and graph
queries, checked before direct file reads, and resolved again for every Remote
MCP tool call. It is not a UI-only result filter, and changing a policy affects
an existing MCP session on its next call.

### Read-only source connectors

The built-in GitHub plugin attaches a repository to an empty Blob workspace:

```http
POST /v1/workspaces/{workspaceId}/sources/github
Content-Type: application/json

{"owner":"acme","repository":"payments","ref":"main"}

POST /v1/workspaces/{workspaceId}/sources/{sourceId}/sync
```

The sync reads Git tree and Blob APIs, applies changed/deleted files through the
same revisioned Blob pipeline, and creates an incremental index job atomically.
An identical tree returns `noop: true`. Source state is available from
`GET /v1/workspaces/{workspaceId}/sources`. Set `CONTEXTENGINE_GITHUB_TOKEN` for
private repositories; credentials are never stored in source configuration or
returned by the API. Repository trees above 20,000 files and truncated GitHub
tree responses are rejected. Files above `CONTEXTENGINE_HTTP_MAX_BLOB_BYTES`
are recorded as skipped and removed from the searchable snapshot.

The built-in `website` plugin turns a bounded static documentation site into
searchable Markdown documents:

```http
POST /v1/workspaces/{workspaceId}/sources/website
Content-Type: application/json

{
  "start_url": "https://docs.example.com/guide/",
  "path_prefix": "/guide/",
  "max_pages": 100,
  "max_depth": 3,
  "max_page_bytes": 1048576,
  "max_total_bytes": 20971520
}
```

Production crawls require HTTPS, resolve and pin public IP addresses for each
request, follow at most three same-origin redirects, stay inside the configured
path prefix, skip query URLs and common binary/static assets, and never send
cookies or source credentials. `robots.txt` is evaluated for
`ContextEngineBot` (falling back to `*`); 401/403 disallow crawling and
429/5xx fail closed. Crawls default to 100 pages, depth 3, 1 MiB per page, and
20 MiB total, with hard maxima of 500 pages, depth 10, 5 MiB per page, and
100 MiB total. HTML title/body text is normalized into `website/*.md` paths.
ETag and Last-Modified validators plus a bounded cursor make unchanged syncs
noops while preserving crawl traversal. Plain HTTP/private-network crawling is
available only through the trusted-deployment
`CONTEXTENGINE_WEBSITE_ALLOW_PRIVATE_NETWORK=1` override.

Set `CONTEXTENGINE_GITHUB_WEBHOOK_SECRET` to enable signed push delivery at
`POST /webhooks/github`, then configure the same secret in the GitHub repository
webhook with `application/json` content. This route does not use the HTTP API
Bearer credential; it requires `X-Hub-Signature-256`, `X-GitHub-Delivery`, and
`X-GitHub-Event`. HMAC is checked against the bounded raw body before JSON is
parsed. Only non-deleted pushes matching the source's configured ref are queued.

The schema v10 inbox stores source id, delivery id, body hash, status, attempt
count, bounded error, validated CI provenance when present, and result
metadata—never the raw payload, CI credential, or webhook secret. Re-delivering
identical bytes is idempotent. Reusing one delivery
id with different bytes returns `409`, including concurrent races. Workers claim
events with PostgreSQL `SKIP LOCKED`, recover expired processing claims using the
database clock, fence terminal writes by attempt number, and retry failures with
bounded exponential backoff. A crash after connector commit but before event
completion safely retries through the connector cursor and becomes a noop.

The built-in GitLab plugin uses the same source route and accepts a
namespace/project path:

```http
POST /v1/workspaces/{workspaceId}/sources/gitlab
Content-Type: application/json

{"project":"acme/tools","ref":"main"}

POST /v1/workspaces/{workspaceId}/sources/{sourceId}/sync
```

The client resolves the branch/tag to an immutable commit SHA, walks the
recursive repository tree with bounded pagination, obtains changed-file sizes
with GitLab's `HEAD repository/files` metadata endpoint, and reads only blobs
that fit the core Blob limit. It validates every path, commit/blob SHA, declared
size and base64 payload; GitLab API errors are bounded and redact
`CONTEXTENGINE_GITLAB_TOKEN`. Core-provided prior file metadata lets unchanged
blobs skip repeat HEAD requests without inflating the connector cursor.

Configure `CONTEXTENGINE_GITLAB_WEBHOOK_SIGNING_TOKEN` for GitLab's Standard
Webhooks HMAC-SHA256 format (`webhook-id`, `webhook-timestamp`,
`webhook-signature`). Signatures cover `{webhook-id}.{timestamp}.{raw body}`,
must be recent, and are checked before JSON parsing. During migration,
`CONTEXTENGINE_GITLAB_WEBHOOK_SECRET` accepts the legacy constant-time
`X-Gitlab-Token` header when no signing header is present. Both adapters emit
the same durable, idempotent inbox flow; deleted pushes and non-push events are
ignored after authentication.

### Source-scoped CI triggers

Owners can issue a source-scoped CI token without granting a CI runner access
to the workspace API:

```http
POST /v1/workspaces/{workspaceId}/sources/{sourceId}/ci-tokens
Authorization: Bearer <workspace-owner-key>
Content-Type: application/json

{"name":"GitHub Actions","expires_in_days":90}
```

The response contains the `ceci_...` credential exactly once. Store it as a
GitHub Actions secret, GitLab CI variable, or Bitbucket secured variable. The
runner then sends only the source-scoped token and an idempotent delivery id:

```http
POST /ci/sync
Authorization: Bearer ceci_<secret>
X-ContextEngine-Delivery: <provider-run-id>
Content-Type: application/json

{"provider":"github-actions","run_id":"12345","ref":"main","commit":"abc123","repository":"acme/tools"}
```

Tokens are stored only as SHA-256 hashes, expire in 1–365 days, can be listed
without revealing their value, and can be revoked with
`DELETE /v1/workspaces/{workspaceId}/sources/{sourceId}/ci-tokens/{tokenId}`.
Each token is limited to 20 active credentials and 60 deliveries per ten
minutes; delivery/body replay conflicts return `409`. The durable webhook inbox
then uses the normal connector lease, cursor fencing, retry, and index-job
pipeline. This endpoint intentionally does not accept a workspace-wide API key.
The optional provenance object is strict and bounded: `provider` must be
`github-actions`, `gitlab-ci`, or `bitbucket-pipelines`; `run_id`, `ref`,
`commit`, and `repository` are short printable strings. Unknown fields and
control characters are rejected. The validated object is stored in the durable
webhook event and copied to the terminal result as `ci_provenance` for audit.

Installable workflow files can be printed with the packaged CLI:

```bash
contextengine ci-template github > .github/workflows/contextengine-sync.yml
contextengine ci-template gitlab > .contextengine-sync.yml
contextengine ci-template bitbucket > bitbucket-pipelines-contextengine.yml
```
Each template uses the provider run identity for `X-ContextEngine-Delivery` and
submits provider, run, ref, commit, and repository provenance.

Minimal provider-neutral CI step:

```yaml
# GitHub Actions, GitLab CI, and Bitbucket Pipelines can use the same shell step.
- name: Refresh ContextEngine source
  run: |
    curl --fail-with-body --retry 3 -X POST "$CONTEXTENGINE_URL/ci/sync" \
      -H "Authorization: Bearer $CONTEXTENGINE_CI_TOKEN" \
      -H "X-ContextEngine-Delivery: ${CI_PIPELINE_ID:-${GITHUB_RUN_ID:-$BITBUCKET_BUILD_NUMBER}}" \
      -H 'Content-Type: application/json' --data '{}'
```

The built-in Bitbucket Cloud plugin uses workspace/repository slugs:

```http
POST /v1/workspaces/{workspaceId}/sources/bitbucket
Content-Type: application/json

{"workspace":"acme","repository":"tools","ref":"main"}

POST /v1/workspaces/{workspaceId}/sources/{sourceId}/sync
```

The client resolves the ref to a commit SHA, walks Bitbucket's paginated source
directories, follows only same-origin API `next` links, obtains file ETags and
sizes with bounded HEAD requests, and reads raw file bytes pinned to that
commit. An unchanged commit reuses the previous file metadata without tree
walk/stat calls. Redirects, unsafe paths, missing ETags, oversized bodies and
token-bearing pagination links fail closed. Configure
`CONTEXTENGINE_BITBUCKET_WEBHOOK_SECRET` for `repo:push`: Bitbucket's
`X-Hub-Signature: sha256=<hex>` HMAC covers the raw body and is verified before
JSON parsing; `X-Request-UUID` provides durable delivery identity and branch
changes are matched against the source ref.

Embedded deployments can register additional providers with the public
`SourceConnectorPlugin` contract. Providers are advertised by
`GET /v1/capabilities` and use the same
`POST /v1/workspaces/{workspaceId}/sources/{provider}` creation route. Core
synchronization retains ownership of leases, hashing, diff, Blob writes and
index promotion. See [`PLUGINS.md`](./PLUGINS.md).

### Owner-managed team snapshots

Set `CONTEXTENGINE_SNAPSHOT_STORE` to a filesystem directory or an
`s3://bucket/prefix` location before enabling these routes. S3 uses the standard
AWS credential chain; `CONTEXTENGINE_S3_ENDPOINT`,
`CONTEXTENGINE_S3_FORCE_PATH_STYLE`, `CONTEXTENGINE_S3_SSE`, and
`CONTEXTENGINE_S3_KMS_KEY_ID` configure compatible services and encryption.

Every route requires workspace `owner` permission. Keys are automatically
scoped by a hash of the workspace id when workspaces share one bucket:

```http
GET /v1/workspaces/{workspaceId}/snapshots

POST /v1/workspaces/{workspaceId}/snapshots
Content-Type: application/json
{"name":"team-main"}

POST /v1/workspaces/{workspaceId}/snapshots/{name}/import
Content-Type: application/json
{}

DELETE /v1/workspaces/{workspaceId}/snapshots/{name}

POST /v1/workspaces/{workspaceId}/snapshots:prune
Content-Type: application/json
{"keep":3,"older_than_days":30}

POST /v1/workspaces/{workspaceId}/snapshots:gc
Content-Type: application/json
{}
```

Import verifies the artifact before promotion and refreshes the cached engine.
Missing configuration returns `503`; reader permissions are hidden as `404`.
Prune and GC fail closed on malformed manifests or an active publication.

### 2. Plan a file manifest change

Hash each UTF-8 file with SHA-256. Paths must be normalized, relative POSIX
paths; absolute paths and `..` segments are rejected.

```http
POST /v1/workspaces/{workspaceId}/sync/plan
Content-Type: application/json

{
  "base_revision": 0,
  "changes": [
    {
      "op": "upsert",
      "path": "src/auth.ts",
      "blob_hash": "c2f0...64 lowercase hex chars",
      "size": 814,
      "mtime_ms": 1760000000000,
      "language": "typescript",
      "root_alias": "main"
    },
    {"op":"delete","path":"src/obsolete.ts"},
    {
      "op":"rename",
      "old_path":"src/old-name.ts",
      "path":"src/new-name.ts"
    }
  ]
}
```

`upsert` requires `blob_hash`; `rename` can reuse its old Blob or specify a new
one. The response only lists content the server does not already have:

```json
{
  "sync_id": "2d57d93b-...",
  "workspace_id": "c0142df0-...",
  "base_revision": 0,
  "missing_blobs": ["c2f0..."],
  "expires_at": "2026-07-15T12:00:00.000Z"
}
```

Plans expire after 15 minutes. Repeating an unchanged file transfers no Blob.

### 3. Upload missing source Blobs

Upload one Blob at a time. The URL hash and body SHA-256 must match.

```http
PUT /v1/blobs/{sha256}?sync_id={syncId}
Content-Type: application/octet-stream

<raw UTF-8 file bytes>
```

`sync_id` is required when multi-principal API keys are configured. It binds
the upload to one authorized workspace and prevents cross-workspace Blob hash
reuse. The legacy single-operator mode also accepts the original unscoped URL.

```json
{"ok":true,"sha256":"c2f0...","bytes":814}
```

For small batches (up to 16 Blobs), `POST /v1/blobs:batch` accepts:

```json
{
  "blobs": [
    {"sha256":"c2f0...","content_base64":"ZXhwb3J0IC4uLg=="}
  ]
}
```

The default per-Blob limit is 2 MiB and is configurable with
`CONTEXTENGINE_HTTP_MAX_BLOB_BYTES`. Large repositories should stream changed
files with individual `PUT` requests; they should not send the repository in one
JSON request.

### 4. Commit and index

```http
POST /v1/workspaces/{workspaceId}/sync/commit
Content-Type: application/json

{"sync_id":"2d57d93b-...","auto_index":true}
```

```json
{
  "ok": true,
  "revision": 1,
  "changed_paths": ["src/auth.ts"],
  "deleted_paths": ["src/obsolete.ts"],
  "index_job": {
    "id": "6a37f4f0-...",
    "status": "queued",
    "mode": "incremental"
  }
}
```

The transaction checks `base_revision` and the database-clock plan TTL again. A
stale client receives `409 revision_conflict` and must pull/merge the latest
workspace state; an expired plan receives `409 sync_plan_expired` and must be
planned again. Blob mappings are committed before indexing; searches continue to
serve the last completed index until the new job succeeds.

## Index jobs

Create a full scan/rebuild explicitly:

```http
POST /v1/workspaces/{workspaceId}/index-jobs
Content-Type: application/json

{"mode":"rebuild"}
```

Poll `GET /v1/index-jobs/{jobId}` or subscribe to
`GET /v1/index-jobs/{jobId}/events` (SSE). A job response includes:

```json
{
  "job": {
    "id": "6a37f4f0-...",
    "workspace_id": "c0142df0-...",
    "revision": 1,
    "mode": "incremental",
    "status": "running",
    "progress": {
      "phase": "embed",
      "files_total": 12,
      "files_done": 12,
      "chunks_total": 49,
      "message": "Embedding 1-8 / 49"
    },
    "result": null,
    "error": null
  }
}
```

Jobs are serialized inside one service process so the embedding endpoint/GPU is
not overloaded by concurrent full-repository indexing.

## Retrieval and file access

| Endpoint | Input | Output |
|---|---|---|
| `POST /v1/workspaces/{id}/search` | `query`, optional `top_k`, `path_prefix`, `language`, `mode`, `expand_graph`, `neural_rerank` | Ranked chunks with path, line range, content, score, retrieval channels, and an `index` generation snapshot |
| `POST /v1/workspaces/{id}/context` | `task` or `information_request`, optional `top_k`, `max_tokens`, `path_prefix` | `packed_text`, token estimate, truncation flag, used hits, and an `index` generation snapshot |
| `GET /v1/workspaces/{id}/file?path=...&start_line=...&end_line=...` | Relative path and optional 1-based range | `{path, content, start_line, end_line}` |
| `GET /v1/workspaces/{id}/status` | None | Workspace revision and index stats |

## Remote MCP over Streamable HTTP

For clients that speak MCP but cannot start a local stdio process, use the
workspace-scoped endpoint:

```text
POST /v1/workspaces/{workspaceId}/mcp
DELETE /v1/workspaces/{workspaceId}/mcp
Authorization: Bearer <CONTEXTENGINE_HTTP_API_KEY>
```

The first `POST` must be an MCP `initialize` request. The server returns an
`mcp-session-id`; send that header on subsequent requests. Sessions are bound
to the workspace in the URL and expose the canonical `codebase-retrieval`
tool. The tool returns the same packed, provenance-bearing context as the
stdio server. A missing index is reported as a tool error; create/commit a
workspace and wait for its index job before querying.

The default PostgreSQL session store hashes the opaque session id and persists
only its workspace/principal binding, negotiated protocol version, status and
database-clock timestamps. Any healthy instance can handle a later JSON POST;
sticky routing is not required, and process restart does not invalidate the
session. GET/SSE is intentionally unavailable and returns `405` because a live
SDK stream cannot be reconstructed from metadata. See
[`MCP_SESSION_ARCHITECTURE.md`](./MCP_SESSION_ARCHITECTURE.md) for the protocol
decision and failure model.

By default an idle session closes after 30 minutes and at most 128 active
sessions may exist globally. Set `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS` and
`CONTEXTENGINE_MCP_MAX_SESSIONS` for different limits. An expired, unknown or
unauthorized session receives HTTP `404`; a new initialize request while the
cap is full receives HTTP `429` with `Retry-After: 1`. DELETE is idempotent and
becomes visible to all instances immediately.

Example initialization:

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/workspaces/$WORKSPACE_ID/mcp" \
  -H "Authorization: Bearer $CONTEXTENGINE_HTTP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

This deployment intentionally keeps the endpoint authenticated and scoped to a
single workspace. Public deployments should add a reverse proxy with TLS,
rate limits, and an origin/CORS allowlist; do not enable unauthenticated mode
on an untrusted network.

`context` accepts both `information_request` and `informationRequest` so clients
that follow different naming conventions can use the agent-oriented endpoint.
If `max_tokens` is omitted, the server returns every reranked hit selected by
`top_k`. `max_tokens` is an optional caller-controlled transport cap; the server
does not maintain model names or infer limits from model context windows.

The `index` object contains `generation_id`, `source_revision`,
`indexed_revision`, `pending_revision`, and `status`. Indexing uses a staging
generation and promotes it atomically, so a request can continue reading the
last complete generation while a new one is being built. Agents should log the
generation id with a task result and treat a non-null `pending_revision` as a
freshness hint rather than mixing results from separate snapshots.

When an embedding or reranker call times out, fails, or is circuit-broken, the
response includes `degraded_channels` (for example `[`"`semantic`"`]`). An
empty array means all configured retrieval channels completed normally; BM25
results remain available during a model outage.

## Mapping from the packaged IntelliJ plugin

The inspected Augment package uses a local sidecar and private operations similar to
`batch-upload`, `find-missing`, checkpoint commits, and an
`informationRequest` retrieval call. Its wire protocol and response envelopes are
not a public ContextEngine standard, so it cannot point at this server without a
small adapter/plugin change.

The direct mapping is:

| Plugin responsibility | ContextEngine HTTP equivalent |
|---|---|
| Initial file intake / debounced document changes | Build `changes` for `/sync/plan` |
| Content hash and missing upload check | `missing_blobs` from `/sync/plan` |
| Upload file contents | `PUT /v1/blobs/{sha256}` or `/v1/blobs:batch` |
| Checkpoint Blob changes | `/sync/commit` with `base_revision` |
| Wait for sidecar indexing | Poll job or consume SSE |
| `informationRequest` retrieval | `POST /context` |
| Read a precise source range | `GET /file` |

An adapter should debounce IDE edits, hash only changed files, upload only missing
Blobs, then pass the user request to `/context`. It should retain the latest
workspace revision locally and retry only after handling a `409` conflict.

## HTTP configuration

| Variable | Purpose |
|---|---|
| `CONTEXTENGINE_HTTP_API_KEY` | Required Bearer key |
| `CONTEXTENGINE_HTTP_API_KEYS` | JSON array of multi-principal API keys |
| `CONTEXTENGINE_OIDC_ISSUER` / `_AUDIENCE` | Enable verified JWT access tokens; required together |
| `CONTEXTENGINE_OIDC_JWKS_URL` | Optional explicit HTTPS JWKS endpoint; otherwise discovery is used |
| `CONTEXTENGINE_OIDC_ALLOWED_ALGORITHMS` | Comma-separated explicit allowlist; default `RS256` |
| `CONTEXTENGINE_OIDC_GROUPS_CLAIM` / `_OPERATOR_GROUPS` | Claim name and exact operator group mapping |
| `CONTEXTENGINE_OIDC_CLOCK_TOLERANCE_SECONDS` | JWT clock tolerance, 0–300 seconds; default 30 |
| `CONTEXTENGINE_OIDC_JWKS_CACHE_TTL_MS` | JWKS/discovery cache TTL, 1 second–24 hours; default 5 minutes |
| `CONTEXTENGINE_OIDC_UNKNOWN_KID_REFRESH_INTERVAL_MS` | Minimum interval for rotation refresh; default 30 seconds |
| `CONTEXTENGINE_OIDC_FETCH_TIMEOUT_MS` | Discovery/JWKS request timeout; default 5 seconds |
| `CONTEXTENGINE_HTTP_HOST` / `_PORT` | Bind address and port (defaults `127.0.0.1:8787`) |
| `CONTEXTENGINE_HTTP_MAX_BLOB_BYTES` | Per-Blob request limit (default 2 MiB) |
| `CONTEXTENGINE_HTTP_CORS_ORIGINS` | Exact comma-separated browser origins, or `*`; disabled by default |
| `CONTEXTENGINE_MCP_SESSION_STORE` | `postgres` (default, cross-instance) or `memory` (single-process rollback) |
| `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS` | Idle lifetime for remote MCP sessions (default 30 minutes) |
| `CONTEXTENGINE_MCP_MAX_SESSIONS` | Global PostgreSQL Remote MCP session limit (default 128; per-process in memory mode) |
| `CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED` | Explicitly disable auth; local development only |
| `CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES` | Permit server-local root workspaces; default off |
| `CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST` | Path-delimited allowlist for local workspaces |
| `CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS` | Allow HTTP runtime configuration to target private/local model endpoints; default off |
| `CONTEXTENGINE_GITHUB_WEBHOOK_SECRET` | Enables HMAC-SHA256 GitHub push delivery; minimum 16 characters |
| `CONTEXTENGINE_WEBHOOK_POLL_INTERVAL_MS` | Persistent inbox poll interval; default 2000 ms |
| `CONTEXTENGINE_WEBHOOK_MAX_ATTEMPTS` | Terminal failure threshold; default 5 |
| `CONTEXTENGINE_WEBSITE_ALLOW_PRIVATE_NETWORK` | Trusted deployment override for private-network/plain-HTTP website crawling; default off |
| `CONTEXTENGINE_WEBSITE_TIMEOUT_MS` | Per-request website crawl timeout; default 15000 ms |
| `CONTEXTENGINE_GITLAB_TOKEN` | Optional GitLab API `PRIVATE-TOKEN`; never returned or stored in source config |
| `CONTEXTENGINE_GITLAB_API_BASE_URL` | GitLab REST API base (default `https://gitlab.com/api/v4`; HTTP only for loopback) |
| `CONTEXTENGINE_GITLAB_TIMEOUT_MS` | Per-request GitLab API timeout; default 30000 ms |
| `CONTEXTENGINE_GITLAB_WEBHOOK_SIGNING_TOKEN` | GitLab Standard Webhooks `whsec_...` signing token |
| `CONTEXTENGINE_GITLAB_WEBHOOK_SECRET` | Legacy `X-Gitlab-Token` migration secret; minimum 16 characters |
| `CONTEXTENGINE_BITBUCKET_TOKEN` | Optional Bitbucket Cloud Bearer token; never returned or stored in source config |
| `CONTEXTENGINE_BITBUCKET_API_BASE_URL` | Bitbucket API base (default `https://api.bitbucket.org/2.0`; HTTP only for loopback) |
| `CONTEXTENGINE_BITBUCKET_TIMEOUT_MS` | Per-request Bitbucket API timeout; default 30000 ms |
| `CONTEXTENGINE_BITBUCKET_WEBHOOK_SECRET` | Bitbucket `repo:push` HMAC secret; minimum 16 characters |
| `CONTEXTENGINE_SNAPSHOT_STORE` | Filesystem directory or `s3://bucket/prefix` for owner-managed snapshots; disabled when unset |
| `CONTEXTENGINE_S3_ENDPOINT` / `_FORCE_PATH_STYLE` | Optional S3-compatible service endpoint and path-style mode |
| `CONTEXTENGINE_S3_SSE` / `_KMS_KEY_ID` | Optional `AES256` or `aws:kms` server-side encryption |

The service uses `CONTEXTENGINE_DATABASE_URL` and the existing embedding/rerank
configuration described in the root README.

When `CONTEXTENGINE_HTTP_CORS_ORIGINS` is configured, requests carrying an
unlisted `Origin` are rejected with `403`. Allowed preflight requests return
`204`; MCP session and retry headers are exposed to browser clients. Prefer
exact HTTPS origins. The `*` wildcard is intended only for public APIs that
still enforce strong Bearer credentials and rate limits.

### v4 to v5 deployment and rollback

Schema v5 adds `ce_mcp_sessions`; v4 processes do not know this table and cannot
participate in global capacity or cross-instance session handling. Drain Remote
MCP traffic from every v4 instance, run one v5 instance to apply the migration,
then route initialize and resume traffic only to v5 instances. After all v4
instances exit, normal round-robin routing can be enabled. A v4 binary refuses
to start against schema v5, preventing silent mixed-version behavior.

Schema v6 relaxes the connector provider constraint for registered plugins.
Existing GitHub rows and schema v5 MCP sessions are unchanged. Running v5
instances can finish GitHub work after migration, but they cannot handle a new
plugin provider and refuse to restart once the v6 marker is committed. Drain
v5 connector traffic before attaching non-GitHub providers; route plugin
creation and synchronization only to v6 instances.

Schema v7 adds source access policies and rules. Version 6 instances reject the
new marker on restart and do not enforce path policies, so drain every v6 HTTP
reader before creating a source policy. The migration is additive and existing
workspace members remain unrestricted until an owner explicitly creates a
policy.

Schema v8 adds the connector webhook inbox. Version 7 instances reject this
marker on restart and cannot claim events. Drain v7 HTTP instances before
enabling webhook delivery; schema v8 workers can safely share the inbox and use
`SKIP LOCKED` plus connector leases across instances.

Schema v9 adds source-scoped CI credentials, and schema v10 adds optional
validated provenance to inbox events. Older instances reject either newer
marker; drain them before issuing CI credentials or accepting CI deliveries.

For application rollback after migration, keep the v5 binary and set
`CONTEXTENGINE_MCP_SESSION_STORE=memory`; this restores the former
single-process behavior and requires sticky routing. A binary rollback requires
a database restored from a pre-v5 backup or an explicitly reviewed down
migration. Do not drop `ce_mcp_sessions` while v5 instances are serving traffic.

Embedding and reranker base URLs submitted through the HTTP configuration API
must use HTTP(S), must not contain URL credentials, and cannot introduce a
literal loopback, private, link-local, or local-network destination by default.
Model requests do not follow HTTP redirects. A local endpoint loaded from the
process environment at startup can be reused. Trusted deployments that need to
select new private endpoints at runtime must explicitly set
`CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS=1`; API credentials should continue
to use the dedicated key fields or environment variables.
