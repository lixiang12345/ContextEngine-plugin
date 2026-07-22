import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
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
});

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
