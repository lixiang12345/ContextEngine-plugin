import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { OpenAICompatibleEmbeddings } from "../src/embeddings/provider.js";
import {
  bufferToVector,
  cosineSimilarity,
  vectorToBuffer,
} from "../src/embeddings/provider.js";
import {
  neuralRerankScores,
  type NeuralRerankConfig,
} from "../src/search/neural-rerank.js";

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

describe("remote model providers", () => {
  it("stores SQLite vectors as compact float32 arrays", () => {
    const vector = bufferToVector(vectorToBuffer([0.25, -0.5, 1]));
    assert.ok(vector instanceof Float32Array);
    assert.deepEqual([...vector], [0.25, -0.5, 1]);
    assert.equal(cosineSimilarity(vector, new Float32Array([0.25, -0.5, 1])), 1.3125);
    assert.throws(
      () => cosineSimilarity(vector, new Float32Array([1, 2])),
      /dimension mismatch/,
    );
  });

  it("embeds through an origin URL and preserves input order", async () => {
    const origin = await listen((req, res) => {
      assert.equal(req.url, "/v1/embeddings");
      assert.equal(req.headers.authorization, "Bearer test-key");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 2] },
            { index: 0, embedding: [3, 0] },
          ],
        }),
      );
    });
    const provider = new OpenAICompatibleEmbeddings({
      apiKey: "test-key",
      baseUrl: origin,
      model: "test-embedding",
    });
    assert.deepEqual(await provider.embed(["a", "b"]), [
      [1, 0],
      [0, 1],
    ]);
  });

  it("can send Qwen v2 input types when enabled", async () => {
    const previous = process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE;
    process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE = "1";
    const inputTypes: string[] = [];
    try {
      const origin = await listen((req, res) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          inputTypes.push(JSON.parse(raw).input_type);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
        });
      });
      const provider = new OpenAICompatibleEmbeddings({
        apiKey: "test-key",
        baseUrl: origin,
        model: "test-embedding",
      });
      await provider.embed(["document"]);
      await provider.embedQuery!(["query"]);
      assert.deepEqual(inputTypes, ["document", "query"]);
    } finally {
      if (previous === undefined) {
        delete process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE;
      } else {
        process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE = previous;
      }
    }
  });

  it("reranks through an origin URL", async () => {
    const origin = await listen((req, res) => {
      assert.equal(req.url, "/v1/rerank");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 },
          ],
        }),
      );
    });
    const config: NeuralRerankConfig = {
      apiKey: "test-key",
      baseUrl: origin,
      model: "test-reranker",
      topN: 2,
      weight: 0.3,
      maxDocChars: 1000,
    };
    const scores = await neuralRerankScores(config, "query", [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ]);
    assert.equal(scores.get("a"), 0.2);
    assert.equal(scores.get("b"), 0.9);
  });
});
