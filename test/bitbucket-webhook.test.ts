import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { BitbucketConnectorClient } from "../src/connectors/bitbucket.js";
import { BitbucketSourceConnector } from "../src/connectors/bitbucket-plugin.js";

const secret = "bitbucket-webhook-test-secret";

function request(payload: Record<string, unknown>, event = "repo:push") {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    body,
    headers: {
      "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-request-uuid": "request-123",
      "x-event-key": event,
    },
  };
}

describe("Bitbucket connector webhook adapter", () => {
  it("verifies raw-body HMAC and matches pushed branches", () => {
    const connector = new BitbucketSourceConnector(new BitbucketConnectorClient(), secret);
    const event = connector.webhook!.verify(request({
      repository: { full_name: "acme/tools", mainbranch: { name: "main" } },
      push: { changes: [{ new: { type: "branch", name: "main" } }] },
    }));
    assert.equal(event.externalId, "acme/tools");
    assert.equal(event.action, "sync");
    assert.equal(connector.webhook!.matchesConfig(event, {
      workspace: "acme", repository: "tools", ref: "HEAD",
    }), true);
    assert.throws(
      () => connector.webhook!.verify({
        ...request({ repository: { full_name: "acme/tools" } }),
        body: Buffer.from("tampered"),
      }),
      /signature is invalid/,
    );
  });

  it("ignores deletes and non-push events after authentication", () => {
    const connector = new BitbucketSourceConnector(new BitbucketConnectorClient(), secret);
    const deleted = connector.webhook!.verify(request({
      repository: { full_name: "acme/tools", mainbranch: { name: "main" } },
      push: { changes: [{ old: { type: "branch", name: "main" }, new: null }] },
    }));
    assert.equal(deleted.action, "ignore");
    const issue = connector.webhook!.verify(request({ repository: { full_name: "acme/tools" } }, "issue:created"));
    assert.equal(issue.action, "ignore");
  });
});
