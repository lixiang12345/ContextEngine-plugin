import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

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

const mcpHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describePostgres("durable Remote MCP sessions", () => {
  const schema = `ce_mcp_durable_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const aliceToken = "durable-mcp-alice";
  const bobToken = "durable-mcp-bob";
  const operatorToken = "durable-mcp-operator";
  let first: HttpServerHandle;
  let second: HttpServerHandle;
  let firstClosed = false;
  let workspaceId = "";
  let otherWorkspaceId = "";

  const request = (
    handle: HttpServerHandle,
    token: string,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> => fetch(`${handle.url}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  const mcpRequest = (
    handle: HttpServerHandle,
    token: string,
    targetWorkspaceId: string,
    sessionId: string | null,
    body: unknown,
  ): Promise<Response> => request(
    handle,
    token,
    `/v1/workspaces/${targetWorkspaceId}/mcp`,
    {
      method: "POST",
      headers: {
        ...mcpHeaders,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    },
  );

  const initialize = async (
    handle: HttpServerHandle,
    id: number,
  ): Promise<Response> => mcpRequest(handle, aliceToken, workspaceId, null, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "durable-session-test", version: "1.0.0" },
    },
  });

  const closeSession = (
    handle: HttpServerHandle,
    sessionId: string,
  ): Promise<Response> => request(
    handle,
    aliceToken,
    `/v1/workspaces/${workspaceId}/mcp`,
    { method: "DELETE", headers: { "mcp-session-id": sessionId } },
  );

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const options = {
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKeys: [
        { principalId: "alice", token: aliceToken, role: "user" as const },
        { principalId: "bob", token: bobToken, role: "user" as const },
        { principalId: "operator", token: operatorToken, role: "operator" as const },
      ],
      disableEmbeddings: true,
      mcpSessionStore: "postgres" as const,
      mcpSessionIdleTtlMs: 1_000,
      mcpMaxSessions: 1,
    };
    [first, second] = await Promise.all([
      startHttpServer(options),
      startHttpServer(options),
    ]);

    const created = await request(first, aliceToken, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Durable MCP workspace" }),
    });
    assert.equal(created.status, 201);
    workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    const other = await request(first, aliceToken, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other MCP workspace" }),
    });
    assert.equal(other.status, 201);
    otherWorkspaceId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    const content = [
      "export function durableAuthorizationBoundary(user: string) {",
      "  return user === 'authorized-principal';",
      "}",
      "",
    ].join("\n");
    const hash = createHash("sha256").update(content).digest("hex");
    const planned = await request(
      first,
      aliceToken,
      `/v1/workspaces/${workspaceId}/sync/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base_revision: 0,
          changes: [{
            op: "upsert",
            path: "src/durable-auth.ts",
            blob_hash: hash,
            size: Buffer.byteLength(content),
          }],
        }),
      },
    );
    assert.equal(planned.status, 201);
    const syncId = ((await planned.json()) as { sync_id: string }).sync_id;
    const uploaded = await request(
      first,
      aliceToken,
      `/v1/blobs/${hash}?sync_id=${encodeURIComponent(syncId)}`,
      {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: content,
      },
    );
    assert.equal(uploaded.status, 201);
    const committed = await request(
      first,
      aliceToken,
      `/v1/workspaces/${workspaceId}/sync/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sync_id: syncId, auto_index: true }),
      },
    );
    assert.equal(committed.status, 200);
    const jobId = ((await committed.json()) as { index_job: { id: string } }).index_job.id;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const jobResponse = await request(first, aliceToken, `/v1/index-jobs/${jobId}`);
      assert.equal(jobResponse.status, 200);
      const job = ((await jobResponse.json()) as {
        job: { status: string; error?: string };
      }).job;
      if (job.status === "succeeded") break;
      if (job.status === "failed") assert.fail(job.error ?? "Index job failed");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  after(async () => {
    if (!firstClosed) await first.close();
    await second.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("serves, authorizes, limits, restarts and closes sessions across instances", async () => {
    const initialized = await initialize(first, 1);
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const initializedNotification = await mcpRequest(
      second,
      aliceToken,
      workspaceId,
      sessionId,
      { jsonrpc: "2.0", method: "notifications/initialized" },
    );
    assert.equal(initializedNotification.status, 202);

    for (let index = 0; index < 100; index += 1) {
      const listed = await mcpRequest(
        index % 2 === 0 ? first : second,
        aliceToken,
        workspaceId,
        sessionId,
        { jsonrpc: "2.0", id: 10 + index, method: "tools/list", params: {} },
      );
      assert.equal(listed.status, 200, `round-robin request ${index + 1}`);
    }

    const retrieved = await mcpRequest(second, aliceToken, workspaceId, sessionId, {
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "codebase-retrieval",
        arguments: { information_request: "Find the durable authorization boundary" },
      },
    });
    assert.equal(retrieved.status, 200);
    const retrievalPayload = await retrieved.json() as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.match(
      retrievalPayload.result?.content?.[0]?.text ?? "",
      /durableAuthorizationBoundary/,
    );

    const bobReuse = await mcpRequest(second, bobToken, workspaceId, sessionId, {
      jsonrpc: "2.0", id: 201, method: "tools/list", params: {},
    });
    assert.equal(bobReuse.status, 404);
    const otherWorkspaceReuse = await mcpRequest(
      second,
      aliceToken,
      otherWorkspaceId,
      sessionId,
      { jsonrpc: "2.0", id: 202, method: "tools/list", params: {} },
    );
    assert.equal(otherWorkspaceReuse.status, 404);

    assert.equal((await closeSession(second, sessionId)).status, 200);
    assert.equal((await closeSession(first, sessionId)).status, 200);
    const afterClose = await mcpRequest(first, aliceToken, workspaceId, sessionId, {
      jsonrpc: "2.0", id: 203, method: "tools/list", params: {},
    });
    assert.equal(afterClose.status, 404);

    const concurrent = await Promise.all([initialize(first, 300), initialize(second, 301)]);
    assert.deepEqual(
      concurrent.map((response) => response.status).sort((a, b) => a - b),
      [200, 429],
    );
    const winner = concurrent.find((response) => response.status === 200)!;
    const capacitySessionId = winner.headers.get("mcp-session-id");
    assert.ok(capacitySessionId);
    assert.equal((await closeSession(second, capacitySessionId)).status, 200);

    const beforeRestart = await initialize(first, 400);
    assert.equal(beforeRestart.status, 200);
    const restartSessionId = beforeRestart.headers.get("mcp-session-id");
    assert.ok(restartSessionId);
    await first.close();
    firstClosed = true;

    const resumed = await mcpRequest(second, aliceToken, workspaceId, restartSessionId, {
      jsonrpc: "2.0", id: 401, method: "tools/list", params: {},
    });
    assert.equal(resumed.status, 200);
    assert.equal((await closeSession(second, restartSessionId)).status, 200);

    const expiring = await initialize(second, 500);
    assert.equal(expiring.status, 200);
    const expiringSessionId = expiring.headers.get("mcp-session-id");
    assert.ok(expiringSessionId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expired = await mcpRequest(second, aliceToken, workspaceId, expiringSessionId, {
      jsonrpc: "2.0", id: 501, method: "tools/list", params: {},
    });
    assert.equal(expired.status, 404);

    const overview = await request(
      second,
      operatorToken,
      "/v1/observability/overview",
    );
    assert.equal(overview.status, 200);
    const metrics = (await overview.json()) as {
      mcp_sessions: {
        store: string;
        principal_mismatch: number;
        expired_rejection: number;
      };
    };
    assert.equal(metrics.mcp_sessions.store, "postgres");
    assert.equal(metrics.mcp_sessions.principal_mismatch, 1);
    assert.equal(metrics.mcp_sessions.expired_rejection, 1);
  });
});
