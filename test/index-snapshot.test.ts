import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import {
  deleteIndexSnapshot,
  exportIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  importIndexSnapshot,
  listIndexSnapshots,
  pruneIndexSnapshots,
  replicateIndexSnapshot,
} from "../src/snapshots/snapshot.js";
import { PostgresStore } from "../src/store/postgres-store.js";
import type {
  SnapshotObjectMetadata,
  SnapshotObjectRequestOptions,
  SnapshotObjectStore,
  SnapshotObjectVersion,
} from "../src/snapshots/object-store.js";

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

class PublicationRaceStore implements SnapshotObjectStore {
  private operationListCalls = 0;
  private readonly publicationCheckStarted: Promise<void>;
  private startPublicationCheck!: () => void;
  private readonly continuePublicationCheck: Promise<void>;
  private continuePublication!: () => void;

  constructor(private readonly inner: SnapshotObjectStore) {
    this.publicationCheckStarted = new Promise((resolve) => {
      this.startPublicationCheck = resolve;
    });
    this.continuePublicationCheck = new Promise((resolve) => {
      this.continuePublication = resolve;
    });
  }

  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    return this.inner.put(key, source, metadata, options);
  }

  get(key: string, options?: SnapshotObjectRequestOptions): Promise<Readable> {
    return this.inner.get(key, options);
  }

  delete(key: string, options?: SnapshotObjectRequestOptions): Promise<void> {
    return this.inner.delete(key, options);
  }

  async list(
    prefix = "",
    options?: SnapshotObjectRequestOptions,
  ): Promise<string[]> {
    if (prefix === "operations" && ++this.operationListCalls === 1) {
      this.startPublicationCheck();
      await this.continuePublicationCheck;
    }
    return this.inner.list!(prefix, options);
  }

  head(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotObjectVersion | null> {
    return this.inner.head!(key, options);
  }

  waitForPublicationCheck(): Promise<void> {
    return this.publicationCheckStarted;
  }

  releasePublicationCheck(): void {
    this.continuePublication();
  }
}

class GarbageCollectionRaceStore implements SnapshotObjectStore {
  private snapshotScanCaptured = false;
  private readonly snapshotScanStarted: Promise<void>;
  private startSnapshotScan!: () => void;
  private readonly continueGarbageCollection: Promise<void>;
  private continueGc!: () => void;

  constructor(private readonly inner: SnapshotObjectStore) {
    this.snapshotScanStarted = new Promise((resolve) => {
      this.startSnapshotScan = resolve;
    });
    this.continueGarbageCollection = new Promise((resolve) => {
      this.continueGc = resolve;
    });
  }

  put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    return this.inner.put(key, source, metadata, options);
  }

  get(key: string, options?: SnapshotObjectRequestOptions): Promise<Readable> {
    return this.inner.get(key, options);
  }

  delete(key: string, options?: SnapshotObjectRequestOptions): Promise<void> {
    return this.inner.delete(key, options);
  }

  async list(
    prefix = "",
    options?: SnapshotObjectRequestOptions,
  ): Promise<string[]> {
    const captured = await this.inner.list!(prefix, options);
    if (prefix === "snapshots" && !this.snapshotScanCaptured) {
      this.snapshotScanCaptured = true;
      this.startSnapshotScan();
      await this.continueGarbageCollection;
    }
    return captured;
  }

  waitForSnapshotScan(): Promise<void> {
    return this.snapshotScanStarted;
  }

  releaseGarbageCollection(): void {
    this.continueGc();
  }
}

describePostgres("portable index snapshots", () => {
  const schema = `ce_snapshot_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  let directory = "";
  let replicaDirectory = "";
  let raceDirectory = "";

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    directory = await mkdtemp(path.join(os.tmpdir(), "ce-index-snapshot-"));
    replicaDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-index-replica-"));
    raceDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-index-race-"));
  });

  after(async () => {
    try {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
      await rm(directory, { recursive: true, force: true });
      await rm(replicaDirectory, { recursive: true, force: true });
      await rm(raceDirectory, { recursive: true, force: true });
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
    assert.deepEqual(await objectStore.list("operations"), []);
    assert.deepEqual(await listIndexSnapshots(objectStore), ["team-main"]);

    // Force the dangerous interleaving: export has published its marker but
    // has not yet checked for GC, then GC starts. The bilateral marker
    // handshake makes GC back off; export subsequently succeeds with its
    // artifact still present.
    const raceStore = new PublicationRaceStore(
      new FilesystemSnapshotStore(path.join(raceDirectory, "export-first")),
    );
    const racingExport = exportIndexSnapshot({
      databaseUrl: schemaUrl,
      workspaceId: sourceWorkspace,
      name: "race-safe",
      store: raceStore,
    });
    await raceStore.waitForPublicationCheck();
    try {
      await assert.rejects(
        garbageCollectSnapshotArtifacts(raceStore),
        /publication is active/,
      );
    } finally {
      raceStore.releasePublicationCheck();
    }
    const safeExport = await racingExport;
    assert.ok(await raceStore.head(safeExport.manifest.artifact.key));
    assert.deepEqual(await raceStore.list("operations"), []);

    const gcMarkerKey = `operations/gc-${randomUUID()}.json`;
    await raceStore.put(
      gcMarkerKey,
      Readable.from([JSON.stringify({ created_at: new Date().toISOString() })]),
    );
    await assert.rejects(
      exportIndexSnapshot({
        databaseUrl: schemaUrl,
        workspaceId: sourceWorkspace,
        name: "blocked-by-gc",
        store: raceStore,
      }),
      /garbage collection is active/,
    );
    await raceStore.delete(gcMarkerKey);
    assert.ok(await raceStore.head(safeExport.manifest.artifact.key));

    // Reproduce the original TOCTOU ordering: GC has captured an empty
    // manifest list, then export starts. The GC marker now forces export to
    // abort instead of publishing an artifact that the stale scan can delete.
    const gcFirstStore = new GarbageCollectionRaceStore(
      new FilesystemSnapshotStore(path.join(raceDirectory, "gc-first")),
    );
    const racingGc = garbageCollectSnapshotArtifacts(gcFirstStore);
    await gcFirstStore.waitForSnapshotScan();
    try {
      await assert.rejects(
        exportIndexSnapshot({
          databaseUrl: schemaUrl,
          workspaceId: sourceWorkspace,
          name: "must-not-publish-during-gc",
          store: gcFirstStore,
        }),
        /garbage collection is active/,
      );
    } finally {
      gcFirstStore.releaseGarbageCollection();
    }
    assert.deepEqual(await racingGc, []);
    assert.deepEqual(await gcFirstStore.list("operations"), []);
    assert.deepEqual(await gcFirstStore.list("snapshots"), []);

    const replicaStore = new FilesystemSnapshotStore(replicaDirectory);
    const replicated = await replicateIndexSnapshot({
      name: "team-main",
      source: objectStore,
      target: replicaStore,
    });
    assert.equal(replicated.artifactKey, exported.manifest.artifact.key);
    assert.deepEqual(await listIndexSnapshots(replicaStore), ["team-main"]);
    const replicaImport = await importIndexSnapshot({
      databaseUrl: schemaUrl,
      workspaceId: "region-copy",
      name: "team-main",
      store: replicaStore,
    });
    assert.equal(replicaImport.manifest.artifact.sha256, exported.manifest.artifact.sha256);

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

    await exportIndexSnapshot({
      databaseUrl: schemaUrl,
      workspaceId: sourceWorkspace,
      name: "team-new",
      store: objectStore,
    });
    assert.deepEqual(
      await pruneIndexSnapshots({ store: objectStore, keepLatest: 1 }),
      ["team-main"],
    );
    assert.deepEqual(await listIndexSnapshots(objectStore), ["team-new"]);
    await deleteIndexSnapshot({ name: "team-new", store: objectStore });
    assert.deepEqual(await listIndexSnapshots(objectStore), []);
    const markerKey = `operations/publish-${randomUUID()}.json`;
    await objectStore.put(
      markerKey,
      Readable.from([JSON.stringify({ created_at: new Date().toISOString() })]),
    );
    await assert.rejects(
      garbageCollectSnapshotArtifacts(objectStore),
      /publication is active/,
    );
    await objectStore.delete(markerKey);
    assert.deepEqual(
      await garbageCollectSnapshotArtifacts(objectStore, {
        preserveArtifactKeys: [exported.manifest.artifact.key],
      }),
      [],
    );
    assert.deepEqual(await garbageCollectSnapshotArtifacts(objectStore), [
      exported.manifest.artifact.key,
    ]);
    assert.deepEqual(await garbageCollectSnapshotArtifacts(objectStore), []);
  });
});
