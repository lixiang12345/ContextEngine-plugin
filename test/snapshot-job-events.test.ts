import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";
import type {
  SnapshotObjectMetadata,
  SnapshotObjectStore,
} from "../src/snapshots/object-store.js";
import type { SnapshotJobEventWakeup } from "../src/server/snapshot-job-events.js";

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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedSnapshotStore implements SnapshotObjectStore {
  private entered = deferred();
  private released = deferred();
  private blockNextPut = true;

  constructor(private readonly inner: SnapshotObjectStore) {}

  reset(): void {
    this.entered = deferred();
    this.released = deferred();
    this.blockNextPut = true;
  }

  waitUntilBlocked(): Promise<void> {
    return this.entered.promise;
  }

  release(): void {
    this.released.resolve();
  }

  async put(
    key: string,
    source: Readable,
    metadata?: SnapshotObjectMetadata,
  ): Promise<void> {
    if (this.blockNextPut) {
      this.blockNextPut = false;
      this.entered.resolve();
      await this.released.promise;
    }
    await this.inner.put(key, source, metadata);
  }

  get(key: string): Promise<Readable> {
    return this.inner.get(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  list(prefix?: string): Promise<string[]> {
    if (!this.inner.list) throw new Error("listing is unavailable");
    return this.inner.list(prefix);
  }
}

class SilentSnapshotJobEventWakeup implements SnapshotJobEventWakeup {
  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {}
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ParsedJobEvent {
  id: string;
  data: {
    job: { status: string; attempts: number };
    event: { id: string; kind: string; attempt: number | null };
  };
}

function parseJobEvents(body: string): ParsedJobEvent[] {
  const parsed: ParsedJobEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    if (!lines.includes("event: job")) continue;
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (id && data) parsed.push({ id, data: JSON.parse(data) as ParsedJobEvent["data"] });
  }
  return parsed;
}

describePostgres("cross-instance snapshot job events", () => {
  const schema = `ce_snapshot_events_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const token = "snapshot-events-owner";
  let primaryDirectory = "";
  let targetDirectory = "";
  let primaryStore: FilesystemSnapshotStore;
  let targetStore: GatedSnapshotStore;
  let executor: HttpServerHandle | null = null;
  let observer: HttpServerHandle | null = null;
  let pollingObserver: HttpServerHandle | null = null;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    primaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-events-primary-"));
    targetDirectory = await mkdtemp(path.join(os.tmpdir(), "ce-events-target-"));
    primaryStore = new FilesystemSnapshotStore(primaryDirectory);
    targetStore = new GatedSnapshotStore(
      new FilesystemSnapshotStore(targetDirectory),
    );
    executor = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: token,
      disableEmbeddings: true,
      snapshotStore: primaryStore,
      snapshotReplicationTargets: { archive: targetStore },
      snapshotJobPollIntervalMs: 100,
    });
    observer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: token,
      disableEmbeddings: true,
      snapshotStore: primaryStore,
      snapshotJobPollIntervalMs: 100,
    });
  });

  after(async () => {
    if (pollingObserver) await pollingObserver.close();
    if (observer) await observer.close();
    if (executor) await executor.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
      await rm(primaryDirectory, { recursive: true, force: true });
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });

  function request(
    handle: HttpServerHandle,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function waitForJob(
    handle: HttpServerHandle,
    workspaceId: string,
    jobId: string,
  ): Promise<{ status: string; error: string | null }> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await request(
        handle,
        `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}`,
      );
      assert.equal(response.status, 200);
      const { job } = (await response.json()) as {
        job: { status: string; error: string | null };
      };
      if (job.status === "succeeded" || job.status === "failed") return job;
      if (Date.now() >= deadline) throw new Error(`job ${jobId} timed out`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  async function queueReplication(
    workspaceId: string,
  ): Promise<string> {
    const response = await request(
      executor!,
      `/v1/workspaces/${workspaceId}/snapshots/main/replicate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "archive" }),
      },
    );
    assert.equal(response.status, 202);
    return ((await response.json()) as { job: { id: string } }).job.id;
  }

  it("replays durable events on another instance and closes streams cleanly", async () => {
    const created = await request(executor!, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "snapshot event history" }),
    });
    assert.equal(created.status, 201);
    const workspaceId = ((await created.json()) as { workspace: { id: string } })
      .workspace.id;
    const exported = await request(
      executor!,
      `/v1/workspaces/${workspaceId}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "main" }),
      },
    );
    assert.equal(exported.status, 202);
    const exportJobId = ((await exported.json()) as { job: { id: string } }).job.id;
    assert.equal((await waitForJob(executor!, workspaceId, exportJobId)).status, "succeeded");

    const jobId = await queueReplication(workspaceId);
    await targetStore.waitUntilBlocked();
    const liveResponse = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/events`,
    );
    assert.equal(liveResponse.status, 200);
    assert.match(liveResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    targetStore.release();
    const liveEvents = parseJobEvents(await liveResponse.text());
    assert.ok(liveEvents.length >= 2);
    assert.ok(
      liveEvents.every(
        (event, index) =>
          event.id === event.data.event.id &&
          (index === 0 || BigInt(event.id) > BigInt(liveEvents[index - 1].id)),
      ),
    );
    assert.equal(liveEvents[liveEvents.length - 1].data.job.status, "succeeded");
    assert.equal(liveEvents[liveEvents.length - 1].data.event.kind, "succeeded");

    const fullReplay = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/events?after_event_id=0`,
    );
    assert.equal(fullReplay.status, 200);
    const allEvents = parseJobEvents(await fullReplay.text());
    assert.equal(allEvents[0].data.event.kind, "queued");
    assert.equal(allEvents[allEvents.length - 1].data.event.kind, "succeeded");
    assert.ok(allEvents.some((event) => event.data.event.kind === "attempt_started"));

    const resumeFrom = allEvents[1].id;
    const resumed = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/events`,
      { headers: { "last-event-id": resumeFrom } },
    );
    assert.equal(resumed.status, 200);
    const resumedEvents = parseJobEvents(await resumed.text());
    assert.deepEqual(
      resumedEvents.map((event) => event.id),
      allEvents.slice(2).map((event) => event.id),
    );

    const attempts = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/attempts?limit=1`,
    );
    assert.equal(attempts.status, 200);
    const attemptPayload = (await attempts.json()) as {
      attempts: Array<{
        attempt: number;
        budget_attempt: number;
        status: string;
        backfilled: boolean;
        started_at: string;
        last_heartbeat_at: string;
        completed_at: string | null;
      }>;
      next_before: number | null;
    };
    assert.equal(attemptPayload.attempts.length, 1);
    assert.deepEqual(
      {
        attempt: attemptPayload.attempts[0].attempt,
        budget_attempt: attemptPayload.attempts[0].budget_attempt,
        status: attemptPayload.attempts[0].status,
        backfilled: attemptPayload.attempts[0].backfilled,
      },
      {
        attempt: 1,
        budget_attempt: 1,
        status: "succeeded",
        backfilled: false,
      },
    );
    assert.match(attemptPayload.attempts[0].started_at, /^\d{4}-/);
    assert.match(attemptPayload.attempts[0].last_heartbeat_at, /^\d{4}-/);
    assert.match(attemptPayload.attempts[0].completed_at ?? "", /^\d{4}-/);
    assert.equal(attemptPayload.next_before, 1);

    const invalidCursor = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/events`,
      { headers: { "last-event-id": "9223372036854775808" } },
    );
    assert.equal(invalidCursor.status, 400);
    const conflictingCursor = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${jobId}/events?after_event_id=0`,
      { headers: { "last-event-id": allEvents[0].id } },
    );
    assert.equal(conflictingCursor.status, 400);

    pollingObserver = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: token,
      disableEmbeddings: true,
      snapshotStore: primaryStore,
      snapshotJobPollIntervalMs: 100,
      snapshotJobEventWakeup: new SilentSnapshotJobEventWakeup(),
    });
    targetStore.reset();
    const pollingJobId = await queueReplication(workspaceId);
    await targetStore.waitUntilBlocked();
    const pollingStream = await request(
      pollingObserver,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${pollingJobId}/events`,
    );
    targetStore.release();
    const pollingEvents = parseJobEvents(await pollingStream.text());
    assert.equal(
      pollingEvents[pollingEvents.length - 1].data.event.kind,
      "succeeded",
    );
    await pollingObserver.close();
    pollingObserver = null;

    targetStore.reset();
    const closingJobId = await queueReplication(workspaceId);
    await targetStore.waitUntilBlocked();
    const openStream = await request(
      observer!,
      `/v1/workspaces/${workspaceId}/snapshot-jobs/${closingJobId}/events`,
    );
    assert.equal(openStream.status, 200);
    await within(observer!.close(), 2_000);
    observer = null;
    await openStream.text();
    targetStore.release();
    assert.equal(
      (await waitForJob(executor!, workspaceId, closingJobId)).status,
      "succeeded",
    );
  });
});
