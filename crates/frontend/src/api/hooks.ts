// Additional reactive hooks for specific use cases
import {
  createResource,
  type Resource,
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  type Accessor,
  Setter,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "./commands";
import type { Note, NoteMetadata } from "../types";

/**
 * Hook to fetch a specific note by path
 */
export function useNote(path: () => string): Resource<Note | undefined> {
  const [note] = createResource(path, commands.getNote);
  return note;
}

/**
 * Hook to load and track note content
 * Returns the note content, loading state, and any errors
 */
export type NoteContent = {
  content: Accessor<string>;
  setContent: Setter<string>;
  isLoading: Accessor<boolean>;
  error: Accessor<Error | null>;
};

export function useNoteContent(path: Accessor<string | null>): NoteContent {
  const [content, setContent] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<Error | null>(null);

  createEffect(async () => {
    const notePath = path();

    if (!notePath) {
      setContent("");
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const note = await commands.getNote(notePath);
      setContent(note.content);
    } catch (err) {
      console.error("Failed to load note:", err);
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  });

  return { content, setContent, isLoading, error };
}

/**
 * Hook to handle autosaving with debounce
 * Tracks save state and provides manual save function
 */
export function useAutoSave(options: {
  getPath: Accessor<string | null>;
  getContent: Accessor<string>;
  delay?: number;
}) {
  const { getPath, getContent, delay = 1000 } = options;

  const [isSaving, setIsSaving] = createSignal(false);
  const [lastSavedContent, setLastSavedContent] = createSignal("");

  let debounceTimer: number | undefined;

  const performSave = async (path: string, content: string) => {
    if (!path) return;

    setIsSaving(true);
    try {
      await commands.saveNote(path, content);
      setLastSavedContent(content);
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const forceSave = async () => {
    const path = getPath();
    if (!path) return;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }

    await performSave(path, getContent());
  };

  const scheduleAutoSave = (content: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    const path = getPath();
    if (path && content !== lastSavedContent()) {
      debounceTimer = setTimeout(() => {
        performSave(path, content);
      }, delay) as unknown as number;
    }
  };

  const hasUnsavedChanges = () => getContent() !== lastSavedContent();

  // Update lastSavedContent when path changes and content loads
  createEffect(() => {
    const path = getPath();
    if (!path) {
      setLastSavedContent("");
    }
  });

  // Setup cleanup for debounce timer
  onMount(() => {
    onCleanup(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    });
  });

  return {
    isSaving,
    hasUnsavedChanges,
    forceSave,
    scheduleAutoSave,
    setLastSavedContent,
  };
}

/**
 * Hook to handle Cmd/Ctrl+S keyboard shortcut
 */
export function useSaveShortcut(onSave: () => void) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      onSave();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });
  });
}

/**
 * Hook to warn and save on window close if there are unsaved changes
 */
export function useUnsavedChangesWarning(
  hasUnsavedChanges: Accessor<boolean>,
  onSave: () => Promise<void>,
) {
  let unlisten: (() => void) | undefined;

  onMount(() => {
    // Setup listener async
    (async () => {
      const window = getCurrentWindow();
      unlisten = await window.onCloseRequested(async (event) => {
        if (hasUnsavedChanges()) {
          event.preventDefault();
          await onSave();
          await window.close();
        }
      });
    })();

    // Register cleanup synchronously
    onCleanup(() => {
      if (unlisten) {
        unlisten();
      }
    });
  });
}

/**
 * Hook to fetch children of a note
 */
export function useChildren(
  path: () => string,
): Resource<NoteMetadata[] | undefined> {
  const [children] = createResource(path, commands.getChildren);
  return children;
}

/**
 * Hook to fetch ancestors (breadcrumb trail) of a note
 */
export function useAncestors(
  path: () => string,
): Resource<NoteMetadata[] | undefined> {
  const [ancestors] = createResource(path, commands.getAncestors);
  return ancestors;
}

/**
 * Hook to fetch root-level notes
 */
export function useRootNotes(): Resource<NoteMetadata[] | undefined> {
  const [rootNotes] = createResource(commands.getRootNotes);
  return rootNotes;
}

/**
 * Hook to search notes
 */
export function useSearch(
  query: () => string | null,
): Resource<NoteMetadata[] | undefined> {
  const [results] = createResource(query, (q) => commands.searchNotes(q));
  return results;
}
