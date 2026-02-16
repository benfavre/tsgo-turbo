import * as vscode from 'vscode';
import type { TsgoTurboConfig, LogLevel } from '@tsgo-turbo/shared';
import { DEFAULT_CONFIG } from '@tsgo-turbo/shared';

/**
 * ConfigManager reads VS Code workspace configuration under the `tsgoTurbo`
 * section and converts it to the strongly-typed {@link TsgoTurboConfig} used
 * throughout the extension and server.
 *
 * It also watches for configuration changes and notifies subscribers so the
 * running LSP server can be kept in sync.
 */
export class ConfigManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<TsgoTurboConfig>();

  /** Fires whenever the effective configuration changes. */
  public readonly onConfigChanged: vscode.Event<TsgoTurboConfig> = this.changeEmitter.event;

  private cachedConfig: TsgoTurboConfig | undefined;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsgoTurbo')) {
          this.cachedConfig = undefined;
          this.changeEmitter.fire(this.getConfig());
        }
      }),
    );
  }

  /**
   * Read the current effective configuration by merging VS Code settings
   * with the built-in defaults.
   */
  getConfig(): TsgoTurboConfig {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

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

    this.cachedConfig = config;
    return config;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
