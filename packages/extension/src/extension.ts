import * as vscode from 'vscode';
import {
  CustomMethods,
  EXTENSION_NAME,
} from '@tsgo-turbo/shared';
import type {
  PerfTraceNotification,
  TypeExpansionWarningNotification,
  ServerStatusNotification,
  LogEntryNotification,
  CacheStatsNotification,
} from '@tsgo-turbo/shared';
import { LspClient } from './client.js';
import { ConfigManager } from './config.js';
import { ClientLogger } from './logger.js';
import { StatusBarManager } from './statusBar.js';
import { registerCommands } from './commands.js';
import { InspectorPanel } from './webview/inspectorPanel.js';

/** Module-level handle so `deactivate()` can perform a clean shutdown. */
let client: LspClient | undefined;

/**
 * Entry point invoked by VS Code when the extension activates.
 *
 * Activation is triggered by any of the `activationEvents` declared in
 * `package.json` (opening a TS/JS/TSX/JSX file).
 *
 * This function wires together the extension's core subsystems:
 * 1. **ConfigManager** — reads and watches VS Code settings.
 * 2. **ClientLogger** — output channel for structured log display.
 * 3. **LspClient** — manages the language server process and protocol.
 * 4. **StatusBarManager** — status bar indicator at the bottom of the editor.
 * 5. **InspectorPanel** — rich webview panel for debugging/perf analysis.
 * 6. **Commands** — all user-facing commands registered in the command palette.
 * 7. **Custom LSP notifications** — perf traces, type expansion warnings,
 *    server status updates, and log entries streamed from the server.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. Configuration
  const configManager = new ConfigManager();
  context.subscriptions.push(configManager);

  const config = configManager.getConfig();

  // 2. Logger
  const logger = new ClientLogger(config.logging.level);
  context.subscriptions.push(logger);
  logger.info(`${EXTENSION_NAME} activating`);

  // 3. Status bar
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // 4. Inspector panel (lazy — created on first access)
  let inspector: InspectorPanel | undefined;
  function getInspector(): InspectorPanel {
    if (!inspector) {
      inspector = new InspectorPanel(context.extensionUri, lspClient, logger);
      context.subscriptions.push(inspector);
    }
    return inspector;
  }

  // 5. LSP Client
  const lspClient = new LspClient(context, logger);
  client = lspClient;
  context.subscriptions.push(lspClient);

  // 6. Register commands
  registerCommands(context, lspClient, logger, configManager, getInspector);

  // 7. Wire up custom notification handlers (must be done before start)
  registerNotificationHandlers(lspClient, logger, statusBar, configManager, getInspector);

  // 8. React to config changes
  configManager.onConfigChanged((newConfig) => {
    logger.setLevel(newConfig.logging.level);
    logger.info('Configuration changed — pushing to server');
    void lspClient.pushConfigToServer(newConfig);
  });

  // 9. Track workspace diagnostic counts for the status bar
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      let count = 0;
      for (const [, diags] of vscode.languages.getDiagnostics()) {
        count += diags.length;
      }
      statusBar.updateDiagnosticCount(count);
    }),
  );

  // 10. Start the LSP client
  try {
    await lspClient.start(config);
    logger.info(`${EXTENSION_NAME} activated successfully`);
  } catch (err) {
    logger.error('Failed to start LSP server', { error: String(err) });
    void vscode.window.showErrorMessage(
      `${EXTENSION_NAME}: Failed to start server — ${String(err)}`,
    );
  }
}

/**
 * Clean shutdown invoked by VS Code when the extension deactivates.
 */
export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

// ---------------------------------------------------------------------------
// Custom notification wiring
// ---------------------------------------------------------------------------

/**
 * Register handlers for all custom LSP notifications emitted by the tsgo
 * Turbo server. These arrive outside the standard LSP protocol and carry
 * performance traces, type expansion warnings, status updates, and log
 * entries that are displayed in the UI.
 */
function registerNotificationHandlers(
  lspClient: LspClient,
  logger: ClientLogger,
  statusBar: StatusBarManager,
  _configManager: ConfigManager,
  getInspector: () => InspectorPanel,
): void {
  // --- tsgoTurbo/serverStatus ---
  lspClient.onCustomNotification<ServerStatusNotification>(
    CustomMethods.serverStatus,
    (params) => {
      statusBar.updateServerStatus(params);
      logger.trace('Server status', {
        status: params.status,
        activeOps: params.activeOperations,
      });

      // Show a notification for error states
      if (params.status === 'error') {
        void vscode.window.showErrorMessage(
          `${EXTENSION_NAME}: Server error — ${params.message ?? 'unknown'}`,
        );
      }
    },
  );

  // --- tsgoTurbo/logEntry ---
  lspClient.onCustomNotification<LogEntryNotification>(
    CustomMethods.logEntry,
    (entry) => {
      logger.handleServerLogEntry(entry);
    },
  );

  // --- tsgoTurbo/perfTrace ---
  lspClient.onCustomNotification<PerfTraceNotification>(
    CustomMethods.perfTrace,
    (params) => {
      logger.trace('Perf trace received', {
        spans: params.spans.length,
        totalMs: params.totalDurationMs,
        file: params.fileUri,
      });

      // Update the status bar with the latest analysis time
      if (params.totalDurationMs > 0) {
        statusBar.updateLastAnalysisTime(params.totalDurationMs);
      }

      // Push to inspector if it is open
      getInspector().pushUpdate({ traces: params.spans });
    },
  );

  // --- tsgoTurbo/typeExpansionWarning ---
  lspClient.onCustomNotification<TypeExpansionWarningNotification>(
    CustomMethods.typeExpansionWarning,
    (params) => {
      logger.warn('Type expansion truncated', {
        type: params.info.typeName,
        depth: params.info.depth,
        maxDepth: params.info.maxDepth,
        file: params.fileUri,
      });

      // Show a warning the first time per file
      void vscode.window.showWarningMessage(
        `${EXTENSION_NAME}: Type expansion for "${params.info.typeName}" was truncated ` +
        `at depth ${params.info.depth}/${params.info.maxDepth}. ${params.suggestion}`,
      );
    },
  );

  // --- tsgoTurbo/cacheStats ---
  lspClient.onCustomNotification<CacheStatsNotification>(
    CustomMethods.cacheStats,
    (params) => {
      logger.trace('Cache stats update', {
        entries: params.totalEntries,
        hitRate: params.hitRate,
      });
      getInspector().pushUpdate({ cacheStats: params });
    },
  );
}
