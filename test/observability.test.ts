import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Script } from "node:vm";
import { observabilityDashboardHtml } from "../src/dashboard.js";
import {
  observableRoute,
  RequestTelemetry,
} from "../src/server/request-telemetry.js";

describe("request telemetry", () => {
  it("normalizes identifiers without capturing request payloads", () => {
    assert.equal(
      observableRoute("/v1/workspaces/workspace-secret/search"),
      "/v1/workspaces/{workspaceId}/search",
    );
    assert.equal(
      observableRoute("/v1/index-jobs/job-secret/events"),
      "/v1/index-jobs/{jobId}/events",
    );
    assert.equal(
      observableRoute("/v1/workspaces/workspace-secret/acl/principal-secret"),
      "/v1/workspaces/{workspaceId}/acl/{principalId}",
    );
    assert.equal(
      observableRoute("/v1/workspaces/workspace-secret/sources/source-secret/sync"),
      "/v1/workspaces/{workspaceId}/sources/{sourceId}/sync",
    );
    assert.equal(
      observableRoute(
        "/v1/workspaces/workspace-secret/sources/private-provider",
        "POST",
      ),
      "/v1/workspaces/{workspaceId}/sources/{provider}",
    );
    assert.equal(
      observableRoute("/webhooks/private-provider", "POST"),
      "/webhooks/{provider}",
    );
    assert.equal(
      observableRoute(
        "/v1/workspaces/workspace-secret/source-acl/principal-secret",
      ),
      "/v1/workspaces/{workspaceId}/source-acl/{principalId}",
    );

    const telemetry = new RequestTelemetry();
    const searchTiming = telemetry.begin();
    searchTiming.startedAtMs -= 25;
    telemetry.complete(
      "POST",
      "/v1/workspaces/workspace-secret/search",
      200,
      searchTiming,
    );
    const failedTiming = telemetry.begin();
    failedTiming.startedAtMs -= 10;
    telemetry.complete(
      "POST",
      "/v1/workspaces/workspace-secret/context",
      500,
      failedTiming,
    );

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.active, 0);
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.errors, 1);
    assert.equal(
      snapshot.recent[0].route,
      "/v1/workspaces/{workspaceId}/context",
    );
    assert.equal("query" in snapshot.recent[0], false);
    assert.equal("body" in snapshot.recent[0], false);
    assert.ok(snapshot.p95Ms >= 10);
  });

  it("collapses unknown paths and methods into bounded route labels", () => {
    assert.equal(observableRoute("/attacker/unique-path-1"), "/{unmatched}");
    assert.equal(observableRoute("/attacker/unique-path-2"), "/{unmatched}");
    assert.equal(observableRoute("/health"), "/health");
    assert.equal(observableRoute("/dashboard"), "/dashboard");
    assert.equal(
      observableRoute("/v1/observability/overview"),
      "/v1/observability/overview",
    );
    assert.equal(
      observableRoute(
        "/v1/workspaces/workspace-a/snapshots/main/replication-schedules/region-backup",
      ),
      "/v1/workspaces/{workspaceId}/snapshots/{name}/replication-schedules/{targetId}",
    );
    assert.equal(
      observableRoute(
        "/v1/workspaces/workspace-a/snapshot-jobs/job-a/events",
      ),
      "/v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}/events",
    );
    assert.equal(
      observableRoute(
        "/v1/workspaces/workspace-a/snapshot-jobs/job-a/attempts",
      ),
      "/v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}/attempts",
    );

    const telemetry = new RequestTelemetry();
    for (let index = 0; index < 250; index++) {
      const timing = telemetry.begin();
      telemetry.complete(
        index % 2 ? `CUSTOM-${index}` : "GET",
        `/missing/${index}`,
        404,
        timing,
      );
    }

    const snapshot = telemetry.snapshot();
    assert.deepEqual(
      snapshot.routes.map(({ method, route }) => ({ method, route })),
      [
        { method: "GET", route: "/{unmatched}" },
        { method: "OTHER", route: "/{unmatched}" },
      ],
    );
    assert.equal(snapshot.routes[0].requests, 125);
    assert.equal(snapshot.routes[1].requests, 125);
  });
});

describe("observability dashboard", () => {
  it("is self-contained and connects only to same-origin APIs", () => {
    const dashboard = observabilityDashboardHtml();
    assert.match(dashboard, /<!doctype html>/i);
    assert.match(dashboard, /ContextEngine/);
    assert.match(dashboard, /\/v1\/observability\/overview/);
    assert.match(dashboard, /Bearer API key/);
    assert.match(dashboard, /aria-label="Embedding base URL"/);
    assert.match(dashboard, /aria-label="Reranker base URL"/);
    assert.match(dashboard, /aria-label=\\"Copy location /);
    // Retrieval probe can pack context and render the reproducible trace.
    assert.match(dashboard, /id="probeView"/);
    assert.match(dashboard, /\/context/);
    assert.match(dashboard, /packing: view/);
    assert.match(dashboard, /function renderTrace/);
    // Ranked hits show a per-channel score breakdown (keyword/semantic/etc).
    assert.match(dashboard, /function renderChannels/);
    assert.match(dashboard, /channel-chips/);
    // Packed views accept a token budget and render a fill gauge against it.
    assert.match(dashboard, /id="probeMaxTokens"/);
    assert.match(dashboard, /budget-track/);
    // Workspace rules grounded into the pack are surfaced in the trace panel.
    assert.match(dashboard, /var ruleChips/);
    assert.doesNotMatch(dashboard, /<script[^>]+src=/i);
    assert.doesNotMatch(dashboard, /<link[^>]+href=["']https?:/i);

    const inlineScript = dashboard.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
    assert.ok(inlineScript, "dashboard should contain an inline script");
    assert.doesNotThrow(() => new Script(inlineScript));
  });
});
