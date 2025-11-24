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
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { livePreview } from "./cm/livePreview3";
import { searchPanel } from "./cm/search";
import { useAutoSave } from "../../api/hooks";
import { NoteContent } from "../../api/hooks";
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

  // Create editor on mount
  onMount(() => {
    if (!editorContainer) return;

    const startState = EditorState.create({
      doc: props.content.content() || "",
      extensions: [
        // Basic extensions
        history(),

        // Keymaps
        keymap.of([...defaultKeymap, ...historyKeymap]),

        // Markdown support
        markdown(),

        // Syntax highlighting
        syntaxHighlighting(defaultHighlightStyle),

        // Live preview
        livePreview(),

        // Search
        searchPanel(),

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
  });

  // Update editor content when path changes
  createEffect(() => {
    if (!editorView) return;

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
