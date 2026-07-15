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
});

describe("observability dashboard", () => {
  it("is self-contained and connects only to same-origin APIs", () => {
    const dashboard = observabilityDashboardHtml();
    assert.match(dashboard, /<!doctype html>/i);
    assert.match(dashboard, /ContextEngine/);
    assert.match(dashboard, /\/v1\/observability\/overview/);
    assert.match(dashboard, /Bearer API key/);
    assert.doesNotMatch(dashboard, /<script[^>]+src=/i);
    assert.doesNotMatch(dashboard, /<link[^>]+href=["']https?:/i);

    const inlineScript = dashboard.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
    assert.ok(inlineScript, "dashboard should contain an inline script");
    assert.doesNotThrow(() => new Script(inlineScript));
  });
});
