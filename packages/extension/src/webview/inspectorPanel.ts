import * as vscode from 'vscode';
import type {
  InspectorDataRequest,
  InspectorDataResponse,
} from '@tsgo-turbo/shared';
import { CustomMethods } from '@tsgo-turbo/shared';
import type { LspClient } from '../client.js';
import type { ClientLogger } from '../logger.js';

/** Interval (ms) between automatic data refreshes while the panel is visible. */
const AUTO_REFRESH_INTERVAL_MS = 2_000;

/**
 * Messages sent **from** the webview to the extension host.
 */
interface WebviewMessage {
  type:
    | 'refresh'
    | 'clearCache'
    | 'setFilter'
    | 'copyJson'
    | 'analyzeFile';
  payload?: unknown;
}

/**
 * InspectorPanel manages a VS Code WebviewPanel that provides a rich,
 * interactive dashboard for debugging and performance analysis of the
 * tsgo Turbo LSP server.
 *
 * Sections:
 * 1. **Server Status** — uptime, memory footprint, active process count.
 * 2. **Performance Traces** — flamegraph-style nested bars of recent spans.
 * 3. **Cache Stats** — hit rate, entry count, size, with a clear button.
 * 4. **Diagnostics Browser** — filterable, sortable diagnostic table.
 * 5. **Type Expansion Inspector** — truncated type expansion paths.
 * 6. **Active Processes** — live table of tsgo/oxc child processes.
 * 7. **Configuration** — current effective configuration dump.
 *
 * The panel auto-refreshes every 2 seconds while visible and communicates
 * with the extension host via `postMessage` / `onDidReceiveMessage`.
 */
export class InspectorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: LspClient,
    private readonly logger: ClientLogger,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create or reveal the inspector panel. If the panel already exists it
   * is brought to the foreground; otherwise a new WebviewPanel is created.
   */
  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'tsgoTurboInspector',
      'tsgo Turbo Inspector',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml();

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );

    // Start auto-refresh when visible, stop when hidden
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel?.visible) {
          this.startAutoRefresh();
        } else {
          this.stopAutoRefresh();
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.stopAutoRefresh();
        this.panel = undefined;
      },
      undefined,
      this.disposables,
    );

    this.startAutoRefresh();
    // Send initial data immediately
    void this.refresh();
  }

  /**
   * Push a one-off data update to the webview (e.g. when a notification
   * arrives from the server outside the refresh cycle).
   */
  pushUpdate(data: Partial<InspectorDataResponse>): void {
    this.postToWebview('partialUpdate', data);
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals — data flow
  // ---------------------------------------------------------------------------

  /** Fetch full inspector data from the server and push it to the webview. */
  private async refresh(): Promise<void> {
    if (!this.client.isRunning) {
      this.postToWebview('serverOffline', {});
      return;
    }

    try {
      const data = await this.client.sendCustomRequest<InspectorDataResponse>(
        CustomMethods.inspectorData,
        {
          includeTraces: true,
          includeCache: true,
          includeDiagnostics: true,
        } satisfies InspectorDataRequest,
      );
      this.postToWebview('fullUpdate', data);
    } catch (err) {
      this.logger.debug('Inspector refresh failed', { error: String(err) });
      this.postToWebview('refreshError', { error: String(err) });
    }
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => void this.refresh(), AUTO_REFRESH_INTERVAL_MS);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** Handle an inbound message from the webview. */
  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'refresh':
        await this.refresh();
        break;

      case 'clearCache':
        try {
          await this.client.sendCustomRequest(CustomMethods.clearCache, {});
          this.logger.info('Cache cleared from inspector');
          await this.refresh();
        } catch (err) {
          this.logger.error('clearCache from inspector failed', { error: String(err) });
        }
        break;

      case 'analyzeFile': {
        await vscode.commands.executeCommand('tsgoTurbo.analyzeFile');
        break;
      }

      case 'copyJson': {
        const json = JSON.stringify(msg.payload, null, 2);
        await vscode.env.clipboard.writeText(json);
        void vscode.window.showInformationMessage('tsgo Turbo: Copied to clipboard');
        break;
      }

      default:
        this.logger.debug('Unknown webview message', { type: msg.type });
    }
  }

  /** Post a typed message to the webview. */
  private postToWebview(type: string, payload: unknown): void {
    if (this.panel) {
      void this.panel.webview.postMessage({ type, payload });
    }
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

  /**
   * Generate the complete self-contained HTML document for the inspector
   * webview. All CSS and JS is inlined.
   */
  private getHtml(): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>tsgo Turbo Inspector</title>
  <style nonce="${nonce}">
    /* ------------------------------------------------------------------ */
    /* CSS Custom Properties — VS Code theme-aware palette                */
    /* ------------------------------------------------------------------ */
    :root {
      --bg-primary: var(--vscode-editor-background, #1e1e1e);
      --bg-secondary: var(--vscode-sideBar-background, #252526);
      --bg-card: var(--vscode-editorWidget-background, #2d2d30);
      --bg-hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --text-primary: var(--vscode-editor-foreground, #cccccc);
      --text-secondary: var(--vscode-descriptionForeground, #9e9e9e);
      --text-muted: var(--vscode-disabledForeground, #6e6e6e);
      --border: var(--vscode-panel-border, #3c3c3c);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --accent-hover: var(--vscode-textLink-activeForeground, #3794ff);
      --success: #4ec9b0;
      --warning: #cca700;
      --error: #f44747;
      --info: #75beff;
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-border: var(--vscode-input-border, #5a5a5a);
      --button-bg: var(--vscode-button-background, #0e639c);
      --button-fg: var(--vscode-button-foreground, #ffffff);
      --button-hover: var(--vscode-button-hoverBackground, #1177bb);
      --scrollbar: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
      --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace);
      --font-size: var(--vscode-editor-font-size, 13px);
      --radius: 4px;
    }

    /* ------------------------------------------------------------------ */
    /* Reset & Base                                                        */
    /* ------------------------------------------------------------------ */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--font-size);
      color: var(--text-primary);
      background: var(--bg-primary);
      line-height: 1.5;
      overflow-y: auto;
      padding: 16px;
    }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }

    /* ------------------------------------------------------------------ */
    /* Layout                                                              */
    /* ------------------------------------------------------------------ */
    .inspector-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .full-width { grid-column: 1 / -1; }

    /* ------------------------------------------------------------------ */
    /* Header                                                              */
    /* ------------------------------------------------------------------ */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header .logo {
      width: 20px; height: 20px;
      background: var(--accent);
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 11px;
      color: #fff;
    }
    .header-actions { display: flex; gap: 6px; }

    /* ------------------------------------------------------------------ */
    /* Cards                                                               */
    /* ------------------------------------------------------------------ */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }
    .card-header .badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .card-body { padding: 12px; }

    /* ------------------------------------------------------------------ */
    /* Buttons                                                             */
    /* ------------------------------------------------------------------ */
    button, .btn {
      background: var(--button-bg);
      color: var(--button-fg);
      border: none;
      padding: 4px 10px;
      border-radius: var(--radius);
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
      transition: background 0.15s;
    }
    button:hover, .btn:hover { background: var(--button-hover); }
    button.secondary {
      background: var(--input-bg);
      color: var(--text-primary);
      border: 1px solid var(--input-border);
    }
    button.secondary:hover { background: var(--bg-hover); }
    button.danger { background: var(--error); }
    button.danger:hover { opacity: 0.85; }

    /* ------------------------------------------------------------------ */
    /* Stat Rows                                                           */
    /* ------------------------------------------------------------------ */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
    .stat-item {
      padding: 8px;
      background: var(--bg-secondary);
      border-radius: var(--radius);
      text-align: center;
    }
    .stat-item .value {
      font-size: 20px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--accent);
    }
    .stat-item .label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 2px;
    }

    /* ------------------------------------------------------------------ */
    /* Status Indicator                                                     */
    /* ------------------------------------------------------------------ */
    .status-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .status-dot.ready    { background: var(--success); }
    .status-dot.busy     { background: var(--warning); animation: pulse 1s infinite; }
    .status-dot.starting { background: var(--info); animation: pulse 1s infinite; }
    .status-dot.error    { background: var(--error); }
    .status-dot.degraded { background: var(--warning); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ------------------------------------------------------------------ */
    /* Performance Trace Flamegraph                                        */
    /* ------------------------------------------------------------------ */
    .trace-container { max-height: 300px; overflow-y: auto; }
    .trace-bar-row {
      position: relative;
      height: 22px;
      margin-bottom: 2px;
    }
    .trace-bar {
      position: absolute;
      top: 0;
      height: 20px;
      border-radius: 2px;
      font-size: 10px;
      line-height: 20px;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      cursor: default;
      transition: opacity 0.15s;
      min-width: 2px;
    }
    .trace-bar:hover { opacity: 0.8; }
    .trace-bar.depth-0 { background: #264f78; color: #9cdcfe; }
    .trace-bar.depth-1 { background: #305070; color: #a8d4f0; }
    .trace-bar.depth-2 { background: #3a5a4a; color: #4ec9b0; }
    .trace-bar.depth-3 { background: #5a4a30; color: #dcdcaa; }
    .trace-bar.depth-4 { background: #5a3030; color: #f48771; }
    .trace-bar.depth-5 { background: #4a3060; color: #c586c0; }

    /* ------------------------------------------------------------------ */
    /* Tables                                                              */
    /* ------------------------------------------------------------------ */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .data-table th, .data-table td {
      padding: 4px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .data-table th {
      background: var(--bg-secondary);
      color: var(--text-secondary);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .data-table tr:hover td { background: var(--bg-hover); }
    .data-table .mono { font-family: var(--font-mono); font-size: 11px; }

    /* ------------------------------------------------------------------ */
    /* Filter Bar                                                          */
    /* ------------------------------------------------------------------ */
    .filter-bar {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      align-items: center;
    }
    .filter-bar input, .filter-bar select {
      background: var(--input-bg);
      color: var(--text-primary);
      border: 1px solid var(--input-border);
      padding: 3px 8px;
      border-radius: var(--radius);
      font-size: 12px;
      font-family: inherit;
    }
    .filter-bar input:focus, .filter-bar select:focus {
      outline: none;
      border-color: var(--accent);
    }
    .filter-bar input { flex: 1; }

    /* Severity badges */
    .severity { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .severity.error   { background: rgba(244,71,71,.2); color: var(--error); }
    .severity.warning { background: rgba(204,167,0,.2); color: var(--warning); }
    .severity.info    { background: rgba(117,190,255,.2); color: var(--info); }
    .severity.hint    { background: rgba(78,201,176,.2); color: var(--success); }

    /* Source badges */
    .source-badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
    .source-badge.tsgo { background: rgba(55,148,255,.15); color: var(--accent); }
    .source-badge.oxc  { background: rgba(78,201,176,.15); color: var(--success); }

    /* ------------------------------------------------------------------ */
    /* Type Expansion                                                      */
    /* ------------------------------------------------------------------ */
    .expansion-path {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 6px 8px;
      background: var(--bg-secondary);
      border-radius: var(--radius);
      margin-bottom: 6px;
      overflow-x: auto;
      white-space: nowrap;
    }
    .expansion-path .arrow { color: var(--text-muted); margin: 0 4px; }
    .expansion-path .truncated { color: var(--error); font-weight: 600; }
    .expansion-depth-bar {
      height: 4px;
      border-radius: 2px;
      background: var(--input-bg);
      margin-top: 4px;
      overflow: hidden;
    }
    .expansion-depth-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }

    /* ------------------------------------------------------------------ */
    /* Config View                                                         */
    /* ------------------------------------------------------------------ */
    .config-json {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg-secondary);
      padding: 10px;
      border-radius: var(--radius);
      max-height: 300px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
    }

    /* ------------------------------------------------------------------ */
    /* Scrollable containers                                               */
    /* ------------------------------------------------------------------ */
    .scroll-y { max-height: 260px; overflow-y: auto; }

    /* ------------------------------------------------------------------ */
    /* Empty / Offline States                                              */
    /* ------------------------------------------------------------------ */
    .empty-state {
      text-align: center;
      padding: 24px 12px;
      color: var(--text-muted);
      font-size: 12px;
    }
    .offline-banner {
      background: rgba(244,71,71,.1);
      border: 1px solid var(--error);
      border-radius: var(--radius);
      padding: 10px 14px;
      margin-bottom: 12px;
      color: var(--error);
      font-weight: 500;
      text-align: center;
    }

    /* ------------------------------------------------------------------ */
    /* Responsive                                                          */
    /* ------------------------------------------------------------------ */
    @media (max-width: 600px) {
      .inspector-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <h1><span class="logo">T</span> tsgo Turbo Inspector</h1>
    <div class="header-actions">
      <button id="btn-refresh" class="secondary" title="Refresh now">Refresh</button>
      <button id="btn-copy-all" class="secondary" title="Copy full data as JSON">Copy JSON</button>
    </div>
  </div>

  <div id="offline-banner" class="offline-banner" style="display:none;">
    Server is offline. Waiting for connection...
  </div>

  <div class="inspector-grid">

    <!-- ================================================================ -->
    <!-- 1. Server Status                                                 -->
    <!-- ================================================================ -->
    <div class="card full-width">
      <div class="card-header">
        <span><span id="status-dot" class="status-dot starting"></span>Server Status</span>
        <span class="badge" id="status-label">Starting</span>
      </div>
      <div class="card-body">
        <div class="stat-grid" id="server-stats">
          <div class="stat-item"><div class="value" id="stat-uptime">--</div><div class="label">Uptime</div></div>
          <div class="stat-item"><div class="value" id="stat-files">0</div><div class="label">Files Analyzed</div></div>
          <div class="stat-item"><div class="value" id="stat-active-ops">0</div><div class="label">Active Ops</div></div>
          <div class="stat-item"><div class="value" id="stat-processes">0</div><div class="label">Processes</div></div>
          <div class="stat-item"><div class="value" id="stat-diagnostics">0</div><div class="label">Diagnostics</div></div>
          <div class="stat-item"><div class="value" id="stat-memory">--</div><div class="label">Memory (MB)</div></div>
        </div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 2. Performance Traces                                            -->
    <!-- ================================================================ -->
    <div class="card full-width">
      <div class="card-header">
        <span>Performance Traces</span>
        <span class="badge" id="trace-count">0</span>
      </div>
      <div class="card-body">
        <div id="trace-container" class="trace-container">
          <div class="empty-state">No traces recorded yet</div>
        </div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 3. Cache Stats                                                   -->
    <!-- ================================================================ -->
    <div class="card">
      <div class="card-header">
        <span>Cache</span>
        <button id="btn-clear-cache" class="danger" style="font-size:10px;padding:2px 8px;">Clear</button>
      </div>
      <div class="card-body">
        <div class="stat-grid" id="cache-stats">
          <div class="stat-item"><div class="value" id="cache-hit-rate">--%</div><div class="label">Hit Rate</div></div>
          <div class="stat-item"><div class="value" id="cache-entries">0</div><div class="label">Entries</div></div>
          <div class="stat-item"><div class="value" id="cache-size">0</div><div class="label">Size (MB)</div></div>
          <div class="stat-item"><div class="value" id="cache-evictions">0</div><div class="label">Evictions</div></div>
        </div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 5. Type Expansion Inspector                                      -->
    <!-- ================================================================ -->
    <div class="card">
      <div class="card-header">
        <span>Type Expansions</span>
        <span class="badge" id="expansion-count">0</span>
      </div>
      <div class="card-body scroll-y" id="expansion-container">
        <div class="empty-state">No truncated type expansions</div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 4. Diagnostics Browser                                           -->
    <!-- ================================================================ -->
    <div class="card full-width">
      <div class="card-header">
        <span>Diagnostics</span>
        <span class="badge" id="diag-count">0</span>
      </div>
      <div class="card-body">
        <div class="filter-bar">
          <input type="text" id="diag-filter" placeholder="Filter by message or file..." />
          <select id="diag-severity-filter">
            <option value="all">All severities</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
            <option value="hint">Hint</option>
          </select>
          <select id="diag-source-filter">
            <option value="all">All sources</option>
            <option value="tsgo">tsgo</option>
            <option value="oxc">oxc</option>
          </select>
        </div>
        <div class="scroll-y">
          <table class="data-table" id="diag-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Source</th>
                <th>File</th>
                <th>Loc</th>
                <th>Message</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody id="diag-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 6. Active Processes                                              -->
    <!-- ================================================================ -->
    <div class="card full-width">
      <div class="card-header">
        <span>Active Processes</span>
        <span class="badge" id="process-count">0</span>
      </div>
      <div class="card-body">
        <div class="scroll-y">
          <table class="data-table" id="process-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>PID</th>
                <th>Memory (MB)</th>
                <th>CPU %</th>
                <th>Active File</th>
                <th>Uptime</th>
              </tr>
            </thead>
            <tbody id="process-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ================================================================ -->
    <!-- 7. Configuration                                                 -->
    <!-- ================================================================ -->
    <div class="card full-width">
      <div class="card-header">
        <span>Effective Configuration</span>
        <button id="btn-copy-config" class="secondary" style="font-size:10px;padding:2px 8px;">Copy</button>
      </div>
      <div class="card-body">
        <pre class="config-json" id="config-json">Loading...</pre>
      </div>
    </div>
  </div>

  <!-- ================================================================== -->
  <!-- Inline JavaScript                                                  -->
  <!-- ================================================================== -->
  <script nonce="${nonce}">
    // Acquire the VS Code API handle
    const vscode = acquireVsCodeApi();

    // ---- State -----------------------------------------------------------
    let currentData = null;

    // ---- DOM refs --------------------------------------------------------
    const $id = (id) => document.getElementById(id);

    // ---- Message sending -------------------------------------------------
    function send(type, payload) {
      vscode.postMessage({ type, payload });
    }

    // ---- Button handlers -------------------------------------------------
    $id('btn-refresh').addEventListener('click', () => send('refresh'));
    $id('btn-clear-cache').addEventListener('click', () => send('clearCache'));
    $id('btn-copy-all').addEventListener('click', () => {
      if (currentData) send('copyJson', currentData);
    });
    $id('btn-copy-config').addEventListener('click', () => {
      if (currentData && currentData.config) send('copyJson', currentData.config);
    });

    // ---- Filter handlers -------------------------------------------------
    $id('diag-filter').addEventListener('input', renderDiagnostics);
    $id('diag-severity-filter').addEventListener('change', renderDiagnostics);
    $id('diag-source-filter').addEventListener('change', renderDiagnostics);

    // ---- Message receiver ------------------------------------------------
    window.addEventListener('message', (event) => {
      const { type, payload } = event.data;
      switch (type) {
        case 'fullUpdate':
          currentData = payload;
          renderAll(payload);
          $id('offline-banner').style.display = 'none';
          break;
        case 'partialUpdate':
          if (currentData) {
            Object.assign(currentData, payload);
            renderAll(currentData);
          }
          break;
        case 'serverOffline':
          $id('offline-banner').style.display = 'block';
          $id('status-dot').className = 'status-dot error';
          $id('status-label').textContent = 'Offline';
          break;
        case 'refreshError':
          // Silently ignore — will retry on next cycle
          break;
      }
    });

    // ---- Render functions ------------------------------------------------
    function renderAll(data) {
      renderServerStatus(data);
      renderTraces(data.traces || []);
      renderCacheStats(data.cacheStats);
      renderDiagnostics();
      renderProcesses(data.activeProcesses || []);
      renderExpansions(data.diagnostics || []);
      renderConfig(data.config);
    }

    function renderServerStatus(data) {
      const status = data._serverStatus || 'ready';
      $id('status-dot').className = 'status-dot ' + status;
      $id('status-label').textContent = status.charAt(0).toUpperCase() + status.slice(1);
      $id('stat-uptime').textContent = formatUptime(data.serverUptime || 0);
      $id('stat-files').textContent = String(data.filesAnalyzed || 0);
      $id('stat-diagnostics').textContent = String((data.diagnostics || []).length);
      $id('stat-processes').textContent = String((data.activeProcesses || []).length);
      $id('stat-active-ops').textContent = String(data._activeOps || 0);

      const totalMem = (data.activeProcesses || []).reduce((sum, p) => sum + (p.memoryMb || 0), 0);
      $id('stat-memory').textContent = totalMem > 0 ? totalMem.toFixed(0) : '--';
    }

    // ---- Performance Traces (flamegraph) --------------------------------
    function renderTraces(spans) {
      const container = $id('trace-container');
      $id('trace-count').textContent = String(spans.length);

      if (!spans.length) {
        container.innerHTML = '<div class="empty-state">No traces recorded yet</div>';
        return;
      }

      // Flatten the span tree with depth information
      const rows = [];
      function flatten(span, depth) {
        rows.push({ span, depth });
        if (span.children) {
          for (const child of span.children) {
            flatten(child, depth + 1);
          }
        }
      }
      // Only show latest 20 root spans
      const recent = spans.slice(-20);
      for (const s of recent) {
        flatten(s, 0);
      }

      // Find the global time range across displayed spans
      let globalStart = Infinity, globalEnd = -Infinity;
      for (const { span } of rows) {
        if (span.startTime < globalStart) globalStart = span.startTime;
        const end = span.endTime || (span.startTime + (span.durationMs || 0));
        if (end > globalEnd) globalEnd = end;
      }
      const totalRange = globalEnd - globalStart || 1;

      let html = '';
      for (const { span, depth } of rows) {
        const start = span.startTime - globalStart;
        const dur = span.durationMs || (span.endTime ? span.endTime - span.startTime : 0);
        const leftPct = (start / totalRange) * 100;
        const widthPct = Math.max((dur / totalRange) * 100, 0.5);
        const depthClass = 'depth-' + Math.min(depth, 5);
        const label = span.name + (dur > 0 ? ' (' + dur.toFixed(1) + 'ms)' : '');
        const tooltip = span.name + '\\nDuration: ' + dur.toFixed(2) + 'ms'
          + (span.metadata ? '\\n' + JSON.stringify(span.metadata) : '');
        html += '<div class="trace-bar-row">'
          + '<div class="trace-bar ' + depthClass + '" '
          + 'style="left:' + leftPct.toFixed(2) + '%;width:' + widthPct.toFixed(2) + '%;" '
          + 'title="' + escHtml(tooltip) + '">'
          + escHtml(label) + '</div></div>';
      }
      container.innerHTML = html;
    }

    // ---- Cache Stats -----------------------------------------------------
    function renderCacheStats(stats) {
      if (!stats) return;
      $id('cache-hit-rate').textContent = (stats.hitRate * 100).toFixed(1) + '%';
      $id('cache-entries').textContent = String(stats.totalEntries);
      $id('cache-size').textContent = (stats.totalSizeBytes / (1024 * 1024)).toFixed(1);
      $id('cache-evictions').textContent = String(stats.evictionCount);
    }

    // ---- Diagnostics Browser ---------------------------------------------
    function renderDiagnostics() {
      if (!currentData) return;
      const diags = currentData.diagnostics || [];
      const filterText = ($id('diag-filter').value || '').toLowerCase();
      const severityFilter = $id('diag-severity-filter').value;
      const sourceFilter = $id('diag-source-filter').value;

      const filtered = diags.filter((d) => {
        if (severityFilter !== 'all' && d.severity !== severityFilter) return false;
        if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
        if (filterText) {
          const hay = (d.message + ' ' + d.file).toLowerCase();
          if (!hay.includes(filterText)) return false;
        }
        return true;
      });

      $id('diag-count').textContent = String(filtered.length);

      const tbody = $id('diag-tbody');
      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No diagnostics match filters</td></tr>';
        return;
      }

      let html = '';
      for (const d of filtered.slice(0, 500)) {
        const fileName = d.file.split('/').pop() || d.file;
        html += '<tr>'
          + '<td><span class="severity ' + safeClass(d.severity) + '">' + escHtml(d.severity) + '</span></td>'
          + '<td><span class="source-badge ' + safeClass(d.source) + '">' + escHtml(d.source) + '</span></td>'
          + '<td title="' + escHtml(d.file) + '">' + escHtml(fileName) + '</td>'
          + '<td class="mono">' + d.line + ':' + d.column + '</td>'
          + '<td>' + escHtml(d.message) + '</td>'
          + '<td class="mono">' + d.computeTimeMs + 'ms</td>'
          + '</tr>';
      }
      tbody.innerHTML = html;
    }

    // ---- Active Processes ------------------------------------------------
    function renderProcesses(processes) {
      $id('process-count').textContent = String(processes.length);
      const tbody = $id('process-tbody');
      if (!processes.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No active processes</td></tr>';
        return;
      }
      let html = '';
      for (const p of processes) {
        const uptime = formatUptime((Date.now() - p.startedAt) / 1000);
        const activeFile = p.activeFile ? p.activeFile.split('/').pop() : '--';
        html += '<tr>'
          + '<td><span class="source-badge ' + safeClass(p.tool) + '">' + escHtml(p.tool) + '</span></td>'
          + '<td class="mono">' + p.pid + '</td>'
          + '<td class="mono">' + p.memoryMb.toFixed(1) + '</td>'
          + '<td class="mono">' + p.cpuPercent.toFixed(1) + '</td>'
          + '<td title="' + escHtml(p.activeFile || '') + '">' + escHtml(activeFile) + '</td>'
          + '<td class="mono">' + uptime + '</td>'
          + '</tr>';
      }
      tbody.innerHTML = html;
    }

    // ---- Type Expansion Inspector ----------------------------------------
    function renderExpansions(diagnostics) {
      const container = $id('expansion-container');
      // Filter diagnostics that have type expansion data
      const expansions = diagnostics.filter((d) => d.data && d.data.expansionPath);
      $id('expansion-count').textContent = String(expansions.length);

      if (!expansions.length) {
        container.innerHTML = '<div class="empty-state">No truncated type expansions</div>';
        return;
      }

      let html = '';
      for (const d of expansions.slice(0, 50)) {
        const path = d.data.expansionPath || [];
        const depth = d.data.expansionDepth || 0;
        const maxDepth = d.data.maxDepth || 50;
        const truncated = d.data.truncated || false;
        const ratio = Math.min(depth / maxDepth, 1);
        const color = ratio > 0.8 ? 'var(--error)' : ratio > 0.5 ? 'var(--warning)' : 'var(--success)';

        html += '<div class="expansion-path">';
        for (let i = 0; i < path.length; i++) {
          if (i > 0) html += '<span class="arrow">-></span>';
          html += escHtml(path[i]);
        }
        if (truncated) html += '<span class="arrow">-></span><span class="truncated">...truncated</span>';
        html += '</div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-bottom:2px;">'
          + '<span>Depth: ' + depth + ' / ' + maxDepth + '</span>'
          + '<span>' + d.computeTimeMs + 'ms</span></div>';
        html += '<div class="expansion-depth-bar">'
          + '<div class="expansion-depth-fill" style="width:' + (ratio * 100).toFixed(1) + '%;background:' + color + ';"></div>'
          + '</div>';
        html += '<div style="height:8px;"></div>';
      }
      container.innerHTML = html;
    }

    // ---- Configuration ---------------------------------------------------
    function renderConfig(config) {
      if (!config) return;
      $id('config-json').textContent = JSON.stringify(config, null, 2);
    }

    // ---- Utilities -------------------------------------------------------
    function formatUptime(seconds) {
      if (!seconds || seconds < 0) return '--';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function escHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** Sanitize a value for use as a CSS class name — allow only [a-zA-Z0-9_-]. */
    function safeClass(str) {
      if (!str) return '';
      return String(str).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    // ---- Initial request -------------------------------------------------
    send('refresh');
  </script>
</body>
</html>`;
  }
}

/**
 * Generate a cryptographically secure random nonce string for CSP.
 */
function getNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
