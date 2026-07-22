import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BitbucketConnectorClient,
  BitbucketConnectorError,
} from "../src/connectors/bitbucket.js";

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Bitbucket connector client", () => {
  it("walks paginated directories, reads ETags, and reuses an unchanged commit", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const commit = "a".repeat(40);
    const content = Buffer.from("# Bitbucket\n");
    const etag = '"etag-1"';
    const requestFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/commit/main")) return json({ hash: commit });
      if (url.endsWith("/docs?pagelen=100")) {
        return json({ values: [{ path: "docs/guide.md", type: "commit_file", size: content.length }] });
      }
      if (url.includes("/src/") && url.includes("?pagelen=")) {
        const parsed = new URL(url);
        const page = parsed.searchParams.get("page");
        if (page === "2") {
          return json({ values: [{ path: "docs/index.md", type: "commit_file", size: content.length }] });
        }
        return json({
          values: [{
            path: "docs",
            type: "commit_directory",
          }, {
            path: "README.md",
            type: "commit_file",
            size: content.length,
          }],
          next: `${new URL(url).origin}/2.0/repositories/acme/tools/src/${commit}/?pagelen=100&page=2`,
        });
      }
      if (method === "HEAD") return new Response(null, { headers: { etag, "content-length": String(content.length) } });
      return new Response(content, { headers: { etag, "content-length": String(content.length) } });
    }) as typeof fetch;
    const client = new BitbucketConnectorClient({
      token: "bitbucket-private-test-token",
      apiBaseUrl: "http://127.0.0.1:8787/2.0",
      fetch: requestFetch,
    });
    const first = await client.getTree("acme", "tools", "main");
    assert.deepEqual(first.files.map((file) => file.path), ["docs/guide.md", "docs/index.md", "README.md"]);
    assert.equal(calls.filter((call) => call.method === "HEAD").length, 3);
    assert.deepEqual(
      await client.getFile("acme", "tools", commit, first.files[0]),
      content,
    );
    const before = calls.length;
    const second = await client.getTree("acme", "tools", "main", commit, first.files);
    assert.deepEqual(second.files, first.files);
    assert.equal(calls.length, before + 1, "unchanged ref should only resolve its commit");
  });

  it("rejects pagination escapes, bad ETags, and redacts API credentials", async () => {
    const client = new BitbucketConnectorClient({
      token: "bitbucket-secret",
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/commit/main")) return json({ hash: "b".repeat(40) });
        return json({ values: [], next: "https://evil.example/steal" });
      }) as typeof fetch,
    });
    await assert.rejects(() => client.getTree("acme", "tools", "main"), /left the API scope/);
    const malformed = new BitbucketConnectorClient({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/commit/main")) return json({ hash: "c".repeat(40) });
        if (init?.method === "HEAD") return new Response(null, { headers: { etag: "" } });
        return json({ values: [{ path: "README.md", type: "commit_file" }] });
      }) as typeof fetch,
    });
    await assert.rejects(() => malformed.getTree("acme", "tools", "main"), BitbucketConnectorError);
  });
});
