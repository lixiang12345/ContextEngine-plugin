import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import type {
  ConnectorFileSnapshot,
  ConnectorSnapshot,
  SourceConnectorPlugin,
  SourceConnectorWebhookHandler,
} from "../src/connectors/types.js";

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

interface MemoryDocument {
  path: string;
  content: string;
  revision: string;
}

class MemoryDocsPlugin implements SourceConnectorPlugin {
  readonly provider = "memory_docs";
  readonly displayName = "Memory documents";
  readonly collections = new Map<string, MemoryDocument[]>();
  readonly webhook: SourceConnectorWebhookHandler = {
    verify: ({ headers, body }) => {
      if (headers["x-memory-signature"] !== "signed-fixture") {
        throw new Error("invalid fixture signature");
      }
      const payload = JSON.parse(body.toString("utf8")) as {
        id: string;
        collection: string;
      };
      return {
        id: payload.id,
        externalId: payload.collection,
        action: "sync",
      };
    },
    matchesConfig: (event, config) =>
      event.externalId === String(config.collection),
  };

  validateConfig(input: unknown): Record<string, unknown> {
    if (!input || Array.isArray(input) || typeof input !== "object") {
      throw new Error("memory_docs config must be an object");
    }
    const collection = (input as Record<string, unknown>).collection;
    if (typeof collection !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(collection)) {
      throw new Error("memory_docs collection is invalid");
    }
    if (!this.collections.has(collection)) this.collections.set(collection, []);
    return { collection };
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    return String(config.collection);
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    return `memory:${String(config.collection)}`;
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    _previousCursor: Readonly<Record<string, unknown>> | null,
  ): Promise<ConnectorSnapshot> {
    const documents = this.collections.get(String(config.collection)) ?? [];
    const revision = documents.map((document) => document.revision).join(":") || "empty";
    return {
      revision,
      cursor: { revision },
      files: documents.map((document) => ({
        path: document.path,
        revision: document.revision,
        bytes: Buffer.byteLength(document.content),
      })),
    };
  }

  async readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const documents = this.collections.get(String(config.collection)) ?? [];
    const document = documents.find(
      (candidate) => candidate.path === file.path && candidate.revision === file.revision,
    );
    if (!document) throw new Error(`memory_docs document not found: ${file.path}`);
    return Buffer.from(document.content);
  }
}

describePostgres("source connector plugin contract", () => {
  const schema = `ce_plugin_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const schemaUrl = databaseUrlForSchema(databaseUrl!, schema);
  const admin = new Pool({ connectionString: databaseUrl! });
  const token = "source-plugin-test-token";
  const plugin = new MemoryDocsPlugin();
  let handle: HttpServerHandle;
  let workspaceId = "";
  let sourceId = "";
  let websiteVersion = 1;
  const websiteServer = createServer((request, response) => {
    if (request.url === "/robots.txt") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("User-agent: *\nAllow: /docs/\nDisallow: /\n");
      return;
    }
    const etag = `\"website-${websiteVersion}-${request.url}\"`;
    if (request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("etag", etag);
    if (request.url === "/docs/") {
      response.end(websiteVersion === 1
        ? "<title>Portal</title><main>alpha launch notebook</main><a href='/docs/guide'>Guide</a>"
        : "<title>Portal</title><main>beta migration compass</main><a href='/docs/new'>New</a>");
      return;
    }
    if (request.url === "/docs/guide" && websiteVersion === 1) {
      response.end("<title>Guide</title><p>obsolete retention appendix</p>");
      return;
    }
    if (request.url === "/docs/new" && websiteVersion === 2) {
      response.end("<title>New</title><p>current deployment handbook</p>");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  let websiteUrl = "";

  async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function waitForJob(jobId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await request(`/v1/index-jobs/${jobId}`);
      assert.equal(response.status, 200);
      const job = (await response.json() as { job: { status: string; error?: string } }).job;
      if (job.status === "succeeded") return;
      if (job.status === "failed") assert.fail(job.error ?? "plugin index job failed");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("plugin index job timed out");
  }

  async function sync(id = sourceId): Promise<{
    noop: boolean;
    changed_paths: string[];
    deleted_paths: string[];
    index_job: { id: string } | null;
  }> {
    const response = await request(`/v1/workspaces/${workspaceId}/sources/${id}/sync`, {
      method: "POST",
    });
    assert.ok(response.status === 202 || response.status === 200);
    const payload = await response.json() as {
      noop: boolean;
      changed_paths: string[];
      deleted_paths: string[];
      index_job: { id: string } | null;
    };
    if (payload.index_job) await waitForJob(payload.index_job.id);
    return payload;
  }

  before(async () => {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    websiteServer.listen(0, "127.0.0.1");
    await once(websiteServer, "listening");
    const websiteAddress = websiteServer.address();
    assert.ok(websiteAddress && typeof websiteAddress !== "string");
    websiteUrl = `http://127.0.0.1:${websiteAddress.port}`;
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: schemaUrl,
      apiKey: token,
      disableEmbeddings: true,
      connectorPlugins: [plugin],
      websiteAllowPrivateNetwork: true,
      webhookPollIntervalMs: 100,
    });
    plugin.collections.set("handbook", [
      {
        path: "docs/alpha.md",
        content: "# Alpha\nThe tenant authorization boundary is enforced here.\n",
        revision: "alpha-1",
      },
    ]);
  });

  after(async () => {
    await handle.close();
    websiteServer.close();
    await once(websiteServer, "close");
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("indexes and updates a third-party provider without core changes", async () => {
    const capabilities = await request("/v1/capabilities");
    assert.equal(capabilities.status, 200);
    const capabilityPayload = await capabilities.json() as {
      connectors: string[];
      connector_plugins: Array<{
        provider: string;
        display_name: string;
        webhook: boolean;
      }>;
    };
    assert.ok(capabilityPayload.connectors.includes("memory_docs"));
    assert.deepEqual(
      capabilityPayload.connector_plugins.find((plugin) => plugin.provider === "memory_docs"),
      {
        provider: "memory_docs",
        display_name: "Memory documents",
        webhook: true,
      },
    );

    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Plugin workspace" }),
    });
    assert.equal(created.status, 201);
    workspaceId = (await created.json() as { workspace: { id: string } }).workspace.id;

    const attached = await request(`/v1/workspaces/${workspaceId}/sources/memory_docs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "handbook" }),
    });
    assert.equal(attached.status, 201);
    sourceId = (await attached.json() as { source: { id: string } }).source.id;
    await sync();

    const firstSearch = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "tenant authorization boundary", top_k: 5 }),
    });
    assert.equal(firstSearch.status, 200);
    const firstPayload = await firstSearch.json() as { results: Array<{ path: string }> };
    assert.ok(firstPayload.results.some((result) => result.path === "docs/alpha.md"));

    plugin.collections.set("handbook", [
      {
        path: "docs/beta.md",
        content: "# Beta\nThe connector plugin contract is provider-neutral.\n",
        revision: "beta-1",
      },
    ]);
    const pluginWebhook = await fetch(`${handle.url}/webhooks/memory_docs`, {
      method: "POST",
      headers: { "x-memory-signature": "signed-fixture" },
      body: JSON.stringify({ id: "memory-delivery-1", collection: "handbook" }),
    });
    assert.equal(pluginWebhook.status, 202);

    let secondPayload: { results: Array<{ path: string }> } = { results: [] };
    for (let attempt = 0; attempt < 120; attempt++) {
      const secondSearch = await request(`/v1/workspaces/${workspaceId}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "connector plugin contract", top_k: 5 }),
      });
      assert.equal(secondSearch.status, 200);
      secondPayload = await secondSearch.json() as {
        results: Array<{ path: string }>;
      };
      if (secondPayload.results.some((result) => result.path === "docs/beta.md")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(secondPayload.results.some((result) => result.path === "docs/beta.md"));
    assert.equal(secondPayload.results.some((result) => result.path === "docs/alpha.md"), false);
  });

  it("crawls and incrementally updates the built-in website provider through HTTP", async () => {
    const capabilities = await request("/v1/capabilities");
    assert.equal(capabilities.status, 200);
    const capabilityPayload = await capabilities.json() as {
      connector_plugins: Array<{
        provider: string;
        display_name: string;
        webhook: boolean;
      }>;
    };
    assert.deepEqual(
      capabilityPayload.connector_plugins.find((plugin) => plugin.provider === "website"),
      { provider: "website", display_name: "Static website", webhook: false },
    );

    const created = await request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Website workspace" }),
    });
    assert.equal(created.status, 201);
    workspaceId = (await created.json() as { workspace: { id: string } }).workspace.id;

    const attached = await request(`/v1/workspaces/${workspaceId}/sources/website`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start_url: `${websiteUrl}/docs/`,
        max_pages: 10,
        max_depth: 2,
      }),
    });
    assert.equal(attached.status, 201);
    const websiteSourceId = (await attached.json() as { source: { id: string } }).source.id;

    const first = await sync(websiteSourceId);
    assert.equal(first.noop, false);
    assert.deepEqual(first.changed_paths.sort(), [
      "website/docs/guide.md",
      "website/docs/index.md",
    ]);
    const firstSearch = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "alpha launch notebook", mode: "bm25", top_k: 5 }),
    });
    assert.equal(firstSearch.status, 200);
    assert.match(await firstSearch.text(), /website\/docs\/index\.md/);

    const unchanged = await sync(websiteSourceId);
    assert.equal(unchanged.noop, true);
    assert.equal(unchanged.index_job, null);

    websiteVersion = 2;
    const second = await sync(websiteSourceId);
    assert.equal(second.noop, false);
    assert.deepEqual(second.changed_paths.sort(), [
      "website/docs/index.md",
      "website/docs/new.md",
    ]);
    assert.deepEqual(second.deleted_paths, ["website/docs/guide.md"]);

    const secondSearch = await request(`/v1/workspaces/${workspaceId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "beta migration compass", mode: "bm25", top_k: 5 }),
    });
    assert.equal(secondSearch.status, 200);
    assert.match(await secondSearch.text(), /website\/docs\/index\.md/);
    assert.equal(
      (await request(
        `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent("website/docs/guide.md")}`,
      )).status,
      404,
    );
  });
});
