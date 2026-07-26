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
  it("never discards a generation after it becomes active", async () => {
    const workspaceId = `generation-active-discard-${Date.now()}-${process.pid}`;
    const initial = await PostgresStore.open({
      databaseUrl: databaseUrl!,
      workspaceId,
    });
    const active = await initial.beginGeneration("1");
    try {
      await active.replaceChunksForFile("src/active.ts", [
        {
          id: "active-chunk",
          path: "src/active.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
          content: "export const activeGeneration = true;",
          symbol: "activeGeneration",
          hash: "active-hash",
        },
      ]);
      await active.promoteGeneration();

      await active.discardGeneration();

      assert.equal((await active.generationStatus()).status, "active");
      assert.equal(await active.chunkCount(), 1);
      assert.equal(await active.isCurrentGeneration(), true);
    } finally {
      await active.close();
    }
  });

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

  it("discards a staging generation when lease cancellation arrives before promotion", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-index-abort-"));
    const workspaceId = `index-abort-${Date.now()}-${process.pid}`;
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "abort.ts"),
      `export function abortBeforePromotion() { return true; }\n`,
    );
    const engine = ContextEngine.open({ root, workspaceId, databaseUrl });
    const controller = new AbortController();
    try {
      await assert.rejects(
        engine.index((progress) => {
          if (progress.phase === "chunk") {
            controller.abort(new Error("index lease lost"));
          }
        }, controller.signal),
        /index lease lost/,
      );
      const pool = new Pool({ connectionString: databaseUrl! });
      try {
        const generations = await pool.query<{ status: string; count: string }>(
          `SELECT status, COUNT(*)::text AS count
           FROM ce_workspace_generations
           WHERE logical_workspace_id = $1
           GROUP BY status
           ORDER BY status`,
          [workspaceId],
        );
        assert.deepEqual(generations.rows, [
          { status: "active", count: "1" },
          { status: "failed", count: "1" },
        ]);
        const aliases = await pool.query<{ status: string }>(
          `SELECT g.status
           FROM ce_workspace_aliases a
           JOIN ce_workspace_generations g ON g.id = a.generation_id
           WHERE a.logical_workspace_id = $1`,
          [workspaceId],
        );
        assert.deepEqual(aliases.rows, [{ status: "active" }]);
      } finally {
        await pool.end();
      }
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels while waiting for a held workspace generation lock", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-index-lock-abort-"));
    const workspaceId = `index-lock-abort-${Date.now()}-${process.pid}`;
    writeFileSync(
      path.join(root, "blocked.ts"),
      `export const blockedByGenerationLock = true;\n`,
    );
    await PostgresStore.ensureSchema(databaseUrl!);
    const pool = new Pool({ connectionString: databaseUrl! });
    const blocker = await pool.connect();
    const key = await blocker.query<{ key: string }>(
      `SELECT hashtextextended($1, 0)::text AS key`,
      [workspaceId],
    );
    const lockKey = key.rows[0]?.key;
    assert.ok(lockKey);
    await blocker.query(`SELECT pg_advisory_lock($1::bigint)`, [lockKey]);
    const engine = ContextEngine.open({ root, workspaceId, databaseUrl });
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(new Error("shutdown cancelled lock wait")),
      50,
    );
    const fallbackUnlock = setTimeout(
      () => void blocker.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]),
      500,
    );
    const started = Date.now();
    try {
      await assert.rejects(
        engine.index(undefined, controller.signal),
        /shutdown cancelled lock wait/,
      );
      assert.ok(
        Date.now() - started < 400,
        "lock wait should reject before the fallback unlock",
      );
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(fallbackUnlock);
      await blocker
        .query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey])
        .catch(() => undefined);
      blocker.release();
      await pool.end();
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries once when a generation is promoted mid-search", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-search-race-"));
    const workspaceId = `search-race-${Date.now()}-${process.pid}`;
    mkdirSync(path.join(root, "src"), { recursive: true });
    const sourcePath = path.join(root, "src", "race.ts");
    writeFileSync(
      sourcePath,
      `export function raceHandlerOne() { return "one"; }\n`,
    );

    const writer = ContextEngine.open({ root, workspaceId, databaseUrl });
    const reader = ContextEngine.open({ root, workspaceId, databaseUrl });
    try {
      await writer.index();
      // Warm the reader so its cached searcher and preflight both see the
      // first generation as current.
      assert.equal(
        (await reader.search({ query: "raceHandlerOne", mode: "bm25" })).some(
          (hit) => hit.chunk.content.includes("raceHandlerOne"),
        ),
        true,
      );
      const firstGeneration = (await reader.indexStatus()).generationId;

      writeFileSync(
        sourcePath,
        `export function raceHandlerTwo() { return "two"; }\n`,
      );

      // Inject the race: let the preflight check pass as current, then promote
      // a new generation before the post-search staleness check runs. The
      // engine must refresh and retry once rather than pair hits with the
      // retired generation's provenance.
      const store = (reader as unknown as {
        ensureStore: () => Promise<PostgresStore>;
      });
      const liveStore = await store.ensureStore();
      const originalIsCurrent = liveStore.isCurrentGeneration.bind(liveStore);
      let checks = 0;
      let promoted = false;
      (liveStore as unknown as {
        isCurrentGeneration: () => Promise<boolean>;
      }).isCurrentGeneration = async () => {
        checks++;
        // First call is the preflight (report current); promote right after so
        // the post-search check observes a retired generation exactly once.
        if (checks === 1) return true;
        if (!promoted) {
          promoted = true;
          await writer.index();
          return false;
        }
        return originalIsCurrent();
      };

      const hits = await reader.search({
        query: "raceHandlerTwo",
        mode: "bm25",
      });
      assert.ok(checks >= 2, "post-search staleness check should run");
      assert.equal(
        hits.some((hit) => hit.chunk.content.includes("raceHandlerTwo")),
        true,
      );
      // After the forced retry the reader serves the promoted generation.
      assert.notEqual(
        (await reader.indexStatus()).generationId,
        firstGeneration,
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
