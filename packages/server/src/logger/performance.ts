import type { PerfSpan } from '@tsgo-turbo/shared';
import { randomUUID } from 'node:crypto';

/**
 * Callback invoked when a span completes and exceeds the slow threshold.
 */
export type SlowSpanCallback = (span: PerfSpan) => void;

/**
 * PerfTracer provides hierarchical performance tracing with nested span support.
 *
 * Spans form a tree: each span can have a parentId linking it to a parent span.
 * Completed trace trees can be exported for the inspector panel.
 *
 * @example
 * ```ts
 * const tracer = new PerfTracer();
 * const rootId = tracer.startSpan('analyzeFile');
 * const tsgoId = tracer.startSpan('tsgo', rootId);
 * tracer.endSpan(tsgoId);
 * const oxcId = tracer.startSpan('oxc', rootId);
 * tracer.endSpan(oxcId);
 * tracer.endSpan(rootId);
 * const trace = tracer.getTrace(rootId);
 * ```
 */
export class PerfTracer {
  /** Active (in-progress) spans by id. */
  private readonly activeSpans = new Map<string, PerfSpan>();
  /** Completed spans by id. */
  private readonly completedSpans = new Map<string, PerfSpan>();
  /** Root span ids in insertion order, bounded to maxHistory. */
  private readonly rootHistory: string[] = [];
  /** Threshold in ms above which a completed span triggers the slow callback. */
  private slowThresholdMs: number;
  /** Maximum number of completed root traces to retain. */
  private readonly maxHistory: number;
  /** Optional callback for slow spans. */
  private onSlowSpan: SlowSpanCallback | undefined;

  /**
   * @param slowThresholdMs - spans exceeding this duration trigger onSlowSpan
   * @param maxHistory - maximum number of root trace trees to keep in memory
   */
  constructor(slowThresholdMs = 1000, maxHistory = 1000) {
    this.slowThresholdMs = slowThresholdMs;
    this.maxHistory = maxHistory;
  }

  /** Set the callback invoked when a span exceeds the slow threshold. */
  setSlowSpanCallback(cb: SlowSpanCallback): void {
    this.onSlowSpan = cb;
  }

  /** Update the slow threshold. */
  setSlowThreshold(ms: number): void {
    this.slowThresholdMs = ms;
  }

  /**
   * Start a new performance span.
   *
   * @param name - human-readable span name (e.g. 'tsgo.analyze')
   * @param parentId - optional parent span id for nesting
   * @param metadata - optional key-value metadata attached to the span
   * @returns the span id
   */
  startSpan(
    name: string,
    parentId?: string,
    metadata?: Record<string, unknown>,
  ): string {
    const id = randomUUID();
    const span: PerfSpan = {
      id,
      name,
      startTime: Date.now(),
      parentId,
      metadata,
      children: [],
    };
    this.activeSpans.set(id, span);

    // Track root spans for history management
    if (!parentId) {
      this.rootHistory.push(id);
      this.evictOldTraces();
    }

    return id;
  }

  /**
   * End a span by its id.
   * Computes duration and moves it from active to completed.
   * If the span has a parent, attaches it as a child of the parent.
   *
   * @param spanId - the id returned by startSpan
   * @param metadata - optional additional metadata to merge on completion
   */
  endSpan(spanId: string, metadata?: Record<string, unknown>): void {
    const span = this.activeSpans.get(spanId);
    if (!span) {
      return;
    }

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    if (metadata) {
      span.metadata = { ...span.metadata, ...metadata };
    }

    this.activeSpans.delete(spanId);
    this.completedSpans.set(spanId, span);

    // Attach to parent if applicable
    if (span.parentId) {
      const parent =
        this.activeSpans.get(span.parentId) ??
        this.completedSpans.get(span.parentId);
      if (parent) {
        parent.children.push(span);
      }
    }

    // Notify slow span callback
    if (
      span.durationMs > this.slowThresholdMs &&
      this.onSlowSpan
    ) {
      try {
        this.onSlowSpan(span);
      } catch {
        // Never let callback errors propagate
      }
    }
  }

  /**
   * Retrieve the full trace tree rooted at the given span id.
   * Children are recursively included.
   *
   * @param rootSpanId - the id of the root span
   * @returns the PerfSpan tree, or undefined if not found
   */
  getTrace(rootSpanId: string): PerfSpan | undefined {
    return (
      this.completedSpans.get(rootSpanId) ??
      this.activeSpans.get(rootSpanId)
    );
  }

  /**
   * Get an active span by id (still in progress).
   */
  getActiveSpan(spanId: string): PerfSpan | undefined {
    return this.activeSpans.get(spanId);
  }

  /**
   * Get all completed root-level traces (most recent first).
   */
  getRecentTraces(limit = 50): PerfSpan[] {
    const result: PerfSpan[] = [];
    for (let i = this.rootHistory.length - 1; i >= 0 && result.length < limit; i--) {
      const id = this.rootHistory[i];
      const span = this.completedSpans.get(id);
      if (span) {
        result.push(span);
      }
    }
    return result;
  }

  /** Number of currently active (in-progress) spans. */
  get activeCount(): number {
    return this.activeSpans.size;
  }

  /** Number of completed spans stored. */
  get completedCount(): number {
    return this.completedSpans.size;
  }

  /** Clear all traces (active and completed). */
  clear(): void {
    this.activeSpans.clear();
    this.completedSpans.clear();
    this.rootHistory.length = 0;
  }

  /**
   * Evict oldest root traces when history exceeds maxHistory.
   */
  private evictOldTraces(): void {
    while (this.rootHistory.length > this.maxHistory) {
      const oldRootId = this.rootHistory.shift();
      if (oldRootId) {
        this.removeTraceTree(oldRootId);
      }
    }
  }

  /**
   * Recursively remove a span and its children from completedSpans.
   */
  private removeTraceTree(spanId: string): void {
    const span = this.completedSpans.get(spanId);
    if (!span) {
      return;
    }
    for (const child of span.children) {
      this.removeTraceTree(child.id);
    }
    this.completedSpans.delete(spanId);
  }
}
