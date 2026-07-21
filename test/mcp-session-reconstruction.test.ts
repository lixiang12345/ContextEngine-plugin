import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

interface DurableSessionMetadata {
  protocolVersion: string;
  status: "active" | "closed";
}

const sessions = new Map<string, DurableSessionMetadata>();
const mcpHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function createSpikeMcpServer(instance: string): McpServer {
  const server = new McpServer({ name: "mcp-reconstruction-spike", version: "1.0.0" });
  server.tool("codebase-retrieval", "Return deterministic spike evidence.", {
    information_request: z.string(),
  }, async ({ information_request }) => ({
    content: [{ type: "text" as const, text: `${instance}:${information_request}` }],
  }));
  return server;
}

async function handleWithFreshTransport(
  instance: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createSpikeMcpServer(instance);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function startSpikeInstance(instance: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const sessionId = request.headers["mcp-session-id"] as string | undefined;

      if (request.method === "GET") {
        response.setHeader("allow", "POST, DELETE");
        jsonError(response, 405, "SSE is unavailable for reconstructed sessions");
        return;
      }

      if (request.method === "DELETE") {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session || session.status === "closed") {
          response.writeHead(204).end();
          return;
        }
        session.status = "closed";
        response.writeHead(204).end();
        return;
      }

      if (request.method !== "POST") {
        jsonError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJson(request);
      if (isInitializeRequest(body)) {
        if (sessionId) {
          jsonError(response, 400, "Initialize must not include a session id");
          return;
        }
        const mcpServer = createSpikeMcpServer(instance);
        let initializedSessionId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            initializedSessionId = newSessionId;
          },
        });
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, body);
          const requested = body.params.protocolVersion;
          sessions.set(initializedSessionId!, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
            status: "active",
          });
        } finally {
          await transport.close().catch(() => undefined);
          await mcpServer.close().catch(() => undefined);
        }
        return;
      }

      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session || session.status !== "active") {
        jsonError(response, 404, "Session not found");
        return;
      }
      const protocolVersion = request.headers["mcp-protocol-version"];
      if (protocolVersion && protocolVersion !== session.protocolVersion) {
        jsonError(response, 400, "Protocol version does not match the initialized session");
        return;
      }
      await handleWithFreshTransport(instance, request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        jsonError(response, 500, error instanceof Error ? error.message : String(error));
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

describe("reconstructable MCP session protocol spike", () => {
  let first: Awaited<ReturnType<typeof startSpikeInstance>>;
  let second: Awaited<ReturnType<typeof startSpikeInstance>>;

  before(async () => {
    sessions.clear();
    first = await startSpikeInstance("instance-a");
    second = await startSpikeInstance("instance-b");
  });

  after(async () => {
    first.server.close();
    second.server.close();
    await Promise.all([once(first.server, "close"), once(second.server, "close")]);
  });

  it("rebuilds JSON request handling on another instance from durable metadata", async () => {
    const initialized = await fetch(first.url, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "reconstruction-spike", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const initializedPayload = await initialized.json() as {
      result?: { protocolVersion?: string };
    };
    const protocolVersion = initializedPayload.result?.protocolVersion;
    assert.ok(protocolVersion);

    const notification = await fetch(second.url, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notification.status, 202);

    const listed = await fetch(second.url, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(listed.status, 200);
    const listedPayload = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
    assert.deepEqual(listedPayload.result?.tools?.map((tool) => tool.name), [
      "codebase-retrieval",
    ]);

    const called = await fetch(second.url, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codebase-retrieval",
          arguments: { information_request: "find the authorization boundary" },
        },
      }),
    });
    assert.equal(called.status, 200);
    const calledPayload = await called.json() as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(
      calledPayload.result?.content?.[0]?.text,
      "instance-b:find the authorization boundary",
    );

    const getStream = await fetch(second.url, {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
    });
    assert.equal(getStream.status, 405);

    const closed = await fetch(second.url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(closed.status, 204);
    const closedAgain = await fetch(first.url, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(closedAgain.status, 204);

    const afterClose = await fetch(first.url, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    assert.equal(afterClose.status, 404);
  });
});
