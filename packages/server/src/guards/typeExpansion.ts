import type { TypeExpansionInfo } from '@tsgo-turbo/shared';
import type { Logger } from '../logger/index.js';

/**
 * Known patterns that commonly cause infinite or deep type expansion.
 * Each pattern has a name and a regex that matches type names exhibiting the pattern.
 */
interface KnownExpansionPattern {
  name: string;
  pattern: RegExp;
  description: string;
  suggestedMaxDepth: number;
}

/**
 * Registry of known type patterns from popular frameworks that cause deep expansion.
 */
const KNOWN_PATTERNS: KnownExpansionPattern[] = [
  {
    name: 'prisma-model',
    pattern: /^Prisma\.\w+(GetPayload|Args|Select|Include|Where|OrderBy|Create|Update|Upsert|Delete|FindMany|FindFirst|FindUnique|GroupBy|Aggregate)/,
    description: 'Prisma generated model type with deep generic expansion',
    suggestedMaxDepth: 30,
  },
  {
    name: 'prisma-client',
    pattern: /^PrismaClient\$Extensions/,
    description: 'Prisma client extension type chain',
    suggestedMaxDepth: 20,
  },
  {
    name: 'trpc-router',
    pattern: /^(AppRouter|TRPCRouter|CreateRouter|Decorated|inferRouterOutputs|inferRouterInputs)/,
    description: 'tRPC router type inference with recursive procedure mapping',
    suggestedMaxDepth: 40,
  },
  {
    name: 'trpc-procedure',
    pattern: /^(BuildProcedure|ProcedureBuilder|ResolverDef|MiddlewareFunction)/,
    description: 'tRPC procedure builder type chain',
    suggestedMaxDepth: 35,
  },
  {
    name: 'next-page-props',
    pattern: /^(InferGetServerSidePropsType|InferGetStaticPropsType|GetServerSideProps|GetStaticProps|PageProps)/,
    description: 'Next.js page props inference with deep generic expansion',
    suggestedMaxDepth: 25,
  },
  {
    name: 'next-app-router',
    pattern: /^(RouteModule|PageComponent|LayoutComponent|MetadataRoute)/,
    description: 'Next.js App Router internal types',
    suggestedMaxDepth: 30,
  },
  {
    name: 'zod-schema',
    pattern: /^(ZodType|ZodObject|ZodUnion|ZodIntersection|ZodEffects|ZodPipeline|ZodBranded)/,
    description: 'Zod schema type with recursive inference',
    suggestedMaxDepth: 35,
  },
  {
    name: 'recursive-generic',
    pattern: /^(\w+)<\1/,
    description: 'Self-referential generic type',
    suggestedMaxDepth: 15,
  },
];

/**
 * TypeExpansionGuard is the core safety mechanism that prevents infinite or excessively
 * deep type recursion during analysis. This is the key feature for Prisma + tRPC + Next.js
 * codebases where standard tsserver often hangs or OOMs.
 *
 * The guard:
 * - Tracks type expansion depth during analysis
 * - Detects known problematic patterns (Prisma, tRPC, Next.js, Zod)
 * - Truncates expansion when depth exceeds configurable limits
 * - Maintains an expansion stack for debugging
 * - Generates human-readable expansion path reports
 *
 * @example
 * ```ts
 * const guard = new TypeExpansionGuard(50, logger);
 * guard.pushType('AppRouter');
 * guard.pushType('inferRouterOutputs<AppRouter>');
 * const info = guard.checkExpansion('Prisma.UserGetPayload<...>', guard.currentDepth);
 * if (info.truncated) {
 *   // Use truncated type representation
 * }
 * guard.popType();
 * guard.popType();
 * ```
 */
export class TypeExpansionGuard {
  private maxTypeDepth: number;
  private readonly expansionStack: string[] = [];
  private readonly logger: Logger | undefined;
  private readonly warningCallback: ((info: TypeExpansionInfo) => void) | undefined;
  private truncationCount = 0;

  /**
   * @param maxTypeDepth - maximum allowed expansion depth before truncation
   * @param logger - optional logger for warnings
   * @param warningCallback - optional callback invoked when truncation occurs
   */
  constructor(
    maxTypeDepth = 50,
    logger?: Logger,
    warningCallback?: (info: TypeExpansionInfo) => void,
  ) {
    this.maxTypeDepth = maxTypeDepth;
    this.logger = logger;
    this.warningCallback = warningCallback;
  }

  /**
   * Check whether a type expansion should be truncated.
   *
   * This is the primary API. Call it before expanding a type to determine
   * if the expansion should proceed or be cut short.
   *
   * @param typeName - the name of the type being expanded
   * @param currentDepth - the current expansion depth
   * @returns TypeExpansionInfo describing the expansion state
   */
  checkExpansion(typeName: string, currentDepth: number): TypeExpansionInfo {
    // Check for known patterns with custom depth limits
    const knownPattern = this.matchKnownPattern(typeName);
    const effectiveMaxDepth = knownPattern
      ? Math.min(this.maxTypeDepth, knownPattern.suggestedMaxDepth)
      : this.maxTypeDepth;

    const truncated = currentDepth >= effectiveMaxDepth;

    const info: TypeExpansionInfo = {
      typeName,
      depth: currentDepth,
      maxDepth: effectiveMaxDepth,
      truncated,
      expansionPath: [...this.expansionStack, typeName],
    };

    if (truncated) {
      this.truncationCount++;
      if (this.logger) {
        this.logger.warn('Type expansion truncated', {
          typeName,
          depth: currentDepth,
          maxDepth: effectiveMaxDepth,
          pattern: knownPattern?.name,
          path: info.expansionPath.slice(-5).join(' -> '),
        });
      }
      if (this.warningCallback) {
        try {
          this.warningCallback(info);
        } catch {
          // Never let callback errors propagate
        }
      }
    }

    return info;
  }

  /**
   * Push a type onto the expansion stack.
   * Call this when entering a type expansion.
   *
   * @param typeName - the type being expanded
   */
  pushType(typeName: string): void {
    this.expansionStack.push(typeName);
  }

  /**
   * Pop the most recent type from the expansion stack.
   * Call this when leaving a type expansion.
   *
   * @returns the popped type name, or undefined if stack is empty
   */
  popType(): string | undefined {
    return this.expansionStack.pop();
  }

  /** Current expansion depth (stack size). */
  get currentDepth(): number {
    return this.expansionStack.length;
  }

  /** Number of times truncation has occurred. */
  get totalTruncations(): number {
    return this.truncationCount;
  }

  /** Reset the expansion stack. Call between file analyses. */
  reset(): void {
    this.expansionStack.length = 0;
  }

  /** Update the maximum type depth at runtime. */
  setMaxDepth(depth: number): void {
    this.maxTypeDepth = depth;
  }

  /**
   * Get the current expansion stack as a copy.
   */
  getExpansionStack(): string[] {
    return [...this.expansionStack];
  }

  /**
   * Generate a human-readable expansion path report.
   * Useful for debugging deep type issues in the inspector panel.
   *
   * @param info - the type expansion info to format
   * @returns a multi-line string describing the expansion path
   */
  formatExpansionReport(info: TypeExpansionInfo): string {
    const lines: string[] = [];
    lines.push(`Type Expansion Report`);
    lines.push(`=====================`);
    lines.push(`Type: ${info.typeName}`);
    lines.push(`Depth: ${info.depth} / ${info.maxDepth}`);
    lines.push(`Truncated: ${info.truncated ? 'YES' : 'no'}`);
    lines.push('');

    const knownPattern = this.matchKnownPattern(info.typeName);
    if (knownPattern) {
      lines.push(`Known Pattern: ${knownPattern.name}`);
      lines.push(`Description: ${knownPattern.description}`);
      lines.push(`Suggested Max Depth: ${knownPattern.suggestedMaxDepth}`);
      lines.push('');
    }

    lines.push(`Expansion Path:`);
    for (let i = 0; i < info.expansionPath.length; i++) {
      const indent = '  '.repeat(Math.min(i, 20));
      const marker = i === info.expansionPath.length - 1 ? '>> ' : '   ';
      lines.push(`${marker}${indent}${info.expansionPath[i]}`);
    }

    if (info.truncated) {
      lines.push('');
      lines.push(`Suggestion: Consider adding explicit type annotations to break`);
      lines.push(`the expansion chain. For Prisma types, use Prisma.validator<>()`);
      lines.push(`instead of inline type arguments.`);
    }

    return lines.join('\n');
  }

  /**
   * Check if a type name matches known problematic patterns.
   * Returns the first matching pattern, or undefined.
   */
  matchKnownPattern(typeName: string): KnownExpansionPattern | undefined {
    for (const pattern of KNOWN_PATTERNS) {
      if (pattern.pattern.test(typeName)) {
        return pattern;
      }
    }
    return undefined;
  }

  /**
   * Detect if the current expansion stack contains a cycle.
   * A cycle is defined as the same type name appearing more than once
   * within the last N entries (configurable window).
   *
   * @param windowSize - how many recent entries to check (default 10)
   * @returns the repeated type name if cycle detected, undefined otherwise
   */
  detectCycle(windowSize = 10): string | undefined {
    const window = this.expansionStack.slice(-windowSize);
    const seen = new Set<string>();
    for (const typeName of window) {
      if (seen.has(typeName)) {
        return typeName;
      }
      seen.add(typeName);
    }
    return undefined;
  }
}
