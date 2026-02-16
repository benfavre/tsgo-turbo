import { Hover, HoverParams, MarkupContent, MarkupKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Logger } from '../logger/index.js';
import type { AnalysisBridge } from '../integrations/bridge.js';
import type { TypeExpansionGuard } from '../guards/typeExpansion.js';

/**
 * Maximum length of type string shown in hover before truncation.
 */
const MAX_TYPE_STRING_LENGTH = 2000;

/**
 * Maximum number of lines in a type string before truncation.
 */
const MAX_TYPE_STRING_LINES = 40;

/**
 * HoverProvider returns type information for the symbol under the cursor.
 *
 * This is one of the key features of tsgo-turbo: it uses the TypeExpansionGuard
 * to truncate deeply nested types (Prisma, tRPC) that would otherwise cause
 * VS Code to hang when rendering the hover tooltip.
 *
 * @example
 * ```ts
 * const provider = new HoverProvider(bridge, guard, logger);
 * const hover = await provider.provideHover(params, document);
 * ```
 */
export class HoverProvider {
  private readonly bridge: AnalysisBridge;
  private readonly guard: TypeExpansionGuard;
  private readonly logger: Logger;
  private timeoutMs: number;

  /**
   * @param bridge - the analysis bridge for accessing tsgo
   * @param guard - type expansion guard for truncating deep types
   * @param logger - logger instance
   * @param timeoutMs - timeout for hover requests (default 5000ms)
   */
  constructor(
    bridge: AnalysisBridge,
    guard: TypeExpansionGuard,
    logger: Logger,
    timeoutMs = 5000,
  ) {
    this.bridge = bridge;
    this.guard = guard;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Provide hover information at the given position.
   *
   * Fetches type info from tsgo, applies type expansion truncation,
   * and formats the result as a Markdown hover tooltip.
   *
   * @param params - LSP hover request parameters
   * @param document - the text document
   * @returns a Hover object, or null if no info is available
   */
  async provideHover(
    params: HoverParams,
    document: TextDocument,
  ): Promise<Hover | null> {
    const uri = params.textDocument.uri;
    const position = params.position;

    try {
      const content = document.getText();

      // Race the tsgo request against a timeout
      const typeInfo = await this.withTimeout(
        this.bridge.tsgoIntegration.getTypeInfo(
          uri,
          content,
          position.line,
          position.character,
        ),
        this.timeoutMs,
      );

      if (!typeInfo) {
        return null;
      }

      // Check type expansion depth and potentially truncate
      const expansionInfo = this.guard.checkExpansion(
        typeInfo.typeName,
        typeInfo.depth,
      );

      let typeString = typeInfo.typeString;
      let wasTruncated = typeInfo.truncated || expansionInfo.truncated;

      // Truncate long type strings
      if (typeString.length > MAX_TYPE_STRING_LENGTH) {
        typeString = typeString.slice(0, MAX_TYPE_STRING_LENGTH) + '\n  // ... (truncated)';
        wasTruncated = true;
      }

      // Truncate type strings with too many lines
      const lines = typeString.split('\n');
      if (lines.length > MAX_TYPE_STRING_LINES) {
        typeString =
          lines.slice(0, MAX_TYPE_STRING_LINES).join('\n') +
          `\n  // ... (${lines.length - MAX_TYPE_STRING_LINES} more lines truncated)`;
        wasTruncated = true;
      }

      // Build hover content
      const contents = this.formatHoverContent(
        typeInfo.typeName,
        typeString,
        typeInfo.documentation,
        typeInfo.depth,
        wasTruncated,
        expansionInfo.truncated,
      );

      return {
        contents,
      };
    } catch (err) {
      // Graceful fallback — hover should never show an error to the user
      if (err instanceof TimeoutError) {
        this.logger.debug('Hover request timed out', {
          uri,
          line: position.line,
          character: position.character,
          timeoutMs: this.timeoutMs,
        });
      } else {
        this.logger.warn('Hover request failed', {
          uri,
          line: position.line,
          character: position.character,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  }

  /**
   * Update the timeout for hover requests.
   */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  /**
   * Format the hover content as Markdown.
   */
  private formatHoverContent(
    typeName: string,
    typeString: string,
    documentation: string | undefined,
    depth: number,
    wasTruncated: boolean,
    expansionTruncated: boolean,
  ): MarkupContent {
    const parts: string[] = [];

    // Type information in a code block
    parts.push('```typescript');
    parts.push(typeString);
    parts.push('```');

    // Documentation if available
    if (documentation) {
      parts.push('');
      parts.push(documentation);
    }

    // Depth indicator
    if (depth > 5) {
      parts.push('');
      parts.push(this.renderDepthIndicator(depth));
    }

    // Truncation warning
    if (wasTruncated) {
      parts.push('');
      parts.push('---');
      if (expansionTruncated) {
        const knownPattern = this.guard.matchKnownPattern(typeName);
        if (knownPattern) {
          parts.push(
            `*Type expansion truncated at depth ${depth} (${knownPattern.name} pattern detected)*`,
          );
        } else {
          parts.push(
            `*Type expansion truncated at depth ${depth} to prevent excessive nesting*`,
          );
        }
      } else {
        parts.push('*Type display truncated for readability*');
      }
    }

    return {
      kind: MarkupKind.Markdown,
      value: parts.join('\n'),
    };
  }

  /**
   * Render a visual depth indicator bar.
   */
  private renderDepthIndicator(depth: number): string {
    const maxBars = 20;
    const filled = Math.min(depth, maxBars);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(maxBars - filled);
    return `Expansion depth: \`${bar}\` ${depth}`;
  }

  /**
   * Race a promise against a timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(`Hover request timed out after ${ms}ms`));
      }, ms);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

/**
 * Custom error class for timeout conditions.
 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
