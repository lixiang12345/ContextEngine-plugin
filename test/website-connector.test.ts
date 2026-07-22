import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { WebsiteSourceConnector } from "../src/connectors/website.js";

describe("static website connector", () => {
  let server: Server;
  let origin = "";
  const requests: string[] = [];
  let robotsStatus = 200;

  before(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/robots.txt") {
        response.statusCode = robotsStatus;
        response.setHeader("content-type", "text/plain");
        response.end([
          "User-agent: *",
          "Disallow: /docs/private*",
          "Allow: /docs/private/public$",
        ].join("\n"));
        return;
      }
      if (request.url === "/docs/") {
        if (request.headers["if-none-match"] === '"root-v1"') {
          response.statusCode = 304;
          response.end();
          return;
        }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("etag", '"root-v1"');
        response.end(`<!doctype html><html><head><title>Docs Home</title>
          <style>.hidden { color: red }</style><script>stealSecret()</script></head>
          <body><h1>Context Engine Docs</h1><p>Portable retrieval guide.</p>
          <a href="/docs/guide">Guide</a>
          <a href="/docs/private/secret">Secret</a>
          <a href="/docs/private/public">Public exception</a>
          <a href="/docs/final?tracking=1">Query ignored</a>
          <a href="/asset.pdf">Asset ignored</a></body></html>`);
        return;
      }
      if (request.url === "/docs/guide") {
        response.setHeader("content-type", "text/html");
        response.end("<title>Guide</title><main><h2>Install</h2><p>Run the indexer.</p></main>");
        return;
      }
      if (request.url === "/docs/private/public") {
        response.setHeader("content-type", "text/html");
        response.end("<title>Public</title><p>Allowed robots exception.</p>");
        return;
      }
      if (request.url === "/docs/private/secret") {
        response.setHeader("content-type", "text/html");
        response.end("<p>must never be fetched</p>");
        return;
      }
      if (request.url === "/docs/oversized") {
        response.setHeader("content-type", "text/html");
        response.end(`<p>${"x".repeat(20 * 1024)}</p>`);
        return;
      }
      if (request.url === "/docs/redirect-out") {
        response.statusCode = 302;
        response.setHeader("location", "https://other.example/docs/");
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  });

  it("enforces URL policy and resolves every production hostname to public IPs", async () => {
    const production = new WebsiteSourceConnector({
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as typeof import("node:dns/promises").lookup,
    });
    assert.throws(
      () => production.validateConfig({ start_url: "http://example.com/docs/" }),
      /must use HTTPS/,
    );
    assert.throws(
      () => production.validateConfig({ start_url: "https://127.0.0.1/docs/" }),
      /loopback/,
    );
    assert.throws(
      () => production.validateConfig({ start_url: "https://user:pass@example.com/docs/" }),
      /without credentials/,
    );
    assert.throws(
      () => production.validateConfig({ start_url: "https://example.com/docs/?page=1" }),
      /without credentials, a query, or a fragment/,
    );
    assert.throws(
      () => production.validateConfig({
        start_url: "https://example.com/docs/",
        path_prefix: "/private/",
      }),
      /inside path_prefix/,
    );
    await assert.rejects(
      production.listFiles(
        production.validateConfig({ start_url: "https://public.example/docs/" }),
        null,
      ),
      /loopback IPv4 address/,
    );
    for (const address of ["192.0.2.10", "198.51.100.10", "203.0.113.10", "2001:db8::10"]) {
      const reserved = new WebsiteSourceConnector({
        lookup: (async () => [{
          address,
          family: address.includes(":") ? 6 : 4,
        }]) as typeof import("node:dns/promises").lookup,
      });
      await assert.rejects(
        reserved.listFiles(
          reserved.validateConfig({ start_url: "https://public.example/docs/" }),
          null,
        ),
        /documentation/,
      );
    }
  });

  it("obeys robots, stays in scope, bounds pages, and emits searchable text", async () => {
    requests.length = 0;
    robotsStatus = 200;
    const connector = new WebsiteSourceConnector({ allowPrivateNetwork: true });
    const config = connector.validateConfig({
      start_url: `${origin}/docs/`,
      max_pages: 10,
      max_depth: 2,
    });
    const snapshot = await connector.listFiles(config, null);
    assert.deepEqual(
      snapshot.files.map((file) => file.path).sort(),
      [
        "website/docs/guide.md",
        "website/docs/index.md",
        "website/docs/private/public.md",
      ],
    );
    assert.equal(requests.includes("/docs/private/secret"), false);
    assert.equal(requests.some((url) => url.includes("tracking")), false);
    const root = snapshot.files.find((file) => file.path.endsWith("index.md"));
    assert.ok(root);
    const text = (await connector.readFile(config, root)).toString("utf8");
    assert.match(text, /# Docs Home/);
    assert.match(text, /Context Engine Docs/);
    assert.match(text, /Source: http:\/\/127\.0\.0\.1/);
    assert.doesNotMatch(text, /stealSecret|hidden \{ color/);

    requests.length = 0;
    const limited = await connector.listFiles(
      connector.validateConfig({
        start_url: `${origin}/docs/`,
        max_pages: 2,
        max_depth: 5,
      }),
      null,
    );
    assert.equal(limited.files.length, 2);
    assert.equal(requests.filter((url) => url !== "/robots.txt").length, 2);
  });

  it("uses validators and cursor links for incremental 304 crawls", async () => {
    requests.length = 0;
    const connector = new WebsiteSourceConnector({ allowPrivateNetwork: true });
    const config = connector.validateConfig({
      start_url: `${origin}/docs/`,
      max_pages: 3,
      max_depth: 1,
    });
    const first = await connector.listFiles(config, null);
    const root = first.files.find((file) => file.path.endsWith("index.md"));
    assert.ok(root);
    const internals = connector as unknown as {
      content: Map<string, Buffer>;
      contentBytes: number;
    };
    internals.content.clear();
    internals.contentBytes = 0;
    assert.match((await connector.readFile(config, root)).toString("utf8"), /Docs Home/);
    requests.length = 0;
    const second = await connector.listFiles(config, first.cursor);
    assert.equal(second.revision, first.revision);
    assert.deepEqual(second.files, first.files);
    assert.ok(requests.includes("/docs/guide"), "304 cursor links must still be traversed");
  });

  it("fails closed on robots outages, cross-origin redirects, and oversized pages", async () => {
    const connector = new WebsiteSourceConnector({ allowPrivateNetwork: true });
    robotsStatus = 503;
    await assert.rejects(
      connector.listFiles(
        connector.validateConfig({ start_url: `${origin}/docs/` }),
        null,
      ),
      /robots\.txt is temporarily unavailable/,
    );
    robotsStatus = 200;
    await assert.rejects(
      connector.listFiles(
        connector.validateConfig({ start_url: `${origin}/docs/redirect-out` }),
        null,
      ),
      /redirect left the configured origin/,
    );
    await assert.rejects(
      connector.listFiles(
        connector.validateConfig({
          start_url: `${origin}/docs/oversized`,
          max_page_bytes: 16 * 1024,
          max_total_bytes: 64 * 1024,
        }),
        null,
      ),
      /page size limit/,
    );
  });
});
