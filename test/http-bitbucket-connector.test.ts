import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

const databaseUrl = process.env.CONTEXTENGINE_TEST_DATABASE_URL ?? process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const token = "bitbucket-http-test-token";
const webhookSecret = "bitbucket-http-webhook-secret";

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

describePostgres("Bitbucket connector HTTP integration", () => {
  const schema = `ce_bb_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const api = createServer();
  let handle: HttpServerHandle;
  let apiUrl = "";
  let workspaceId = "";
  let version = 1;
  const commits = ["1".repeat(40), "2".repeat(40)];
  const content = {
    1: { "docs/old.md": "# Old\nBitbucket first revision.\n" },
    2: { "docs/new.md": "# New\nBitbucket webhook revision.\n" },
  } as const;
  const etag = (path: string) => `"${version}-${path}"`;

  function request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  }

  async function waitJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await request(`/v1/index-jobs/${jobId}`);
      const job = (await response.json() as { job: { status: string; error?: string } }).job;
      if (job.status === "succeeded") return;
      if (job.status === "failed") assert.fail(job.error ?? "Bitbucket index job failed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Bitbucket index job timeout");
  }

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    api.on("request", async (request, response) => {
      const url = new URL(request.url ?? "/", "http://bitbucket.test");
      const prefix = "/2.0/repositories/acme/tools";
      if (!url.pathname.startsWith(prefix)) { response.statusCode = 404; response.end(); return; }
      const current = content[version as 1 | 2];
      if (url.pathname.endsWith("/commit/main")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ hash: commits[version - 1] }));
        return;
      }
      const src = new RegExp(`${prefix}/src/([^/]+)(?:/(.*))?$`).exec(url.pathname);
      if (!src) { response.statusCode = 404; response.end(); return; }
      const commit = src[1];
      const path = src[2] ? decodeURIComponent(src[2]) : "";
      if (path === "") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          values: Object.keys(current).map((file) => ({
            path: file,
            type: "commit_file",
            size: Buffer.byteLength(current[file as keyof typeof current]),
          })),
        }));
        return;
      }
      const value = current[path as keyof typeof current];
      if (value === undefined) { response.statusCode = 404; response.end(); return; }
      response.setHeader("etag", etag(path));
      response.setHeader("content-length", String(Buffer.byteLength(value)));
      if (request.method === "HEAD") { response.end(); return; }
      response.setHeader("content-type", "text/plain");
      response.end(value);
      void commit;
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    apiUrl = `http://127.0.0.1:${address.port}/2.0`;
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl(databaseUrl!, schema),
      apiKey: token,
      disableEmbeddings: true,
      bitbucketToken: "bitbucket-api-token",
      bitbucketApiBaseUrl: apiUrl,
      bitbucketWebhookSecret: webhookSecret,
      webhookPollIntervalMs: 100,
    });
  });

  after(async () => {
    await handle.close();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    try { await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await admin.end(); }
  });

  it("indexes Bitbucket content and refreshes via signed repo:push", async () => {
    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bitbucket workspace" }),
    });
    assert.equal(created.status, 201);
    workspaceId = (await created.json() as { workspace: { id: string } }).workspace.id;
    const attached = await request(`/v1/workspaces/${workspaceId}/sources/bitbucket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "acme", repository: "tools", ref: "main" }),
    });
    assert.equal(attached.status, 201);
    const sourceId = (await attached.json() as { source: { id: string } }).source.id;
    const first = await request(`/v1/workspaces/${workspaceId}/sources/${sourceId}/sync`, { method: "POST" });
    assert.equal(first.status, 202);
    const firstPayload = await first.json() as { index_job: { id: string } };
    await waitJob(firstPayload.index_job.id);
    const search = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Bitbucket first revision", mode: "bm25", top_k: 5 }),
    });
    assert.match(await search.text(), /docs\/old\.md/);

    version = 2;
    const body = Buffer.from(JSON.stringify({
      repository: { full_name: "acme/tools", mainbranch: { name: "main" } },
      push: { changes: [{ new: { type: "branch", name: "main" } }] },
    }));
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    const webhook = await fetch(`${handle.url}/webhooks/bitbucket`, {
      method: "POST",
      headers: { "x-hub-signature": signature, "x-request-uuid": `bb-${Date.now()}`, "x-event-key": "repo:push" },
      body,
    });
    assert.equal(webhook.status, 202);
    let refreshed = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      const result = await request(`/v1/workspaces/${workspaceId}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "Bitbucket webhook revision", mode: "bm25", top_k: 5 }),
      });
      if ((await result.text()).includes("docs/new.md")) { refreshed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(refreshed, true);
    assert.equal((await request(`/v1/workspaces/${workspaceId}/file?path=docs%2Fold.md`)).status, 404);
  });
});
