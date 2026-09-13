import { Marked } from 'marked';
import { markedTerminal, TerminalRendererOptions } from 'marked-terminal';
import chalk from 'chalk';

export interface MarkdownRenderOptions extends TerminalRendererOptions {
  highlightOptions?: any;
}

/**
 * Creates a configured Marked parser instance configured for terminal rendering.
 */
export function createMarkdownRenderer(options: MarkdownRenderOptions = {}): Marked {
  const terminalOptions: TerminalRendererOptions = {
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.cyan.underline,
    codespan: chalk.yellow,
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    hr: (input?: string) => {
      const w = Math.min(options.width ?? (process.stdout.columns || 80), 80);
      return chalk.gray((input && input.trim()) ? input : '─'.repeat(w));
    },
    table: chalk.reset,
    tableOptions: {
      style: {
        head: ['cyan', 'bold'],
        border: ['gray'],
      },
    },
    tab: 2,
    showSectionPrefix: true,
    reflowText: false,
    width: options.width ?? (process.stdout.columns || 80),
    ...options,
  };

  const marked = new Marked();
  marked.use(markedTerminal(terminalOptions, options.highlightOptions) as any);
  return marked;
}

// Default singleton renderer instance for standard rendering
let defaultRenderer: Marked | null = null;

function getDefaultRenderer(): Marked {
  if (!defaultRenderer) {
    defaultRenderer = createMarkdownRenderer();
  }
  return defaultRenderer;
}

/**
 * Render a markdown string formatted with ANSI escape sequences for terminal display.
 *
 * @param content - Markdown formatted text string
 * @param options - Custom rendering options
 * @returns Formatted terminal string
 */
export function renderMarkdown(
  content?: string | null,
  options?: MarkdownRenderOptions,
): string {
  if (!content || typeof content !== 'string') {
    return '';
  }

  try {
    const renderer = options ? createMarkdownRenderer(options) : getDefaultRenderer();
    const result = renderer.parse(content);
    const parsedStr = typeof result === 'string' ? result : String(result);
    // Trim trailing newlines cleanly
    return parsedStr.replace(/\n+$/, '');
  } catch {
    // Fallback safely to original content if parsing fails
    return content;
  }
}

/**
 * Utility function to render and print markdown directly to standard output.
 */
export function printMarkdown(
  content?: string | null,
  options?: MarkdownRenderOptions,
): void {
  const rendered = renderMarkdown(content, options);
  if (rendered) {
    console.log(rendered);
  }
}
