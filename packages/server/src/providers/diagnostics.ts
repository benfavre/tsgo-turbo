import type { Connection } from 'vscode-languageserver';
import {
  Diagnostic,
  DiagnosticSeverity as LspDiagnosticSeverity,
  Range,
  Position,
} from 'vscode-languageserver';
import type {
  TurbodiagnosticItem,
  DiagnosticSeverity,
  DiagnosticSource,
} from '@tsgo-turbo/shared';
import type { Logger } from '../logger/index.js';

/**
 * Filter criteria for diagnostics.
 */
export interface DiagnosticFilter {
  /** Include only diagnostics from these sources. If empty/undefined, include all. */
  sources?: DiagnosticSource[];
  /** Minimum severity to include. */
  minSeverity?: DiagnosticSeverity;
}

/**
 * DiagnosticsProvider converts TurbodiagnosticItem arrays from the analysis
 * bridge into LSP Diagnostic objects and publishes them to the client.
 *
 * It manages diagnostic collections per file, supports filtering by source
 * and severity, and debounces rapid updates to avoid flooding the client.
 *
 * @example
 * ```ts
 * const provider = new DiagnosticsProvider(connection, logger);
 * provider.updateDiagnostics('file:///app.ts', diagnostics);
 * provider.clearDiagnostics('file:///app.ts');
 * ```
 */
export class DiagnosticsProvider {
  private readonly connection: Connection;
  private readonly logger: Logger;
  /** Current diagnostics per file URI. */
  private readonly filesDiagnostics = new Map<string, TurbodiagnosticItem[]>();
  /** Debounce timers per file URI. */
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Debounce delay in ms. */
  private debounceMs: number;
  /** Active filter. */
  private filter: DiagnosticFilter = {};

  /**
   * @param connection - the LSP connection for sending diagnostics
   * @param logger - logger instance
   * @param debounceMs - debounce delay for rapid updates (default 100ms)
   */
  constructor(connection: Connection, logger: Logger, debounceMs = 100) {
    this.connection = connection;
    this.logger = logger;
    this.debounceMs = debounceMs;
  }

  /**
   * Update diagnostics for a file. Converts to LSP format and publishes
   * to the client, debouncing rapid updates.
   *
   * @param uri - the file URI
   * @param diagnostics - the diagnostics from the analysis bridge
   */
  updateDiagnostics(uri: string, diagnostics: TurbodiagnosticItem[]): void {
    this.filesDiagnostics.set(uri, diagnostics);
    this.scheduleSend(uri);
  }

  /**
   * Clear diagnostics for a file.
   *
   * @param uri - the file URI
   */
  clearDiagnostics(uri: string): void {
    this.filesDiagnostics.delete(uri);
    this.cancelDebounce(uri);
    this.sendToClient(uri, []);
  }

  /**
   * Clear diagnostics for all files.
   */
  clearAll(): void {
    const uris = Array.from(this.filesDiagnostics.keys());
    this.filesDiagnostics.clear();
    for (const [uri, timer] of this.debounceTimers) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri);
    }
    for (const uri of uris) {
      this.sendToClient(uri, []);
    }
  }

  /**
   * Set the diagnostic filter. Triggers re-publish of all existing diagnostics.
   *
   * @param filter - the filter to apply
   */
  setFilter(filter: DiagnosticFilter): void {
    this.filter = filter;
    // Re-publish all existing diagnostics with new filter
    for (const uri of this.filesDiagnostics.keys()) {
      this.scheduleSend(uri);
    }
  }

  /**
   * Set the debounce delay.
   */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  /**
   * Get current raw diagnostics for a file.
   */
  getDiagnostics(uri: string): TurbodiagnosticItem[] {
    return this.filesDiagnostics.get(uri) ?? [];
  }

  /**
   * Get all tracked file URIs.
   */
  getTrackedUris(): string[] {
    return Array.from(this.filesDiagnostics.keys());
  }

  /**
   * Get total diagnostic count across all files.
   */
  getTotalDiagnosticCount(): number {
    let total = 0;
    for (const diagnostics of this.filesDiagnostics.values()) {
      total += diagnostics.length;
    }
    return total;
  }

  /**
   * Dispose all timers.
   */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Schedule a debounced send for a URI.
   */
  private scheduleSend(uri: string): void {
    this.cancelDebounce(uri);

    if (this.debounceMs <= 0) {
      this.publishDiagnostics(uri);
      return;
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(uri);
      this.publishDiagnostics(uri);
    }, this.debounceMs);

    this.debounceTimers.set(uri, timer);
  }

  /**
   * Cancel any pending debounced send for a URI.
   */
  private cancelDebounce(uri: string): void {
    const existing = this.debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(uri);
    }
  }

  /**
   * Convert and publish diagnostics for a URI.
   */
  private publishDiagnostics(uri: string): void {
    const items = this.filesDiagnostics.get(uri) ?? [];
    const filtered = this.applyFilter(items);
    const lspDiagnostics = filtered.map((item) => this.toLspDiagnostic(item));
    this.sendToClient(uri, lspDiagnostics);
  }

  /**
   * Apply the current filter to a diagnostics array.
   */
  private applyFilter(items: TurbodiagnosticItem[]): TurbodiagnosticItem[] {
    let result = items;

    if (this.filter.sources && this.filter.sources.length > 0) {
      const sources = new Set(this.filter.sources);
      result = result.filter((item) => sources.has(item.source));
    }

    if (this.filter.minSeverity) {
      const minLevel = this.severityLevel(this.filter.minSeverity);
      result = result.filter(
        (item) => this.severityLevel(item.severity) <= minLevel,
      );
    }

    return result;
  }

  /**
   * Convert a TurbodiagnosticItem to an LSP Diagnostic.
   */
  private toLspDiagnostic(item: TurbodiagnosticItem): Diagnostic {
    const startPos = Position.create(
      Math.max(0, item.line - 1),
      Math.max(0, item.column - 1),
    );
    const endPos = Position.create(
      Math.max(0, (item.endLine ?? item.line) - 1),
      Math.max(0, (item.endColumn ?? item.column) - 1),
    );

    // Ensure end is after start
    const range = Range.create(startPos, endPos);

    const diagnostic: Diagnostic = {
      range,
      message: item.message,
      severity: this.toLspSeverity(item.severity),
      source: `tsgo-turbo (${item.source})`,
      code: item.code,
    };

    // Attach data for code actions
    if (item.data) {
      diagnostic.data = {
        ...item.data,
        source: item.source,
        computeTimeMs: item.computeTimeMs,
      };
    }

    return diagnostic;
  }

  /**
   * Send diagnostics to the LSP client.
   */
  private sendToClient(uri: string, diagnostics: Diagnostic[]): void {
    try {
      this.connection.sendDiagnostics({ uri, diagnostics });
    } catch (err) {
      this.logger.error('Failed to send diagnostics', {
        uri,
        count: diagnostics.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Map our severity to LSP DiagnosticSeverity.
   */
  private toLspSeverity(severity: DiagnosticSeverity): LspDiagnosticSeverity {
    switch (severity) {
      case 'error':
        return LspDiagnosticSeverity.Error;
      case 'warning':
        return LspDiagnosticSeverity.Warning;
      case 'info':
        return LspDiagnosticSeverity.Information;
      case 'hint':
        return LspDiagnosticSeverity.Hint;
      default:
        return LspDiagnosticSeverity.Error;
    }
  }

  /**
   * Numeric severity level (lower = more severe).
   */
  private severityLevel(severity: DiagnosticSeverity): number {
    switch (severity) {
      case 'error':
        return 1;
      case 'warning':
        return 2;
      case 'info':
        return 3;
      case 'hint':
        return 4;
      default:
        return 5;
    }
  }
}
