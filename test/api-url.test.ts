import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  apiOriginFromBaseUrl,
  normalizeOpenAIBaseUrl,
  openAIEndpoint,
} from "../src/util/api-url.js";

describe("OpenAI-compatible API URLs", () => {
  it("accepts origins, versioned bases, and full endpoint URLs", () => {
    assert.equal(
      normalizeOpenAIBaseUrl("https://example.com"),
      "https://example.com/v1",
    );
    assert.equal(
      normalizeOpenAIBaseUrl("https://example.com/v1/"),
      "https://example.com/v1",
    );
    assert.equal(
      normalizeOpenAIBaseUrl("https://example.com/v1/embeddings"),
      "https://example.com/v1",
    );
  });

  it("builds endpoints without duplicating the API version", () => {
    assert.equal(
      openAIEndpoint("https://example.com", "/rerank"),
      "https://example.com/v1/rerank",
    );
    assert.equal(
      apiOriginFromBaseUrl("https://example.com/v1"),
      "https://example.com",
    );
  });
});
