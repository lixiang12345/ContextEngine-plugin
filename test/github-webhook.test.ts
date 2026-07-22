import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { GitHubConnectorClient } from "../src/connectors/github.js";
import { GitHubSourceConnector } from "../src/connectors/github-plugin.js";

const secret = "github-webhook-test-secret";

function signedRequest(payload: Record<string, unknown>, overrides: Record<string, string> = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    body,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-github-delivery": "delivery-123",
      "x-github-event": "push",
      ...overrides,
    },
  };
}

describe("GitHub connector webhook adapter", () => {
  const connector = new GitHubSourceConnector(new GitHubConnectorClient(), secret);

  it("verifies HMAC before parsing and matches only the configured branch", () => {
    const request = signedRequest({
      ref: "refs/heads/main",
      deleted: false,
      repository: {
        full_name: "acme/payments",
        default_branch: "main",
      },
    });
    const event = connector.webhook!.verify(request);
    assert.deepEqual(event, {
      id: "delivery-123",
      externalId: "acme/payments",
      action: "sync",
      metadata: { ref: "refs/heads/main", default_branch: "main" },
    });
    assert.equal(
      connector.webhook!.matchesConfig(event, {
        owner: "acme",
        repository: "payments",
        ref: "HEAD",
      }),
      true,
    );
    assert.equal(
      connector.webhook!.matchesConfig(event, {
        owner: "acme",
        repository: "payments",
        ref: "release",
      }),
      false,
    );

    assert.throws(
      () => connector.webhook!.verify({
        body: Buffer.from("not-json"),
        headers: { ...request.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      }),
      /signature is invalid/,
    );
  });

  it("ignores non-push and deleted-ref deliveries after authenticating them", () => {
    const ping = connector.webhook!.verify(signedRequest({
      repository: { full_name: "acme/payments", default_branch: "main" },
    }, { "x-github-event": "ping" }));
    assert.equal(ping.action, "ignore");

    const deleted = connector.webhook!.verify(signedRequest({
      ref: "refs/heads/main",
      deleted: true,
      repository: { full_name: "acme/payments", default_branch: "main" },
    }));
    assert.equal(deleted.action, "ignore");
  });

  it("does not expose a webhook endpoint when no secret is configured", () => {
    assert.equal(
      new GitHubSourceConnector(new GitHubConnectorClient()).webhook,
      undefined,
    );
  });
});
