# Team Index Snapshots

ContextEngine can publish one active PostgreSQL index generation to a local
directory or S3-compatible object store and import it into another logical
workspace. Snapshot transport is a pluggable component; filesystem and S3
adapters are built in.

## CLI

The default store is `<root>/.contextengine/snapshots`:

```bash
contextengine snapshot export team-main --root /srv/repo
contextengine snapshot import team-main --root /srv/copy
contextengine snapshot list --root /srv/repo
contextengine snapshot delete team-main --root /srv/repo
contextengine snapshot gc --root /srv/repo
contextengine snapshot prune --keep 3 --older-than-days 30 --root /srv/repo
```

For an existing HTTP workspace, use its id instead of the local root namespace:

```bash
contextengine snapshot export team-main \
  --workspace-id 01JWORKSPACE \
  --store s3://team-indexes/contextengine

contextengine snapshot import team-main \
  --workspace-id 01JOTHERWORKSPACE \
  --store s3://team-indexes/contextengine
```

AWS credentials use the standard AWS SDK credential chain. S3-compatible
services such as MinIO, R2, B2, and Spaces can use:

```bash
export CONTEXTENGINE_S3_ENDPOINT=https://objects.example.com
export CONTEXTENGINE_S3_FORCE_PATH_STYLE=true
```

Optional server-side encryption settings are
`CONTEXTENGINE_S3_SSE=AES256` or `CONTEXTENGINE_S3_SSE=aws:kms` with
`CONTEXTENGINE_S3_KMS_KEY_ID`.

`snapshot delete` removes only the named manifest. Run `snapshot gc` to remove
content-addressed artifacts that are no longer referenced by any valid
manifest. GC fails closed when a manifest is unreadable or invalid, so damaged
metadata cannot cause a still-needed artifact to be deleted. HTTP GC also
preserves artifacts pinned by active replication jobs or failed replication
jobs from the last seven days, keeping bounded manual retries recoverable.

`snapshot prune` can retain the newest `--keep` snapshots, enforce
`--older-than-days`, or combine both so a snapshot must cross both boundaries
before deletion. It fails on malformed manifests.

## Publication Model

An export reads the active physical generation inside a PostgreSQL
`REPEATABLE READ READ ONLY` transaction. It streams bounded pages into gzip
NDJSON without loading the complete index into memory. Publication has two
steps:

1. Upload `objects/sha256/<digest>.ndjson.gz`.
2. Publish `snapshots/<name>/manifest.json` last.

The manifest includes format/index versions, source generation and revision,
record counts, compressed size, and SHA-256. It stores only a hash of the
logical workspace id, so a local absolute root is not disclosed.

Import downloads to a private temporary file, enforces compressed and expanded
size limits, verifies size and SHA-256 before database writes, strictly parses
every record, and checks header/count agreement. It rebuilds derived FTS,
symbol, and import data in a new generation. The target alias changes only
after all records and vector indexes succeed. Existing stale-generation guards
still prevent an older numeric revision from replacing newer data.

## Plugin API

Hosts can provide another transport without changing the snapshot codec:

```ts
import type { SnapshotObjectStore } from "contextengine-plugin";
import { exportIndexSnapshot } from "contextengine-plugin";

const store: SnapshotObjectStore = {
  async put(key, source, metadata) {
    /* stream to object storage */
  },
  async get(key) {
    /* return a Node.js Readable */
  },
  async delete(key) {
    /* remove one object */
  },
};

await exportIndexSnapshot({ databaseUrl, workspaceId, name: "main", store });
```

The minimal interface remains sufficient for custom stores. A store can opt in
to strict cross-process publication fencing by also implementing `head` and
`putConditional`. `supportsConditionalSnapshotWrites(store)` detects the
capability; request methods receive an optional `AbortSignal`, which conditional
implementations must honor. The built-in
filesystem and S3 adapters implement it, with S3 mapping conditions to
`If-Match` and `If-None-Match`.

The filesystem adapter never steals a publication lock based on wall-clock
age, because a suspended process could otherwise overwrite a newer manifest.
An orphaned lock causes a bounded timeout and must be removed only after an
operator verifies that no writer remains.

Replication uses the same store contract and publishes the target manifest last:

```ts
import { replicateIndexSnapshot } from "contextengine-plugin";

await replicateIndexSnapshot({
  name: "main",
  source: primaryStore,
  target: regionalStore,
});
```

The artifact is first downloaded into a bounded private temporary file and
verified against its manifest digest and byte count. A failed copy therefore
cannot replace an existing valid target artifact; a retry is idempotent and
publishes the manifest only after the artifact is durable.

Durable HTTP replication pins the first validated source manifest and its
SHA-256 in PostgreSQL schema v14. Every job receives a monotonic decimal-string
publication sequence that is retained across lease takeover and explicit
retry. The target manifest stores that sequence and source digest. Conditional
publication re-reads after every conflict: a lower sequence returns
`superseded`, and the same sequence plus digest returns `already_current`.
The final manifest CAS holds the current job row lock for that short write, so
lease takeover and terminal state changes cannot cross the publication point.
Replication and GC also share a workspace-scoped PostgreSQL advisory lifecycle
lock, covering the artifact transfer through manifest publication and the GC
scan/deletes.
Replication results expose `publication_status`, `publication_sequence`,
`source_manifest_sha256`, and `strict_fencing`. Minimal third-party stores use a
compatible best-effort fallback and report `strict_fencing: false`.

Snapshot format v1 contains portable index metadata, file metadata, chunks,
and embeddings. It intentionally excludes database credentials, CI/webhook
credentials, ACLs, local root paths, source Blob objects, and binary files. It
is a retrieval snapshot, not a source repository backup. In particular, an
HTTP workspace imported from a snapshot can search and pack context, while
`/file` still requires that workspace's own source Blob data.

## HTTP Jobs

The HTTP service keeps list and delete synchronous. Export, import, prune, and
GC create PostgreSQL-backed jobs and return `202` immediately. The creating
workspace owner can poll
`GET /v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}` or stream the same
state from the `/events` SSE endpoint. Schema v15 records each state transition
as an immutable event in the same transaction as the job mutation. SSE uses
that log across HTTP instances instead of relying on an in-process runner.

An initial `/events` request returns the latest durable state. Reconnect with
`Last-Event-ID: <decimal>` or request `?after_event_id=<decimal>` to replay every
later event in ascending order. Each `event: job` frame keeps the existing
`data.job` payload and adds an `id:` plus `data.event`; a succeeded or failed
stream closes after its final frame. PostgreSQL `LISTEN/NOTIFY` is only a
low-latency wakeup, with `CONTEXTENGINE_SNAPSHOT_JOB_POLL_INTERVAL_MS` polling
as the correctness fallback. Deployments may inject another
`SnapshotJobEventWakeup`; durable event storage remains PostgreSQL so it stays
atomic with the job row.

Owners can inspect lifetime attempts with
`GET /v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}/attempts`. Its
`attempt` is monotonic for the life of the job, while `budget_attempt` mirrors
the current automatic retry budget. A v14 migration backfills only the latest
known attempt and marks it `backfilled: true`; it does not invent unavailable
historical attempts.

`POST /v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}/retry` requeues a
failed job. Non-replication jobs preserve their cumulative attempt count;
replication starts a fresh bounded automatic-attempt budget while retaining the
same durable job id and timestamps.

Jobs survive process restarts. A claim increments `attempts` and assigns a new
lease token; progress and terminal writes must present that token, which fences
off a worker whose lease was replaced by another server instance. Lease loss
also aborts in-flight object-store operations. A database publication watermark
prevents an older failed job from being retried over a newer publication even
if the target manifest was deleted. CLI commands remain synchronous for
scripting and maintenance workflows.

Schema v15 also keeps a separate lifetime attempt sequence because an explicit
replication retry intentionally resets the bounded `attempts` budget to zero.
Takeover marks the prior attempt `lease_expired`; heartbeat updates the attempt
without creating noisy events, and a stale worker's fenced update creates no
history row.

## Replication Targets

HTTP deployments can inject named target stores through
`HttpServerOptions.snapshotReplicationTargets`. A simple environment-based
deployment can map target ids to store locations:

```bash
export CONTEXTENGINE_SNAPSHOT_REPLICATION_TARGETS='{
  "region-backup":"s3://team-indexes-eu/contextengine",
  "local-dr":"/srv/contextengine-replica"
}'
```

Target ids are persisted with replication jobs, but store locations and
credentials are not. Each target receives the same workspace hash prefix used
by the primary store. Owners queue a copy with
`POST /v1/workspaces/{workspaceId}/snapshots/{name}/replicate` and inspect the
latest status per target and snapshot through
`GET /v1/workspaces/{workspaceId}/snapshot-replication-targets`. Failed copies
use the standard snapshot-job retry endpoint.

### Durable schedules

Owners can persist one replication policy for each workspace, target, and
snapshot:

```http
PUT /v1/workspaces/{workspaceId}/snapshots/{name}/replication-schedules/{targetId}
Content-Type: application/json

{"mode":"interval","interval_ms":3600000}
```

`manual` stores an explicitly disabled policy, `interval` accepts 60 seconds to
365 days, and `nightly` accepts `nightly_at` (`HH:MM[:SS]`) plus an IANA
`timezone` (for example `Asia/Shanghai`). `PATCH` with `{"enabled":false}`
pauses a policy; setting it back to `true` computes a fresh next run using the
PostgreSQL clock. List policies with
`GET /v1/workspaces/{workspaceId}/snapshot-replication-schedules`, inspect a
single policy under its snapshot path, or remove it with `DELETE`.

Every due policy is claimed with `FOR UPDATE SKIP LOCKED`, advances its next
run before the transaction commits, and writes a durable replication job with
the policy id and scheduled timestamp. A partial unique index also collapses
manual and scheduled requests onto one active workspace/target/snapshot job,
so multiple HTTP instances can poll safely. Missed interval ticks coalesce into
one catch-up job instead of producing an unbounded burst. Store implementations
and their credentials remain process-injected; only schedule metadata and
aggregate metrics are persisted.

Replication jobs automatically retry transient target failures up to three
attempts by default, with exponential delays capped at five minutes. The job
payload exposes `next_attempt_at` while waiting, and the target status endpoint
reports retry count, terminal failures, average duration, database-clock lag,
artifact bytes, effective throughput, consecutive failures, and a bounded
health/alert summary. `CONTEXTENGINE_SNAPSHOT_REPLICATION_MAX_ATTEMPTS` and
`CONTEXTENGINE_SNAPSHOT_REPLICATION_RETRY_BASE_MS` bound this policy.
An explicit retry of a terminal replication job starts a fresh bounded attempt
budget; non-replication jobs retain their cumulative attempt count.
