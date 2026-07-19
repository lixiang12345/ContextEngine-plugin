import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import {
  testEmbeddingConnection,
  testRerankerConnection,
} from "../src/server/model-connection-test.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.close();
  await once(server, "close");
  server = undefined;
});

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<string> {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

describe("model connection tests", () => {
  it("tests an unauthenticated embedding endpoint and reports dimensions", async () => {
    const origin = await listen((request, response) => {
      assert.equal(request.url, "/v1/embeddings");
      assert.equal(request.headers.authorization, undefined);
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          input_type?: string;
          dimensions?: number;
        };
        assert.equal(body.input_type, "document");
        assert.equal(body.dimensions, 3);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [{ index: 0, embedding: [3, 4, 0] }],
          }),
        );
      });
    });

    const result = await testEmbeddingConnection(
      {
        baseUrl: origin,
        model: "test-embedding",
        dimensions: 3,
      },
      {
        inputType: true,
        maxInputChars: 4000,
      },
    );

    assert.equal(result.model, "test-embedding");
    assert.equal(result.details.dimensions, 3);
    assert.equal(result.details.vectors, 1);
    assert.ok(result.latencyMs >= 0);
  });

  it("tests an authenticated reranker endpoint and requires valid scores", async () => {
    const origin = await listen((request, response) => {
      assert.equal(request.url, "/v1/rerank");
      assert.equal(request.headers.authorization, "Bearer rerank-key");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.1 },
          ],
        }),
      );
    });

    const result = await testRerankerConnection({
      apiKey: "rerank-key",
      baseUrl: origin,
      model: "test-reranker",
      topN: 20,
      weight: 0.32,
      maxDocChars: 1800,
    });

    assert.equal(result.model, "test-reranker");
    assert.equal(result.details.scored_documents, 2);
    assert.ok(result.latencyMs >= 0);
  });

  it("rejects reranker responses without usable scores", async () => {
    const origin = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [] }));
    });

    await assert.rejects(
      testRerankerConnection({
        baseUrl: origin,
        model: "test-reranker",
        topN: 20,
        weight: 0.32,
        maxDocChars: 1800,
      }),
      /no valid scores/,
    );
  });
});
