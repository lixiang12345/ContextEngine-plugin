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

The server binds `127.0.0.1:8787` by default. It refuses to start without
`CONTEXTENGINE_HTTP_API_KEY` unless `CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED=1`
is explicitly set.

Public routes:

- `GET /health`
- `GET /dashboard`
- `GET /openapi.json`

All `/v1/*` routes require:

```http
Authorization: Bearer <CONTEXTENGINE_HTTP_API_KEY>
```

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
operator credential for backward compatibility.

### Read-only GitHub source

Attach one GitHub repository to an empty Blob workspace, then synchronize it:

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
GET  /v1/workspaces/{workspaceId}/mcp
DELETE /v1/workspaces/{workspaceId}/mcp
Authorization: Bearer <CONTEXTENGINE_HTTP_API_KEY>
```

The first `POST` must be an MCP `initialize` request. The server returns an
`mcp-session-id`; send that header on subsequent requests. Sessions are bound
to the workspace in the URL and expose the canonical `codebase-retrieval`
tool. The tool returns the same packed, provenance-bearing context as the
stdio server. A missing index is reported as a tool error; create/commit a
workspace and wait for its index job before querying.

Remote sessions are bounded per HTTP process. By default an idle session is
closed after 30 minutes and at most 128 sessions (including in-flight
initializations) may exist. Set `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS` and
`CONTEXTENGINE_MCP_MAX_SESSIONS` for a deployment with different limits. A
request carrying an expired or unknown session id receives HTTP `404`; a new
initialize request while the cap is full receives HTTP `429` with
`Retry-After: 1`.

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
| `CONTEXTENGINE_HTTP_HOST` / `_PORT` | Bind address and port (defaults `127.0.0.1:8787`) |
| `CONTEXTENGINE_HTTP_MAX_BLOB_BYTES` | Per-Blob request limit (default 2 MiB) |
| `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS` | Idle lifetime for remote MCP sessions (default 30 minutes) |
| `CONTEXTENGINE_MCP_MAX_SESSIONS` | Maximum remote MCP sessions per HTTP process (default 128) |
| `CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED` | Explicitly disable auth; local development only |
| `CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES` | Permit server-local root workspaces; default off |
| `CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST` | Path-delimited allowlist for local workspaces |
| `CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS` | Allow HTTP runtime configuration to target private/local model endpoints; default off |

The service uses `CONTEXTENGINE_DATABASE_URL` and the existing embedding/rerank
configuration described in the root README.

Embedding and reranker base URLs submitted through the HTTP configuration API
must use HTTP(S), must not contain URL credentials, and cannot introduce a
literal loopback, private, link-local, or local-network destination by default.
Model requests do not follow HTTP redirects. A local endpoint loaded from the
process environment at startup can be reused. Trusted deployments that need to
select new private endpoints at runtime must explicitly set
`CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS=1`; API credentials should continue
to use the dedicated key fields or environment variables.
