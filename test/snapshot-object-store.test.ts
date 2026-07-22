import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import { snapshotReplicationTargetsFromJson } from "../src/snapshots/config.js";
import { PrefixedSnapshotObjectStore } from "../src/snapshots/object-store.js";
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
