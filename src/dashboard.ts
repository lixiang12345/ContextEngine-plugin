export function observabilityDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>ContextEngine Observability</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --surface: #ffffff;
      --surface-muted: #f0f2f3;
      --text: #172027;
      --muted: #66727c;
      --line: #d8dde1;
      --line-strong: #b8c1c8;
      --accent: #176b4d;
      --accent-soft: #e5f2ec;
      --warning: #9a5b08;
      --warning-soft: #fff2d8;
      --danger: #a43a32;
      --danger-soft: #fbe9e7;
      --info: #255f89;
      --info-soft: #e8f1f7;
      --shadow: 0 1px 2px rgba(23, 32, 39, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.45;
      letter-spacing: 0;
    }
    button, input, select { font: inherit; letter-spacing: 0; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
      outline: 2px solid var(--info);
      outline-offset: 2px;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      min-height: 58px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(10px);
    }
    .topbar-inner {
      width: min(1480px, 100%);
      min-height: 58px;
      margin: 0 auto;
      padding: 9px 22px;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: baseline;
      gap: 9px;
      flex: 0 0 auto;
    }
    .brand strong { font-size: 16px; font-weight: 720; }
    .brand span { color: var(--muted); font-size: 12px; }
    .connection {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 105px;
      color: var(--muted);
      font-size: 12px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--line-strong);
      box-shadow: 0 0 0 3px var(--surface-muted);
    }
    .status-dot.online { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .status-dot.error { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
    .auth-form {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .auth-form input { width: 210px; }
    .control {
      min-height: 34px;
      border: 1px solid var(--line-strong);
      border-radius: 5px;
      background: var(--surface);
      color: var(--text);
      padding: 6px 9px;
    }
    .control:hover { border-color: #87949e; }
    .button {
      min-height: 34px;
      border: 1px solid var(--line-strong);
      border-radius: 5px;
      background: var(--surface);
      color: var(--text);
      padding: 6px 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .button:hover { background: var(--surface-muted); }
    .button.primary { border-color: var(--accent); background: var(--accent); color: #ffffff; }
    .button.primary:hover { background: #115a40; }
    .button.ghost { border-color: transparent; background: transparent; color: var(--muted); }
    .button:disabled { opacity: 0.55; cursor: wait; }
    .icon-button { width: 34px; padding: 0; display: grid; place-items: center; font-weight: 700; }
    .top-link { color: var(--muted); text-decoration: none; padding: 7px 3px; }
    .top-link:hover { color: var(--text); }
    .auto-refresh { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .auto-refresh input { accent-color: var(--accent); }
    main { width: min(1480px, 100%); margin: 0 auto; padding: 22px; }
    .notice {
      display: none;
      margin-bottom: 16px;
      border: 1px solid #efc6c2;
      border-radius: 6px;
      background: var(--danger-soft);
      color: #7f2b25;
      padding: 10px 12px;
    }
    .notice.visible { display: block; }
    .page-heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 16px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 3px; font-size: 22px; line-height: 1.2; font-weight: 720; }
    h2 { margin-bottom: 12px; font-size: 15px; line-height: 1.25; font-weight: 700; }
    .subtitle, .section-note { color: var(--muted); }
    .subtitle { margin: 0; font-size: 13px; }
    .updated { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(8, minmax(112px, 1fr));
      gap: 9px;
      margin-bottom: 24px;
    }
    .metric {
      min-height: 96px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .metric-label { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 650; }
    .metric-value { margin-top: 9px; font-size: 23px; line-height: 1; font-weight: 720; font-variant-numeric: tabular-nums; }
    .metric-detail { margin-top: 7px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .section { min-width: 0; border-top: 1px solid var(--line); padding: 20px 0 24px; }
    .section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .section-header h2 { margin: 0; }
    .section-note { font-size: 12px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 0.72fr); gap: 28px; }
    .split > * { min-width: 0; }
    .table-wrap { width: 100%; max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; border: 1px solid var(--line); background: var(--surface); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    th { color: var(--muted); background: var(--surface-muted); font-weight: 650; white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: #fafbfb; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    .truncate { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 650;
      white-space: nowrap;
    }
    .badge.good { background: var(--accent-soft); color: #12543d; }
    .badge.warn { background: var(--warning-soft); color: #7b4908; }
    .badge.bad { background: var(--danger-soft); color: #8b3029; }
    .badge.info { background: var(--info-soft); color: #204f70; }
    .badge.neutral { background: var(--surface-muted); color: var(--muted); }
    .runtime-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--line); background: var(--surface); }
    .runtime-item { min-height: 61px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .runtime-item:nth-child(odd) { border-right: 1px solid var(--line); }
    .runtime-item:nth-last-child(-n + 2) { border-bottom: 0; }
    .runtime-key { color: var(--muted); font-size: 11px; }
    .runtime-value { margin-top: 4px; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .latency-cell { min-width: 130px; }
    .latency-track { width: 100%; height: 5px; margin-top: 5px; background: #e8ebed; }
    .latency-fill { height: 100%; background: var(--info); }
    .empty { border: 1px dashed var(--line-strong); color: var(--muted); padding: 24px; text-align: center; }
    .probe-form { display: grid; grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 2fr) 95px 120px auto; gap: 8px; align-items: end; }
    .field { min-width: 0; }
    .field label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 11px; font-weight: 650; }
    .field .control { width: 100%; }
    .probe-meta { margin: 12px 0 8px; color: var(--muted); font-size: 12px; min-height: 18px; }
    .result-list { border: 1px solid var(--line); background: var(--surface); }
    .result { padding: 13px 14px; border-bottom: 1px solid var(--line); }
    .result:last-child { border-bottom: 0; }
    .result-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
    .result-path { min-width: 0; font-weight: 680; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .result-score { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .result-preview { margin-top: 7px; color: #3c4850; white-space: pre-wrap; overflow-wrap: anywhere; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; line-height: 1.5; }
    .skeleton { color: transparent; background: #e8ebed; border-radius: 3px; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.55; } }
    @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
    @media (max-width: 1180px) {
      .metric-grid { grid-template-columns: repeat(4, minmax(130px, 1fr)); }
      .split { grid-template-columns: 1fr; }
      .probe-form { grid-template-columns: 1fr 2fr 90px 110px; }
      .probe-form .button { grid-column: 1 / -1; justify-self: start; }
    }
    @media (max-width: 760px) {
      .topbar-inner { align-items: flex-start; flex-wrap: wrap; padding: 10px 14px; }
      .auth-form { order: 3; width: 100%; margin-left: 0; }
      .auth-form input { flex: 1; width: auto; min-width: 120px; }
      .auto-refresh { margin-left: auto; }
      main { padding: 17px 14px; }
      .page-heading { align-items: flex-start; flex-direction: column; gap: 7px; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric { min-height: 88px; }
      .runtime-list { grid-template-columns: 1fr; }
      .runtime-item:nth-child(odd) { border-right: 0; }
      .runtime-item:nth-last-child(2) { border-bottom: 1px solid var(--line); }
      .probe-form { grid-template-columns: 1fr; }
      .probe-form .button { grid-column: auto; width: 100%; }
      .top-link { display: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><strong>ContextEngine</strong><span>Observability</span></div>
      <div class="connection"><span id="connectionDot" class="status-dot"></span><span id="connectionText">Connecting</span></div>
      <label class="auto-refresh"><input id="autoRefresh" type="checkbox" checked> Auto refresh</label>
      <a class="top-link" href="/openapi.json" target="_blank" rel="noreferrer">API schema</a>
      <form id="authForm" class="auth-form">
        <input id="apiKey" class="control" type="password" autocomplete="current-password" placeholder="Bearer API key" aria-label="Bearer API key">
        <button class="button primary" type="submit">Connect</button>
        <button id="clearKey" class="button ghost" type="button">Clear</button>
        <button id="refresh" class="button icon-button" type="button" title="Refresh dashboard" aria-label="Refresh dashboard">R</button>
      </form>
    </div>
  </header>
  <main>
    <div id="notice" class="notice" role="alert"></div>
    <div class="page-heading">
      <div>
        <h1>Service overview</h1>
        <p class="subtitle">Index health, retrieval traffic, and runtime state.</p>
      </div>
      <div id="updatedAt" class="updated">Waiting for data</div>
    </div>
    <section class="metric-grid" aria-label="Service metrics">
      <div class="metric"><div class="metric-label">Service</div><div id="serviceMetric" class="metric-value">--</div><div id="serviceDetail" class="metric-detail">No data</div></div>
      <div class="metric"><div class="metric-label">Workspaces</div><div id="workspaceMetric" class="metric-value">--</div><div id="workspaceDetail" class="metric-detail">No data</div></div>
      <div class="metric"><div class="metric-label">Files</div><div id="fileMetric" class="metric-value">--</div><div id="fileDetail" class="metric-detail">Indexed source files</div></div>
      <div class="metric"><div class="metric-label">Chunks</div><div id="chunkMetric" class="metric-value">--</div><div id="chunkDetail" class="metric-detail">Retrievable chunks</div></div>
      <div class="metric"><div class="metric-label">Requests</div><div id="requestMetric" class="metric-value">--</div><div id="requestDetail" class="metric-detail">Since process start</div></div>
      <div class="metric"><div class="metric-label">Error rate</div><div id="errorMetric" class="metric-value">--</div><div id="errorDetail" class="metric-detail">HTTP 4xx and 5xx</div></div>
      <div class="metric"><div class="metric-label">P95 latency</div><div id="latencyMetric" class="metric-value">--</div><div id="latencyDetail" class="metric-detail">All observed routes</div></div>
      <div class="metric"><div class="metric-label">Index jobs</div><div id="jobMetric" class="metric-value">--</div><div id="jobDetail" class="metric-detail">Queued or running</div></div>
    </section>
    <section class="section split">
      <div>
        <div class="section-header"><h2>Route health</h2><span class="section-note">In-memory process window</span></div>
        <div id="routeTable" class="empty">No request observations yet.</div>
      </div>
      <div>
        <div class="section-header"><h2>Runtime</h2><span class="section-note">Current process</span></div>
        <div id="runtimeList" class="runtime-list">
          <div class="runtime-item"><div class="runtime-key">Uptime</div><div class="runtime-value">--</div></div>
          <div class="runtime-item"><div class="runtime-key">Memory</div><div class="runtime-value">--</div></div>
          <div class="runtime-item"><div class="runtime-key">Node</div><div class="runtime-value">--</div></div>
          <div class="runtime-item"><div class="runtime-key">Storage</div><div class="runtime-value">--</div></div>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-header"><h2>Workspaces</h2><span id="workspaceNote" class="section-note">No workspaces loaded</span></div>
      <div id="workspaceTable" class="empty">Connect to load workspaces.</div>
    </section>
    <section class="section split">
      <div>
        <div class="section-header"><h2>Recent index jobs</h2><span class="section-note">Latest 25</span></div>
        <div id="jobTable" class="empty">No index jobs loaded.</div>
      </div>
      <div>
        <div class="section-header"><h2>Recent requests</h2><span class="section-note">No payload capture</span></div>
        <div id="requestTable" class="empty">No requests observed.</div>
      </div>
    </section>
    <section id="probe" class="section">
      <div class="section-header"><h2>Retrieval probe</h2><span class="section-note">Run a live search against an indexed workspace</span></div>
      <form id="probeForm" class="probe-form">
        <div class="field"><label for="probeWorkspace">Workspace</label><select id="probeWorkspace" class="control" required><option value="">Select workspace</option></select></div>
        <div class="field"><label for="probeQuery">Query</label><input id="probeQuery" class="control" required maxlength="20000" placeholder="Find authorization checks before access is granted"></div>
        <div class="field"><label for="probeTopK">Top K</label><input id="probeTopK" class="control" type="number" min="1" max="40" value="8"></div>
        <div class="field"><label for="probeMode">Mode</label><select id="probeMode" class="control"><option value="auto">Auto</option><option value="hybrid">Hybrid</option><option value="bm25">BM25</option><option value="semantic">Semantic</option></select></div>
        <button id="probeSubmit" class="button primary" type="submit">Run search</button>
      </form>
      <div id="probeMeta" class="probe-meta"></div>
      <div id="probeResults" class="empty">No probe results yet.</div>
    </section>
  </main>
  <script>
(function () {
  "use strict";
  var storageKey = "contextengine.dashboard.apiKey";
  var state = { token: sessionStorage.getItem(storageKey) || "", data: null, loading: false, timer: null };
  var byId = function (id) { return document.getElementById(id); };
  var apiKey = byId("apiKey");
  apiKey.value = state.token;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function number(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function bytes(value) {
    var size = Number(value || 0);
    if (size < 1024) return size + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var index = -1;
    do { size /= 1024; index++; } while (size >= 1024 && index < units.length - 1);
    return size.toFixed(size >= 10 ? 1 : 2) + " " + units[index];
  }

  function duration(value) {
    var ms = Number(value || 0);
    if (ms < 1000) return ms.toFixed(ms < 10 ? 1 : 0) + " ms";
    return (ms / 1000).toFixed(2) + " s";
  }

  function uptime(value) {
    var seconds = Math.max(0, Number(value || 0));
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    if (days) return days + "d " + hours + "h";
    if (hours) return hours + "h " + minutes + "m";
    return minutes + "m " + Math.floor(seconds % 60) + "s";
  }

  function timeAgo(value) {
    if (!value) return "--";
    var delta = Math.max(0, Date.now() - new Date(value).getTime());
    if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
    if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
    if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
    return Math.floor(delta / 86400000) + "d ago";
  }

  function badge(value) {
    var text = String(value || "unknown");
    var tone = "neutral";
    if (["online", "indexed", "succeeded", "200"].indexOf(text) >= 0) tone = "good";
    else if (["queued", "running", "partial"].indexOf(text) >= 0) tone = "warn";
    else if (["failed", "offline", "error"].indexOf(text) >= 0) tone = "bad";
    else if (["blob", "local", "incremental", "rebuild"].indexOf(text) >= 0) tone = "info";
    return "<span class=\"badge " + tone + "\">" + escapeHtml(text) + "</span>";
  }

  function setConnection(kind, text) {
    byId("connectionDot").className = "status-dot" + (kind ? " " + kind : "");
    byId("connectionText").textContent = text;
  }

  function showNotice(message) {
    var notice = byId("notice");
    notice.textContent = message || "";
    notice.classList.toggle("visible", Boolean(message));
  }

  async function api(path, options) {
    var init = options || {};
    var headers = Object.assign({ accept: "application/json" }, init.headers || {});
    if (state.token) headers.authorization = "Bearer " + state.token;
    var response = await fetch(path, Object.assign({}, init, { headers: headers }));
    var contentType = response.headers.get("content-type") || "";
    var payload = contentType.indexOf("application/json") >= 0 ? await response.json() : await response.text();
    if (!response.ok) {
      var message = payload && payload.error && payload.error.message ? payload.error.message : "Request failed with status " + response.status;
      var error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function renderMetrics(data) {
    var workspaces = data.workspaces || [];
    var indexed = workspaces.filter(function (item) { return item.indexed; }).length;
    var files = workspaces.reduce(function (sum, item) { return sum + Number(item.stats && item.stats.fileCount || 0); }, 0);
    var chunks = workspaces.reduce(function (sum, item) { return sum + Number(item.stats && item.stats.chunkCount || 0); }, 0);
    var activeJobs = (data.jobs || []).filter(function (job) { return job.status === "queued" || job.status === "running"; }).length;
    byId("serviceMetric").textContent = "Online";
    byId("serviceDetail").textContent = uptime(data.service.uptime_seconds) + " uptime";
    byId("workspaceMetric").textContent = number(workspaces.length);
    byId("workspaceDetail").textContent = indexed + " indexed";
    byId("fileMetric").textContent = number(files);
    byId("chunkMetric").textContent = number(chunks);
    byId("requestMetric").textContent = number(data.requests.total);
    byId("requestDetail").textContent = data.requests.active + " active";
    byId("errorMetric").textContent = Number(data.requests.error_rate || 0).toFixed(1) + "%";
    byId("errorDetail").textContent = number(data.requests.errors) + " errors";
    byId("latencyMetric").textContent = duration(data.requests.p95_ms);
    byId("latencyDetail").textContent = duration(data.requests.average_ms) + " average";
    byId("jobMetric").textContent = number(activeJobs);
    byId("jobDetail").textContent = number((data.jobs || []).length) + " recent jobs";
  }

  function renderRuntime(data) {
    var memory = data.service.memory || {};
    var rows = [
      ["Uptime", uptime(data.service.uptime_seconds)],
      ["Resident memory", bytes(memory.rss_bytes)],
      ["Heap used", bytes(memory.heap_used_bytes) + " / " + bytes(memory.heap_total_bytes)],
      ["Node", data.service.node_version],
      ["Process", "PID " + data.service.pid],
      ["Storage", data.service.storage],
    ];
    byId("runtimeList").innerHTML = rows.map(function (row) {
      return "<div class=\"runtime-item\"><div class=\"runtime-key\">" + escapeHtml(row[0]) + "</div><div class=\"runtime-value\">" + escapeHtml(row[1]) + "</div></div>";
    }).join("");
  }

  function renderRoutes(data) {
    var routes = data.requests.routes || [];
    if (!routes.length) { byId("routeTable").className = "empty"; byId("routeTable").textContent = "No request observations yet."; return; }
    var maxP95 = Math.max.apply(null, routes.map(function (route) { return route.p95_ms; }).concat([1]));
    var body = routes.slice(0, 12).map(function (route) {
      var width = Math.max(3, Math.round((route.p95_ms / maxP95) * 100));
      var errorTone = route.errors ? "bad" : "good";
      return "<tr><td>" + escapeHtml(route.method) + "</td><td class=\"mono truncate\" title=\"" + escapeHtml(route.route) + "\">" + escapeHtml(route.route) + "</td><td class=\"number\">" + number(route.requests) + "</td><td>" + "<span class=\"badge " + errorTone + "\">" + number(route.errors) + " errors</span></td><td class=\"latency-cell\"><span>" + duration(route.p95_ms) + "</span><div class=\"latency-track\"><div class=\"latency-fill\" style=\"width:" + width + "%\"></div></div></td></tr>";
    }).join("");
    byId("routeTable").className = "table-wrap";
    byId("routeTable").innerHTML = "<table><thead><tr><th>Method</th><th>Route</th><th class=\"number\">Requests</th><th>Errors</th><th>P95</th></tr></thead><tbody>" + body + "</tbody></table>";
  }

  function renderWorkspaces(data) {
    var workspaces = data.workspaces || [];
    byId("workspaceNote").textContent = workspaces.length + " configured";
    var select = byId("probeWorkspace");
    var previous = select.value;
    select.innerHTML = "<option value=\"\">Select workspace</option>" + workspaces.filter(function (item) { return item.indexed; }).map(function (item) {
      return "<option value=\"" + escapeHtml(item.workspace.id) + "\">" + escapeHtml(item.workspace.name) + "</option>";
    }).join("");
    if (previous && workspaces.some(function (item) { return item.workspace.id === previous && item.indexed; })) select.value = previous;
    if (!workspaces.length) { byId("workspaceTable").className = "empty"; byId("workspaceTable").textContent = "No workspaces configured."; return; }
    var rows = workspaces.map(function (item) {
      var stats = item.stats || {};
      var status = item.indexed ? "indexed" : "empty";
      return "<tr><td><strong>" + escapeHtml(item.workspace.name) + "</strong><div class=\"mono truncate section-note\">" + escapeHtml(item.workspace.id) + "</div></td><td>" + badge(item.workspace.source_mode) + "</td><td>" + badge(status) + "</td><td class=\"number\">" + number(item.workspace.revision) + "</td><td class=\"number\">" + number(stats.fileCount) + "</td><td class=\"number\">" + number(stats.chunkCount) + "</td><td>" + timeAgo(stats.lastIndexedAt || item.workspace.updated_at) + "</td><td><button class=\"button probe-workspace\" type=\"button\" data-workspace=\"" + escapeHtml(item.workspace.id) + "\" " + (item.indexed ? "" : "disabled") + ">Probe</button></td></tr>";
    }).join("");
    byId("workspaceTable").className = "table-wrap";
    byId("workspaceTable").innerHTML = "<table><thead><tr><th>Workspace</th><th>Source</th><th>Status</th><th class=\"number\">Revision</th><th class=\"number\">Files</th><th class=\"number\">Chunks</th><th>Updated</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>";
    Array.prototype.forEach.call(document.querySelectorAll(".probe-workspace"), function (button) {
      button.addEventListener("click", function () { byId("probeWorkspace").value = button.dataset.workspace || ""; byId("probe").scrollIntoView({ behavior: "smooth", block: "start" }); byId("probeQuery").focus(); });
    });
  }

  function renderJobs(data) {
    var jobs = data.jobs || [];
    if (!jobs.length) { byId("jobTable").className = "empty"; byId("jobTable").textContent = "No index jobs found."; return; }
    var names = {};
    (data.workspaces || []).forEach(function (item) { names[item.workspace.id] = item.workspace.name; });
    var rows = jobs.map(function (job) {
      var progress = job.progress && job.progress.phase ? job.progress.phase : job.status;
      return "<tr><td>" + badge(job.status) + "</td><td class=\"truncate\" title=\"" + escapeHtml(names[job.workspace_id] || job.workspace_id) + "\">" + escapeHtml(names[job.workspace_id] || job.workspace_id) + "</td><td>" + badge(job.mode) + "</td><td>" + escapeHtml(progress) + "</td><td>" + timeAgo(job.created_at) + "</td></tr>";
    }).join("");
    byId("jobTable").className = "table-wrap";
    byId("jobTable").innerHTML = "<table><thead><tr><th>Status</th><th>Workspace</th><th>Mode</th><th>Phase</th><th>Created</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderRequests(data) {
    var requests = data.requests.recent || [];
    if (!requests.length) { byId("requestTable").className = "empty"; byId("requestTable").textContent = "No requests observed."; return; }
    var rows = requests.slice(0, 18).map(function (request) {
      var tone = request.status >= 500 ? "bad" : request.status >= 400 ? "warn" : "good";
      return "<tr><td>" + escapeHtml(request.method) + "</td><td class=\"mono truncate\" title=\"" + escapeHtml(request.route) + "\">" + escapeHtml(request.route) + "</td><td><span class=\"badge " + tone + "\">" + request.status + "</span></td><td class=\"number\">" + duration(request.duration_ms) + "</td><td>" + timeAgo(request.started_at) + "</td></tr>";
    }).join("");
    byId("requestTable").className = "table-wrap";
    byId("requestTable").innerHTML = "<table><thead><tr><th>Method</th><th>Route</th><th>Status</th><th class=\"number\">Time</th><th>When</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function render(data) {
    state.data = data;
    renderMetrics(data);
    renderRuntime(data);
    renderRoutes(data);
    renderWorkspaces(data);
    renderJobs(data);
    renderRequests(data);
    byId("updatedAt").textContent = "Updated " + new Date(data.generated_at).toLocaleTimeString();
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    byId("refresh").disabled = true;
    try {
      var data = await api("/v1/observability/overview?request_limit=60&job_limit=25");
      render(data);
      setConnection("online", "Connected");
      showNotice("");
    } catch (error) {
      setConnection("error", error.status === 401 ? "Authentication required" : "Unavailable");
      showNotice(error.message);
    } finally {
      state.loading = false;
      byId("refresh").disabled = false;
    }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (byId("autoRefresh").checked) state.timer = setInterval(refresh, 5000);
  }

  byId("authForm").addEventListener("submit", function (event) {
    event.preventDefault();
    state.token = apiKey.value.trim();
    if (state.token) sessionStorage.setItem(storageKey, state.token); else sessionStorage.removeItem(storageKey);
    refresh();
  });
  byId("clearKey").addEventListener("click", function () { state.token = ""; apiKey.value = ""; sessionStorage.removeItem(storageKey); refresh(); });
  byId("refresh").addEventListener("click", refresh);
  byId("autoRefresh").addEventListener("change", schedule);

  byId("probeForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    var workspaceId = byId("probeWorkspace").value;
    var query = byId("probeQuery").value.trim();
    if (!workspaceId || !query) return;
    var button = byId("probeSubmit");
    button.disabled = true;
    byId("probeMeta").textContent = "Searching...";
    var started = performance.now();
    try {
      var payload = await api("/v1/workspaces/" + encodeURIComponent(workspaceId) + "/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query, top_k: Number(byId("probeTopK").value || 8), mode: byId("probeMode").value })
      });
      var elapsed = performance.now() - started;
      byId("probeMeta").textContent = payload.count + " results in " + duration(elapsed);
      if (!payload.results.length) { byId("probeResults").className = "empty"; byId("probeResults").textContent = "No results returned."; }
      else {
        byId("probeResults").className = "result-list";
        byId("probeResults").innerHTML = payload.results.map(function (result) {
          var label = result.path + ":" + result.start_line + "-" + result.end_line;
          return "<article class=\"result\"><div class=\"result-head\"><div class=\"result-path mono\" title=\"" + escapeHtml(label) + "\">" + escapeHtml(label) + "</div><div class=\"result-score\">" + escapeHtml(result.source) + " / " + Number(result.score || 0).toFixed(4) + "</div></div><div class=\"result-preview\">" + escapeHtml(result.preview || result.content || "") + "</div></article>";
        }).join("");
      }
      setTimeout(refresh, 150);
    } catch (error) {
      byId("probeMeta").textContent = "Search failed";
      byId("probeResults").className = "empty";
      byId("probeResults").textContent = error.message;
    } finally { button.disabled = false; }
  });

  schedule();
  refresh();
})();
  </script>
</body>
</html>`;
}
