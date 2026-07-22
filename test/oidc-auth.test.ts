import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { describe, it } from "node:test";
import { createHttpAuthenticator } from "../src/server/http-auth.js";
import { OidcJwtAuthenticator } from "../src/server/oidc-auth.js";

const ISSUER = "https://identity.example.com/tenant";
const AUDIENCE = "contextengine-api";
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
}

function signingKey(kid: string): SigningKey {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function jwt(
  key: SigningKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = Buffer.from(JSON.stringify({
    alg: "RS256",
    kid: key.kid,
    typ: "at+jwt",
    ...header,
  })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-123",
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 300,
    ...claims,
  })).toString("base64url");
  const input = `${encodedHeader}.${encodedClaims}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

function jwksFetch(keys: readonly JsonWebKey[]): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ keys }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
}

function verifier(
  key: SigningKey,
  overrides: Partial<ConstructorParameters<typeof OidcJwtAuthenticator>[0]> = {},
): OidcJwtAuthenticator {
  return new OidcJwtAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: "https://identity.example.com/jwks.json",
    fetch: jwksFetch([key.jwk]),
    now: () => NOW_MS,
    ...overrides,
  });
}

describe("OIDC JWT authentication", () => {
  it("coexists with API keys and derives a stable issuer+subject principal", async () => {
    const key = signingKey("primary");
    const authenticator = createHttpAuthenticator({
      apiKeys: [{ principalId: "automation", token: "api-secret" }],
      oidc: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: "https://identity.example.com/jwks.json",
        fetch: jwksFetch([key.jwk]),
        now: () => NOW_MS,
      },
    });

    assert.equal(
      (await authenticator.authenticateAuthorization("Bearer api-secret"))?.principalId,
      "automation",
    );
    const first = await authenticator.authenticateAuthorization(
      `Bearer ${jwt(key, { role: "operator", admin: true })}`,
    );
    const rotatedToken = await authenticator.authenticateAuthorization(
      `Bearer ${jwt(key, { iat: NOW_SECONDS, nonce: "new-access-token" })}`,
    );
    assert.deepEqual(first, {
      principalId: first?.principalId,
      role: "user",
      admin: false,
      authenticationMethod: "oidc",
    });
    assert.match(first?.principalId ?? "", /^oidc:[A-Za-z0-9_-]{43}$/);
    assert.equal(rotatedToken?.principalId, first?.principalId);
    assert.equal(JSON.stringify(first).includes("user-123"), false);
  });

  it("grants operator only through an explicit configured group mapping", async () => {
    const key = signingKey("groups");
    const auth = verifier(key, {
      groupsClaim: "team_memberships",
      operatorGroups: ["contextengine-operators"],
    });

    assert.equal(
      (await auth.authenticateToken(jwt(key, {
        team_memberships: ["developers", "contextengine-operators"],
      })))?.role,
      "operator",
    );
    assert.equal(
      (await auth.authenticateToken(jwt(key, {
        groups: ["contextengine-operators"],
        team_memberships: ["developers"],
        role: "operator",
      })))?.role,
      "user",
    );
  });

  it("fails closed for invalid claims, signatures and algorithms", async () => {
    const key = signingKey("strict");
    const attacker = signingKey("attacker");
    const auth = verifier(key);
    const rejected = [
      jwt(key, { iss: "https://attacker.example.com" }),
      jwt(key, { aud: "some-other-api" }),
      jwt(key, { exp: NOW_SECONDS - 31 }),
      jwt(key, { nbf: NOW_SECONDS + 31 }),
      jwt(key, { iat: NOW_SECONDS + 31 }),
      jwt(key, { sub: "" }),
      jwt(attacker, {}, { kid: key.kid }),
      jwt(key, {}, { alg: "none" }),
    ];
    for (const token of rejected) {
      assert.equal(await auth.authenticateToken(token), null);
    }
  });

  it("refreshes JWKS once when a provider rotates to an unknown kid", async () => {
    const first = signingKey("old-key");
    const second = signingKey("new-key");
    let published: readonly JsonWebKey[] = [first.jwk];
    let requests = 0;
    const auth = verifier(first, {
      fetch: (async () => {
        requests += 1;
        return new Response(JSON.stringify({ keys: published }));
      }) as typeof fetch,
    });

    assert.ok(await auth.authenticateToken(jwt(first)));
    published = [second.jwk];
    assert.ok(await auth.authenticateToken(jwt(second)));
    assert.equal(requests, 2);

    assert.equal(await auth.authenticateToken(jwt(signingKey("unknown"))), null);
    assert.equal(requests, 2, "unknown-kid refreshes are rate limited");
  });

  it("supports explicitly enabled PSS and ECDSA access-token profiles", async () => {
    const cases = [
      {
        algorithm: "PS256" as const,
        pair: generateKeyPairSync("rsa", { modulusLength: 2048 }),
        signOptions: (privateKey: KeyObject) => ({
          key: privateKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        }),
      },
      {
        algorithm: "ES256" as const,
        pair: generateKeyPairSync("ec", { namedCurve: "P-256" }),
        signOptions: (privateKey: KeyObject) => ({
          key: privateKey,
          dsaEncoding: "ieee-p1363" as const,
        }),
      },
    ];
    for (const item of cases) {
      const encodedHeader = Buffer.from(JSON.stringify({
        alg: item.algorithm,
        kid: item.algorithm,
        typ: "at+jwt",
      })).toString("base64url");
      const encodedClaims = Buffer.from(JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: `${item.algorithm}-subject`,
        iat: NOW_SECONDS - 10,
        exp: NOW_SECONDS + 60,
      })).toString("base64url");
      const input = `${encodedHeader}.${encodedClaims}`;
      const token = `${input}.${sign(
        "sha256",
        Buffer.from(input),
        item.signOptions(item.pair.privateKey),
      ).toString("base64url")}`;
      const publicJwk: JsonWebKey = {
        ...item.pair.publicKey.export({ format: "jwk" }),
        kid: item.algorithm,
        alg: item.algorithm,
        use: "sig",
        key_ops: ["verify"],
      };
      const auth = new OidcJwtAuthenticator({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: "https://identity.example.com/jwks.json",
        allowedAlgorithms: [item.algorithm],
        now: () => NOW_MS,
        fetch: jwksFetch([publicJwk]),
      });
      assert.equal((await auth.authenticateToken(token))?.role, "user");
    }
  });

  it("validates discovered issuer and JWKS endpoint before using keys", async () => {
    const key = signingKey("discovered");
    const urls: string[] = [];
    const auth = new OidcJwtAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW_MS,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("openid-configuration")) {
          return new Response(JSON.stringify({
            issuer: ISSUER,
            jwks_uri: "https://keys.example.net/contextengine.json",
          }));
        }
        return new Response(JSON.stringify({ keys: [key.jwk] }));
      }) as typeof fetch,
    });

    assert.ok(await auth.authenticateToken(jwt(key)));
    assert.deepEqual(urls, [
      "https://identity.example.com/.well-known/openid-configuration/tenant",
      "https://keys.example.net/contextengine.json",
    ]);

    const mismatch = new OidcJwtAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW_MS,
      fetch: (async () => new Response(JSON.stringify({
        issuer: "https://identity.example.com/other-tenant",
        jwks_uri: "https://identity.example.com/jwks.json",
      }))) as typeof fetch,
    });
    assert.equal(await mismatch.authenticateToken(jwt(key)), null);
  });

  it("rejects insecure endpoints and unsupported configuration", () => {
    const key = signingKey("config");
    assert.throws(
      () => verifier(key, { issuer: "http://identity.example.com" }),
      /HTTPS URL/,
    );
    assert.throws(
      () => verifier(key, { allowedAlgorithms: ["none" as "RS256"] }),
      /Unsupported OIDC algorithm/,
    );
    assert.throws(
      () => verifier(key, { audience: [] }),
      /at least one value/,
    );
  });
});
