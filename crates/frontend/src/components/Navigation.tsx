import {
  createSignal,
  For,
  Show,
  createEffect,
  onMount,
  onCleanup,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { useNotes } from "../api";
import { commands } from "../api/commands";
import { getPathTitle } from "../utils/paths";
import { expandMacros } from "../utils/macros";
import { DropdownMenu } from "./ui/DropdownMenu";
import { useToast } from "./ui/Toast";
import type { NoteMetadata } from "../types";

function Breadcrumb(props: { item: NoteMetadata; isActive: boolean }) {
  const notes = useNotes();
  const toast = useToast();
  const [children, setChildren] = createSignal<NoteMetadata[]>([]);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [isEditing, setIsEditing] = createSignal(false);
  const [editTitle, setEditTitle] = createSignal("");

  // Listen for frecency updates
  onMount(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await listen("notes:frecency", () => {
        setRefreshKey((k) => k + 1);
      });
    })();

    onCleanup(() => {
      unlisten?.();
    });
  });

  createEffect(() => {
    refreshKey(); // Track refresh key
    commands.getChildren(props.item.path).then(setChildren);
  });

  const handleCreateNote = async () => {
    const newPath = `${props.item.path}/untitled`;
    try {
      await commands.createNote(newPath);
      notes.setCurrentPath(newPath);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to create note:", err);
      toast.error(`Failed to create note: ${err}`);
    }
  };

  const [inputRef, setInputRef] = createSignal<HTMLInputElement | null>(null);

  const handleClick = () => {
    if (props.isActive) {
      // Enter edit mode
      setEditTitle(getPathTitle(props.item.path));
      setIsEditing(true);
      inputRef()!.focus();
    } else {
      // Navigate
      notes.setCurrentPath(props.item.path);
    }
  };

  const handleRename = async () => {
    const expandedTitle = expandMacros(editTitle().trim());
    const newTitle = expandedTitle || "untitled";
    const currentTitle = getPathTitle(props.item.path);

    if (newTitle !== currentTitle) {
      const parentPath = props.item.path.split("/").slice(0, -1).join("/");
      const newPath = parentPath ? `${parentPath}/${newTitle}` : newTitle;

      try {
        await commands.renameNote(props.item.path, newPath);
        notes.setCurrentPath(newPath);
      } catch (err) {
        console.error("Failed to rename:", err);
        toast.error(`Failed to rename: ${err}`);
      }
    }
    setIsEditing(false);
  };

  return (
    <>
      <Show
        when={isEditing()}
        fallback={
          <button
            class={`hover:bg-button-hover rounded px-2 ${props.isActive ? "" : "opacity-60"}`}
            onClick={handleClick}
          >
            {getPathTitle(props.item.path)}
          </button>
        }
      >
        <input
          type="text"
          value={editTitle()}
          onInput={(e) => setEditTitle(e.currentTarget.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") setIsEditing(false);
          }}
          class="bg-transparent px-2 outline-none"
          ref={setInputRef}
        />
      </Show>
      <Show when={!isEditing()}>
        <Show
          when={children().length > 0}
          fallback={
            <button
              class="hover:bg-button-hover rounded px-2 opacity-60"
              onClick={handleCreateNote}
            >
              +
            </button>
          }
        >
          <DropdownMenu
            content={children()}
            path={props.item.path}
            onRefresh={() => setRefreshKey((k) => k + 1)}
            isActive={props.isActive}
          />
        </Show>
      </Show>
    </>
  );
}

function RootCrumb() {
  const [rootNotes, setRootNotes] = createSignal<NoteMetadata[]>([]);
  const [refreshKey, setRefreshKey] = createSignal(0);

  // Listen for frecency updates
  onMount(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await listen("notes:frecency", () => {
        setRefreshKey((k) => k + 1);
      });
    })();

    onCleanup(() => {
      unlisten?.();
    });
  });

  createEffect(() => {
    refreshKey(); // Track refresh key
    commands.getRootNotes().then(setRootNotes);
  });

  return (
    <DropdownMenu
      content={rootNotes()}
      path=""
      onRefresh={() => setRefreshKey((k) => k + 1)}
    />
  );
}

export function Navigation() {
  const notes = useNotes();
  const [items, setItems] = createSignal<NoteMetadata[]>([]);

  createEffect(() => {
    const path = notes.currentPath();
    if (path) {
      commands.getAncestors(path).then(setItems);
    } else {
      setItems([]);
    }
  });

  return (
    <div class="bg-background fixed top-0 left-0 z-10 w-full">
      <div class="h-6 w-full" data-tauri-drag-region></div>
      <nav class="flex h-8 w-full items-center px-4 pb-2 font-sans select-none">
        <div class="flex flex-1">
          <RootCrumb />
          <For each={items()}>
            {(item, index) => {
              const isActive = () => index() === items().length - 1;
              return <Breadcrumb item={item} isActive={isActive()} />;
            }}
          </For>
        </div>
      </nav>
    </div>
  );
}
