import { spawn, type ChildProcess } from 'node:child_process';
import type {
  TsgoTurboConfig,
  FileAnalysisResult,
  TurbodiagnosticItem,
  DiagnosticSeverity,
} from '@tsgo-turbo/shared';
import type { Logger } from '../logger/index.js';
import { FileCache } from '../cache/fileCache.js';

/**
 * Internal representation of a pooled oxc child process.
 */
interface OxcProcess {
  process: ChildProcess;
  pid: number;
  busy: boolean;
  activeFile: string | undefined;
  startedAt: number;
  requestCount: number;
}

/**
 * Raw JSON diagnostic from oxc lint output.
 * oxc outputs diagnostics in a JSON array when invoked with --format=json.
 */
interface OxcRawDiagnostic {
  filename?: string;
  message: string;
  severity: string;
  rule_id?: string;
  ruleId?: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
  span?: { start: number; end: number };
  labels?: Array<{
    span: { start: number; end: number };
    message?: string;
  }>;
  fix?: {
    message: string;
    edits: Array<{
      span: { start: number; end: number };
      content: string;
    }>;
  };
  help?: string;
}

/**
 * Pending lint request in the dispatch queue.
 */
interface PendingLintRequest {
  uri: string;
  content: string;
  resolve: (result: FileAnalysisResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * OxcIntegration manages a pool of oxc child processes for fast Rust-based linting.
 *
 * oxc is extremely fast (sub-100ms per file in most cases), so the pool is sized
 * generously. Each lint request spawns a short-lived process (oxc lint is not
 * a long-running server), but we pool them to avoid spawn overhead for rapid
 * sequential requests.
 *
 * For simplicity and reliability, each lint invocation spawns a fresh process
 * since oxc is fast enough that the spawn overhead is negligible compared to
 * the analysis time for other tools.
 *
 * @example
 * ```ts
 * const oxc = new OxcIntegration(config, logger);
 * await oxc.start();
 * const result = await oxc.lint('file:///app.ts', sourceCode);
 * await oxc.shutdown();
 * ```
 */
export class OxcIntegration {
  private config: TsgoTurboConfig['oxc'];
  private readonly logger: Logger;
  private readonly maxConcurrency: number;
  private activeLints = 0;
  private readonly pendingQueue: PendingLintRequest[] = [];
  private started = false;
  private shuttingDown = false;
  private readonly activeProcesses = new Set<ChildProcess>();

  /**
   * @param config - oxc section of TsgoTurboConfig
   * @param logger - logger instance
   * @param maxConcurrency - maximum concurrent lint processes (default 8)
   */
  constructor(
    config: TsgoTurboConfig['oxc'],
    logger: Logger,
    maxConcurrency = 8,
  ) {
    this.config = config;
    this.logger = logger;
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Start the oxc integration. Validates that the oxc binary is accessible.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger.info('Starting oxc integration', {
      maxConcurrency: this.maxConcurrency,
    });

    // Validate binary availability by running --version
    try {
      await this.runOxcCommand(['--version']);
      this.logger.info('oxc binary validated');
    } catch (err) {
      this.logger.warn('oxc binary not found or not working, linting will be unavailable', {
        binaryPath: this.config.binaryPath ?? 'oxlint',
        error: err instanceof Error ? err.message : String(err),
      });
      // We still mark as started — lint calls will fail gracefully
    }

    this.started = true;
  }

  /**
   * Lint a file using oxc.
   *
   * Spawns a short-lived oxc process with the file content piped via stdin.
   * Parses the JSON output into TurbodiagnosticItem format.
   *
   * @param uri - file URI
   * @param content - file content
   * @returns analysis result with lint diagnostics
   */
  async lint(uri: string, content: string): Promise<FileAnalysisResult> {
    if (!this.started || this.shuttingDown) {
      throw new Error('OxcIntegration is not running');
    }

    const contentHash = FileCache.computeHash(content);

    // If at max concurrency, queue the request
    if (this.activeLints >= this.maxConcurrency) {
      return new Promise<FileAnalysisResult>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          const idx = this.pendingQueue.findIndex((p) => p.uri === uri && p.resolve === resolve);
          if (idx >= 0) {
            this.pendingQueue.splice(idx, 1);
          }
          reject(new Error(`oxc lint timed out waiting in queue for ${uri}`));
        }, this.config.fileTimeoutMs);

        this.pendingQueue.push({ uri, content, resolve, reject, timeoutHandle });
      });
    }

    return this.executeLint(uri, content, contentHash);
  }

  /**
   * Update the oxc configuration at runtime.
   */
  updateConfig(config: TsgoTurboConfig['oxc']): void {
    this.config = config;
    this.logger.info('oxc configuration updated');
  }

  /**
   * Get information about active processes.
   */
  getProcessInfo(): Array<{
    pid: number;
    tool: 'oxc';
    startedAt: number;
  }> {
    const result: Array<{ pid: number; tool: 'oxc'; startedAt: number }> = [];
    for (const proc of this.activeProcesses) {
      if (proc.pid) {
        result.push({
          pid: proc.pid,
          tool: 'oxc',
          startedAt: Date.now(), // approximate
        });
      }
    }
    return result;
  }

  /**
   * Gracefully shut down — kill active processes and reject pending requests.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.logger.info('Shutting down oxc integration');

    // Reject all pending requests
    for (const pending of this.pendingQueue) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('OxcIntegration shutting down'));
    }
    this.pendingQueue.length = 0;

    // Kill active processes
    for (const proc of this.activeProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }
    this.activeProcesses.clear();

    this.started = false;
    this.shuttingDown = false;
    this.logger.info('oxc integration shut down');
  }

  /**
   * Execute a lint operation for a single file.
   */
  private async executeLint(
    uri: string,
    content: string,
    contentHash: string,
  ): Promise<FileAnalysisResult> {
    this.activeLints++;
    const startTime = Date.now();

    try {
      // Determine the filename from URI for oxc (it uses extension for language detection)
      const filename = this.uriToFilename(uri);

      const args = [
        '--format=json',
        `--stdin-filename=${filename}`,
        '-',
      ];

      // Add config path if specified
      if (this.config.configPath) {
        args.unshift(`--config=${this.config.configPath}`);
      }

      // Add rule overrides
      if (this.config.rules) {
        for (const [rule, setting] of Object.entries(this.config.rules)) {
          if (setting === 'off') {
            args.push(`--disable=${rule}`);
          } else if (setting === 'warn') {
            args.push(`--warn=${rule}`);
          } else if (setting === 'error') {
            args.push(`--deny=${rule}`);
          }
        }
      }

      const output = await this.runOxcWithStdin(args, content);
      const analysisTimeMs = Date.now() - startTime;

      const diagnostics = this.parseOutput(uri, output, analysisTimeMs);

      return {
        uri,
        diagnostics,
        analysisTimeMs,
        cached: false,
        contentHash,
      };
    } catch (err) {
      const analysisTimeMs = Date.now() - startTime;
      this.logger.warn('oxc lint failed', {
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
    } finally {
      this.activeLints--;
      this.dispatchPending();
    }
  }

  /**
   * Dispatch queued requests when a slot opens up.
   */
  private dispatchPending(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.activeLints < this.maxConcurrency
    ) {
      const pending = this.pendingQueue.shift()!;
      clearTimeout(pending.timeoutHandle);
      const contentHash = FileCache.computeHash(pending.content);
      this.executeLint(pending.uri, pending.content, contentHash).then(
        pending.resolve,
        pending.reject,
      );
    }
  }

  /**
   * Run oxc with content piped via stdin and capture stdout.
   */
  private runOxcWithStdin(args: string[], content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const binaryPath = this.config.binaryPath ?? 'oxlint';
      const child = spawn(binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      // Timeout handling
      const timeoutHandle = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead
        }
        reject(new Error(`oxc lint timed out after ${this.config.fileTimeoutMs}ms`));
      }, this.config.fileTimeoutMs);

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        this.activeProcesses.delete(child);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        this.activeProcesses.delete(child);
        // oxc returns non-zero when it finds lint errors, which is normal
        if (code !== null && code <= 1) {
          resolve(stdout);
        } else if (stdout) {
          // Even with error codes > 1, try to use stdout if available
          resolve(stdout);
        } else {
          reject(
            new Error(
              `oxc exited with code ${code}: ${stderr.slice(0, 500)}`,
            ),
          );
        }
      });

      // Write content to stdin and close
      if (child.stdin) {
        child.stdin.write(content, () => {
          child.stdin!.end();
        });
      }
    });
  }

  /**
   * Run an oxc command and capture output (for validation).
   */
  private runOxcCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const binaryPath = this.config.binaryPath ?? 'oxlint';
      const child = spawn(binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`oxc command failed with code ${code}`));
        }
      });
    });
  }

  /**
   * Parse oxc JSON output into TurbodiagnosticItem array.
   */
  private parseOutput(
    uri: string,
    output: string,
    computeTimeMs: number,
  ): TurbodiagnosticItem[] {
    if (!output.trim()) {
      return [];
    }

    try {
      const raw = JSON.parse(output) as OxcRawDiagnostic[] | OxcRawDiagnostic;
      const items = Array.isArray(raw) ? raw : [raw];

      return items.map((d) => this.convertDiagnostic(uri, d, computeTimeMs));
    } catch {
      // If JSON parsing fails, try to parse line-by-line or return empty
      this.logger.debug('Failed to parse oxc JSON output, trying fallback', {
        outputLength: output.length,
      });
      return this.parseFallback(uri, output, computeTimeMs);
    }
  }

  /**
   * Convert a single raw oxc diagnostic to TurbodiagnosticItem.
   */
  private convertDiagnostic(
    uri: string,
    raw: OxcRawDiagnostic,
    computeTimeMs: number,
  ): TurbodiagnosticItem {
    const ruleId = raw.rule_id ?? raw.ruleId;

    // Determine position from various oxc output formats
    let line = 1;
    let column = 1;
    let endLine: number | undefined;
    let endColumn: number | undefined;

    if (raw.start) {
      line = raw.start.line;
      column = raw.start.column;
    }
    if (raw.end) {
      endLine = raw.end.line;
      endColumn = raw.end.column;
    }
    if (raw.labels && raw.labels.length > 0) {
      // Labels provide more precise span info
      const label = raw.labels[0];
      if (label.span) {
        // Byte spans need file content to convert to line/column
        // For now, use them as approximate values
      }
    }

    // Build data for code actions (auto-fix support)
    const data: Record<string, unknown> = {};
    if (raw.fix) {
      data['fix'] = raw.fix;
    }
    if (raw.help) {
      data['help'] = raw.help;
    }

    return {
      file: raw.filename ?? uri,
      line,
      column,
      endLine,
      endColumn,
      message: raw.message,
      severity: this.mapSeverity(raw.severity),
      source: 'oxc',
      code: ruleId,
      computeTimeMs,
      data: Object.keys(data).length > 0 ? data : undefined,
    };
  }

  /**
   * Fallback parser for non-JSON oxc output.
   */
  private parseFallback(
    uri: string,
    output: string,
    computeTimeMs: number,
  ): TurbodiagnosticItem[] {
    const diagnostics: TurbodiagnosticItem[] = [];
    const lineRegex = /^(.+?):(\d+):(\d+):\s*(error|warning|info|hint)(?:\[(.+?)\])?\s*(.+)$/;

    for (const line of output.split('\n')) {
      const match = lineRegex.exec(line.trim());
      if (match) {
        diagnostics.push({
          file: match[1] || uri,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[6],
          severity: this.mapSeverity(match[4]),
          source: 'oxc',
          code: match[5],
          computeTimeMs,
        });
      }
    }

    return diagnostics;
  }

  /**
   * Map oxc severity string to DiagnosticSeverity.
   */
  private mapSeverity(severity: string): DiagnosticSeverity {
    switch (severity.toLowerCase()) {
      case 'error':
      case 'deny':
        return 'error';
      case 'warning':
      case 'warn':
        return 'warning';
      case 'info':
      case 'advice':
        return 'info';
      case 'hint':
      case 'help':
        return 'hint';
      default:
        return 'warning';
    }
  }

  /**
   * Convert a file URI to a filename for oxc's --stdin-filename flag.
   */
  private uriToFilename(uri: string): string {
    try {
      if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.replace('file://', ''));
      }
      return uri;
    } catch {
      return uri;
    }
  }
}
