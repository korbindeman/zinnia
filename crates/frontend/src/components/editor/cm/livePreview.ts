/**
 * CodeMirror 6 Live Preview Plugin
 * Hides markdown syntax when cursor is not in formatted text (Obsidian-style)
 */

import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { parseMarkdown, extractFormatMarks, type FormatMark } from "./parser";

/**
 * State effect to update parsed format marks
 */
const setFormatMarks = StateEffect.define<FormatMark[]>();

/**
 * State field to store current format marks
 */
const formatMarksField = StateField.define<FormatMark[]>({
  create() {
    return [];
  },
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFormatMarks)) {
        return effect.value;
      }
    }
    return marks;
  },
});

/**
 * Debounced parsing state
 * Stores timer and last parsed content to avoid excessive parsing
 */
let parseTimer: number | null = null;
let lastParsedContent = "";

/**
 * Parse markdown and update format marks with debouncing
 */
function scheduleParse(view: EditorView, delay = 100) {
  if (parseTimer !== null) {
    clearTimeout(parseTimer);
  }

  parseTimer = window.setTimeout(() => {
    const content = view.state.doc.toString();

    // Only parse if content has changed
    if (content === lastParsedContent) {
      return;
    }

    lastParsedContent = content;
    const ast = parseMarkdown(content);
    const marks = extractFormatMarks(ast);

    view.dispatch({
      effects: setFormatMarks.of(marks),
    });

    parseTimer = null;
  }, delay);
}

/**
 * Check if any selection range or cursor position overlaps with a mark
 * Only applies when editor is focused
 */
function isMarkInSelection(
  mark: FormatMark,
  state: EditorState,
  view: EditorView,
): boolean {
  // If editor is not focused, hide all marks (show full preview)
  if (!view.hasFocus) {
    return false;
  }

  const { from, to } = mark;

  for (const range of state.selection.ranges) {
    // If there's an actual selection (not just a cursor), check overlap
    if (range.from !== range.to) {
      if (range.from <= to && range.to >= from) {
        return true;
      }
    } else {
      // For cursor position (no selection), check if cursor is on the same line
      const cursorPos = range.from;
      const cursorLine = state.doc.lineAt(cursorPos);

      // Check if the mark is on the same line as the cursor
      if (from <= cursorLine.to && to >= cursorLine.from) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create decorations for format marks based on cursor position and focus
 */
function createDecorations(view: EditorView): DecorationSet {
  const marks = view.state.field(formatMarksField, false) || [];
  const decorations: any[] = [];

  for (const mark of marks) {
    // Show syntax if cursor/selection is in the formatted region or editor is focused
    if (isMarkInSelection(mark, view.state, view)) {
      continue; // Don't hide the mark
    }

    // Hide the syntax mark
    decorations.push(
      Decoration.replace({
        inclusive: false,
      }).range(mark.from, mark.to),
    );
  }

  return Decoration.set(decorations, true);
}

/**
 * View plugin that manages decorations and triggers parsing
 */
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(private view: EditorView) {
      // Initial parse
      scheduleParse(view, 0);
      this.decorations = createDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        scheduleParse(this.view);
      }

      // Check if format marks were updated
      const marksUpdated = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setFormatMarks)),
      );

      // Update decorations on doc change, selection change, focus change, or marks update
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        marksUpdated
      ) {
        this.decorations = createDecorations(this.view);
      }
    }

    destroy() {
      if (parseTimer !== null) {
        clearTimeout(parseTimer);
        parseTimer = null;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Extension combining all live preview functionality
 */
export function livePreview() {
  return [formatMarksField, livePreviewPlugin];
}

/**
 * Utility to force reparse (useful for testing)
 */
export function forceParse(view: EditorView) {
  scheduleParse(view, 0);
}

/**
 * Utility to get current format marks (useful for testing)
 */
export function getFormatMarks(state: EditorState): FormatMark[] {
  return state.field(formatMarksField, false) || [];
}
