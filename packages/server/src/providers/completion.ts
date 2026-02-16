import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  CompletionParams,
  InsertTextFormat,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Logger } from '../logger/index.js';
import type { AnalysisBridge } from '../integrations/bridge.js';
import type { TsgoCompletion } from '../integrations/tsgo.js';

/**
 * CompletionProvider provides code completions by delegating to tsgo's
 * completion engine. It transforms tsgo completion items into LSP
 * CompletionItem format, filters, and sorts them.
 *
 * @example
 * ```ts
 * const provider = new CompletionProvider(bridge, logger);
 * const result = await provider.provideCompletions(params, document);
 * ```
 */
export class CompletionProvider {
  private readonly bridge: AnalysisBridge;
  private readonly logger: Logger;

  /**
   * @param bridge - the analysis bridge for accessing tsgo
   * @param logger - logger instance
   */
  constructor(bridge: AnalysisBridge, logger: Logger) {
    this.bridge = bridge;
    this.logger = logger;
  }

  /**
   * Provide completions at the given position.
   *
   * @param params - LSP completion request parameters
   * @param document - the text document being edited
   * @returns a CompletionList with completion items
   */
  async provideCompletions(
    params: CompletionParams,
    document: TextDocument,
  ): Promise<CompletionList> {
    const uri = params.textDocument.uri;
    const position = params.position;

    try {
      const content = document.getText();
      const completions = await this.bridge.tsgoIntegration.getCompletions(
        uri,
        content,
        position.line,
        position.character,
      );

      if (!completions || completions.length === 0) {
        return CompletionList.create([], false);
      }

      const items = completions.map((c, index) =>
        this.toCompletionItem(c, index),
      );

      // Sort: prioritize exact matches, then alphabetical
      items.sort((a, b) => {
        const sortA = a.sortText ?? a.label;
        const sortB = b.sortText ?? b.label;
        return sortA.localeCompare(sortB);
      });

      return CompletionList.create(items, false);
    } catch (err) {
      this.logger.warn('Completion request failed', {
        uri,
        line: position.line,
        character: position.character,
        error: err instanceof Error ? err.message : String(err),
      });
      return CompletionList.create([], false);
    }
  }

  /**
   * Convert a tsgo completion item to an LSP CompletionItem.
   */
  private toCompletionItem(
    tsgoItem: TsgoCompletion,
    index: number,
  ): CompletionItem {
    const item: CompletionItem = {
      label: tsgoItem.label,
      kind: this.mapKind(tsgoItem.kind),
      detail: tsgoItem.detail
        ? `${tsgoItem.detail} (tsgo)`
        : '(tsgo)',
      documentation: tsgoItem.documentation,
      sortText: tsgoItem.sortText ?? String(index).padStart(5, '0'),
      insertText: tsgoItem.insertText ?? tsgoItem.label,
      insertTextFormat: InsertTextFormat.PlainText,
    };

    return item;
  }

  /**
   * Map tsgo completion kind strings to LSP CompletionItemKind.
   */
  private mapKind(kind: string): CompletionItemKind {
    switch (kind.toLowerCase()) {
      case 'function':
      case 'method':
        return CompletionItemKind.Function;
      case 'variable':
      case 'let':
      case 'const':
        return CompletionItemKind.Variable;
      case 'property':
      case 'field':
        return CompletionItemKind.Property;
      case 'class':
        return CompletionItemKind.Class;
      case 'interface':
        return CompletionItemKind.Interface;
      case 'module':
      case 'namespace':
        return CompletionItemKind.Module;
      case 'keyword':
        return CompletionItemKind.Keyword;
      case 'enum':
        return CompletionItemKind.Enum;
      case 'enum member':
      case 'enummember':
        return CompletionItemKind.EnumMember;
      case 'type':
      case 'type parameter':
      case 'typeparameter':
        return CompletionItemKind.TypeParameter;
      case 'snippet':
        return CompletionItemKind.Snippet;
      case 'text':
        return CompletionItemKind.Text;
      case 'file':
      case 'path':
        return CompletionItemKind.File;
      case 'folder':
      case 'directory':
        return CompletionItemKind.Folder;
      case 'constant':
        return CompletionItemKind.Constant;
      case 'struct':
        return CompletionItemKind.Struct;
      case 'event':
        return CompletionItemKind.Event;
      case 'operator':
        return CompletionItemKind.Operator;
      case 'value':
        return CompletionItemKind.Value;
      default:
        return CompletionItemKind.Text;
    }
  }
}
