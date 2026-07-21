import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describePostgres("ContextEngine HTTP service", () => {
  let handle: HttpServerHandle;
  let workspaceId = "";
  let localWorkspaceId = "";
  let localSandbox = "";
  let allowedLocalRoot = "";
  let outsideLocalRoot = "";
  const apiKey = "http-test-key";

  before(async () => {
    localSandbox = mkdtempSync(path.join(tmpdir(), "ce-http-local-root-"));
    allowedLocalRoot = path.join(localSandbox, "allowed");
    outsideLocalRoot = path.join(localSandbox, "outside");
    mkdirSync(allowedLocalRoot, { recursive: true });
    mkdirSync(outsideLocalRoot, { recursive: true });
    writeFileSync(path.join(allowedLocalRoot, "safe.ts"), "export const safe = true;\n");
    writeFileSync(path.join(outsideLocalRoot, "secret.ts"), "export const secret = true;\n");
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      apiKey,
      databaseUrl,
      disableEmbeddings: true,
      allowLocalWorkspaces: true,
      localRootAllowlist: [allowedLocalRoot],
      mcpSessionIdleTtlMs: 1_000,
      mcpMaxSessions: 1,
      mcpSessionStore: "memory",
      corsOrigins: ["https://client.example"],
    });
  });

  after(async () => {
    if (localWorkspaceId) {
      await fetch(`${handle.url}/v1/workspaces/${localWorkspaceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      });
    }
    if (workspaceId) {
      await fetch(`${handle.url}/v1/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      });
    }
    await handle.close();
    rmSync(localSandbox, { recursive: true, force: true });
  });

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
    });
  }

  async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request(`/v1/index-jobs/${jobId}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        job: Record<string, unknown>;
      };
      const status = payload.job.status;
      if (status === "succeeded") return payload.job;
      if (status === "failed") {
        assert.fail(`Index job failed: ${String(payload.job.error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("Timed out waiting for index job");
  }

  it("returns a conflict response for an expired sync plan", async () => {
    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Expired sync plan" }),
    });
    assert.equal(created.status, 201);
    const createdPayload = (await created.json()) as {
      workspace: { id: string };
    };
    const expiredWorkspaceId = createdPayload.workspace.id;

    try {
      const planned = await request(
        `/v1/workspaces/${expiredWorkspaceId}/sync/plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            base_revision: 0,
            changes: [{ op: "delete", path: "src/expired.ts" }],
          }),
        },
      );
      assert.equal(planned.status, 201);
      const plan = (await planned.json()) as { sync_id: string };
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await pool.query(
          `UPDATE ce_sync_sessions
           SET expires_at = clock_timestamp() - interval '1 second'
           WHERE id = $1`,
          [plan.sync_id],
        );
      } finally {
        await pool.end();
      }

      const committed = await request(
        `/v1/workspaces/${expiredWorkspaceId}/sync/commit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sync_id: plan.sync_id }),
        },
      );
      assert.equal(committed.status, 409);
      assert.deepEqual(await committed.json(), {
        error: {
          code: "sync_plan_expired",
          message: "Sync session has expired",
        },
      });
    } finally {
      const deleted = await request(`/v1/workspaces/${expiredWorkspaceId}`, {
        method: "DELETE",
      });
      assert.equal(deleted.status, 200);
    }
  });

  it("syncs content-addressed files, indexes asynchronously, and retrieves context", async () => {
    const root = await fetch(`${handle.url}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/dashboard");
    const dashboard = await fetch(`${handle.url}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await dashboard.text(), /ContextEngine/);

    const health = await fetch(`${handle.url}/health`);
    assert.equal(health.status, 200);
    const preflight = await fetch(`${handle.url}/v1/capabilities`, {
      method: "OPTIONS",
      headers: { origin: "https://client.example" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://client.example",
    );
    const corsHealth = await fetch(`${handle.url}/health`, {
      headers: { origin: "https://client.example" },
    });
    assert.equal(corsHealth.status, 200);
    assert.equal(
      corsHealth.headers.get("access-control-allow-origin"),
      "https://client.example",
    );
    const deniedOrigin = await fetch(`${handle.url}/health`, {
      headers: { origin: "https://denied.example" },
    });
    assert.equal(deniedOrigin.status, 403);
    const unauthorized = await fetch(`${handle.url}/v1/workspaces`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedOverview = await fetch(
      `${handle.url}/v1/observability/overview`,
    );
    assert.equal(unauthorizedOverview.status, 401);

    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP test workspace" }),
    });
    assert.equal(created.status, 201);
    const workspacePayload = (await created.json()) as {
      workspace: { id: string; revision: number };
    };
    workspaceId = workspacePayload.workspace.id;
    assert.equal(workspacePayload.workspace.revision, 0);

    const authContent = [
      "export function requirePermission(user: User, permission: string) {",
      "  if (!user.permissions.includes(permission)) throw new Error('forbidden');",
      "  return true;",
      "}",
      "",
    ].join("\n");
    const billingContent = [
      "export function createInvoice(customerId: string) {",
      "  return { customerId, status: 'draft' };",
      "}",
      "",
    ].join("\n");
    const authHash = digest(authContent);
    const billingHash = digest(billingContent);

    const planned = await request(`/v1/workspaces/${workspaceId}/sync/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        changes: [
          {
            op: "upsert",
            path: "src/auth.ts",
            blob_hash: authHash,
            size: Buffer.byteLength(authContent),
          },
          {
            op: "upsert",
            path: "src/billing.ts",
            blob_hash: billingHash,
            size: Buffer.byteLength(billingContent),
          },
        ],
      }),
    });
    assert.equal(planned.status, 201);
    const plan = (await planned.json()) as {
      sync_id: string;
      missing_blobs: string[];
    };
    assert.deepEqual(new Set(plan.missing_blobs), new Set([authHash, billingHash]));

    for (const [hash, content] of [
      [authHash, authContent],
      [billingHash, billingContent],
    ]) {
      const uploaded = await request(`/v1/blobs/${hash}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: content,
      });
      assert.equal(uploaded.status, 201);
    }

    const committed = await request(`/v1/workspaces/${workspaceId}/sync/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sync_id: plan.sync_id, auto_index: true }),
    });
    assert.equal(committed.status, 200);
    const commit = (await committed.json()) as {
      revision: number;
      index_job: { id: string };
    };
    assert.equal(commit.revision, 1);
    const job = await waitForJob(commit.index_job.id);
    assert.equal(job.status, "succeeded");

    const search = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "where is user permission enforced", top_k: 5 }),
    });
    assert.equal(search.status, 200);
    const searchPayload = (await search.json()) as {
      index: {
        generation_id: string;
        indexed_revision: string;
        pending_revision: string | null;
      };
      results: Array<{ path: string }>;
    };
    assert.ok(searchPayload.index.generation_id);
    assert.equal(searchPayload.index.indexed_revision, "1");
    assert.equal(searchPayload.index.pending_revision, null);
    assert.ok(searchPayload.results.some((result) => result.path === "src/auth.ts"));

    const context = await request(`/v1/workspaces/${workspaceId}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        information_request: "Find requirePermission authorization checks before access is granted",
      }),
    });
    assert.equal(context.status, 200);
    const contextPayload = (await context.json()) as {
      index: { generation_id: string; indexed_revision: string };
      packed_text: string;
    };
    assert.equal(
      contextPayload.index.generation_id,
      searchPayload.index.generation_id,
    );
    assert.equal(contextPayload.index.indexed_revision, "1");
    assert.match(contextPayload.packed_text, /requirePermission/);

    const mcpHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initialized = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "contextengine-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const initializePayload = (await initialized.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    assert.equal(initializePayload.result?.serverInfo?.name, "contextengine");

    const overCapacity = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "contextengine-over-capacity", version: "1.0.0" },
        },
      }),
    });
    assert.equal(overCapacity.status, 429);
    assert.equal(overCapacity.headers.get("retry-after"), "1");

    const listed = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(listed.status, 200);
    const listedPayload = (await listed.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    assert.deepEqual(
      listedPayload.result?.tools?.map((tool) => tool.name),
      ["codebase-retrieval"],
    );

    const called = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codebase-retrieval",
          arguments: {
            information_request: "Where is requirePermission enforced?",
            top_k: 4,
          },
        },
      }),
    });
    assert.equal(called.status, 200);
    const calledPayload = (await called.json()) as {
      result?: { content?: Array<{ type: string; text?: string }> };
    };
    assert.match(calledPayload.result?.content?.[0]?.text ?? "", /requirePermission/);

    const closed = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    assert.equal(closed.status, 200);

    const closedSession = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(closedSession.status, 404);

    const expiring = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "contextengine-expiry-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(expiring.status, 200);
    const expiringSessionId = expiring.headers.get("mcp-session-id");
    assert.ok(expiringSessionId);
    await expiring.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const expiredSession = await request(`/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": expiringSessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(expiredSession.status, 404);

    const overview = await request(
      "/v1/observability/overview?request_limit=20&job_limit=10",
    );
    assert.equal(overview.status, 200);
    const overviewPayload = (await overview.json()) as {
      service: { status: string; storage: string };
      requests: { total: number; recent: Array<{ route: string }> };
      workspaces: Array<{
        workspace: { id: string };
        indexed: boolean;
        stats: {
          fileCount: number;
          chunkCount: number;
          generationId: string;
          indexedRevision: string;
        } | null;
      }>;
      jobs: Array<{ id: string; status: string }>;
    };
    assert.equal(overviewPayload.service.status, "online");
    assert.equal(overviewPayload.service.storage, "postgresql+pgvector");
    assert.ok(overviewPayload.requests.total > 0);
    assert.ok(
      overviewPayload.requests.recent.some(
        (item) => item.route === "/v1/workspaces/{workspaceId}/context",
      ),
    );
    const observedWorkspace = overviewPayload.workspaces.find(
      (item) => item.workspace.id === workspaceId,
    );
    assert.equal(observedWorkspace?.indexed, true);
    assert.ok((observedWorkspace?.stats?.fileCount ?? 0) >= 2);
    assert.ok((observedWorkspace?.stats?.chunkCount ?? 0) >= 2);
    assert.equal(
      observedWorkspace?.stats?.generationId,
      searchPayload.index.generation_id,
    );
    assert.equal(observedWorkspace?.stats?.indexedRevision, "1");
    assert.ok(
      overviewPayload.jobs.some(
        (item) =>
          item.id === commit.index_job.id && item.status === "succeeded",
      ),
    );

    const file = await request(
      `/v1/workspaces/${workspaceId}/file?path=src%2Fauth.ts&start_line=1&end_line=2`,
    );
    assert.equal(file.status, 200);
    const filePayload = (await file.json()) as {
      path: string;
      start_line: number;
      end_line: number;
      content: string;
    };
    assert.equal(filePayload.path, "src/auth.ts");
    assert.equal(filePayload.start_line, 1);
    assert.equal(filePayload.end_line, 2);
    assert.match(filePayload.content, /requirePermission/);

    const stalePlan = await request(`/v1/workspaces/${workspaceId}/sync/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        changes: [{ op: "delete", path: "src/billing.ts" }],
      }),
    });
    assert.equal(stalePlan.status, 409);

    // Replacing text with binary content must remove the old searchable
    // chunks, while the source-file endpoint continues to reject the Blob.
    const binaryContent = Buffer.from([
      0x00, 0x00, 0x00, 0x72, 0x65, 0x71, 0x75, 0x69, 0x72, 0x65,
    ]);
    const binaryHash = digest(binaryContent);
    const binaryPlanResponse = await request(
      `/v1/workspaces/${workspaceId}/sync/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base_revision: 1,
          changes: [
            {
              op: "upsert",
              path: "src/auth.ts",
              blob_hash: binaryHash,
              size: binaryContent.length,
            },
          ],
        }),
      },
    );
    assert.equal(binaryPlanResponse.status, 201);
    const binaryPlan = (await binaryPlanResponse.json()) as {
      sync_id: string;
      missing_blobs: string[];
    };
    assert.deepEqual(binaryPlan.missing_blobs, [binaryHash]);

    const binaryUpload = await request(`/v1/blobs/${binaryHash}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(binaryContent),
    });
    assert.equal(binaryUpload.status, 201);

    const binaryCommitResponse = await request(
      `/v1/workspaces/${workspaceId}/sync/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sync_id: binaryPlan.sync_id,
          auto_index: true,
        }),
      },
    );
    assert.equal(binaryCommitResponse.status, 200);
    const binaryCommit = (await binaryCommitResponse.json()) as {
      revision: number;
      index_job: { id: string };
    };
    assert.equal(binaryCommit.revision, 2);
    await waitForJob(binaryCommit.index_job.id);

    const staleSearch = await request(
      `/v1/workspaces/${workspaceId}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "requirePermission", top_k: 5 }),
      },
    );
    assert.equal(staleSearch.status, 200);
    const staleSearchPayload = (await staleSearch.json()) as {
      index: { generation_id: string; indexed_revision: string };
      results: Array<{ path: string }>;
    };
    assert.notEqual(
      staleSearchPayload.index.generation_id,
      searchPayload.index.generation_id,
    );
    assert.equal(staleSearchPayload.index.indexed_revision, "2");
    assert.equal(
      staleSearchPayload.results.some((result) => result.path === "src/auth.ts"),
      false,
    );

    const binaryFile = await request(
      `/v1/workspaces/${workspaceId}/file?path=src%2Fauth.ts`,
    );
    assert.equal(binaryFile.status, 404);
  });

  it("rechecks a cached local workspace root against the allowlist", async () => {
    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Local root boundary test",
        source_mode: "local",
        local_root: allowedLocalRoot,
      }),
    });
    assert.equal(created.status, 201);
    const payload = (await created.json()) as { workspace: { id: string } };
    localWorkspaceId = payload.workspace.id;

    const initialStatus = await request(
      `/v1/workspaces/${localWorkspaceId}/status`,
    );
    assert.equal(initialStatus.status, 200);

    renameSync(allowedLocalRoot, `${allowedLocalRoot}-original`);
    symlinkSync(outsideLocalRoot, allowedLocalRoot);

    const replacedStatus = await request(
      `/v1/workspaces/${localWorkspaceId}/status`,
    );
    assert.equal(replacedStatus.status, 403);
    const error = (await replacedStatus.json()) as {
      error: { message: string };
    };
    assert.match(error.error.message, /outside CONTEXTENGINE_LOCAL_ROOT_ALLOWLIST/);

    const overview = await request("/v1/observability/overview");
    assert.equal(overview.status, 200);
    const overviewPayload = (await overview.json()) as {
      workspaces: Array<{ workspace: { id: string }; error: string | null }>;
    };
    const observed = overviewPayload.workspaces.find(
      (item) => item.workspace.id === localWorkspaceId,
    );
    assert.equal(observed?.error, "Workspace root unavailable");
  });
});
