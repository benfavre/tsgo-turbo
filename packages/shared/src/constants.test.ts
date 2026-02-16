import { describe, it, expect } from 'vitest';
import {
  EXTENSION_ID,
  EXTENSION_NAME,
  LSP_SERVER_ID,
  DEFAULT_CONFIG,
  LOG_LEVEL_VALUES,
  IPC_MESSAGES,
} from './constants.js';

describe('constants', () => {
  it('exports required identifiers', () => {
    expect(EXTENSION_ID).toBe('tsgo-turbo');
    expect(EXTENSION_NAME).toBe('tsgo Turbo');
    expect(LSP_SERVER_ID).toBe('tsgo-turbo-lsp');
  });

  it('DEFAULT_CONFIG has valid structure', () => {
    expect(DEFAULT_CONFIG.tsgo.enabled).toBe(true);
    expect(DEFAULT_CONFIG.oxc.enabled).toBe(true);
    expect(DEFAULT_CONFIG.logging.level).toBe('info');
    expect(DEFAULT_CONFIG.cache.enabled).toBe(true);
    expect(DEFAULT_CONFIG.watch.include.length).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.inspector.enabled).toBe(true);
  });

  it('DEFAULT_CONFIG watch.include covers expected extensions', () => {
    const patterns = DEFAULT_CONFIG.watch.include;
    expect(patterns).toContain('**/*.ts');
    expect(patterns).toContain('**/*.tsx');
    expect(patterns).toContain('**/*.js');
    expect(patterns).toContain('**/*.jsx');
    expect(patterns).toContain('**/*.mts');
    expect(patterns).toContain('**/*.cts');
  });

  it('LOG_LEVEL_VALUES are ordered correctly', () => {
    expect(LOG_LEVEL_VALUES['trace']).toBeLessThan(LOG_LEVEL_VALUES['debug']);
    expect(LOG_LEVEL_VALUES['debug']).toBeLessThan(LOG_LEVEL_VALUES['info']);
    expect(LOG_LEVEL_VALUES['info']).toBeLessThan(LOG_LEVEL_VALUES['warn']);
    expect(LOG_LEVEL_VALUES['warn']).toBeLessThan(LOG_LEVEL_VALUES['error']);
    expect(LOG_LEVEL_VALUES['error']).toBeLessThan(LOG_LEVEL_VALUES['fatal']);
  });

  it('IPC_MESSAGES has required message types', () => {
    expect(IPC_MESSAGES.ANALYZE).toBe('analyze');
    expect(IPC_MESSAGES.RESULT).toBe('result');
    expect(IPC_MESSAGES.ERROR).toBe('error');
    expect(IPC_MESSAGES.HEALTH).toBe('health');
    expect(IPC_MESSAGES.SHUTDOWN).toBe('shutdown');
  });
});
