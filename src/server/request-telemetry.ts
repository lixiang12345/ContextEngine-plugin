export interface RequestObservation {
  id: number;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  startedAt: string;
}

export interface RouteObservation {
  method: string;
  route: string;
  requests: number;
  errors: number;
  averageMs: number;
  p95Ms: number;
}

export interface RequestTelemetrySnapshot {
  active: number;
  total: number;
  errors: number;
  errorRate: number;
  averageMs: number;
  p95Ms: number;
  routes: RouteObservation[];
  recent: RequestObservation[];
}

interface RouteAccumulator {
  method: string;
  route: string;
  requests: number;
  errors: number;
  durations: number[];
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return rounded(sorted[index]);
}

const STATIC_ROUTES = new Set([
  "/",
  "/dashboard",
  "/favicon.ico",
  "/health",
  "/openapi.json",
  "/docs",
  "/v1/capabilities",
  "/v1/observability/overview",
  "/v1/observability/configuration",
  "/v1/observability/configuration/test",
  "/v1/workspaces",
  "/v1/blobs:batch",
]);

const OBSERVABLE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function observableRoute(pathname: string, method?: string): string {
  if (/^\/webhooks\/[^/]+$/.test(pathname)) {
    return "/webhooks/{provider}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/sync\/plan$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/sync/plan";
  }
  if (/^\/v1\/workspaces\/[^/]+\/sync\/commit$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/sync/commit";
  }
  if (/^\/v1\/workspaces\/[^/]+\/acl$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/acl";
  }
  if (/^\/v1\/workspaces\/[^/]+\/acl\/[^/]+$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/acl/{principalId}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/source-acl$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/source-acl";
  }
  if (/^\/v1\/workspaces\/[^/]+\/source-acl\/[^/]+$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/source-acl/{principalId}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/sources$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/sources";
  }
  if (/^\/v1\/workspaces\/[^/]+\/sources\/[^/]+\/sync$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/sources/{sourceId}/sync";
  }
  if (/^\/v1\/workspaces\/[^/]+\/sources\/[^/]+$/.test(pathname)) {
    return method?.toUpperCase() === "POST"
      ? "/v1/workspaces/{workspaceId}/sources/{provider}"
      : "/v1/workspaces/{workspaceId}/sources/{sourceId}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/index-jobs$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/index-jobs";
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshots$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/snapshots";
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshots:(prune|gc)$/.test(pathname)) {
    return pathname.replace(
      /^\/v1\/workspaces\/[^/]+/,
      "/v1/workspaces/{workspaceId}",
    );
  }
  if (
    /^\/v1\/workspaces\/[^/]+\/snapshots\/[^/]+\/replication-schedules\/[^/]+$/.test(
      pathname,
    )
  ) {
    return "/v1/workspaces/{workspaceId}/snapshots/{name}/replication-schedules/{targetId}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshots\/[^/]+\/(import|replicate)$/.test(pathname)) {
    return pathname
      .replace(/^\/v1\/workspaces\/[^/]+/, "/v1/workspaces/{workspaceId}")
      .replace(/\/snapshots\/[^/]+\//, "/snapshots/{name}/");
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshots\/[^/]+$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/snapshots/{name}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshot-replication-targets$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/snapshot-replication-targets";
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshot-replication-schedules$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/snapshot-replication-schedules";
  }
  if (
    /^\/v1\/workspaces\/[^/]+\/snapshot-jobs\/[^/]+\/(attempts|events|retry)$/.test(
      pathname,
    )
  ) {
    return pathname
      .replace(/^\/v1\/workspaces\/[^/]+/, "/v1/workspaces/{workspaceId}")
      .replace(/\/snapshot-jobs\/[^/]+\//, "/snapshot-jobs/{jobId}/");
  }
  if (/^\/v1\/workspaces\/[^/]+\/snapshot-jobs\/[^/]+$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}/snapshot-jobs/{jobId}";
  }
  if (/^\/v1\/workspaces\/[^/]+\/(search|context|file|status)$/.test(pathname)) {
    return pathname.replace(/^\/v1\/workspaces\/[^/]+/, "/v1/workspaces/{workspaceId}");
  }
  if (/^\/v1\/workspaces\/[^/]+$/.test(pathname)) {
    return "/v1/workspaces/{workspaceId}";
  }
  if (/^\/v1\/index-jobs\/[^/]+\/events$/.test(pathname)) {
    return "/v1/index-jobs/{jobId}/events";
  }
  if (/^\/v1\/index-jobs\/[^/]+$/.test(pathname)) {
    return "/v1/index-jobs/{jobId}";
  }
  if (/^\/v1\/blobs\/[0-9a-fA-F]{64}$/.test(pathname)) {
    return "/v1/blobs/{sha256}";
  }
  if (STATIC_ROUTES.has(pathname)) return pathname;
  return "/{unmatched}";
}

export class RequestTelemetry {
  private readonly startedAtMs = Date.now();
  private readonly recent: RequestObservation[] = [];
  private readonly durations: number[] = [];
  private readonly routes = new Map<string, RouteAccumulator>();
  private sequence = 0;
  private total = 0;
  private errors = 0;
  private active = 0;

  constructor(
    private readonly recentLimit = 120,
    private readonly durationLimit = 2_000,
  ) {}

  begin(): { startedAtMs: number; startedAt: string } {
    this.active++;
    const startedAtMs = Date.now();
    return { startedAtMs, startedAt: new Date(startedAtMs).toISOString() };
  }

  complete(
    method: string | undefined,
    pathname: string,
    status: number,
    timing: { startedAtMs: number; startedAt: string },
  ): void {
    this.active = Math.max(0, this.active - 1);
    const durationMs = Math.max(0, Date.now() - timing.startedAtMs);
    const requestedMethod = method?.toUpperCase() || "GET";
    const normalizedMethod = OBSERVABLE_METHODS.has(requestedMethod)
      ? requestedMethod
      : "OTHER";
    const route = observableRoute(pathname, normalizedMethod);
    const observation: RequestObservation = {
      id: ++this.sequence,
      method: normalizedMethod,
      route,
      status,
      durationMs,
      startedAt: timing.startedAt,
    };
    this.total++;
    if (status >= 400) this.errors++;
    this.recent.unshift(observation);
    if (this.recent.length > this.recentLimit) this.recent.length = this.recentLimit;
    this.durations.push(durationMs);
    if (this.durations.length > this.durationLimit) this.durations.shift();

    const key = `${normalizedMethod} ${route}`;
    const accumulator = this.routes.get(key) ?? {
      method: normalizedMethod,
      route,
      requests: 0,
      errors: 0,
      durations: [],
    };
    accumulator.requests++;
    if (status >= 400) accumulator.errors++;
    accumulator.durations.push(durationMs);
    if (accumulator.durations.length > this.durationLimit) {
      accumulator.durations.shift();
    }
    this.routes.set(key, accumulator);
  }

  uptimeSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1_000));
  }

  snapshot(recentLimit = 60): RequestTelemetrySnapshot {
    const durationTotal = this.durations.reduce((sum, value) => sum + value, 0);
    const routes = [...this.routes.values()]
      .map((route) => {
        const total = route.durations.reduce((sum, value) => sum + value, 0);
        return {
          method: route.method,
          route: route.route,
          requests: route.requests,
          errors: route.errors,
          averageMs: route.durations.length ? rounded(total / route.durations.length) : 0,
          p95Ms: percentile(route.durations, 0.95),
        };
      })
      .sort((left, right) => right.requests - left.requests || left.route.localeCompare(right.route));
    return {
      active: this.active,
      total: this.total,
      errors: this.errors,
      errorRate: this.total ? rounded((this.errors / this.total) * 100) : 0,
      averageMs: this.durations.length ? rounded(durationTotal / this.durations.length) : 0,
      p95Ms: percentile(this.durations, 0.95),
      routes,
      recent: this.recent.slice(0, Math.max(0, recentLimit)),
    };
  }
}
