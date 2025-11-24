// SolidJS Context Provider for Notes API
import {
  createContext,
  useContext,
  createSignal,
  createResource,
  createMemo,
  onMount,
  onCleanup,
  type ParentProps,
  type Resource,
  type Accessor,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { commands } from "./commands";
import type { Note, NoteMetadata } from "../types";
import { setAppState } from "../utils/appState";

interface NotesContextValue {
  // Current note state
  currentNote: Resource<Note | undefined>;
  currentPath: Accessor<string>;
  setCurrentPath: (path: string) => void;

  // Navigation
  children: Resource<NoteMetadata[]>;
  ancestors: Resource<NoteMetadata[]>;
  rootNotes: Resource<NoteMetadata[]>;

  // History navigation
  canGoBack: Accessor<boolean>;
  canGoForward: Accessor<boolean>;
  goBack: () => void;
  goForward: () => void;

  // Search
  searchQuery: Accessor<string>;
  setSearchQuery: (query: string) => void;
  searchResults: Resource<NoteMetadata[]>;

  // Mutations
  createNote: (path: string) => Promise<Note>;
  saveNote: (path: string, content: string) => Promise<void>;
  deleteNote: (path: string) => Promise<void>;
  renameNote: (oldPath: string, newPath: string) => Promise<void>;
  archiveNote: (path: string) => Promise<void>;
  unarchiveNote: (path: string) => Promise<void>;

  // Refresh helpers
  refetchCurrent: () => void;
  refetchChildren: () => void;
  refetchAncestors: () => void;
  refetchRootNotes: () => void;
}

const NotesContext = createContext<NotesContextValue>();

export function NotesProvider(props: ParentProps) {
  // Current note path
  const [currentPath, setCurrentPathInternal] = createSignal("");

  // Navigation history
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);

  // Wrapper for setCurrentPath that tracks history
  const setCurrentPath = (path: string, skipHistory = false) => {
    // Don't add to history if we're navigating via back/forward
    if (!skipHistory) {
      const currentIndex = historyIndex();
      const currentHistory = history();

      // If we're in the middle of history, truncate forward history
      const newHistory = currentHistory.slice(0, currentIndex + 1);

      // Add new path to history
      newHistory.push(path);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }

    setCurrentPathInternal(path);

    // Save last opened note to app state (only if path is not empty)
    if (path) {
      setAppState("lastOpenedNote", path).catch((err) =>
        console.error("Failed to save last opened note:", err),
      );
    }
  };

  // History navigation helpers
  const canGoBack = () => historyIndex() > 0;
  const canGoForward = () => historyIndex() < history().length - 1;

  const goBack = () => {
    if (canGoBack()) {
      const newIndex = historyIndex() - 1;
      setHistoryIndex(newIndex);
      const path = history()[newIndex];
      setCurrentPathInternal(path);
    }
  };

  const goForward = () => {
    if (canGoForward()) {
      const newIndex = historyIndex() + 1;
      setHistoryIndex(newIndex);
      const path = history()[newIndex];
      setCurrentPathInternal(path);
    }
  };

  // Search state
  const [searchQuery, setSearchQuery] = createSignal("");

  // Resources for data fetching
  const [currentNote, { refetch: refetchCurrent }] = createResource(
    currentPath,
    commands.getNote,
  );

  const [children, { refetch: refetchChildren }] = createResource(
    currentPath,
    commands.getChildren,
  );

  const [ancestors, { refetch: refetchAncestors }] = createResource(
    currentPath,
    commands.getAncestors,
  );

  const [rootNotes, { refetch: refetchRootNotes }] = createResource(
    commands.getRootNotes,
  );

  const [searchResults] = createResource(
    // Only fetch when query is not empty
    createMemo(() => {
      const query = searchQuery();
      return query.trim() ? query : null;
    }),
    (query) => commands.searchNotes(query),
  );

  // Mutation functions with automatic refetching
  const createNote = async (path: string) => {
    const note = await commands.createNote(path);
    refetchRootNotes();
    refetchChildren();
    return note;
  };

  const saveNote = async (path: string, content: string) => {
    await commands.saveNote(path, content);
    if (path === currentPath()) {
      refetchCurrent();
    }
  };

  const deleteNote = async (path: string) => {
    await commands.deleteNote(path);
    if (path === currentPath()) {
      setCurrentPath("");
    }
    refetchChildren();
    refetchRootNotes();
  };

  const renameNote = async (oldPath: string, newPath: string) => {
    await commands.renameNote(oldPath, newPath);
    if (currentPath() === oldPath) {
      setCurrentPath(newPath);
    }
    refetchChildren();
    refetchAncestors();
  };

  const archiveNote = async (path: string) => {
    await commands.archiveNote(path);
    refetchChildren();
    refetchCurrent();
  };

  const unarchiveNote = async (path: string) => {
    await commands.unarchiveNote(path);
    refetchChildren();
    refetchCurrent();
  };

  // Listen for filesystem watcher events from Tauri backend
  onMount(() => {
    let unlistenChanged: (() => void) | undefined;
    let unlistenRenamed: (() => void) | undefined;
    let unlistenFrecency: (() => void) | undefined;

    // Setup async listeners
    (async () => {
      // Listen for note changes (create, update, delete)
      // The backend now uses content hash comparison, so this event only fires
      // when content actually changes (not on our own saves with identical content)
      unlistenChanged = await listen("notes:changed", () => {
        console.log(
          "File watcher detected external changes, reloading current note...",
        );
        // Force reload by toggling the path
        const path = currentPath();
        if (path) {
          setCurrentPath("");
          // Use setTimeout to ensure the effect runs twice
          setTimeout(() => setCurrentPath(path), 0);
        }
      });

      // Listen for note renames/moves
      unlistenRenamed = await listen("notes:renamed", () => {
        console.log(
          "File watcher detected external rename/move, reloading current note...",
        );
        // Force reload by toggling the path
        const path = currentPath();
        if (path) {
          setCurrentPath("");
          setTimeout(() => setCurrentPath(path), 0);
        }
      });

      // Listen for frecency updates
      unlistenFrecency = await listen("notes:frecency", () => {
        // Refresh children and root notes to get updated order
        refetchChildren();
        refetchRootNotes();
      });
    })();

    // Cleanup listeners when component unmounts
    // Register cleanup synchronously before async work completes
    onCleanup(() => {
      unlistenChanged?.();
      unlistenRenamed?.();
      unlistenFrecency?.();
    });
  });

  const value: NotesContextValue = {
    currentNote,
    currentPath,
    setCurrentPath,
    children,
    ancestors,
    rootNotes,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    searchQuery,
    setSearchQuery,
    searchResults,
    createNote,
    saveNote,
    deleteNote,
    renameNote,
    archiveNote,
    unarchiveNote,
    refetchCurrent,
    refetchChildren,
    refetchAncestors,
    refetchRootNotes,
  };

  return (
    <NotesContext.Provider value={value}>
      {props.children}
    </NotesContext.Provider>
  );
}

export function useNotes() {
  const context = useContext(NotesContext);
  if (!context) {
    throw new Error("useNotes must be used within a NotesProvider");
  }
  return context;
}
