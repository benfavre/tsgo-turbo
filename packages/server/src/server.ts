import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  CodeActionKind,
  type Connection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  TsgoTurboConfig,
  InspectorDataRequest,
  InspectorDataResponse,
  AnalyzeFileRequest,
  AnalyzeFileResponse,
} from '@tsgo-turbo/shared';
import {
  CustomMethods,
  DEFAULT_CONFIG,
  LSP_SERVER_ID,
} from '@tsgo-turbo/shared';

import { Logger } from './logger/index.js';
import { PerfTracer } from './logger/performance.js';
import { ConfigLoader } from './config/loader.js';
import { AnalysisBridge, AnalysisPriority } from './integrations/bridge.js';
import { DiagnosticsProvider } from './providers/diagnostics.js';
import { CompletionProvider } from './providers/completion.js';
import { HoverProvider } from './providers/hover.js';
import { CodeActionProvider } from './providers/codeAction.js';
import { TypeExpansionGuard } from './guards/typeExpansion.js';
import { TypeCache } from './cache/typeCache.js';

/**
 * TsgoTurboServer is the main LSP server that integrates tsgo (Go-based
 * TypeScript compiler) and oxc (Rust-based linter) for high-performance
 * analysis of massive Next.js + tRPC + Prisma codebases.
 *
 * It manages:
 * - Connection lifecycle (initialize, shutdown)
 * - Process pools for tsgo and oxc
 * - Document synchronization and analysis triggers
 * - Provider registration (diagnostics, completion, hover, code actions)
 * - Configuration hot-reloading
 * - Custom method handlers for inspector, cache clearing, etc.
 * - Graceful shutdown with child process cleanup
 */
class TsgoTurboServer {
  private readonly connection: Connection;
  private readonly documents: TextDocuments<TextDocument>;
  private logger!: Logger;
  private configLoader!: ConfigLoader;
  private bridge!: AnalysisBridge;
  private diagnosticsProvider!: DiagnosticsProvider;
  private completionProvider!: CompletionProvider;
  private hoverProvider!: HoverProvider;
  private codeActionProvider!: CodeActionProvider;
  private typeExpansionGuard!: TypeExpansionGuard;
  private typeCache!: TypeCache;
  private perfTracer!: PerfTracer;
  private config: TsgoTurboConfig = DEFAULT_CONFIG;
  private hasConfigCapability = false;
  private hasWorkspaceFolderCapability = false;
  private readonly startTime: number;

  /** Map of open file URIs to debounce timers for analysis. */
  private readonly analysisDebounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor() {
    this.startTime = Date.now();
    this.connection = createConnection(ProposedFeatures.all);
    this.documents = new TextDocuments(TextDocument);

    this.setupConnectionHandlers();
    this.setupDocumentHandlers();
    this.setupCustomMethods();
  }

  /**
   * Start listening on the connection.
   */
  start(): void {
    this.documents.listen(this.connection);
    this.connection.listen();
  }

  /**
   * Set up LSP connection lifecycle handlers.
   */
  private setupConnectionHandlers(): void {
    this.connection.onInitialize((params) => this.onInitialize(params));
    this.connection.onInitialized(() => this.onInitialized());
    this.connection.onShutdown(() => this.onShutdown());

    this.connection.onDidChangeConfiguration((change) => {
      this.onDidChangeConfiguration(change.settings);
    });

    // Providers
    this.connection.onCompletion((params) => this.onCompletion(params));
    this.connection.onHover((params) => this.onHover(params));
    this.connection.onCodeAction((params) => this.onCodeAction(params));
  }

  /**
   * Set up document synchronization event handlers.
   */
  private setupDocumentHandlers(): void {
    this.documents.onDidOpen((event) => {
      this.scheduleAnalysis(event.document.uri, AnalysisPriority.Open);
    });

    this.documents.onDidChangeContent((change) => {
      this.scheduleAnalysis(
        change.document.uri,
        AnalysisPriority.Active,
      );
    });

    this.documents.onDidSave((event) => {
      // Force re-analysis on save (bypass cache)
      this.scheduleAnalysis(event.document.uri, AnalysisPriority.Active, true);
    });

    this.documents.onDidClose((event) => {
      // Clear diagnostics and cancel pending analysis for closed files
      const uri = event.document.uri;
      this.cancelAnalysis(uri);
      this.diagnosticsProvider?.clearDiagnostics(uri);
    });
  }

  /**
   * Set up custom method handlers for inspector, cache, and config operations.
   */
  private setupCustomMethods(): void {
    // Inspector data request
    this.connection.onRequest(
      CustomMethods.inspectorData,
      (params: InspectorDataRequest): InspectorDataResponse => {
        return this.handleInspectorData(params);
      },
    );

    // Clear all caches
    this.connection.onRequest(CustomMethods.clearCache, () => {
      this.handleClearCache();
      return { success: true };
    });

    // Reload configuration
    this.connection.onRequest(CustomMethods.reloadConfig, async () => {
      await this.handleReloadConfig();
      return { success: true };
    });

    // Analyze single file on demand
    this.connection.onRequest(
      CustomMethods.analyzeFile,
      async (params: AnalyzeFileRequest): Promise<AnalyzeFileResponse> => {
        return this.handleAnalyzeFile(params);
      },
    );
  }

  /**
   * Handle the initialize request from the client.
   */
  private onInitialize(params: InitializeParams): InitializeResult {
    const capabilities = params.capabilities;

    this.hasConfigCapability = !!(
      capabilities.workspace && capabilities.workspace.configuration
    );
    this.hasWorkspaceFolderCapability = !!(
      capabilities.workspace && capabilities.workspace.workspaceFolders
    );

    // Initialize logger with defaults first (config not loaded yet)
    this.perfTracer = new PerfTracer(
      1000,
      this.config.inspector.maxTraceHistory,
    );
    this.logger = new Logger(this.connection, this.config.logging);

    this.logger.info('Initializing tsgo Turbo LSP server', {
      processId: params.processId,
      clientName: params.clientInfo?.name,
      clientVersion: params.clientInfo?.version,
      hasConfigCapability: this.hasConfigCapability,
      hasWorkspaceFolderCapability: this.hasWorkspaceFolderCapability,
    });

    // Initialize config loader
    this.configLoader = new ConfigLoader(this.connection, this.logger);
    this.configLoader.setHasConfigCapability(this.hasConfigCapability);

    // Register config change handler
    this.configLoader.onConfigChanged((newConfig, _oldConfig) => {
      this.applyConfig(newConfig);
    });

    // Initialize type expansion guard
    this.typeExpansionGuard = new TypeExpansionGuard(
      this.config.tsgo.maxTypeDepth,
      this.logger,
      (info) => {
        // Send warning to client
        this.connection.sendNotification(
          CustomMethods.typeExpansionWarning,
          {
            info,
            fileUri: '', // Will be set when called from analysis
            suggestion:
              'Consider adding explicit type annotations to reduce type expansion depth.',
          },
        );
      },
    );

    // Initialize type cache
    this.typeCache = new TypeCache(this.config.cache);

    // Return capabilities
    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          triggerCharacters: ['.', '"', "'", '/', '<', '@'],
          resolveProvider: false,
        },
        hoverProvider: true,
        codeActionProvider: {
          codeActionKinds: [
            CodeActionKind.QuickFix,
            CodeActionKind.Empty,
          ],
        },
        diagnosticProvider: {
          identifier: LSP_SERVER_ID,
          interFileDependencies: true,
          workspaceDiagnostics: false,
        },
      },
      serverInfo: {
        name: 'tsgo Turbo',
        version: '0.1.0',
      },
    };

    if (this.hasWorkspaceFolderCapability) {
      result.capabilities.workspace = {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
      };
    }

    return result;
  }

  /**
   * Handle the initialized notification. Start tool processes and load config.
   */
  private async onInitialized(): Promise<void> {
    // Register for config change notifications
    if (this.hasConfigCapability) {
      this.connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined,
      );
    }

    // Load config from client
    try {
      this.config = await this.configLoader.load();
      this.logger.info('Configuration loaded');
    } catch (err) {
      this.logger.error('Failed to load configuration, using defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Apply the loaded config
    this.applyConfig(this.config);

    // Start the analysis bridge (spawns tsgo + oxc processes)
    try {
      this.bridge = new AnalysisBridge(
        this.config,
        this.logger,
        this.perfTracer,
      );

      // Initialize providers
      this.diagnosticsProvider = new DiagnosticsProvider(
        this.connection,
        this.logger,
        this.config.watch.debounceMs,
      );
      this.completionProvider = new CompletionProvider(
        this.bridge,
        this.logger,
      );
      this.hoverProvider = new HoverProvider(
        this.bridge,
        this.typeExpansionGuard,
        this.logger,
      );
      this.codeActionProvider = new CodeActionProvider(
        this.diagnosticsProvider,
        this.logger,
      );

      await this.bridge.start();

      // Send server ready status
      this.connection.sendNotification(CustomMethods.serverStatus, {
        status: 'ready',
        message: 'tsgo Turbo is ready',
        activeOperations: 0,
        queuedOperations: 0,
      });

      this.logger.info('Server fully initialized and ready');
    } catch (err) {
      this.logger.error('Failed to start analysis bridge', {
        error: err instanceof Error ? err.message : String(err),
      });

      this.connection.sendNotification(CustomMethods.serverStatus, {
        status: 'error',
        message: `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
        activeOperations: 0,
        queuedOperations: 0,
      });
    }
  }

  /**
   * Apply a new configuration. Called on initial load and on config changes.
   */
  private applyConfig(config: TsgoTurboConfig): void {
    this.config = config;

    // Update logger
    this.logger.setLevel(config.logging.level);

    // Update type expansion guard
    this.typeExpansionGuard?.setMaxDepth(config.tsgo.maxTypeDepth);

    // Update bridge
    this.bridge?.updateConfig(config);

    // Update diagnostics debounce
    this.diagnosticsProvider?.setDebounceMs(config.watch.debounceMs);

    // Update perf tracer
    this.perfTracer?.setSlowThreshold(
      config.tsgo.fileTimeoutMs / 2,
    );

    this.logger.debug('Configuration applied', {
      tsgoEnabled: config.tsgo.enabled,
      oxcEnabled: config.oxc.enabled,
      maxTypeDepth: config.tsgo.maxTypeDepth,
      cacheEnabled: config.cache.enabled,
    });
  }

  /**
   * Handle configuration change notification from the client.
   */
  private async onDidChangeConfiguration(settings: unknown): Promise<void> {
    if (this.hasConfigCapability) {
      // Pull fresh config from client
      await this.configLoader.load();
    } else {
      // Use the settings from the notification directly
      const rawConfig =
        settings && typeof settings === 'object'
          ? (settings as Record<string, unknown>)['tsgo-turbo']
          : undefined;
      if (rawConfig) {
        this.configLoader.applyRawConfig(rawConfig);
      }
    }
  }

  /**
   * Handle completion requests.
   */
  private async onCompletion(params: import('vscode-languageserver').CompletionParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document || !this.completionProvider) {
      return null;
    }
    return this.completionProvider.provideCompletions(params, document);
  }

  /**
   * Handle hover requests.
   */
  private async onHover(params: import('vscode-languageserver').HoverParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document || !this.hoverProvider) {
      return null;
    }
    return this.hoverProvider.provideHover(params, document);
  }

  /**
   * Handle code action requests.
   */
  private onCodeAction(params: import('vscode-languageserver').CodeActionParams) {
    const document = this.documents.get(params.textDocument.uri);
    if (!document || !this.codeActionProvider) {
      return [];
    }
    return this.codeActionProvider.provideCodeActions(
      params,
      document.getText(),
    );
  }

  /**
   * Schedule an analysis for a file with debouncing.
   */
  private scheduleAnalysis(
    uri: string,
    priority: AnalysisPriority,
    force = false,
  ): void {
    if (!this.bridge) {
      return;
    }

    this.cancelAnalysis(uri);

    const debounceMs = this.config.watch.debounceMs;

    const timer = setTimeout(async () => {
      this.analysisDebounceTimers.delete(uri);
      await this.runAnalysis(uri, priority, force);
    }, debounceMs);

    this.analysisDebounceTimers.set(uri, timer);
  }

  /**
   * Cancel a pending analysis for a file.
   */
  private cancelAnalysis(uri: string): void {
    const existing = this.analysisDebounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
      this.analysisDebounceTimers.delete(uri);
    }
  }

  /**
   * Run analysis for a file and publish diagnostics.
   */
  private async runAnalysis(
    uri: string,
    priority: AnalysisPriority,
    force: boolean,
  ): Promise<void> {
    const document = this.documents.get(uri);
    if (!document || !this.bridge) {
      return;
    }

    // Update server status
    this.sendStatusUpdate('busy');

    try {
      const content = document.getText();
      const result = await this.bridge.analyzeFile(
        uri,
        content,
        force,
        priority,
      );

      // Publish diagnostics
      this.diagnosticsProvider.updateDiagnostics(uri, result.diagnostics);

      this.logger.debug('Analysis complete', {
        uri,
        diagnosticCount: result.diagnostics.length,
        durationMs: result.analysisTimeMs,
        cached: result.cached,
      });
    } catch (err) {
      this.logger.error('Analysis failed', {
        uri,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.sendStatusUpdate(
        this.bridge.activeCount > 0 ? 'busy' : 'ready',
      );
    }
  }

  /**
   * Send a server status notification to the client.
   */
  private sendStatusUpdate(
    status: 'ready' | 'busy' | 'error' | 'degraded',
  ): void {
    try {
      this.connection.sendNotification(CustomMethods.serverStatus, {
        status,
        activeOperations: this.bridge?.activeCount ?? 0,
        queuedOperations: this.bridge?.queueSize ?? 0,
      });
    } catch (err) {
      this.logger.debug('Failed to send status update', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle inspector data request.
   */
  private handleInspectorData(
    params: InspectorDataRequest,
  ): InspectorDataResponse {
    const traces = params.includeTraces
      ? this.perfTracer.getRecentTraces(50)
      : [];

    const cacheStats = params.includeCache
      ? this.bridge?.getCacheStats() ?? {
          totalEntries: 0,
          totalSizeBytes: 0,
          hitRate: 0,
          missRate: 0,
          evictionCount: 0,
        }
      : {
          totalEntries: 0,
          totalSizeBytes: 0,
          hitRate: 0,
          missRate: 0,
          evictionCount: 0,
        };

    const diagnostics = params.includeDiagnostics
      ? params.fileUri
        ? this.diagnosticsProvider?.getDiagnostics(params.fileUri) ?? []
        : []
      : [];

    return {
      traces,
      cacheStats,
      diagnostics,
      config: this.config,
      serverUptime: Date.now() - this.startTime,
      filesAnalyzed: this.bridge?.totalFilesAnalyzed ?? 0,
      activeProcesses: this.bridge?.getProcessInfo() ?? [],
    };
  }

  /**
   * Handle clear cache request.
   */
  private handleClearCache(): void {
    this.bridge?.clearCache();
    this.typeCache?.clear();
    this.logger.info('All caches cleared via client request');

    // Send updated cache stats
    this.connection.sendNotification(CustomMethods.cacheStats, {
      totalEntries: 0,
      totalSizeBytes: 0,
      hitRate: 0,
      missRate: 0,
      evictionCount: 0,
    });
  }

  /**
   * Handle configuration reload request.
   */
  private async handleReloadConfig(): Promise<void> {
    const newConfig = await this.configLoader.reload();
    this.applyConfig(newConfig);
    this.logger.info('Configuration reloaded via client request');
  }

  /**
   * Handle analyze single file request.
   */
  private async handleAnalyzeFile(
    params: AnalyzeFileRequest,
  ): Promise<AnalyzeFileResponse> {
    const document = this.documents.get(params.uri);
    if (!document || !this.bridge) {
      return {
        result: {
          uri: params.uri,
          diagnostics: [],
          analysisTimeMs: 0,
          cached: false,
          contentHash: '',
        },
        traces: [],
      };
    }

    const content = document.getText();
    const result = await this.bridge.analyzeFile(
      params.uri,
      content,
      params.force,
      AnalysisPriority.Active,
    );

    // Publish diagnostics immediately
    this.diagnosticsProvider.updateDiagnostics(params.uri, result.diagnostics);

    // Get related traces
    const traces = this.perfTracer.getRecentTraces(5);

    return { result, traces };
  }

  /**
   * Handle shutdown request. Gracefully stop all child processes.
   */
  private async onShutdown(): Promise<void> {
    this.logger.info('Server shutting down');

    // Cancel all pending analyses
    for (const [uri, timer] of this.analysisDebounceTimers) {
      clearTimeout(timer);
    }
    this.analysisDebounceTimers.clear();

    // Shutdown bridge (kills tsgo + oxc processes)
    if (this.bridge) {
      try {
        await this.bridge.shutdown();
      } catch (err) {
        this.logger.error('Error during bridge shutdown', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Dispose providers
    this.diagnosticsProvider?.dispose();

    // Flush and dispose logger
    this.logger.flush();
    this.logger.dispose();
  }
}

// --- Entry Point ---

const server = new TsgoTurboServer();
server.start();
