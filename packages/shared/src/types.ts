/** Severity levels for diagnostics */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Source tool that produced the diagnostic */
export type DiagnosticSource = 'tsgo' | 'oxc' | 'tsgo-turbo';

/** A diagnostic from our system */
export interface TurbodiagnosticItem {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  code?: string;
  /** How long this diagnostic took to compute in ms */
  computeTimeMs: number;
  /** Additional data for code actions */
  data?: Record<string, unknown>;
}

/** File analysis result from a single tool */
export interface FileAnalysisResult {
  uri: string;
  diagnostics: TurbodiagnosticItem[];
  /** Wall clock time for this analysis */
  analysisTimeMs: number;
  /** Whether result came from cache */
  cached: boolean;
  /** Content hash used for cache invalidation */
  contentHash: string;
}

/** Cache entry with metadata */
export interface CacheEntry<T> {
  data: T;
  contentHash: string;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

/** Type expansion tracking to prevent infinite recursion */
export interface TypeExpansionInfo {
  typeName: string;
  depth: number;
  maxDepth: number;
  truncated: boolean;
  expansionPath: string[];
}

/** Performance trace span */
export interface PerfSpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  parentId?: string;
  metadata?: Record<string, unknown>;
  children: PerfSpan[];
}

/** Configuration for the extension */
export interface TsgoTurboConfig {
  /** Enable tsgo type checking */
  tsgo: {
    enabled: boolean;
    /** Path to tsgo binary (auto-detected if not set) */
    binaryPath?: string;
    /** Max type expansion depth (prevents Prisma/tRPC infinite expansion) */
    maxTypeDepth: number;
    /** Timeout per file in ms */
    fileTimeoutMs: number;
    /** Max memory per tsgo process in MB */
    maxMemoryMb: number;
    /** Additional tsgo flags */
    flags: string[];
  };
  /** Enable oxc linting */
  oxc: {
    enabled: boolean;
    /** Path to oxc binary */
    binaryPath?: string;
    /** Oxc config file path */
    configPath?: string;
    /** Timeout per file in ms */
    fileTimeoutMs: number;
    /** Rules to enable/disable */
    rules?: Record<string, 'off' | 'warn' | 'error'>;
  };
  /** Logging configuration */
  logging: {
    /** Log level */
    level: LogLevel;
    /** Output to file */
    file?: string;
    /** Enable performance tracing */
    perfTracing: boolean;
    /** Max log file size in MB before rotation */
    maxFileSizeMb: number;
    /** Pretty print logs in output channel */
    prettyPrint: boolean;
  };
  /** Cache configuration */
  cache: {
    enabled: boolean;
    /** Max cache entries */
    maxEntries: number;
    /** Max cache size in MB */
    maxSizeMb: number;
    /** TTL in seconds */
    ttlSeconds: number;
  };
  /** File watching */
  watch: {
    /** Glob patterns to include */
    include: string[];
    /** Glob patterns to exclude */
    exclude: string[];
    /** Debounce delay in ms */
    debounceMs: number;
  };
  /** Inspector panel */
  inspector: {
    enabled: boolean;
    /** Auto-open on errors */
    autoOpen: boolean;
    /** Max trace history */
    maxTraceHistory: number;
  };
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
