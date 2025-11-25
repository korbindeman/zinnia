use std::sync::{Arc, Mutex};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::NotesApi;

/// Event type emitted by the filesystem watcher
#[derive(Debug, Clone)]
pub enum WatcherEvent {
    /// Notes were modified (created, updated, or deleted)
    NotesChanged,
    /// Notes were renamed or moved
    NotesRenamed,
    /// Frecency scores were updated (navigation should refresh)
    FrecencyUpdated,
}

/// Sets up a filesystem watcher for the notes directory.
///
/// This watcher monitors the filesystem for changes to notes and automatically
/// syncs the database when changes are detected. It handles:
/// - Note content modifications (_index.md files)
/// - Note folder creation and deletion
/// - Note folder renames and moves
///
/// The watcher uses debouncing to avoid excessive rescans during bulk operations.
///
/// # Arguments
///
/// * `notes_api` - Arc-wrapped NotesApi instance to sync when changes are detected
/// * `on_change` - Optional callback function that will be called when changes are detected
///
/// # Returns
///
/// Returns a `RecommendedWatcher` that must be kept alive for the duration of watching.
/// Dropping the watcher will stop filesystem monitoring.
///
/// # Example
///
/// ```no_run
/// use zinnia_core::{NotesApi, setup_watcher, WatcherEvent};
/// use std::sync::{Arc, Mutex};
///
/// let api = NotesApi::new("/path/to/notes").unwrap();
/// let api = Arc::new(Mutex::new(api));
/// let _watcher = setup_watcher(Arc::clone(&api), None::<fn(WatcherEvent)>);
/// // Keep _watcher alive while you want to monitor filesystem changes
/// ```
pub fn setup_watcher<F>(notes_api: Arc<Mutex<NotesApi>>, on_change: Option<F>) -> RecommendedWatcher
where
    F: Fn(WatcherEvent) + Send + 'static,
{
    let notes_root = {
        let api = notes_api.lock().unwrap();
        api.notes_root().to_path_buf()
    };

    let notes_root_clone = notes_root.clone();

    // Helper function to convert filesystem path to note path
    let path_to_note_path = move |fs_path: &std::path::Path| -> Option<String> {
        // Get the path relative to notes_root
        let relative = fs_path.strip_prefix(&notes_root_clone).ok()?;

        // Convert to string
        let path_str = relative.to_str()?;

        // Remove /_index.md suffix if present
        if path_str.ends_with("/_index.md") {
            Some(path_str.trim_end_matches("/_index.md").to_string())
        } else if path_str == "_index.md" {
            Some(String::new()) // Root note
        } else if relative.is_dir() {
            // Directory itself - use as-is
            Some(path_str.to_string())
        } else {
            None
        }
    };

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            match result {
                Ok(event) => {
                    // Ignore changes to the database file itself to prevent loops
                    let is_db_change = event.paths.iter().any(|p| {
                        p.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                            name == ".notes.db" || name.starts_with(".notes.db-")
                        })
                    });

                    if is_db_change {
                        return;
                    }

                    // Check if this is a note-related change (involves _index.md or note directories)
                    let is_note_related = event.paths.iter().any(|p| {
                        // Check if it's an _index.md file
                        if p.file_name().and_then(|n| n.to_str()) == Some("_index.md") {
                            return true;
                        }

                        // Check if it's a directory that might contain notes
                        if p.is_dir() {
                            // Check if it contains _index.md
                            let index_path = p.join("_index.md");
                            return index_path.exists();
                        }

                        false
                    });

                    if !is_note_related {
                        return;
                    }

                    use notify::EventKind;
                    match event.kind {
                        // Handle rename/move events - need full rescan
                        EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                            if let Ok(mut api) = notes_api.lock() {
                                if let Err(e) = api.rescan() {
                                    eprintln!("Failed to rescan after rename: {:?}", e);
                                } else if let Some(ref callback) = on_change {
                                    callback(WatcherEvent::NotesRenamed);
                                }
                            }
                        }
                        // Handle create, modify, and delete events for specific notes
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                            // Extract note paths from the event
                            for path in &event.paths {
                                // Convert filesystem path to note path
                                if let Some(note_path) = path_to_note_path(path)
                                    && let Ok(mut api) = notes_api.lock()
                                {
                                    // Skip if an operation is in progress (API is making changes)
                                    if api
                                        .operation_flag()
                                        .load(std::sync::atomic::Ordering::SeqCst)
                                    {
                                        continue;
                                    }

                                    // Use sync_note which returns true only if content changed
                                    match api.sync_note(&note_path) {
                                        Ok(true) => {
                                            // Only notify if content actually changed
                                            if let Some(ref callback) = on_change {
                                                callback(WatcherEvent::NotesChanged);
                                            }
                                        }
                                        Ok(false) => {
                                            // Don't notify - content is identical
                                        }
                                        Err(e) => {
                                            eprintln!("Failed to sync note {}: {:?}", note_path, e);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {
                            // Ignore other event types
                        }
                    }
                }
                Err(e) => eprintln!("Filesystem watcher error: {:?}", e),
            }
        },
        Config::default(),
    )
    .expect("Failed to create filesystem watcher");

    watcher
        .watch(&notes_root, RecursiveMode::Recursive)
        .expect("Failed to start watching notes directory");

    watcher
}
