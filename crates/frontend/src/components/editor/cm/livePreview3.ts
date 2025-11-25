/**
 * CodeMirror 6 Live Preview Plugin - Syntax Hiding Approach
 * Hides markdown syntax marks instead of replacing with widgets
 * This allows proper cursor positioning on click
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range, StateField, StateEffect } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Get all line numbers that have a selection in them
 */
function getSelectedLines(state: EditorState): Set<number> {
  const selectedLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;

    // Add all lines in the selection range
    for (let lineNum = fromLine; lineNum <= toLine; lineNum++) {
      selectedLines.add(lineNum);
    }
  }

  return selectedLines;
}

/**
 * StateEffect to set the note path
 */
export const setNotePathEffect = StateEffect.define<string>();

/**
 * StateField to store the note path
 */
export const notePathField = StateField.define<string>({
  create: () => "",
  update: (value, tr) => {
    for (let effect of tr.effects) {
      if (effect.is(setNotePathEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

/**
 * Create decorations to hide markdown syntax
 */
function createDecorations(view: EditorView, notePath: string): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  // If editor doesn't have focus, render all lines in preview mode
  const renderAllLines = !view.hasFocus;
  const selectedLines = renderAllLines
    ? new Set<number>()
    : getSelectedLines(view.state);

  const doc = view.state.doc;

  // Iterate through all lines
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum);
    const lineText = line.text;

    // Skip empty lines
    if (!lineText.trim()) {
      continue;
    }

    // Determine if this line should show syntax marks (source mode)
    const isSourceMode = !renderAllLines && selectedLines.has(lineNum);

    // Headings: hide the # marks and style the line
    const headingMatch = lineText.match(/^(#{1,6})\s+/);
    if (headingMatch) {
      const hashMarks = headingMatch[0];
      const level = headingMatch[1].length;

      if (!isSourceMode) {
        // Preview mode: hide the # marks
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(
            line.from,
            line.from + hashMarks.length,
          ),
        );
      }

      // Style the entire line as a heading (both modes)
      decorations.push(
        Decoration.line({ class: `cm-heading-line cm-heading-${level}` }).range(
          line.from,
        ),
      );

      // Make heading text bold (both modes)
      decorations.push(
        Decoration.mark({ class: "cm-bold-text" }).range(
          line.from + hashMarks.length,
          line.to,
        ),
      );
    }

    // List items: hide the bullet/number and add bullet display
    const listMatch = lineText.match(/^([-*+]|\d+\.)\s+/);
    if (listMatch) {
      const marker = listMatch[0];

      if (!isSourceMode) {
        // Preview mode: hide the marker
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(
            line.from,
            line.from + marker.length,
          ),
        );

        // Add styled bullet/number before the content
        const isOrdered = /^\d+\./.test(marker);
        const bulletWidget = Decoration.widget({
          widget: new (class extends WidgetType {
            toDOM() {
              const span = document.createElement("span");
              span.className = "cm-list-marker";
              span.textContent = isOrdered ? marker.trim() + " " : "• ";
              return span;
            }
          })(),
          side: 1,
        });

        decorations.push(bulletWidget.range(line.from + marker.length));
      }
    }

    // Bold: handle ** markers
    const boldRegex = /\*\*(.+?)\*\*/g;
    let boldMatch;
    while ((boldMatch = boldRegex.exec(lineText)) !== null) {
      const start = line.from + boldMatch.index;
      const end = start + boldMatch[0].length;

      if (!isSourceMode) {
        // Preview mode: hide ** markers
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(start, start + 2),
        );
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(end - 2, end),
        );
      }

      // Make content bold (both modes)
      decorations.push(
        Decoration.mark({ class: "cm-bold-text" }).range(start + 2, end - 2),
      );
    }

    // Italic: handle * markers (but not ** which is bold)
    const italicRegex = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
    let italicMatch;
    while ((italicMatch = italicRegex.exec(lineText)) !== null) {
      const start = line.from + italicMatch.index;
      const end = start + italicMatch[0].length;

      if (!isSourceMode) {
        // Preview mode: hide * markers
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(start, start + 1),
        );
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(end - 1, end),
        );
      }

      // Make content italic (both modes)
      decorations.push(
        Decoration.mark({ class: "cm-italic-text" }).range(start + 1, end - 1),
      );
    }

    // Strikethrough: handle ~~ markers
    const strikethroughRegex = /~~(.+?)~~/g;
    let strikeMatch;
    while ((strikeMatch = strikethroughRegex.exec(lineText)) !== null) {
      const start = line.from + strikeMatch.index;
      const end = start + strikeMatch[0].length;

      if (!isSourceMode) {
        // Preview mode: hide ~~ markers
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(start, start + 2),
        );
        decorations.push(
          Decoration.mark({ class: "cm-hide-syntax" }).range(end - 2, end),
        );
      }

      // Make content strikethrough (both modes)
      decorations.push(
        Decoration.mark({ class: "cm-strikethrough-text" }).range(
          start + 2,
          end - 2,
        ),
      );
    }

    // Images: handle ![alt](url) syntax - only if it's the entire line
    // Images always render as block-level widgets on their own line
    const trimmedLine = lineText.trim();
    const imageRegex = /^!\[([^\]]*)\]\(([^)]+)\)$/;
    const imageMatch = trimmedLine.match(imageRegex);

    if (imageMatch) {
      const alt = imageMatch[1];
      const url = imageMatch[2];

      // Hide the entire line
      decorations.push(
        Decoration.line({ class: "cm-image-line" }).range(line.from),
      );

      decorations.push(
        Decoration.mark({ class: "cm-hide-syntax" }).range(line.from, line.to),
      );

      // Add block-level image widget at the start of the line
      const imageWidget = Decoration.widget({
        widget: new (class extends WidgetType {
          toDOM() {
            const container = document.createElement("div");
            container.className = "cm-image-block";

            const img = document.createElement("img");

            // Convert local paths to Tauri asset protocol
            // Local paths start with ./ or _attachments/
            if (url.startsWith("./") || url.startsWith("_attachments/")) {
              // Resolve the path asynchronously
              (async () => {
                try {
                  // Import commands dynamically to avoid circular dependencies
                  const { commands } = await import("../../../api/commands");
                  const fullPath = await commands.resolveImagePath(
                    notePath,
                    url,
                  );
                  // Convert the file path to Tauri asset URL with 'asset' protocol
                  const assetUrl = convertFileSrc(fullPath, "asset");
                  img.src = assetUrl;
                } catch (error) {
                  console.error(`Failed to resolve image path: ${url}`, error);
                  img.alt = `[Image not found: ${alt || url}]`;
                  container.classList.add("cm-image-error");
                }
              })();
            } else {
              // Remote URLs use as-is (though they shouldn't exist after paste handling)
              img.src = url;
            }

            img.alt = alt;
            img.className = "cm-image-content";

            // Handle image load errors
            img.onerror = () => {
              console.error(`Failed to load image: ${url}`);
              img.alt = `[Image failed to load: ${alt || url}]`;
              container.classList.add("cm-image-error");
            };

            container.appendChild(img);
            return container;
          }
        })(),
        block: true,
        side: -1,
      });

      decorations.push(imageWidget.range(line.from));
    }
  }

  return Decoration.set(decorations, true);
}

/**
 * View plugin that manages decorations
 */
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(private view: EditorView) {
      const notePath = view.state.field(notePathField);
      this.decorations = createDecorations(view, notePath);
    }

    update(update: ViewUpdate) {
      // Update decorations on doc change, selection change, focus change, or note path change
      const notePath = update.state.field(notePathField);
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(setNotePathEffect)),
        )
      ) {
        this.decorations = createDecorations(this.view, notePath);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Extension for syntax-hiding live preview
 */
export function livePreview() {
  return [notePathField, livePreviewPlugin];
}
