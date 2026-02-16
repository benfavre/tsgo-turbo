import { describe, it, expect, vi } from 'vitest';
import { StructuredLogger, LogRingBuffer } from './structured.js';

describe('LogRingBuffer', () => {
  it('stores and retrieves entries', () => {
    const buffer = new LogRingBuffer(10);
    buffer.push({
      timestamp: Date.now(),
      level: 'info',
      message: 'test',
      context: {},
      source: 'test',
    });
    expect(buffer.size).toBe(1);
    expect(buffer.toArray()).toHaveLength(1);
  });

  it('overwrites oldest entries when full', () => {
    const buffer = new LogRingBuffer(3);
    for (let i = 0; i < 5; i++) {
      buffer.push({
        timestamp: i,
        level: 'info',
        message: `msg-${i}`,
        context: {},
        source: 'test',
      });
    }
    expect(buffer.size).toBe(3);
    const entries = buffer.toArray();
    expect(entries[0].message).toBe('msg-2');
    expect(entries[2].message).toBe('msg-4');
  });

  it('clears all entries', () => {
    const buffer = new LogRingBuffer(10);
    buffer.push({
      timestamp: Date.now(),
      level: 'info',
      message: 'test',
      context: {},
      source: 'test',
    });
    buffer.clear();
    expect(buffer.size).toBe(0);
  });

  it('filters by log level', () => {
    const buffer = new LogRingBuffer(10);
    buffer.push({ timestamp: 1, level: 'debug', message: 'd', context: {}, source: 'test' });
    buffer.push({ timestamp: 2, level: 'info', message: 'i', context: {}, source: 'test' });
    buffer.push({ timestamp: 3, level: 'error', message: 'e', context: {}, source: 'test' });

    const warnings = buffer.query('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('error');
  });
});

describe('StructuredLogger', () => {
  it('batches and flushes entries', () => {
    const flushed: unknown[] = [];
    const logger = new StructuredLogger((entries) => flushed.push(...entries), false, 10);
    logger.append({
      timestamp: Date.now(),
      level: 'info',
      message: 'hello',
      context: {},
      source: 'test',
    });
    logger.flush();
    expect(flushed).toHaveLength(1);
  });

  it('formats entries as JSON by default', () => {
    const logger = new StructuredLogger(() => {}, false);
    const entry = {
      timestamp: 1000,
      level: 'info' as const,
      message: 'test',
      context: {},
      source: 'srv',
    };
    const formatted = logger.format(entry);
    expect(JSON.parse(formatted)).toEqual(entry);
  });

  it('formats entries as pretty print', () => {
    const logger = new StructuredLogger(() => {}, true);
    const entry = {
      timestamp: 1000,
      level: 'info' as const,
      message: 'test message',
      context: {},
      source: 'srv',
    };
    const formatted = logger.format(entry);
    expect(formatted).toContain('INFO');
    expect(formatted).toContain('test message');
    expect(formatted).toContain('[srv]');
  });
});
