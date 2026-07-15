import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { PostgresStore } from "../src/store/postgres-store.js";

const describePostgres =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL
    ? describe
    : describe.skip;

describePostgres("ContextEngine PostgreSQL integration", () => {
  let root: string;
  let dataDir: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-test-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "payments.ts"),
      `
import { auditPayment } from "./audit";

export function processPayment(amount: number) {
  return chargeStripe(amount);
}

export function chargeStripe(amount: number) {
  // call stripe API
  auditPayment(amount);
  return { ok: true, amount };
}
`.trim(),
    );
    writeFileSync(
      path.join(root, "src", "audit.ts"),
      `export function auditPayment(amount: number) { return amount; }\n`,
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

    const stats = await engine.stats();
    assert.equal(stats.fileCount >= 2, true);
    assert.equal(stats.hasEmbeddings, false);

    const databaseUrl =
      process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
      process.env.CONTEXTENGINE_DATABASE_URL!;
    const store = await PostgresStore.open({
      databaseUrl,
      workspaceId: root,
    });
    const missingModel = "pagination-regression-model";
    const missingCount = await store.countChunksMissingEmbeddings(missingModel);
    assert.equal(missingCount, stats.chunkCount);
    assert.equal(
      (await store.chunksMissingEmbeddings(missingModel, 1)).length,
      1,
    );
    assert.equal(
      (await store.chunksMissingEmbeddings(missingModel, 2)).length,
      Math.min(2, missingCount),
    );
    await store.close();

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
    assert.ok(
      hits.some((h) => h.chunk.path.includes("audit")),
      `expected graph-expanded audit hit, got: ${hits.map((h) => h.chunk.path).join(", ")}`,
    );

    const packed = await engine.getTaskContext({
      task: "Add logging to payment requests",
      topK: 5,
      maxTokens: 2000,
    });
    assert.ok(packed.packedText.includes("payments") || packed.hits.length > 0);
    assert.ok(packed.estimatedTokens > 0);

    await engine.close();
  });
});
