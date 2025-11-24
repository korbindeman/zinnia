/**
 * In-document search functionality for CodeMirror 6
 * Provides browser-style search with Cmd/Ctrl+F
 */

import { search, highlightSelectionMatches } from "@codemirror/search";

/**
 * Search panel extension with custom styling
 * Provides Cmd/Ctrl+F search functionality
 */
export function searchPanel() {
  return [
    // Built-in search panel with Cmd/Ctrl+F support
    search({
      top: true, // Show search panel at top
    }),

    // Highlight matching selections
    highlightSelectionMatches(),
  ];
}
