/**
 * CodeMirror 6 Live Preview Plugin with Widgets
 * Replaces markdown lines with rendered HTML widgets
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, StateField, Range } from "@codemirror/state";
import { MarkdownWidget } from "./widgets";

/**
 * Get the line number where the cursor is
 */
function getCurrentLine(state: EditorState): number {
  const { from } = state.selection.main;
  return state.doc.lineAt(from).number;
}

/**
 * Create decorations to replace lines with widgets
 */
function createDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  // If editor doesn't have focus, render all lines
  const renderAllLines = !view.hasFocus;
  const currentLine = renderAllLines ? -1 : getCurrentLine(view.state);

  const doc = view.state.doc;

  // Iterate through all lines
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    // Skip current line when editor has focus
    if (!renderAllLines && lineNum === currentLine) {
      continue;
    }

    const line = doc.line(lineNum);
    const lineText = line.text;

    // Skip empty lines
    if (!lineText.trim()) {
      continue;
    }

    // Create a widget and a mark to style the line
    const widget = new MarkdownWidget(lineText);

    // Add widget at the start of the line
    const widgetDeco = Decoration.widget({
      widget,
      side: 1,
    });

    // Add mark to hide the actual text
    const markDeco = Decoration.mark({
      class: "cm-hidden-source",
    });

    decorations.push(widgetDeco.range(line.from));
    decorations.push(markDeco.range(line.from, line.to));
  }

  return Decoration.set(decorations, true);
}

/**
 * View plugin that manages widget decorations
 */
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(private view: EditorView) {
      this.decorations = createDecorations(view);
    }

    update(update: ViewUpdate) {
      // Update decorations on doc change, selection change, or focus change
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        this.decorations = createDecorations(this.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Extension for widget-based live preview
 */
export function livePreview() {
  return [livePreviewPlugin];
}
