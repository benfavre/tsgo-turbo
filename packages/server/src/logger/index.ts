import type { Connection } from 'vscode-languageserver';
import type { LogLevel, TsgoTurboConfig } from '@tsgo-turbo/shared';
import { LOG_LEVEL_VALUES, CustomMethods } from '@tsgo-turbo/shared';
import type { LogEntryNotification } from '@tsgo-turbo/shared';
import { StructuredLogger, type LogEntry } from './structured.js';
import { PerfTracer } from './performance.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Logger is the primary logging facade for the tsgo-turbo server.
 *
 * It provides:
 * - Structured JSON log entries sent to the LSP client via custom notifications
 * - Optional file-based logging with rotation
 * - Child loggers that inherit parent context
 * - Integration with PerfTracer for performance spans
 *
 * @example
 * ```ts
 * const logger = new Logger(connection, config.logging);
 * logger.info('Server started', { port: 3000 });
 *
 * const child = logger.child({ component: 'tsgo' });
 * child.warn('Process restarted', { pid: 1234 });
 * ```
 */
export class Logger {
  private readonly structured: StructuredLogger;
  private readonly perf: PerfTracer;
  private level: LogLevel;
  private readonly source: string;
  private readonly baseContext: Record<string, unknown>;
  private logFilePath: string | undefined;
  private logFileStream: fs.WriteStream | undefined;
  private logFileSizeBytes = 0;
  private maxFileSizeMb: number;
  private readonly connection: Connection | undefined;
  private disposed = false;

  /**
   * Create a new Logger instance.
   *
   * @param connection - the LSP connection for sending log notifications (may be undefined for testing)
   * @param loggingConfig - logging section of TsgoTurboConfig
   * @param source - source label for log entries (default 'server')
   * @param baseContext - context inherited by all entries from this logger
   * @param parentStructured - shared StructuredLogger instance (for child loggers)
   * @param parentPerf - shared PerfTracer instance (for child loggers)
   */
  constructor(
    connection: Connection | undefined,
    loggingConfig: TsgoTurboConfig['logging'],
    source = 'server',
    baseContext: Record<string, unknown> = {},
    parentStructured?: StructuredLogger,
    parentPerf?: PerfTracer,
  ) {
    this.connection = connection;
    this.level = loggingConfig.level;
    this.source = source;
    this.baseContext = baseContext;
    this.maxFileSizeMb = loggingConfig.maxFileSizeMb;

    // Create or reuse the structured logger
    this.structured =
      parentStructured ??
      new StructuredLogger(
        (entries) => this.flushEntries(entries),
        loggingConfig.prettyPrint,
      );

    // Create or reuse the perf tracer
    this.perf = parentPerf ?? new PerfTracer();

    // Set up file logging if configured
    if (loggingConfig.file) {
      this.setupFileLogging(loggingConfig.file);
    }
  }

  /**
   * Create a child logger that inherits this logger's context and structured backend.
   * Child loggers share the same StructuredLogger and PerfTracer instances.
   *
   * @param context - additional context merged into the child's base context
   * @returns a new Logger with merged context
   */
  child(context: Record<string, unknown>): Logger {
    const childConfig: TsgoTurboConfig['logging'] = {
      level: this.level,
      perfTracing: true,
      maxFileSizeMb: this.maxFileSizeMb,
      prettyPrint: false,
    };
    const childSource = (context['component'] as string) ?? this.source;
    return new Logger(
      this.connection,
      childConfig,
      childSource,
      { ...this.baseContext, ...context },
      this.structured,
      this.perf,
    );
  }

  /** Get the underlying PerfTracer for performance tracing. */
  get perfTracer(): PerfTracer {
    return this.perf;
  }

  /** Get the underlying StructuredLogger for ring buffer queries. */
  get structuredLogger(): StructuredLogger {
    return this.structured;
  }

  /** Update the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Log a trace-level message. */
  trace(message: string, context?: Record<string, unknown>): void {
    this.log('trace', message, context);
  }

  /** Log a debug-level message. */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  /** Log an info-level message. */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  /** Log a warn-level message. */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  /** Log an error-level message. */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  /** Log a fatal-level message. */
  fatal(message: string, context?: Record<string, unknown>): void {
    this.log('fatal', message, context);
  }

  /**
   * Flush pending log entries immediately.
   * Useful before shutdown.
   */
  flush(): void {
    this.structured.flush();
  }

  /** Dispose the logger, flushing entries and closing file streams. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.structured.dispose();
    if (this.logFileStream) {
      this.logFileStream.end();
      this.logFileStream = undefined;
    }
  }

  /**
   * Query recent log entries at or above the given level.
   */
  queryRecent(minLevel?: LogLevel): LogEntry[] {
    return this.structured.queryRecent(minLevel ?? 'trace');
  }

  /**
   * Log a message with an associated performance span id for correlation.
   */
  logWithSpan(
    level: LogLevel,
    message: string,
    spanId: string,
    context?: Record<string, unknown>,
  ): void {
    this.log(level, message, context, spanId);
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    spanId?: string,
  ): void {
    if (this.disposed) {
      return;
    }
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      context: { ...this.baseContext, ...context },
      source: this.source,
      spanId,
    };

    this.structured.append(entry);
  }

  private shouldLog(level: LogLevel): boolean {
    const currentValue = LOG_LEVEL_VALUES[this.level] ?? 0;
    const entryValue = LOG_LEVEL_VALUES[level] ?? 0;
    return entryValue >= currentValue;
  }

  private flushEntries(entries: LogEntry[]): void {
    // Send to LSP client via custom notification
    if (this.connection) {
      for (const entry of entries) {
        const notification: LogEntryNotification = {
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          context:
            Object.keys(entry.context).length > 0
              ? entry.context
              : undefined,
          source: entry.source,
        };
        try {
          this.connection.sendNotification(CustomMethods.logEntry, notification);
        } catch {
          // Connection may not be ready; swallow
        }
      }
    }

    // Write to file if configured
    if (this.logFileStream) {
      for (const entry of entries) {
        const line = this.structured.format(entry) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        this.logFileSizeBytes += lineBytes;
        this.logFileStream.write(line);
      }
      this.checkRotation();
    }
  }

  private setupFileLogging(filePath: string): void {
    try {
      // Close existing stream if present to prevent resource leaks
      if (this.logFileStream) {
        this.logFileStream.end();
        this.logFileStream = undefined;
      }

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Check existing file size
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        this.logFileSizeBytes = stat.size;
      }
      this.logFilePath = filePath;
      this.logFileStream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch {
      // If file logging fails, continue without it
      this.logFilePath = undefined;
      this.logFileStream = undefined;
    }
  }

  private checkRotation(): void {
    if (!this.logFilePath || !this.logFileStream) {
      return;
    }
    const maxBytes = this.maxFileSizeMb * 1024 * 1024;
    if (this.logFileSizeBytes < maxBytes) {
      return;
    }

    try {
      this.logFileStream.end();
      const rotatedPath = `${this.logFilePath}.1`;
      // Remove old rotated file if present
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
      fs.renameSync(this.logFilePath, rotatedPath);
      this.logFileStream = fs.createWriteStream(this.logFilePath, {
        flags: 'a',
      });
      this.logFileSizeBytes = 0;
    } catch {
      // If rotation fails, continue without file logging
      this.logFileStream = undefined;
    }
  }
}

export { StructuredLogger, type LogEntry } from './structured.js';
export { PerfTracer } from './performance.js';
