#!/usr/bin/env node
/**
 * MCP server — Augment-class context tools for any coding agent.
 *
 *   claude mcp add contextengine -- node /path/to/dist/mcp-server.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { loadDotEnv, resolveEngineConfig } from "./config.js";
import { ContextEngine } from "./engine.js";
import { registerCodebaseRetrievalTools } from "./mcp-tools.js";
import {
  indexWorkspace,
  parseExtraRootsFromEnv,
  type IndexResult,
} from "./indexer/indexer.js";
import { watchAndIndex, type WatchHandle } from "./indexer/watch.js";

loadDotEnv();

export interface McpServerOptions {
  root?: string;
  dataDir?: string;
  autoIndex?: boolean;
  /** Override CONTEXTENGINE_MCP_WATCH (enabled by default). */
  watch?: boolean;
  watchDebounceMs?: number;
}

export interface McpServerHandle {
  close: () => Promise<void>;
}

export { CONTEXT_RETRIEVAL_TOOL_NAMES } from "./mcp-tools.js";

export function isMcpWatchEnabled(value = process.env.CONTEXTENGINE_MCP_WATCH): boolean {
  if (value === undefined) return true;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

export async function startMcpServer(
  opts: McpServerOptions = {},
): Promise<McpServerHandle> {
  const root = path.resolve(
    opts.root || process.env.CONTEXTENGINE_ROOT || process.cwd(),
  );
  const config = resolveEngineConfig({
    root,
    dataDir: opts.dataDir || process.env.CONTEXTENGINE_DATA_DIR,
    extraRoots: parseExtraRootsFromEnv(),
  });

  const engine = new ContextEngine(config);

  // The watcher and MCP requests share this single-flight index operation. It
  // prevents the initial watcher pass and the first tool call from rebuilding
  // the same workspace concurrently, while refreshing the live searcher after
  // every completed incremental index.
  let indexing: Promise<IndexResult> | null = null;
  const runIndex = (): Promise<IndexResult> => {
    if (!indexing) {
      indexing = (async () => {
        const result = await indexWorkspace(config);
        await engine.refresh();
        return result;
      })().finally(() => {
        indexing = null;
      });
    }
    return indexing;
  };

  const watchEnabled = opts.watch ?? isMcpWatchEnabled();
  let watcher: WatchHandle | null = null;

  const ensureReady = async (): Promise<ContextEngine> => {
    // When the embedded watcher is enabled, its initial pass owns startup
    // indexing. Awaiting ready here avoids a second concurrent build.
    if (watcher) await watcher.ready;
    if (!(await engine.hasIndex())) {
      if (opts.autoIndex || process.env.CONTEXTENGINE_AUTO_INDEX === "1") {
        await runIndex();
      } else {
        throw new Error(
          `No index for ${config.root}. Run \`contextengine index\` or set CONTEXTENGINE_AUTO_INDEX=1.`,
        );
      }
    }
    return engine;
  };

  const server = new McpServer({
    name: "contextengine",
    version: "0.4.0",
  });

  registerCodebaseRetrievalTools(server, { ensureReady });

  server.tool(
    "codebase_search",
    "Structured hybrid search returning ranked JSON hits (path, lines, symbol, scores, channels). Prefer codebase-retrieval for agent editing workflows.",
    {
      query: z.string().describe("Natural language or keyword query"),
      top_k: z.number().int().min(1).max(40).optional(),
      path_prefix: z.string().optional(),
      mode: z.enum(["auto", "bm25", "semantic", "hybrid"]).optional(),
      expand_graph: z.boolean().optional(),
      include_commits: z.boolean().optional(),
    },
    async ({ query, top_k, path_prefix, mode, expand_graph, include_commits }) => {
      try {
        const eng = await ensureReady();
        const hits = await eng.search({
          query,
          topK: top_k ?? 10,
          pathPrefix: path_prefix,
          mode: mode ?? "auto",
          expandGraph: expand_graph,
          includeCommits: include_commits,
        });
        const payload = hits.map((h) => ({
          path: h.chunk.path,
          startLine: h.chunk.startLine,
          endLine: h.chunk.endLine,
          symbol: h.chunk.symbol,
          language: h.chunk.language,
          score: Number(h.score.toFixed(6)),
          source: h.source,
          intent: h.intent,
          channels: h.channels,
          degradedChannels: h.degradedChannels,
          preview: h.preview,
          content: h.chunk.content,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: payload.length,
                  degraded_channels: [
                    ...new Set(payload.flatMap((item) => item.degradedChannels ?? [])),
                  ],
                  results: payload,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_task_context",
    "Pack task-oriented context (task-oriented companion to codebase-retrieval).",
    {
      task: z.string(),
      top_k: z.number().int().min(1).max(40).optional(),
      max_tokens: z.number().int().min(1).optional(),
      path_prefix: z.string().optional(),
    },
    async ({ task, top_k, max_tokens, path_prefix }) => {
      try {
        const eng = await ensureReady();
        const packed = await eng.getTaskContext({
          task,
          topK: top_k ?? 12,
          maxTokens: max_tokens,
          pathPrefix: path_prefix,
        });
        return {
          content: [{ type: "text" as const, text: packed.packedText }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_file_context",
    "Read a file (or line range) from the workspace. Paths may be multi-root prefixed (e.g. main/src/x.ts).",
    {
      path: z.string(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    },
    async ({ path: relPath, start_line, end_line }) => {
      try {
        const eng = await ensureReady();
        const file = eng.getFileContext(relPath, start_line, end_line);
        if (!file) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File not found or binary: ${relPath}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${file.path}:${file.startLine}-${file.endLine}\n\n${file.content}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "index_status",
    "Show ContextEngine index statistics (chunks, FTS, embeddings).",
    {},
    async () => {
      try {
        if (!(await engine.hasIndex())) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    root: config.root,
                    indexed: false,
                    hint: "Run contextengine index or call reindex_workspace",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const stats = await engine.stats();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, indexed: true, ...stats }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "reindex_workspace",
    "Incrementally re-index all configured roots (code + extra docs/repos).",
    {},
    async () => {
      try {
        const result = watcher ? await watcher.reindex() : await runIndex();
        if (!result) throw new Error("Indexing was cancelled before completion");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, ...result }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  if (watchEnabled) {
    watcher = watchAndIndex(config, {
      debounceMs: opts.watchDebounceMs,
      runIndex: async () => runIndex(),
      onError: (error) => {
        console.error(
          "[mcp watch error]",
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  }

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error) {
    await watcher?.close();
    await engine.close();
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const cleanupOnce = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await watcher?.close();
        if (indexing) {
          try {
            await indexing;
          } catch {
            // The original index error has already been reported to the caller.
          }
        }
        await engine.close();
      })();
    }
    return cleanupPromise;
  };
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await server.close();
        } finally {
          await cleanupOnce();
        }
      })();
    }
    return closePromise;
  };

  const removeLifecycleListeners = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onInputEnd);
    process.stdin.off("close", onInputEnd);
  };
  const onSignal = (): void => {
    void close().finally(() => {
      removeLifecycleListeners();
      process.exitCode = 0;
    });
  };
  const onInputEnd = (): void => {
    void close().finally(removeLifecycleListeners);
  };
  server.server.onclose = () => {
    void cleanupOnce();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onInputEnd);
  process.stdin.once("close", onInputEnd);

  return { close };
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-server.ts") ||
    process.argv[1].endsWith("mcp-server.js") ||
    process.argv[1].includes("contextengine-mcp"));

if (isDirect) {
  startMcpServer({
    autoIndex: process.env.CONTEXTENGINE_AUTO_INDEX === "1",
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
