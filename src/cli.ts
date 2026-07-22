#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadDotEnv, resolveDatabaseUrl, resolveEngineConfig } from "./config.js";
import { ContextEngine } from "./engine.js";
import { renderCiTemplate, type CiTemplateProvider } from "./ci/templates.js";
import { FilesystemSnapshotStore } from "./snapshots/filesystem-store.js";
import { S3SnapshotStore } from "./snapshots/s3-store.js";
import {
  deleteIndexSnapshot,
  exportIndexSnapshot,
  garbageCollectSnapshotArtifacts,
  importIndexSnapshot,
  listIndexSnapshots,
  pruneIndexSnapshots,
} from "./snapshots/snapshot.js";
import type { SnapshotObjectStore } from "./snapshots/object-store.js";

loadDotEnv();

const program = new Command();

program
  .name("contextengine")
  .description(
    "Portable Context Engine for AI coding agents — index, search, and pack codebase context.",
  )
  .version("0.4.0");

program
  .command("ci-template")
  .description("Print an installable CI workflow for a source sync trigger")
  .argument("<provider>", "github | gitlab | bitbucket")
  .action((provider: string) => {
    if (!(["github", "gitlab", "bitbucket"] as const).includes(provider as CiTemplateProvider)) {
      throw new Error(`Unsupported CI provider: ${provider}`);
    }
    process.stdout.write(renderCiTemplate(provider as CiTemplateProvider));
  });

const snapshot = program
  .command("snapshot")
  .description("Export or import a versioned team index snapshot");

snapshot
  .command("export")
  .argument("<name>", "snapshot name")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--workspace-id <id>", "logical workspace id (defaults to root)")
  .option("--store <location>", "directory or s3://bucket/prefix")
  .action(async (name: string, opts: SnapshotCliOptions) => {
    const root = path.resolve(opts.root);
    const result = await exportIndexSnapshot({
      databaseUrl: requireSnapshotDatabaseUrl(),
      workspaceId: opts.workspaceId ?? root,
      name,
      store: snapshotStore(opts.store, root),
    });
    console.log(JSON.stringify(result, null, 2));
  });

snapshot
  .command("import")
  .argument("<name>", "snapshot name")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--workspace-id <id>", "logical workspace id (defaults to root)")
  .option("--store <location>", "directory or s3://bucket/prefix")
  .action(async (name: string, opts: SnapshotCliOptions) => {
    const root = path.resolve(opts.root);
    const result = await importIndexSnapshot({
      databaseUrl: requireSnapshotDatabaseUrl(),
      workspaceId: opts.workspaceId ?? root,
      name,
      store: snapshotStore(opts.store, root),
    });
    console.log(JSON.stringify(result, null, 2));
  });

snapshot
  .command("list")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--store <location>", "directory or s3://bucket/prefix")
  .action(async (opts: Omit<SnapshotCliOptions, "workspaceId">) => {
    const root = path.resolve(opts.root);
    console.log(JSON.stringify(await listIndexSnapshots(snapshotStore(opts.store, root)), null, 2));
  });

snapshot
  .command("delete")
  .argument("<name>", "snapshot name")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--store <location>", "directory or s3://bucket/prefix")
  .action(async (name: string, opts: Omit<SnapshotCliOptions, "workspaceId">) => {
    const root = path.resolve(opts.root);
    await deleteIndexSnapshot({ name, store: snapshotStore(opts.store, root) });
    console.log(JSON.stringify({ deleted: name }));
  });

snapshot
  .command("gc")
  .description("Delete unreferenced content-addressed snapshot artifacts")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--store <location>", "directory or s3://bucket/prefix")
  .action(async (opts: Omit<SnapshotCliOptions, "workspaceId">) => {
    const root = path.resolve(opts.root);
    console.log(JSON.stringify(await garbageCollectSnapshotArtifacts(snapshotStore(opts.store, root)), null, 2));
  });

snapshot
  .command("prune")
  .description("Delete old snapshots by age while retaining the newest snapshots")
  .option("-r, --root <dir>", "local workspace root", process.cwd())
  .option("--store <location>", "directory or s3://bucket/prefix")
  .option("--keep <count>", "number of newest snapshots to retain", "0")
  .option("--older-than-days <days>", "delete snapshots at least this old")
  .action(async (opts: Omit<SnapshotCliOptions, "workspaceId"> & { keep: string; olderThanDays?: string }) => {
    const root = path.resolve(opts.root);
    const keepLatest = Number(opts.keep);
    const olderThanMs = opts.olderThanDays === undefined
      ? undefined
      : Number(opts.olderThanDays) * 24 * 60 * 60 * 1000;
    console.log(JSON.stringify(
      await pruneIndexSnapshots({
        store: snapshotStore(opts.store, root),
        keepLatest,
        olderThanMs,
      }),
      null,
      2,
    ));
  });

program
  .command("index")
  .description("Index a workspace (incremental, multi-root via --extra or env)")
  .argument("[root]", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option(
    "-e, --extra <specs...>",
    "extra roots name:path (e.g. docs:../docs api:../api)",
  )
  .option(
    "--exclude <patterns...>",
    "extra gitignore-style exclude patterns (repeatable)",
  )
  .option("-q, --quiet", "less output")
  .action(
    async (
      root: string,
      opts: {
        dataDir?: string;
        quiet?: boolean;
        extra?: string[];
        exclude?: string[];
      },
    ) => {
    const extraRoots = (opts.extra ?? []).flatMap((spec) => {
      const colon = spec.indexOf(":");
      if (colon <= 0) return [];
      return [
        {
          name: spec.slice(0, colon),
          path: path.resolve(spec.slice(colon + 1)),
          kind: spec.startsWith("docs")
            ? ("docs" as const)
            : ("code" as const),
        },
      ];
    });
    const config = resolveEngineConfig({
      root: path.resolve(root),
      dataDir: opts.dataDir,
      extraRoots: extraRoots.length ? extraRoots : undefined,
      extraIgnores: opts.exclude,
    });
    const engine = new ContextEngine(config);
    if (!opts.quiet) {
      console.log(`Indexing ${config.root}`);
      if (config.extraRoots?.length) {
        console.log(
          `Extra roots: ${config.extraRoots.map((r) => r.name + ":" + r.path).join(", ")}`,
        );
      }
      console.log("Storage: PostgreSQL + pgvector");
      console.log(
        config.embeddings
          ? `Embeddings: ${config.embeddings.model} @ ${config.embeddings.baseUrl}`
          : "Embeddings: off (multi-signal FTS+symbol still on — set OPENAI_API_KEY for semantic)",
      );
    }
    let lastMsg = "";
    const result = await engine.index((p) => {
      if (opts.quiet) return;
      const msg =
        p.message ||
        `${p.phase} ${p.filesDone}/${p.filesTotal} files · ${p.chunksTotal} chunks`;
      if (msg !== lastMsg) {
        process.stdout.write(`\r\x1b[K  ${msg}`);
        lastMsg = msg;
      }
    });
    await engine.close();
    if (!opts.quiet) process.stdout.write("\n");
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result,
          storage: "postgresql+pgvector",
        },
        null,
        2,
      ),
    );
  },
  );

program
  .command("search")
  .description("Search the index")
  .argument("<query>", "search query")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("-k, --top-k <n>", "number of results", "8")
  .option("--path-prefix <prefix>", "limit to path prefix")
  .option("--mode <mode>", "auto | bm25 | semantic | hybrid", "auto")
  .option("--json", "JSON output")
  .action(
    async (
      query: string,
      opts: {
        root: string;
        dataDir?: string;
        topK: string;
        pathPrefix?: string;
        mode: "auto" | "bm25" | "semantic" | "hybrid";
        json?: boolean;
      },
    ) => {
      const engine = ContextEngine.open({
        root: path.resolve(opts.root),
        dataDir: opts.dataDir,
      });
      const hits = await engine.search({
        query,
        topK: Number(opts.topK) || 8,
        pathPrefix: opts.pathPrefix,
        mode: opts.mode,
      });
      await engine.close();
      if (opts.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      if (!hits.length) {
        console.log("No results.");
        return;
      }
      for (const [i, hit] of hits.entries()) {
        console.log(
          `${i + 1}. ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine}  [${hit.source} ${hit.score.toFixed(4)}]${hit.chunk.symbol ? "  " + hit.chunk.symbol : ""}`,
        );
        console.log(`   ${hit.preview}`);
        console.log();
      }
    },
  );

program
  .command("context")
  .description("Pack task-oriented context for an agent")
  .argument("<task>", "natural language task")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("-k, --top-k <n>", "chunks to consider", "12")
  .option("--max-tokens <n>", "optional cap for packed context tokens")
  .option("--json", "JSON output")
  .action(
    async (
      task: string,
      opts: {
        root: string;
        dataDir?: string;
        topK: string;
        maxTokens?: string;
        json?: boolean;
      },
    ) => {
      const engine = ContextEngine.open({
        root: path.resolve(opts.root),
        dataDir: opts.dataDir,
      });
      const packed = await engine.getTaskContext({
        task,
        topK: Number(opts.topK) || 12,
        maxTokens: optionalPositiveInteger(opts.maxTokens),
      });
      await engine.close();
      if (opts.json) {
        console.log(JSON.stringify(packed, null, 2));
        return;
      }
      console.log(packed.packedText);
      console.error(
        `\n--- ~${packed.estimatedTokens} tokens · ${packed.hits.length} chunks${packed.truncated ? " · capped" : ""} ---`,
      );
    },
  );

program
  .command("status")
  .description("Show index status")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .action(async (opts: { root: string; dataDir?: string }) => {
    const engine = ContextEngine.open({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    if (!(await engine.hasIndex())) {
      console.log(
        JSON.stringify(
          { ok: false, error: "no index", hint: "run contextengine index" },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      await engine.close();
      return;
    }
    const stats = await engine.stats();
    await engine.close();
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  });

program
  .command("serve")
  .description("Start MCP server on stdio (same as contextengine-mcp)")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("--auto-index", "index on startup if missing or stale is not checked; indexes if missing")
  .action(async (opts: { root: string; dataDir?: string; autoIndex?: boolean }) => {
    const { startMcpServer } = await import("./mcp-server.js");
    await startMcpServer({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
      autoIndex: opts.autoIndex,
    });
  });

program
  .command("http")
  .description("Start the authenticated HTTP Context Engine service")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "8787")
  .option("--api-key <key>", "Bearer API key (defaults to CONTEXTENGINE_HTTP_API_KEY)")
  .option(
    "--allow-local-workspaces",
    "allow server-side local-root workspaces (disabled by default)",
  )
  .action(
    async (opts: {
      host: string;
      port: string;
      apiKey?: string;
      allowLocalWorkspaces?: boolean;
    }) => {
      const { startHttpServer } = await import("./http-server.js");
      const parsedPort = Number(opts.port);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
      const handle = await startHttpServer({
        host: opts.host,
        port: parsedPort,
        apiKey: opts.apiKey,
        allowLocalWorkspaces: opts.allowLocalWorkspaces,
      });
      console.log(`ContextEngine HTTP server listening at ${handle.url}`);
      const stop = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  );

program
  .command("watch")
  .description("Watch workspace and incrementally re-index on changes")
  .argument("[root]", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("--debounce <ms>", "debounce milliseconds", "800")
  .action(
    async (
      root: string,
      opts: { dataDir?: string; debounce: string },
    ) => {
      const config = resolveEngineConfig({
        root: path.resolve(root),
        dataDir: opts.dataDir,
      });
      const { watchAndIndex } = await import("./indexer/watch.js");
      console.log(`Watching ${config.root}`);
      console.log("Storage: PostgreSQL + pgvector");
      const handle = watchAndIndex(config, {
        debounceMs: Number(opts.debounce) || 800,
        onIndexed: (r) => {
          console.log(
            `[index] scanned=${r.filesScanned} updated=${r.filesIndexed} chunks+=${r.chunksWritten} embeds+=${r.embeddingsWritten} (${r.durationMs}ms)`,
          );
        },
        onError: (e) => {
          console.error("[watch error]", e instanceof Error ? e.message : e);
        },
      });
      const stop = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  );

program
  .command("migrate-sqlite")
  .description("One-time migration from a legacy SQLite index into PostgreSQL")
  .argument("<source>", "legacy SQLite index.db path")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .action(async (source: string, opts: { root: string; dataDir?: string }) => {
    const config = resolveEngineConfig({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    const { migrateSqliteIndex } = await import("./store/migrate-sqlite.js");
    const result = await migrateSqliteIndex(path.resolve(source), config);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("clear-index")
  .description("Delete this workspace's PostgreSQL index")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "legacy SQLite data directory")
  .action(async (opts: { root: string; dataDir?: string }) => {
    const engine = ContextEngine.open({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    await engine.clearIndex();
    await engine.close();
    console.log(JSON.stringify({ ok: true, storage: "postgresql+pgvector" }, null, 2));
  });

program
  .command("eval")
  .description("Run retrieval evaluation cases (JSON file or built-in self-eval)")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("-c, --cases <file>", "JSON file of eval cases")
  .option("--self", "run built-in self-eval against this repo's sources")
  .option("--reindex", "reindex before eval")
  .action(
    async (opts: {
      root: string;
      dataDir?: string;
      cases?: string;
      self?: boolean;
      reindex?: boolean;
    }) => {
      const { readFileSync } = await import("node:fs");
      const {
        runEval,
        defaultSelfEvalCases,
      } = await import("./eval/harness.js");
      const engine = ContextEngine.open({
        root: path.resolve(opts.root),
        dataDir: opts.dataDir,
      });
      if (opts.reindex || !(await engine.hasIndex())) {
        await engine.index();
      }
      let cases;
      if (opts.cases) {
        cases = JSON.parse(readFileSync(opts.cases, "utf8"));
      } else if (opts.self || !opts.cases) {
        cases = defaultSelfEvalCases();
      } else {
        cases = [];
      }
      const report = await runEval(engine, cases);
      await engine.close();
      console.log(JSON.stringify(report, null, 2));
      if (report.failed > 0) process.exitCode = 1;
    },
  );

program
  .command("eval-pr")
  .alias("pr-eval")
  .description("Run agent PR tasks in isolated Git repositories")
  .requiredOption("-m, --manifest <file>", "versioned PR eval manifest JSON")
  .option("-o, --out <file>", "write the full JSON report")
  .option("--markdown <file>", "write a compact Markdown report")
  .option("--case <ids...>", "run only selected case ids")
  .option("--variant <ids...>", "run only selected variant ids")
  .option("--keep-worktrees", "keep temporary repositories for debugging")
  .option(
    "--allow-exec",
    "allow setup, agent, and test commands from the manifest",
  )
  .option(
    "--fail-on-unsolved",
    "exit non-zero when any task is not solved",
  )
  .action(
    async (opts: {
      manifest: string;
      out?: string;
      markdown?: string;
      case?: string[];
      variant?: string[];
      keepWorktrees?: boolean;
      allowExec?: boolean;
      failOnUnsolved?: boolean;
    }) => {
      if (!opts.allowExec) {
        throw new Error(
          "eval-pr executes manifest commands; review the file and pass --allow-exec",
        );
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const {
        formatPrEvalReportMarkdown,
        loadPrEvalSuite,
        runPrEvalSuite,
      } = await import("./eval/pr-harness.js");
      const suite = loadPrEvalSuite(opts.manifest);
      const report = await runPrEvalSuite(suite, {
        caseIds: opts.case,
        variantIds: opts.variant,
        keepWorktrees: opts.keepWorktrees,
        onProgress: (progress) => {
          if (progress.phase === "start") {
            console.error(
              `[${progress.completedRuns + 1}/${progress.totalRuns}] ${progress.caseId} / r${progress.repetition} / ${progress.variantId}`,
            );
          } else {
            console.error(`  ${progress.status}`);
          }
        },
      });
      const json = JSON.stringify(report, null, 2);
      if (opts.out) {
        const outputPath = path.resolve(opts.out);
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${json}\n`, "utf8");
        console.error(`JSON report: ${outputPath}`);
      } else {
        console.log(json);
      }
      if (opts.markdown) {
        const markdownPath = path.resolve(opts.markdown);
        mkdirSync(path.dirname(markdownPath), { recursive: true });
        writeFileSync(
          markdownPath,
          formatPrEvalReportMarkdown(report),
          "utf8",
        );
        console.error(`Markdown report: ${markdownPath}`);
      }
      if (report.summary.errors > 0) process.exitCode = 2;
      else if (
        opts.failOnUnsolved &&
        report.summary.passed !== report.summary.totalRuns
      ) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("profile")
  .description("Manage multi-repo profiles (contextengine.profiles.json)")
  .argument("<action>", "list | add | use")
  .argument("[name]", "profile name")
  .option("--root <dir>", "repo root when adding")
  .option("--data-dir <dir>", "data dir when adding")
  .option("-f, --file <path>", "profiles file path")
  .action(
    async (
      action: string,
      name: string | undefined,
      opts: { root?: string; dataDir?: string; file?: string },
    ) => {
      const {
        loadProfiles,
        saveProfiles,
        upsertProfile,
        resolveProfile,
      } = await import("./config/profiles.js");

      if (action === "list") {
        console.log(JSON.stringify(loadProfiles(opts.file), null, 2));
        return;
      }
      if (action === "add") {
        if (!name || !opts.root) {
          console.error("Usage: contextengine profile add <name> --root <dir>");
          process.exitCode = 1;
          return;
        }
        const cfg = upsertProfile(
          {
            name,
            root: path.resolve(opts.root),
            dataDir: opts.dataDir ? path.resolve(opts.dataDir) : undefined,
          },
          opts.file,
        );
        console.log(JSON.stringify(cfg, null, 2));
        return;
      }
      if (action === "use") {
        if (!name) {
          console.error("Usage: contextengine profile use <name>");
          process.exitCode = 1;
          return;
        }
        const cfg = loadProfiles(opts.file);
        if (!cfg.profiles.some((p) => p.name === name)) {
          console.error(`Unknown profile: ${name}`);
          process.exitCode = 1;
          return;
        }
        cfg.default = name;
        saveProfiles(cfg, opts.file);
        const engineCfg = resolveProfile(name, opts.file);
        console.log(
          JSON.stringify({ ok: true, default: name, config: engineCfg }, null, 2),
        );
        return;
      }
      console.error(`Unknown action: ${action}. Use list | add | use`);
      process.exitCode = 1;
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
}

interface SnapshotCliOptions {
  root: string;
  workspaceId?: string;
  store?: string;
}

function requireSnapshotDatabaseUrl(): string {
  const value = resolveDatabaseUrl();
  if (!value) throw new Error("CONTEXTENGINE_DATABASE_URL is required for snapshots");
  return value;
}

function snapshotStore(location: string | undefined, root: string): SnapshotObjectStore {
  const value = location?.trim() || path.join(root, ".contextengine", "snapshots");
  if (!value.startsWith("s3://")) return new FilesystemSnapshotStore(value);
  const parsed = new URL(value);
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Snapshot S3 location must be s3://bucket/prefix");
  }
  return new S3SnapshotStore({
    bucket: parsed.hostname,
    prefix: parsed.pathname.replace(/^\/+|\/+$/g, "") || "contextengine",
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    endpoint: process.env.CONTEXTENGINE_S3_ENDPOINT || process.env.CC_S3_ENDPOINT,
    forcePathStyle: /^(1|true|yes|on)$/i.test(
      process.env.CONTEXTENGINE_S3_FORCE_PATH_STYLE || process.env.CC_S3_FORCE_PATH_STYLE || "",
    ),
    serverSideEncryption: process.env.CONTEXTENGINE_S3_SSE === "aws:kms"
      ? "aws:kms"
      : process.env.CONTEXTENGINE_S3_SSE === "AES256"
        ? "AES256"
        : undefined,
    kmsKeyId: process.env.CONTEXTENGINE_S3_KMS_KEY_ID,
  });
}
