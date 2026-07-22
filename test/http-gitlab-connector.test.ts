import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

const databaseUrl = process.env.CONTEXTENGINE_TEST_DATABASE_URL ?? process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const token = "gitlab-http-test-token";
const webhookKey = Buffer.from("gitlab-signing-key-for-http-test-32bytes!!");
const webhookSigningToken = `whsec_${webhookKey.toString("base64").replace(/=+$/, "")}`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaUrl(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

function blobId(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

describePostgres("GitLab connector HTTP integration", () => {
  const schema = `ce_gitlab_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const api = createServer();
  let handle: HttpServerHandle;
  let apiBaseUrl = "";
  let workspaceId = "";
  let version = 1;
  let metadataRequests = 0;
  const commits = ["1".repeat(40), "2".repeat(40)];
  const files = {
    1: [
      { path: "docs/alpha.md", content: "# Alpha\nGitLab connector first revision.\n" },
      { path: "docs/remove.md", content: "# Remove\nThis page is deleted next.\n" },
    ],
    2: [
      { path: "docs/beta.md", content: "# Beta\nGitLab connector webhook refresh.\n" },
      { path: "docs/alpha.md", content: "# Alpha\nGitLab connector updated revision.\n" },
    ],
  } as const;

  function request(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  }

  async function waitForJob(jobId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await request(`/v1/index-jobs/${jobId}`);
      assert.equal(response.status, 200);
      const job = (await response.json() as { job: { status: string; error?: string } }).job;
      if (job.status === "succeeded") return;
      if (job.status === "failed") assert.fail(job.error ?? "GitLab index job failed");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("GitLab index job timed out");
  }

  async function sync(sourceId: string): Promise<{
    index_job: { id: string } | null;
    changed_paths: string[];
    deleted_paths: string[];
  }> {
    const response = await request(`/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`, {
      method: "POST",
    });
    assert.ok(response.status === 200 || response.status === 202);
    const payload = await response.json() as {
      index_job: { id: string } | null;
      changed_paths: string[];
      deleted_paths: string[];
    };
    if (payload.index_job) await waitForJob(payload.index_job.id);
    return payload;
  }

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    api.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://gitlab.test");
      if (!url.pathname.startsWith("/api/v4/")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const project = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      if (project !== "acme/tools") {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "unknown project" }));
        return;
      }
      const current = files[version as 1 | 2];
      if (url.pathname.endsWith("/repository/commits/main")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: commits[version - 1] }));
        return;
      }
      if (url.pathname.endsWith("/repository/tree")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(current.map((file) => ({
          id: blobId(file.content),
          path: file.path,
          type: "blob",
        }))));
        return;
      }
      const fileMatch = /\/repository\/files\/(.+)$/.exec(url.pathname);
      if (fileMatch) {
        const path = decodeURIComponent(fileMatch[1]);
        const file = current.find((candidate) => candidate.path === path);
        if (!file) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const id = blobId(file.content);
        response.setHeader("x-gitlab-blob-id", id);
        response.setHeader("x-gitlab-size", String(Buffer.byteLength(file.content)));
        if (request.method === "HEAD") {
          metadataRequests += 1;
          response.statusCode = 200;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          sha: id,
          size: Buffer.byteLength(file.content),
          encoding: "base64",
          content: Buffer.from(file.content).toString("base64"),
        }));
        return;
      }
      const blobMatch = /\/repository\/blobs\/([0-9a-f]+)$/.exec(url.pathname);
      if (blobMatch) {
        const file = current.find((candidate) =>
          blobId(candidate.content) === blobMatch[1],
        );
        if (!file) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          sha: blobMatch[1],
          size: Buffer.byteLength(file.content),
          encoding: "base64",
          content: Buffer.from(file.content).toString("base64"),
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    apiBaseUrl = `http://127.0.0.1:${address.port}/api/v4`;
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl(databaseUrl!, schema),
      apiKey: token,
      disableEmbeddings: true,
      gitlabToken: "gitlab-api-token",
      gitlabApiBaseUrl: apiBaseUrl,
      gitlabWebhookSigningToken: webhookSigningToken,
      webhookPollIntervalMs: 100,
    });
  });

  after(async () => {
    await handle.close();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("indexes GitLab content and refreshes through a signed push webhook", async () => {
    const createdWorkspace = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitLab workspace" }),
    });
    assert.equal(createdWorkspace.status, 201);
    workspaceId = (await createdWorkspace.json() as { workspace: { id: string } }).workspace.id;
    const attached = await request(`/v1/workspaces/${workspaceId}/sources/gitlab`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "acme/tools", ref: "main" }),
    });
    assert.equal(attached.status, 201);
    const sourceId = (await attached.json() as { source: { id: string } }).source.id;
    const first = await sync(sourceId);
    assert.deepEqual(first.changed_paths.sort(), ["docs/alpha.md", "docs/remove.md"].sort());
    assert.equal(metadataRequests, 2);
    const search = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "GitLab connector first revision", mode: "bm25", top_k: 5 }),
    });
    assert.equal(search.status, 200);
    assert.match(await search.text(), /docs\/alpha\.md/);
    const unchanged = await sync(sourceId);
    assert.equal(unchanged.index_job, null);
    assert.equal(metadataRequests, 2, "unchanged blobs must reuse core-owned metadata");

    version = 2;
    const body = Buffer.from(JSON.stringify({
      object_kind: "push",
      ref: "refs/heads/main",
      after: commits[1],
      project: { path_with_namespace: "acme/tools", default_branch: "main" },
    }));
    const id = `gitlab-http-${Date.now()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${createHmac("sha256", webhookKey)
      .update(`${id}.${timestamp}.${body.toString("utf8")}`)
      .digest("base64")}`;
    const webhook = await fetch(`${handle.url}/webhooks/gitlab`, {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
        "x-gitlab-event": "Push Hook",
      },
      body,
    });
    assert.equal(webhook.status, 202);

    let refreshed = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      const result = await request(`/v1/workspaces/${workspaceId}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "webhook refresh", mode: "bm25", top_k: 5 }),
      });
      assert.equal(result.status, 200);
      if ((await result.text()).includes("docs/beta.md")) {
        refreshed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(refreshed, true);
    assert.equal(
      (await request(`/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent("docs/remove.md")}`)).status,
      404,
    );
  });
});
