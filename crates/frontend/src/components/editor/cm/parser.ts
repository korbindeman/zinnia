/**
 * Markdown parsing utilities using unified.js and remark
 * Converts markdown text to AST for live preview rendering
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Heading, List, ListItem, Text } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Represents a text node with position information in the markdown source
 */
export interface TextNode {
  type: "text";
  value: string;
  position: {
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
  };
}

/**
 * Represents a formatting mark (syntax) to be hidden in live preview
 */
export interface FormatMark {
  from: number; // Start position in document (0-indexed)
  to: number; // End position in document (0-indexed)
  type: "heading" | "bold" | "italic" | "list" | "task-list";
  level?: number; // For headings (1-6)
}

/**
 * Parse markdown text to AST using unified/remark
 */
export function parseMarkdown(text: string): Root {
  const processor = unified().use(remarkParse).use(remarkGfm);

  return processor.parse(text) as Root;
}

/**
 * Extract formatting marks from markdown AST
 * Returns array of marks that should be hidden in live preview mode
 */
export function extractFormatMarks(ast: Root): FormatMark[] {
  const marks: FormatMark[] = [];

  visit(ast, (node) => {
    if (!node.position) return;

    const startOffset = node.position.start.offset;
    const endOffset = node.position.end.offset;

    // Skip if offsets are undefined
    if (startOffset === undefined || endOffset === undefined) return;

    // Headings: hide the # symbols
    if (node.type === "heading") {
      const heading = node as Heading;
      const level = heading.depth;

      // The heading marks are the # symbols at the start
      // Format: "# ", "## ", etc.
      marks.push({
        from: startOffset,
        to: startOffset + level + 1, // level hash marks + 1 space
        type: "heading",
        level,
      });
    }

    // Bold: hide ** or __
    if (node.type === "strong") {
      // Strong can use ** or __ (2 characters each)
      marks.push({
        from: startOffset,
        to: startOffset + 2, // Opening **
        type: "bold",
      });
      marks.push({
        from: endOffset - 2,
        to: endOffset, // Closing **
        type: "bold",
      });
    }

    // Italic: hide * or _
    if (node.type === "emphasis") {
      // Emphasis can use * or _ (1 character each)
      marks.push({
        from: startOffset,
        to: startOffset + 1, // Opening *
        type: "italic",
      });
      marks.push({
        from: endOffset - 1,
        to: endOffset, // Closing *
        type: "italic",
      });
    }

    // Lists: hide the bullet/number markers
    if (node.type === "list") {
      const list = node as List;

      list.children.forEach((item) => {
        if (!item.position) return;

        const itemStart = item.position.start.offset;
        if (itemStart === undefined) return;

        const listItem = item as ListItem;

        // Check if it's a task list item
        if (listItem.checked !== null && listItem.checked !== undefined) {
          // Task list: "- [ ] " or "- [x] "
          const markerEnd = itemStart + (list.ordered ? 3 : 2); // "- " or "1. "
          const checkboxEnd = markerEnd + 4; // "[x] "

          marks.push({
            from: itemStart,
            to: checkboxEnd,
            type: "task-list",
          });
        } else {
          // Regular list item
          // Unordered: "- ", "* ", or "+ "
          // Ordered: "1. ", "2. ", etc.

          if (list.ordered) {
            // Find where the number ends (look for ". ")
            const firstChild = listItem.children[0];
            if (firstChild && firstChild.position) {
              const contentStart = firstChild.position.start.offset;
              if (contentStart !== undefined) {
                marks.push({
                  from: itemStart,
                  to: contentStart,
                  type: "list",
                });
              }
            }
          } else {
            // Unordered list marker is 2 characters: "- "
            marks.push({
              from: itemStart,
              to: itemStart + 2,
              type: "list",
            });
          }
        }
      });
    }
  });

  return marks;
}

/**
 * Get all text nodes from AST with their positions
 * Useful for testing and debugging
 */
export function extractTextNodes(ast: Root): TextNode[] {
  const textNodes: TextNode[] = [];

  visit(ast, "text", (node) => {
    const textNode = node as Text;
    if (textNode.position) {
      const startOffset = textNode.position.start.offset;
      const endOffset = textNode.position.end.offset;

      if (startOffset !== undefined && endOffset !== undefined) {
        textNodes.push({
          type: "text",
          value: textNode.value,
          position: {
            start: {
              line: textNode.position.start.line,
              column: textNode.position.start.column,
              offset: startOffset,
            },
            end: {
              line: textNode.position.end.line,
              column: textNode.position.end.column,
              offset: endOffset,
            },
          },
        });
      }
    }
  });

  return textNodes;
}

/**
 * Check if a position is within a formatting node
 * Used to determine when to show/hide syntax based on cursor position
 */
export function isPositionInFormatting(
  pos: number,
  ast: Root,
  formatType?: FormatMark["type"],
): boolean {
  let isInFormatting = false;

  visit(ast, (node) => {
    if (!node.position) return;

    const nodeStart = node.position.start.offset;
    const nodeEnd = node.position.end.offset;

    if (nodeStart === undefined || nodeEnd === undefined) return;

    // Check if position is within this node
    if (pos >= nodeStart && pos <= nodeEnd) {
      // Check if this node type matches the requested format type
      if (formatType) {
        if (
          (formatType === "heading" && node.type === "heading") ||
          (formatType === "bold" && node.type === "strong") ||
          (formatType === "italic" && node.type === "emphasis") ||
          (formatType === "list" && node.type === "list") ||
          (formatType === "task-list" &&
            node.type === "listItem" &&
            "checked" in node)
        ) {
          isInFormatting = true;
        }
      } else {
        // No specific format type requested, check if in any formatting
        if (
          node.type === "heading" ||
          node.type === "strong" ||
          node.type === "emphasis" ||
          node.type === "list" ||
          (node.type === "listItem" && "checked" in node)
        ) {
          isInFormatting = true;
        }
      }
    }
  });

  return isInFormatting;
}
