import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import {
  SyncPlanConflictError,
  WorkspaceRepository,
} from "../src/server/workspace-repository.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres("principal ACL and GitHub connector", () => {
  const githubToken = "github-read-token-must-stay-secret";
  const githubContent = [
    "export function connectorPermission(user: string) {",
    "  return user === 'repository-reader';",
    "}",
    "",
  ].join("\n");
  const githubPrivateContent = [
    "export function privateBillingCredential() {",
    "  return 'source-acl-must-hide-this';",
    "}",
    "",
  ].join("\n");
  const schema = `ce_acl_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  let mockGitHub: Server;
  let mockGitHubUrl = "";
  let handle: HttpServerHandle;
  let failTree = false;
  const workspaceIds: string[] = [];
  const observedAuthorizations: Array<string | undefined> = [];

  const tokens = {
    admin: "acl-admin-token",
    alice: "acl-alice-token",
    bob: "acl-bob-token",
  } as const;

  before(async () => {
    await adminDatabase.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    mockGitHub = createServer((request, response) => {
      observedAuthorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/git/trees/")) {
        if (failTree) {
          response.statusCode = 503;
          response.end(JSON.stringify({ message: "temporary upstream failure" }));
          return;
        }
        response.end(
          JSON.stringify({
            sha: "tree-revision-1",
            truncated: false,
            tree: [
              {
                type: "blob",
                path: "src/connector-permission.ts",
                sha: "github-blob-1",
                size: Buffer.byteLength(githubContent),
              },
              {
                type: "blob",
                path: "private/billing-credential.ts",
                sha: "github-private-blob-1",
                size: Buffer.byteLength(githubPrivateContent),
              },
            ],
          }),
        );
        return;
      }
      if (request.url?.includes("/git/blobs/github-blob-1")) {
        response.end(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from(githubContent).toString("base64"),
            size: Buffer.byteLength(githubContent),
          }),
        );
        return;
      }
      if (request.url?.includes("/git/blobs/github-private-blob-1")) {
        response.end(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from(githubPrivateContent).toString("base64"),
            size: Buffer.byteLength(githubPrivateContent),
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    });
    mockGitHub.listen(0, "127.0.0.1");
    await once(mockGitHub, "listening");
    const address = mockGitHub.address();
    assert.ok(address && typeof address !== "string");
    mockGitHubUrl = `http://127.0.0.1:${address.port}`;

    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: databaseUrlForSchema(databaseUrl!, schema),
      apiKeys: [
        { principalId: "admin", token: tokens.admin, role: "operator" },
        { principalId: "alice", token: tokens.alice },
        { principalId: "bob", token: tokens.bob },
      ],
      disableEmbeddings: true,
      githubToken,
      githubApiBaseUrl: mockGitHubUrl,
    });
  });

  after(async () => {
    if (handle) {
      for (const workspaceId of workspaceIds) {
        await request("admin", `/v1/workspaces/${workspaceId}`, { method: "DELETE" });
      }
      await handle.close();
    }
    if (mockGitHub) {
      await new Promise<void>((resolve, reject) =>
        mockGitHub.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await adminDatabase.end();
  });

  function request(
    actor: keyof typeof tokens,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...init.headers,
      },
    });
  }

  async function createWorkspace(actor: "alice" | "bob", name: string): Promise<string> {
    const response = await request(actor, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201);
    const payload = (await response.json()) as { workspace: { id: string } };
    workspaceIds.push(payload.workspace.id);
    return payload.workspace.id;
  }

  async function waitForJob(actor: "alice" | "bob", jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 160; attempt++) {
      const response = await request(actor, `/v1/index-jobs/${jobId}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        job: { status: string; error?: string };
      };
      if (payload.job.status === "succeeded") return;
      if (payload.job.status === "failed") {
        assert.fail(`Connector index job failed: ${payload.job.error ?? "unknown"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("Timed out waiting for connector index job");
  }

  it("isolates workspaces and Blob possession across principals", async () => {
    const aliceWorkspace = await createWorkspace("alice", "Alice secure Blob workspace");
    const bobWorkspace = await createWorkspace("bob", "Bob secure Blob workspace");
    const secret = "export const aliceOnly = 'private-workspace-content';\n";
    const hash = digest(secret);

    const alicePlanResponse = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/sync/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base_revision: 0,
          changes: [{ op: "upsert", path: "secret.ts", blob_hash: hash }],
        }),
      },
    );
    assert.equal(alicePlanResponse.status, 201);
    const alicePlan = (await alicePlanResponse.json()) as {
      sync_id: string;
      missing_blobs: string[];
    };
    assert.deepEqual(alicePlan.missing_blobs, [hash]);

    const crossPrincipalUpload = await request(
      "bob",
      `/v1/blobs/${hash}?sync_id=${alicePlan.sync_id}`,
      { method: "PUT", body: secret },
    );
    assert.equal(crossPrincipalUpload.status, 404);
    const aliceUpload = await request(
      "alice",
      `/v1/blobs/${hash}?sync_id=${alicePlan.sync_id}`,
      { method: "PUT", body: secret },
    );
    assert.equal(aliceUpload.status, 201);
    const aliceCommit = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/sync/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sync_id: alicePlan.sync_id, auto_index: false }),
      },
    );
    assert.equal(aliceCommit.status, 200);

    const bobPlanResponse = await request("bob", `/v1/workspaces/${bobWorkspace}/sync/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_revision: 0,
        changes: [{ op: "upsert", path: "stolen.ts", blob_hash: hash }],
      }),
    });
    assert.equal(bobPlanResponse.status, 201);
    const bobPlan = (await bobPlanResponse.json()) as {
      sync_id: string;
      missing_blobs: string[];
    };
    assert.deepEqual(bobPlan.missing_blobs, [hash]);
    const stolenCommit = await request(
      "bob",
      `/v1/workspaces/${bobWorkspace}/sync/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sync_id: bobPlan.sync_id, auto_index: false }),
      },
    );
    assert.equal(stolenCommit.status, 409);

    const bobList = (await (await request("bob", "/v1/workspaces")).json()) as {
      workspaces: Array<{ id: string }>;
    };
    assert.equal(bobList.workspaces.some((item) => item.id === aliceWorkspace), false);
    assert.equal(
      (await request("bob", `/v1/workspaces/${aliceWorkspace}`)).status,
      404,
    );
  });

  it("syncs GitHub incrementally and applies grant/revoke to HTTP and MCP", async () => {
    const workspaceId = await createWorkspace("alice", "Alice GitHub workspace");
    const createdSource = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/github`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo-owner", repository: "context-repo", ref: "main" }),
      },
    );
    assert.equal(createdSource.status, 201);
    const sourcePayload = (await createdSource.json()) as { source: { id: string } };
    const sourceId = sourcePayload.source.id;
    assert.equal(
      (await request("bob", `/v1/workspaces/${workspaceId}/sources`)).status,
      404,
    );

    const synced = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`,
      { method: "POST" },
    );
    assert.equal(synced.status, 202);
    const syncPayload = (await synced.json()) as {
      noop: boolean;
      index_job: { id: string };
      changed_paths: string[];
    };
    assert.equal(syncPayload.noop, false);
    assert.deepEqual(syncPayload.changed_paths, [
      "private/billing-credential.ts",
      "src/connector-permission.ts",
    ]);
    await waitForJob("alice", syncPayload.index_job.id);

    const filePath = "src%2Fconnector-permission.ts";
    const aliceFile = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/file?path=${filePath}`,
    );
    assert.equal(aliceFile.status, 200);
    assert.match(await aliceFile.text(), /connectorPermission/);

    const repeated = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`,
      { method: "POST" },
    );
    assert.equal(repeated.status, 200);
    const repeatedPayload = (await repeated.json()) as {
      noop: boolean;
      index_job: null;
    };
    assert.equal(repeatedPayload.noop, true);
    assert.equal(repeatedPayload.index_job, null);

    const policyWithoutWorkspaceAccess = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/source-acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_access: "deny", rules: [] }),
      },
    );
    assert.equal(policyWithoutWorkspaceAccess.status, 409);

    const granted = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: "reader" }),
      },
    );
    assert.equal(granted.status, 200);
    const sourcePolicy = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/source-acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default_access: "deny",
          rules: [{ path_prefix: "src", effect: "allow" }],
        }),
      },
    );
    assert.equal(sourcePolicy.status, 200);
    assert.equal(
      (await request("bob", `/v1/workspaces/${workspaceId}/file?path=${filePath}`)).status,
      200,
    );
    assert.equal(
      (
        await request(
          "bob",
          `/v1/workspaces/${workspaceId}/file?path=private%2Fbilling-credential.ts`,
        )
      ).status,
      404,
    );
    const hiddenSearch = await request(
      "bob",
      `/v1/workspaces/${workspaceId}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "privateBillingCredential", mode: "bm25" }),
      },
    );
    assert.equal(hiddenSearch.status, 200);
    assert.doesNotMatch(await hiddenSearch.text(), /privateBillingCredential/);
    const hiddenContext = await request(
      "bob",
      `/v1/workspaces/${workspaceId}/context`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "privateBillingCredential" }),
      },
    );
    assert.equal(hiddenContext.status, 200);
    assert.doesNotMatch(await hiddenContext.text(), /source-acl-must-hide-this/);
    assert.equal(
      (
        await request(
          "bob",
          `/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`,
          { method: "POST" },
        )
      ).status,
      404,
    );
    assert.equal(
      (await request("bob", `/v1/workspaces/${workspaceId}/acl`)).status,
      404,
    );
    assert.equal((await request("bob", "/v1/observability/overview")).status, 403);

    const mcpHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "acl-test", version: "1.0.0" },
      },
    });
    const aliceMcp = await request("alice", `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: initializeBody,
    });
    assert.equal(aliceMcp.status, 200);
    const aliceSession = aliceMcp.headers.get("mcp-session-id");
    assert.ok(aliceSession);
    const bobMcp = await request("bob", `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: initializeBody,
    });
    assert.equal(bobMcp.status, 200);
    const bobSession = bobMcp.headers.get("mcp-session-id");
    assert.ok(bobSession);

    const hiddenMcp = await request("bob", `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": bobSession! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codebase-retrieval",
          arguments: { information_request: "privateBillingCredential", top_k: 10 },
        },
      }),
    });
    assert.equal(hiddenMcp.status, 200);
    assert.doesNotMatch(await hiddenMcp.text(), /source-acl-must-hide-this/);

    const replacedPolicy = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/source-acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default_access: "allow",
          rules: [{ path_prefix: "src", effect: "deny" }],
        }),
      },
    );
    assert.equal(replacedPolicy.status, 200);
    const revokedDuringSession = await request(
      "bob",
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": bobSession! },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "codebase-retrieval",
            arguments: { information_request: "connectorPermission", top_k: 10 },
          },
        }),
      },
    );
    assert.equal(revokedDuringSession.status, 200);
    assert.doesNotMatch(await revokedDuringSession.text(), /repository-reader/);

    const bobReusesAlice = await request("bob", `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": aliceSession! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(bobReusesAlice.status, 404);

    const revoked = await request("alice", `/v1/workspaces/${workspaceId}/acl/bob`, {
      method: "DELETE",
    });
    assert.equal(revoked.status, 200);
    const policiesAfterRevoke = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/source-acl`,
    );
    assert.equal(policiesAfterRevoke.status, 200);
    assert.doesNotMatch(await policiesAfterRevoke.text(), /"principal_id":"bob"/);
    assert.equal(
      (await request("bob", `/v1/workspaces/${workspaceId}/file?path=${filePath}`)).status,
      404,
    );
    const revokedMcp = await request("bob", `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": bobSession! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    assert.equal(revokedMcp.status, 404);

    failTree = true;
    const failedSync = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`,
      { method: "POST" },
    );
    assert.equal(failedSync.status, 502);
    const failedText = await failedSync.text();
    assert.equal(failedText.includes(githubToken), false);
    const sourceStatus = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/${sourceId}`,
    );
    assert.equal(sourceStatus.status, 200);
    assert.equal((await sourceStatus.text()).includes(githubToken), false);
    assert.ok(observedAuthorizations.every((value) => value === `Bearer ${githubToken}`));
  });

  it("enforces connector ownership of sync plans inside the workspace transaction", async () => {
    const workspaceId = await createWorkspace("alice", "Connector transaction guard");
    const createdSource = await request(
      "alice",
      `/v1/workspaces/${workspaceId}/sources/github`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo-owner", repository: "guarded-repo", ref: "main" }),
      },
    );
    assert.equal(createdSource.status, 201);
    const { source } = (await createdSource.json()) as {
      source: { id: string };
    };
    const repository = await WorkspaceRepository.open(
      databaseUrlForSchema(databaseUrl!, schema),
    );

    try {
      await assert.rejects(
        repository.createSyncPlan(workspaceId, 0, []),
        SyncPlanConflictError,
      );
      await assert.rejects(
        repository.createSyncPlan(
          workspaceId,
          0,
          [],
          15 * 60 * 1000,
          false,
          {
            sourceId: source.id,
            expectedCursorVersion: 0,
            syncAttemptId: randomUUID(),
          },
        ),
        SyncPlanConflictError,
      );
      await assert.rejects(
        repository.createSyncPlan(
          workspaceId,
          0,
          [],
          15 * 60 * 1000,
          false,
          {
            sourceId: randomUUID(),
            expectedCursorVersion: 0,
            syncAttemptId: randomUUID(),
          },
        ),
        SyncPlanConflictError,
      );

      const started = await repository.beginConnectorSync(workspaceId, source.id, 0);
      assert.ok(started);
      assert.equal(started.status, "syncing");
      const plan = await repository.createSyncPlan(
        workspaceId,
        0,
        [],
        15 * 60 * 1000,
        false,
        {
          sourceId: started.id,
          expectedCursorVersion: started.cursorVersion,
          syncAttemptId: started.syncAttemptId,
        },
      );
      assert.equal(plan.workspaceId, workspaceId);
      await assert.rejects(
        repository.commitSync(workspaceId, plan.id),
        SyncPlanConflictError,
      );
    } finally {
      await repository.close();
    }
  });
});
