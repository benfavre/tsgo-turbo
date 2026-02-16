import * as vscode from 'vscode';
import type {
  AnalyzeFileRequest,
  AnalyzeFileResponse,
  InspectorDataRequest,
  InspectorDataResponse,
  CacheStatsNotification,
} from '@tsgo-turbo/shared';
import { CustomMethods } from '@tsgo-turbo/shared';
import type { LspClient } from './client.js';
import type { ClientLogger } from './logger.js';
import type { ConfigManager } from './config.js';
import type { InspectorPanel } from './webview/inspectorPanel.js';

/**
 * Registers all user-facing commands contributed by the tsgo Turbo extension.
 *
 * Each command is registered via `vscode.commands.registerCommand` and pushed
 * onto the extension context's subscriptions so they are automatically disposed
 * when the extension deactivates.
 *
 * @param context  - The extension context used for disposable tracking.
 * @param client   - The LSP client wrapper for server communication.
 * @param logger   - The client-side logger.
 * @param config   - The configuration manager.
 * @param getInspector - Lazy accessor for the inspector panel (may be created on demand).
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  client: LspClient,
  logger: ClientLogger,
  config: ConfigManager,
  getInspector: () => InspectorPanel,
): void {
  // --------------------------------------------------------------------------
  // tsgoTurbo.showInspector — open (or reveal) the inspector webview panel
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.showInspector', () => {
      const inspector = getInspector();
      inspector.reveal();
      logger.info('Inspector panel opened');
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.analyzeFile — request on-demand analysis of the current file
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.analyzeFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('tsgo Turbo: No active editor');
        return;
      }

      const uri = editor.document.uri.toString();
      logger.info('Analyzing current file', { uri });

      try {
        const params: AnalyzeFileRequest = { uri, force: true };
        const response = await client.sendCustomRequest<AnalyzeFileResponse>(
          CustomMethods.analyzeFile,
          params,
        );

        const diagCount = response.result.diagnostics.length;
        const time = response.result.analysisTimeMs;
        const cached = response.result.cached ? ' (cached)' : '';

        void vscode.window.showInformationMessage(
          `tsgo Turbo: ${diagCount} diagnostic(s) in ${time}ms${cached}`,
        );
      } catch (err) {
        logger.error('analyzeFile failed', { error: String(err) });
        void vscode.window.showErrorMessage(
          `tsgo Turbo: Analysis failed — ${String(err)}`,
        );
      }
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.analyzeWorkspace — full workspace analysis with progress
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.analyzeWorkspace', async () => {
      logger.info('Starting workspace analysis');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'tsgo Turbo: Analyzing workspace...',
          cancellable: true,
        },
        async (progress, token) => {
          try {
            // Collect all matching files in the workspace
            const include = config.getConfig().watch.include.join(',');
            const files = await vscode.workspace.findFiles(
              `{${include}}`,
              '**/node_modules/**',
            );

            const total = files.length;
            let completed = 0;

            for (const file of files) {
              if (token.isCancellationRequested) {
                logger.info('Workspace analysis cancelled by user');
                break;
              }

              try {
                const params: AnalyzeFileRequest = {
                  uri: file.toString(),
                  force: false,
                };
                await client.sendCustomRequest<AnalyzeFileResponse>(
                  CustomMethods.analyzeFile,
                  params,
                );
              } catch (fileErr) {
                logger.debug('File analysis failed', {
                  uri: file.toString(),
                  error: String(fileErr),
                });
              }

              completed++;
              const pct = Math.round((completed / total) * 100);
              progress.report({
                message: `${completed}/${total} files (${pct}%)`,
                increment: (1 / total) * 100,
              });
            }

            void vscode.window.showInformationMessage(
              `tsgo Turbo: Workspace analysis complete — ${completed}/${total} files analyzed`,
            );
          } catch (err) {
            logger.error('Workspace analysis failed', { error: String(err) });
            void vscode.window.showErrorMessage(
              `tsgo Turbo: Workspace analysis failed — ${String(err)}`,
            );
          }
        },
      );
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.clearCache — ask the server to purge its cache
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.clearCache', async () => {
      try {
        await client.sendCustomRequest<void>(CustomMethods.clearCache, {});

        // Fetch fresh stats to show confirmation
        const stats = await client.sendCustomRequest<CacheStatsNotification>(
          CustomMethods.cacheStats,
          {},
        );

        void vscode.window.showInformationMessage(
          `tsgo Turbo: Cache cleared (${stats.totalEntries} entries remain)`,
        );
        logger.info('Cache cleared');
      } catch (err) {
        logger.error('clearCache failed', { error: String(err) });
        void vscode.window.showErrorMessage(
          `tsgo Turbo: Failed to clear cache — ${String(err)}`,
        );
      }
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.showLogs — reveal the output channel
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.showLogs', () => {
      logger.show();
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.restartServer — stop and re-start the LSP client
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.restartServer', async () => {
      logger.info('Restarting LSP server (user-initiated)');
      try {
        await client.restart(config.getConfig());
        void vscode.window.showInformationMessage(
          'tsgo Turbo: Server restarted successfully',
        );
      } catch (err) {
        logger.error('Server restart failed', { error: String(err) });
        void vscode.window.showErrorMessage(
          `tsgo Turbo: Restart failed — ${String(err)}`,
        );
      }
    }),
  );

  // --------------------------------------------------------------------------
  // tsgoTurbo.showTypeExpansion — show type expansion info at cursor position
  // --------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('tsgoTurbo.showTypeExpansion', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('tsgo Turbo: No active editor');
        return;
      }

      const uri = editor.document.uri.toString();
      const position = editor.selection.active;

      try {
        const response = await client.sendCustomRequest<InspectorDataResponse>(
          CustomMethods.inspectorData,
          {
            fileUri: uri,
            includeTraces: false,
            includeCache: false,
            includeDiagnostics: true,
          } satisfies InspectorDataRequest,
        );

        // Find diagnostics near the cursor that contain type expansion info
        const nearbyDiagnostics = response.diagnostics.filter(
          (d) =>
            d.line === position.line + 1 &&
            d.column <= position.character + 1 &&
            (d.endColumn === undefined || d.endColumn >= position.character + 1),
        );

        if (nearbyDiagnostics.length === 0) {
          void vscode.window.showInformationMessage(
            'tsgo Turbo: No type expansion data at cursor position',
          );
          return;
        }

        const items = nearbyDiagnostics.map((d) => {
          const data = d.data as Record<string, unknown> | undefined;
          const depth = (data?.['expansionDepth'] as number) ?? 0;
          const maxDepth = (data?.['maxDepth'] as number) ?? config.getConfig().tsgo.maxTypeDepth;
          const truncated = (data?.['truncated'] as boolean) ?? false;
          const path = (data?.['expansionPath'] as string[]) ?? [];

          return [
            `**${d.message}**`,
            ``,
            `- Expansion depth: ${depth} / ${maxDepth}`,
            `- Truncated: ${truncated ? 'Yes' : 'No'}`,
            path.length > 0 ? `- Path: ${path.join(' -> ')}` : '',
            `- Source: ${d.source}`,
            `- Compute time: ${d.computeTimeMs}ms`,
          ]
            .filter(Boolean)
            .join('\n');
        });

        const doc = await vscode.workspace.openTextDocument({
          content: items.join('\n\n---\n\n'),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        logger.error('showTypeExpansion failed', { error: String(err) });
        void vscode.window.showErrorMessage(
          `tsgo Turbo: Failed to get type expansion — ${String(err)}`,
        );
      }
    }),
  );
}
