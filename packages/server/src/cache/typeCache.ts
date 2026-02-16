import type { TsgoTurboConfig } from '@tsgo-turbo/shared';
import { FileCache } from './fileCache.js';

/**
 * Resolved type information stored in the type cache.
 */
export interface TypeInfo {
  /** Fully-qualified type name */
  typeName: string;
  /** Rendered type string (possibly truncated) */
  typeString: string;
  /** Expansion depth at which this type was resolved */
  depth: number;
  /** Whether the type was truncated due to depth limits */
  truncated: boolean;
  /** Source file URI where this type originates */
  sourceUri: string;
}

/**
 * TypeCache extends the FileCache concept with dependency-graph-aware invalidation.
 *
 * When file A imports file B, a dependency edge is tracked: A depends on B.
 * When B changes, both B and all files that depend on B (directly or transitively)
 * are invalidated.
 *
 * This is critical for large codebases where a Prisma schema change should
 * cascade invalidation through all files that import Prisma-generated types.
 *
 * @example
 * ```ts
 * const tc = new TypeCache(cacheConfig);
 * tc.addDependency('file:///a.ts', 'file:///prisma.ts');
 * tc.addDependency('file:///b.ts', 'file:///prisma.ts');
 * const invalidated = tc.invalidateWithDependents('file:///prisma.ts');
 * // invalidated = Set { 'file:///prisma.ts', 'file:///a.ts', 'file:///b.ts' }
 * ```
 */
export class TypeCache {
  /** Cache of type info per file URI. */
  private readonly cache: FileCache<TypeInfo[]>;

  /**
   * Forward dependency graph: fromUri -> Set of toUris that fromUri imports.
   * "A depends on B" means dependsOn.get(A) contains B.
   */
  private readonly dependsOn = new Map<string, Set<string>>();

  /**
   * Reverse dependency graph: toUri -> Set of fromUris that import toUri.
   * "A depends on B" means dependedOnBy.get(B) contains A.
   */
  private readonly dependedOnBy = new Map<string, Set<string>>();

  /**
   * @param config - cache configuration from TsgoTurboConfig
   */
  constructor(config: TsgoTurboConfig['cache']) {
    this.cache = new FileCache<TypeInfo[]>(config);
  }

  /**
   * Get cached type information for a file.
   *
   * @param uri - the file URI
   * @param contentHash - current content hash
   * @returns cached type info array, or undefined on miss
   */
  get(uri: string, contentHash: string): TypeInfo[] | undefined {
    return this.cache.get(uri, contentHash);
  }

  /**
   * Store type information for a file.
   *
   * @param uri - the file URI
   * @param contentHash - current content hash
   * @param types - resolved type information
   */
  set(uri: string, contentHash: string, types: TypeInfo[]): void {
    this.cache.set(uri, contentHash, types);
  }

  /**
   * Record that `fromUri` depends on (imports) `toUri`.
   * This allows cascade invalidation when `toUri` changes.
   *
   * @param fromUri - the file that imports
   * @param toUri - the file being imported
   */
  addDependency(fromUri: string, toUri: string): void {
    // Forward edge
    let deps = this.dependsOn.get(fromUri);
    if (!deps) {
      deps = new Set();
      this.dependsOn.set(fromUri, deps);
    }
    deps.add(toUri);

    // Reverse edge
    let rdeps = this.dependedOnBy.get(toUri);
    if (!rdeps) {
      rdeps = new Set();
      this.dependedOnBy.set(toUri, rdeps);
    }
    rdeps.add(fromUri);
  }

  /**
   * Remove all dependency edges originating from `fromUri`.
   * Called when a file is re-analyzed and its imports may have changed.
   *
   * @param fromUri - the file whose outgoing dependencies to clear
   */
  clearDependencies(fromUri: string): void {
    const deps = this.dependsOn.get(fromUri);
    if (!deps) {
      return;
    }

    for (const toUri of deps) {
      const rdeps = this.dependedOnBy.get(toUri);
      if (rdeps) {
        rdeps.delete(fromUri);
        if (rdeps.size === 0) {
          this.dependedOnBy.delete(toUri);
        }
      }
    }

    this.dependsOn.delete(fromUri);
  }

  /**
   * Invalidate a file and all files that transitively depend on it.
   * Uses BFS to walk the reverse dependency graph.
   *
   * @param uri - the URI of the changed file
   * @returns the set of all invalidated URIs (including the original)
   */
  invalidateWithDependents(uri: string): Set<string> {
    const invalidated = new Set<string>();
    const queue: string[] = [uri];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (invalidated.has(current)) {
        continue;
      }
      invalidated.add(current);
      this.cache.invalidate(current);

      // Find all files that depend on the current file
      const dependents = this.dependedOnBy.get(current);
      if (dependents) {
        for (const dependent of dependents) {
          if (!invalidated.has(dependent)) {
            queue.push(dependent);
          }
        }
      }
    }

    return invalidated;
  }

  /**
   * Get direct dependencies of a file (files it imports).
   */
  getDependencies(uri: string): Set<string> {
    return this.dependsOn.get(uri) ?? new Set();
  }

  /**
   * Get direct dependents of a file (files that import it).
   */
  getDependents(uri: string): Set<string> {
    return this.dependedOnBy.get(uri) ?? new Set();
  }

  /**
   * Clear all cached data and dependency graph information.
   */
  clear(): void {
    this.cache.clear();
    this.dependsOn.clear();
    this.dependedOnBy.clear();
  }

  /** Get cache statistics. */
  getStats() {
    return this.cache.getStats();
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Number of tracked dependency edges. */
  get dependencyCount(): number {
    let count = 0;
    for (const deps of this.dependsOn.values()) {
      count += deps.size;
    }
    return count;
  }
}
