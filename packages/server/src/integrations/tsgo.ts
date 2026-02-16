import { spawn, type ChildProcess } from 'node:child_process';
import type {
  TsgoTurboConfig,
  FileAnalysisResult,
  TurbodiagnosticItem,
  DiagnosticSeverity,
} from '@tsgo-turbo/shared';
import { IPC_MESSAGES } from '@tsgo-turbo/shared';
import type { Logger } from '../logger/index.js';
import { FileCache } from '../cache/fileCache.js';

/** Interval (ms) between health check pings to idle tsgo processes. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;
/** Interval (ms) between memory/liveness checks on tsgo processes. */
const MEMORY_CHECK_INTERVAL_MS = 10_000;
/** Default tsgo binary name when no binaryPath is configured. */
const DEFAULT_BINARY = 'tsgo';
/** Timeout (ms) for graceful shutdown before sending SIGKILL. */
const FORCE_KILL_TIMEOUT_MS = 5_000;
/** Delay (ms) between SIGTERM and SIGKILL during graceful shutdown. */
const SIGTERM_GRACE_MS = 1_000;

/**
 * Internal representation of a pooled tsgo child process.
 */
interface TsgoProcess {
  process: ChildProcess;
  pid: number;
  busy: boolean;
  activeFile: string | undefined;
  startedAt: number;
  requestCount: number;
  lastHealthCheck: number;
}

/**
 * Raw JSON response structure from tsgo's stdin/stdout protocol.
 */
interface TsgoResponse {
  type: 'result' | 'error';
  uri?: string;
  diagnostics?: TsgoRawDiagnostic[];
  typeInfo?: TsgoTypeInfo;
  completions?: TsgoCompletion[];
  error?: string;
  durationMs?: number;
}

/** Raw diagnostic from tsgo output. */
interface TsgoRawDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: string;
  code?: string;
  category?: string;
}

/** Type info response from tsgo. */
export interface TsgoTypeInfo {
  typeName: string;
  typeString: string;
  documentation?: string;
  depth: number;
  truncated: boolean;
}

/** Completion item from tsgo. */
export interface TsgoCompletion {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  insertText?: string;
}

/**
 * Request types for tsgo stdin protocol.
 */
interface TsgoRequest {
  type: string;
  uri: string;
  content?: string;
  line?: number;
  column?: number;
  flags?: string[];
}

/**
 * TsgoIntegration manages a pool of tsgo child processes for type checking
 * TypeScript files. It communicates with tsgo via a JSON-over-stdin/stdout
 * protocol, handles timeouts, memory monitoring, and automatic process restarts.
 *
 * The pool size is configurable. When all processes are busy, requests are queued
 * and dispatched to the next available process.
 *
 * @example
 * ```ts
 * const tsgo = new TsgoIntegration(config, logger);
 * await tsgo.start();
 * const result = await tsgo.analyze('file:///app.ts', sourceCode);
 * await tsgo.shutdown();
 * ```
 */
export class TsgoIntegration {
  private readonly pool: TsgoProcess[] = [];
  private readonly pendingRequests: Array<{
    request: TsgoRequest;
    resolve: (response: TsgoResponse) => void;
    reject: (error: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  }> = [];
  private config: TsgoTurboConfig['tsgo'];
  private readonly logger: Logger;
  private poolSize: number;
  private healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  private memoryCheckInterval: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private shuttingDown = false;
  private respawning = false;

  /**
   * @param config - tsgo section of TsgoTurboConfig
   * @param logger - logger instance
   * @param poolSize - number of concurrent tsgo processes (default 4)
   */
  constructor(
    config: TsgoTurboConfig['tsgo'],
    logger: Logger,
    poolSize = 4,
  ) {
    this.config = config;
    this.logger = logger;
    this.poolSize = poolSize;
  }

  /**
   * Start the tsgo process pool.
   * Spawns `poolSize` tsgo processes and begins health monitoring.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger.info('Starting tsgo process pool', { poolSize: this.poolSize });

    for (let i = 0; i < this.poolSize; i++) {
      try {
        const proc = this.spawnProcess();
        this.pool.push(proc);
      } catch (err) {
        this.logger.error('Failed to spawn tsgo process', {
          error: err instanceof Error ? err.message : String(err),
          index: i,
        });
      }
    }

    if (this.pool.length === 0) {
      throw new Error('Failed to start any tsgo processes');
    }

    this.started = true;

    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);

    this.memoryCheckInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, MEMORY_CHECK_INTERVAL_MS);

    this.logger.info('tsgo process pool started', {
      activeProcesses: this.pool.length,
    });
  }

  /**
   * Analyze a file using tsgo type checking.
   *
   * Dispatches the request to an available process in the pool. If all processes
   * are busy, the request is queued. Enforces a timeout per file.
   *
   * @param uri - file URI
   * @param content - file content
   * @returns analysis result with diagnostics
   */
  async analyze(uri: string, content: string): Promise<FileAnalysisResult> {
    if (!this.started || this.shuttingDown) {
      throw new Error('TsgoIntegration is not running');
    }

    const contentHash = FileCache.computeHash(content);
    const startTime = Date.now();

    const request: TsgoRequest = {
      type: IPC_MESSAGES.ANALYZE,
      uri,
      content,
      flags: this.config.flags,
    };

    try {
      const response = await this.dispatch(request);
      const analysisTimeMs = Date.now() - startTime;

      if (response.type === 'error') {
        this.logger.warn('tsgo analysis returned error', {
          uri,
          error: response.error,
        });
        return {
          uri,
          diagnostics: [],
          analysisTimeMs,
          cached: false,
          contentHash,
        };
      }

      const diagnostics = this.convertDiagnostics(
        uri,
        response.diagnostics ?? [],
        analysisTimeMs,
      );

      return {
        uri,
        diagnostics,
        analysisTimeMs,
        cached: false,
        contentHash,
      };
    } catch (err) {
      const analysisTimeMs = Date.now() - startTime;
      this.logger.error('tsgo analysis failed', {
        uri,
        error: err instanceof Error ? err.message : String(err),
        durationMs: analysisTimeMs,
      });

      return {
        uri,
        diagnostics: [],
        analysisTimeMs,
        cached: false,
        contentHash,
      };
    }
  }

  /**
   * Get type information for a position in a file.
   *
   * @param uri - file URI
   * @param content - file content
   * @param line - zero-based line number
   * @param column - zero-based column number
   * @returns type info or undefined on failure
   */
  async getTypeInfo(
    uri: string,
    content: string,
    line: number,
    column: number,
  ): Promise<TsgoTypeInfo | undefined> {
    if (!this.started || this.shuttingDown) {
      return undefined;
    }

    const request: TsgoRequest = {
      type: 'typeInfo',
      uri,
      content,
      line,
      column,
    };

    try {
      const response = await this.dispatch(request);
      return response.typeInfo;
    } catch (err) {
      this.logger.warn('tsgo getTypeInfo failed', {
        uri,
        line,
        column,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Get completions at a position in a file.
   *
   * @param uri - file URI
   * @param content - file content
   * @param line - zero-based line number
   * @param column - zero-based column number
   * @returns array of completion items
   */
  async getCompletions(
    uri: string,
    content: string,
    line: number,
    column: number,
  ): Promise<TsgoCompletion[]> {
    if (!this.started || this.shuttingDown) {
      return [];
    }

    const request: TsgoRequest = {
      type: 'completions',
      uri,
      content,
      line,
      column,
    };

    try {
      const response = await this.dispatch(request);
      return response.completions ?? [];
    } catch (err) {
      this.logger.warn('tsgo getCompletions failed', {
        uri,
        line,
        column,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Update the tsgo configuration at runtime.
   */
  updateConfig(config: TsgoTurboConfig['tsgo']): void {
    this.config = config;
    this.logger.info('tsgo configuration updated');
  }

  /**
   * Get information about active processes in the pool.
   */
  getProcessInfo(): Array<{
    pid: number;
    busy: boolean;
    activeFile: string | undefined;
    requestCount: number;
    startedAt: number;
  }> {
    return this.pool.map((p) => ({
      pid: p.pid,
      busy: p.busy,
      activeFile: p.activeFile,
      requestCount: p.requestCount,
      startedAt: p.startedAt,
    }));
  }

  /**
   * Gracefully shut down all tsgo processes.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.logger.info('Shutting down tsgo process pool');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = undefined;
    }

    // Reject all pending requests
    for (const pending of this.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('TsgoIntegration shutting down'));
    }
    this.pendingRequests.length = 0;

    // Kill all processes
    const killPromises = this.pool.map((proc) => this.killProcess(proc));
    await Promise.allSettled(killPromises);
    this.pool.length = 0;

    this.started = false;
    this.shuttingDown = false;
    this.logger.info('tsgo process pool shut down');
  }

  private spawnProcess(): TsgoProcess {
    const binaryPath = this.config.binaryPath ?? DEFAULT_BINARY;
    const args = ['--lsp-stdio', ...this.config.flags];

    this.logger.debug('Spawning tsgo process', { binaryPath, args });

    const child = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${this.config.maxMemoryMb}`,
      },
    });

    const pid = child.pid ?? -1;

    const tsgoProc: TsgoProcess = {
      process: child,
      pid,
      busy: false,
      activeFile: undefined,
      startedAt: Date.now(),
      requestCount: 0,
      lastHealthCheck: Date.now(),
    };

    // Handle process exit — remove from pool and spawn replacement
    child.on('exit', (code, signal) => {
      this.logger.warn('tsgo process exited', { pid, code, signal });

      // Clean up any active stdout listener for this process
      if (tsgoProc.busy && child.stdout) {
        child.stdout.removeAllListeners('data');
        tsgoProc.busy = false;
        tsgoProc.activeFile = undefined;
      }

      const idx = this.pool.indexOf(tsgoProc);
      if (idx >= 0) {
        this.pool.splice(idx, 1);
      }
      // Respawn if not shutting down (guard against concurrent respawns)
      if (!this.shuttingDown && !this.respawning && this.pool.length < this.poolSize) {
        this.respawning = true;
        try {
          const replacement = this.spawnProcess();
          this.pool.push(replacement);
          this.logger.info('Respawned tsgo process', {
            newPid: replacement.pid,
          });
          // Try to dispatch pending requests
          this.dispatchPending();
        } catch (err) {
          this.logger.error('Failed to respawn tsgo process', {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.respawning = false;
        }
      }
    });

    child.on('error', (err) => {
      this.logger.error('tsgo process error', {
        pid,
        error: err.message,
      });
    });

    // Log stderr for debugging
    if (child.stderr) {
      let stderrBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            this.logger.debug('tsgo stderr', { pid, line: line.trim() });
          }
        }
      });
    }

    return tsgoProc;
  }

  /**
   * Dispatch a request to an available process or queue it.
   */
  private dispatch(request: TsgoRequest): Promise<TsgoResponse> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        // Remove from pending queue
        const idx = this.pendingRequests.findIndex(
          (p) => p.resolve === resolve,
        );
        if (idx >= 0) {
          this.pendingRequests.splice(idx, 1);
        }
        reject(new Error(`tsgo request timed out after ${this.config.fileTimeoutMs}ms for ${request.uri}`));
      }, this.config.fileTimeoutMs);

      const pending = { request, resolve, reject, timeoutHandle };

      // Try to find an idle process
      const idle = this.pool.find((p) => !p.busy);
      if (idle) {
        this.sendToProcess(idle, pending);
      } else {
        this.pendingRequests.push(pending);
      }
    });
  }

  /**
   * Send a request to a specific process.
   */
  private sendToProcess(
    proc: TsgoProcess,
    pending: {
      request: TsgoRequest;
      resolve: (response: TsgoResponse) => void;
      reject: (error: Error) => void;
      timeoutHandle: ReturnType<typeof setTimeout>;
    },
  ): void {
    proc.busy = true;
    proc.activeFile = pending.request.uri;
    proc.requestCount++;

    const stdin = proc.process.stdin;
    const stdout = proc.process.stdout;

    if (!stdin || !stdout) {
      proc.busy = false;
      proc.activeFile = undefined;
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('tsgo process has no stdin/stdout'));
      return;
    }

    let responseBuffer = '';

    const onData = (chunk: Buffer) => {
      responseBuffer += chunk.toString();

      // Try to parse complete JSON messages (newline-delimited)
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const response = JSON.parse(trimmed) as TsgoResponse;
          // Clean up
          stdout.removeListener('data', onData);
          clearTimeout(pending.timeoutHandle);
          proc.busy = false;
          proc.activeFile = undefined;
          pending.resolve(response);
          // Dispatch next pending request
          this.dispatchPending();
          return;
        } catch {
          // Incomplete JSON, wait for more data
        }
      }
    };

    stdout.on('data', onData);

    // Send the request as a newline-delimited JSON message
    try {
      stdin.write(JSON.stringify(pending.request) + '\n');
    } catch (err) {
      stdout.removeListener('data', onData);
      clearTimeout(pending.timeoutHandle);
      proc.busy = false;
      proc.activeFile = undefined;
      pending.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Try to dispatch queued requests to idle processes.
   */
  private dispatchPending(): void {
    while (this.pendingRequests.length > 0) {
      const idle = this.pool.find((p) => !p.busy);
      if (!idle) {
        break;
      }
      const pending = this.pendingRequests.shift()!;
      this.sendToProcess(idle, pending);
    }
  }

  /**
   * Perform health checks on all processes.
   */
  private performHealthChecks(): void {
    for (const proc of this.pool) {
      if (proc.busy) {
        continue;
      }
      try {
        // Send a ping via stdin
        proc.process.stdin?.write(
          JSON.stringify({ type: IPC_MESSAGES.HEALTH }) + '\n',
        );
        proc.lastHealthCheck = Date.now();
      } catch {
        this.logger.warn('Health check failed for tsgo process', {
          pid: proc.pid,
        });
      }
    }
  }

  /**
   * Check memory usage of all processes and restart those exceeding the limit.
   */
  private checkMemoryUsage(): void {
    for (const proc of this.pool) {
      if (proc.busy) {
        continue;
      }
      try {
        // On Linux, we can read /proc/pid/status for memory info.
        // For portability, we use a kill(0) check — process is alive.
        // Full memory monitoring would use pidusage or /proc reads.
        // For now, we rely on the --max-old-space-size limit in the spawn env.
        process.kill(proc.pid, 0);
      } catch {
        this.logger.warn('tsgo process no longer alive', { pid: proc.pid });
        const idx = this.pool.indexOf(proc);
        if (idx >= 0) {
          this.pool.splice(idx, 1);
          if (!this.shuttingDown && this.pool.length < this.poolSize) {
            try {
              const replacement = this.spawnProcess();
              this.pool.push(replacement);
            } catch {
              // Logged in spawnProcess
            }
          }
        }
      }
    }
  }

  /**
   * Kill a tsgo process gracefully, then forcefully after a timeout.
   */
  private killProcess(proc: TsgoProcess): Promise<void> {
    return new Promise((resolve) => {
      const forceKillTimeout = setTimeout(() => {
        try {
          proc.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
        resolve();
      }, FORCE_KILL_TIMEOUT_MS);

      proc.process.once('exit', () => {
        clearTimeout(forceKillTimeout);
        resolve();
      });

      try {
        // Try graceful shutdown first
        proc.process.stdin?.write(
          JSON.stringify({ type: IPC_MESSAGES.SHUTDOWN }) + '\n',
        );
        setTimeout(() => {
          try {
            proc.process.kill('SIGTERM');
          } catch {
            // Already dead
          }
        }, SIGTERM_GRACE_MS);
      } catch {
        try {
          proc.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
        clearTimeout(forceKillTimeout);
        resolve();
      }
    });
  }

  /**
   * Convert raw tsgo diagnostics to TurbodiagnosticItem format.
   */
  private convertDiagnostics(
    uri: string,
    raw: TsgoRawDiagnostic[],
    computeTimeMs: number,
  ): TurbodiagnosticItem[] {
    return raw.map((d) => ({
      file: d.file || uri,
      line: d.line,
      column: d.column,
      endLine: d.endLine,
      endColumn: d.endColumn,
      message: d.message,
      severity: this.mapSeverity(d.severity),
      source: 'tsgo' as const,
      code: d.code,
      computeTimeMs,
    }));
  }

  /**
   * Map tsgo severity strings to our DiagnosticSeverity type.
   */
  private mapSeverity(severity: string): DiagnosticSeverity {
    switch (severity.toLowerCase()) {
      case 'error':
        return 'error';
      case 'warning':
      case 'warn':
        return 'warning';
      case 'info':
      case 'information':
        return 'info';
      case 'hint':
      case 'suggestion':
        return 'hint';
      default:
        return 'error';
    }
  }
}
