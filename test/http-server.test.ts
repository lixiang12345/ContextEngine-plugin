import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describePostgres("ContextEngine HTTP service", () => {
  let handle: HttpServerHandle;
  let workspaceId = "";
  const apiKey = "http-test-key";

  before(async () => {
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      apiKey,
      databaseUrl,
      disableEmbeddings: true,
    });
  });

  after(async () => {
    if (workspaceId) {
      await fetch(`${handle.url}/v1/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      });
    }
    await handle.close();
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
      results: Array<{ path: string }>;
    };
    assert.ok(searchPayload.results.some((result) => result.path === "src/auth.ts"));

    const context = await request(`/v1/workspaces/${workspaceId}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        information_request: "Find requirePermission authorization checks before access is granted",
      }),
    });
    assert.equal(context.status, 200);
    const contextPayload = (await context.json()) as { packed_text: string };
    assert.match(contextPayload.packed_text, /requirePermission/);

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
        stats: { fileCount: number; chunkCount: number } | null;
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
  });
});
