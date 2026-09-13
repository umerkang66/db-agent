import { describe, it, expect, vi } from 'vitest';
import {
  renderMarkdown,
  printMarkdown,
  createMarkdownRenderer,
} from '../src/markdown.js';

describe('Markdown Terminal Renderer', () => {
  it('returns empty string for empty, null, or undefined input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null as any)).toBe('');
    expect(renderMarkdown(undefined as any)).toBe('');
  });

  it('renders bold and italic formatting', () => {
    const output = renderMarkdown('This is **bold** and *italic* text.');
    expect(output).toContain('bold');
    expect(output).toContain('italic');
    expect(output).not.toContain('**');
    expect(output).not.toContain('*italic*');
  });

  it('renders headings with cyan/bold formatting and prefixes', () => {
    const output = renderMarkdown('# Main Heading\n## Sub Heading');
    expect(output).toContain('# Main Heading');
    expect(output).toContain('## Sub Heading');
  });

  it('supports hiding section prefixes when showSectionPrefix is false', () => {
    const output = renderMarkdown('# Main Heading', { showSectionPrefix: false });
    expect(output).not.toContain('# Main Heading');
    expect(output).toContain('Main Heading');
  });

  it('renders inline code and code blocks', () => {
    const inline = renderMarkdown('Run `npm test` now.');
    expect(inline).toContain('npm test');

    const block = renderMarkdown('```sql\nSELECT * FROM users;\n```');
    expect(block).toContain('SELECT * FROM users;');
  });

  it('renders bullet lists and ordered lists', () => {
    const list = renderMarkdown('- First item\n- Second item\n  - Nested item');
    expect(list).toContain('First item');
    expect(list).toContain('Second item');
    expect(list).toContain('Nested item');

    const ordered = renderMarkdown('1. Step 1\n2. Step 2');
    expect(ordered).toContain('1. Step 1');
    expect(ordered).toContain('2. Step 2');
  });

  it('renders markdown tables into styled terminal tables', () => {
    const tableMd = [
      '| Column 1 | Column 2 |',
      '| --- | --- |',
      '| Alpha | 100 |',
      '| Beta | 200 |',
    ].join('\n');

    const output = renderMarkdown(tableMd);
    expect(output).toContain('Column 1');
    expect(output).toContain('Column 2');
    expect(output).toContain('Alpha');
    expect(output).toContain('Beta');
    // Table border characters
    expect(output).toMatch(/[┌┬┐├┼┤└┴┘│─]/);
  });

  it('prints rendered markdown using printMarkdown', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printMarkdown('**Test Message**');
    expect(consoleSpy).toHaveBeenCalledOnce();
    const calledWith = consoleSpy.mock.calls[0][0];
    expect(calledWith).toContain('Test Message');
    consoleSpy.mockRestore();
  });

  it('creates custom Marked instances with createMarkdownRenderer', () => {
    const customRenderer = createMarkdownRenderer({ tab: 4 });
    expect(customRenderer).toBeDefined();
    const res = customRenderer.parse('# Custom Heading');
    expect(typeof res).toBe('string');
    expect(res).toContain('Custom Heading');
  });
});
