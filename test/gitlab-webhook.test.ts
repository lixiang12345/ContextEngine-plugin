import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { GitLabConnectorClient } from "../src/connectors/gitlab.js";
import { GitLabSourceConnector } from "../src/connectors/gitlab-plugin.js";

const now = 1_700_000_000_000;
const rawKey = randomBytes(32);
const signingToken = `whsec_${rawKey.toString("base64").replace(/=+$/, "")}`;

function payload(after = "d".repeat(40)): Buffer {
  return Buffer.from(JSON.stringify({
    object_kind: "push",
    ref: "refs/heads/main",
    after,
    project: {
      path_with_namespace: "acme/tools",
      default_branch: "main",
    },
  }));
}

function signedRequest(body: Buffer, id = "msg-1", timestamp = String(now / 1000)) {
  const signature = `v1,${createHmac("sha256", rawKey)
    .update(`${id}.${timestamp}.${body.toString("utf8")}`)
    .digest("base64")}`;
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
      "x-gitlab-event": "Push Hook",
    },
  };
}

describe("GitLab connector webhook adapter", () => {
  it("verifies Standard Webhooks HMAC and matches branch/project", () => {
    const connector = new GitLabSourceConnector(
      new GitLabConnectorClient(),
      { signingToken, now: () => now },
    );
    const event = connector.webhook!.verify(signedRequest(payload()));
    assert.deepEqual(event, {
      id: "msg-1",
      externalId: "acme/tools",
      action: "sync",
      metadata: { ref: "refs/heads/main", default_branch: "main" },
    });
    assert.equal(connector.webhook!.matchesConfig(event, { project: "acme/tools", ref: "HEAD" }), true);
    assert.equal(connector.webhook!.matchesConfig(event, { project: "acme/tools", ref: "release" }), false);
    assert.throws(
      () => connector.webhook!.verify({
        ...signedRequest(payload()),
        headers: { ...signedRequest(payload()).headers, "webhook-signature": "v1,bad" },
      }),
      /signature is invalid/,
    );
    assert.throws(
      () => connector.webhook!.verify(signedRequest(payload(), "msg-old", String(now / 1000 - 600))),
      /too old/,
    );
  });

  it("supports legacy X-Gitlab-Token migration and ignores deletes", () => {
    const token = "legacy-gitlab-webhook-token";
    const connector = new GitLabSourceConnector(
      new GitLabConnectorClient(),
      { secretToken: token, now: () => now },
    );
    const request = {
      body: payload(),
      headers: {
        "x-gitlab-token": token,
        "x-gitlab-event": "Push Hook",
        "idempotency-key": "legacy-msg",
      },
    };
    const event = connector.webhook!.verify(request);
    assert.equal(event.id, "legacy-msg");
    assert.equal(event.action, "sync");
    const deleted = connector.webhook!.verify({
      ...request,
      body: payload("0".repeat(40)),
    });
    assert.equal(deleted.action, "ignore");
    assert.throws(
      () => connector.webhook!.verify({ ...request, headers: { ...request.headers, "x-gitlab-token": "wrong" } }),
      /token is invalid/,
    );
  });
});
