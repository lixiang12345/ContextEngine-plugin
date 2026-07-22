import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import { snapshotReplicationTargetsFromJson } from "../src/snapshots/config.js";
import {
  PrefixedSnapshotObjectStore,
  supportsConditionalSnapshotWrites,
  type SnapshotObjectStore,
} from "../src/snapshots/object-store.js";
import {
  loadIndexSnapshotManifest,
  replicateIndexSnapshot,
  type SnapshotManifest,
} from "../src/snapshots/snapshot.js";
import {
  S3SnapshotStore,
  type S3CommandClient,
} from "../src/snapshots/s3-store.js";

describe("snapshot object stores", () => {
  it("writes filesystem objects atomically and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ce-snapshot-store-"));
    const store = new FilesystemSnapshotStore(root);
    await store.put(
      "snapshots/team/manifest.json",
      Readable.from(["manifest"]),
    );
    assert.equal(
      await readFile(path.join(root, "snapshots/team/manifest.json"), "utf8"),
      "manifest",
    );
    assert.equal(
      await streamText(await store.get("snapshots/team/manifest.json")),
      "manifest",
    );
    assert.deepEqual(await store.list("snapshots"), [
      "snapshots/team/manifest.json",
    ]);
    await assert.rejects(
      store.put("../escape", Readable.from(["bad"])),
      /Invalid snapshot object key/,
    );
    await store.delete("snapshots/team/manifest.json");
    await assert.rejects(async () =>
      streamText(await store.get("snapshots/team/manifest.json")),
    );
  });

  it("conditionally publishes filesystem objects using stable entity tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ce-snapshot-cas-"));
    const store = new FilesystemSnapshotStore(root);
    const key = "snapshots/team/manifest.json";
    assert.equal(await store.head(key), null);
    const created = await store.putConditional(
      key,
      Readable.from(["first"]),
      { ifAbsent: true },
      { contentLength: 5 },
    );
    assert.equal(created.written, true);
    assert.match(created.entityTag ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(await store.head(key), {
      entityTag: created.entityTag,
      contentLength: 5,
    });
    assert.equal(
      (await store.putConditional(key, Readable.from(["ignored"]), { ifAbsent: true }))
        .written,
      false,
    );
    assert.equal(
      (
        await store.putConditional(key, Readable.from(["ignored"]), {
          entityTag: "0".repeat(64),
        })
      ).written,
      false,
    );
    assert.equal(await streamText(await store.get(key)), "first");
    const replaced = await store.putConditional(
      key,
      Readable.from(["second"]),
      { entityTag: created.entityTag! },
      { contentLength: 6 },
    );
    assert.equal(replaced.written, true);
    assert.notEqual(replaced.entityTag, created.entityTag);
    assert.equal(await streamText(await store.get(key)), "second");
    await assert.rejects(
      store.putConditional(
        key,
        Readable.from(["short"]),
        { entityTag: replaced.entityTag! },
        { contentLength: 99 },
      ),
      /content length mismatch/,
    );
    const lock = path.join(root, `${key}.contextengine-lock`);
    await writeFile(lock, "orphaned-lock");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(new Error("stop waiting for lock")),
      25,
    );
    try {
      await assert.rejects(
        store.putConditional(
          key,
          Readable.from(["must-not-write"]),
          { entityTag: replaced.entityTag! },
          {},
          { signal: abortController.signal },
        ),
        /aborted/i,
      );
    } finally {
      clearTimeout(timer);
      await rm(lock, { force: true });
    }
    assert.equal(await streamText(await store.get(key)), "second");
  });

  it("maps the portable contract to bounded S3 commands", async () => {
    const commands: Array<{
      constructor: { name: string };
      input: Record<string, unknown>;
    }> = [];
    const client: S3CommandClient = {
      async send(command: object): Promise<unknown> {
        commands.push(command as (typeof commands)[number]);
        if (command.constructor.name === "GetObjectCommand") {
          return { Body: Readable.from(["body"]) };
        }
        if (command.constructor.name === "ListObjectsV2Command") {
          return {
            Contents: [
              { Key: "contextengine/shared/snapshots/team/manifest.json" },
            ],
          };
        }
        return {};
      },
    };
    const store = new S3SnapshotStore({
      bucket: "team-indexes",
      prefix: "contextengine/shared",
      serverSideEncryption: "aws:kms",
      kmsKeyId: "key-1",
      client,
    });
    await store.put("objects/a", Readable.from(["body"]), {
      contentLength: 4,
      checksumSha256: "00".repeat(32),
    });
    assert.equal(await streamText(await store.get("objects/a")), "body");
    assert.deepEqual(await store.list("snapshots"), [
      "snapshots/team/manifest.json",
    ]);
    await store.delete("objects/a");
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      [
        "PutObjectCommand",
        "GetObjectCommand",
        "ListObjectsV2Command",
        "DeleteObjectCommand",
      ],
    );
    assert.equal(commands[0].input.Bucket, "team-indexes");
    assert.equal(commands[0].input.Key, "contextengine/shared/objects/a");
    assert.equal(commands[0].input.ServerSideEncryption, "aws:kms");
    assert.equal(commands[0].input.SSEKMSKeyId, "key-1");
    assert.equal(
      commands[0].input.ChecksumSHA256,
      Buffer.alloc(32).toString("base64"),
    );
    assert.equal(commands[2].input.Prefix, "contextengine/shared/snapshots/");
  });

  it("maps conditional S3 writes, conflicts, head, and abort signals", async () => {
    const calls: Array<{
      command: { constructor: { name: string }; input: Record<string, unknown> };
      options?: { abortSignal?: AbortSignal };
    }> = [];
    let conflict = false;
    const client: S3CommandClient = {
      async send(command, options): Promise<unknown> {
        calls.push({
          command: command as (typeof calls)[number]["command"],
          options,
        });
        if (command.constructor.name === "HeadObjectCommand") {
          return { ETag: '"etag-1"', ContentLength: 12 };
        }
        if (conflict) {
          throw { $metadata: { httpStatusCode: 412 } };
        }
        return { ETag: '"etag-2"' };
      },
    };
    const store = new S3SnapshotStore({ bucket: "team-indexes", client });
    const abortController = new AbortController();
    assert.deepEqual(await store.head("snapshots/main/manifest.json"), {
      entityTag: '"etag-1"',
      contentLength: 12,
    });
    const created = await store.putConditional(
      "snapshots/main/manifest.json",
      Readable.from(["body"]),
      { ifAbsent: true },
      {},
      { signal: abortController.signal },
    );
    assert.deepEqual(created, { written: true, entityTag: '"etag-2"' });
    conflict = true;
    assert.deepEqual(
      await store.putConditional(
        "snapshots/main/manifest.json",
        Readable.from(["body"]),
        { entityTag: '"etag-1"' },
      ),
      { written: false },
    );
    assert.equal(calls[1].command.input.IfNoneMatch, "*");
    assert.equal(calls[1].options?.abortSignal, abortController.signal);
    assert.equal(calls[2].command.input.IfMatch, '"etag-1"');
  });

  it("isolates callers behind validated object prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ce-prefixed-store-"));
    const base = new FilesystemSnapshotStore(root);
    const alice = new PrefixedSnapshotObjectStore(base, "workspaces/alice");
    const bob = new PrefixedSnapshotObjectStore(base, "workspaces/bob");
    await alice.put("snapshots/main/manifest.json", Readable.from(["alice"]));
    assert.deepEqual(await alice.list("snapshots"), [
      "snapshots/main/manifest.json",
    ]);
    assert.deepEqual(await bob.list("snapshots"), []);
    await assert.rejects(
      bob.get("snapshots/main/manifest.json").then(streamText),
    );
    assert.equal(supportsConditionalSnapshotWrites(alice), true);
    const current = await alice.head!("snapshots/main/manifest.json");
    assert.equal(
      (
        await alice.putConditional!(
          "snapshots/main/manifest.json",
          Readable.from(["alice-v2"]),
          { entityTag: current!.entityTag },
        )
      ).written,
      true,
    );
    assert.equal(
      await readFile(
        path.join(root, "workspaces/alice/snapshots/main/manifest.json"),
        "utf8",
      ),
      "alice-v2",
    );
  });

  it("never lets a stale CAS publication roll back a newer manifest", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "ce-source-cas-"));
    const newerRoot = await mkdtemp(path.join(os.tmpdir(), "ce-source-newer-"));
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "ce-target-cas-"));
    const source = new FilesystemSnapshotStore(sourceRoot);
    const newer = new FilesystemSnapshotStore(newerRoot);
    const target = new FilesystemSnapshotStore(targetRoot);
    const oldLoaded = await writeSyntheticSnapshot(source, "main", "old", "old-body");
    const newLoaded = await writeSyntheticSnapshot(newer, "main", "new", "new-body");

    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    let delayFirst = true;
    const delayedTarget: SnapshotObjectStore = {
      put: (...args) => target.put(...args),
      get: (...args) => target.get(...args),
      delete: (...args) => target.delete(...args),
      list: (...args) => target.list(...args),
      head: (...args) => target.head(...args),
      async putConditional(...args) {
        if (delayFirst) {
          delayFirst = false;
          firstEnteredResolve();
          await firstReleased;
        }
        return target.putConditional(...args);
      },
    };
    const stale = replicateIndexSnapshot({
      name: "main",
      source,
      target: delayedTarget,
      publication: {
        publicationSequence: "1",
        sourceManifest: oldLoaded.manifest,
        sourceManifestSha256: oldLoaded.sha256,
      },
    });
    await firstEntered;
    const latest = await replicateIndexSnapshot({
      name: "main",
      source: newer,
      target: delayedTarget,
      publication: {
        publicationSequence: "2",
        sourceManifest: newLoaded.manifest,
        sourceManifestSha256: newLoaded.sha256,
      },
    });
    assert.equal(latest.publicationStatus, "published");
    releaseFirst();
    assert.equal((await stale).publicationStatus, "superseded");

    const published = await loadIndexSnapshotManifest({
      name: "main",
      store: target,
    });
    assert.equal(published.manifest.generation_id, "new");
    assert.equal(published.manifest.replication?.publication_sequence, "2");
    assert.equal(
      (
        await replicateIndexSnapshot({
          name: "main",
          source: newer,
          target,
          publication: {
            publicationSequence: "2",
            sourceManifest: newLoaded.manifest,
            sourceManifestSha256: newLoaded.sha256,
          },
        })
      ).publicationStatus,
      "already_current",
    );
    await target.put(
      "snapshots/main/manifest.json",
      Readable.from([
        JSON.stringify({ ...published.manifest, generation_id: "tampered" }),
      ]),
    );
    await assert.rejects(
      replicateIndexSnapshot({
        name: "main",
        source: newer,
        target,
        publication: {
          publicationSequence: "2",
          sourceManifest: newLoaded.manifest,
          sourceManifestSha256: newLoaded.sha256,
        },
      }),
      /conflicting source manifests/,
    );
    await target.put(
      "snapshots/main/manifest.json",
      Readable.from([JSON.stringify(published.manifest)]),
    );
    await assert.rejects(
      replicateIndexSnapshot({
        name: "main",
        source,
        target,
        publication: {
          publicationSequence: "2",
          sourceManifest: oldLoaded.manifest,
          sourceManifestSha256: oldLoaded.sha256,
        },
      }),
      /conflicting source manifests/,
    );
  });

  it("reports when a minimal custom store cannot provide strict fencing", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "ce-source-fallback-"));
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "ce-target-fallback-"));
    const source = new FilesystemSnapshotStore(sourceRoot);
    const target = new FilesystemSnapshotStore(targetRoot);
    const loaded = await writeSyntheticSnapshot(source, "main", "fallback", "body");
    const minimal: SnapshotObjectStore = {
      put: (...args) => target.put(...args),
      get: (...args) => target.get(...args),
      delete: (...args) => target.delete(...args),
    };
    await source.delete(loaded.manifest.artifact.key);
    const superseded = await replicateIndexSnapshot({
      name: "main",
      source,
      target: minimal,
      publication: {
        publicationSequence: "9",
        sourceManifest: loaded.manifest,
        sourceManifestSha256: loaded.sha256,
      },
      isPublicationCurrent: async () => false,
    });
    assert.equal(superseded.publicationStatus, "superseded");
    await source.put(loaded.manifest.artifact.key, Readable.from(["body"]));
    const result = await replicateIndexSnapshot({
      name: "main",
      source,
      target: minimal,
      publication: {
        publicationSequence: "10",
        sourceManifest: loaded.manifest,
        sourceManifestSha256: loaded.sha256,
      },
    });
    assert.equal(result.publicationStatus, "published");
    assert.equal(result.strictFencing, false);
  });

  it("rejects unsafe S3 configuration", () => {
    assert.throws(
      () => new S3SnapshotStore({ bucket: "Bad_Bucket" }),
      /bucket name/,
    );
    assert.throws(
      () =>
        new S3SnapshotStore({
          bucket: "valid-bucket",
          endpoint: "https://user:pass@example.com",
        }),
      /without credentials/,
    );
    assert.throws(
      () =>
        new S3SnapshotStore({ bucket: "valid-bucket", prefix: "../escape" }),
      /Invalid snapshot object key/,
    );
  });

  it("parses bounded named replication targets without persisting credentials", () => {
    const targets = snapshotReplicationTargetsFromJson(
      JSON.stringify({ secondary: "./replica", archive_1: "./archive" }),
      "/tmp/contextengine-targets",
    );
    assert.deepEqual([...targets.keys()], ["archive_1", "secondary"]);
    assert.ok(targets.get("secondary") instanceof FilesystemSnapshotStore);
    assert.throws(
      () => snapshotReplicationTargetsFromJson('{"Bad Target":"./replica"}'),
      /Invalid snapshot replication target id/,
    );
    assert.throws(
      () => snapshotReplicationTargetsFromJson("[]"),
      /JSON object/,
    );
  });
});

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function writeSyntheticSnapshot(
  store: SnapshotObjectStore,
  name: string,
  generationId: string,
  artifactBody: string,
) {
  const sha256 = createHash("sha256").update(artifactBody).digest("hex");
  const artifactKey = `objects/sha256/${sha256}.ndjson.gz`;
  const manifest: SnapshotManifest = {
    format_version: 1,
    index_version: 3,
    created_at: new Date().toISOString(),
    workspace_fingerprint: "0".repeat(64),
    generation_id: generationId,
    source_revision: generationId,
    indexed_revision: generationId,
    artifact: {
      key: artifactKey,
      sha256,
      bytes: Buffer.byteLength(artifactBody),
      content_encoding: "gzip",
    },
    counts: { metadata: 0, files: 0, chunks: 0, embeddings: 0 },
  };
  await store.put(artifactKey, Readable.from([artifactBody]));
  await store.put(
    `snapshots/${name}/manifest.json`,
    Readable.from([JSON.stringify(manifest)]),
  );
  return loadIndexSnapshotManifest({ name, store });
}
