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
  .version("0.1.0");

program
  .command("index")
  .description("Index a workspace (incremental)")
  .argument("[root]", "workspace root", process.cwd())
  .option("-d, --data-dir <dir>", "index data directory")
  .option("-q, --quiet", "less output")
  .action(async (root: string, opts: { dataDir?: string; quiet?: boolean }) => {
    const config = resolveEngineConfig({
      root: path.resolve(root),
      dataDir: opts.dataDir,
    });
    const engine = new ContextEngine(config);
    if (!opts.quiet) {
      console.log(`Indexing ${config.root}`);
      console.log(`Data dir: ${config.dataDir}`);
      console.log(
        config.embeddings
          ? `Embeddings: ${config.embeddings.model} @ ${config.embeddings.baseUrl}`
          : "Embeddings: off (BM25-only mode — set OPENAI_API_KEY or CONTEXTENGINE_EMBEDDING_API_KEY for semantic search)",
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
  });

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
  .option("--max-tokens <n>", "token budget", "6000")
  .option("--json", "JSON output")
  .action(
    async (
      task: string,
      opts: {
        root: string;
        dataDir?: string;
        topK: string;
        maxTokens: string;
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
        maxTokens: Number(opts.maxTokens) || 6000,
      });
      engine.close();
      if (opts.json) {
        console.log(JSON.stringify(packed, null, 2));
        return;
      }
      console.log(packed.packedText);
      console.error(
        `\n--- ~${packed.estimatedTokens} tokens · ${packed.hits.length} chunks${packed.truncated ? " · truncated" : ""} ---`,
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
