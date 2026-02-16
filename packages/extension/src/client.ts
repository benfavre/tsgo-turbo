import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  State,
} from 'vscode-languageclient/node.js';
import { LSP_SERVER_ID, EXTENSION_NAME, DEFAULT_CONFIG } from '@tsgo-turbo/shared';
import type { TsgoTurboConfig, LogLevel } from '@tsgo-turbo/shared';
import type { ClientLogger } from './logger.js';

/** Minimum and maximum back-off delays (in milliseconds) for restart attempts. */
const MIN_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

/**
 * LspClient wraps `vscode-languageclient`'s {@link LanguageClient} with
 * additional features specific to tsgo Turbo:
 *
 * - Automatic server module resolution (locates the bundled server).
 * - Registration helpers for custom LSP notifications / requests.
 * - Transparent restart with exponential back-off on crash.
 * - Logging middleware that feeds requests/responses into the
 *   extension-side {@link ClientLogger}.
 */
export class LspClient implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /** Fires when the underlying client transitions to the Running state. */
  private readonly readyEmitter = new vscode.EventEmitter<void>();
  public readonly onReady: vscode.Event<void> = this.readyEmitter.event;

  /** Fires when the client stops (crash or intentional). */
  private readonly stoppedEmitter = new vscode.EventEmitter<void>();
  public readonly onStopped: vscode.Event<void> = this.stoppedEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: ClientLogger,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the language client. Resolves when the server has finished its
   * initialization handshake.
   */
  async start(initConfig: TsgoTurboConfig): Promise<void> {
    if (this.client) {
      this.logger.warn('LspClient.start called while client already exists — stopping first');
      await this.stop();
    }

    const serverModule = this.resolveServerModule();
    this.logger.info('Starting LSP server', { serverModule });

    const serverOptions: ServerOptions = {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        env: {
          ...process.env,
          TSGO_TURBO_CONFIG: JSON.stringify(initConfig),
        },
      },
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'javascriptreact' },
      ],
      synchronize: {
        fileEvents: vscode.workspace.createFileSystemWatcher(
          '**/*.{ts,tsx,js,jsx,mts,cts}',
        ),
      },
      initializationOptions: initConfig,
      middleware: {
        handleDiagnostics: (uri, diagnostics, next) => {
          this.logger.trace('Diagnostics received', {
            uri: uri.toString(),
            count: diagnostics.length,
          });
          next(uri, diagnostics);
        },
      },
      outputChannelName: EXTENSION_NAME,
    };

    this.client = new LanguageClient(
      LSP_SERVER_ID,
      EXTENSION_NAME,
      serverOptions,
      clientOptions,
    );

    this.registerStateChangeHandler();

    await this.client.start();
    this.restartCount = 0;
    this.readyEmitter.fire();
    this.logger.info('LSP server started successfully');
  }

  /**
   * Gracefully stop the language client.
   */
  async stop(): Promise<void> {
    this.clearRestartTimer();
    if (this.client) {
      try {
        if (this.client.state === State.Running) {
          await this.client.stop(2_000);
        }
      } catch (err) {
        this.logger.warn('Error stopping LSP client', {
          error: String(err),
        });
      } finally {
        this.client = undefined;
      }
    }
  }

  /**
   * Stop and re-start the client. Resets the back-off counter so the next
   * crash will start from the minimum delay again.
   */
  async restart(config: TsgoTurboConfig): Promise<void> {
    this.logger.info('Restarting LSP server');
    this.restartCount = 0;
    await this.stop();
    await this.start(config);
  }

  // ---------------------------------------------------------------------------
  // Custom protocol helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a custom request to the server and return its response.
   *
   * @param method - Custom method name, e.g. `tsgoTurbo/inspectorData`.
   * @param params - Arbitrary JSON-serialisable parameters.
   */
  async sendCustomRequest<R>(method: string, params?: unknown): Promise<R> {
    if (!this.client || this.client.state !== State.Running) {
      throw new Error('LSP client is not running');
    }
    return this.client.sendRequest(method, params) as Promise<R>;
  }

  /**
   * Register a handler for a custom notification from the server.
   *
   * @returns A disposable that unregisters the handler.
   */
  onCustomNotification<T>(method: string, handler: (params: T) => void): vscode.Disposable {
    if (!this.client) {
      // Defer registration — queue it so it is applied once the client starts.
      const deferred = this.onReady(() => {
        if (this.client) {
          this.client.onNotification(method, handler);
        }
      });
      this.disposables.push(deferred);
      return deferred;
    }
    this.client.onNotification(method, handler);
    return { dispose: () => { /* vscode-languageclient does not expose un-register */ } };
  }

  /**
   * Push updated configuration to the server via the standard
   * `workspace/didChangeConfiguration` notification.
   */
  async pushConfigToServer(config: TsgoTurboConfig): Promise<void> {
    if (!this.client || this.client.state !== State.Running) {
      return;
    }
    await this.client.sendNotification('workspace/didChangeConfiguration', {
      settings: { tsgoTurbo: config },
    });
    this.logger.debug('Pushed updated config to server');
  }

  /** Whether the client is currently in the Running state. */
  get isRunning(): boolean {
    return this.client?.state === State.Running;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Locate the bundled server entry-point. The server package is a sibling
   * workspace package; its esbuild output lives at `../server/dist/server.js`.
   */
  private resolveServerModule(): string {
    return this.context.asAbsolutePath(
      path.join('..', 'server', 'dist', 'server.js'),
    );
  }

  /**
   * Watch for state changes on the underlying client so we can trigger
   * automatic restart with exponential back-off on unexpected stops.
   */
  private registerStateChangeHandler(): void {
    if (!this.client) {
      return;
    }

    this.client.onDidChangeState((e) => {
      if (e.newState === State.Stopped && !this.disposed) {
        this.logger.warn('LSP server stopped unexpectedly');
        this.stoppedEmitter.fire();
        this.scheduleRestart();
      }
    });
  }

  /**
   * Schedule an automatic restart with exponential back-off.
   */
  private scheduleRestart(): void {
    if (this.disposed) {
      return;
    }

    const delay = Math.min(
      MIN_RESTART_DELAY_MS * Math.pow(BACKOFF_FACTOR, this.restartCount),
      MAX_RESTART_DELAY_MS,
    );

    this.restartCount++;
    this.logger.info(`Scheduling LSP restart in ${delay}ms (attempt ${this.restartCount})`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined;
      try {
        // Re-read config from VS Code settings; the ConfigManager is the
        // canonical source but we avoid a circular dependency here.
        const ws = vscode.workspace.getConfiguration('tsgoTurbo');
        const config: TsgoTurboConfig = {
          tsgo: {
            enabled: ws.get<boolean>('tsgo.enabled', DEFAULT_CONFIG.tsgo.enabled),
            binaryPath: ws.get<string>('tsgo.binaryPath', '') || undefined,
            maxTypeDepth: ws.get<number>('tsgo.maxTypeDepth', DEFAULT_CONFIG.tsgo.maxTypeDepth),
            fileTimeoutMs: ws.get<number>('tsgo.fileTimeoutMs', DEFAULT_CONFIG.tsgo.fileTimeoutMs),
            maxMemoryMb: ws.get<number>('tsgo.maxMemoryMb', DEFAULT_CONFIG.tsgo.maxMemoryMb),
            flags: DEFAULT_CONFIG.tsgo.flags,
          },
          oxc: {
            enabled: ws.get<boolean>('oxc.enabled', DEFAULT_CONFIG.oxc.enabled),
            binaryPath: ws.get<string>('oxc.binaryPath', '') || undefined,
            configPath: ws.get<string>('oxc.configPath', '') || undefined,
            fileTimeoutMs: ws.get<number>('oxc.fileTimeoutMs', DEFAULT_CONFIG.oxc.fileTimeoutMs),
          },
          logging: {
            level: ws.get<LogLevel>('logging.level', DEFAULT_CONFIG.logging.level),
            perfTracing: ws.get<boolean>('logging.perfTracing', DEFAULT_CONFIG.logging.perfTracing),
            maxFileSizeMb: DEFAULT_CONFIG.logging.maxFileSizeMb,
            prettyPrint: ws.get<boolean>('logging.prettyPrint', DEFAULT_CONFIG.logging.prettyPrint),
          },
          cache: {
            enabled: ws.get<boolean>('cache.enabled', DEFAULT_CONFIG.cache.enabled),
            maxEntries: ws.get<number>('cache.maxEntries', DEFAULT_CONFIG.cache.maxEntries),
            maxSizeMb: ws.get<number>('cache.maxSizeMb', DEFAULT_CONFIG.cache.maxSizeMb),
            ttlSeconds: DEFAULT_CONFIG.cache.ttlSeconds,
          },
          watch: {
            include: ws.get<string[]>('watch.include', DEFAULT_CONFIG.watch.include),
            exclude: ws.get<string[]>('watch.exclude', DEFAULT_CONFIG.watch.exclude),
            debounceMs: ws.get<number>('watch.debounceMs', DEFAULT_CONFIG.watch.debounceMs),
          },
          inspector: {
            enabled: ws.get<boolean>('inspector.enabled', DEFAULT_CONFIG.inspector.enabled),
            autoOpen: ws.get<boolean>('inspector.autoOpen', DEFAULT_CONFIG.inspector.autoOpen),
            maxTraceHistory: DEFAULT_CONFIG.inspector.maxTraceHistory,
          },
        };
        await this.start(config);
      } catch (err) {
        this.logger.error('Auto-restart failed', { error: String(err) });
        this.scheduleRestart();
      }
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearRestartTimer();
    this.readyEmitter.dispose();
    this.stoppedEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    // stop() is async — fire and forget during dispose
    void this.stop();
  }
}
