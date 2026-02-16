import type { TsgoTurboConfig } from './types.js';

export const EXTENSION_ID = 'tsgo-turbo';
export const EXTENSION_NAME = 'tsgo Turbo';
export const OUTPUT_CHANNEL_NAME = 'tsgo Turbo';
export const LSP_SERVER_ID = 'tsgo-turbo-lsp';

export const DEFAULT_CONFIG: TsgoTurboConfig = {
  tsgo: {
    enabled: true,
    maxTypeDepth: 50,
    fileTimeoutMs: 30_000,
    maxMemoryMb: 4096,
    flags: [],
  },
  oxc: {
    enabled: true,
    fileTimeoutMs: 10_000,
  },
  logging: {
    level: 'info',
    perfTracing: false,
    maxFileSizeMb: 50,
    prettyPrint: true,
  },
  cache: {
    enabled: true,
    maxEntries: 10_000,
    maxSizeMb: 512,
    ttlSeconds: 300,
  },
  watch: {
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/.turbo/**'],
    debounceMs: 150,
  },
  inspector: {
    enabled: true,
    autoOpen: false,
    maxTraceHistory: 1000,
  },
};

/** Log level numeric values for comparison */
export const LOG_LEVEL_VALUES: Record<string, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/** Max concurrent tool processes */
export const MAX_CONCURRENT_TSGO = 4;
export const MAX_CONCURRENT_OXC = 8;

/** IPC message types for child process communication */
export const IPC_MESSAGES = {
  ANALYZE: 'analyze',
  RESULT: 'result',
  ERROR: 'error',
  CANCEL: 'cancel',
  HEALTH: 'health',
  SHUTDOWN: 'shutdown',
} as const;
