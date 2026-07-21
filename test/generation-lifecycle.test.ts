import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { ContextEngine } from "../src/engine.js";
import {
  PostgresStore,
  StaleGenerationError,
} from "../src/store/postgres-store.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("index generation lifecycle", () => {
  it("rejects a generation that would roll the active revision backward", async () => {
    const workspaceId = `generation-revision-${Date.now()}-${process.pid}`;
    const initial = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    const current = await initial.beginGeneration("2");
    await current.promoteGeneration();
    await current.close();

    const active = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    const stale = await active.beginGeneration("1");
    await assert.rejects(
      stale.promoteGeneration(),
      (error: unknown) => error instanceof StaleGenerationError,
    );
    await stale.discardGeneration();
    await stale.close();

    const retained = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    assert.equal((await retained.generationStatus()).indexedRevision, "2");
    await retained.close();
  });

  it("refreshes a cached reader after another engine promotes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-reader-refresh-"));
    const workspaceId = `reader-refresh-${Date.now()}-${process.pid}`;
    mkdirSync(path.join(root, "src"), { recursive: true });
    const sourcePath = path.join(root, "src", "revision.ts");
    writeFileSync(
      sourcePath,
      `export function revisionOneHandler() { return "revision-one"; }\n`,
    );

    const writer = ContextEngine.open({ root, workspaceId, databaseUrl });
    const reader = ContextEngine.open({ root, workspaceId, databaseUrl });
    try {
      await writer.index();
      assert.equal(
        (await reader.search({ query: "revisionOneHandler", mode: "bm25" }))
          .some((hit) => hit.chunk.content.includes("revisionOneHandler")),
        true,
      );
      const firstGeneration = (await reader.indexStatus()).generationId;

      writeFileSync(
        sourcePath,
        `export function revisionTwoHandler() { return "revision-two"; }\n`,
      );
      await writer.index();

      const hits = await reader.search({
        query: "revisionTwoHandler",
        mode: "bm25",
      });
      assert.equal(
        hits.some((hit) => hit.chunk.content.includes("revisionTwoHandler")),
        true,
      );
      assert.notEqual((await reader.indexStatus()).generationId, firstGeneration);
      assert.equal(
        (await reader.indexStatus()).generationId,
        (await writer.indexStatus()).generationId,
      );
    } finally {
      await Promise.all([reader.close(), writer.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("garbage-collects retired generations only after the retention window", async () => {
    const workspaceId = `generation-gc-${Date.now()}-${process.pid}`;
    const initial = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    const first = await initial.beginGeneration("1");
    await first.promoteGeneration();
    const firstGenerationId = first.generationId;
    await first.close();

    const active = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    const second = await active.beginGeneration("2");
    await second.promoteGeneration();

    const pool = new Pool({ connectionString: databaseUrl! });
    try {
      await pool.query(
        `UPDATE ce_workspace_generations
         SET updated_at = now() - interval '2 hours'
         WHERE id = $1`,
        [firstGenerationId],
      );
      assert.equal(await second.gcGenerations(60_000), 1);
      const retained = await pool.query<{ id: string }>(
        `SELECT id FROM ce_workspace_generations WHERE id = $1`,
        [firstGenerationId],
      );
      assert.equal(retained.rows.length, 0);
    } finally {
      await pool.end();
      await second.close();
    }
  });
});
