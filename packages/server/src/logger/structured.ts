import type { LogLevel } from '@tsgo-turbo/shared';
import { LOG_LEVEL_VALUES } from '@tsgo-turbo/shared';

/**
 * A single structured log entry produced by the logger.
 */
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  source: string;
  spanId?: string;
}

/**
 * Ring buffer that stores recent log entries for querying by the inspector.
 * Fixed-capacity circular buffer: once full, oldest entries are overwritten.
 */
export class LogRingBuffer {
  private readonly buffer: Array<LogEntry | undefined>;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = Array.from<LogEntry | undefined>({ length: capacity });
  }

  /** Push a new entry into the ring buffer. Overwrites oldest if full. */
  push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Return all stored entries in chronological order. */
  toArray(): LogEntry[] {
    const result: LogEntry[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Return entries filtered by minimum log level. */
  query(minLevel: LogLevel): LogEntry[] {
    const minValue = LOG_LEVEL_VALUES[minLevel] ?? 0;
    return this.toArray().filter(
      (e) => (LOG_LEVEL_VALUES[e.level] ?? 0) >= minValue,
    );
  }

  /** Clear all entries. */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  /** Current number of stored entries. */
  get size(): number {
    return this.count;
  }
}

/**
 * StructuredLogger is responsible for formatting log entries and batching
 * them before flushing to an output sink (LSP connection notification or file).
 *
 * It does not own the connection or file handle -- callers provide flush callbacks.
 */
export class StructuredLogger {
  private batch: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly ringBuffer: LogRingBuffer;

  /**
   * @param flushCallback - invoked with batched entries on flush
   * @param prettyPrint - whether to pretty-print JSON (dev mode)
   * @param batchIntervalMs - how often to auto-flush (default 100ms)
   * @param ringCapacity - size of in-memory ring buffer for inspector
   */
  constructor(
    private readonly flushCallback: (entries: LogEntry[]) => void,
    private readonly prettyPrint: boolean = false,
    private readonly batchIntervalMs: number = 100,
    ringCapacity: number = 2000,
  ) {
    this.ringBuffer = new LogRingBuffer(ringCapacity);
  }

  /** Add a log entry to the batch and ring buffer. */
  append(entry: LogEntry): void {
    this.ringBuffer.push(entry);
    this.batch.push(entry);
    this.scheduleFlush();
  }

  /** Format a log entry to a JSON string. */
  format(entry: LogEntry): string {
    if (this.prettyPrint) {
      const ts = new Date(entry.timestamp).toISOString();
      const lvl = entry.level.toUpperCase().padEnd(5);
      const src = entry.source ? `[${entry.source}]` : '';
      const ctx =
        Object.keys(entry.context).length > 0
          ? ` ${JSON.stringify(entry.context)}`
          : '';
      const span = entry.spanId ? ` (span:${entry.spanId})` : '';
      return `${ts} ${lvl} ${src} ${entry.message}${ctx}${span}`;
    }
    return JSON.stringify(entry);
  }

  /** Immediately flush all pending entries. */
  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.batch.length === 0) {
      return;
    }
    const entries = this.batch;
    this.batch = [];
    try {
      this.flushCallback(entries);
    } catch {
      // Swallow flush errors -- logging should never crash the server
    }
  }

  /** Query the ring buffer for recent entries at or above the given level. */
  queryRecent(minLevel: LogLevel): LogEntry[] {
    return this.ringBuffer.query(minLevel);
  }

  /** Get all entries in the ring buffer. */
  getRecentEntries(): LogEntry[] {
    return this.ringBuffer.toArray();
  }

  /** Dispose timers and flush remaining entries. */
  dispose(): void {
    this.flush();
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.batchIntervalMs);
  }
}
