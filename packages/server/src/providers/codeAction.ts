import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Command,
  Diagnostic,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver';
import type { Logger } from '../logger/index.js';
import type { DiagnosticsProvider } from './diagnostics.js';

/**
 * Fix edit from oxc auto-fix data.
 */
interface OxcFixEdit {
  span: { start: number; end: number };
  content: string;
}

/**
 * Fix data structure stored in diagnostic.data by oxc integration.
 */
interface OxcFixData {
  message: string;
  edits: OxcFixEdit[];
}

/**
 * CodeActionProvider generates quick fixes and actions for diagnostics.
 *
 * It supports:
 * - Auto-fix suggestions from oxc lint rules
 * - "Suppress diagnostic" actions (inline comments)
 * - "Show in inspector" command for any diagnostic
 *
 * @example
 * ```ts
 * const provider = new CodeActionProvider(diagnosticsProvider, logger);
 * const actions = provider.provideCodeActions(params, documentText);
 * ```
 */
export class CodeActionProvider {
  private readonly diagnosticsProvider: DiagnosticsProvider;
  private readonly logger: Logger;

  /**
   * @param diagnosticsProvider - the diagnostics provider for looking up diagnostic data
   * @param logger - logger instance
   */
  constructor(diagnosticsProvider: DiagnosticsProvider, logger: Logger) {
    this.diagnosticsProvider = diagnosticsProvider;
    this.logger = logger;
  }

  /**
   * Provide code actions for diagnostics at the given range.
   *
   * @param params - LSP code action request parameters
   * @param documentText - the full document text (for computing edits)
   * @returns array of code actions
   */
  provideCodeActions(
    params: CodeActionParams,
    documentText: string,
  ): CodeAction[] {
    const uri = params.textDocument.uri;
    const diagnostics = params.context.diagnostics;
    const actions: CodeAction[] = [];

    for (const diagnostic of diagnostics) {
      // Only process our diagnostics
      if (
        !diagnostic.source ||
        !diagnostic.source.startsWith('tsgo-turbo')
      ) {
        continue;
      }

      // Auto-fix from oxc
      const fixActions = this.createOxcFixActions(uri, diagnostic, documentText);
      actions.push(...fixActions);

      // Suppress diagnostic action
      const suppressAction = this.createSuppressAction(uri, diagnostic, documentText);
      if (suppressAction) {
        actions.push(suppressAction);
      }

      // Show in inspector action
      const inspectorAction = this.createInspectorAction(uri, diagnostic);
      actions.push(inspectorAction);
    }

    return actions;
  }

  /**
   * Create auto-fix code actions from oxc fix data.
   */
  private createOxcFixActions(
    uri: string,
    diagnostic: Diagnostic,
    documentText: string,
  ): CodeAction[] {
    const data = diagnostic.data as Record<string, unknown> | undefined;
    if (!data || !data['fix']) {
      return [];
    }

    try {
      const fix = data['fix'] as OxcFixData;
      const edits: TextEdit[] = [];

      for (const edit of fix.edits) {
        const startPos = this.offsetToPosition(documentText, edit.span.start);
        const endPos = this.offsetToPosition(documentText, edit.span.end);

        if (startPos && endPos) {
          edits.push(TextEdit.replace({ start: startPos, end: endPos }, edit.content));
        }
      }

      if (edits.length === 0) {
        return [];
      }

      const workspaceEdit: WorkspaceEdit = {
        changes: { [uri]: edits },
      };

      const action: CodeAction = {
        title: `Fix: ${fix.message}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: workspaceEdit,
        isPreferred: true,
      };

      return [action];
    } catch (err) {
      this.logger.debug('Failed to create oxc fix action', {
        uri,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Create a "suppress diagnostic" action that inserts a comment.
   */
  private createSuppressAction(
    uri: string,
    diagnostic: Diagnostic,
    documentText: string,
  ): CodeAction | null {
    const data = diagnostic.data as Record<string, unknown> | undefined;
    const source = data?.['source'] as string | undefined;
    const code = diagnostic.code;

    if (!code) {
      return null;
    }

    // Determine the suppress comment format based on source
    let suppressComment: string;
    if (source === 'oxc') {
      suppressComment = `// oxlint-disable-next-line ${code}`;
    } else if (source === 'tsgo') {
      suppressComment = `// @ts-ignore ${code}`;
    } else {
      suppressComment = `// tsgo-turbo-ignore ${code}`;
    }

    // Insert the comment on the line above the diagnostic
    const line = diagnostic.range.start.line;
    const lines = documentText.split('\n');
    const indent = line < lines.length ? this.getIndentation(lines[line]) : '';

    const textEdit = TextEdit.insert(
      { line, character: 0 },
      `${indent}${suppressComment}\n`,
    );

    const workspaceEdit: WorkspaceEdit = {
      changes: { [uri]: [textEdit] },
    };

    return {
      title: `Suppress: ${code}`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: workspaceEdit,
    };
  }

  /**
   * Create a "Show in inspector" command action.
   */
  private createInspectorAction(
    uri: string,
    diagnostic: Diagnostic,
  ): CodeAction {
    const command: Command = {
      title: 'Show in tsgo Turbo Inspector',
      command: 'tsgo-turbo.showInInspector',
      arguments: [
        {
          uri,
          line: diagnostic.range.start.line,
          column: diagnostic.range.start.character,
          message: diagnostic.message,
          code: diagnostic.code,
        },
      ],
    };

    return {
      title: 'Show in tsgo Turbo Inspector',
      kind: CodeActionKind.Empty,
      diagnostics: [diagnostic],
      command,
    };
  }

  /**
   * Convert a byte offset to a line/character Position.
   */
  private offsetToPosition(
    text: string,
    offset: number,
  ): { line: number; character: number } | undefined {
    if (offset < 0 || offset > text.length) {
      return undefined;
    }

    let line = 0;
    let character = 0;

    for (let i = 0; i < offset; i++) {
      if (text[i] === '\n') {
        line++;
        character = 0;
      } else {
        character++;
      }
    }

    return { line, character };
  }

  /**
   * Extract the leading whitespace from a line.
   */
  private getIndentation(line: string): string {
    const match = /^(\s*)/.exec(line);
    return match ? match[1] : '';
  }
}
