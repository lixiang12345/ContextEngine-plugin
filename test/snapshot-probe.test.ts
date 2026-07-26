import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import {
  PrefixedSnapshotObjectStore,
  type SnapshotObjectMetadata,
  type SnapshotObjectStore,
} from "../src/snapshots/object-store.js";
import { probeSnapshotObjectStore } from "../src/snapshots/probe.js";
import {
  classifySnapshotStoreError,
  isNonRetryableSnapshotStoreError,
} from "../src/snapshots/store-errors.js";
import {
  SnapshotStoreTimeoutError,
  withSnapshotStoreTimeouts,
} from "../src/snapshots/timeout-store.js";

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function s3Error(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name}: simulated`);
  error.name = name;
  return Object.assign(error, { $metadata: { httpStatusCode } });
}

describe("snapshot store error classification", () => {
  it("classifies filesystem errno codes", () => {
    assert.equal(classifySnapshotStoreError(errnoError("EACCES")), "permission");
    assert.equal(classifySnapshotStoreError(errnoError("EPERM")), "permission");
    assert.equal(classifySnapshotStoreError(errnoError("EROFS")), "permission");
    assert.equal(classifySnapshotStoreError(errnoError("ENOSPC")), "capacity");
    assert.equal(classifySnapshotStoreError(errnoError("EDQUOT")), "capacity");
    assert.equal(classifySnapshotStoreError(errnoError("ENOENT")), "not_found");
    assert.equal(classifySnapshotStoreError(errnoError("ETIMEDOUT")), "timeout");
    assert.equal(classifySnapshotStoreError(errnoError("ECONNRESET")), "transient");
  });

  it("classifies S3 error names and status codes", () => {
    assert.equal(classifySnapshotStoreError(s3Error("AccessDenied", 403)), "permission");
    assert.equal(classifySnapshotStoreError(s3Error("SomeError", 403)), "permission");
    assert.equal(classifySnapshotStoreError(s3Error("InvalidAccessKeyId")), "permission");
    assert.equal(classifySnapshotStoreError(s3Error("SomeError", 507)), "capacity");
    assert.equal(classifySnapshotStoreError(s3Error("RequestTimeout")), "timeout");
    assert.equal(classifySnapshotStoreError(s3Error("NoSuchKey", 404)), "not_found");
    assert.equal(classifySnapshotStoreError(s3Error("SlowDown", 503)), "transient");
  });

  it("keeps rotating-credential errors retryable despite their 403 status", () => {
    assert.equal(classifySnapshotStoreError(s3Error("ExpiredToken", 403)), "transient");
    assert.equal(
      classifySnapshotStoreError(s3Error("TokenRefreshRequired", 403)),
      "transient",
    );
    assert.equal(
      classifySnapshotStoreError(s3Error("CredentialsProviderError")),
      "transient",
    );
    assert.equal(isNonRetryableSnapshotStoreError(s3Error("ExpiredToken", 403)), false);
  });

  it("walks the cause chain and bounds unknown shapes", () => {
    const wrapped = new Error("outer", { cause: errnoError("ENOSPC") });
    assert.equal(classifySnapshotStoreError(wrapped), "capacity");
    assert.equal(classifySnapshotStoreError(new Error("plain")), "transient");
    assert.equal(classifySnapshotStoreError(undefined), "transient");
    assert.equal(classifySnapshotStoreError("string error"), "transient");
  });

  it("marks only permission and capacity failures as non-retryable", () => {
    assert.equal(isNonRetryableSnapshotStoreError(errnoError("EACCES")), true);
    assert.equal(isNonRetryableSnapshotStoreError(errnoError("ENOSPC")), true);
    assert.equal(isNonRetryableSnapshotStoreError(errnoError("ENOENT")), false);
    assert.equal(isNonRetryableSnapshotStoreError(new Error("flaky network")), false);
    assert.equal(isNonRetryableSnapshotStoreError(errnoError("ETIMEDOUT")), false);
  });
});

describe("snapshot store operation timeouts", () => {
  const hangingStore: SnapshotObjectStore = {
    async put() {},
    async get() {
      return Readable.from("ok");
    },
    async delete() {},
    head(_key, options) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  };

  it("rewrites a fired deadline into a classifiable timeout error", async () => {
    const guarded = withSnapshotStoreTimeouts(hangingStore, { metadataMs: 50 });
    await assert.rejects(
      guarded.head!("snapshots/main/manifest.json"),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotStoreTimeoutError);
        assert.match(error.message, /head timed out after 50ms/);
        assert.equal(classifySnapshotStoreError(error), "timeout");
        assert.equal(isNonRetryableSnapshotStoreError(error), false);
        return true;
      },
    );
  });

  it("preserves the caller's own abort error", async () => {
    const guarded = withSnapshotStoreTimeouts(hangingStore, { metadataMs: 5_000 });
    const controller = new AbortController();
    const pending = guarded.head!("snapshots/main/manifest.json", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller cancelled"));
    await assert.rejects(pending, /caller cancelled/);
  });

  it("returns the raw store when every timeout is disabled", () => {
    assert.equal(
      withSnapshotStoreTimeouts(hangingStore, { metadataMs: 0, transferMs: null }),
      hangingStore,
    );
  });

  it("settles even when the store never observes the abort signal", async () => {
    const stubborn: SnapshotObjectStore = {
      async put() {},
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
      head() {
        // Simulates a syscall stuck on a hung mount: no signal handling at all.
        return new Promise<never>(() => undefined);
      },
    };
    const guarded = withSnapshotStoreTimeouts(stubborn, { metadataMs: 50 });
    await assert.rejects(
      guarded.head!("snapshots/main/manifest.json"),
      SnapshotStoreTimeoutError,
    );
  });

  it("destroys a stalled get stream after the transfer deadline", async () => {
    let pushed = false;
    const stalled: SnapshotObjectStore = {
      async put() {},
      async get() {
        // A stream that emits one chunk and then never ends.
        return new Readable({
          read() {
            if (!pushed) {
              pushed = true;
              this.push("partial");
            }
          },
        });
      },
      async delete() {},
    };
    const guarded = withSnapshotStoreTimeouts(stalled, { transferMs: 60 });
    const stream = await guarded.get("objects/sha256/artifact");
    await assert.rejects(
      (async () => {
        // Consume until the deadline destroys the stream.
        for await (const chunk of stream) void chunk;
      })(),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotStoreTimeoutError);
        assert.match(error.message, /get timed out after 60ms/);
        return true;
      },
    );
  });

  it("only forwards the optional capabilities the inner store implements", () => {
    const minimal: SnapshotObjectStore = {
      async put() {},
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const guarded = withSnapshotStoreTimeouts(minimal, { metadataMs: 50 });
    assert.equal(guarded.head, undefined);
    assert.equal(guarded.putConditional, undefined);
    assert.equal(guarded.list, undefined);
  });
});

describe("snapshot object store probe", () => {
  let directory = "";
  let store: FilesystemSnapshotStore;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "ce-snapshot-probe-"));
    store = new FilesystemSnapshotStore(directory);
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("exercises write/head/read/CAS/list/delete and cleans up", async () => {
    const result = await probeSnapshotObjectStore(store, {
      capacity: async () => ({ availableBytes: 1_000, totalBytes: 2_000 }),
    });
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.deepEqual(result.capabilities, {
      list: true,
      head: true,
      conditionalWrite: true,
    });
    assert.deepEqual(
      result.checks.map((check) => [check.operation, check.status]),
      [
        ["write", "ok"],
        ["head", "ok"],
        ["read", "ok"],
        ["conditional_write", "ok"],
        ["list", "ok"],
        ["delete", "ok"],
      ],
    );
    for (const check of result.checks) {
      assert.equal(typeof check.latencyMs, "number");
    }
    assert.deepEqual(result.capacity, { availableBytes: 1_000, totalBytes: 2_000 });
    assert.deepEqual(await store.list("probe"), []);
  });

  it("reports reduced capability sets without failing the probe", async () => {
    const minimal: SnapshotObjectStore = {
      async put() {},
      async get() {
        return Readable.from("wrong-content");
      },
      async delete() {},
    };
    const result = await probeSnapshotObjectStore(minimal);
    assert.deepEqual(result.capabilities, {
      list: false,
      head: false,
      conditionalWrite: false,
    });
    const read = result.checks.find((check) => check.operation === "read");
    assert.equal(read?.status, "failed");
    assert.match(read?.error ?? "", /content did not match/);
    assert.equal(result.ok, false);
  });

  it("classifies a permission failure and skips dependent checks", async () => {
    const denied: SnapshotObjectStore = {
      async put() {
        throw errnoError("EACCES");
      },
      async get() {
        throw new Error("must not be read after a failed write");
      },
      async delete() {},
      async list() {
        throw new Error("must not be listed after a failed write");
      },
      async head() {
        throw new Error("must not be headed after a failed write");
      },
      async putConditional() {
        throw new Error("must not CAS after a failed write");
      },
    };
    const result = await probeSnapshotObjectStore(denied);
    assert.equal(result.ok, false);
    const byOperation = new Map(
      result.checks.map((check) => [check.operation, check]),
    );
    assert.equal(byOperation.get("write")?.status, "failed");
    assert.equal(byOperation.get("write")?.classification, "permission");
    assert.equal(byOperation.get("head")?.status, "skipped");
    assert.equal(byOperation.get("read")?.status, "skipped");
    assert.equal(byOperation.get("conditional_write")?.status, "skipped");
    assert.equal(byOperation.get("list")?.status, "skipped");
    assert.equal(byOperation.get("delete")?.status, "ok");
  });

  it("bounds a hung operation with its own timeout signal", async () => {
    const hanging: SnapshotObjectStore = {
      put(_key, source, _metadata, options) {
        source.resume();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const result = await probeSnapshotObjectStore(hanging, {
      operationTimeoutMs: 100,
    });
    const write = result.checks.find((check) => check.operation === "write");
    assert.equal(write?.status, "failed");
    assert.equal(write?.classification, "timeout");
    assert.equal(result.ok, false);
    assert.equal(result.operationTimeoutMs, 100);
  });

  it("still responds when the store never observes the abort signal", async () => {
    const stubborn: SnapshotObjectStore = {
      put(_key, source) {
        source.resume();
        // Simulates a probe against a hung mount: the promise never settles
        // and no signal is observed.
        return new Promise<never>(() => undefined);
      },
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const result = await probeSnapshotObjectStore(stubborn, {
      operationTimeoutMs: 80,
      capacity: () => new Promise<never>(() => undefined),
    });
    const write = result.checks.find((check) => check.operation === "write");
    assert.equal(write?.status, "failed");
    assert.equal(write?.classification, "timeout");
    assert.equal(result.capacity, null, "hung capacity reader must also time out");
  });

  it("passes contentLength so real S3 targets accept the probe stream", async () => {
    let observed: SnapshotObjectMetadata | undefined;
    const capturing: SnapshotObjectStore = {
      async put(_key, source, metadata) {
        observed = metadata;
        source.resume();
      },
      async get() {
        return Readable.from("wrong");
      },
      async delete() {},
    };
    await probeSnapshotObjectStore(capturing);
    assert.ok(observed);
    assert.ok((observed.contentLength ?? 0) > 0);
  });

  it("sweeps stale orphaned probe objects during the list check", async () => {
    const orphanKey = `probe/${Date.now() - 2 * 60 * 60_000}-orphan`;
    await store.put(orphanKey, Readable.from("orphan"));
    const freshKey = `probe/${Date.now()}-concurrent`;
    await store.put(freshKey, Readable.from("concurrent"));
    const result = await probeSnapshotObjectStore(store);
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    const remaining = await store.list("probe");
    assert.ok(!remaining.includes(orphanKey), "stale orphan must be swept");
    assert.ok(
      remaining.includes(freshKey),
      "recent objects from a concurrent probe must survive",
    );
    await store.delete(freshKey);
  });

  it("scrubs absolute filesystem paths from probe error output", async () => {
    const leaky: SnapshotObjectStore = {
      async put() {
        throw Object.assign(
          new Error(
            "EACCES: permission denied, open '/private/srv/snapshots/workspaces/abc/probe/x'",
          ),
          { code: "EACCES" },
        );
      },
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const result = await probeSnapshotObjectStore(leaky);
    const write = result.checks.find((check) => check.operation === "write");
    assert.equal(write?.classification, "permission");
    assert.ok(!(write?.error ?? "").includes("/private/srv"));
    assert.match(write?.error ?? "", /<path>/);
  });

  it("sees capabilities through the prefix wrapper", async () => {
    const listless: SnapshotObjectStore = {
      async put() {},
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const prefixed = new PrefixedSnapshotObjectStore(listless, "workspaces/team");
    assert.equal(prefixed.list, undefined);
    const result = await probeSnapshotObjectStore(prefixed);
    assert.equal(result.capabilities.list, false);
    assert.ok(!result.checks.some((check) => check.operation === "list"));
  });

  it("bounds oversized error messages", async () => {
    const noisy: SnapshotObjectStore = {
      async put() {
        throw new Error("x".repeat(1_000));
      },
      async get() {
        return Readable.from("ok");
      },
      async delete() {},
    };
    const result = await probeSnapshotObjectStore(noisy);
    const write = result.checks.find((check) => check.operation === "write");
    assert.ok((write?.error ?? "").length <= 201);
  });
});
