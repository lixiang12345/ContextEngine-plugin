import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANONYMOUS_HTTP_PRINCIPAL_ID,
  createHttpAuthenticator,
  LEGACY_HTTP_PRINCIPAL_ID,
  parseBearerAuthorization,
} from "../src/server/http-auth.js";

describe("HTTP Bearer authentication", () => {
  it("maps the legacy API key to an operator principal", () => {
    const authenticator = createHttpAuthenticator({ apiKey: "legacy-secret" });

    assert.deepEqual(authenticator.policy, {
      mode: "bearer",
      authenticationRequired: true,
    });
    assert.deepEqual(
      authenticator.authenticateAuthorization("Bearer legacy-secret"),
      {
        principalId: LEGACY_HTTP_PRINCIPAL_ID,
        role: "operator",
        admin: true,
        authenticationMethod: "bearer",
      },
    );
    assert.equal(authenticator.authenticateAuthorization(undefined), null);
    assert.equal(
      authenticator.authenticateAuthorization("Bearer legacy-secrex"),
      null,
    );
    assert.equal(
      authenticator.authenticateAuthorization("Bearer short"),
      null,
    );
  });

  it("authenticates configured users and operators without exposing tokens", () => {
    const authenticator = createHttpAuthenticator({
      apiKeys: [
        { principalId: " alice ", token: "alice-token" },
        {
          principalId: "ops",
          token: "operator-token",
          role: "operator",
        },
      ],
    });

    const alice = authenticator.authenticateAuthorization("Bearer alice-token");
    const operator = authenticator.authenticateAuthorization(
      "Bearer operator-token",
    );
    assert.deepEqual(alice, {
      principalId: "alice",
      role: "user",
      admin: false,
      authenticationMethod: "bearer",
    });
    assert.deepEqual(operator, {
      principalId: "ops",
      role: "operator",
      admin: true,
      authenticationMethod: "bearer",
    });
    assert.equal(JSON.stringify(alice).includes("alice-token"), false);
    assert.equal(Object.isFrozen(alice), true);

    assert.deepEqual(
      authenticator.authenticate({
        headers: { authorization: "Bearer alice-token" },
      }),
      alice,
    );
  });

  it("supports the explicit admin alias and rejects conflicting roles", () => {
    const authenticator = createHttpAuthenticator({
      apiKeys: [{ principalId: "admin", token: "admin-token", admin: true }],
    });
    assert.equal(
      authenticator.authenticateAuthorization("Bearer admin-token")?.role,
      "operator",
    );

    assert.throws(
      () =>
        createHttpAuthenticator({
          apiKeys: [
            {
              principalId: "conflict",
              token: "conflict-token",
              role: "user",
              admin: true,
            },
          ],
        }),
      /role and admin settings conflict/,
    );
    assert.throws(
      () =>
        createHttpAuthenticator({
          apiKeys: [
            {
              principalId: "invalid-role",
              token: "invalid-role-token",
              role: "root" as "user",
            },
          ],
        }),
      /role is invalid/,
    );
  });

  it("parses one strict, case-insensitive Bearer authorization value", () => {
    assert.equal(parseBearerAuthorization("Bearer abc-._~+/=="), "abc-._~+/==");
    assert.equal(parseBearerAuthorization("bearer token"), "token");
    assert.equal(parseBearerAuthorization("Basic token"), null);
    assert.equal(parseBearerAuthorization("Bearer"), null);
    assert.equal(parseBearerAuthorization("Bearer  token"), null);
    assert.equal(parseBearerAuthorization(" Bearer token"), null);
    assert.equal(parseBearerAuthorization("Bearer token "), null);
    assert.equal(parseBearerAuthorization("Bearer token, Bearer other"), null);
    assert.equal(parseBearerAuthorization(["Bearer token"]), null);
  });

  it("only enables anonymous admin compatibility without configured keys", () => {
    assert.throws(
      () => createHttpAuthenticator({}),
      /At least one HTTP API key is required/,
    );

    const anonymous = createHttpAuthenticator({ allowUnauthenticated: true });
    assert.deepEqual(anonymous.policy, {
      mode: "anonymous-admin",
      authenticationRequired: false,
    });
    assert.deepEqual(anonymous.authenticateAuthorization(undefined), {
      principalId: ANONYMOUS_HTTP_PRINCIPAL_ID,
      role: "operator",
      admin: true,
      authenticationMethod: "anonymous",
    });
    assert.equal(
      anonymous.authenticateAuthorization("Bearer unexpected-token"),
      null,
    );

    const configured = createHttpAuthenticator({
      apiKey: "configured-token",
      allowUnauthenticated: true,
    });
    assert.equal(configured.policy.mode, "bearer");
    assert.equal(configured.authenticateAuthorization(undefined), null);
  });

  it("rejects duplicate principals and tokens without disclosing secrets", () => {
    const secret = "never-print-this-token";
    const invalidConfigurations = [
      () =>
        createHttpAuthenticator({
          apiKeys: [
            { principalId: "same", token: "first-token" },
            { principalId: " same ", token: "second-token" },
          ],
        }),
      () =>
        createHttpAuthenticator({
          apiKeys: [
            { principalId: "first", token: secret },
            { principalId: "second", token: secret },
          ],
        }),
      () =>
        createHttpAuthenticator({
          apiKeys: [{ principalId: "bad", token: "token with spaces" }],
        }),
    ];

    for (const create of invalidConfigurations) {
      assert.throws(create, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
  });
});
