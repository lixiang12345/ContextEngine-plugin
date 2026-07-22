import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import {
  sourcePathAllowed,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";

type SourceRow = {
  path: string;
  blob_hash: string;
  language: string;
  mtime_ms: number;
  size: number;
  root_alias: string;
  content: Buffer;
};

function repositoryWithRows(rows: SourceRow[]): WorkspaceRepository {
  const pool = {
    query: async () => ({ rows }),
  } as unknown as Pool;
  const RepositoryConstructor = WorkspaceRepository as unknown as new (
    pool: Pool,
  ) => WorkspaceRepository;
  return new RepositoryConstructor(pool);
}

function repositoryWithLockClient(options: {
  acquired?: boolean;
  events: string[];
  runningWorkspace?: string;
}): WorkspaceRepository {
  const client = {
    query: async (text: string) => {
      options.events.push(text);
      if (text.includes("hashtextextended")) return { rows: [{ key: "42" }] };
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.acquired ?? true }] };
      }
      return { rows: [] };
    },
    release: () => options.events.push("release"),
  };
  const pool = {
    connect: async () => client,
    query: async (text: string) => {
      options.events.push(`pool:${text}`);
      if (text.includes("SELECT DISTINCT workspace_id")) {
        return {
          rows: options.runningWorkspace
            ? [{ workspace_id: options.runningWorkspace }]
            : [],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const RepositoryConstructor = WorkspaceRepository as unknown as new (
    pool: Pool,
  ) => WorkspaceRepository;
  return new RepositoryConstructor(pool);
}

function sourceRow(path: string, content: Buffer): SourceRow {
  return {
    path,
    blob_hash: "a".repeat(64),
    language: "typescript",
    mtime_ms: 123,
    // Deliberately untrusted manifest value: decoded documents must report
    // the authoritative Blob byte length instead.
    size: 1,
    root_alias: "main",
    content,
  };
}

describe("WorkspaceRepository source decoding", () => {
  it("preserves raw Blob size and marks non-text rows during index scans", async () => {
    const textWithBom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    const binary = Buffer.from([0x00, 0x00, 0x00, 0x61]);
    const repository = repositoryWithRows([
      sourceRow("src/text.ts", textWithBom),
      sourceRow("src/binary.ts", binary),
    ]);

    const documents = [];
    for await (const document of repository.iterateSourceFiles("workspace", [
      "src/text.ts",
      "src/binary.ts",
    ])) {
      documents.push(document);
    }

    assert.equal(documents.length, 2);
    assert.deepEqual(
      documents.map(({ path, content, indexable, size }) => ({
        path,
        content,
        indexable,
        size,
      })),
      [
        {
          path: "src/text.ts",
          content: "a",
          indexable: true,
          size: textWithBom.length,
        },
        {
          path: "src/binary.ts",
          content: "",
          indexable: false,
          size: binary.length,
        },
      ],
    );
  });

  it("does not expose binary Blob content through source-file reads", async () => {
    const repository = repositoryWithRows([
      sourceRow("src/binary.ts", Buffer.from([0x00, 0x00, 0x00, 0x61])),
    ]);

    assert.equal(
      await repository.readSourceFile("workspace", "src/binary.ts"),
      null,
    );
  });
});

describe("source path policy", () => {
  it("uses the most-specific prefix and defaults when no rule matches", () => {
    const policy = {
      defaultAccess: "allow" as const,
      rules: [
        { pathPrefix: "private", effect: "deny" as const },
        { pathPrefix: "private/public", effect: "allow" as const },
        { pathPrefix: "private/public/internal", effect: "deny" as const },
      ],
    };
    assert.equal(sourcePathAllowed(policy, "src/index.ts"), true);
    assert.equal(sourcePathAllowed(policy, "private/secret.ts"), false);
    assert.equal(sourcePathAllowed(policy, "private/public/readme.md"), true);
    assert.equal(
      sourcePathAllowed(policy, "private/public/internal/credential.ts"),
      false,
    );
  });

  it("can deny every source with an empty deny-by-default policy", () => {
    assert.equal(
      sourcePathAllowed({ defaultAccess: "deny", rules: [] }, "src/index.ts"),
      false,
    );
    assert.equal(sourcePathAllowed(undefined, "src/index.ts"), true);
  });
});

describe("WorkspaceRepository index locks", () => {
  it("holds and releases a workspace advisory lock around an operation", async () => {
    const events: string[] = [];
    const repository = repositoryWithLockClient({ events });
    await repository.withIndexJobLock("workspace", async () => {
      events.push("operation");
    });

    assert.equal(events[0].includes("hashtextextended"), true);
    assert.equal(events[1].includes("pg_advisory_lock"), true);
    assert.equal(events[2], "operation");
    assert.equal(events[3].includes("pg_advisory_unlock"), true);
    assert.equal(events[4], "release");
  });

  it("does not recover a running job while another instance owns the lock", async () => {
    const events: string[] = [];
    const repository = repositoryWithLockClient({
      acquired: false,
      events,
      runningWorkspace: "workspace",
    });
    await repository.markRunningJobsFailed();
    assert.equal(events.some((event) => event.includes("UPDATE ce_index_jobs")), false);
  });

  it("recovers an abandoned running job after acquiring its workspace lock", async () => {
    const events: string[] = [];
    const repository = repositoryWithLockClient({
      acquired: true,
      events,
      runningWorkspace: "workspace",
    });
    await repository.markRunningJobsFailed();
    assert.equal(events.some((event) => event.includes("UPDATE ce_index_jobs")), true);
    assert.equal(events.some((event) => event.includes("pg_advisory_unlock")), true);
  });
});
