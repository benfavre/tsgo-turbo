import * as vscode from 'vscode';
import type { ServerStatusNotification } from '@tsgo-turbo/shared';

/**
 * Icon codicons used in the status bar item to indicate server state.
 * VS Code renders these via the `$(icon-name)` syntax.
 */
const STATUS_ICONS: Record<ServerStatusNotification['status'], string> = {
  starting: '$(loading~spin)',
  ready:    '$(check)',
  busy:     '$(clock)',
  degraded: '$(warning)',
  error:    '$(error)',
};

/**
 * Human-readable labels shown next to the icon.
 */
const STATUS_LABELS: Record<ServerStatusNotification['status'], string> = {
  starting: 'Starting',
  ready:    'Ready',
  busy:     'Busy',
  degraded: 'Degraded',
  error:    'Error',
};

/**
 * StatusBarManager owns the VS Code status bar item displayed at the bottom
 * of the editor window. It reflects the current state of the tsgo Turbo LSP
 * server and provides a click-action to open the inspector panel.
 *
 * State transitions:
 * - **Starting** — server is booting, spinner icon shown.
 * - **Ready** — server is idle and healthy, check icon shown.
 * - **Busy** — one or more analysis operations are in-flight, clock icon shown.
 * - **Degraded** — server is running but a subsystem (tsgo or oxc) has failed.
 * - **Error** — server has crashed or cannot be reached.
 *
 * The tooltip displays extended information including the number of active
 * and queued operations, server message, current file analysis time, and
 * the total diagnostic count across the workspace.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentStatus: ServerStatusNotification = {
    status: 'starting',
    activeOperations: 0,
    queuedOperations: 0,
  };
  private diagnosticCount = 0;
  private lastAnalysisTimeMs: number | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100,
    );
    this.item.command = 'tsgoTurbo.showInspector';
    this.render();
    this.item.show();
  }

  /**
   * Update the status bar to reflect a new {@link ServerStatusNotification}.
   */
  updateServerStatus(status: ServerStatusNotification): void {
    this.currentStatus = status;
    this.render();
  }

  /**
   * Update the total diagnostic count displayed in the tooltip.
   */
  updateDiagnosticCount(count: number): void {
    this.diagnosticCount = count;
    this.render();
  }

  /**
   * Record the most recent analysis duration so it can be shown in the tooltip.
   */
  updateLastAnalysisTime(ms: number): void {
    this.lastAnalysisTimeMs = ms;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  /** Re-render the status bar text and tooltip from current state. */
  private render(): void {
    const { status, activeOperations, queuedOperations, message } = this.currentStatus;
    const icon = STATUS_ICONS[status];
    const label = STATUS_LABELS[status];

    let text = `${icon} tsgo Turbo: ${label}`;
    if (activeOperations > 0) {
      text += ` (${activeOperations})`;
    }
    this.item.text = text;

    // Build rich tooltip
    const tooltipLines: string[] = [
      `**tsgo Turbo** - ${label}`,
    ];

    if (message) {
      tooltipLines.push(``, message);
    }

    tooltipLines.push(
      ``,
      `Active operations: ${activeOperations}`,
      `Queued operations: ${queuedOperations}`,
      `Diagnostics: ${this.diagnosticCount}`,
    );

    if (this.lastAnalysisTimeMs !== undefined) {
      tooltipLines.push(`Last analysis: ${this.lastAnalysisTimeMs}ms`);
    }

    tooltipLines.push(``, `_Click to open Inspector_`);

    const tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
    tooltip.isTrusted = true;
    this.item.tooltip = tooltip;

    // Colour the background for error/degraded states
    if (status === 'error') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'degraded') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }
}
