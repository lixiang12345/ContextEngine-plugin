import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";

describe("ContextEngine integration", () => {
  let root: string;
  let dataDir: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-test-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "payments.ts"),
      `
export function processPayment(amount: number) {
  return chargeStripe(amount);
}

export function chargeStripe(amount: number) {
  // call stripe API
  return { ok: true, amount };
}
`.trim(),
    );
    writeFileSync(
      path.join(root, "src", "auth.ts"),
      `
export function login(user: string, password: string) {
  return { token: "abc", user };
}
`.trim(),
    );
    writeFileSync(
      path.join(root, "README.md"),
      `# Demo\n\nPayment service docs.\n`,
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes and finds payment code with BM25", async () => {
    const engine = ContextEngine.open({ root, dataDir });
    const result = await engine.index();
    assert.ok(result.filesScanned >= 2);
    assert.ok(result.chunksWritten >= 1);

    const stats = engine.stats();
    assert.equal(stats.fileCount >= 2, true);
    assert.equal(stats.hasEmbeddings, false);

    const hits = await engine.search({
      query: "stripe payment charge",
      topK: 5,
      mode: "bm25",
    });
    assert.ok(hits.length > 0);
    assert.ok(
      hits.some((h) => h.chunk.path.includes("payments")),
      `expected payments hit, got: ${hits.map((h) => h.chunk.path).join(", ")}`,
    );

    const packed = await engine.getTaskContext({
      task: "Add logging to payment requests",
      topK: 5,
      maxTokens: 2000,
    });
    assert.ok(packed.packedText.includes("payments") || packed.hits.length > 0);
    assert.ok(packed.estimatedTokens > 0);

    engine.close();
  });
});
