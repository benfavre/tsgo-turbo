import * as crypto from 'node:crypto';
import type { CacheEntry, TsgoTurboConfig } from '@tsgo-turbo/shared';
import type { CacheStatsNotification } from '@tsgo-turbo/shared';

/**
 * FileCache is a generic LRU cache with content-hash based invalidation.
 *
 * It stores analysis results keyed by file URI. Each entry is validated
 * against a content hash so stale results are never returned. The cache
 * auto-evicts when maxEntries or maxSizeMb limits are exceeded using
 * least-recently-used ordering.
 *
 * @typeParam T - the type of cached data
 *
 * @example
 * ```ts
 * const cache = new FileCache<FileAnalysisResult>({ maxEntries: 5000, maxSizeMb: 256 });
 * const hash = FileCache.computeHash(content);
 * cache.set(uri, hash, result);
 * const cached = cache.get(uri, hash); // returns result or undefined
 * ```
 */
export class FileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly maxSizeBytes: number;
  private readonly ttlMs: number;
  private totalSizeBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /**
   * @param config - cache configuration from TsgoTurboConfig
   */
  constructor(config: TsgoTurboConfig['cache']) {
    this.maxEntries = config.maxEntries;
    this.maxSizeBytes = config.maxSizeMb * 1024 * 1024;
    this.ttlMs = config.ttlSeconds * 1000;
  }

  /**
   * Retrieve a cached value if it exists and the content hash matches.
   *
   * @param uri - the file URI (cache key)
   * @param contentHash - current content hash to validate freshness
   * @returns the cached data, or undefined on miss/stale
   */
  get(uri: string, contentHash: string): T | undefined {
    const entry = this.entries.get(uri);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check content hash freshness
    if (entry.contentHash !== contentHash) {
      this.misses++;
      this.deleteEntry(uri);
      return undefined;
    }

    // Check TTL expiration
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.misses++;
      this.deleteEntry(uri);
      return undefined;
    }

    // Update LRU tracking
    entry.accessCount++;
    entry.lastAccessedAt = now;
    this.hits++;
    return entry.data;
  }

  /**
   * Store a value in the cache.
   *
   * @param uri - the file URI (cache key)
   * @param contentHash - content hash for invalidation
   * @param data - the data to cache
   */
  set(uri: string, contentHash: string, data: T): void {
    // Remove existing entry for this key first
    if (this.entries.has(uri)) {
      this.deleteEntry(uri);
    }

    const sizeBytes = this.estimateSize(data);
    const now = Date.now();

    const entry: CacheEntry<T> = {
      data,
      contentHash,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
      sizeBytes,
    };

    this.entries.set(uri, entry);
    this.totalSizeBytes += sizeBytes;

    // Evict if over limits
    this.evictIfNeeded();
  }

  /**
   * Invalidate (remove) a single cache entry.
   *
   * @param uri - the file URI to invalidate
   * @returns true if an entry was removed
   */
  invalidate(uri: string): boolean {
    return this.deleteEntry(uri);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.entries.clear();
    this.totalSizeBytes = 0;
    this.evictions = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Check if the cache contains a valid entry for the given URI and hash.
   */
  has(uri: string, contentHash: string): boolean {
    const entry = this.entries.get(uri);
    if (!entry) {
      return false;
    }
    if (entry.contentHash !== contentHash) {
      return false;
    }
    const now = Date.now();
    return now - entry.createdAt <= this.ttlMs;
  }

  /**
   * Get current cache statistics.
   */
  getStats(): CacheStatsNotification {
    const total = this.hits + this.misses;
    return {
      totalEntries: this.entries.size,
      totalSizeBytes: this.totalSizeBytes,
      hitRate: total > 0 ? this.hits / total : 0,
      missRate: total > 0 ? this.misses / total : 0,
      evictionCount: this.evictions,
    };
  }

  /** Current number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** All cached URIs. */
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /**
   * Compute a content hash for a string using MD5.
   * MD5 is used for speed (not security) -- this is cache invalidation, not crypto.
   *
   * @param content - the file content string
   * @returns hex-encoded MD5 hash
   */
  static computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private deleteEntry(uri: string): boolean {
    const entry = this.entries.get(uri);
    if (!entry) {
      return false;
    }
    this.totalSizeBytes -= entry.sizeBytes;
    this.entries.delete(uri);
    return true;
  }

  private evictIfNeeded(): void {
    // Evict by entry count
    while (this.entries.size > this.maxEntries) {
      this.evictLRU();
    }
    // Evict by total size
    while (this.totalSizeBytes > this.maxSizeBytes && this.entries.size > 0) {
      this.evictLRU();
    }
  }

  private evictLRU(): void {
    let oldestUri: string | undefined;
    let oldestAccess = Infinity;

    for (const [uri, entry] of this.entries) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestUri = uri;
      }
    }

    if (oldestUri) {
      this.deleteEntry(oldestUri);
      this.evictions++;
    }
  }

  /**
   * Estimate the memory size of a value in bytes.
   * This is a rough approximation using JSON serialization length.
   */
  private estimateSize(data: T): number {
    try {
      return Buffer.byteLength(JSON.stringify(data), 'utf-8');
    } catch {
      // If serialization fails, use a conservative estimate
      return 1024;
    }
  }
}
