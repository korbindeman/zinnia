// Tauri command bindings for notes API
import { invoke } from "@tauri-apps/api/core";
import type { Note, NoteMetadata } from "../types";

export type RankingMode = "visits" | "frecency";

export const commands = {
  createNote: (path: string) => invoke<Note>("create_note", { path }),

  getNote: (path: string) => invoke<Note>("get_note", { path }),

  saveNote: (path: string, content: string) =>
    invoke<void>("save_note", { path, content }),

  deleteNote: (path: string) => invoke<void>("delete_note", { path }),

  renameNote: (oldPath: string, newPath: string) =>
    invoke<void>("rename_note", { oldPath, newPath }),

  getChildren: (path: string) =>
    invoke<NoteMetadata[]>("get_children", { path }),

  hasChildren: (path: string) => invoke<boolean>("has_children", { path }),

  getAncestors: (path: string) =>
    invoke<NoteMetadata[]>("get_ancestors", { path }),

  getRootNotes: () => invoke<NoteMetadata[]>("get_root_notes"),

  getAllNotes: () => invoke<NoteMetadata[]>("get_all_notes"),

  fuzzySearchNotes: (
    query: string,
    limit?: number,
    rankingMode?: RankingMode,
  ) =>
    invoke<NoteMetadata[]>("fuzzy_search_notes", {
      query,
      limit,
      rankingMode: rankingMode || "visits",
    }),

  searchNotes: (query: string) =>
    invoke<NoteMetadata[]>("search_notes", { query }),

  archiveNote: (path: string) => invoke<void>("archive_note", { path }),

  unarchiveNote: (path: string) => invoke<void>("unarchive_note", { path }),

  trashNote: (path: string) => invoke<void>("trash_note", { path }),

  downloadImage: (notePath: string, imageUrl: string) =>
    invoke<string>("download_image", { notePath, imageUrl }),

  resolveImagePath: (notePath: string, imagePath: string) =>
    invoke<string>("resolve_image_path", { notePath, imagePath }),
};
