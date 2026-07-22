import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { after, before, describe, it } from "node:test";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import { FilesystemSnapshotStore } from "../src/snapshots/filesystem-store.js";

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

describePostgres("owner-managed snapshot HTTP API", () => {
  const schema = `ce_http_snapshot_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const tokens = { alice: "snapshot-alice", bob: "snapshot-bob" } as const;
  let directory = "";
  let handle: HttpServerHandle;

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    directory = await mkdtemp(path.join(os.tmpdir(), "ce-http-snapshot-"));
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKeys: [
        { principalId: "alice", token: tokens.alice },
        { principalId: "bob", token: tokens.bob },
      ],
      disableEmbeddings: true,
      snapshotStore: new FilesystemSnapshotStore(directory),
    });
  });

  after(async () => {
    await handle.close();
    try {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
    } finally {
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  function request(
    actor: keyof typeof tokens,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens[actor]}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function createWorkspace(
    actor: keyof typeof tokens,
    name: string,
  ): Promise<string> {
    const response = await request(actor, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { workspace: { id: string } }).workspace
      .id;
  }

  it("isolates snapshots by workspace and requires owner permission", async () => {
    const aliceWorkspace = await createWorkspace("alice", "Alice snapshots");
    const bobWorkspace = await createWorkspace("bob", "Bob snapshots");
    const capabilities = await request("alice", "/v1/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(
      ((await capabilities.json()) as { snapshots: { configured: boolean } })
        .snapshots.configured,
      true,
    );

    const invalid = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "team-main", unexpected: true }),
      },
    );
    assert.equal(invalid.status, 400);

    const exported = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "team-main" }),
      },
    );
    assert.equal(exported.status, 201);
    assert.equal(
      ((await exported.json()) as { snapshot: { counts: { files: number } } })
        .snapshot.counts.files,
      0,
    );
    const aliceList = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots`,
    );
    assert.deepEqual(await aliceList.json(), { snapshots: ["team-main"] });
    const bobList = await request(
      "bob",
      `/v1/workspaces/${bobWorkspace}/snapshots`,
    );
    assert.deepEqual(await bobList.json(), { snapshots: [] });
    assert.equal(
      (
        await request(
          "alice",
          `/v1/workspaces/${aliceWorkspace}/snapshots/missing/import`,
          { method: "POST", body: "{}" },
        )
      ).status,
      404,
    );

    const grant = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/acl/bob`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: "reader" }),
      },
    );
    assert.equal(grant.status, 200);
    assert.equal(
      (await request("bob", `/v1/workspaces/${aliceWorkspace}/snapshots`))
        .status,
      404,
    );

    const imported = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main/import`,
      { method: "POST", body: "{}" },
    );
    assert.equal(imported.status, 200);
    assert.match(
      ((await imported.json()) as { generation_id: string }).generation_id,
      /^[0-9a-f-]{36}$/,
    );
    const pruned = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots:prune`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keep: 1 }),
      },
    );
    assert.equal(pruned.status, 200);
    assert.deepEqual(await pruned.json(), { deleted: [] });
    const deleted = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots/team-main`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 200);
    const gc = await request(
      "alice",
      `/v1/workspaces/${aliceWorkspace}/snapshots:gc`,
      { method: "POST", body: "{}" },
    );
    assert.equal(gc.status, 200);
    assert.equal(
      ((await gc.json()) as { deleted_artifacts: string[] }).deleted_artifacts
        .length,
      1,
    );
  });

  it("returns service unavailable when no snapshot store is configured", async () => {
    const isolated = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: "snapshot-unconfigured",
      disableEmbeddings: true,
      snapshotStore: null,
    });
    try {
      const created = await fetch(`${isolated.url}/v1/workspaces`, {
        method: "POST",
        headers: {
          authorization: "Bearer snapshot-unconfigured",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "No snapshot store" }),
      });
      const workspaceId = (
        (await created.json()) as { workspace: { id: string } }
      ).workspace.id;
      const response = await fetch(
        `${isolated.url}/v1/workspaces/${workspaceId}/snapshots`,
        { headers: { authorization: "Bearer snapshot-unconfigured" } },
      );
      assert.equal(response.status, 503);
    } finally {
      await isolated.close();
    }
  });
});
