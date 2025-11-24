/**
 * CodeMirror Widget System for Rendered Markdown
 * Creates widgets that replace markdown source with rendered HTML
 */

import { WidgetType } from "@codemirror/view";
import { renderBlockToDOM } from "./renderer";

/**
 * Widget that displays rendered markdown HTML
 */
export class MarkdownWidget extends WidgetType {
  constructor(private markdown: string) {
    super();
  }

  toDOM(): HTMLElement {
    const rendered = renderBlockToDOM([this.markdown]);
    rendered.classList.add("cm-markdown-widget");

    return rendered;
  }

  eq(other: MarkdownWidget): boolean {
    return this.markdown === other.markdown;
  }

  ignoreEvent(event: Event): boolean {
    // Let CodeMirror handle mousedown events for cursor positioning
    return event.type === "mousedown";
  }
}

/**
 * Widget for rendering a block of multiple lines (like lists)
 */
export class MarkdownBlockWidget extends WidgetType {
  constructor(private lines: string[]) {
    super();
  }

  toDOM(): HTMLElement {
    const rendered = renderBlockToDOM(this.lines);
    rendered.classList.add("cm-markdown-block-widget");
    rendered.setAttribute("contenteditable", "false");

    return rendered;
  }

  eq(other: MarkdownBlockWidget): boolean {
    return (
      this.lines.length === other.lines.length &&
      this.lines.every((line, i) => line === other.lines[i])
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}
