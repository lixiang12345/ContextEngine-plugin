import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextEngine } from "./engine.js";

/** The canonical Augment-compatible name plus the pre-0.4 alias. */
export const CONTEXT_RETRIEVAL_TOOL_NAMES = [
  "codebase-retrieval",
  "codebase_retrieval",
] as const;

export interface RetrievalMcpRuntime {
  /** Resolve an engine that is ready to answer a retrieval request. */
  ensureReady: () => Promise<ContextEngine>;
}

export interface RetrievalToolOptions {
  /** Expose the legacy underscore alias for older MCP clients. */
  includeLegacyAlias?: boolean;
}

const retrievalDescription =
  "PRIMARY tool: retrieve the most relevant code/docs for an information request. Call this BEFORE grepping. Returns the reranked path+line+content evidence pack; max_tokens is an optional caller-controlled output cap.";

const retrievalSchema = {
  information_request: z
    .string()
    .describe(
      "What you need to know — be specific (APIs, symbols, behaviors, files).",
    ),
  top_k: z.number().int().min(1).max(40).optional(),
  max_tokens: z.number().int().min(1).optional(),
};

/**
 * Register the small, stable retrieval surface shared by stdio and remote
 * Streamable HTTP MCP transports. Keeping this in one place prevents the two
 * transports from drifting in parameter names or packing behavior.
 */
export function registerCodebaseRetrievalTools(
  server: McpServer,
  runtime: RetrievalMcpRuntime,
  options: RetrievalToolOptions = {},
): void {
  const retrieveCodebase = async ({
    information_request,
    top_k,
    max_tokens,
  }: {
    information_request: string;
    top_k?: number;
    max_tokens?: number;
  }) => {
    try {
      const engine = await runtime.ensureReady();
      const packed = await engine.codebaseRetrieval(information_request, {
        topK: top_k ?? 14,
        maxTokens: max_tokens,
      });
      return {
        content: [{ type: "text" as const, text: packed.packedText }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  const names = options.includeLegacyAlias === false
    ? [CONTEXT_RETRIEVAL_TOOL_NAMES[0]]
    : CONTEXT_RETRIEVAL_TOOL_NAMES;
  for (const toolName of names) {
    server.tool(toolName, retrievalDescription, retrievalSchema, retrieveCodebase);
  }
}

/** Create a stateless MCP server for a remote retrieval request. */
export function createRetrievalMcpServer(
  runtime: RetrievalMcpRuntime,
  options: RetrievalToolOptions = {},
): McpServer {
  const server = new McpServer({
    name: "contextengine",
    version: "0.4.0",
  });
  registerCodebaseRetrievalTools(server, runtime, options);
  return server;
}
