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
    .config-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); background: var(--surface); }
    .config-panel { min-width: 0; padding: 14px; border-right: 1px solid var(--line); }
    .config-panel:last-child { border-right: 0; }
    .config-panel h3 { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 12px; font-size: 13px; }
    .config-panel .field { margin-top: 9px; }
    .config-panel .field:first-of-type { margin-top: 0; }
    .config-panel .field label { margin-bottom: 4px; }
    .config-panel .control { min-height: 32px; }
    .config-panel .control[type="number"] { font-variant-numeric: tabular-nums; }
    .config-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .config-check { display: flex; align-items: center; gap: 7px; min-height: 32px; color: var(--text); font-size: 12px; }
    .config-check input { accent-color: var(--accent); }
    .config-help { margin-top: 4px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .model-test { display: flex; align-items: flex-start; flex-direction: column; gap: 8px; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line); }
    .model-test .button { align-self: flex-end; }
    .model-test-status { width: 100%; min-width: 0; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .model-test-status.good { color: #12543d; }
    .model-test-status.warn { color: #7b4908; }
    .model-test-status.bad { color: #8b3029; }
    .config-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
    .config-status { min-height: 18px; color: var(--muted); font-size: 12px; }
    .config-status.good { color: #12543d; }
    .config-status.warn { color: #7b4908; }
    .config-status.bad { color: #8b3029; }
    .config-readonly { display: grid; gap: 10px; }
    .config-readonly .runtime-item { min-height: 0; padding: 0 0 9px; border: 0; border-bottom: 1px solid var(--line); }
    .config-readonly .runtime-item:last-child { padding-bottom: 0; border-bottom: 0; }
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
      .config-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .config-panel:nth-child(2) { border-right: 0; }
      .config-panel:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
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
      .config-grid { grid-template-columns: 1fr; }
      .config-panel { border-right: 0; border-bottom: 1px solid var(--line); }
      .config-panel:last-child { border-bottom: 0; }
      .config-panel:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
      .config-actions { align-items: flex-start; flex-direction: column; }
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
      <div class="section-header"><h2>Model &amp; runtime configuration</h2><span class="section-note">Applied to this process</span></div>
      <form id="modelConfigForm">
        <div class="config-grid">
          <div class="config-panel">
            <h3><span>Embedding</span><span id="embeddingState" class="badge neutral">--</span></h3>
            <label class="config-check"><input id="embeddingEnabled" type="checkbox"> Enabled</label>
            <div class="field"><label for="embeddingBaseUrl">Base URL</label><input id="embeddingBaseUrl" class="control" type="url" spellcheck="false"></div>
            <div class="field"><label for="embeddingModel">Model</label><input id="embeddingModel" class="control" type="text" spellcheck="false"></div>
            <div class="field"><label for="embeddingAuth">Authentication</label><select id="embeddingAuth" class="control"><option value="bearer">Bearer</option><option value="none">None</option></select></div>
            <div class="field"><label for="embeddingApiKey">API key</label><input id="embeddingApiKey" class="control" type="password" autocomplete="new-password" spellcheck="false"></div>
            <div id="embeddingKeyHelp" class="config-help">Leave blank to keep the current key.</div>
            <div class="config-field-grid">
              <div class="field"><label for="embeddingDimensions">Dimensions</label><input id="embeddingDimensions" class="control" type="number" min="1"></div>
              <div class="field"><label for="embeddingBatchSize">Batch size</label><input id="embeddingBatchSize" class="control" type="number" min="1" max="1024"></div>
            </div>
            <div class="config-field-grid">
              <div class="field"><label for="embeddingMaxChars">Max input chars</label><input id="embeddingMaxChars" class="control" type="number" min="100"></div>
              <label class="config-check"><input id="embeddingInputType" type="checkbox"> Qwen input type</label>
            </div>
            <div class="model-test">
              <span id="embeddingTestStatus" class="model-test-status" aria-live="polite">Not tested</span>
              <button id="testEmbedding" class="button" type="button">Test connection</button>
            </div>
          </div>
          <div class="config-panel">
            <h3><span>Reranker</span><span id="rerankerState" class="badge neutral">--</span></h3>
            <label class="config-check"><input id="rerankerEnabled" type="checkbox"> Enabled</label>
            <div class="field"><label for="rerankerBaseUrl">Base URL</label><input id="rerankerBaseUrl" class="control" type="url" spellcheck="false"></div>
            <div class="field"><label for="rerankerModel">Model</label><input id="rerankerModel" class="control" type="text" spellcheck="false"></div>
            <div class="field"><label for="rerankerAuth">Authentication</label><select id="rerankerAuth" class="control"><option value="bearer">Bearer</option><option value="none">None</option></select></div>
            <div class="field"><label for="rerankerApiKey">API key</label><input id="rerankerApiKey" class="control" type="password" autocomplete="new-password" spellcheck="false"></div>
            <div id="rerankerKeyHelp" class="config-help">Leave blank to keep the current key.</div>
            <div class="config-field-grid">
              <div class="field"><label for="rerankerTopN">Top N</label><input id="rerankerTopN" class="control" type="number" min="2" max="64"></div>
              <div class="field"><label for="rerankerWeight">Weight</label><input id="rerankerWeight" class="control" type="number" min="0.05" max="0.85" step="0.01"></div>
            </div>
            <div class="field"><label for="rerankerMaxChars">Max document chars</label><input id="rerankerMaxChars" class="control" type="number" min="200"></div>
            <div class="field"><label for="rerankerInstruction">Instruction</label><textarea id="rerankerInstruction" class="control" rows="3"></textarea></div>
            <div class="model-test">
              <span id="rerankerTestStatus" class="model-test-status" aria-live="polite">Not tested</span>
              <button id="testReranker" class="button" type="button">Test connection</button>
            </div>
          </div>
          <div class="config-panel">
            <h3><span>Runtime policy</span><span class="badge info">Effective</span></h3>
            <div id="runtimeConfigList" class="config-readonly"></div>
          </div>
          <div class="config-panel">
            <h3><span>Server &amp; storage</span><span class="badge info">Effective</span></h3>
            <div id="serverConfigList" class="config-readonly"></div>
          </div>
        </div>
        <div class="config-actions">
          <span id="configStatus" class="config-status">Waiting for configuration.</span>
          <button id="saveConfiguration" class="button primary" type="submit">Apply configuration</button>
        </div>
      </form>
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
  var state = { token: sessionStorage.getItem(storageKey) || "", data: null, loading: false, timer: null, configDirty: false };
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
    if (["online", "indexed", "succeeded", "200", "enabled", "bearer"].indexOf(text) >= 0) tone = "good";
    else if (["queued", "running", "partial"].indexOf(text) >= 0) tone = "warn";
    else if (["failed", "offline", "error", "unavailable"].indexOf(text) >= 0) tone = "bad";
    else if (["blob", "local", "incremental", "rebuild", "none", "effective"].indexOf(text) >= 0) tone = "info";
    else if (["disabled_by_server"].indexOf(text) >= 0) tone = "warn";
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

  function configRows(rows) {
    return rows.map(function (row) {
      return "<div class=\"runtime-item\"><div class=\"runtime-key\">" + escapeHtml(row[0]) + "</div><div class=\"runtime-value\">" + escapeHtml(row[1]) + "</div></div>";
    }).join("");
  }

  function setInputValue(id, value) {
    byId(id).value = value == null ? "" : String(value);
  }

  function stateBadge(id, value) {
    var text = String(value || "disabled");
    var tone = text === "enabled" || text === "bearer" ? "good" : text === "disabled_by_server" ? "warn" : "neutral";
    var node = byId(id);
    node.className = "badge " + tone;
    node.textContent = text;
  }

  function syncModelEditor(prefix, enabled, auth) {
    byId(prefix + "Enabled").checked = enabled;
    byId(prefix + "Auth").disabled = !enabled;
    byId(prefix + "ApiKey").disabled = !enabled || auth === "none";
    byId("test" + (prefix === "embedding" ? "Embedding" : "Reranker")).disabled = !enabled;
  }

  function setModelTestStatus(prefix, tone, text) {
    var node = byId(prefix + "TestStatus");
    node.className = "model-test-status" + (tone ? " " + tone : "");
    node.textContent = text;
  }

  function embeddingFormConfiguration() {
    var embedding = {
      enabled: byId("embeddingEnabled").checked,
      base_url: byId("embeddingBaseUrl").value.trim() || undefined,
      model: byId("embeddingModel").value.trim() || undefined,
      dimensions: byId("embeddingDimensions").value ? Number(byId("embeddingDimensions").value) : null,
      authentication: byId("embeddingAuth").value,
      batch_size: Number(byId("embeddingBatchSize").value || 8),
      max_input_chars: Number(byId("embeddingMaxChars").value || 4000),
      input_type: byId("embeddingInputType").checked
    };
    var apiKey = byId("embeddingApiKey").value.trim();
    if (apiKey) embedding.api_key = apiKey;
    return embedding;
  }

  function rerankerFormConfiguration() {
    var reranker = {
      enabled: byId("rerankerEnabled").checked,
      base_url: byId("rerankerBaseUrl").value.trim() || undefined,
      model: byId("rerankerModel").value.trim() || undefined,
      authentication: byId("rerankerAuth").value,
      top_n: Number(byId("rerankerTopN").value || 20),
      weight: Number(byId("rerankerWeight").value || 0.32),
      max_document_chars: Number(byId("rerankerMaxChars").value || 1800),
      instruction: byId("rerankerInstruction").value.trim() || null
    };
    var apiKey = byId("rerankerApiKey").value.trim();
    if (apiKey) reranker.api_key = apiKey;
    return reranker;
  }

  function renderConfiguration(data) {
    var config = data.configuration || {};
    var embedding = config.embedding || {};
    var reranker = config.reranker || {};
    var modelApi = config.model_api || {};
    var indexing = config.indexing || {};
    var http = config.http || {};
    var storage = config.storage || {};

    stateBadge("embeddingState", embedding.state);
    stateBadge("rerankerState", reranker.state);
    setInputValue("embeddingBaseUrl", embedding.base_url);
    setInputValue("embeddingModel", embedding.model);
    setInputValue("embeddingDimensions", embedding.dimensions);
    setInputValue("embeddingBatchSize", embedding.batch_size);
    setInputValue("embeddingMaxChars", embedding.max_input_chars);
    byId("embeddingAuth").value = embedding.authentication === "none" ? "none" : "bearer";
    byId("embeddingInputType").checked = Boolean(embedding.input_type);
    byId("embeddingApiKey").value = "";
    byId("embeddingApiKey").placeholder = embedding.api_key_hint ? "Keep " + embedding.api_key_hint : "No key configured";
    byId("embeddingKeyHelp").textContent = embedding.api_key_hint ? "Current key: " + embedding.api_key_hint : "No key is configured.";

    setInputValue("rerankerBaseUrl", reranker.base_url);
    setInputValue("rerankerModel", reranker.model);
    setInputValue("rerankerTopN", reranker.top_n == null ? 20 : reranker.top_n);
    setInputValue("rerankerWeight", reranker.weight == null ? 0.32 : reranker.weight);
    setInputValue("rerankerMaxChars", reranker.max_document_chars == null ? 1800 : reranker.max_document_chars);
    setInputValue("rerankerInstruction", reranker.instruction);
    byId("rerankerAuth").value = reranker.authentication === "none" ? "none" : "bearer";
    byId("rerankerApiKey").value = "";
    byId("rerankerApiKey").placeholder = reranker.api_key_hint ? "Keep " + reranker.api_key_hint : "No key configured";
    byId("rerankerKeyHelp").textContent = reranker.api_key_hint ? "Current key: " + reranker.api_key_hint : "No key is configured.";

    syncModelEditor("embedding", embedding.state === "enabled", byId("embeddingAuth").value);
    syncModelEditor("reranker", reranker.state === "enabled", byId("rerankerAuth").value);
    byId("embeddingEnabled").disabled = embedding.state === "disabled_by_server";

    byId("runtimeConfigList").innerHTML = configRows([
      ["API timeout", number(modelApi.timeout_ms) + " ms"],
      ["API retries", number(modelApi.retries)],
      ["Max file", bytes(indexing.max_file_bytes)],
      ["Max chunk", number(indexing.max_chunk_chars) + " chars"],
    ]);
    byId("serverConfigList").innerHTML = configRows([
      ["HTTP auth", String(http.authentication || "--")],
      ["Max Blob", bytes(http.max_blob_bytes)],
      ["Local workspaces", http.local_workspaces ? "enabled" : "disabled"],
      ["Allowlist entries", number(http.local_root_allowlist_count)],
      ["Database", storage.host ? storage.host + (storage.port ? ":" + storage.port : "") + " / " + (storage.database || "configured") : "--"],
      ["Database TLS", storage.tls ? "enabled" : "disabled"],
    ]);
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
    if (!state.configDirty) renderConfiguration(data);
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

  Array.prototype.forEach.call(document.querySelectorAll("#modelConfigForm input, #modelConfigForm select, #modelConfigForm textarea"), function (control) {
    control.addEventListener("input", function () {
      state.configDirty = true;
      var prefix = control.id.indexOf("embedding") === 0 ? "embedding" : control.id.indexOf("reranker") === 0 ? "reranker" : "";
      if (prefix) setModelTestStatus(prefix, "", "Configuration changed; test again");
      byId("configStatus").className = "config-status";
      byId("configStatus").textContent = "Unsaved changes";
    });
    control.addEventListener("change", function () {
      state.configDirty = true;
      if (control.id === "embeddingAuth" || control.id === "embeddingEnabled") syncModelEditor("embedding", byId("embeddingEnabled").checked, byId("embeddingAuth").value);
      if (control.id === "rerankerAuth" || control.id === "rerankerEnabled") syncModelEditor("reranker", byId("rerankerEnabled").checked, byId("rerankerAuth").value);
      var prefix = control.id.indexOf("embedding") === 0 ? "embedding" : control.id.indexOf("reranker") === 0 ? "reranker" : "";
      if (prefix) setModelTestStatus(prefix, "", "Configuration changed; test again");
      byId("configStatus").className = "config-status";
      byId("configStatus").textContent = "Unsaved changes";
    });
  });

  async function testModelConnection(target) {
    var isEmbedding = target === "embedding";
    var prefix = isEmbedding ? "embedding" : "reranker";
    var button = byId(isEmbedding ? "testEmbedding" : "testReranker");
    var configuration = isEmbedding ? embeddingFormConfiguration() : rerankerFormConfiguration();
    if (!configuration.enabled) {
      setModelTestStatus(prefix, "warn", "Enable the model before testing");
      return;
    }
    button.disabled = true;
    setModelTestStatus(prefix, "", "Testing...");
    try {
      var body = isEmbedding
        ? { target: "embedding", embedding: configuration }
        : { target: "reranker", reranker: configuration };
      var result = await api("/v1/observability/configuration/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      var detail = isEmbedding
        ? number(result.details && result.details.dimensions) + " dimensions"
        : number(result.details && result.details.scored_documents) + " scores";
      setModelTestStatus(prefix, "good", "Available - " + duration(result.latency_ms) + " - " + detail);
    } catch (error) {
      setModelTestStatus(prefix, "bad", error.message);
    } finally {
      button.disabled = !byId(prefix + "Enabled").checked;
    }
  }

  byId("testEmbedding").addEventListener("click", function () { testModelConnection("embedding"); });
  byId("testReranker").addEventListener("click", function () { testModelConnection("reranker"); });

  byId("modelConfigForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    var button = byId("saveConfiguration");
    button.disabled = true;
    byId("configStatus").className = "config-status";
    byId("configStatus").textContent = "Applying...";
    var embedding = embeddingFormConfiguration();
    var reranker = rerankerFormConfiguration();
    try {
      var result = await api("/v1/observability/configuration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embedding: embedding, reranker: reranker })
      });
      state.configDirty = false;
      renderConfiguration({ configuration: result.configuration });
      byId("configStatus").className = "config-status " + (result.reindex_required ? "warn" : "good");
      byId("configStatus").textContent = result.reindex_required ? "Applied; reindex required for the current embedding index." : "Applied to the running process.";
      setTimeout(refresh, 150);
    } catch (error) {
      byId("configStatus").className = "config-status bad";
      byId("configStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

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
