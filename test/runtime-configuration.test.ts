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
  "CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "EMBEDDING_API_KEY",
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
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL =
      "https://models.example.com";
    const configuration = new RuntimeModelConfiguration();

    const candidate = configuration.embeddingCandidate({
      enabled: true,
      baseUrl: "https://other-models.example.com",
      model: "test-model",
      dimensions: 768,
      authentication: "bearer",
      batchSize: 8,
      maxInputChars: 4000,
      inputType: false,
    });

    assert.equal(candidate.apiKey, "existing-key");
    assert.equal(candidate.baseUrl, "https://other-models.example.com/v1");
  });

  it("preserves an environment-configured local endpoint", () => {
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL = "http://127.0.0.1:18000";
    const configuration = new RuntimeModelConfiguration();
    const update = {
      enabled: true,
      baseUrl: undefined,
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

  it("rejects unsafe runtime embedding endpoints by default", () => {
    const configuration = new RuntimeModelConfiguration();
    const endpoints = [
      "ftp://models.example.com",
      "https://user:password@models.example.com",
      "http://localhost:11434",
      "http://127.1:11434",
      "http://10.10.0.2:8080",
      "http://172.16.0.2:8080",
      "http://192.168.1.2:8080",
      "http://169.254.169.254/latest",
      "http://[::1]:8080",
      "http://[fd00::1]:8080",
      "http://[fe80::1]:8080",
      "http://ollama:11434",
      "http://metadata.google.internal",
    ];

    for (const baseUrl of endpoints) {
      assert.throws(
        () =>
          configuration.embeddingCandidate({
            enabled: true,
            baseUrl,
            model: "test-model",
            dimensions: 768,
            authentication: "none",
            batchSize: 8,
            maxInputChars: 4000,
            inputType: false,
          }),
        /must use http|must not include URL credentials|blocked for runtime configuration/,
        baseUrl,
      );
    }
  });

  it("applies the same private-network policy to reranker endpoints", () => {
    const configuration = new RuntimeModelConfiguration();
    assert.throws(
      () =>
        configuration.rerankerCandidate({
          enabled: true,
          baseUrl: "http://192.168.1.20:8080",
          model: "local-reranker",
          authentication: "none",
          topN: 20,
          weight: 0.32,
          maxDocumentChars: 1800,
        }),
      /blocked for runtime configuration/,
    );
  });

  it("does not partially apply a combined update when one section is invalid", () => {
    process.env.CONTEXTENGINE_EMBEDDING_API_KEY = "existing-key";
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL =
      "https://models.example.com";
    process.env.CONTEXTENGINE_EMBED_BATCH = "3";
    process.env.CONTEXTENGINE_EMBED_MAX_CHARS = "2400";
    process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE = "0";
    const configuration = new RuntimeModelConfiguration();
    const previous = configuration.engineConfig();

    assert.throws(
      () =>
        configuration.update({
          embedding: {
            enabled: true,
            baseUrl: "https://replacement.example.com",
            model: "replacement-model",
            dimensions: 768,
            authentication: "bearer",
            batchSize: 16,
            maxInputChars: 6000,
            inputType: true,
          },
          reranker: {
            enabled: true,
            baseUrl: "http://192.168.1.20:8080",
            model: "local-reranker",
            authentication: "none",
            topN: 20,
            weight: 0.32,
            maxDocumentChars: 1800,
          },
        }),
      /blocked for runtime configuration/,
    );

    assert.deepEqual(configuration.engineConfig(), previous);
    assert.equal(process.env.CONTEXTENGINE_EMBED_BATCH, "3");
    assert.equal(process.env.CONTEXTENGINE_EMBED_MAX_CHARS, "2400");
    assert.equal(process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE, "0");
  });

  it("allows private endpoints only with the explicit server opt-in", () => {
    process.env.CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS = "1";
    const configuration = new RuntimeModelConfiguration();
    const candidate = configuration.embeddingCandidate({
      enabled: true,
      baseUrl: "http://127.0.0.1:19000",
      model: "local-embedding",
      dimensions: 768,
      authentication: "none",
      batchSize: 8,
      maxInputChars: 4000,
      inputType: false,
    });

    assert.equal(candidate.baseUrl, "http://127.0.0.1:19000/v1");
    const snapshot = configuration.snapshot({
      databaseUrl: "postgresql://database.example.com/contextengine",
      allowUnauthenticated: false,
      allowLocalWorkspaces: false,
      localRootAllowlistCount: 0,
      maxBlobBytes: 1024,
      disableEmbeddings: false,
    }) as {
      model_api: {
        runtime_base_url_policy: {
          protocols: string[];
          url_credentials: string;
          private_network_targets: string;
          private_network_opt_in_env: string;
        };
      };
    };
    assert.deepEqual(snapshot.model_api.runtime_base_url_policy, {
      protocols: ["http", "https"],
      url_credentials: "blocked",
      private_network_targets: "allowed_by_server_opt_in",
      private_network_opt_in_env:
        "CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS",
    });
  });
});
