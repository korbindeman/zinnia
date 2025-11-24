import { createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { useNotes } from "../../api";
import { commands } from "../../api/commands";
import { InputModal } from "./InputModal";
import { NoteFinder } from "./NoteFinder";
import { MenuPanel } from "./MenuPanel";
import { useToast } from "./Toast";
import type { NoteMetadata } from "../../types";
import type { MenuItem } from "./ContextMenu";
import { ContextMenuContainer } from "./ContextMenu";

interface PanelState {
  parentPath: string;
  items: NoteMetadata[];
  left: number;
  top: number;
}

interface DropdownMenuProps {
  content: NoteMetadata[];
  path: string;
  onRefresh?: () => void;
  isActive?: boolean;
}

export function DropdownMenu(props: DropdownMenuProps) {
  let buttonRef: HTMLButtonElement | undefined;
  let dialogRef: HTMLDialogElement | undefined;

  const notes = useNotes();
  const toast = useToast();
  const [showModal, setShowModal] = createSignal(false);
  const [createAtPath, setCreateAtPath] = createSignal("");
  const [showNoteFinder, setShowNoteFinder] = createSignal(false);
  const [noteToMove, setNoteToMove] = createSignal<string | null>(null);
  const [openPanels, setOpenPanels] = createSignal<PanelState[]>([]);
  const [childrenCache, setChildrenCache] = createSignal(
    new Map<string, NoteMetadata[]>(),
  );
  const [hasChildrenMap, setHasChildrenMap] = createSignal<
    Record<string, boolean>
  >({});
  const [contextMenu, setContextMenu] = createSignal<{
    items: MenuItem[];
    x: number;
    y: number;
    notePath: string;
  } | null>(null);

  // Listen for frecency updates and clear cache
  onMount(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await listen("notes:frecency", () => {
        // Clear cache to force refetch with new order
        setChildrenCache(new Map());
        // Trigger refresh if callback provided
        if (props.onRefresh) {
          props.onRefresh();
        }
      });
    })();

    onCleanup(() => {
      unlisten?.();
    });
  });

  // Track refs for positioning
  const panelRefs = new Map<number, HTMLDivElement>();
  const rowRefs = new Map<string, HTMLButtonElement>();

  const setPanelRef = (level: number, el: HTMLDivElement | undefined) => {
    if (el) {
      panelRefs.set(level, el);
    } else {
      panelRefs.delete(level);
    }
  };

  const setRowRef = (path: string, el: HTMLButtonElement | undefined) => {
    if (el) {
      rowRefs.set(path, el);
    } else {
      rowRefs.delete(path);
    }
  };

  const handleClick = () => {
    if (dialogRef && buttonRef) {
      const rect = buttonRef.getBoundingClientRect();
      dialogRef.style.top = `${rect.top}px`;
      dialogRef.style.left = `${rect.left}px`;
      dialogRef.showModal();

      // Initialize root panel
      setOpenPanels([
        {
          parentPath: props.path,
          items: props.content,
          left: 0,
          top: 0,
        },
      ]);

      // Preload hasChildren for root items
      loadHasChildrenForItems(props.content);
    }
  };

  const handleDialogClick = (e: MouseEvent) => {
    if (e.target === dialogRef) {
      dialogRef?.close();
      setOpenPanels([]);
    }
  };

  const loadHasChildrenForItems = async (items: NoteMetadata[]) => {
    const map = { ...hasChildrenMap() };
    await Promise.all(
      items.map(async (item) => {
        try {
          const hasChildren = await commands.hasChildren(item.path);
          map[item.path] = hasChildren;
        } catch (err) {
          console.error("Failed to check children:", err);
          map[item.path] = false;
        }
      }),
    );
    setHasChildrenMap(map);
  };

  const ensureChildrenLoaded = async (parentPath: string) => {
    const cache = childrenCache();
    if (!cache.has(parentPath)) {
      try {
        const items = await commands.getChildren(parentPath);
        cache.set(parentPath, items);
        setChildrenCache(new Map(cache));
        // Preload hasChildren for these items
        loadHasChildrenForItems(items);
      } catch (err) {
        console.error("Failed to load children:", err);
      }
    }
  };

  const computeSubmenuPosition = (
    parentLevel: number,
    itemPath: string,
  ): { left: number; top: number } => {
    if (!dialogRef) return { left: 0, top: 0 };

    const dialogRect = dialogRef.getBoundingClientRect();
    const parentPanelEl = panelRefs.get(parentLevel);
    const rowEl = rowRefs.get(itemPath);

    if (!parentPanelEl || !rowEl) return { left: 0, top: 0 };

    const panelRect = parentPanelEl.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();

    // Measure paddings to align titles precisely
    const parentRowStyles = getComputedStyle(rowEl);
    const parentRowPaddingTop = parseFloat(parentRowStyles.paddingTop) || 0;

    const panelStyles = getComputedStyle(parentPanelEl);
    const panelPaddingTop = parseFloat(panelStyles.paddingTop) || 0;

    // Child rows share the same class/padding as parent rows
    const childRowPaddingTop = parentRowPaddingTop;

    // Overlap by 1px to avoid double-width border seam
    const left = Math.round(
      panelRect.left + panelRect.width - dialogRect.left - 1,
    );

    // Align the first child title with the hovered parent title
    const top = Math.round(
      rowRect.top +
        parentRowPaddingTop -
        (dialogRect.top + panelPaddingTop + childRowPaddingTop) -
        1,
    );

    return { left, top };
  };

  const handleHoverItem = async (level: number, note: NoteMetadata) => {
    // Check if note has children
    const hasChildren = hasChildrenMap()[note.path];

    if (!hasChildren) {
      // Trim deeper panels
      setOpenPanels((panels) => panels.slice(0, level + 1));
      return;
    }

    // Load children if needed
    await ensureChildrenLoaded(note.path);

    const cache = childrenCache();
    const items = cache.get(note.path);

    if (!items || items.length === 0) {
      // No children after all, trim panels
      setOpenPanels((panels) => panels.slice(0, level + 1));
      return;
    }

    // Compute position for submenu
    const pos = computeSubmenuPosition(level, note.path);

    // Add/replace submenu panel
    setOpenPanels((panels) => {
      const next = panels.slice(0, level + 1);
      next.push({
        parentPath: note.path,
        items,
        left: pos.left,
        top: pos.top,
      });
      return next;
    });
  };

  const handleClickItem = (item: NoteMetadata) => {
    notes.setCurrentPath(item.path);
    dialogRef?.close();
    setOpenPanels([]);
  };

  const handleArchiveItem = async (item: NoteMetadata) => {
    const itemPath = item.path;
    const wasCurrentNote = notes.currentPath() === itemPath;
    const parentPath = itemPath.split("/").slice(0, -1).join("/");

    // Calculate archived path for undo
    const archivedPath = parentPath
      ? `${parentPath}/_archive/${itemPath.split("/").pop()}`
      : `_archive/${itemPath}`;

    try {
      await commands.archiveNote(itemPath);

      if (wasCurrentNote) {
        const segments = itemPath.split("/");
        segments.pop();
        notes.setCurrentPath(segments.join("/"));
      }

      // Invalidate cache for parent
      const cache = childrenCache();
      cache.delete(parentPath);
      setChildrenCache(new Map(cache));

      // Clear hasChildren for this item
      const map = { ...hasChildrenMap() };
      delete map[itemPath];
      setHasChildrenMap(map);

      props.onRefresh?.();

      toast.success("Note archived", {
        duration: "long",
        onUndo: async () => {
          try {
            await commands.unarchiveNote(archivedPath);

            // Invalidate cache to refresh
            const cache = childrenCache();
            cache.delete(parentPath);
            setChildrenCache(new Map(cache));

            props.onRefresh?.();

            // Restore as current note if it was current before
            if (wasCurrentNote) {
              notes.setCurrentPath(itemPath);
            }

            toast.success("Note restored", { duration: "short" });
          } catch (err) {
            console.error("Failed to unarchive:", err);
            toast.error(`Failed to undo: ${err}`);
          }
        },
      });
    } catch (err) {
      console.error("Failed to archive:", err);
      toast.error(`Failed to archive: ${err}`);
    }
  };

  const handleTrashItem = async (item: NoteMetadata) => {
    const itemPath = item.path;
    const wasCurrentNote = notes.currentPath() === itemPath;
    const parentPath = itemPath.split("/").slice(0, -1).join("/");

    try {
      await commands.trashNote(itemPath);

      if (wasCurrentNote) {
        const segments = itemPath.split("/");
        segments.pop();
        notes.setCurrentPath(segments.join("/"));
      }

      // Invalidate cache for parent
      const cache = childrenCache();
      cache.delete(parentPath);
      setChildrenCache(new Map(cache));

      // Clear hasChildren for this item
      const map = { ...hasChildrenMap() };
      delete map[itemPath];
      setHasChildrenMap(map);

      props.onRefresh?.();

      toast.success("Note moved to trash", { duration: "short" });
    } catch (err) {
      console.error("Failed to trash note:", err);
      toast.error(`Failed to trash: ${err}`);
    }
  };

  const handleCreateChild = async (parentPath: string) => {
    setCreateAtPath(parentPath);
    setShowModal(true);
    dialogRef?.close();
    setOpenPanels([]);
  };

  const handleContextMenu = (
    e: MouseEvent,
    note: NoteMetadata,
    items: MenuItem[],
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      items,
      x: e.clientX,
      y: e.clientY,
      notePath: note.path,
    });
  };

  const createContextMenuItems = (note: NoteMetadata): MenuItem[] => {
    return [
      {
        label: "Move",
        onClick: () => {
          handleMoveNote(note.path);
        },
      },
      { separator: true },
      {
        label: "Archive",
        onClick: () => {
          handleArchiveItem(note);
        },
      },
      {
        label: "Trash",
        onClick: () => {
          handleTrashItem(note);
        },
      },
    ];
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleMoveNote = (notePath: string) => {
    setNoteToMove(notePath);
    setShowNoteFinder(true);
    dialogRef?.close();
    setOpenPanels([]);
  };

  const handleMoveToDestination = async (destination: NoteMetadata) => {
    const sourceNotePath = noteToMove();
    if (!sourceNotePath) return;

    const noteTitle = sourceNotePath.split("/").pop();
    if (!noteTitle) return;

    const newPath = destination.path
      ? `${destination.path}/${noteTitle}`
      : noteTitle;

    // Prevent moving to itself
    if (sourceNotePath === newPath) {
      toast.error("Cannot move note to itself");
      return;
    }

    // Prevent moving to a descendant
    if (newPath.startsWith(sourceNotePath + "/")) {
      toast.error("Cannot move note to its own descendant");
      return;
    }

    try {
      await commands.renameNote(sourceNotePath, newPath);

      // Invalidate cache for both old and new parents
      const cache = childrenCache();
      const oldParent = sourceNotePath.split("/").slice(0, -1).join("/");
      const newParent = destination.path;
      cache.delete(oldParent);
      cache.delete(newParent);
      setChildrenCache(new Map(cache));

      // Update current path if the moved note was selected
      if (notes.currentPath() === sourceNotePath) {
        notes.setCurrentPath(newPath);
      }

      props.onRefresh?.();
      toast.success("Note moved", { duration: "short" });
    } catch (err) {
      console.error("Failed to move note:", err);
      toast.error(`Failed to move: ${err}`);
    }
  };

  const createNewNote = async (title: string) => {
    const basePath = createAtPath();
    const newPath = basePath ? `${basePath}/${title}` : title;
    try {
      const newNote = await commands.createNote(newPath);
      setShowModal(false);

      // Invalidate cache for the parent where the note was created
      const cache = childrenCache();
      cache.delete(basePath);
      setChildrenCache(new Map(cache));

      notes.setCurrentPath(newNote.path);
      props.onRefresh?.();
    } catch (err) {
      console.error("Failed to create note:", err);
      toast.error(`Failed to create note: ${err}`);
    }
  };

  return (
    <>
      <InputModal
        open={showModal()}
        onSubmit={createNewNote}
        placeholder="untitled"
        onClose={() => setShowModal(false)}
      />
      <NoteFinder
        open={showNoteFinder()}
        onSelect={handleMoveToDestination}
        onClose={() => setShowNoteFinder(false)}
        placeholder="Move to..."
        excludePath={noteToMove()}
        rankBy="frecency"
      />
      <button
        ref={buttonRef}
        class={`hover:bg-button-hover rounded px-0.5 font-mono ${props.isActive ? "" : "opacity-60"}`}
        onClick={handleClick}
        onMouseDown={() => {
          // Close context menu when clicking outside
          if (contextMenu()) {
            handleCloseContextMenu();
          }
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          class="size-5"
        >
          <path
            fill-rule="evenodd"
            d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
      <dialog
        ref={dialogRef}
        class="relative overflow-visible border-none bg-transparent p-0 outline-none backdrop:bg-transparent"
        onClick={(e) => {
          handleDialogClick(e);
          handleCloseContextMenu();
        }}
        onMouseDown={(e) => {
          if (contextMenu() && e.target === dialogRef) {
            handleCloseContextMenu();
          }
        }}
      >
        <For each={openPanels()}>
          {(panel, index) => (
            <MenuPanel
              parentPath={panel.parentPath}
              items={panel.items}
              left={panel.left}
              top={panel.top}
              level={index()}
              hasChildrenMap={hasChildrenMap()}
              onHoverItem={handleHoverItem}
              onClickItem={handleClickItem}
              onArchiveItem={handleArchiveItem}
              onCreateChild={handleCreateChild}
              setPanelRef={setPanelRef}
              setRowRef={setRowRef}
              onContextMenu={handleContextMenu}
              contextMenuNotePath={contextMenu()?.notePath}
              createContextMenuItems={createContextMenuItems}
            />
          )}
        </For>
        <Show when={contextMenu()}>
          {(menu) => (
            <ContextMenuContainer
              x={menu().x}
              y={menu().y}
              items={menu().items}
              onItemClick={(item) => {
                if (!item.disabled) {
                  item.onClick();
                  handleCloseContextMenu();
                }
              }}
            />
          )}
        </Show>
      </dialog>
    </>
  );
}
