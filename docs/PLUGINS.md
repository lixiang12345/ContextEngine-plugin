# Source Connector Plugins

ContextEngine exposes a provider-neutral, read-only source connector contract.
Plugins enumerate immutable file revisions and read their bytes; the core owns
leases, hashing, incremental diff, Blob persistence, workspace revisions, index
jobs and promotion. This keeps third-party providers inside the same consistency
and authorization boundaries as the built-in GitHub connector.

## Contract

```ts
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
} from "contextengine-plugin";

export class DocsConnector implements SourceConnectorPlugin {
  readonly provider = "internal_docs";
  readonly displayName = "Internal documentation";

  validateConfig(input: unknown): Record<string, unknown> {
    return { collection: "engineering" };
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    return String(config.collection);
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    return `docs:${String(config.collection)}`;
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    previousCursor: Readonly<Record<string, unknown>> | null,
  ): Promise<ConnectorSnapshot> {
    return {
      revision: "collection-revision",
      cursor: { revision: "collection-revision" },
      files: [{ path: "runbooks/on-call.md", revision: "blob-1", bytes: 128 }],
    };
  }

  async readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    return Buffer.from("# On-call runbook\n...");
  }
}
```

Register trusted plugins when embedding the HTTP server:

```ts
import { startHttpServer } from "contextengine-plugin";
import { DocsConnector } from "./docs-connector.js";

await startHttpServer({ connectorPlugins: [new DocsConnector()] });
```

The provider is then advertised by `GET /v1/capabilities` and can be attached
with `POST /v1/workspaces/{workspaceId}/sources/internal_docs`. Synchronization
uses `POST /v1/workspaces/{workspaceId}/sources/{sourceId}/sync`.

## Invariants

- `provider` must match `^[a-z][a-z0-9_-]{0,62}$` and must be unique.
- `validateConfig` must return JSON-serializable configuration without access
  tokens. Keep credentials in the plugin instance or an external secret store.
- Paths must be relative, normalized and unique. The core rejects traversal,
  duplicate paths, invalid revisions, invalid sizes and snapshots above 20,000
  files.
- `readFile` must return the exact byte count declared by `listFiles`.
- A file revision must identify immutable bytes. Reusing a revision for changed
  content breaks incremental synchronization.
- Plugins are trusted process code, not dynamically uploaded scripts. Register
  only reviewed packages at service startup.
- Throw `SourceConnectorError` for upstream failures that should map to HTTP 502.
  Use `secrets()` only as defense-in-depth redaction.

The current contract is deliberately read-only. Webhook delivery, cursor commit
and source-level permission snapshots will be separate interfaces so a simple
connector does not need to implement a queue or authorization system.

