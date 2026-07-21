import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubConnectorClient,
  GitHubConnectorError,
} from "../src/connectors/github.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub connector client", () => {
  it("reads a bounded recursive tree and decodes Blob content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const content = Buffer.from("export const connected = true;\n");
    const requestFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("/git/trees/")) {
        return jsonResponse({
          sha: "tree-sha",
          truncated: false,
          tree: [
            { type: "tree", path: "src", sha: "directory" },
            {
              type: "blob",
              path: "src/connected.ts",
              sha: "blob-sha",
              size: content.length,
            },
          ],
        });
      }
      return jsonResponse({
        encoding: "base64",
        content: content.toString("base64"),
        size: content.length,
      });
    };
    const client = new GitHubConnectorClient({
      token: "private-test-token",
      apiBaseUrl: "http://127.0.0.1:8787/api/",
      fetch: requestFetch as typeof fetch,
    });

    const tree = await client.getTree("owner", "repo", "refs/heads/main");
    assert.deepEqual(tree, {
      revision: "tree-sha",
      files: [
        {
          path: "src/connected.ts",
          revision: "blob-sha",
          bytes: content.length,
        },
      ],
    });
    assert.deepEqual(
      await client.getBlob("owner", "repo", "blob-sha"),
      content,
    );
    assert.match(calls[0].url, /refs%2Fheads%2Fmain/);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer private-test-token",
    );
  });

  it("rejects truncated, unsafe, and oversized trees", async () => {
    const responses = [
      { sha: "tree", truncated: true, tree: [] },
      {
        sha: "tree",
        truncated: false,
        tree: [{ type: "blob", path: "../secret", sha: "blob", size: 1 }],
      },
      {
        sha: "tree",
        truncated: false,
        tree: [
          { type: "blob", path: "one", sha: "1", size: 1 },
          { type: "blob", path: "two", sha: "2", size: 1 },
        ],
      },
    ];
    for (const [index, payload] of responses.entries()) {
      const client = new GitHubConnectorClient({
        maxFiles: index === 2 ? 1 : 20_000,
        fetch: (async () => jsonResponse(payload)) as typeof fetch,
      });
      await assert.rejects(() => client.getTree("owner", "repo", "HEAD"),
        GitHubConnectorError);
    }
  });

  it("never includes its Bearer credential in remote errors", async () => {
    const token = "credential-must-not-leak";
    const client = new GitHubConnectorClient({
      token,
      fetch: (async () => jsonResponse({ message: "not found" }, 404)) as typeof fetch,
    });
    await assert.rejects(
      () => client.getTree("private-owner", "private-repo", "HEAD"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(token), false);
        assert.match(error.message, /HTTP 404/);
        return true;
      },
    );
  });

  it("rejects a Blob whose declared size differs from decoded bytes", async () => {
    const client = new GitHubConnectorClient({
      fetch: (async () =>
        jsonResponse({ encoding: "base64", content: "YQ==", size: 2 })) as typeof fetch,
    });
    await assert.rejects(
      () => client.getBlob("owner", "repo", "blob"),
      /size does not match/,
    );
  });
});
