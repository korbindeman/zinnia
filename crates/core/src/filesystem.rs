use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct FSNoteMetadata {
    pub path: String,
    pub mtime: SystemTime,
}

// Helper function to get parent path from a path string
fn get_parent_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let path = Path::new(path);
    path.parent()
        .filter(|p| p != &Path::new(""))
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Debug)]
pub struct NoteFilesystem {
    root_path: PathBuf,
}

impl NoteFilesystem {
    pub fn new<P: AsRef<Path>>(root_path: P) -> io::Result<Self> {
        let root_path = root_path.as_ref().to_path_buf();
        fs::create_dir_all(&root_path)?;
        Ok(Self { root_path })
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    pub fn read_note(&self, path: &str) -> io::Result<String> {
        let fs_path = self.note_to_fs_path(path);
        fs::read_to_string(fs_path)
    }

    pub fn write_note(&self, path: &str, content: &str) -> io::Result<()> {
        let fs_path = self.note_to_fs_path(path);
        if let Some(parent) = fs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(fs_path, content)
    }

    pub fn create_note(&self, path: &str) -> io::Result<()> {
        let fs_path = self.note_to_fs_path(path);
        if fs_path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Note already exists",
            ));
        }
        if let Some(parent) = fs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(fs_path, "")
    }

    pub fn delete_note(&self, path: &str) -> io::Result<()> {
        let dir_path = self.root_path.join(path);
        fs::remove_dir_all(dir_path)
    }

    pub fn cleanup_unused_attachments(&self, path: &str, content: &str) -> io::Result<()> {
        // Get the note's directory
        let note_dir = if path.is_empty() {
            self.root_path.clone()
        } else {
            self.root_path.join(path)
        };

        let attachments_dir = note_dir.join("_attachments");

        // If no attachments directory exists, nothing to clean up
        if !attachments_dir.exists() {
            return Ok(());
        }

        // Extract all image references from the content
        // Matches: ![alt](_attachments/filename) or ![alt](./attachments/filename)
        let image_regex =
            regex::Regex::new(r"!\[([^\]]*)\]\((?:\./)?_attachments/([^)]+)\)").unwrap();

        let referenced_files: std::collections::HashSet<String> = image_regex
            .captures_iter(content)
            .map(|cap| cap[2].to_string())
            .collect();

        // Read all files in attachments directory
        let entries = match fs::read_dir(&attachments_dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(()), // Directory doesn't exist or can't be read
        };

        // Delete unreferenced files
        for entry in entries {
            if let Ok(entry) = entry {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        if let Some(filename) = entry.file_name().to_str() {
                            if !referenced_files.contains(filename) {
                                let file_path = attachments_dir.join(filename);
                                fs::remove_file(file_path).ok(); // Ignore errors
                            }
                        }
                    }
                }
            }
        }

        // Remove the attachments directory if it's now empty
        if let Ok(mut entries) = fs::read_dir(&attachments_dir) {
            if entries.next().is_none() {
                fs::remove_dir(&attachments_dir).ok(); // Ignore errors
            }
        }

        Ok(())
    }

    pub fn rename_note(&self, old_path: &str, new_path: &str) -> io::Result<()> {
        let old_dir_path = if old_path.is_empty() {
            // Can't rename root note
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Cannot rename root note",
            ));
        } else {
            self.root_path.join(old_path)
        };

        let new_dir_path = if new_path.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Cannot rename to root note",
            ));
        } else {
            self.root_path.join(new_path)
        };

        // Ensure parent directory exists for new path
        if let Some(parent) = new_dir_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Move the entire directory (including _attachments and other files)
        fs::rename(&old_dir_path, &new_dir_path)?;

        Ok(())
    }

    pub fn trash_note(&self, path: &str) -> io::Result<()> {
        let dir_path = self.root_path.join(path);
        if !dir_path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Note does not exist",
            ));
        }
        trash::delete(&dir_path)
            .map_err(|e| io::Error::other(format!("Failed to move note to trash: {}", e)))
    }

    pub fn scan_all(&self) -> io::Result<Vec<FSNoteMetadata>> {
        let mut notes = Vec::new();
        Self::scan_dir(&self.root_path, "", &mut notes)?;
        Ok(notes)
    }

    pub fn get_ancestors(&self, path: &str) -> Vec<String> {
        let mut ancestors = vec![path.to_string()];
        let mut current = path.to_string();

        while let Some(parent) = get_parent_path(&current) {
            ancestors.push(parent.clone());
            current = parent;
        }

        ancestors.reverse();
        ancestors
    }

    fn note_to_fs_path(&self, path: &str) -> PathBuf {
        if path.is_empty() {
            self.root_path.join("_index.md")
        } else {
            self.root_path.join(path).join("_index.md")
        }
    }

    fn scan_dir(dir: &Path, prefix: &str, notes: &mut Vec<FSNoteMetadata>) -> io::Result<()> {
        let index_path = dir.join("_index.md");
        if index_path.exists() {
            let metadata = fs::metadata(&index_path)?;
            let mtime = metadata.modified()?;
            notes.push(FSNoteMetadata {
                path: prefix.to_string(),
                mtime,
            });
        }

        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let metadata = entry.metadata()?;

            if metadata.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();

                // Skip special directories
                if name == "_backups" {
                    continue;
                }

                let new_prefix = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                };
                Self::scan_dir(&entry.path(), &new_prefix, notes)?;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_and_read_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.create_note("test").unwrap();
        let content = fs.read_note("test").unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn test_write_and_read_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("test", "Hello, World!").unwrap();
        let content = fs.read_note("test").unwrap();
        assert_eq!(content, "Hello, World!");
    }

    #[test]
    fn test_create_nested_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.create_note("projects/rust").unwrap();
        let content = fs.read_note("projects/rust").unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn test_delete_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.create_note("test").unwrap();
        fs.delete_note("test").unwrap();
        assert!(fs.read_note("test").is_err());
    }

    #[test]
    fn test_delete_note_with_children() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("parent", "Parent content").unwrap();
        fs.write_note("parent/child", "Child content").unwrap();

        fs.delete_note("parent").unwrap();
        assert!(fs.read_note("parent").is_err());
        assert!(fs.read_note("parent/child").is_err());
    }

    #[test]
    fn test_scan_all() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("inbox", "Inbox content").unwrap();
        fs.write_note("projects", "Projects content").unwrap();
        fs.write_note("projects/rust-app", "Rust app content")
            .unwrap();

        let notes = fs.scan_all().unwrap();
        assert_eq!(notes.len(), 3);

        let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
        assert!(paths.contains(&"inbox"));
        assert!(paths.contains(&"projects"));
        assert!(paths.contains(&"projects/rust-app"));
    }

    #[test]
    fn test_special_characters_in_path() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("note-with-dashes", "Content").unwrap();
        let content = fs.read_note("note-with-dashes").unwrap();
        assert_eq!(content, "Content");

        fs.write_note("note_with_underscores", "Content").unwrap();
        let content = fs.read_note("note_with_underscores").unwrap();
        assert_eq!(content, "Content");
    }

    #[test]
    fn test_deep_nesting() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("a/b/c/d/e", "Deep content").unwrap();
        let content = fs.read_note("a/b/c/d/e").unwrap();
        assert_eq!(content, "Deep content");
    }

    #[test]
    fn test_read_nonexistent_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        assert!(fs.read_note("nonexistent").is_err());
    }

    #[test]
    fn test_create_duplicate_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.create_note("test").unwrap();
        assert!(fs.create_note("test").is_err());
    }

    #[test]
    fn test_scan_nested_structure() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("inbox", "Inbox").unwrap();
        fs.write_note("projects", "Projects").unwrap();
        fs.write_note("projects/rust-app", "Rust app").unwrap();
        fs.write_note("projects/rust-app/architecture", "Architecture")
            .unwrap();

        let notes = fs.scan_all().unwrap();
        assert_eq!(notes.len(), 4);
    }

    #[test]
    fn test_mtime_tracking() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("test", "Content").unwrap();
        let notes = fs.scan_all().unwrap();

        assert_eq!(notes.len(), 1);
        assert!(notes[0].mtime.elapsed().is_ok());
    }

    #[test]
    fn test_root_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        fs.write_note("", "Root content").unwrap();
        let content = fs.read_note("").unwrap();
        assert_eq!(content, "Root content");
    }

    #[test]
    fn test_get_ancestors() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Empty path returns itself (root note)
        assert_eq!(fs.get_ancestors(""), vec![""]);

        // Root level note returns itself only
        assert_eq!(fs.get_ancestors("inbox"), vec!["inbox"]);

        // One level deep - returns root, then self
        assert_eq!(
            fs.get_ancestors("projects/rust-app"),
            vec!["projects", "projects/rust-app"]
        );

        // Multiple levels deep - returns full path including self
        assert_eq!(
            fs.get_ancestors("projects/rust-app/architecture"),
            vec![
                "projects",
                "projects/rust-app",
                "projects/rust-app/architecture"
            ]
        );

        // Deep nesting - returns full path including self
        assert_eq!(
            fs.get_ancestors("a/b/c/d/e"),
            vec!["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"]
        );
    }

    #[test]
    fn test_rename_note() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note with content
        fs.write_note("old-name", "Test content").unwrap();

        // Rename it
        fs.rename_note("old-name", "new-name").unwrap();

        // Old path should not exist
        assert!(fs.read_note("old-name").is_err());

        // New path should have the content
        let content = fs.read_note("new-name").unwrap();
        assert_eq!(content, "Test content");
    }

    #[test]
    fn test_rename_note_with_attachments() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note
        fs.write_note("old-name", "Test content").unwrap();

        // Create an attachments folder with a file
        let attachments_dir = temp_dir.path().join("old-name/_attachments");
        fs::create_dir_all(&attachments_dir).unwrap();
        let test_file = attachments_dir.join("image.jpg");
        fs::write(&test_file, b"fake image data").unwrap();

        // Rename the note
        fs.rename_note("old-name", "new-name").unwrap();

        // Old path should not exist
        assert!(fs.read_note("old-name").is_err());
        assert!(
            !temp_dir
                .path()
                .join("old-name/_attachments/image.jpg")
                .exists()
        );

        // New path should have the content and attachments
        let content = fs.read_note("new-name").unwrap();
        assert_eq!(content, "Test content");

        let new_attachment = temp_dir.path().join("new-name/_attachments/image.jpg");
        assert!(new_attachment.exists());
        let attachment_content = fs::read(&new_attachment).unwrap();
        assert_eq!(attachment_content, b"fake image data");
    }

    #[test]
    fn test_cleanup_unused_attachments() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note with one image reference
        let content = "# My Note\n\n![Image 1](_attachments/image1.jpg)\n\nSome text.";
        fs.write_note("test-note", content).unwrap();

        // Create attachments directory with multiple files
        let attachments_dir = temp_dir.path().join("test-note/_attachments");
        fs::create_dir_all(&attachments_dir).unwrap();
        fs::write(attachments_dir.join("image1.jpg"), b"image 1 data").unwrap();
        fs::write(attachments_dir.join("image2.jpg"), b"image 2 data").unwrap();
        fs::write(attachments_dir.join("image3.jpg"), b"image 3 data").unwrap();

        // Run cleanup
        fs.cleanup_unused_attachments("test-note", content).unwrap();

        // image1.jpg should still exist (it's referenced)
        assert!(attachments_dir.join("image1.jpg").exists());

        // image2.jpg and image3.jpg should be deleted (not referenced)
        assert!(!attachments_dir.join("image2.jpg").exists());
        assert!(!attachments_dir.join("image3.jpg").exists());
    }

    #[test]
    fn test_cleanup_removes_empty_attachments_dir() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note with no image references
        let content = "# My Note\n\nNo images here.";
        fs.write_note("test-note", content).unwrap();

        // Create attachments directory with a file
        let attachments_dir = temp_dir.path().join("test-note/_attachments");
        fs::create_dir_all(&attachments_dir).unwrap();
        fs::write(attachments_dir.join("unused.jpg"), b"unused data").unwrap();

        // Run cleanup
        fs.cleanup_unused_attachments("test-note", content).unwrap();

        // The entire attachments directory should be removed
        assert!(!attachments_dir.exists());
    }

    #[test]
    fn test_cleanup_with_no_attachments_dir() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note without attachments
        let content = "# My Note\n\nNo images here.";
        fs.write_note("test-note", content).unwrap();

        // Run cleanup (should not error even with no attachments dir)
        fs.cleanup_unused_attachments("test-note", content).unwrap();
    }
}
