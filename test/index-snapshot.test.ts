import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import {
  deleteIndexSnapshot,
  exportIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  importIndexSnapshot,
  listIndexSnapshots,
} from "../src/snapshots/snapshot.js";
import { PostgresStore } from "../src/store/postgres-store.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres("portable index snapshots", () => {
  const schema = `ce_snapshot_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  let directory = "";

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    directory = await mkdtemp(path.join(os.tmpdir(), "ce-index-snapshot-"));
  });

  after(async () => {
    try {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
    } finally {
      await admin.end();
    }
  });

  it("exports an active generation and atomically imports a searchable copy", async () => {
    const sourceWorkspace = "/private/source/path-that-must-not-leak";
    let source = await PostgresStore.open({
      databaseUrl: schemaUrl,
      workspaceId: sourceWorkspace,
      lockWorkspace: true,
    });
    source = await source.beginGeneration("7");
    const content =
      "export function sharedSnapshotToken() { return 'team-index'; }";
    const hash = createHash("sha256").update(content).digest("hex");
    await source.clearWorkspace();
    await source.upsertFile({
      path: "src/shared.ts",
      hash,
      language: "typescript",
      mtimeMs: 123,
      size: Buffer.byteLength(content),
      rootAlias: "main",
    });
    await source.replaceChunksForFile(
      "src/shared.ts",
      [
        {
          id: "shared-chunk",
          path: "src/shared.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
          content,
          symbol: "sharedSnapshotToken",
          hash,
        },
      ],
      "main",
    );
    await source.upsertEmbedding("shared-chunk", "fixture-model", [0.25, 0.75]);
    await source.setMeta("search_tokenizer_version", "1");
    await source.promoteGeneration();
    await source.close();

    const objectStore = new FilesystemSnapshotStore(directory);
    const exported = await exportIndexSnapshot({
      databaseUrl: schemaUrl,
      workspaceId: sourceWorkspace,
      name: "team-main",
      store: objectStore,
    });
    assert.equal(exported.manifest.counts.files, 1);
    assert.equal(exported.manifest.counts.chunks, 1);
    assert.equal(exported.manifest.counts.embeddings, 1);
    assert.doesNotMatch(JSON.stringify(exported.manifest), /private\/source/);
    assert.deepEqual(await listIndexSnapshots(objectStore), ["team-main"]);

    const imported = await importIndexSnapshot({
      databaseUrl: schemaUrl,
      workspaceId: "team-copy",
      name: "team-main",
      store: objectStore,
    });
    assert.equal(
      imported.manifest.artifact.sha256,
      exported.manifest.artifact.sha256,
    );
    const target = await PostgresStore.open({
      databaseUrl: schemaUrl,
      workspaceId: "team-copy",
    });
    assert.equal(
      (await target.ftsSearch("shared snapshot token", 5))[0]?.id,
      "shared-chunk",
    );
    assert.equal(await target.embeddingCount("fixture-model"), 1);
    assert.equal((await target.generationStatus()).indexedRevision, "7");
    await target.close();

    await appendFile(
      path.join(directory, exported.manifest.artifact.key),
      "tamper",
    );
    await assert.rejects(
      importIndexSnapshot({
        databaseUrl: schemaUrl,
        workspaceId: "rejected-copy",
        name: "team-main",
        store: objectStore,
      }),
      /checksum or size mismatch/,
    );
    const rejected = await PostgresStore.open({
      databaseUrl: schemaUrl,
      workspaceId: "rejected-copy",
    });
    assert.equal(await rejected.chunkCount(), 0);
    await rejected.close();

    await deleteIndexSnapshot({ name: "team-main", store: objectStore });
    assert.deepEqual(await listIndexSnapshots(objectStore), []);
    assert.deepEqual(await garbageCollectSnapshotArtifacts(objectStore), [
      exported.manifest.artifact.key,
    ]);
    assert.deepEqual(await garbageCollectSnapshotArtifacts(objectStore), []);
  });
});
