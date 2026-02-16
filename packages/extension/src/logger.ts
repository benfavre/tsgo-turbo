import * as vscode from 'vscode';
import type { LogLevel } from '@tsgo-turbo/shared';
import { OUTPUT_CHANNEL_NAME, LOG_LEVEL_VALUES } from '@tsgo-turbo/shared';
import type { LogEntryNotification } from '@tsgo-turbo/shared';

/**
 * Severity label used for prefixing log lines in the output channel.
 * Maps each level to a human-readable, fixed-width tag.
 */
const LEVEL_LABELS: Record<string, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info:  'INFO ',
  warn:  'WARN ',
  error: 'ERROR',
  fatal: 'FATAL',
};

/**
 * ClientLogger provides the extension-side logging surface.
 *
 * It owns a VS Code OutputChannel named "tsgo Turbo" and is responsible for:
 * - Formatting and displaying log entries received from the LSP server via
 *   the `tsgoTurbo/logEntry` custom notification.
 * - Allowing the extension itself to emit client-side log messages.
 * - Filtering messages by the configured minimum log level.
 * - Providing a `show()` method to reveal the output panel on demand.
 */
export class ClientLogger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.minLevel = minLevel;
  }

  /**
   * Update the minimum log level filter. Messages below this severity
   * will be silently dropped.
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Handle a {@link LogEntryNotification} received from the LSP server.
   * The entry is formatted with a timestamp, level badge, source tag, and
   * optional structured context before being appended to the output channel.
   */
  handleServerLogEntry(entry: LogEntryNotification): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }
    const line = this.formatEntry(entry);
    this.channel.appendLine(line);
  }

  /**
   * Write a client-side log message to the output channel.
   */
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const entry: LogEntryNotification = {
      timestamp: Date.now(),
      level,
      message,
      source: 'extension',
      context,
    };
    const line = this.formatEntry(entry);
    this.channel.appendLine(line);
  }

  /** Convenience — log at info level. */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  /** Convenience — log at warn level. */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  /** Convenience — log at error level. */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  /** Convenience — log at debug level. */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  /** Convenience — log at trace level. */
  trace(message: string, context?: Record<string, unknown>): void {
    this.log('trace', message, context);
  }

  /** Reveal the output channel in the VS Code panel area. */
  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  /**
   * Format a log entry into a single human-readable line.
   *
   * Format: `HH:MM:SS.mmm LEVEL [source] message {context}`
   */
  private formatEntry(entry: LogEntryNotification): string {
    const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
    const label = LEVEL_LABELS[entry.level] ?? entry.level.toUpperCase().padEnd(5);
    const src = entry.source ? ` [${entry.source}]` : '';
    let line = `${ts} ${label}${src} ${entry.message}`;

    if (entry.context && Object.keys(entry.context).length > 0) {
      line += ` ${JSON.stringify(entry.context)}`;
    }

    return line;
  }

  /** Return true if the given level passes the current minimum filter. */
  private shouldLog(level: string): boolean {
    const value = LOG_LEVEL_VALUES[level] ?? 0;
    const minValue = LOG_LEVEL_VALUES[this.minLevel] ?? 0;
    return value >= minValue;
  }
}
