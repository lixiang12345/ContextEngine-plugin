import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SourceConnectorRegistry,
  type SourceConnectorPlugin,
} from "../src/connectors/types.js";

function plugin(provider: string, displayName = provider): SourceConnectorPlugin {
  return {
    provider,
    displayName,
    validateConfig: () => ({}),
    externalId: () => provider,
    rootAlias: () => provider,
    listFiles: async () => ({ revision: "1", cursor: {}, files: [] }),
    readFile: async () => Buffer.alloc(0),
  };
}

describe("SourceConnectorRegistry", () => {
  it("rejects unsafe and duplicate provider ids", () => {
    assert.throws(
      () => new SourceConnectorRegistry([plugin("Unsafe Provider")]),
      /must match/,
    );
    const registry = new SourceConnectorRegistry([plugin("docs")]);
    assert.throws(() => registry.register(plugin("docs")), /already registered/);
    assert.throws(() => registry.register(plugin("other", "  ")), /display name/);
  });

  it("resolves plugins and lists them in stable provider order", () => {
    const registry = new SourceConnectorRegistry([
      plugin("website", "Website"),
      plugin("gitlab", "GitLab"),
    ]);
    assert.equal(registry.require("gitlab").displayName, "GitLab");
    assert.deepEqual(registry.list(), [
      { provider: "gitlab", displayName: "GitLab" },
      { provider: "website", displayName: "Website" },
    ]);
    assert.throws(() => registry.require("missing"), /Unsupported connector provider/);
  });
});
