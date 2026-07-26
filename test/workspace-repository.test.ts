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

function repositoryCapturingQueries(
  captured: { text: string; values: unknown[] }[],
): WorkspaceRepository {
  const pool = {
    query: async (text: string, values: unknown[]) => {
      captured.push({ text, values });
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

describe("WorkspaceRepository stranded local jobs", () => {
  it("scopes the stranded scan to foreign-executor local jobs and clamps the limit", async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    const repository = repositoryCapturingQueries(captured);

    const jobs = await repository.listStrandedLocalIndexJobs("executor-a", 500);

    assert.deepEqual(jobs, []);
    const [call] = captured;
    assert.ok(call, "expected one query");
    assert.equal(call.text.includes("executor_id <> $1::text"), true);
    assert.equal(call.text.includes("source_mode = 'local'"), true);
    assert.equal(call.text.includes("('queued', 'running')"), true);
    assert.deepEqual(call.values, ["executor-a", 100]);
  });

  it("bounds the periodic runnable scan", async () => {
    const captured: { text: string; values: unknown[] }[] = [];
    const repository = repositoryCapturingQueries(captured);

    await repository.listRunnableIndexJobs(60_000, "executor-a");

    const [call] = captured;
    assert.ok(call, "expected one query");
    assert.equal(call.text.includes("LIMIT 100"), true);
  });
});
