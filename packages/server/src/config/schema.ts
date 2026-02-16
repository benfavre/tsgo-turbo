import type { TsgoTurboConfig } from '@tsgo-turbo/shared';
import { DEFAULT_CONFIG, LOG_LEVEL_VALUES } from '@tsgo-turbo/shared';

/**
 * Result of configuration validation.
 */
export interface ValidationResult {
  valid: boolean;
  config?: TsgoTurboConfig;
  errors?: string[];
}

/**
 * Type-safe deep merge utility.
 * Merges source into target, preferring source values.
 * Only merges plain objects recursively; arrays and primitives are replaced.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (sourceVal === undefined) {
      continue;
    }

    if (
      isPlainObject(targetVal) &&
      isPlainObject(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = sourceVal as T[keyof T];
    }
  }

  return result;
}

/**
 * Validate a raw configuration object and merge with defaults.
 *
 * Performs runtime validation without external dependencies (no Zod).
 * Checks types, ranges, and enum values for all configuration fields.
 *
 * @param raw - untrusted configuration object from client settings
 * @returns validation result with either a valid config or error messages
 */
export function validateConfig(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (raw === null || raw === undefined) {
    return { valid: true, config: { ...DEFAULT_CONFIG } };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ['Configuration must be an object'],
    };
  }

  const input = raw as Record<string, unknown>;

  // Build partial config by validating each section
  const partial: Record<string, unknown> = {};

  // -- tsgo section --
  if (input['tsgo'] !== undefined) {
    if (!isPlainObject(input['tsgo'])) {
      errors.push('tsgo: must be an object');
    } else {
      const tsgo = input['tsgo'] as Record<string, unknown>;
      const tsgoPartial: Record<string, unknown> = {};

      if (tsgo['enabled'] !== undefined) {
        if (typeof tsgo['enabled'] !== 'boolean') {
          errors.push('tsgo.enabled: must be a boolean');
        } else {
          tsgoPartial['enabled'] = tsgo['enabled'];
        }
      }

      if (tsgo['binaryPath'] !== undefined) {
        if (typeof tsgo['binaryPath'] !== 'string') {
          errors.push('tsgo.binaryPath: must be a string');
        } else {
          tsgoPartial['binaryPath'] = tsgo['binaryPath'];
        }
      }

      if (tsgo['maxTypeDepth'] !== undefined) {
        if (typeof tsgo['maxTypeDepth'] !== 'number' || tsgo['maxTypeDepth'] < 1) {
          errors.push('tsgo.maxTypeDepth: must be a positive number');
        } else {
          tsgoPartial['maxTypeDepth'] = tsgo['maxTypeDepth'];
        }
      }

      if (tsgo['fileTimeoutMs'] !== undefined) {
        if (typeof tsgo['fileTimeoutMs'] !== 'number' || tsgo['fileTimeoutMs'] < 100) {
          errors.push('tsgo.fileTimeoutMs: must be a number >= 100');
        } else {
          tsgoPartial['fileTimeoutMs'] = tsgo['fileTimeoutMs'];
        }
      }

      if (tsgo['maxMemoryMb'] !== undefined) {
        if (typeof tsgo['maxMemoryMb'] !== 'number' || tsgo['maxMemoryMb'] < 64) {
          errors.push('tsgo.maxMemoryMb: must be a number >= 64');
        } else {
          tsgoPartial['maxMemoryMb'] = tsgo['maxMemoryMb'];
        }
      }

      if (tsgo['flags'] !== undefined) {
        if (!Array.isArray(tsgo['flags']) || !tsgo['flags'].every((f: unknown) => typeof f === 'string')) {
          errors.push('tsgo.flags: must be an array of strings');
        } else {
          tsgoPartial['flags'] = tsgo['flags'];
        }
      }

      if (Object.keys(tsgoPartial).length > 0) {
        partial['tsgo'] = tsgoPartial;
      }
    }
  }

  // -- oxc section --
  if (input['oxc'] !== undefined) {
    if (!isPlainObject(input['oxc'])) {
      errors.push('oxc: must be an object');
    } else {
      const oxc = input['oxc'] as Record<string, unknown>;
      const oxcPartial: Record<string, unknown> = {};

      if (oxc['enabled'] !== undefined) {
        if (typeof oxc['enabled'] !== 'boolean') {
          errors.push('oxc.enabled: must be a boolean');
        } else {
          oxcPartial['enabled'] = oxc['enabled'];
        }
      }

      if (oxc['binaryPath'] !== undefined) {
        if (typeof oxc['binaryPath'] !== 'string') {
          errors.push('oxc.binaryPath: must be a string');
        } else {
          oxcPartial['binaryPath'] = oxc['binaryPath'];
        }
      }

      if (oxc['configPath'] !== undefined) {
        if (typeof oxc['configPath'] !== 'string') {
          errors.push('oxc.configPath: must be a string');
        } else {
          oxcPartial['configPath'] = oxc['configPath'];
        }
      }

      if (oxc['fileTimeoutMs'] !== undefined) {
        if (typeof oxc['fileTimeoutMs'] !== 'number' || oxc['fileTimeoutMs'] < 100) {
          errors.push('oxc.fileTimeoutMs: must be a number >= 100');
        } else {
          oxcPartial['fileTimeoutMs'] = oxc['fileTimeoutMs'];
        }
      }

      if (oxc['rules'] !== undefined) {
        if (!isPlainObject(oxc['rules'])) {
          errors.push('oxc.rules: must be an object');
        } else {
          const rules = oxc['rules'] as Record<string, unknown>;
          const validValues = new Set(['off', 'warn', 'error']);
          let rulesValid = true;
          for (const [rule, value] of Object.entries(rules)) {
            if (typeof value !== 'string' || !validValues.has(value)) {
              errors.push(`oxc.rules.${rule}: must be 'off', 'warn', or 'error'`);
              rulesValid = false;
            }
          }
          if (rulesValid) {
            oxcPartial['rules'] = oxc['rules'];
          }
        }
      }

      if (Object.keys(oxcPartial).length > 0) {
        partial['oxc'] = oxcPartial;
      }
    }
  }

  // -- logging section --
  if (input['logging'] !== undefined) {
    if (!isPlainObject(input['logging'])) {
      errors.push('logging: must be an object');
    } else {
      const logging = input['logging'] as Record<string, unknown>;
      const loggingPartial: Record<string, unknown> = {};

      if (logging['level'] !== undefined) {
        if (
          typeof logging['level'] !== 'string' ||
          !(logging['level'] in LOG_LEVEL_VALUES)
        ) {
          errors.push(
            `logging.level: must be one of ${Object.keys(LOG_LEVEL_VALUES).join(', ')}`,
          );
        } else {
          loggingPartial['level'] = logging['level'];
        }
      }

      if (logging['file'] !== undefined) {
        if (typeof logging['file'] !== 'string') {
          errors.push('logging.file: must be a string');
        } else {
          loggingPartial['file'] = logging['file'];
        }
      }

      if (logging['perfTracing'] !== undefined) {
        if (typeof logging['perfTracing'] !== 'boolean') {
          errors.push('logging.perfTracing: must be a boolean');
        } else {
          loggingPartial['perfTracing'] = logging['perfTracing'];
        }
      }

      if (logging['maxFileSizeMb'] !== undefined) {
        if (typeof logging['maxFileSizeMb'] !== 'number' || logging['maxFileSizeMb'] < 1) {
          errors.push('logging.maxFileSizeMb: must be a number >= 1');
        } else {
          loggingPartial['maxFileSizeMb'] = logging['maxFileSizeMb'];
        }
      }

      if (logging['prettyPrint'] !== undefined) {
        if (typeof logging['prettyPrint'] !== 'boolean') {
          errors.push('logging.prettyPrint: must be a boolean');
        } else {
          loggingPartial['prettyPrint'] = logging['prettyPrint'];
        }
      }

      if (Object.keys(loggingPartial).length > 0) {
        partial['logging'] = loggingPartial;
      }
    }
  }

  // -- cache section --
  if (input['cache'] !== undefined) {
    if (!isPlainObject(input['cache'])) {
      errors.push('cache: must be an object');
    } else {
      const cache = input['cache'] as Record<string, unknown>;
      const cachePartial: Record<string, unknown> = {};

      if (cache['enabled'] !== undefined) {
        if (typeof cache['enabled'] !== 'boolean') {
          errors.push('cache.enabled: must be a boolean');
        } else {
          cachePartial['enabled'] = cache['enabled'];
        }
      }

      if (cache['maxEntries'] !== undefined) {
        if (typeof cache['maxEntries'] !== 'number' || cache['maxEntries'] < 1) {
          errors.push('cache.maxEntries: must be a positive number');
        } else {
          cachePartial['maxEntries'] = cache['maxEntries'];
        }
      }

      if (cache['maxSizeMb'] !== undefined) {
        if (typeof cache['maxSizeMb'] !== 'number' || cache['maxSizeMb'] < 1) {
          errors.push('cache.maxSizeMb: must be a number >= 1');
        } else {
          cachePartial['maxSizeMb'] = cache['maxSizeMb'];
        }
      }

      if (cache['ttlSeconds'] !== undefined) {
        if (typeof cache['ttlSeconds'] !== 'number' || cache['ttlSeconds'] < 0) {
          errors.push('cache.ttlSeconds: must be a non-negative number');
        } else {
          cachePartial['ttlSeconds'] = cache['ttlSeconds'];
        }
      }

      if (Object.keys(cachePartial).length > 0) {
        partial['cache'] = cachePartial;
      }
    }
  }

  // -- watch section --
  if (input['watch'] !== undefined) {
    if (!isPlainObject(input['watch'])) {
      errors.push('watch: must be an object');
    } else {
      const watch = input['watch'] as Record<string, unknown>;
      const watchPartial: Record<string, unknown> = {};

      if (watch['include'] !== undefined) {
        if (!Array.isArray(watch['include']) || !watch['include'].every((s: unknown) => typeof s === 'string')) {
          errors.push('watch.include: must be an array of strings');
        } else {
          watchPartial['include'] = watch['include'];
        }
      }

      if (watch['exclude'] !== undefined) {
        if (!Array.isArray(watch['exclude']) || !watch['exclude'].every((s: unknown) => typeof s === 'string')) {
          errors.push('watch.exclude: must be an array of strings');
        } else {
          watchPartial['exclude'] = watch['exclude'];
        }
      }

      if (watch['debounceMs'] !== undefined) {
        if (typeof watch['debounceMs'] !== 'number' || watch['debounceMs'] < 0) {
          errors.push('watch.debounceMs: must be a non-negative number');
        } else {
          watchPartial['debounceMs'] = watch['debounceMs'];
        }
      }

      if (Object.keys(watchPartial).length > 0) {
        partial['watch'] = watchPartial;
      }
    }
  }

  // -- inspector section --
  if (input['inspector'] !== undefined) {
    if (!isPlainObject(input['inspector'])) {
      errors.push('inspector: must be an object');
    } else {
      const inspector = input['inspector'] as Record<string, unknown>;
      const inspectorPartial: Record<string, unknown> = {};

      if (inspector['enabled'] !== undefined) {
        if (typeof inspector['enabled'] !== 'boolean') {
          errors.push('inspector.enabled: must be a boolean');
        } else {
          inspectorPartial['enabled'] = inspector['enabled'];
        }
      }

      if (inspector['autoOpen'] !== undefined) {
        if (typeof inspector['autoOpen'] !== 'boolean') {
          errors.push('inspector.autoOpen: must be a boolean');
        } else {
          inspectorPartial['autoOpen'] = inspector['autoOpen'];
        }
      }

      if (inspector['maxTraceHistory'] !== undefined) {
        if (typeof inspector['maxTraceHistory'] !== 'number' || inspector['maxTraceHistory'] < 1) {
          errors.push('inspector.maxTraceHistory: must be a positive number');
        } else {
          inspectorPartial['maxTraceHistory'] = inspector['maxTraceHistory'];
        }
      }

      if (Object.keys(inspectorPartial).length > 0) {
        partial['inspector'] = inspectorPartial;
      }
    }
  }

  // If there are validation errors, return them
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Merge validated partial config with defaults
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    partial,
  ) as unknown as TsgoTurboConfig;

  return { valid: true, config: merged };
}

/**
 * Check if a value is a plain object (not array, null, Date, etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
