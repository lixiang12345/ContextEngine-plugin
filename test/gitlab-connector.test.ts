import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitLabConnectorClient,
  GitLabConnectorError,
} from "../src/connectors/gitlab.js";

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GitLab connector client", () => {
  it("resolves a ref, paginates the tree, and reuses previous file metadata", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const commitSha = "a".repeat(40);
    const entries = Array.from({ length: 101 }, (_, index) => ({
      id: index.toString(16).padStart(40, "0"),
      path: `src/file-${index}.ts`,
      type: "blob",
    }));
    const requestFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ url, method, headers });
      if (url.includes("/repository/commits/")) return jsonResponse({ id: commitSha });
      if (url.includes("/repository/tree")) {
        const page = new URL(url).searchParams.get("page");
        return jsonResponse(page === "1" ? entries.slice(0, 100) : entries.slice(100));
      }
      if (method === "HEAD") {
        const path = decodeURIComponent(new URL(url).pathname.split("/repository/files/")[1]);
        const index = Number(path.match(/file-(\d+)\.ts/)?.[1]);
        return new Response(null, {
          status: 200,
          headers: {
            "x-gitlab-blob-id": entries[index].id,
            "x-gitlab-size": "1",
          },
        });
      }
      return jsonResponse({
        sha: entries[0].id,
        size: 1,
        encoding: "base64",
        content: "eA==",
      });
    };
    const client = new GitLabConnectorClient({
      token: "gitlab-private-test-token",
      apiBaseUrl: "http://127.0.0.1:8787/api/v4/",
      metadataConcurrency: 4,
      fetch: requestFetch as typeof fetch,
    });
    const first = await client.getTree("acme/tools", "main");
    assert.equal(first.revision, commitSha);
    assert.equal(first.files.length, 101);
    assert.equal(calls.filter((call) => call.method === "HEAD").length, 101);
    const second = await client.getTree("acme/tools", "main", first.files);
    assert.deepEqual(second.files, first.files);
    assert.equal(calls.filter((call) => call.method === "HEAD").length, 101);
    assert.ok(calls.every((call) => call.headers.get("private-token") === "gitlab-private-test-token"));
    assert.ok(calls.some((call) => call.url.includes("projects/acme%2Ftools")));
  });

  it("reads and validates a base64 Blob, and redacts token errors", async () => {
    const token = "gitlab-secret-must-not-leak";
    const sha = "b".repeat(40);
    const content = Buffer.from("x");
    let includeSha = true;
    const client = new GitLabConnectorClient({
      token,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get("private-token"), token);
        if (String(input).includes("/blobs/")) {
          return jsonResponse({
            sha: includeSha ? sha : "c".repeat(40),
            size: 1,
            encoding: "base64",
            content: content.toString("base64"),
          });
        }
        return jsonResponse({ message: token }, 404);
      }) as typeof fetch,
    });
    assert.deepEqual(await client.getBlob("acme/tools", sha, 1), content);
    includeSha = false;
    await assert.rejects(() => client.getBlob("acme/tools", sha, 1), /does not match the tree/);
    await assert.rejects(
      () => client.getTree("acme/tools", "main"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
  });

  it("rejects unsafe API bases and malformed repository metadata", async () => {
    assert.throws(
      () => new GitLabConnectorClient({ apiBaseUrl: "http://gitlab.example.com/api/v4" }),
      /must use https/,
    );
    const client = new GitLabConnectorClient({
      fetch: (async () => jsonResponse({ id: "not-a-sha" })) as typeof fetch,
    });
    await assert.rejects(() => client.getTree("acme/tools", "main"), GitLabConnectorError);
  });
});
