import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_RETRIEVAL_TOOL_NAMES,
  isMcpWatchEnabled,
} from "../src/mcp-server.js";

describe("MCP compatibility settings", () => {
  it("enables file watching by default and accepts common false values", () => {
    assert.equal(isMcpWatchEnabled(undefined), true);
    assert.equal(isMcpWatchEnabled("1"), true);
    assert.equal(isMcpWatchEnabled("true"), true);
    assert.equal(isMcpWatchEnabled("0"), false);
    assert.equal(isMcpWatchEnabled(" FALSE "), false);
    assert.equal(isMcpWatchEnabled("off"), false);
    assert.equal(isMcpWatchEnabled("No"), false);
  });

  it("exposes the Augment-compatible tool name and legacy alias", () => {
    assert.deepEqual(CONTEXT_RETRIEVAL_TOOL_NAMES, [
      "codebase-retrieval",
      "codebase_retrieval",
    ]);
  });
});
