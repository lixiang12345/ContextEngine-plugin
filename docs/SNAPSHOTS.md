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
metadata cannot cause a still-needed artifact to be deleted.

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

Snapshot format v1 contains portable index metadata, file metadata, chunks,
and embeddings. It intentionally excludes database credentials, CI/webhook
credentials, ACLs, local root paths, source Blob objects, and binary files. It
is a retrieval snapshot, not a source repository backup. In particular, an
HTTP workspace imported from a snapshot can search and pack context, while
`/file` still requires that workspace's own source Blob data.
