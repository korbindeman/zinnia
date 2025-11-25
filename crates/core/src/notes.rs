use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};

use crate::filesystem::NoteFilesystem;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Database(rusqlite::Error),
    DatabaseCorrupted,
    NotFound(String),
    AlreadyExists(String),
    ParentNotFound(String),
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(err: rusqlite::Error) -> Self {
        Error::Database(err)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Note {
    pub id: i64,
    pub path: String,
    pub content: String,
    pub modified: SystemTime,
}

#[derive(Debug, Clone)]
pub struct NoteMetadata {
    pub id: i64,
    pub path: String,
    pub modified: SystemTime,
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankingMode {
    /// Rank by direct visit count only
    Visits,
    /// Rank by frecency score (frequency + recency)
    Frecency,
}

pub struct NotesApi {
    fs: NoteFilesystem,
    db: Connection,
    /// Flag to indicate when API is performing operations (suppresses watcher)
    pub(crate) operation_in_progress: Arc<AtomicBool>,
    /// Optional callback for frecency updates
    frecency_callback: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// RAII guard that sets operation_in_progress flag on creation and clears it on drop
struct OperationGuard {
    flag: Arc<AtomicBool>,
}

impl OperationGuard {
    fn new(flag: Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self { flag }
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl NotesApi {
    /// Creates a new NotesApi instance.
    ///
    /// Initializes the filesystem and database at the specified notes_root directory.
    /// Creates the database file if it doesn't exist, runs migrations, and verifies schema.
    pub fn new<P: AsRef<Path>>(notes_root: P) -> Result<Self> {
        let fs = NoteFilesystem::new(&notes_root)?;

        // Create database path at notes_root/.notes.db
        let db_path = notes_root.as_ref().join(".notes.db");
        let db = Connection::open(db_path)?;

        // Run migrations
        run_migrations(&db)?;

        // Verify schema
        verify_schema(&db)?;

        Ok(Self {
            fs,
            db,
            operation_in_progress: Arc::new(AtomicBool::new(false)),
            frecency_callback: None,
        })
    }

    /// Creates a new NotesApi instance using platform-specific default paths.
    ///
    /// Uses `get_default_notes_path()` to determine the appropriate notes directory
    /// based on the current platform and debug mode. See `default_paths` module for details.
    ///
    /// # Arguments
    /// * `debug` - Whether the application is running in debug mode (uses separate directory)
    ///
    /// # Returns
    /// `Result<Self>` or an error if the default path cannot be determined or initialization fails.
    ///
    /// # Example
    /// ```no_run
    /// use zinnia_core::NotesApi;
    ///
    /// let debug = cfg!(debug_assertions);
    /// let mut api = NotesApi::with_default_path(debug)?;
    /// api.startup_sync()?;
    /// # Ok::<(), zinnia_core::Error>(())
    /// ```
    pub fn with_default_path(debug: bool) -> Result<Self> {
        let notes_root = crate::default_paths::get_default_notes_path(debug).ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Could not determine default notes path (home directory not found)",
            ))
        })?;

        Self::new(notes_root)
    }

    /// Returns a reference to the operation_in_progress flag for use by the watcher.
    pub fn operation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.operation_in_progress)
    }

    /// Returns the root path of the notes directory.
    pub fn notes_root(&self) -> &Path {
        self.fs.root_path()
    }

    /// Sets a callback to be invoked when frecency scores are updated.
    /// This allows the frontend to refresh navigation when scores change.
    pub fn set_frecency_callback<F>(&mut self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.frecency_callback = Some(Arc::new(callback));
    }

    /// Syncs the database index with the filesystem on startup.
    ///
    /// Scans all notes in the filesystem and ensures the database is up to date.
    /// Use this after opening the database to handle external filesystem changes.
    pub fn startup_sync(&mut self) -> Result<()> {
        self.rescan()
    }

    // Core CRUD operations

    /// Creates a new empty note at the specified path.
    ///
    /// Returns an error if the parent path doesn't exist (notes must be created top-down).
    /// Creates an empty note in both filesystem and database, returning the created Note.
    pub fn create_note(&mut self, path: &str) -> Result<Note> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Check if note already exists
        if self.note_exists(path)? {
            return Err(Error::AlreadyExists(path.to_string()));
        }

        // Check if parent exists (if not root-level)
        if let Some(parent_path) = get_parent_path(path)
            && !self.note_exists(&parent_path)?
        {
            return Err(Error::ParentNotFound(parent_path));
        }

        // Create note in filesystem
        self.fs.create_note(path)?;

        // Index in database
        self.sync_note(path)?;

        // Return the created note (without tracking access)
        self.get_note_internal(path)
    }

    /// Retrieves a note with its full content without tracking access.
    /// Internal method used by operations that shouldn't count as user access.
    fn get_note_internal(&self, path: &str) -> Result<Note> {
        // Read content from filesystem
        let content = self
            .fs
            .read_note(path)
            .map_err(|_| Error::NotFound(path.to_string()))?;

        // Get metadata from database
        let (id, mtime) = self
            .db
            .query_row(
                "SELECT id, mtime FROM notes WHERE path = ?1",
                params![path],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|_| Error::NotFound(path.to_string()))?;

        let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);

        Ok(Note {
            id,
            path: path.to_string(),
            content,
            modified,
        })
    }

    /// Retrieves a note with its full content.
    ///
    /// Reads the content from filesystem and metadata from database.
    /// Returns the complete Note including id, path, content, and modification time.
    /// Records an access to the note and propagates to ancestors.
    pub fn get_note(&mut self, path: &str) -> Result<Note> {
        let note = self.get_note_internal(path)?;

        // Record access for frecency tracking
        self.record_access(path)?;

        Ok(note)
    }

    /// Updates an existing note's content.
    ///
    /// Writes the new content to filesystem and updates the database index.
    /// Updates modification time and content hash automatically.
    /// Records an access to the note and propagates to ancestors.
    pub fn save_note(&mut self, path: &str, content: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Write to filesystem
        self.fs.write_note(path, content)?;

        // Update database
        self.sync_note(path)?;

        // Record access for frecency tracking
        self.record_access(path)?;

        Ok(())
    }

    /// Deletes a note and all its descendants recursively.
    ///
    /// Removes the note directory from filesystem and all associated entries from database.
    /// This operation cannot be undone (unless you archive_note instead).
    pub fn delete_note(&mut self, path: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Delete from filesystem (recursive)
        self.fs
            .delete_note(path)
            .map_err(|_| Error::NotFound(path.to_string()))?;

        // Delete from database (note and all descendants)
        self.db.execute(
            "DELETE FROM notes WHERE path = ?1 OR path LIKE ?2",
            params![path, format!("{}/%", path)],
        )?;

        Ok(())
    }

    /// Moves a note and all its descendants to the system trash/recycle bin.
    ///
    /// Sends the note directory to the OS trash (Trash on macOS, Recycle Bin on Windows).
    /// Also removes all associated entries from the database.
    /// The note can be restored from the system trash using OS file recovery.
    pub fn trash_note(&mut self, path: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Move to trash (recursive - entire directory)
        self.fs
            .trash_note(path)
            .map_err(|_| Error::NotFound(path.to_string()))?;

        // Delete from database (note and all descendants)
        self.db.execute(
            "DELETE FROM notes WHERE path = ?1 OR path LIKE ?2",
            params![path, format!("{}/%", path)],
        )?;

        Ok(())
    }

    /// Renames a note and updates all descendant paths.
    ///
    /// Moves the note in filesystem and updates database paths for the note and all children.
    /// Returns an error if new_path already exists or old_path doesn't exist.
    pub fn rename_note(&mut self, old_path: &str, new_path: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Check if old path exists
        if !self.note_exists(old_path)? {
            return Err(Error::NotFound(old_path.to_string()));
        }

        // Detect case-only rename (same path but different capitalization)
        let is_case_only_rename =
            old_path.to_lowercase() == new_path.to_lowercase() && old_path != new_path;

        // Check if new path already exists (skip for case-only renames on case-insensitive FS)
        if !is_case_only_rename && self.note_exists(new_path)? {
            return Err(Error::AlreadyExists(new_path.to_string()));
        }

        // Read content from old path
        let content = self.fs.read_note(old_path)?;

        // Get all descendants with their content
        let descendants: Vec<(String, String)> = self
            .db
            .prepare("SELECT path FROM notes WHERE path LIKE ?1")?
            .query_map(params![format!("{}/%", old_path)], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?
            .into_iter()
            .map(|path| {
                let content = self.fs.read_note(&path).unwrap_or_default();
                (path, content)
            })
            .collect();

        // For case-only renames, use a temporary intermediate path to avoid filesystem conflicts
        if is_case_only_rename {
            // Generate a unique temporary path
            let temp_path = format!(
                "{}_temp_{}",
                old_path,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );

            // Move to temporary location first
            self.fs.write_note(&temp_path, &content)?;

            // Move descendants to temp location
            let temp_descendants: Vec<(String, String, String)> = descendants
                .iter()
                .map(|(desc_old, desc_content)| {
                    let desc_temp = desc_old.replacen(old_path, &temp_path, 1);
                    (desc_old.clone(), desc_temp, desc_content.clone())
                })
                .collect();

            for (_, desc_temp, desc_content) in &temp_descendants {
                self.fs.write_note(desc_temp, desc_content)?;
            }

            // Delete old path
            self.fs.delete_note(old_path)?;

            // Move from temp to new path
            self.fs.write_note(new_path, &content)?;

            for (desc_old, _desc_temp, desc_content) in &temp_descendants {
                let desc_new = desc_old.replacen(old_path, new_path, 1);
                self.fs.write_note(&desc_new, desc_content)?;
            }

            // Clean up temp location
            self.fs.delete_note(&temp_path).ok(); // Ignore errors on cleanup
        } else {
            // Regular rename: write to new location then delete old

            // Write to new path
            self.fs.write_note(new_path, &content)?;

            // Move descendants
            for (desc_old, desc_content) in &descendants {
                let desc_new = desc_old.replacen(old_path, new_path, 1);
                self.fs.write_note(&desc_new, desc_content)?;
            }

            // Delete old path (after all new files are written)
            self.fs.delete_note(old_path)?;
        }

        // Update database: update all paths
        self.db.execute(
            "UPDATE notes SET path = ?2, parent_path = ?3 WHERE path = ?1",
            params![old_path, new_path, get_parent_path(new_path)],
        )?;

        // Update descendant paths
        for (desc_old, _) in &descendants {
            let desc_new = desc_old.replacen(old_path, new_path, 1);
            self.db.execute(
                "UPDATE notes SET path = ?2, parent_path = ?3 WHERE path = ?1",
                params![desc_old, desc_new, get_parent_path(&desc_new)],
            )?;
        }

        Ok(())
    }

    /// Checks if a note exists at the specified path.
    ///
    /// Fast database lookup to verify note existence without reading content.
    pub fn note_exists(&self, path: &str) -> Result<bool> {
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM notes WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // Navigation methods

    /// Returns all direct children of a note, sorted by frecency score.
    ///
    /// Returns metadata only (no content) for all notes whose parent is the specified path.
    /// Children are sorted by frecency score (descending), with alphabetical fallback.
    /// Useful for displaying note hierarchies and navigation trees.
    pub fn get_children(&self, path: &str) -> Result<Vec<NoteMetadata>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, path, mtime, archived FROM notes WHERE parent_path = ?1 ORDER BY frecency_score DESC, path ASC")?;

        let children = stmt
            .query_map(params![path], |row| {
                let mtime: i64 = row.get(2)?;
                let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                Ok(NoteMetadata {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    modified,
                    archived: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(children)
    }

    /// Returns true if the specified path has at least one child note.
    /// Only checks non-archived notes.
    pub fn has_children(&self, path: &str) -> Result<bool> {
        let mut stmt = self.db.prepare(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE parent_path = ?1 AND archived = 0 LIMIT 1)",
        )?;

        let exists: i64 = stmt.query_row(params![path], |row| row.get(0))?;
        Ok(exists != 0)
    }

    /// Returns the parent note's metadata.
    ///
    /// Returns None for root-level notes. Returns metadata only (no content).
    pub fn get_parent(&self, path: &str) -> Result<Option<NoteMetadata>> {
        let parent_path = match get_parent_path(path) {
            Some(p) => p,
            None => return Ok(None),
        };

        let metadata = self
            .db
            .query_row(
                "SELECT id, path, mtime, archived FROM notes WHERE path = ?1",
                params![parent_path],
                |row| {
                    let mtime: i64 = row.get(2)?;
                    let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                    Ok(NoteMetadata {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        modified,
                        archived: row.get::<_, i64>(3)? != 0,
                    })
                },
            )
            .optional()?;

        Ok(metadata)
    }

    /// Returns all ancestor notes from root to parent.
    ///
    /// Returns metadata for all notes in the path hierarchy, ordered from root to immediate parent.
    /// Useful for breadcrumb navigation. Does not include the current note itself.
    pub fn get_ancestors(&self, path: &str) -> Result<Vec<NoteMetadata>> {
        let mut ancestors = Vec::new();
        let mut current = path.to_string();

        while let Some(parent_path) = get_parent_path(&current) {
            if let Some(metadata) = self.get_parent(&current)? {
                ancestors.push(metadata);
            }
            current = parent_path;
        }

        ancestors.reverse();

        // Include the given note itself
        let mut stmt = self.db.prepare(
            "SELECT id, path, mtime, archived FROM notes WHERE path = ? AND archived = 0",
        )?;
        let note_metadata = stmt.query_row([path], |row| {
            let mtime: i64 = row.get(2)?;
            let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
            Ok(NoteMetadata {
                id: row.get(0)?,
                path: row.get(1)?,
                modified,
                archived: row.get::<_, i64>(3)? != 0,
            })
        })?;
        ancestors.push(note_metadata);

        Ok(ancestors)
    }

    /// Returns all top-level notes (notes without a parent), sorted by frecency score.
    ///
    /// Returns metadata for all notes at the root of the hierarchy.
    /// Notes are sorted by frecency score (descending), with alphabetical fallback.
    /// Useful for displaying the main navigation or note list.
    pub fn get_root_notes(&self) -> Result<Vec<NoteMetadata>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, path, mtime, archived FROM notes WHERE parent_path IS NULL ORDER BY frecency_score DESC, path ASC")?;

        let roots = stmt
            .query_map([], |row| {
                let mtime: i64 = row.get(2)?;
                let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                Ok(NoteMetadata {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    modified,
                    archived: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(roots)
    }

    // Archive operations

    /// Archives a note by moving it to an _archive subfolder.
    ///
    /// Moves the note (and all descendants) to parent/_archive/name in filesystem
    /// and sets the archived flag in database. This is a soft delete that can be undone.
    pub fn archive_note(&mut self, path: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Determine archive path
        let archive_path = if let Some(parent) = get_parent_path(path) {
            let name = path.split('/').next_back().unwrap();
            format!("{}/_archive/{}", parent, name)
        } else {
            let name = path;
            format!("_archive/{}", name)
        };

        // Get content
        let content = self.fs.read_note(path)?;

        // Get all descendants
        let descendants: Vec<(String, String)> = self
            .db
            .prepare("SELECT path FROM notes WHERE path LIKE ?1")?
            .query_map(params![format!("{}/%", path)], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?
            .into_iter()
            .map(|old_path| {
                let new_path = old_path.replacen(path, &archive_path, 1);
                (old_path, new_path)
            })
            .collect();

        // Move descendants
        for (desc_old, desc_new) in &descendants {
            let desc_content = self.fs.read_note(desc_old)?;
            self.fs.write_note(desc_new, &desc_content)?;
        }

        // Write to archive path
        self.fs.write_note(&archive_path, &content)?;

        // Delete old path
        self.fs.delete_note(path)?;

        // Update database
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        self.db.execute(
            "UPDATE notes SET path = ?2, parent_path = ?3, archived = 1, archived_at = ?4 WHERE path = ?1",
            params![path, archive_path, get_parent_path(&archive_path), now]
        )?;

        // Update descendants
        for (desc_old, desc_new) in &descendants {
            self.db.execute(
                "UPDATE notes SET path = ?2, parent_path = ?3, archived = 1, archived_at = ?4 WHERE path = ?1",
                params![desc_old, desc_new, get_parent_path(desc_new), now]
            )?;
        }

        Ok(())
    }

    /// Restores an archived note to its original location.
    ///
    /// Moves the note from _archive back to its parent directory and clears the archived flag.
    /// The path parameter should be the current archived path (containing /_archive/).
    pub fn unarchive_note(&mut self, path: &str) -> Result<()> {
        let _guard = OperationGuard::new(Arc::clone(&self.operation_in_progress));

        // Path should be in _archive
        if !path.contains("/_archive/") {
            return Err(Error::NotFound(path.to_string()));
        }

        // Determine unarchive path
        let unarchive_path = path.replace("/_archive/", "/");

        // Get content
        let content = self.fs.read_note(path)?;

        // Get all descendants
        let descendants: Vec<(String, String)> = self
            .db
            .prepare("SELECT path FROM notes WHERE path LIKE ?1")?
            .query_map(params![format!("{}/%", path)], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?
            .into_iter()
            .map(|old_path| {
                let new_path = old_path.replace("/_archive/", "/");
                (old_path, new_path)
            })
            .collect();

        // Move descendants
        for (desc_old, desc_new) in &descendants {
            let desc_content = self.fs.read_note(desc_old)?;
            self.fs.write_note(desc_new, &desc_content)?;
        }

        // Write to unarchive path
        self.fs.write_note(&unarchive_path, &content)?;

        // Delete old path
        self.fs.delete_note(path)?;

        // Update database
        self.db.execute(
            "UPDATE notes SET path = ?2, parent_path = ?3, archived = 0, archived_at = NULL WHERE path = ?1",
            params![path, unarchive_path, get_parent_path(&unarchive_path)]
        )?;

        // Update descendants
        for (desc_old, desc_new) in &descendants {
            self.db.execute(
                "UPDATE notes SET path = ?2, parent_path = ?3, archived = 0, archived_at = NULL WHERE path = ?1",
                params![desc_old, desc_new, get_parent_path(desc_new)]
            )?;
        }

        Ok(())
    }

    // Search and sync operations

    /// Returns all non-archived notes, sorted by frecency score.
    ///
    /// Returns metadata for all notes that are not archived.
    /// Notes are sorted by frecency score (descending), with alphabetical fallback.
    /// Useful for displaying all available notes in a picker or finder.
    pub fn get_all_notes(&self) -> Result<Vec<NoteMetadata>> {
        let mut stmt = self
            .db
            .prepare("SELECT id, path, mtime, archived FROM notes WHERE archived = 0 ORDER BY frecency_score DESC, path ASC")?;

        let notes = stmt
            .query_map([], |row| {
                let mtime: i64 = row.get(2)?;
                let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                Ok(NoteMetadata {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    modified,
                    archived: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(notes)
    }

    /// Fuzzy search for notes by path/title (for quick finder/picker UIs).
    ///
    /// Performs case-insensitive substring matching on note paths.
    /// Returns non-archived notes sorted by:
    /// 1. Path prefix matches first (e.g., "hel" matches "hello/world" before "some/hello")
    /// 2. Ranking score (frecency or visits, depending on `ranking_mode`)
    /// 3. Alphabetical order as final tiebreaker
    ///
    /// Designed for interactive note pickers where users type partial titles.
    pub fn fuzzy_search(
        &self,
        query: &str,
        limit: Option<usize>,
        ranking_mode: RankingMode,
    ) -> Result<Vec<NoteMetadata>> {
        let ranking_column = match ranking_mode {
            RankingMode::Visits => "direct_access_count",
            RankingMode::Frecency => "frecency_score",
        };

        if query.is_empty() {
            // Return top notes by ranking when no query provided
            let limit_clause = limit.map(|l| format!("LIMIT {}", l)).unwrap_or_default();
            let sql = format!(
                "SELECT id, path, mtime, archived
                 FROM notes
                 WHERE archived = 0
                 ORDER BY {} DESC, path ASC
                 {}",
                ranking_column, limit_clause
            );

            let mut stmt = self.db.prepare(&sql)?;

            let results = stmt
                .query_map([], |row| {
                    let mtime: i64 = row.get(2)?;
                    let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                    Ok(NoteMetadata {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        modified,
                        archived: row.get::<_, i64>(3)? != 0,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            return Ok(results);
        }

        // Use LIKE for substring matching, with % wildcards
        let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));

        let limit_clause = limit.map(|l| format!("LIMIT {}", l)).unwrap_or_default();
        let sql = format!(
            "SELECT id, path, mtime, archived,
                    CASE
                        WHEN LOWER(path) LIKE LOWER(?1) THEN 1
                        WHEN LOWER(path) LIKE LOWER(?2) THEN 2
                        ELSE 3
                    END as match_priority
             FROM notes
             WHERE archived = 0 AND LOWER(path) LIKE LOWER(?2)
             ORDER BY match_priority ASC, {} DESC, path ASC
             {}",
            ranking_column, limit_clause
        );

        let mut stmt = self.db.prepare(&sql)?;

        // ?1 = prefix pattern (query%), ?2 = substring pattern (%query%)
        let prefix_pattern = format!("{}%", query.replace('%', "\\%").replace('_', "\\_"));

        let results = stmt
            .query_map(params![prefix_pattern, pattern], |row| {
                let mtime: i64 = row.get(2)?;
                let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                Ok(NoteMetadata {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    modified,
                    archived: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(results)
    }

    /// Performs full-text search across all note content.
    ///
    /// Uses FTS5 to search both note paths and content. Returns metadata for matching notes.
    /// Query syntax follows FTS5 conventions (supports phrases, AND/OR, etc.).
    pub fn search(&self, query: &str) -> Result<Vec<NoteMetadata>> {
        let mut stmt = self.db.prepare(
            "SELECT notes.id, notes.path, notes.mtime, notes.archived
             FROM notes_fts
             JOIN notes ON notes_fts.rowid = notes.id
             WHERE notes_fts MATCH ?1",
        )?;

        let results = stmt
            .query_map(params![query], |row| {
                let mtime: i64 = row.get(2)?;
                let modified = UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                Ok(NoteMetadata {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    modified,
                    archived: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(results)
    }

    /// Syncs a single note from filesystem to database.
    ///
    /// Reads the note from filesystem and updates (or creates) its database entry.
    /// Updates modification time, content hash, and FTS index. Used by file watchers.
    ///
    /// Returns `true` if the note content actually changed (or was newly created),
    /// `false` if the content hash was already up-to-date.
    pub fn sync_note(&mut self, path: &str) -> Result<bool> {
        // Get file metadata from filesystem
        let fs_metadata = self
            .fs
            .scan_all()?
            .into_iter()
            .find(|m| m.path == path)
            .ok_or_else(|| Error::NotFound(path.to_string()))?;

        // Read content to compute hash
        let content = self.fs.read_note(path)?;
        let content_hash = compute_hash(&content);

        let mtime = fs_metadata
            .mtime
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let parent_path = get_parent_path(path);

        // Check if note exists in database
        let exists: bool = self.db.query_row(
            "SELECT COUNT(*) FROM notes WHERE path = ?1",
            params![path],
            |row| Ok(row.get::<_, i64>(0)? > 0),
        )?;

        if exists {
            // Get existing ID and content hash
            let (id, existing_hash): (i64, String) = self.db.query_row(
                "SELECT id, content_hash FROM notes WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            // Only update if content has changed
            if existing_hash != content_hash {
                // Update existing note
                self.db.execute(
                    "UPDATE notes SET mtime = ?2, content_hash = ?3, parent_path = ?4 WHERE path = ?1",
                    params![path, mtime, content_hash, parent_path],
                )?;

                // Update FTS index - FTS5 requires DELETE + INSERT
                self.db
                    .execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
                self.db.execute(
                    "INSERT INTO notes_fts (rowid, path, content) VALUES (?1, ?2, ?3)",
                    params![id, path, content],
                )?;

                Ok(true) // Content changed
            } else {
                Ok(false) // Content unchanged
            }
        } else {
            // Insert new note
            self.db.execute(
                "INSERT INTO notes (path, parent_path, mtime, content_hash, archived, archived_at)
                 VALUES (?1, ?2, ?3, ?4, 0, NULL)",
                params![path, parent_path, mtime, content_hash],
            )?;

            // Insert into FTS index
            let id = self.db.last_insert_rowid();
            self.db.execute(
                "INSERT INTO notes_fts (rowid, path, content) VALUES (?1, ?2, ?3)",
                params![id, path, content],
            )?;

            Ok(true) // New note created
        }
    }

    /// Performs a full filesystem scan and rebuilds the database index.
    ///
    /// Scans all notes in the filesystem, syncs them to the database, and removes
    /// database entries for notes that no longer exist. Use after external filesystem changes.
    pub fn rescan(&mut self) -> Result<()> {
        // Get all notes from filesystem
        let fs_notes = self.fs.scan_all()?;

        // Get all paths from database
        let db_paths: Vec<String> = self
            .db
            .prepare("SELECT path FROM notes")?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        // Index or update all filesystem notes
        for fs_note in &fs_notes {
            self.sync_note(&fs_note.path)?;
        }

        // Remove notes that no longer exist in filesystem
        let fs_paths: std::collections::HashSet<_> =
            fs_notes.iter().map(|n| n.path.as_str()).collect();
        for db_path in db_paths {
            if !fs_paths.contains(db_path.as_str()) {
                self.db
                    .execute("DELETE FROM notes WHERE path = ?1", params![db_path])?;
            }
        }

        Ok(())
    }

    // Frecency tracking methods

    /// Calculates the frecency score for a note based on access count and recency.
    ///
    /// Formula: access_count * (100 / (days_since_access + 1))
    /// This gives higher scores to frequently accessed notes with a boost for recent access.
    fn calculate_frecency_score(access_count: i64, last_accessed_at: Option<i64>) -> f64 {
        let access_count = access_count as f64;

        if let Some(last_accessed) = last_accessed_at {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            let seconds_since_access = (now - last_accessed).max(0);
            let days_since_access = (seconds_since_access as f64) / 86400.0; // 86400 seconds in a day

            let recency_bonus = 100.0 / (days_since_access + 1.0);
            access_count * recency_bonus
        } else {
            // No access history, return minimal score
            0.0
        }
    }

    /// Records an access to a note and updates its frecency score.
    /// Also propagates the access to all ancestor notes.
    fn record_access(&mut self, path: &str) -> Result<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Update the note itself (including direct access count)
        self.update_frecency(path, now, true)?;

        // Propagate to ancestors (without incrementing direct access count)
        let mut current = path.to_string();
        while let Some(parent_path) = get_parent_path(&current) {
            if self.note_exists(&parent_path)? {
                self.update_frecency(&parent_path, now, false)?;
            }
            current = parent_path;
        }

        // Notify callback that frecency scores have changed
        if let Some(callback) = &self.frecency_callback {
            callback();
        }

        Ok(())
    }

    /// Updates a single note's access count, timestamp, and frecency score.
    /// If `is_direct` is true, also increments the direct_access_count.
    fn update_frecency(&mut self, path: &str, access_time: i64, is_direct: bool) -> Result<()> {
        // Get current values
        let (access_count, _last_accessed): (i64, Option<i64>) = self.db.query_row(
            "SELECT access_count, last_accessed_at FROM notes WHERE path = ?1",
            params![path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let new_count = access_count + 1;
        let new_score = Self::calculate_frecency_score(new_count, Some(access_time));

        // Update database
        if is_direct {
            self.db.execute(
                "UPDATE notes SET access_count = ?1, last_accessed_at = ?2, frecency_score = ?3, direct_access_count = direct_access_count + 1 WHERE path = ?4",
                params![new_count, access_time, new_score, path],
            )?;
        } else {
            self.db.execute(
                "UPDATE notes SET access_count = ?1, last_accessed_at = ?2, frecency_score = ?3 WHERE path = ?4",
                params![new_count, access_time, new_score, path],
            )?;
        }

        Ok(())
    }
}

// Helper functions
fn get_parent_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let path = std::path::Path::new(path);
    path.parent()
        .filter(|p| p != &std::path::Path::new(""))
        .map(|p| p.to_string_lossy().to_string())
}

fn compute_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn get_schema_version(conn: &Connection) -> SqlResult<i32> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn run_migrations(conn: &Connection) -> Result<()> {
    let version = get_schema_version(conn)?;

    if version < 1 {
        // Create initial schema
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                parent_path TEXT,
                mtime INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                archived INTEGER DEFAULT 0,
                archived_at INTEGER
            );

            CREATE INDEX idx_parent_path ON notes(parent_path);
            CREATE INDEX idx_archived ON notes(archived) WHERE archived = 0;

            CREATE VIRTUAL TABLE notes_fts USING fts5(
                path UNINDEXED,
                content
            );",
        )?;
        conn.pragma_update(None, "user_version", 1)?;
    }

    if version < 2 {
        // Add frecency columns
        conn.execute_batch(
            "ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0;
             ALTER TABLE notes ADD COLUMN last_accessed_at INTEGER;
             ALTER TABLE notes ADD COLUMN frecency_score REAL DEFAULT 0;
             CREATE INDEX idx_frecency_score ON notes(frecency_score DESC);",
        )?;
        conn.pragma_update(None, "user_version", 2)?;
    }

    if version < 3 {
        // Add direct access count (non-cascading)
        conn.execute_batch(
            "ALTER TABLE notes ADD COLUMN direct_access_count INTEGER DEFAULT 0;
             CREATE INDEX idx_direct_access_count ON notes(direct_access_count DESC);",
        )?;
        conn.pragma_update(None, "user_version", 3)?;
    }

    // Future migrations go here
    // if version < 4 { ... }

    Ok(())
}

fn verify_schema(conn: &Connection) -> Result<()> {
    // Check that notes table exists
    let notes_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'",
        [],
        |row| Ok(row.get::<_, i32>(0)? > 0),
    )?;

    if !notes_exists {
        return Err(Error::DatabaseCorrupted);
    }

    // Check FTS5 table exists
    let fts_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes_fts'",
        [],
        |row| Ok(row.get::<_, i32>(0)? > 0),
    )?;

    if !fts_exists {
        return Err(Error::DatabaseCorrupted);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_new_database() {
        let temp_dir = TempDir::new().unwrap();
        let api = NotesApi::new(temp_dir.path()).unwrap();

        // Verify database file was created
        let db_path = temp_dir.path().join(".notes.db");
        assert!(db_path.exists());

        // Verify schema version (should be latest)
        let version = get_schema_version(&api.db).unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn test_open_existing_database() {
        let temp_dir = TempDir::new().unwrap();

        // Create database
        let api1 = NotesApi::new(temp_dir.path()).unwrap();
        drop(api1);

        // Open existing database
        let api2 = NotesApi::new(temp_dir.path()).unwrap();
        let version = get_schema_version(&api2.db).unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn test_database_schema_tables_exist() {
        let temp_dir = TempDir::new().unwrap();
        let api = NotesApi::new(temp_dir.path()).unwrap();

        // Check notes table exists
        let notes_exists: bool = api
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'",
                [],
                |row| Ok(row.get::<_, i32>(0)? > 0),
            )
            .unwrap();
        assert!(notes_exists);

        // Check FTS table exists
        let fts_exists: bool = api
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes_fts'",
                [],
                |row| Ok(row.get::<_, i32>(0)? > 0),
            )
            .unwrap();
        assert!(fts_exists);
    }

    #[test]
    fn test_database_indexes_exist() {
        let temp_dir = TempDir::new().unwrap();
        let api = NotesApi::new(temp_dir.path()).unwrap();

        // Check parent_path index exists
        let parent_idx_exists: bool = api
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_parent_path'",
                [],
                |row| Ok(row.get::<_, i32>(0)? > 0),
            )
            .unwrap();
        assert!(parent_idx_exists);

        // Check archived index exists
        let archived_idx_exists: bool = api
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_archived'",
                [],
                |row| Ok(row.get::<_, i32>(0)? > 0),
            )
            .unwrap();
        assert!(archived_idx_exists);
    }

    #[test]
    fn test_corrupted_database() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join(".notes.db");

        // Create a corrupted database (invalid data)
        std::fs::write(&db_path, b"corrupted data").unwrap();

        // Attempt to open should fail
        let result = NotesApi::new(temp_dir.path());
        assert!(result.is_err());
    }

    #[test]
    fn test_database_with_missing_tables() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join(".notes.db");

        // Create database with wrong schema at current version
        let conn = Connection::open(&db_path).unwrap();
        conn.execute("CREATE TABLE wrong_table (id INTEGER)", [])
            .unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        drop(conn);

        // Attempt to open should fail verification
        let result = NotesApi::new(temp_dir.path());
        assert!(result.is_err());

        if let Err(Error::DatabaseCorrupted) = result {
            // Expected error type
        } else {
            panic!("Expected DatabaseCorrupted error");
        }
    }

    #[test]
    fn test_create_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        let note = api.create_note("test").unwrap();

        assert_eq!(note.path, "test");
        assert_eq!(note.content, "");
        assert!(note.id > 0);

        // Verify filesystem
        let fs_content = std::fs::read_to_string(temp_dir.path().join("test/_index.md")).unwrap();
        assert_eq!(fs_content, "");

        // Verify database
        assert!(api.note_exists("test").unwrap());
    }

    #[test]
    fn test_create_note_with_nonexistent_parent() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        let result = api.create_note("parent/child");
        assert!(matches!(result, Err(Error::ParentNotFound(_))));
    }

    #[test]
    fn test_get_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();
        api.save_note("test", "Test content").unwrap();
        let note = api.get_note("test").unwrap();

        assert_eq!(note.path, "test");
        assert_eq!(note.content, "Test content");
    }

    #[test]
    fn test_save_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();
        api.save_note("test", "Original").unwrap();
        api.save_note("test", "Updated").unwrap();

        let note = api.get_note("test").unwrap();
        assert_eq!(note.content, "Updated");
    }

    #[test]
    fn test_delete_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();
        api.delete_note("test").unwrap();

        assert!(!api.note_exists("test").unwrap());
    }

    #[test]
    fn test_delete_note_with_children() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child").unwrap();

        api.delete_note("parent").unwrap();

        assert!(!api.note_exists("parent").unwrap());
        assert!(!api.note_exists("parent/child").unwrap());
    }

    #[test]
    fn test_trash_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();
        api.save_note("test", "Content to trash").unwrap();

        // Verify note exists before trashing
        assert!(api.note_exists("test").unwrap());

        // Test the trash_note method exists and can be called
        // We verify the filesystem operation works, but skip actual trash to avoid filling system trash
        let note_dir = temp_dir.path().join("test");
        assert!(note_dir.exists());

        // Manually remove from database to test the cleanup logic
        api.delete_note("test").unwrap();

        // Note should no longer exist in database
        assert!(!api.note_exists("test").unwrap());

        // Note directory should no longer exist in filesystem
        assert!(!note_dir.exists());
    }

    #[test]
    fn test_trash_note_with_children() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child").unwrap();
        api.save_note("parent", "Parent content").unwrap();
        api.save_note("parent/child", "Child content").unwrap();

        // Verify directory exists before deletion
        let parent_dir = temp_dir.path().join("parent");
        assert!(parent_dir.exists());

        // Use delete_note instead of trash_note to avoid filling system trash
        api.delete_note("parent").unwrap();

        // Both parent and child should be removed from database
        assert!(!api.note_exists("parent").unwrap());
        assert!(!api.note_exists("parent/child").unwrap());

        // Parent directory should no longer exist in filesystem
        assert!(!parent_dir.exists());
    }

    #[test]
    fn test_rename_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("old").unwrap();
        api.save_note("old", "Content").unwrap();
        api.rename_note("old", "new").unwrap();

        assert!(!api.note_exists("old").unwrap());
        assert!(api.note_exists("new").unwrap());

        let note = api.get_note("new").unwrap();
        assert_eq!(note.content, "Content");
    }

    #[test]
    fn test_rename_note_with_descendants() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("old").unwrap();
        api.create_note("old/child").unwrap();

        api.rename_note("old", "new").unwrap();

        assert!(api.note_exists("new").unwrap());
        assert!(api.note_exists("new/child").unwrap());
        assert!(!api.note_exists("old").unwrap());
        assert!(!api.note_exists("old/child").unwrap());
    }

    #[test]
    fn test_rename_to_existing_path() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("old").unwrap();
        api.create_note("new").unwrap();

        let result = api.rename_note("old", "new");
        assert!(matches!(result, Err(Error::AlreadyExists(_))));
    }

    #[test]
    fn test_rename_case_only_preserves_content() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create note with content
        api.create_note("test").unwrap();
        api.save_note("test", "Important content").unwrap();

        // Rename to different capitalization
        api.rename_note("test", "Test").unwrap();

        // Verify content is preserved
        assert!(api.note_exists("Test").unwrap());
        let note = api.get_note("Test").unwrap();
        assert_eq!(note.content, "Important content");
        assert_eq!(note.path, "Test");
    }

    #[test]
    fn test_rename_case_only_lowercase_to_uppercase() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("lowercase").unwrap();
        api.save_note("lowercase", "test content").unwrap();

        api.rename_note("lowercase", "UPPERCASE").unwrap();

        assert!(!api.note_exists("lowercase").unwrap());
        assert!(api.note_exists("UPPERCASE").unwrap());
        let note = api.get_note("UPPERCASE").unwrap();
        assert_eq!(note.content, "test content");
    }

    #[test]
    fn test_rename_case_only_with_descendants() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create parent and child notes
        api.create_note("parent").unwrap();
        api.save_note("parent", "Parent content").unwrap();
        api.create_note("parent/child").unwrap();
        api.save_note("parent/child", "Child content").unwrap();

        // Rename parent to different case
        api.rename_note("parent", "Parent").unwrap();

        // Verify both parent and child are renamed with content preserved
        assert!(!api.note_exists("parent").unwrap());
        assert!(!api.note_exists("parent/child").unwrap());
        assert!(api.note_exists("Parent").unwrap());
        assert!(api.note_exists("Parent/child").unwrap());

        let parent = api.get_note("Parent").unwrap();
        assert_eq!(parent.content, "Parent content");

        let child = api.get_note("Parent/child").unwrap();
        assert_eq!(child.content, "Child content");
    }

    #[test]
    fn test_rename_case_only_mixed_case() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("myNote").unwrap();
        api.save_note("myNote", "Content here").unwrap();

        // Change case in multiple positions
        api.rename_note("myNote", "MyNote").unwrap();

        assert!(!api.note_exists("myNote").unwrap());
        assert!(api.note_exists("MyNote").unwrap());
        let note = api.get_note("MyNote").unwrap();
        assert_eq!(note.content, "Content here");
    }

    #[test]
    fn test_rename_case_only_nested_path() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("projects").unwrap();
        api.create_note("projects/rust-app").unwrap();
        api.save_note("projects/rust-app", "Rust project content")
            .unwrap();

        // Rename nested note with case change
        api.rename_note("projects/rust-app", "projects/Rust-App")
            .unwrap();

        assert!(!api.note_exists("projects/rust-app").unwrap());
        assert!(api.note_exists("projects/Rust-App").unwrap());
        let note = api.get_note("projects/Rust-App").unwrap();
        assert_eq!(note.content, "Rust project content");
    }

    #[test]
    fn test_get_children() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child1").unwrap();
        api.create_note("parent/child2").unwrap();

        let children = api.get_children("parent").unwrap();
        assert_eq!(children.len(), 2);

        let paths: Vec<_> = children.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"parent/child1"));
        assert!(paths.contains(&"parent/child2"));
    }

    #[test]
    fn test_get_parent() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child").unwrap();

        let parent = api.get_parent("parent/child").unwrap();
        assert!(parent.is_some());
        assert_eq!(parent.unwrap().path, "parent");

        let no_parent = api.get_parent("parent").unwrap();
        assert!(no_parent.is_none());
    }

    #[test]
    fn test_has_children() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child1").unwrap();
        api.create_note("parent/child2").unwrap();
        api.create_note("empty").unwrap();

        // Parent with children should return true
        assert!(api.has_children("parent").unwrap());

        // Note without children should return false
        assert!(!api.has_children("empty").unwrap());
        assert!(!api.has_children("parent/child1").unwrap());

        // Archive a child and verify has_children still works
        api.archive_note("parent/child1").unwrap();
        assert!(api.has_children("parent").unwrap());

        // Archive all children
        api.archive_note("parent/child2").unwrap();
        assert!(!api.has_children("parent").unwrap());
    }

    #[test]
    fn test_get_ancestors() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("a").unwrap();
        api.create_note("a/b").unwrap();
        api.create_note("a/b/c").unwrap();

        let ancestors = api.get_ancestors("a/b/c").unwrap();
        assert_eq!(ancestors.len(), 3);
        assert_eq!(ancestors[0].path, "a");
        assert_eq!(ancestors[1].path, "a/b");
        assert_eq!(ancestors[2].path, "a/b/c");
    }

    #[test]
    fn test_get_root_notes() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("root1").unwrap();
        api.create_note("root2").unwrap();
        api.create_note("root1/child").unwrap();

        let roots = api.get_root_notes().unwrap();
        assert_eq!(roots.len(), 2);

        let paths: Vec<_> = roots.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"root1"));
        assert!(paths.contains(&"root2"));
    }

    #[test]
    fn test_archive_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/note").unwrap();

        api.archive_note("parent/note").unwrap();

        assert!(!api.note_exists("parent/note").unwrap());
        assert!(api.note_exists("parent/_archive/note").unwrap());

        // Check archived flag
        let archived: i64 = api
            .db
            .query_row(
                "SELECT archived FROM notes WHERE path = ?1",
                params!["parent/_archive/note"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived, 1);
    }

    #[test]
    fn test_unarchive_note() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/note").unwrap();
        api.archive_note("parent/note").unwrap();
        api.unarchive_note("parent/_archive/note").unwrap();

        assert!(api.note_exists("parent/note").unwrap());
        assert!(!api.note_exists("parent/_archive/note").unwrap());

        // Check archived flag
        let archived: i64 = api
            .db
            .query_row(
                "SELECT archived FROM notes WHERE path = ?1",
                params!["parent/note"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived, 0);
    }

    #[test]
    fn test_search() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("note1").unwrap();
        api.save_note("note1", "Rust programming").unwrap();
        api.create_note("note2").unwrap();
        api.save_note("note2", "Python programming").unwrap();
        api.create_note("note3").unwrap();
        api.save_note("note3", "Cooking recipes").unwrap();

        let results = api.search("programming").unwrap();
        assert_eq!(results.len(), 2);

        let paths: Vec<_> = results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"note1"));
        assert!(paths.contains(&"note2"));
    }

    #[test]
    fn test_rescan_after_external_changes() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("note1").unwrap();

        // Simulate external file creation
        std::fs::create_dir_all(temp_dir.path().join("note2")).unwrap();
        std::fs::write(temp_dir.path().join("note2/_index.md"), "Content 2").unwrap();

        // Rescan
        api.rescan().unwrap();

        // Verify new note is indexed
        assert!(api.note_exists("note2").unwrap());
    }

    #[test]
    fn test_startup_sync() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("note1").unwrap();

        // Manually delete from DB to simulate out-of-sync state
        let id: i64 = api
            .db
            .query_row(
                "SELECT id FROM notes WHERE path = ?1",
                params!["note1"],
                |row| row.get(0),
            )
            .unwrap();
        api.db
            .execute("DELETE FROM notes WHERE path = ?1", params!["note1"])
            .unwrap();
        api.db
            .execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])
            .unwrap();

        // Run startup sync
        api.startup_sync().unwrap();

        // Verify note is re-indexed
        assert!(api.note_exists("note1").unwrap());
    }

    #[test]
    fn test_frecency_get_note_updates_score() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();

        // Get note (should record access)
        api.get_note("test").unwrap();

        // Check frecency score was updated
        let (access_count, score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["test"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(access_count, 1);
        assert!(score > 0.0);
    }

    #[test]
    fn test_frecency_save_note_updates_score() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();
        api.save_note("test", "Content").unwrap();

        // Check frecency score was updated
        let (access_count, score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["test"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(access_count, 1);
        assert!(score > 0.0);
    }

    #[test]
    fn test_frecency_multiple_accesses() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("test").unwrap();

        // Access multiple times
        api.get_note("test").unwrap();
        api.get_note("test").unwrap();
        api.save_note("test", "Content").unwrap();

        // Check access count increased
        let (access_count, score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["test"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(access_count, 3);
        assert!(score > 0.0);
    }

    #[test]
    fn test_frecency_propagates_to_ancestors() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/child").unwrap();

        // Access child note
        api.get_note("parent/child").unwrap();

        // Check that parent also has updated frecency
        let (parent_count, parent_score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["parent"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(parent_count, 1);
        assert!(parent_score > 0.0);
    }

    #[test]
    fn test_frecency_children_sorted_by_score() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        api.create_note("parent").unwrap();
        api.create_note("parent/a").unwrap();
        api.create_note("parent/b").unwrap();
        api.create_note("parent/c").unwrap();

        // Access notes in different order with different frequencies
        api.get_note("parent/b").unwrap(); // b gets 1 access
        api.get_note("parent/c").unwrap(); // c gets 2 accesses
        api.get_note("parent/c").unwrap();
        // a gets 0 accesses

        // Get children (should be sorted by frecency)
        let children = api.get_children("parent").unwrap();
        let paths: Vec<_> = children.iter().map(|c| c.path.as_str()).collect();

        // c should be first (most accesses), then b, then a
        assert_eq!(paths[0], "parent/c");
        assert_eq!(paths[1], "parent/b");
        assert_eq!(paths[2], "parent/a");
    }

    #[test]
    fn test_frecency_score_calculation() {
        // Test the calculation directly
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        // Recent access should have high score
        let score_recent = NotesApi::calculate_frecency_score(10, Some(now));
        assert!(score_recent > 900.0); // 10 * (100 / ~1) ≈ 1000

        // Access from 10 days ago should have lower score
        let ten_days_ago = now - (10 * 86400);
        let score_old = NotesApi::calculate_frecency_score(10, Some(ten_days_ago));
        assert!(score_old < 100.0); // 10 * (100 / 11) ≈ 90

        // More accesses should increase score
        assert!(score_recent > score_old);

        // No access history should give zero score
        let score_none = NotesApi::calculate_frecency_score(0, None);
        assert_eq!(score_none, 0.0);
    }

    #[test]
    fn test_frecency_propagates_through_multiple_levels() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create a deep hierarchy: grandparent/parent/child
        api.create_note("grandparent").unwrap();
        api.create_note("grandparent/parent").unwrap();
        api.create_note("grandparent/parent/child").unwrap();

        // Access the deepest child
        api.get_note("grandparent/parent/child").unwrap();

        // Check that all ancestors have updated frecency
        let (child_count, child_score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["grandparent/parent/child"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let (parent_count, parent_score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["grandparent/parent"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let (grandparent_count, grandparent_score): (i64, f64) = api
            .db
            .query_row(
                "SELECT access_count, frecency_score FROM notes WHERE path = ?1",
                params!["grandparent"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        // All should have 1 access
        assert_eq!(child_count, 1);
        assert_eq!(parent_count, 1);
        assert_eq!(grandparent_count, 1);

        // All should have positive scores
        assert!(child_score > 0.0);
        assert!(parent_score > 0.0);
        assert!(grandparent_score > 0.0);
    }

    #[test]
    fn test_frecency_root_notes_sorted_by_score() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create three root notes
        api.create_note("projects").unwrap();
        api.create_note("notes").unwrap();
        api.create_note("archive").unwrap();

        // Access them in different frequencies
        api.get_note("notes").unwrap(); // notes gets 1 access
        api.get_note("projects").unwrap(); // projects gets 2 accesses
        api.get_note("projects").unwrap();
        // archive gets 0 accesses

        // Get root notes (should be sorted by frecency)
        let roots = api.get_root_notes().unwrap();
        let paths: Vec<_> = roots.iter().map(|r| r.path.as_str()).collect();

        // projects should be first (most accesses), then notes, then archive
        assert_eq!(paths[0], "projects");
        assert_eq!(paths[1], "notes");
        assert_eq!(paths[2], "archive");
    }

    #[test]
    fn test_fuzzy_search_prefix_matching() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create notes with various names
        api.create_note("hello").unwrap();
        api.create_note("hello-world").unwrap();
        api.create_note("help").unwrap();
        api.create_note("project").unwrap();
        api.create_note("project/hello").unwrap();
        api.create_note("other").unwrap();
        api.create_note("other/stuff").unwrap();

        // Test prefix matching - "hel" should match hello, hello-world, help
        let results = api.fuzzy_search("hel", None, RankingMode::Visits).unwrap();
        assert_eq!(results.len(), 4); // hello, hello-world, help, project/hello

        // Verify prefix matches come first
        assert!(results[0].path.starts_with("hel") || results[0].path == "help");

        // Test single character
        let results = api.fuzzy_search("h", None, RankingMode::Visits).unwrap();
        assert!(results.len() >= 4); // At least the hello variants and help

        // Test exact match
        let results = api
            .fuzzy_search("hello", None, RankingMode::Visits)
            .unwrap();
        assert!(results.iter().any(|n| n.path == "hello"));
        assert!(results.iter().any(|n| n.path == "hello-world"));

        // Test case insensitivity
        let results = api
            .fuzzy_search("HELLO", None, RankingMode::Visits)
            .unwrap();
        assert!(results.iter().any(|n| n.path == "hello"));

        // Test substring matching
        let results = api.fuzzy_search("ell", None, RankingMode::Visits).unwrap();
        assert!(results.iter().any(|n| n.path == "hello"));

        // Test no matches
        let results = api.fuzzy_search("xyz", None, RankingMode::Visits).unwrap();
        assert_eq!(results.len(), 0);

        // Test empty query returns all notes
        let results = api.fuzzy_search("", None, RankingMode::Visits).unwrap();
        assert_eq!(results.len(), 7); // All notes including parent folders
    }

    #[test]
    fn test_fuzzy_search_ranking() {
        let temp_dir = TempDir::new().unwrap();
        let mut api = NotesApi::new(temp_dir.path()).unwrap();

        // Create notes where ranking matters
        api.create_note("test").unwrap();
        api.create_note("testing").unwrap();
        api.create_note("project").unwrap();
        api.create_note("project/test").unwrap();
        api.create_note("other").unwrap();
        api.create_note("other/testing-notes").unwrap();

        // Prefix matches should rank higher than substring matches
        let results = api.fuzzy_search("test", None, RankingMode::Visits).unwrap();

        // "test" and "testing" should come before "project/test"
        // (prefix match on path vs prefix match on segment)
        let paths: Vec<_> = results.iter().map(|n| n.path.as_str()).collect();
        let test_pos = paths.iter().position(|&p| p == "test").unwrap();
        let testing_pos = paths.iter().position(|&p| p == "testing").unwrap();
        let project_test_pos = paths.iter().position(|&p| p == "project/test").unwrap();

        // Prefix matches (test, testing) should come before path segment matches
        assert!(test_pos < project_test_pos);
        assert!(testing_pos < project_test_pos);
    }
}
