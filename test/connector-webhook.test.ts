import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { ConnectorWebhookProcessor } from "../src/server/connector-webhook.js";
import {
  ConnectorWebhookReplayError,
  WorkspaceRepository,
  type StoredConnectorSource,
} from "../src/server/workspace-repository.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaUrl(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres("persistent connector webhook inbox", () => {
  const schema = `ce_webhook_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  let first: WorkspaceRepository;
  let second: WorkspaceRepository;
  let source: StoredConnectorSource;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const url = schemaUrl(databaseUrl!, schema);
    first = await WorkspaceRepository.open(url);
    second = await WorkspaceRepository.open(url);
    const workspace = await first.createWorkspace({
      name: "Webhook inbox",
      sourceMode: "blob",
    });
    source = await first.createConnectorSource({
      workspaceId: workspace.id,
      provider: "fixture",
      externalId: "acme/payments",
      config: { ref: "main" },
      createdBy: "test",
    });
  });

  after(async () => {
    await first?.close();
    await second?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  it("deduplicates concurrent deliveries and rejects id reuse with new bytes", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => first.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-concurrent",
        bodyHash: "a".repeat(64),
        sourceIds: [source.id],
      })),
    );
    assert.equal(outcomes.reduce((sum, item) => sum + item.accepted, 0), 1);
    assert.equal(outcomes.reduce((sum, item) => sum + item.duplicates, 0), 19);
    await assert.rejects(
      first.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-concurrent",
        bodyHash: "b".repeat(64),
        sourceIds: [source.id],
      }),
      ConnectorWebhookReplayError,
    );
    const claims = await Promise.all([
      first.claimConnectorWebhookEvents(1),
      second.claimConnectorWebhookEvents(1),
    ]);
    assert.equal(claims.flat().length, 1);
    const claimed = claims.flat()[0];
    assert.equal(claimed.attempts, 1);
    await first.completeConnectorWebhookEvent(
      source.id,
      claimed.eventId,
      claimed.attempts,
      { noop: true },
    );

    const conflictingRace = await Promise.allSettled([
      first.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-conflicting-race",
        bodyHash: "e".repeat(64),
        sourceIds: [source.id],
      }),
      second.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-conflicting-race",
        bodyHash: "f".repeat(64),
        sourceIds: [source.id],
      }),
    ]);
    assert.equal(
      conflictingRace.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      conflictingRace.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    const [conflicting] = await first.claimConnectorWebhookEvents(1);
    await first.completeConnectorWebhookEvent(
      source.id,
      conflicting.eventId,
      conflicting.attempts,
      { noop: true },
    );
  });

  it("processes a persistent event once and leaves duplicates terminal", async () => {
    await first.enqueueConnectorWebhookEvents({
      provider: "fixture",
      eventId: "delivery-worker",
      bodyHash: "c".repeat(64),
      sourceIds: [source.id],
    });
    let syncCalls = 0;
    const processor = new ConnectorWebhookProcessor({
      repository: first,
      pollIntervalMs: 100,
      coordinator: {
        sync: async () => {
          syncCalls += 1;
          return {
            source,
            noop: true,
            revision: 0,
            changedPaths: [],
            deletedPaths: [],
            skippedOversized: 0,
            indexJob: null,
          };
        },
      },
    });
    processor.start();
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const event = await first.getConnectorWebhookEvent(source.id, "delivery-worker");
        if (event?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        (await first.getConnectorWebhookEvent(source.id, "delivery-worker"))?.status,
        "succeeded",
      );
      assert.equal(syncCalls, 1);
      const duplicate = await first.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-worker",
        bodyHash: "c".repeat(64),
        sourceIds: [source.id],
      });
      assert.deepEqual(duplicate, { accepted: 0, duplicates: 1 });
      processor.notify();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(syncCalls, 1);
    } finally {
      await processor.close();
    }
  });

  it("reclaims a processing event after its database-clock lease expires", async () => {
    await first.enqueueConnectorWebhookEvents({
      provider: "fixture",
      eventId: "delivery-recovery",
      bodyHash: "d".repeat(64),
      sourceIds: [source.id],
    });
    const [abandoned] = await first.claimConnectorWebhookEvents(1);
    assert.equal(abandoned.eventId, "delivery-recovery");
    await admin.query("SELECT pg_sleep(0.01)");
    const [recovered] = await second.claimConnectorWebhookEvents(1, 1);
    assert.equal(recovered.eventId, "delivery-recovery");
    assert.equal(recovered.attempts, 2);
    assert.equal(
      await first.completeConnectorWebhookEvent(
        source.id,
        abandoned.eventId,
        abandoned.attempts,
        { stale: true },
      ),
      false,
    );
    await second.completeConnectorWebhookEvent(
      source.id,
      recovered.eventId,
      recovered.attempts,
      { recovered: true },
    );
  });

  it("renews a fenced processing lease with the database clock", async () => {
    await first.enqueueConnectorWebhookEvents({
      provider: "fixture",
      eventId: "delivery-renewal",
      bodyHash: "7".repeat(64),
      sourceIds: [source.id],
    });
    const [claimed] = await first.claimConnectorWebhookEvents(1, 250);
    assert.equal(claimed.eventId, "delivery-renewal");
    await admin.query("SELECT pg_sleep(0.12)");
    assert.equal(
      await first.renewConnectorWebhookEventLease(
        source.id,
        claimed.eventId,
        claimed.attempts,
      ),
      true,
    );
    await admin.query("SELECT pg_sleep(0.12)");
    assert.deepEqual(await second.claimConnectorWebhookEvents(1, 250), []);
    await admin.query("SELECT pg_sleep(0.16)");
    const [recovered] = await second.claimConnectorWebhookEvents(1, 250);
    assert.equal(recovered.eventId, "delivery-renewal");
    assert.equal(recovered.attempts, 2);
    assert.equal(
      await first.renewConnectorWebhookEventLease(
        source.id,
        claimed.eventId,
        claimed.attempts,
      ),
      false,
    );
    await second.completeConnectorWebhookEvent(
      source.id,
      recovered.eventId,
      recovered.attempts,
      { recovered: true },
    );
  });

  it("keeps a long-running sync claimed through heartbeat renewal", async () => {
    await first.enqueueConnectorWebhookEvents({
      provider: "fixture",
      eventId: "delivery-long-running",
      bodyHash: "8".repeat(64),
      sourceIds: [source.id],
    });
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });
    let finishSync!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    const processor = new ConnectorWebhookProcessor({
      repository: first,
      pollIntervalMs: 100,
      processingLeaseMs: 120,
      coordinator: {
        sync: async () => {
          syncStarted();
          await finish;
          return {
            source,
            noop: true,
            revision: 0,
            changedPaths: [],
            deletedPaths: [],
            skippedOversized: 0,
            indexJob: null,
          };
        },
      },
    });
    processor.start();
    try {
      await started;
      await admin.query("SELECT pg_sleep(0.3)");
      assert.deepEqual(
        await second.claimConnectorWebhookEvents(1, 120),
        [],
      );
      finishSync();
      for (let attempt = 0; attempt < 50; attempt++) {
        const event = await first.getConnectorWebhookEvent(
          source.id,
          "delivery-long-running",
        );
        if (event?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const completed = await first.getConnectorWebhookEvent(
        source.id,
        "delivery-long-running",
      );
      assert.equal(completed?.status, "succeeded");
      assert.equal(completed?.attempts, 1);
    } finally {
      finishSync();
      await processor.close();
    }
  });

  it(
    "retries failures with backoff and stops at the configured attempt bound",
    { timeout: 6_000 },
    async () => {
      await first.enqueueConnectorWebhookEvents({
        provider: "fixture",
        eventId: "delivery-terminal-failure",
        bodyHash: "9".repeat(64),
        sourceIds: [source.id],
      });
      let syncCalls = 0;
      const processor = new ConnectorWebhookProcessor({
        repository: first,
        pollIntervalMs: 100,
        maxAttempts: 2,
        coordinator: {
          sync: async () => {
            syncCalls += 1;
            throw new Error("temporary fixture failure");
          },
        },
      });
      processor.start();
      try {
        for (let attempt = 0; attempt < 150; attempt++) {
          const event = await first.getConnectorWebhookEvent(
            source.id,
            "delivery-terminal-failure",
          );
          if (event?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const failed = await first.getConnectorWebhookEvent(
          source.id,
          "delivery-terminal-failure",
        );
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.attempts, 2);
        assert.equal(failed?.lastError, "temporary fixture failure");
        assert.equal(syncCalls, 2);
      } finally {
        await processor.close();
      }
    },
  );
});
