import type { Connection } from 'vscode-languageserver';
import type { TsgoTurboConfig } from '@tsgo-turbo/shared';
import { DEFAULT_CONFIG, EXTENSION_ID } from '@tsgo-turbo/shared';
import { validateConfig } from './schema.js';
import type { Logger } from '../logger/index.js';

/**
 * Listener callback invoked when configuration changes.
 */
export type ConfigChangeListener = (
  newConfig: TsgoTurboConfig,
  oldConfig: TsgoTurboConfig,
) => void;

/**
 * ConfigLoader manages loading, validating, and watching for changes to
 * TsgoTurboConfig via the LSP connection.
 *
 * It loads configuration from VS Code client settings using the
 * `workspace/configuration` request, validates the result, and merges
 * with defaults. When configuration changes are detected, registered
 * listeners are notified.
 *
 * @example
 * ```ts
 * const loader = new ConfigLoader(connection, logger);
 * loader.onConfigChanged((newCfg, oldCfg) => {
 *   if (newCfg.tsgo.maxTypeDepth !== oldCfg.tsgo.maxTypeDepth) {
 *     guard.setMaxDepth(newCfg.tsgo.maxTypeDepth);
 *   }
 * });
 * await loader.load();
 * const config = loader.getConfig();
 * ```
 */
export class ConfigLoader {
  private config: TsgoTurboConfig;
  private readonly listeners: ConfigChangeListener[] = [];
  private readonly connection: Connection;
  private readonly logger: Logger | undefined;
  private hasClientConfigCapability = false;

  /**
   * @param connection - the LSP connection for requesting configuration
   * @param logger - optional logger for config load/validation messages
   */
  constructor(connection: Connection, logger?: Logger) {
    this.connection = connection;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Set whether the client supports workspace/configuration requests.
   * This should be called during initialize based on client capabilities.
   */
  setHasConfigCapability(has: boolean): void {
    this.hasClientConfigCapability = has;
  }

  /**
   * Load configuration from the LSP client.
   * Validates the raw config and merges with defaults.
   * Notifies listeners if the config changed.
   */
  async load(): Promise<TsgoTurboConfig> {
    if (!this.hasClientConfigCapability) {
      this.logger?.debug('Client does not support workspace/configuration, using defaults');
      return this.config;
    }

    try {
      const items = await this.connection.workspace.getConfiguration({
        section: EXTENSION_ID,
      });

      return this.applyRawConfig(items);
    } catch (err) {
      this.logger?.error('Failed to load configuration from client', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.config;
    }
  }

  /**
   * Apply a raw configuration object (e.g., from onDidChangeConfiguration).
   * Validates, merges with defaults, and notifies listeners.
   *
   * @param raw - the raw settings object from the client
   * @returns the new validated configuration
   */
  applyRawConfig(raw: unknown): TsgoTurboConfig {
    const oldConfig = this.config;
    const result = validateConfig(raw);

    if (!result.valid || !result.config) {
      this.logger?.warn('Configuration validation failed, keeping previous config', {
        errors: result.errors,
      });
      return this.config;
    }

    this.config = result.config;

    // Notify listeners if config actually changed
    const configJson = JSON.stringify(this.config);
    const oldJson = JSON.stringify(oldConfig);
    if (configJson !== oldJson) {
      this.logger?.info('Configuration updated', {
        changedSections: this.detectChangedSections(oldConfig, this.config),
      });
      this.notifyListeners(this.config, oldConfig);
    }

    return this.config;
  }

  /**
   * Get the current validated configuration.
   */
  getConfig(): TsgoTurboConfig {
    return this.config;
  }

  /**
   * Register a listener that will be called when configuration changes.
   *
   * @param listener - callback receiving new and old config
   * @returns a dispose function to unregister the listener
   */
  onConfigChanged(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Force a reload from the client.
   * Equivalent to calling load() but explicitly named for use as a command handler.
   */
  async reload(): Promise<TsgoTurboConfig> {
    this.logger?.info('Reloading configuration');
    return this.load();
  }

  private notifyListeners(
    newConfig: TsgoTurboConfig,
    oldConfig: TsgoTurboConfig,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(newConfig, oldConfig);
      } catch (err) {
        this.logger?.error('Config change listener threw an error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Detect which top-level sections changed between two configs.
   */
  private detectChangedSections(
    oldConfig: TsgoTurboConfig,
    newConfig: TsgoTurboConfig,
  ): string[] {
    const sections: Array<keyof TsgoTurboConfig> = [
      'tsgo',
      'oxc',
      'logging',
      'cache',
      'watch',
      'inspector',
    ];
    const changed: string[] = [];
    for (const section of sections) {
      if (JSON.stringify(oldConfig[section]) !== JSON.stringify(newConfig[section])) {
        changed.push(section);
      }
    }
    return changed;
  }
}
