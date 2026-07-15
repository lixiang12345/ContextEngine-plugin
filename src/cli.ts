#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadDotEnv, resolveEngineConfig } from "./config.js";
import { ContextEngine } from "./engine.js";

loadDotEnv();

const program = new Command();

program
  .name("contextengine")
  .description(
    "Portable Context Engine for AI coding agents — index, search, and pack codebase context.",
  )
  .version("0.4.0");

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
      console.log(`Data dir: ${config.dataDir}`);
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
    engine.close();
    if (!opts.quiet) process.stdout.write("\n");
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result,
          db: config.dataDir + "/index.db",
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
      engine.close();
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
  .option("--max-tokens <n>", "explicit retrieval token budget")
  .option(
    "--context-window-tokens <n>",
    "model context window used for automatic retrieval sizing",
  )
  .option(
    "--reserved-output-tokens <n>",
    "model output tokens reserved outside the input budget",
  )
  .option("--json", "JSON output")
  .action(
    async (
      task: string,
      opts: {
        root: string;
        dataDir?: string;
        topK: string;
        maxTokens?: string;
        contextWindowTokens?: string;
        reservedOutputTokens?: string;
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
        contextWindowTokens: optionalPositiveInteger(
          opts.contextWindowTokens,
        ),
        reservedOutputTokens: optionalPositiveInteger(
          opts.reservedOutputTokens,
        ),
      });
      engine.close();
      if (opts.json) {
        console.log(JSON.stringify(packed, null, 2));
        return;
      }
      console.log(packed.packedText);
      console.error(
        `\n--- ~${packed.estimatedTokens}/${packed.budget.maxTokens} tokens · ${packed.hits.length} chunks · ${packed.budget.contextWindowTokens} context${packed.truncated ? " · truncated" : ""} ---`,
      );
    },
  );

program
  .command("status")
  .description("Show index status")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .action((opts: { root: string; dataDir?: string }) => {
    const engine = ContextEngine.open({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    if (!engine.hasIndex()) {
      console.log(
        JSON.stringify(
          { ok: false, error: "no index", hint: "run contextengine index" },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const stats = engine.stats();
    engine.close();
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
      console.log(`Data dir: ${config.dataDir}`);
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
        handle.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  );

program
  .command("export-index")
  .description("Export the SQLite index to a portable file (for backup/team share)")
  .argument("<dest>", "destination path (e.g. ./index-share.db)")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .action(async (dest: string, opts: { root: string; dataDir?: string }) => {
    const config = resolveEngineConfig({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    const { exportIndex } = await import("./store/export-import.js");
    const dbPath = path.join(config.dataDir, "index.db");
    const result = exportIndex(dbPath, path.resolve(dest));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("import-index")
  .description("Import a shared SQLite index into the workspace data dir")
  .argument("<source>", "source index.db path")
  .option("-r, --root <dir>", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .action(async (source: string, opts: { root: string; dataDir?: string }) => {
    const config = resolveEngineConfig({
      root: path.resolve(opts.root),
      dataDir: opts.dataDir,
    });
    const { importIndex } = await import("./store/export-import.js");
    const result = importIndex(path.resolve(source), config.dataDir);
    console.log(JSON.stringify(result, null, 2));
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
      if (opts.reindex || !engine.hasIndex()) {
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
      engine.close();
      console.log(JSON.stringify(report, null, 2));
      if (report.failed > 0) process.exitCode = 1;
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
