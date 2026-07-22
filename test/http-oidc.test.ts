import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
} from "node:crypto";
import { after, before, describe, it } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "pg";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";

const databaseUrl =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ??
  process.env.CONTEXTENGINE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const ISSUER = "https://identity.example.com/realms/acme";
const AUDIENCE = "contextengine-api";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres("OIDC HTTP and MCP identity integration", () => {
  const schema = `ce_oidc_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk: JsonWebKey = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "integration-key",
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
  let handle: HttpServerHandle;
  let workspaceId = "";

  function token(
    subject: string,
    claims: Record<string, unknown> = {},
  ): string {
    const encodedHeader = Buffer.from(JSON.stringify({
      alg: "RS256",
      kid: jwk.kid,
      typ: "at+jwt",
    })).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const encodedClaims = Buffer.from(JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: subject,
      iat: now - 5,
      exp: now + 300,
      ...claims,
    })).toString("base64url");
    const input = `${encodedHeader}.${encodedClaims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
  }

  function request(
    bearer: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...init.headers,
      },
    });
  }

  before(async () => {
    await adminDatabase.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: databaseUrlForSchema(databaseUrl!, schema),
      disableEmbeddings: true,
      mcpSessionStore: "memory",
      oidc: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: "https://identity.example.com/jwks.json",
        operatorGroups: ["contextengine-operators"],
        fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch,
      },
    });
  });

  after(async () => {
    if (handle) {
      if (workspaceId) {
        await request(
          token("operator", { groups: ["contextengine-operators"] }),
          `/v1/workspaces/${workspaceId}`,
          { method: "DELETE" },
        );
      }
      await handle.close();
    }
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await adminDatabase.end();
  });

  it("enables ACLs and keeps HTTP/MCP access stable across token rotation", async () => {
    const alice = token("alice", { nonce: "first" });
    const capabilities = await request(alice, "/v1/capabilities");
    assert.equal(capabilities.status, 200);
    const capabilityPayload = await capabilities.json() as {
      authorization: {
        workspace_acl: boolean;
        current_principal: {
          principal_id: string;
          role: string;
          authentication_method: string;
        };
      };
    };
    assert.equal(capabilityPayload.authorization.workspace_acl, true);
    assert.deepEqual(capabilityPayload.authorization.current_principal, {
      principal_id: capabilityPayload.authorization.current_principal.principal_id,
      role: "user",
      authentication_method: "oidc",
    });

    const created = await request(alice, "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "oidc-private", source_mode: "blob" }),
    });
    assert.equal(created.status, 201);
    workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    const bobDenied = await request(token("bob"), `/v1/workspaces/${workspaceId}`);
    assert.equal(bobDenied.status, 404);
    const rotatedAlice = token("alice", { nonce: "rotated" });
    assert.equal(
      (await request(rotatedAlice, `/v1/workspaces/${workspaceId}`)).status,
      200,
    );
    assert.equal(
      (await request(
        token("operator", { groups: ["contextengine-operators"] }),
        `/v1/workspaces/${workspaceId}`,
      )).status,
      200,
    );

    const initialize = await request(alice, `/v1/workspaces/${workspaceId}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "oidc-integration-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const resumed = await request(
      rotatedAlice,
      `/v1/workspaces/${workspaceId}/mcp`,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      },
    );
    assert.equal(resumed.status, 200);

    const invalid = await request("not-a-jwt", "/v1/capabilities");
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("www-authenticate"), "Bearer");
  });
});
