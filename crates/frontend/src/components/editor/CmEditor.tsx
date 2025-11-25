/**
 * CodeMirror 6 Editor Component for SolidJS
 * Provides live preview markdown editing with auto-save
 */

import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  history,
  defaultKeymap,
  historyKeymap,
  deleteCharBackward,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { livePreview, setNotePathEffect } from "./cm/livePreview3";
import { searchPanel } from "./cm/search";
import { useAutoSave } from "../../api/hooks";
import { NoteContent } from "../../api/hooks";
import { commands } from "../../api/commands";
import "./CmEditor.css";

const AUTOSAVE_DELAY = 400;

interface CmEditorProps {
  /**
   * Current note path
   */
  path: string;

  /**
   * Note content object
   */
  content: NoteContent;
}

/**
 * CodeMirror 6 markdown editor with live preview
 */
export const CmEditor: Component<CmEditorProps> = (props) => {
  let editorContainer: HTMLDivElement | undefined;
  let editorView: EditorView | undefined;

  const [pathSignal, _] = createSignal(props.path);

  const autoSave = useAutoSave({
    getPath: pathSignal,
    getContent: props.content.content,
    delay: AUTOSAVE_DELAY,
  });

  // Set initial content as last saved to avoid triggering autosave on load
  autoSave.setLastSavedContent(props.content.content());

  /**
   * Handle paste events to detect and download remote images
   */
  const handlePaste = async (event: ClipboardEvent, view: EditorView) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return false;

    // Check if the pasted text is an image URL
    const imageUrlRegex =
      /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i;
    const isImageUrl = imageUrlRegex.test(text.trim());

    if (isImageUrl) {
      event.preventDefault();

      try {
        // Download the image and get the local path
        const localPath = await commands.downloadImage(props.path, text.trim());

        // Insert markdown image syntax with the local path
        const imageMarkdown = `![image](${localPath})`;
        const { from } = view.state.selection.main;

        view.dispatch({
          changes: { from, insert: imageMarkdown },
          selection: { anchor: from + imageMarkdown.length },
        });

        return true;
      } catch (error) {
        console.error("Failed to download image:", error);
        // Fall back to inserting the URL as-is
        return false;
      }
    }

    return false;
  };

  /**
   * Custom backspace handler that deletes entire image lines
   */
  const handleBackspace = (view: EditorView): boolean => {
    const { from, to } = view.state.selection.main;

    // Only handle when cursor is at a single position (not a selection)
    if (from !== to) {
      return false; // Let default handler deal with selections
    }

    const line = view.state.doc.lineAt(from);
    const lineText = line.text.trim();

    // Check if the current line is an image
    const imageRegex = /^!\[([^\]]*)\]\(([^)]+)\)$/;
    const isImageLine = imageRegex.test(lineText);

    if (isImageLine) {
      // Delete the entire line including newline
      const deleteFrom = line.from;
      const deleteTo = line.to < view.state.doc.length ? line.to + 1 : line.to;

      view.dispatch({
        changes: { from: deleteFrom, to: deleteTo },
        selection: { anchor: deleteFrom },
      });

      return true;
    }

    // Check if we're at the start of a line and the previous line is an image
    if (from === line.from && line.number > 1) {
      const prevLine = view.state.doc.line(line.number - 1);
      const prevLineText = prevLine.text.trim();

      if (imageRegex.test(prevLineText)) {
        // Delete the previous line (the image)
        const deleteFrom = prevLine.from;
        const deleteTo = prevLine.to + 1; // Include the newline

        view.dispatch({
          changes: { from: deleteFrom, to: deleteTo },
          selection: { anchor: deleteFrom },
        });

        return true;
      }
    }

    return false; // Let default backspace handler work
  };

  // Create editor on mount
  onMount(() => {
    if (!editorContainer) return;

    const startState = EditorState.create({
      doc: props.content.content() || "",
      extensions: [
        // Basic extensions
        history(),

        // Keymaps - custom backspace before default keymaps
        keymap.of([
          { key: "Backspace", run: handleBackspace },
          ...defaultKeymap,
          ...historyKeymap,
        ]),

        // Markdown support
        markdown(),

        // Syntax highlighting
        syntaxHighlighting(defaultHighlightStyle),

        // Live preview
        livePreview(),

        // Search
        searchPanel(),

        // Paste handler for image URLs
        EditorView.domEventHandlers({
          paste: (event, view) => handlePaste(event, view),
        }),

        // Update callback
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            props.content.setContent(newContent);
            autoSave.scheduleAutoSave(newContent);
          }
        }),
      ],
    });

    editorView = new EditorView({
      state: startState,
      parent: editorContainer,
    });

    // Set the initial note path
    editorView.dispatch({
      effects: setNotePathEffect.of(props.path),
    });
  });

  // Update editor content and note path when path changes
  createEffect(() => {
    if (!editorView) return;

    // Update the note path in the editor state
    editorView.dispatch({
      effects: setNotePathEffect.of(props.path),
    });

    // When path changes, update the editor content
    const currentContent = editorView.state.doc.toString();
    const newContent = props.content.content();
    if (newContent !== currentContent) {
      editorView.dispatch({
        changes: {
          from: 0,
          to: editorView.state.doc.length,
          insert: newContent,
        },
      });
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (editorView) {
      editorView.destroy();
      editorView = undefined;
    }
  });

  return (
    <div class="cm-editor-wrapper flex h-full flex-col">
      {/* Editor container */}
      <div
        ref={editorContainer}
        class="cm-editor-container flex-1 overflow-auto p-5 pt-0 pb-8"
      />
    </div>
  );
};
