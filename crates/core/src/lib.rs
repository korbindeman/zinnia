pub mod default_paths;
pub mod filesystem;
pub mod migrations;
pub mod notes;
pub mod watcher;

// Re-export main types for convenience
pub use default_paths::get_default_notes_path;
pub use filesystem::{FSNoteMetadata, NoteFilesystem};
pub use migrations::cleanup_br_tags;
pub use notes::{Error, Note, NoteMetadata, NotesApi, RankingMode, Result};
pub use watcher::{WatcherEvent, setup_watcher};
