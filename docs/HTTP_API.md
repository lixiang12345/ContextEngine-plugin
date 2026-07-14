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
- `GET /openapi.json`

All `/v1/*` routes require:

```http
Authorization: Bearer <CONTEXTENGINE_HTTP_API_KEY>
```

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
PUT /v1/blobs/{sha256}
Content-Type: application/octet-stream

<raw UTF-8 file bytes>
```

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

The transaction checks `base_revision` again. A stale client receives `409
revision_conflict` and must pull/merge the latest workspace state before planning a
new sync. Blob mappings are committed before indexing; searches continue to serve
the last completed index until the new job succeeds.

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
| `POST /v1/workspaces/{id}/search` | `query`, optional `top_k`, `path_prefix`, `language`, `mode`, `expand_graph`, `neural_rerank` | Ranked chunks with path, line range, content, score, retrieval channels |
| `POST /v1/workspaces/{id}/context` | `task` or `information_request`, optional `top_k`, `max_tokens`, `path_prefix` | `packed_text`, token estimate, truncation flag, used hits |
| `GET /v1/workspaces/{id}/file?path=...&start_line=...&end_line=...` | Relative path and optional 1-based range | `{path, content, start_line, end_line}` |
| `GET /v1/workspaces/{id}/status` | None | Workspace revision and index stats |

`context` accepts both `information_request` and `informationRequest` so clients
that follow different naming conventions can use the agent-oriented endpoint.

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
| `CONTEXTENGINE_HTTP_ALLOW_UNAUTHENTICATED` | Explicitly disable auth; local development only |
| `CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES` | Permit server-local root workspaces; default off |
| `CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST` | Path-delimited allowlist for local workspaces |

The service uses `CONTEXTENGINE_DATABASE_URL` and the existing embedding/rerank
configuration described in the root README.
