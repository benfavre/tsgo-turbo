import { describe, it, expect } from 'vitest';
import { FileCache } from './fileCache.js';

describe('FileCache', () => {
  it('stores and retrieves entries', () => {
    const cache = new FileCache({
      enabled: true,
      maxEntries: 100,
      maxSizeMb: 10,
      ttlSeconds: 300,
    });

    const data = {
      uri: 'file:///test.ts',
      diagnostics: [],
      analysisTimeMs: 10,
      cached: false,
      contentHash: 'abc123',
    };

    cache.set('file:///test.ts', 'abc123', data);
    const result = cache.get('file:///test.ts', 'abc123');
    expect(result).toBeDefined();
    expect(result?.uri).toBe('file:///test.ts');
  });

  it('returns undefined for mismatched content hash', () => {
    const cache = new FileCache({
      enabled: true,
      maxEntries: 100,
      maxSizeMb: 10,
      ttlSeconds: 300,
    });

    const data = {
      uri: 'file:///test.ts',
      diagnostics: [],
      analysisTimeMs: 10,
      cached: false,
      contentHash: 'abc123',
    };

    cache.set('file:///test.ts', 'abc123', data);
    const result = cache.get('file:///test.ts', 'different-hash');
    expect(result).toBeUndefined();
  });

  it('computes a content hash', () => {
    const hash = FileCache.computeHash('const x = 1;');
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('clears all entries', () => {
    const cache = new FileCache({
      enabled: true,
      maxEntries: 100,
      maxSizeMb: 10,
      ttlSeconds: 300,
    });

    cache.set('file:///a.ts', 'h1', {
      uri: 'file:///a.ts',
      diagnostics: [],
      analysisTimeMs: 5,
      cached: false,
      contentHash: 'h1',
    });

    cache.clear();
    expect(cache.get('file:///a.ts', 'h1')).toBeUndefined();
  });
});
