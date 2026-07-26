import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import {
  type ClaimedIndexJob,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";

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

describePostgres("cross-instance index job events", () => {
  const schema = `ce_index_events_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const token = "index-events-owner";
  let repository: WorkspaceRepository;
  let executor: HttpServerHandle;
  let observer: HttpServerHandle;
  let claim: ClaimedIndexJob;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    repository = await WorkspaceRepository.open(schemaUrl);
    const workspace = await repository.createWorkspace({
      name: "cross-instance index events",
      sourceMode: "blob",
      ownerPrincipalId: "legacy-operator",
    });
    const job = await repository.createIndexJob({
      workspaceId: workspace.id,
      revision: workspace.revision,
      mode: "rebuild",
    });
    const claimed = await repository.claimIndexJob(job.id, 60_000);
    assert.ok(claimed);
    claim = claimed;
    const options = {
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: token,
      disableEmbeddings: true,
      indexJobLeaseMs: 60_000,
      indexJobPollIntervalMs: 100,
    };
    [executor, observer] = await Promise.all([
      startHttpServer(options),
      startHttpServer(options),
    ]);
  });

  after(async () => {
    await observer.close();
    await executor.close();
    await repository.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("polls progress and terminal state on a non-executing instance", async () => {
    const stream = await fetch(
      `${observer.url}/v1/index-jobs/${claim.id}/events`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

    assert.ok(
      await repository.updateIndexJobProgress(claim.id, claim.attemptToken, {
        phase: "chunk",
        files_done: 1,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 175));
    assert.ok(
      await repository.completeIndexJob(claim.id, claim.attemptToken, {
        filesIndexed: 1,
      }),
    );

    const frames = parseJobFrames(await within(stream.text(), 2_000));
    assert.ok(frames.length >= 3);
    assert.equal(frames[0].status, "running");
    assert.ok(
      frames.some(
        (frame) => frame.status === "running" && frame.phase === "chunk",
      ),
    );
    assert.equal(frames[frames.length - 1].status, "succeeded");
    assert.equal(frames[frames.length - 1].attempts, 1);
  });
});

function parseJobFrames(body: string): Array<{
  status: string;
  phase: string | null;
  attempts: number;
}> {
  const frames: Array<{ status: string; phase: string | null; attempts: number }> = [];
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    if (!lines.includes("event: job")) continue;
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) continue;
    const parsed = JSON.parse(data) as {
      job: {
        status: string;
        attempts: number;
        progress: { phase?: string } | null;
      };
    };
    frames.push({
      status: parsed.job.status,
      phase: parsed.job.progress?.phase ?? null,
      attempts: parsed.job.attempts,
    });
  }
  return frames;
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
