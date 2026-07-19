import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RuntimeModelConfiguration } from "../src/server/runtime-configuration.js";

const trackedEnvironment = [
  "CONTEXTENGINE_EMBEDDING_API_KEY",
  "CONTEXTENGINE_EMBEDDING_BASE_URL",
  "CONTEXTENGINE_EMBEDDING_MODEL",
  "CONTEXTENGINE_EMBEDDING_DIMENSIONS",
  "CONTEXTENGINE_EMBED_BATCH",
  "CONTEXTENGINE_EMBED_MAX_CHARS",
  "CONTEXTENGINE_EMBEDDING_INPUT_TYPE",
  "CONTEXTENGINE_NEURAL_RERANK",
  "CONTEXTENGINE_RERANK_API_KEY",
  "CONTEXTENGINE_RERANK_BASE_URL",
] as const;

let previousEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  previousEnvironment = Object.fromEntries(
    trackedEnvironment.map((name) => [name, process.env[name]]),
  );
  for (const name of trackedEnvironment) delete process.env[name];
});

afterEach(() => {
  for (const name of trackedEnvironment) {
    const value = previousEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("runtime model configuration", () => {
  it("reuses the current Bearer key when the test form leaves it blank", () => {
    process.env.CONTEXTENGINE_EMBEDDING_API_KEY = "existing-key";
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL = "http://127.0.0.1:18000";
    const configuration = new RuntimeModelConfiguration();

    const candidate = configuration.embeddingCandidate({
      enabled: true,
      baseUrl: "http://127.0.0.1:19000",
      model: "test-model",
      dimensions: 768,
      authentication: "bearer",
      batchSize: 8,
      maxInputChars: 4000,
      inputType: false,
    });

    assert.equal(candidate.apiKey, "existing-key");
    assert.equal(candidate.baseUrl, "http://127.0.0.1:19000/v1");
  });

  it("allows local endpoints without an API key and applies updates in process", () => {
    const configuration = new RuntimeModelConfiguration();
    const update = {
      enabled: true,
      baseUrl: "http://127.0.0.1:18000",
      model: "local-embedding",
      dimensions: 1024,
      authentication: "none" as const,
      batchSize: 4,
      maxInputChars: 3000,
      inputType: true,
    };

    const candidate = configuration.embeddingCandidate(update);
    assert.equal(candidate.apiKey, undefined);

    const result = configuration.update({ embedding: update });
    assert.equal(result.changed, true);
    assert.equal(result.reindexRequired, true);
    assert.equal(
      configuration.engineConfig().embeddings?.baseUrl,
      "http://127.0.0.1:18000/v1",
    );
    assert.equal(process.env.CONTEXTENGINE_EMBED_BATCH, "4");
    assert.equal(process.env.CONTEXTENGINE_EMBED_MAX_CHARS, "3000");
    assert.equal(process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE, "1");
  });
});
