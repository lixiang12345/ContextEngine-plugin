import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

describePostgres("local workspace source ACL boundaries", () => {
  const schema = `ce_local_acl_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  const tokens = {
    admin: "local-acl-admin-token",
    owner: "local-acl-owner-token",
    reader: "local-acl-reader-token",
    atomicReader: "local-acl-atomic-reader-token",
  } as const;
  const ruleSecret = "RULE_SECRET_MUST_NOT_CROSS_SOURCE_ACL";
  const commitSecret = "COMMIT_LINEAGE_SECRET_MUST_NOT_CROSS_SOURCE_ACL";
  let sandbox = "";
  let localRoot = "";
  let handle: HttpServerHandle;
  let workspaceId = "";

  before(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), "ce-http-local-acl-"));
    localRoot = path.join(sandbox, "repo");
    mkdirSync(path.join(localRoot, "src"), { recursive: true });
    mkdirSync(path.join(localRoot, "private"), { recursive: true });
    writeFileSync(
      path.join(localRoot, "AGENTS.md"),
      `# Private conventions\n\n${ruleSecret}\n`,
    );
    writeFileSync(
      path.join(localRoot, "src", "public.ts"),
      "export const publicValue = 'reader-visible';\n",
    );
    writeFileSync(
      path.join(localRoot, "private", "secret.ts"),
      "export const privateValue = 'private-source-marker';\n",
    );
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: localRoot });
    execFileSync("git", ["config", "user.email", "acl-test@example.com"], {
      cwd: localRoot,
    });
    execFileSync("git", ["config", "user.name", "ACL Test"], {
      cwd: localRoot,
    });
    execFileSync("git", ["add", "."], { cwd: localRoot });
    execFileSync("git", ["commit", "-m", commitSecret], { cwd: localRoot });

    await adminDatabase.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: databaseUrlForSchema(databaseUrl!, schema),
      apiKeys: [
        { principalId: "admin", token: tokens.admin, role: "operator" },
        { principalId: "owner", token: tokens.owner },
        { principalId: "reader", token: tokens.reader },
        { principalId: "atomic-reader", token: tokens.atomicReader },
      ],
      disableEmbeddings: true,
      allowLocalWorkspaces: true,
      localRootAllowlist: [localRoot],
    });

    const created = await request("owner", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Local source ACL fixture",
        source_mode: "local",
        local_root: localRoot,
      }),
    });
    assert.equal(created.status, 201);
    workspaceId = ((await created.json()) as { workspace: { id: string } })
      .workspace.id;

    const queued = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/index-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "rebuild" }),
      },
    );
    assert.equal(queued.status, 202);
    const jobId = ((await queued.json()) as { job: { id: string } }).job.id;
    await waitForJob(jobId);
  });

  after(async () => {
    if (handle) {
      if (workspaceId) {
        await request("admin", `/v1/workspaces/${workspaceId}`, {
          method: "DELETE",
        });
      }
      await handle.close();
    }
    await adminDatabase.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
    );
    await adminDatabase.end();
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  function request(
    actor: keyof typeof tokens,
    requestPath: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${requestPath}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...init.headers,
      },
    });
  }

  async function waitForJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 160; attempt++) {
      const response = await request("owner", `/v1/index-jobs/${jobId}`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        job: { status: string; error?: string };
      };
      if (payload.job.status === "succeeded") return;
      if (payload.job.status === "failed") {
        assert.fail(`Local index job failed: ${payload.job.error ?? "unknown"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("Timed out waiting for local index job");
  }

  it("filters rules and commit lineage over HTTP and an existing MCP session", async () => {
    const ownerContext = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/context`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "workspace conventions", top_k: 10 }),
      },
    );
    assert.equal(ownerContext.status, 200);
    assert.match(await ownerContext.text(), new RegExp(ruleSecret));

    const ownerHistory = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "show recent commit history",
          mode: "bm25",
          top_k: 20,
          include_commits: true,
        }),
      },
    );
    assert.equal(ownerHistory.status, 200);
    assert.match(await ownerHistory.text(), new RegExp(commitSecret));

    const granted = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/acl/reader`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: "reader" }),
      },
    );
    assert.equal(granted.status, 200);

    const mcpHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initialized = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "local-acl-test", version: "1.0.0" },
          },
        }),
      },
    );
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const beforePolicy = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "codebase-retrieval",
            arguments: { information_request: "workspace conventions" },
          },
        }),
      },
    );
    assert.equal(beforePolicy.status, 200);
    assert.match(await beforePolicy.text(), new RegExp(ruleSecret));

    const policy = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/source-acl/reader`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default_access: "allow",
          rules: [
            { path_prefix: "AGENTS.md", effect: "deny" },
            { path_prefix: "private", effect: "deny" },
          ],
        }),
      },
    );
    assert.equal(policy.status, 200);

    const readerContext = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/context`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "workspace conventions", top_k: 10 }),
      },
    );
    assert.equal(readerContext.status, 200);
    const readerContextText = await readerContext.text();
    assert.doesNotMatch(readerContextText, new RegExp(ruleSecret));
    assert.doesNotMatch(readerContextText, /"path":"AGENTS\.md"/);

    const readerHistory = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "show recent commit history",
          mode: "bm25",
          top_k: 20,
          include_commits: true,
        }),
      },
    );
    assert.equal(readerHistory.status, 200);
    assert.doesNotMatch(await readerHistory.text(), new RegExp(commitSecret));

    const rulesAfterPolicy = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "codebase-retrieval",
            arguments: { information_request: "workspace conventions" },
          },
        }),
      },
    );
    assert.equal(rulesAfterPolicy.status, 200);
    assert.doesNotMatch(await rulesAfterPolicy.text(), new RegExp(ruleSecret));

    const historyAfterPolicy = await request(
      "reader",
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": sessionId! },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "codebase-retrieval",
            arguments: { information_request: "show recent commit history" },
          },
        }),
      },
    );
    assert.equal(historyAfterPolicy.status, 200);
    assert.doesNotMatch(
      await historyAfterPolicy.text(),
      new RegExp(commitSecret),
    );
  });

  it("atomically grants workspace permission with its source policy", async () => {
    const quotedSchema = quoteIdentifier(schema);
    await adminDatabase.query(`
      CREATE OR REPLACE FUNCTION ${quotedSchema}.ce_test_delay_source_policy()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.35);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ce_test_delay_source_policy
      BEFORE INSERT ON ${quotedSchema}.ce_source_access_policies
      FOR EACH ROW EXECUTE FUNCTION ${quotedSchema}.ce_test_delay_source_policy()
    `);

    let settled = false;
    let observedPartialGrant = false;
    let observations = 0;
    const grantStartedAt = Date.now();
    const pendingGrant = request(
      "owner",
      `/v1/workspaces/${workspaceId}/acl/atomic-reader`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permission: "reader",
          source_acl: {
            default_access: "deny",
            rules: [{ path_prefix: "src", effect: "allow" }],
          },
        }),
      },
    ).finally(() => {
      settled = true;
    });

    while (!settled) {
      const visibility = await adminDatabase.query<{
        permission_visible: boolean;
        policy_ready: boolean;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM ${quotedSchema}.ce_workspace_acl
             WHERE workspace_id = $1 AND principal_id = $2
           ) AS permission_visible,
           EXISTS (
             SELECT 1
             FROM ${quotedSchema}.ce_source_access_policies AS policy
             JOIN ${quotedSchema}.ce_source_access_rules AS rule
               ON rule.workspace_id = policy.workspace_id
              AND rule.principal_id = policy.principal_id
             WHERE policy.workspace_id = $1
               AND policy.principal_id = $2
               AND policy.default_access = 'deny'
               AND rule.path_prefix = 'src'
               AND rule.effect = 'allow'
           ) AS policy_ready`,
        [workspaceId, "atomic-reader"],
      );
      const row = visibility.rows[0];
      if (row?.permission_visible && !row.policy_ready) {
        observedPartialGrant = true;
      }
      observations++;
      if (!settled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const granted = await pendingGrant;
    assert.equal(granted.status, 200);
    const grantPayload = (await granted.json()) as {
      principal_id: string;
      permission: string;
      source_acl: { default_access: string; rules: unknown[] };
    };
    assert.equal(grantPayload.principal_id, "atomic-reader");
    assert.equal(grantPayload.permission, "reader");
    assert.equal(grantPayload.source_acl.default_access, "deny");
    assert.equal(grantPayload.source_acl.rules.length, 1);
    assert.equal(observedPartialGrant, false);
    assert.ok(observations > 1);
    assert.ok(Date.now() - grantStartedAt >= 300);

    const finalVisibility = await adminDatabase.query<{
      permission_visible: boolean;
      policy_ready: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM ${quotedSchema}.ce_workspace_acl
           WHERE workspace_id = $1 AND principal_id = $2
         ) AS permission_visible,
         EXISTS (
           SELECT 1
           FROM ${quotedSchema}.ce_source_access_policies AS policy
           JOIN ${quotedSchema}.ce_source_access_rules AS rule
             ON rule.workspace_id = policy.workspace_id
            AND rule.principal_id = policy.principal_id
           WHERE policy.workspace_id = $1
             AND policy.principal_id = $2
             AND policy.default_access = 'deny'
             AND rule.path_prefix = 'src'
             AND rule.effect = 'allow'
         ) AS policy_ready`,
      [workspaceId, "atomic-reader"],
    );
    assert.deepEqual(finalVisibility.rows[0], {
      permission_visible: true,
      policy_ready: true,
    });

    assert.equal(
      (
        await request(
          "atomicReader",
          `/v1/workspaces/${workspaceId}/file?path=src%2Fpublic.ts`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "atomicReader",
          `/v1/workspaces/${workspaceId}/file?path=private%2Fsecret.ts`,
        )
      ).status,
      404,
    );
    const context = await request(
      "atomicReader",
      `/v1/workspaces/${workspaceId}/context`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "workspace conventions", top_k: 10 }),
      },
    );
    assert.equal(context.status, 200);
    assert.doesNotMatch(await context.text(), new RegExp(ruleSecret));

    await adminDatabase.query(`
      DROP TRIGGER ce_test_delay_source_policy
        ON ${quotedSchema}.ce_source_access_policies;
      DROP FUNCTION ${quotedSchema}.ce_test_delay_source_policy();
      CREATE OR REPLACE FUNCTION ${quotedSchema}.ce_test_reject_source_policy()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.principal_id = 'rollback-reader' THEN
          RAISE EXCEPTION 'forced atomic policy failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ce_test_reject_source_policy
      BEFORE INSERT ON ${quotedSchema}.ce_source_access_policies
      FOR EACH ROW EXECUTE FUNCTION ${quotedSchema}.ce_test_reject_source_policy()
    `);

    const failedGrant = await request(
      "owner",
      `/v1/workspaces/${workspaceId}/acl/rollback-reader`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permission: "reader",
          source_acl: { default_access: "deny", rules: [] },
        }),
      },
    );
    assert.equal(failedGrant.status, 500);
    const rolledBack = await adminDatabase.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${quotedSchema}.ce_workspace_acl
         WHERE workspace_id = $1 AND principal_id = $2
       ) AS visible`,
      [workspaceId, "rollback-reader"],
    );
    assert.equal(rolledBack.rows[0]?.visible, false);

    await adminDatabase.query(`
      DROP TRIGGER ce_test_reject_source_policy
        ON ${quotedSchema}.ce_source_access_policies;
      DROP FUNCTION ${quotedSchema}.ce_test_reject_source_policy()
    `);
  });
});
