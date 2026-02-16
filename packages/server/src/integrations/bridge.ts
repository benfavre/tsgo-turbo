import type {
  TsgoTurboConfig,
  FileAnalysisResult,
  TurbodiagnosticItem,
} from '@tsgo-turbo/shared';
import type { Logger } from '../logger/index.js';
import type { PerfTracer } from '../logger/performance.js';
import { TsgoIntegration } from './tsgo.js';
import { OxcIntegration } from './oxc.js';
import { FileCache } from '../cache/fileCache.js';

/**
 * Priority levels for analysis queue items.
 * Open files (active editor) get highest priority.
 */
export enum AnalysisPriority {
  /** Currently focused file in the editor */
  Active = 0,
  /** Open files (visible in tabs) */
  Open = 1,
  /** Background analysis (saved files, workspace scan) */
  Background = 2,
}

/**
 * An item in the analysis queue.
 */
interface QueueItem {
  uri: string;
  content: string;
  priority: AnalysisPriority;
  force: boolean;
  resolve: (result: FileAnalysisResult) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/**
 * AnalysisBridge orchestrates both tsgo and oxc integrations, running them
 * in parallel for each file and merging their results. It manages a priority
 * queue for analysis requests, deduplicates requests for the same file, and
 * checks the file cache before dispatching to the tools.
 *
 * This is the primary interface that the LSP server uses to analyze files.
 *
 * @example
 * ```ts
 * const bridge = new AnalysisBridge(config, logger, perfTracer);
 * await bridge.start();
 *
 * const result = await bridge.analyzeFile(uri, content);
 * // result.diagnostics contains merged tsgo + oxc diagnostics
 *
 * await bridge.shutdown();
 * ```
 */
export class AnalysisBridge {
  private readonly tsgo: TsgoIntegration;
  private readonly oxc: OxcIntegration;
  private readonly cache: FileCache<FileAnalysisResult>;
  private readonly logger: Logger;
  private readonly perfTracer: PerfTracer;
  private config: TsgoTurboConfig;
  private readonly queue: QueueItem[] = [];
  private processing = false;
  private readonly maxConcurrentAnalyses: number;
  private activeAnalyses = 0;
  private filesAnalyzedCount = 0;
  private started = false;

  /**
   * @param config - full TsgoTurboConfig
   * @param logger - logger instance
   * @param perfTracer - performance tracer
   * @param maxConcurrentAnalyses - max files analyzed simultaneously (default 4)
   */
  constructor(
    config: TsgoTurboConfig,
    logger: Logger,
    perfTracer: PerfTracer,
    maxConcurrentAnalyses = 4,
  ) {
    this.config = config;
    this.logger = logger;
    this.perfTracer = perfTracer;
    this.maxConcurrentAnalyses = maxConcurrentAnalyses;

    this.tsgo = new TsgoIntegration(
      config.tsgo,
      logger.child({ component: 'tsgo' }),
    );
    this.oxc = new OxcIntegration(
      config.oxc,
      logger.child({ component: 'oxc' }),
    );
    this.cache = new FileCache<FileAnalysisResult>(config.cache);
  }

  /** Get the tsgo integration for direct access (hover, completions). */
  get tsgoIntegration(): TsgoIntegration {
    return this.tsgo;
  }

  /** Get the oxc integration for direct access. */
  get oxcIntegration(): OxcIntegration {
    return this.oxc;
  }

  /** Total number of files analyzed since server start. */
  get totalFilesAnalyzed(): number {
    return this.filesAnalyzedCount;
  }

  /** Number of items currently in the analysis queue. */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Number of analyses currently in progress. */
  get activeCount(): number {
    return this.activeAnalyses;
  }

  /**
   * Start both tsgo and oxc integrations.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger.info('Starting analysis bridge');

    const startPromises: Promise<void>[] = [];

    if (this.config.tsgo.enabled) {
      startPromises.push(this.tsgo.start());
    }
    if (this.config.oxc.enabled) {
      startPromises.push(this.oxc.start());
    }

    const results = await Promise.allSettled(startPromises);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error('Failed to start integration', {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }

    this.started = true;
    this.logger.info('Analysis bridge started');
  }

  /**
   * Analyze a file by running tsgo and oxc in parallel.
   *
   * Checks cache first (unless force=true). Deduplicates concurrent requests
   * for the same file. Returns merged diagnostics from both tools.
   *
   * @param uri - file URI
   * @param content - file content
   * @param force - skip cache and force re-analysis
   * @param priority - queue priority (default: Open)
   * @returns merged analysis result
   */
  async analyzeFile(
    uri: string,
    content: string,
    force = false,
    priority: AnalysisPriority = AnalysisPriority.Open,
  ): Promise<FileAnalysisResult> {
    const contentHash = FileCache.computeHash(content);

    // Check cache unless forced
    if (!force && this.config.cache.enabled) {
      const cached = this.cache.get(uri, contentHash);
      if (cached) {
        this.logger.debug('Cache hit for file', { uri });
        return { ...cached, cached: true };
      }
    }

    // Deduplicate: if there's already a pending request for this URI, replace it
    const existingIdx = this.queue.findIndex((item) => item.uri === uri);
    if (existingIdx >= 0) {
      const existing = this.queue[existingIdx];
      // Reject the old request — it will be superseded
      existing.reject(new Error('Superseded by newer request'));
      this.queue.splice(existingIdx, 1);
    }

    // Enqueue the analysis
    return new Promise<FileAnalysisResult>((resolve, reject) => {
      this.queue.push({
        uri,
        content,
        priority,
        force,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      // Sort queue by priority (lower number = higher priority)
      this.queue.sort((a, b) => a.priority - b.priority);

      // Try to process
      this.processQueue();
    });
  }

  /**
   * Invalidate cache for a file.
   */
  invalidateCache(uri: string): void {
    this.cache.invalidate(uri);
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.info('All caches cleared');
  }

  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: TsgoTurboConfig): void {
    this.config = config;
    this.tsgo.updateConfig(config.tsgo);
    this.oxc.updateConfig(config.oxc);
    this.logger.info('Analysis bridge configuration updated');
  }

  /**
   * Get information about active tool processes.
   */
  getProcessInfo() {
    return [
      ...this.tsgo.getProcessInfo().map((p) => ({
        ...p,
        tool: 'tsgo' as const,
        memoryMb: 0,
        cpuPercent: 0,
      })),
      ...this.oxc.getProcessInfo().map((p) => ({
        ...p,
        memoryMb: 0,
        cpuPercent: 0,
        activeFile: undefined,
      })),
    ];
  }

  /**
   * Gracefully shut down both integrations.
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down analysis bridge');

    // Reject all queued items
    for (const item of this.queue) {
      item.reject(new Error('AnalysisBridge shutting down'));
    }
    this.queue.length = 0;

    await Promise.allSettled([
      this.tsgo.shutdown(),
      this.oxc.shutdown(),
    ]);

    this.started = false;
    this.logger.info('Analysis bridge shut down');
  }

  /**
   * Process items from the queue up to the concurrency limit.
   */
  private processQueue(): void {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (
        this.queue.length > 0 &&
        this.activeAnalyses < this.maxConcurrentAnalyses
      ) {
        const item = this.queue.shift()!;
        this.activeAnalyses++;
        this.executeAnalysis(item).finally(() => {
          this.activeAnalyses--;
          // Recursively process more items
          this.processQueue();
        });
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute analysis for a single queue item.
   * Runs tsgo and oxc in parallel and merges the results.
   */
  private async executeAnalysis(item: QueueItem): Promise<void> {
    const spanId = this.perfTracer.startSpan('analyzeFile', undefined, {
      uri: item.uri,
      priority: item.priority,
    });

    const startTime = Date.now();
    const contentHash = FileCache.computeHash(item.content);

    try {
      const promises: Promise<FileAnalysisResult>[] = [];

      // Run tsgo if enabled
      if (this.config.tsgo.enabled) {
        const tsgoSpanId = this.perfTracer.startSpan('tsgo.analyze', spanId, {
          uri: item.uri,
        });
        promises.push(
          this.tsgo
            .analyze(item.uri, item.content)
            .finally(() => this.perfTracer.endSpan(tsgoSpanId)),
        );
      }

      // Run oxc if enabled
      if (this.config.oxc.enabled) {
        const oxcSpanId = this.perfTracer.startSpan('oxc.lint', spanId, {
          uri: item.uri,
        });
        promises.push(
          this.oxc
            .lint(item.uri, item.content)
            .finally(() => this.perfTracer.endSpan(oxcSpanId)),
        );
      }

      // Wait for all tools to complete
      const results = await Promise.allSettled(promises);
      const analysisTimeMs = Date.now() - startTime;

      // Merge diagnostics from all successful results
      const allDiagnostics: TurbodiagnosticItem[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allDiagnostics.push(...result.value.diagnostics);
        } else {
          this.logger.warn('Tool analysis failed', {
            uri: item.uri,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }

      // Deduplicate diagnostics that might overlap between tools
      const deduplicated = this.deduplicateDiagnostics(allDiagnostics);

      const mergedResult: FileAnalysisResult = {
        uri: item.uri,
        diagnostics: deduplicated,
        analysisTimeMs,
        cached: false,
        contentHash,
      };

      // Cache the result
      if (this.config.cache.enabled) {
        this.cache.set(item.uri, contentHash, mergedResult);
      }

      this.filesAnalyzedCount++;
      this.perfTracer.endSpan(spanId, {
        diagnosticCount: deduplicated.length,
        durationMs: analysisTimeMs,
      });

      item.resolve(mergedResult);
    } catch (err) {
      this.perfTracer.endSpan(spanId, {
        error: err instanceof Error ? err.message : String(err),
      });

      this.logger.error('Analysis execution failed', {
        uri: item.uri,
        error: err instanceof Error ? err.message : String(err),
      });

      // Return empty result rather than rejecting — partial results are better than none
      item.resolve({
        uri: item.uri,
        diagnostics: [],
        analysisTimeMs: Date.now() - startTime,
        cached: false,
        contentHash,
      });
    }
  }

  /**
   * Deduplicate diagnostics that have the same file, line, column, and message.
   * Prefers the version from the more authoritative source (tsgo > oxc).
   */
  private deduplicateDiagnostics(
    diagnostics: TurbodiagnosticItem[],
  ): TurbodiagnosticItem[] {
    const seen = new Map<string, TurbodiagnosticItem>();

    for (const diag of diagnostics) {
      const key = `${diag.file}:${diag.line}:${diag.column}:${diag.message}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, diag);
      } else if (diag.source === 'tsgo' && existing.source !== 'tsgo') {
        // Prefer tsgo diagnostics when they overlap
        seen.set(key, diag);
      }
    }

    return Array.from(seen.values());
  }
}
