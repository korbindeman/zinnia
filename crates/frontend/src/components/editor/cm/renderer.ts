/**
 * Markdown to HTML Renderer for CodeMirror Widgets
 * Converts markdown blocks to semantic HTML elements
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import type { Root } from "mdast";

/**
 * Parse and render markdown to HTML string
 */
export async function renderMarkdownToHTML(markdown: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeStringify);

  const result = await processor.process(markdown);
  return String(result);
}

/**
 * Parse and render markdown to DOM element (synchronous)
 * Used for creating widget content
 */
export function renderMarkdownToDOM(markdown: string): HTMLElement {
  const trimmed = markdown.trim();

  if (!trimmed) {
    // Empty line - return empty span
    const span = document.createElement("span");
    span.className = "cm-markdown-rendered";
    return span;
  }

  // Headings - render as bold span to avoid block display issues
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const text = headingMatch[2];
    const span = document.createElement("span");
    span.className = `cm-markdown-rendered cm-heading cm-heading-${level}`;
    span.innerHTML = processInlineMarkdown(text);
    return span;
  }

  // Unordered list item - render as span with bullet
  const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
  if (ulMatch) {
    const text = ulMatch[1];
    const span = document.createElement("span");
    span.className = "cm-markdown-rendered cm-list-item";
    span.innerHTML = "• " + processInlineMarkdown(text);
    return span;
  }

  // Ordered list item - render as span with number
  const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
  if (olMatch) {
    const num = olMatch[1];
    const text = olMatch[2];
    const span = document.createElement("span");
    span.className = "cm-markdown-rendered cm-list-item";
    span.innerHTML = num + ". " + processInlineMarkdown(text);
    return span;
  }

  // Horizontal rule
  if (trimmed.match(/^(---|\*\*\*|___)$/)) {
    const hr = document.createElement("hr");
    hr.className = "cm-markdown-rendered";
    return hr;
  }

  // Code block marker
  if (trimmed.startsWith("```")) {
    const span = document.createElement("span");
    span.className = "cm-markdown-rendered";
    span.textContent = trimmed;
    return span;
  }

  // Blockquote
  if (trimmed.startsWith(">")) {
    const text = trimmed.substring(1).trim();
    const blockquote = document.createElement("blockquote");
    blockquote.className = "cm-markdown-rendered";
    blockquote.innerHTML = processInlineMarkdown(text);
    return blockquote;
  }

  // Default: span with inline markdown
  const span = document.createElement("span");
  span.className = "cm-markdown-rendered";
  span.innerHTML = processInlineMarkdown(trimmed);
  return span;
}

/**
 * Process inline markdown (bold, italic, links, code)
 */
function processInlineMarkdown(text: string): string {
  // Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic *text* or _text_
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");

  // Inline code `code`
  text = text.replace(/`(.+?)`/g, "<code>$1</code>");

  // Links [text](url)
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

  return text;
}

/**
 * Render a block of lines to a single DOM element
 */
export function renderBlockToDOM(lines: string[]): HTMLElement {
  const markdown = lines.join("\n");
  return renderMarkdownToDOM(markdown);
}

/**
 * Check if a line is part of a multi-line block
 */
export function isMultiLineBlock(line: string): boolean {
  const trimmed = line.trim();

  // List items
  if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
    return true;
  }

  // Code blocks
  if (trimmed.startsWith("```")) {
    return true;
  }

  // Blockquotes
  if (trimmed.startsWith(">")) {
    return true;
  }

  return false;
}
