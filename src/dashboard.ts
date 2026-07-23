export function observabilityDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
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
    .button-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .icon-button { width: 34px; padding: 0; display: grid; place-items: center; font-weight: 700; }
    .top-link { color: var(--muted); text-decoration: none; padding: 7px 3px; }
    .top-link:hover { color: var(--text); }
    .auto-refresh { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .auto-refresh input { accent-color: var(--accent); }
    main { width: min(1480px, 100%); margin: 0 auto; padding: 22px; }
    main:focus { outline: none; }
    .skip-link {
      position: fixed;
      top: 8px;
      left: 8px;
      z-index: 100;
      border-radius: 7px;
      background: var(--text);
      color: var(--surface);
      padding: 8px 11px;
      text-decoration: none;
      transform: translateY(-150%);
    }
    .skip-link:focus { transform: translateY(0); }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
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
    .probe-form { display: grid; grid-template-columns: minmax(190px, 0.72fr) minmax(220px, 1.8fr) 80px 112px 142px 104px auto; gap: 8px; align-items: end; }
    .field { min-width: 0; }
    .field label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 11px; font-weight: 650; }
    .field .control { width: 100%; }
    .probe-meta { margin: 12px 0 8px; color: var(--muted); font-size: 12px; min-height: 18px; }
    .trace-panel { display: none; margin: 4px 0 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 12px 14px; }
    .trace-panel.visible { display: block; }
    .trace-grid { display: flex; flex-wrap: wrap; gap: 8px 20px; }
    .trace-item { min-width: 0; }
    .trace-key { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 650; letter-spacing: 0.02em; }
    .trace-value { margin-top: 3px; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .trace-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 3px; }
    .trace-chip { display: inline-flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 600; }
    .trace-chip.warn { border-color: var(--warning); color: var(--warning); }
    .budget-line { font-variant-numeric: tabular-nums; }
    .budget-track { width: 100%; max-width: 200px; height: 5px; margin-top: 5px; border-radius: 999px; background: #e8ebed; overflow: hidden; }
    .budget-fill { height: 100%; background: var(--accent); border-radius: 999px; }
    .budget-fill.near { background: var(--warning); }
    .budget-fill.over { background: var(--danger); }
    html[data-theme="dark"] .budget-track { background: #263440; }
    .packed-block { margin-top: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 13px 14px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 11px; line-height: 1.55; max-height: 520px; overflow-y: auto; }
    .result-list { border: 1px solid var(--line); background: var(--surface); }
    .result { padding: 13px 14px; border-bottom: 1px solid var(--line); }
    .result:last-child { border-bottom: 0; }
    .result-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
    .result-path { min-width: 0; font-weight: 680; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .result-score { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .revision-cell { max-width: 150px; white-space: nowrap; }
    .result-preview { margin-top: 7px; color: #3c4850; white-space: pre-wrap; overflow-wrap: anywhere; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; line-height: 1.5; }
    .channel-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .channel-chip { display: inline-flex; align-items: baseline; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; padding: 1px 8px; font-size: 10px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: 0.02em; }
    .channel-chip .channel-pct { font-variant-numeric: tabular-nums; color: var(--text); }
    .channel-chip.warn { border-color: var(--warning); color: var(--warning); }
    .skeleton { color: transparent; background: #e8ebed; border-radius: 3px; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.55; } }
    @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }

    /* Operational polish: restrained hierarchy, dark mode, and clear feedback. */
    html { scroll-behavior: smooth; }
    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1117;
      --surface: #121a22;
      --surface-muted: #19232d;
      --text: #e6edf3;
      --muted: #91a0ad;
      --line: #273440;
      --line-strong: #3b4b58;
      --accent: #45c08a;
      --accent-soft: #17382c;
      --warning: #e1a84b;
      --warning-soft: #382b18;
      --danger: #ef7c73;
      --danger-soft: #3a211f;
      --info: #67b7ec;
      --info-soft: #183247;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
    }
    html[data-theme="dark"] .topbar { background: rgba(11, 17, 23, 0.9); }
    html[data-theme="dark"] tbody tr:hover td { background: #17212a; }
    html[data-theme="dark"] .result-preview { color: #b8c5cf; }
    html[data-theme="dark"] .latency-track,
    html[data-theme="dark"] .skeleton { background: #263440; }
    html[data-theme="dark"] .badge.good,
    html[data-theme="dark"] .config-status.good,
    html[data-theme="dark"] .model-test-status.good { color: #83ddb5; }
    html[data-theme="dark"] .badge.warn,
    html[data-theme="dark"] .config-status.warn,
    html[data-theme="dark"] .model-test-status.warn { color: #f3c572; }
    html[data-theme="dark"] .badge.bad,
    html[data-theme="dark"] .config-status.bad,
    html[data-theme="dark"] .model-test-status.bad { color: #ffaaa3; }
    html[data-theme="dark"] .badge.info { color: #a1d8f8; }
    .loading-bar {
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 40;
      height: 3px;
      pointer-events: none;
      opacity: 0;
      overflow: hidden;
      transition: opacity 160ms ease;
    }
    .loading-bar::after {
      content: "";
      display: block;
      width: 38%;
      height: 100%;
      background: var(--accent);
      transform: translateX(-110%);
    }
    .loading-bar.active { opacity: 1; }
    .loading-bar.active::after { animation: loading-slide 1.1s ease-in-out infinite; }
    @keyframes loading-slide { to { transform: translateX(365%); } }
    .brand { align-items: center; }
    .brand-mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      color: #fff;
      background: var(--accent);
      box-shadow: var(--shadow);
      font-size: 13px;
      font-weight: 800;
    }
    .brand-copy { display: grid; gap: 0; }
    .brand-copy strong { line-height: 1.1; }
    .brand-copy span { line-height: 1.1; }
    .topbar-inner { min-height: 64px; }
    .control, .button {
      border-radius: 6px;
      transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
    }
    .control:focus { border-color: var(--info); box-shadow: 0 0 0 3px var(--info-soft); }
    .button:hover:not(:disabled) { transform: translateY(-1px); }
    .button.primary { box-shadow: var(--shadow); }
    .button.compact { min-height: 30px; padding: 4px 9px; font-size: 11px; }
    .icon-button.spinning { animation: spin 700ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .page-heading {
      align-items: center;
      margin: 0;
      padding: 12px 0 20px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow { margin-bottom: 7px; color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: 0; text-transform: uppercase; }
    h1 { font-size: 26px; letter-spacing: 0; }
    .section-nav { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 15px; }
    .section-nav a {
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--surface);
      color: var(--muted);
      padding: 5px 10px;
      text-decoration: none;
      font-size: 11px;
    }
    .section-nav a:hover { border-color: var(--accent); color: var(--accent); }
    .metric-grid { gap: 12px; }
    .metric {
      position: relative;
      overflow: hidden;
      border-radius: 7px;
      box-shadow: var(--shadow);
      transition: border-color 180ms ease, box-shadow 180ms ease;
    }
    .metric::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--info);
      opacity: 0.7;
    }
    .metric:nth-child(2n)::before { background: var(--accent); }
    .metric:nth-child(3n)::before { background: var(--warning); }
    .metric:hover { border-color: var(--line-strong); }
    .metric-value { letter-spacing: 0; }
    .section {
      margin-bottom: 0;
      padding: 22px 0 26px;
      border: 0;
      border-top: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      scroll-margin-top: 82px;
    }
    .section-header h2 { font-size: 16px; letter-spacing: 0; }
    .table-wrap, .runtime-list, .config-grid, .result-list, .empty {
      border-radius: 6px;
      overflow: hidden;
    }
    .table-wrap { box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
    th { position: sticky; top: 0; z-index: 1; }
    .config-panel { background: var(--surface); }
    .result { transition: background 140ms ease; }
    .result:hover { background: var(--surface-muted); }
    .result-actions { display: flex; align-items: center; gap: 7px; }
    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 50; display: grid; gap: 8px; width: min(360px, calc(100vw - 36px)); }
    .toast {
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      background: var(--surface);
      color: var(--text);
      padding: 11px 13px;
      box-shadow: 0 16px 38px rgba(0,0,0,0.2);
      animation: toast-in 180ms ease-out;
    }
    .toast.good { border-color: var(--accent); }
    .toast.bad { border-color: var(--danger); }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
    @media (max-width: 1180px) {
      .metric-grid { grid-template-columns: repeat(4, minmax(130px, 1fr)); }
      .split { grid-template-columns: 1fr; }
      .config-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .config-panel:nth-child(2) { border-right: 0; }
      .config-panel:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
      .probe-form { grid-template-columns: 1fr 2fr 90px 110px 120px 104px; }
      .probe-form .button { grid-column: 1 / -1; justify-self: start; }
    }
    @media (max-width: 760px) {
      .topbar-inner { align-items: flex-start; flex-wrap: wrap; padding: 10px 14px; }
      .auth-form { order: 3; width: 100%; margin-left: 0; flex-wrap: wrap; }
      .auth-form input { flex: 1 1 160px; width: auto; min-width: 120px; }
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
      .page-heading { padding: 8px 0 18px; }
      .section { padding: 18px 0 22px; }
      .section-nav { display: none; }
      .result-head { align-items: flex-start; flex-direction: column; }
      .result-actions { width: 100%; justify-content: space-between; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      .skeleton, .loading-bar.active::after, .icon-button.spinning, .toast { animation: none; }
      .control, .button, .metric, .result, .loading-bar { transition: none; }
      .button:hover:not(:disabled) { transform: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#mainContent">Skip to main content</a>
  <div id="loadingBar" class="loading-bar" aria-hidden="true"></div>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><span class="brand-mark" aria-hidden="true">CE</span><span class="brand-copy"><strong>ContextEngine</strong><span>Observability</span></span></div>
      <div class="connection" role="status" aria-live="polite" aria-atomic="true"><span id="connectionDot" class="status-dot" aria-hidden="true"></span><span id="connectionText">Connecting</span></div>
      <label class="auto-refresh"><input id="autoRefresh" type="checkbox" checked> Auto refresh</label>
      <a class="top-link" href="/openapi.json" target="_blank" rel="noreferrer">API schema</a>
      <form id="authForm" class="auth-form">
        <input id="apiKey" class="control" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Bearer API key" aria-label="Bearer API key">
        <button id="toggleKey" class="button ghost compact" type="button" aria-label="Show API key">Show</button>
        <button class="button primary" type="submit">Connect</button>
        <button id="clearKey" class="button ghost" type="button">Clear</button>
        <button id="themeToggle" class="button icon-button" type="button" title="Use dark theme" aria-label="Use dark theme" aria-pressed="false">◐</button>
        <button id="refresh" class="button icon-button" type="button" title="Refresh dashboard" aria-label="Refresh dashboard">↻</button>
      </form>
    </div>
  </header>
  <main id="mainContent" tabindex="-1">
    <div id="notice" class="notice" role="alert"></div>
    <div class="page-heading">
      <div>
        <div class="eyebrow">Live operations console</div>
        <h1>Service overview</h1>
        <p class="subtitle">Index health, retrieval traffic, and runtime state.</p>
        <nav class="section-nav" aria-label="Dashboard sections"><a href="#health">Health</a><a href="#configuration">Configuration</a><a href="#workspaces">Workspaces</a><a href="#activity">Activity</a><a href="#probe">Retrieval probe</a></nav>
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
      <div class="metric"><div class="metric-label">MCP sessions</div><div id="mcpMetric" class="metric-value">--</div><div id="mcpDetail" class="metric-detail">Active durable sessions</div></div>
    </section>
    <section id="health" class="section split">
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
    <section id="configuration" class="section">
      <div class="section-header"><h2>Model &amp; runtime configuration</h2><span class="section-note">Applied to this process</span></div>
      <form id="modelConfigForm">
        <div class="config-grid">
          <div class="config-panel">
            <h3><span>Embedding</span><span id="embeddingState" class="badge neutral">--</span></h3>
            <label class="config-check"><input id="embeddingEnabled" type="checkbox" aria-label="Enable embedding"> Enabled</label>
            <div class="field"><label for="embeddingBaseUrl">Base URL</label><input id="embeddingBaseUrl" class="control" type="url" spellcheck="false" aria-label="Embedding base URL"></div>
            <div class="field"><label for="embeddingModel">Model</label><input id="embeddingModel" class="control" type="text" spellcheck="false" aria-label="Embedding model"></div>
            <div class="field"><label for="embeddingAuth">Authentication</label><select id="embeddingAuth" class="control" aria-label="Embedding authentication"><option value="bearer">Bearer</option><option value="none">None</option></select></div>
            <div class="field"><label for="embeddingApiKey">API key</label><input id="embeddingApiKey" class="control" type="password" autocomplete="new-password" spellcheck="false" aria-label="Embedding API key"></div>
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
              <button id="testEmbedding" class="button" type="button" aria-label="Test embedding connection">Test connection</button>
            </div>
          </div>
          <div class="config-panel">
            <h3><span>Reranker</span><span id="rerankerState" class="badge neutral">--</span></h3>
            <label class="config-check"><input id="rerankerEnabled" type="checkbox" aria-label="Enable reranker"> Enabled</label>
            <div class="field"><label for="rerankerBaseUrl">Base URL</label><input id="rerankerBaseUrl" class="control" type="url" spellcheck="false" aria-label="Reranker base URL"></div>
            <div class="field"><label for="rerankerModel">Model</label><input id="rerankerModel" class="control" type="text" spellcheck="false" aria-label="Reranker model"></div>
            <div class="field"><label for="rerankerAuth">Authentication</label><select id="rerankerAuth" class="control" aria-label="Reranker authentication"><option value="bearer">Bearer</option><option value="none">None</option></select></div>
            <div class="field"><label for="rerankerApiKey">API key</label><input id="rerankerApiKey" class="control" type="password" autocomplete="new-password" spellcheck="false" aria-label="Reranker API key"></div>
            <div id="rerankerKeyHelp" class="config-help">Leave blank to keep the current key.</div>
            <div class="config-field-grid">
              <div class="field"><label for="rerankerTopN">Top N</label><input id="rerankerTopN" class="control" type="number" min="2" max="64"></div>
              <div class="field"><label for="rerankerWeight">Weight</label><input id="rerankerWeight" class="control" type="number" min="0.05" max="0.85" step="0.01"></div>
            </div>
            <div class="field"><label for="rerankerMaxChars">Max document chars</label><input id="rerankerMaxChars" class="control" type="number" min="200"></div>
            <div class="field"><label for="rerankerInstruction">Instruction</label><textarea id="rerankerInstruction" class="control" rows="3"></textarea></div>
            <div class="model-test">
              <span id="rerankerTestStatus" class="model-test-status" aria-live="polite">Not tested</span>
              <button id="testReranker" class="button" type="button" aria-label="Test reranker connection">Test connection</button>
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
          <span id="configStatus" class="config-status" role="status" aria-live="polite" aria-atomic="true">Waiting for configuration.</span>
          <button id="saveConfiguration" class="button primary" type="submit">Apply configuration</button>
        </div>
      </form>
    </section>
    <section id="workspaces" class="section">
      <div class="section-header"><h2>Workspaces</h2><span id="workspaceNote" class="section-note">No workspaces loaded</span></div>
      <div id="workspaceTable" class="empty">Connect to load workspaces.</div>
    </section>
    <section id="activity" class="section split">
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
        <div class="field" id="probeModeField"><label for="probeMode">Mode</label><select id="probeMode" class="control"><option value="auto">Auto</option><option value="hybrid">Hybrid</option><option value="bm25">BM25</option><option value="semantic">Semantic</option></select></div>
        <div class="field"><label for="probeView">View</label><select id="probeView" class="control"><option value="hits">Ranked hits</option><option value="raw">Packed · raw</option><option value="extractive">Packed · extractive</option></select></div>
        <div class="field" id="probeMaxTokensField" hidden><label for="probeMaxTokens">Max tokens</label><input id="probeMaxTokens" class="control" type="number" min="1" max="128000" placeholder="uncapped"></div>
        <button id="probeSubmit" class="button primary" type="submit">Run search</button>
      </form>
      <div id="probeMeta" class="probe-meta" role="status" aria-live="polite" aria-atomic="true"></div>
      <div id="probeTrace" class="trace-panel" aria-live="polite"></div>
      <div id="probeResults" class="empty" aria-busy="false">No probe results yet.</div>
    </section>
  </main>
  <div id="toastStack" class="toast-stack" aria-label="Notifications" aria-live="polite" aria-atomic="false"></div>
  <script>
(function () {
  "use strict";
  var storageKey = "contextengine.dashboard.apiKey";
  var themeStorageKey = "contextengine.dashboard.theme";

  function readSessionToken() {
    try { return sessionStorage.getItem(storageKey) || ""; } catch (_) { return ""; }
  }

  function storeSessionToken(value) {
    try {
      if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey);
    } catch (_) { /* storage can be unavailable */ }
  }

  var state = { token: readSessionToken(), data: null, loading: false, refreshQueued: false, timer: null, configDirty: false };
  var byId = function (id) { return document.getElementById(id); };
  var numberFormatter = new Intl.NumberFormat();
  var apiKey = byId("apiKey");
  apiKey.value = state.token;

  function storedTheme() {
    try { return localStorage.getItem(themeStorageKey); } catch (_) { return null; }
  }

  function applyTheme(theme, persist) {
    var resolved = theme === "dark" ? "dark" : "light";
    var toggle = byId("themeToggle");
    document.documentElement.dataset.theme = resolved;
    toggle.textContent = resolved === "dark" ? "☀" : "◐";
    toggle.title = resolved === "dark" ? "Use light theme" : "Use dark theme";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(resolved === "dark"));
    if (persist) {
      try { localStorage.setItem(themeStorageKey, resolved); } catch (_) { /* storage can be unavailable */ }
    }
  }

  var colorScheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  applyTheme(storedTheme() || (colorScheme && colorScheme.matches ? "dark" : "light"), false);
  if (colorScheme && colorScheme.addEventListener) {
    colorScheme.addEventListener("change", function (event) {
      if (!storedTheme()) applyTheme(event.matches ? "dark" : "light", false);
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function number(value) {
    return numberFormatter.format(Number(value || 0));
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
    if (["online", "indexed", "current", "succeeded", "200", "enabled", "bearer"].indexOf(text) >= 0) tone = "good";
    else if (["queued", "running", "partial", "indexing", "stale", "building"].indexOf(text) >= 0) tone = "warn";
    else if (["failed", "offline", "error", "unavailable"].indexOf(text) >= 0) tone = "bad";
    else if (["blob", "local", "incremental", "rebuild", "none", "effective"].indexOf(text) >= 0) tone = "info";
    else if (["disabled_by_server"].indexOf(text) >= 0) tone = "warn";
    return "<span class=\"badge " + tone + "\">" + escapeHtml(text) + "</span>";
  }

  function setConnection(kind, text) {
    var className = "status-dot" + (kind ? " " + kind : "");
    if (byId("connectionDot").className !== className) byId("connectionDot").className = className;
    if (byId("connectionText").textContent !== text) byId("connectionText").textContent = text;
  }

  function showNotice(message) {
    var notice = byId("notice");
    var next = message || "";
    if (notice.textContent !== next) notice.textContent = next;
    notice.classList.toggle("visible", Boolean(next));
  }

  function toast(message, tone) {
    var node = document.createElement("div");
    node.className = "toast" + (tone ? " " + tone : "");
    node.textContent = message;
    byId("toastStack").appendChild(node);
    window.setTimeout(function () { node.remove(); }, 3200);
  }

  async function copyText(value) {
    var copied = false;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (_) {
      var input = document.createElement("textarea");
      var previousFocus = document.activeElement;
      input.value = value;
      input.setAttribute("readonly", "");
      input.setAttribute("aria-hidden", "true");
      input.setAttribute("tabindex", "-1");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
      input.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    toast(copied ? "Location copied" : "Could not copy location", copied ? "good" : "bad");
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
    var indexing = workspaces.filter(function (item) { return item.stats && item.stats.pendingRevision; }).length;
    var files = workspaces.reduce(function (sum, item) { return sum + Number(item.stats && item.stats.fileCount || 0); }, 0);
    var chunks = workspaces.reduce(function (sum, item) { return sum + Number(item.stats && item.stats.chunkCount || 0); }, 0);
    var activeJobs = (data.jobs || []).filter(function (job) { return job.status === "queued" || job.status === "running"; }).length;
    var mcp = data.mcp_sessions || {};
    byId("serviceMetric").textContent = "Online";
    byId("serviceDetail").textContent = uptime(data.service.uptime_seconds) + " uptime";
    byId("workspaceMetric").textContent = number(workspaces.length);
    byId("workspaceDetail").textContent = indexed + " indexed" + (indexing ? " · " + indexing + " indexing" : "");
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
    byId("mcpMetric").textContent = number(mcp.active);
    byId("mcpDetail").textContent = number(mcp.expired) + " expired · " + number(mcp.closed) + " closed";
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
    var mcp = data.mcp_sessions || {};

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
      ["MCP idle TTL", http.mcp_session_idle_ttl_ms == null ? "--" : duration(http.mcp_session_idle_ttl_ms)],
      ["MCP store", String(http.mcp_session_store || "--")],
      ["MCP sessions", number(mcp.active) + " active / " + (http.mcp_max_sessions == null ? "--" : number(http.mcp_max_sessions)) + " max"],
      ["MCP rejected", number(mcp.lookup_rejection) + " lookup · " + number(mcp.capacity_rejection) + " capacity"],
      ["CORS origins", number(http.cors_origins_count)],
      ["Local workspaces", http.local_workspaces ? "enabled" : "disabled"],
      ["Allowlist entries", number(http.local_root_allowlist_count)],
      ["Snapshot store", http.snapshot_store_configured ? "configured" : "disabled"],
      ["Replication targets", number(http.snapshot_replication_target_count)],
      ["Snapshot poll", http.snapshot_job_poll_interval_ms == null ? "--" : duration(http.snapshot_job_poll_interval_ms)],
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
    byId("routeTable").innerHTML = "<table><caption class=\"sr-only\">Route health</caption><thead><tr><th scope=\"col\">Method</th><th scope=\"col\">Route</th><th scope=\"col\" class=\"number\">Requests</th><th scope=\"col\">Errors</th><th scope=\"col\">P95</th></tr></thead><tbody>" + body + "</tbody></table>";
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
    var shortRevision = function (value) {
      if (value == null || value === "") return "--";
      var text = String(value);
      return text.length > 18 ? text.slice(0, 10) + "…" + text.slice(-6) : text;
    };
    var freshness = function (item, stats) {
      if (item.error) return "unavailable";
      if (!item.indexed) return "empty";
      if (stats.pendingRevision) return "indexing";
      if (item.workspace.source_mode === "blob" && stats.indexedRevision == null) return "unknown";
      if (item.workspace.source_mode === "blob" && String(stats.indexedRevision) !== String(item.workspace.revision)) return "stale";
      return "current";
    };
    var rows = workspaces.map(function (item) {
      var stats = item.stats || {};
      var status = freshness(item, stats);
      var source = item.sources && item.sources[0];
      var sourceCell = source
        ? badge(source.provider) + "<div class=\"truncate section-note\" title=\"" + escapeHtml(source.external_id) + "\">" + escapeHtml(source.external_id) + "</div><div class=\"section-note\">" + badge(source.status) + " · " + timeAgo(source.last_synced_at || source.updated_at) + "</div>"
        : badge(item.workspace.source_mode);
      var generation = stats.generationId ? "<div class=\"mono truncate section-note\" title=\"" + escapeHtml(stats.generationId) + "\">gen " + escapeHtml(shortRevision(stats.generationId)) + "</div>" : "";
      var syncButton = source ? "<button class=\"button sync-source\" type=\"button\" data-workspace=\"" + escapeHtml(item.workspace.id) + "\" data-source=\"" + escapeHtml(source.id) + "\" " + (source.status === "syncing" ? "disabled" : "") + ">Sync</button>" : "";
      return "<tr><td><strong>" + escapeHtml(item.workspace.name) + "</strong><div class=\"mono truncate section-note\">" + escapeHtml(item.workspace.id) + "</div></td><td>" + sourceCell + "</td><td>" + badge(status) + generation + "</td><td class=\"mono revision-cell\" title=\"" + escapeHtml(String(item.workspace.revision)) + "\">" + escapeHtml(shortRevision(item.workspace.revision)) + "</td><td class=\"mono revision-cell\" title=\"" + escapeHtml(String(stats.indexedRevision || "--")) + "\">" + escapeHtml(shortRevision(stats.indexedRevision)) + "</td><td class=\"number\">" + number(stats.fileCount) + "</td><td class=\"number\">" + number(stats.chunkCount) + "</td><td>" + timeAgo(stats.lastIndexedAt || source && source.last_synced_at || item.workspace.updated_at) + "</td><td><div class=\"button-row\">" + syncButton + "<button class=\"button probe-workspace\" type=\"button\" data-workspace=\"" + escapeHtml(item.workspace.id) + "\" aria-label=\"Probe " + escapeHtml(item.workspace.name) + "\" " + (item.indexed ? "" : "disabled") + ">Probe</button></div></td></tr>";
    }).join("");
    byId("workspaceTable").className = "table-wrap";
    byId("workspaceTable").innerHTML = "<table><caption class=\"sr-only\">Configured workspaces</caption><thead><tr><th scope=\"col\">Workspace</th><th scope=\"col\">Source</th><th scope=\"col\">Freshness</th><th scope=\"col\">Source rev</th><th scope=\"col\">Indexed rev</th><th scope=\"col\" class=\"number\">Files</th><th scope=\"col\" class=\"number\">Chunks</th><th scope=\"col\">Updated</th><th scope=\"col\"><span class=\"sr-only\">Actions</span></th></tr></thead><tbody>" + rows + "</tbody></table>";
    Array.prototype.forEach.call(document.querySelectorAll(".probe-workspace"), function (button) {
      button.addEventListener("click", function () { byId("probeWorkspace").value = button.dataset.workspace || ""; byId("probe").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }); byId("probeQuery").focus(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".sync-source"), function (button) {
      button.addEventListener("click", async function () {
        button.disabled = true;
        button.textContent = "Syncing";
        try {
          var result = await api("/v1/workspaces/" + encodeURIComponent(button.dataset.workspace || "") + "/sources/" + encodeURIComponent(button.dataset.source || "") + "/sync", { method: "POST" });
          toast(result.noop ? "Source is already current" : "Source sync queued", "good");
          await refresh(true);
        } catch (error) {
          toast(error.message, "bad");
          button.disabled = false;
          button.textContent = "Sync";
        }
      });
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
    byId("jobTable").innerHTML = "<table><caption class=\"sr-only\">Recent index jobs</caption><thead><tr><th scope=\"col\">Status</th><th scope=\"col\">Workspace</th><th scope=\"col\">Mode</th><th scope=\"col\">Phase</th><th scope=\"col\">Created</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderRequests(data) {
    var requests = data.requests.recent || [];
    if (!requests.length) { byId("requestTable").className = "empty"; byId("requestTable").textContent = "No requests observed."; return; }
    var rows = requests.slice(0, 18).map(function (request) {
      var tone = request.status >= 500 ? "bad" : request.status >= 400 ? "warn" : "good";
      return "<tr><td>" + escapeHtml(request.method) + "</td><td class=\"mono truncate\" title=\"" + escapeHtml(request.route) + "\">" + escapeHtml(request.route) + "</td><td><span class=\"badge " + tone + "\">" + escapeHtml(request.status) + "</span></td><td class=\"number\">" + duration(request.duration_ms) + "</td><td>" + timeAgo(request.started_at) + "</td></tr>";
    }).join("");
    byId("requestTable").className = "table-wrap";
    byId("requestTable").innerHTML = "<table><caption class=\"sr-only\">Recent requests</caption><thead><tr><th scope=\"col\">Method</th><th scope=\"col\">Route</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"number\">Time</th><th scope=\"col\">When</th></tr></thead><tbody>" + rows + "</tbody></table>";
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

  function setRefreshState(loading) {
    var button = byId("refresh");
    button.disabled = loading;
    button.classList.toggle("spinning", loading);
    button.setAttribute("aria-busy", String(loading));
    button.setAttribute("aria-label", loading ? "Refreshing dashboard" : "Refresh dashboard");
    button.title = loading ? "Refreshing dashboard" : "Refresh dashboard";
    byId("loadingBar").classList.toggle("active", loading);
  }

  async function refresh(queueIfBusy) {
    if (state.loading) {
      if (queueIfBusy === true) state.refreshQueued = true;
      return;
    }
    state.loading = true;
    setRefreshState(true);
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
      setRefreshState(false);
      if (state.refreshQueued) {
        state.refreshQueued = false;
        void refresh();
      }
    }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (byId("autoRefresh").checked && !document.hidden) state.timer = setInterval(refresh, 5000);
  }

  byId("authForm").addEventListener("submit", function (event) {
    event.preventDefault();
    state.token = apiKey.value.trim();
    storeSessionToken(state.token);
    refresh(true);
  });
  byId("clearKey").addEventListener("click", function () { state.token = ""; apiKey.value = ""; apiKey.type = "password"; storeSessionToken(""); byId("toggleKey").textContent = "Show"; byId("toggleKey").setAttribute("aria-label", "Show API key"); toast("API key cleared"); refresh(true); });
  byId("toggleKey").addEventListener("click", function () {
    var reveal = apiKey.type === "password";
    apiKey.type = reveal ? "text" : "password";
    byId("toggleKey").textContent = reveal ? "Hide" : "Show";
    byId("toggleKey").setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
  });
  byId("themeToggle").addEventListener("click", function () {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
  });
  byId("refresh").addEventListener("click", function () { refresh(true); });
  byId("autoRefresh").addEventListener("change", schedule);
  byId("probeView").addEventListener("change", function () {
    var isPacked = byId("probeView").value !== "hits";
    byId("probeMaxTokensField").hidden = !isPacked;
    byId("probeModeField").hidden = isPacked;
  });
  (function () {
    var isPacked = byId("probeView").value !== "hits";
    byId("probeMaxTokensField").hidden = !isPacked;
    byId("probeModeField").hidden = isPacked;
  })();

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
      toast((isEmbedding ? "Embedding" : "Reranker") + " connection is healthy", "good");
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
      toast(result.reindex_required ? "Configuration applied — reindex required" : "Configuration applied", result.reindex_required ? "" : "good");
      setTimeout(refresh, 150);
    } catch (error) {
      byId("configStatus").className = "config-status bad";
      byId("configStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function renderChannels(result) {
    var channels = result.channels;
    if (!channels) return "";
    var order = ["fts", "symbol", "path", "semantic", "graph", "neural"];
    var labels = { fts: "keyword", symbol: "symbol", path: "path", semantic: "semantic", graph: "graph", neural: "neural" };
    var known = new Set(order);
    var allKeys = order.filter(function (name) { return channels[name] != null; })
      .concat(Object.keys(channels).filter(function (name) { return !known.has(name) && channels[name] != null; }));
    var chips = allKeys.map(function (name) {
      var pct = Math.round(Math.max(0, Math.min(1, Number(channels[name]))) * 100);
      return "<span class=\"channel-chip\" title=\"" + escapeHtml(name) + " score " + Number(channels[name]).toFixed(3) + "\">" + escapeHtml(labels[name] || name) + " <span class=\"channel-pct\">" + pct + "%</span></span>";
    });
    (result.degraded_channels || []).forEach(function (name) {
      chips.push("<span class=\"channel-chip warn\" title=\"" + escapeHtml(name) + " channel degraded\">" + escapeHtml(name) + " degraded</span>");
    });
    if (!chips.length) return "";
    return "<div class=\"channel-chips\">" + chips.join("") + "</div>";
  }

  function renderTrace(trace, tokenBudget) {
    var panel = byId("probeTrace");
    if (!trace) { panel.className = "trace-panel"; panel.innerHTML = ""; return; }
    var channelChips = (trace.channels || []).map(function (name) {
      return "<span class=\"trace-chip\">" + escapeHtml(name) + "</span>";
    }).join("");
    var degradedChips = (trace.degradedChannels || trace.degraded_channels || []).map(function (name) {
      return "<span class=\"trace-chip warn\">" + escapeHtml(name) + "</span>";
    }).join("");
    var conceptChips = (trace.concepts || []).slice(0, 12).map(function (name) {
      return "<span class=\"trace-chip\">" + escapeHtml(name) + "</span>";
    }).join("");
    var ruleChips = (trace.rules || []).map(function (rule) {
      var tone = rule.scope === "always" ? "" : " warn";
      return "<span class=\"trace-chip" + tone + "\" title=\"" + escapeHtml(rule.path) + " (" + escapeHtml(rule.scope) + ")\">" + escapeHtml(rule.path) + "</span>";
    }).join("");
    var candidateCount = trace.candidateCount == null ? trace.candidate_count : trace.candidateCount;
    var packedCount = trace.packedCount == null ? trace.packed_count : trace.packedCount;
    var fileCount = trace.fileCount == null ? trace.file_count : trace.fileCount;
    var generationId = trace.generationId || trace.generation_id;
    var estTokens = Number(trace.estimatedTokens == null ? trace.estimated_tokens : trace.estimatedTokens) || 0;
    var items = [
      ["Intent", escapeHtml(trace.intent || "--")],
      ["Packing", escapeHtml(trace.packing || "raw")],
      ["Candidates", number(candidateCount) + " → " + number(packedCount) + " packed"],
      ["Files", number(fileCount)],
    ];
    if (tokenBudget && tokenBudget > 0) {
      var pct = Math.min(100, Math.round((estTokens / tokenBudget) * 100));
      var tone = pct >= 100 ? " over" : pct >= 80 ? " near" : "";
      items.push(["Token budget", number(estTokens) + " / " + number(tokenBudget) + (trace.truncated ? " · capped" : "") + "<div class=\"budget-track\"><div class=\"budget-fill" + tone + "\" style=\"width:" + pct + "%\"></div></div>"]);
    } else {
      items.push(["Est. tokens", number(estTokens) + (trace.truncated ? " · capped" : "")]);
    }
    items.push(["Channels", "<div class=\"trace-chips\">" + (channelChips || "<span class=\"section-note\">none</span>") + "</div>"]);
    if (conceptChips) items.push(["Understood", "<div class=\"trace-chips\">" + conceptChips + "</div>"]);
    if (ruleChips) items.push(["Rules", "<div class=\"trace-chips\">" + ruleChips + "</div>"]);
    if (degradedChips) items.push(["Degraded", "<div class=\"trace-chips\">" + degradedChips + "</div>"]);
    if (generationId) items.push(["Generation", "<span class=\"mono\">" + escapeHtml(String(generationId).slice(0, 12)) + "</span>"]);
    panel.className = "trace-panel visible";
    panel.innerHTML = "<div class=\"trace-grid\">" + items.map(function (row) {
      return "<div class=\"trace-item\"><div class=\"trace-key\">" + row[0] + "</div><div class=\"trace-value\">" + row[1] + "</div></div>";
    }).join("") + "</div>";
  }

  byId("probeForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    var workspaceId = byId("probeWorkspace").value;
    var query = byId("probeQuery").value.trim();
    if (!workspaceId || !query) return;
    var view = byId("probeView").value;
    var button = byId("probeSubmit");
    button.disabled = true;
    byId("probeResults").setAttribute("aria-busy", "true");
    byId("probeMeta").textContent = view === "hits" ? "Searching..." : "Packing context...";
    renderTrace(null);
    var started = performance.now();
    try {
      if (view === "hits") {
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
            return "<article class=\"result\"><div class=\"result-head\"><div class=\"result-path mono\" title=\"" + escapeHtml(label) + "\">" + escapeHtml(label) + "</div><div class=\"result-actions\"><div class=\"result-score\">" + escapeHtml(result.source) + " / " + Number(result.score || 0).toFixed(4) + "</div><button class=\"button ghost compact copy-result\" type=\"button\" data-copy=\"" + escapeHtml(label) + "\" aria-label=\"Copy location " + escapeHtml(label) + "\">Copy</button></div></div>" + renderChannels(result) + "<div class=\"result-preview\">" + escapeHtml(result.preview || result.content || "") + "</div></article>";
          }).join("");
          Array.prototype.forEach.call(document.querySelectorAll(".copy-result"), function (button) {
            button.addEventListener("click", function () { void copyText(button.dataset.copy || ""); });
          });
        }
      } else {
        var maxTokensRaw = Number(byId("probeMaxTokens").value);
        var contextBody = { information_request: query, top_k: Number(byId("probeTopK").value || 8), packing: view };
        if (maxTokensRaw > 0) contextBody.max_tokens = Math.floor(maxTokensRaw);
        var packed = await api("/v1/workspaces/" + encodeURIComponent(workspaceId) + "/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(contextBody)
        });
        var packedElapsed = performance.now() - started;
        byId("probeMeta").textContent = (packed.hits ? packed.hits.length : 0) + " passages packed in " + duration(packedElapsed);
        renderTrace(packed.trace, maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : null);
        var text = packed.packed_text || "";
        if (!text) { byId("probeResults").className = "empty"; byId("probeResults").textContent = "No context packed."; }
        else {
          byId("probeResults").className = "";
          byId("probeResults").innerHTML = "<div class=\"result-head\" style=\"margin-bottom:8px\"><div class=\"section-note\">Packed context (" + escapeHtml(view) + ")</div><button class=\"button ghost compact copy-result\" type=\"button\" data-copy-packed=\"1\" aria-label=\"Copy packed context\">Copy all</button></div><div class=\"packed-block\">" + escapeHtml(text) + "</div>";
          var copyPacked = byId("probeResults").querySelector("[data-copy-packed]");
          if (copyPacked) copyPacked.addEventListener("click", function () { void copyText(text); });
        }
      }
      setTimeout(refresh, 150);
    } catch (error) {
      byId("probeMeta").textContent = view === "hits" ? "Search failed" : "Packing failed";
      renderTrace(null);
      byId("probeResults").className = "empty";
      byId("probeResults").textContent = error.message;
    } finally { button.disabled = false; byId("probeResults").setAttribute("aria-busy", "false"); }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      return;
    }
    schedule();
    refresh();
  });
  document.addEventListener("keydown", function (event) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      event.preventDefault();
      byId("probeQuery").focus();
      byId("probe").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  schedule();
  refresh();
})();
  </script>
</body>
</html>`;
}
