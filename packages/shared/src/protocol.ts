import { TurbodiagnosticItem, PerfSpan, TypeExpansionInfo, TsgoTurboConfig, FileAnalysisResult } from './types.js';

/** Custom notification methods beyond standard LSP */
export const CustomMethods = {
  /** Server -> Client: performance trace completed */
  perfTrace: 'tsgoTurbo/perfTrace',
  /** Server -> Client: type expansion warning */
  typeExpansionWarning: 'tsgoTurbo/typeExpansionWarning',
  /** Server -> Client: cache stats update */
  cacheStats: 'tsgoTurbo/cacheStats',
  /** Client -> Server: request inspector data */
  inspectorData: 'tsgoTurbo/inspectorData',
  /** Client -> Server: clear all caches */
  clearCache: 'tsgoTurbo/clearCache',
  /** Client -> Server: reload configuration */
  reloadConfig: 'tsgoTurbo/reloadConfig',
  /** Server -> Client: server status update */
  serverStatus: 'tsgoTurbo/serverStatus',
  /** Client -> Server: analyze single file on demand */
  analyzeFile: 'tsgoTurbo/analyzeFile',
  /** Server -> Client: detailed log entry */
  logEntry: 'tsgoTurbo/logEntry',
} as const;

/** Notification payloads */
export interface PerfTraceNotification {
  spans: PerfSpan[];
  totalDurationMs: number;
  fileUri?: string;
}

export interface TypeExpansionWarningNotification {
  info: TypeExpansionInfo;
  fileUri: string;
  suggestion: string;
}

export interface CacheStatsNotification {
  totalEntries: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  evictionCount: number;
}

export interface InspectorDataRequest {
  fileUri?: string;
  includeTraces: boolean;
  includeCache: boolean;
  includeDiagnostics: boolean;
}

export interface InspectorDataResponse {
  traces: PerfSpan[];
  cacheStats: CacheStatsNotification;
  diagnostics: TurbodiagnosticItem[];
  config: TsgoTurboConfig;
  serverUptime: number;
  filesAnalyzed: number;
  activeProcesses: ProcessInfo[];
}

export interface ProcessInfo {
  pid: number;
  tool: 'tsgo' | 'oxc';
  memoryMb: number;
  cpuPercent: number;
  activeFile?: string;
  startedAt: number;
}

export interface ServerStatusNotification {
  status: 'starting' | 'ready' | 'busy' | 'error' | 'degraded';
  message?: string;
  activeOperations: number;
  queuedOperations: number;
}

export interface AnalyzeFileRequest {
  uri: string;
  force: boolean;
}

export interface AnalyzeFileResponse {
  result: FileAnalysisResult;
  traces: PerfSpan[];
}

export interface LogEntryNotification {
  timestamp: number;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  source: string;
}
