#!/usr/bin/env node
/**
 * MCP server entry — plug ContextEngine into Claude Code, Cursor, Codex, etc.
 *
 * Claude Code example:
 *   claude mcp add contextengine -- npx -y contextengine-plugin
 *
 * Or after local build:
 *   claude mcp add contextengine -- node /path/to/ContextEngine-plugin/dist/mcp-server.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { loadDotEnv, resolveEngineConfig } from "./config.js";
import { ContextEngine } from "./engine.js";

loadDotEnv();

export interface McpServerOptions {
  root?: string;
  dataDir?: string;
  autoIndex?: boolean;
}

export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const root = path.resolve(
    opts.root ||
      process.env.CONTEXTENGINE_ROOT ||
      process.cwd(),
  );
  const config = resolveEngineConfig({
    root,
    dataDir: opts.dataDir || process.env.CONTEXTENGINE_DATA_DIR,
  });

  let engine = new ContextEngine(config);

  const ensureReady = async (): Promise<ContextEngine> => {
    if (!engine.hasIndex()) {
      if (opts.autoIndex || process.env.CONTEXTENGINE_AUTO_INDEX === "1") {
        await engine.index();
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
    version: "0.3.1",
  });

  server.tool(
    "codebase_search",
    "Hybrid semantic + lexical search over the indexed codebase. Prefer this over blind grep when you need relevant files for a task.",
    {
      query: z.string().describe("Natural language or keyword query"),
      top_k: z.number().int().min(1).max(30).optional().describe("Max results (default 8)"),
      path_prefix: z
        .string()
        .optional()
        .describe("Limit results to this path prefix"),
      mode: z
        .enum(["auto", "bm25", "semantic", "hybrid"])
        .optional()
        .describe("Retrieval mode (default auto)"),
      expand_graph: z
        .boolean()
        .optional()
        .describe("Expand via import/symbol graph (default true)"),
      include_commits: z
        .boolean()
        .optional()
        .describe("Include git commit lineage chunks (default true)"),
    },
    async ({ query, top_k, path_prefix, mode, expand_graph, include_commits }) => {
      try {
        const eng = await ensureReady();
        const hits = await eng.search({
          query,
          topK: top_k ?? 8,
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
          preview: h.preview,
          content: h.chunk.content,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: payload.length, results: payload }, null, 2),
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
    "Pack high-signal codebase context for an engineering task under a token budget. Best first call before editing.",
    {
      task: z.string().describe("What you are trying to implement or fix"),
      top_k: z.number().int().min(1).max(30).optional(),
      max_tokens: z.number().int().min(500).max(50000).optional(),
      path_prefix: z.string().optional(),
    },
    async ({ task, top_k, max_tokens, path_prefix }) => {
      try {
        const eng = await ensureReady();
        const packed = await eng.getTaskContext({
          task,
          topK: top_k ?? 12,
          maxTokens: max_tokens ?? 6000,
          pathPrefix: path_prefix,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: packed.packedText,
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
    "get_file_context",
    "Read a file (or line range) from the workspace with stable path + line metadata.",
    {
      path: z.string().describe("Path relative to workspace root"),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    },
    async ({ path: relPath, start_line, end_line }) => {
      try {
        const eng = await ensureReady();
        const file = eng.getFileContext(relPath, start_line, end_line);
        if (!file) {
          return {
            content: [{ type: "text" as const, text: `File not found or binary: ${relPath}` }],
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
    "Show ContextEngine index statistics for the current workspace.",
    {},
    async () => {
      try {
        if (!engine.hasIndex()) {
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
        const stats = engine.stats();
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
    "Incrementally re-index the workspace. Call after large local changes if search looks stale.",
    {},
    async () => {
      try {
        engine.close();
        engine = new ContextEngine(config);
        const result = await engine.index();
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when executed directly
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
