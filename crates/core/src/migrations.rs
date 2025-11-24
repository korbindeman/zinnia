use std::fs;
use std::io;
use std::path::Path;

use crate::filesystem::NoteFilesystem;

/// Cleans up markdown files by removing `<br />` tags and excessive empty lines.
/// Creates backups in a `_backups` folder before modifying files.
pub fn cleanup_br_tags(notes_root: &Path) -> io::Result<()> {
    let fs = NoteFilesystem::new(notes_root)?;

    // Create backup directory
    let backup_root = notes_root.join("_backups");
    fs::create_dir_all(&backup_root)?;

    // Scan all notes
    let notes = fs.scan_all()?;

    for note_meta in notes {
        let path = &note_meta.path;

        // Read original content
        let content = match fs.read_note(path) {
            Ok(c) => c,
            Err(_) => continue, // Skip if we can't read it
        };

        // Create backup with same directory structure
        let backup_path = if path.is_empty() {
            backup_root.join("_index.md")
        } else {
            backup_root.join(path).join("_index.md")
        };

        if let Some(parent) = backup_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&backup_path, &content)?;

        // Clean the content
        let cleaned = clean_markdown(&content);

        // Only write if content changed
        if cleaned != content {
            fs.write_note(path, &cleaned)?;
        }
    }

    Ok(())
}

/// Cleans markdown content by:
/// 1. Removing all `<br />`, `<br/>`, `<br>` tags
/// 2. Removing all empty lines (including whitespace-only lines)
/// 3. Adding single empty lines where `<br />` appeared (between sections)
fn clean_markdown(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();

    // Step 1: Replace lines containing only <br /> variants with a marker
    let br_marker = "::BR_PLACEHOLDER::";
    let lines: Vec<&str> = lines
        .into_iter()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed == "<br />" || trimmed == "<br/>" || trimmed == "<br>" {
                br_marker
            } else {
                line
            }
        })
        .collect();

    // Step 2: Remove all empty/whitespace-only lines
    let lines: Vec<&str> = lines
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect();

    // Step 3: Replace BR markers with single empty lines
    let lines: Vec<&str> = lines
        .into_iter()
        .map(|line| if line == br_marker { "" } else { line })
        .collect();

    // Step 4: Join with newlines and ensure single trailing newline
    let result = lines.join("\n");
    if result.is_empty() {
        result
    } else {
        format!("{}\n", result.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_clean_markdown_basic() {
        let input = r#"# Ingredients:

* Roasted peanuts (as fresh as possibble!)

* Sugar (adjust to taste)

* Avocado oil (1-2 tablespoons per 250g peanuts, adjust for desired consistency)

* Salt (add after grinding)

<br />

# Directions:

1. Grind peanuts first until oil releases
2. Add salt, sugar, avocado oil
3. Blend until desired consistency
4. Store in clean glass jar, minimal headspace

<br />

# Notes:

* Oil separation is normal - stir before use

- Oxidation of peanuts (not oil) limits shelf life - use fresh peanuts, dry utensils only, minimize air exposure

- Equipment: needs high-powered blender (1200W+) or strong food processor

- Watch for rancidity: bitter taste or off smell means it's expired"#;

        let expected = r#"# Ingredients:
* Roasted peanuts (as fresh as possibble!)
* Sugar (adjust to taste)
* Avocado oil (1-2 tablespoons per 250g peanuts, adjust for desired consistency)
* Salt (add after grinding)

# Directions:
1. Grind peanuts first until oil releases
2. Add salt, sugar, avocado oil
3. Blend until desired consistency
4. Store in clean glass jar, minimal headspace

# Notes:
* Oil separation is normal - stir before use
- Oxidation of peanuts (not oil) limits shelf life - use fresh peanuts, dry utensils only, minimize air exposure
- Equipment: needs high-powered blender (1200W+) or strong food processor
- Watch for rancidity: bitter taste or off smell means it's expired
"#;

        let result = clean_markdown(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_clean_markdown_br_variants() {
        let input = "Line 1\n\n<br />\n\nLine 2\n\n<br/>\n\nLine 3\n\n<br>\n\nLine 4";
        let expected = "Line 1\n\nLine 2\n\nLine 3\n\nLine 4\n";

        let result = clean_markdown(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_clean_markdown_whitespace_only_lines() {
        let input = "Line 1\n   \n\t\nLine 2\n  \t  \nLine 3";
        let expected = "Line 1\nLine 2\nLine 3\n";

        let result = clean_markdown(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_clean_markdown_empty_content() {
        let input = "";
        let expected = "";

        let result = clean_markdown(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_clean_markdown_only_br_tags() {
        let input = "<br />\n\n<br/>\n\n<br>";
        // Each <br /> becomes an empty line, empty lines between them are removed
        let expected = "\n";

        let result = clean_markdown(input);
        assert_eq!(result, expected);
    }

    #[test]
    fn test_cleanup_br_tags_integration() {
        let temp_dir = TempDir::new().unwrap();
        let fs = NoteFilesystem::new(temp_dir.path()).unwrap();

        // Create a note with br tags
        let content_with_br = "# Title\n\nLine 1\n\nLine 2\n\n<br />\n\n# Section 2\n\nContent";
        fs.write_note("test", content_with_br).unwrap();

        // Create a nested note
        fs.write_note("parent/child", "Text 1\n\n<br/>\n\nText 2")
            .unwrap();

        // Run the cleanup
        cleanup_br_tags(temp_dir.path()).unwrap();

        // Verify the notes were cleaned
        let cleaned = fs.read_note("test").unwrap();
        assert_eq!(cleaned, "# Title\nLine 1\nLine 2\n\n# Section 2\nContent\n");

        let cleaned_nested = fs.read_note("parent/child").unwrap();
        assert_eq!(cleaned_nested, "Text 1\n\nText 2\n");

        // Verify backup was created
        let backup_path = temp_dir.path().join("_backups/test/_index.md");
        assert!(backup_path.exists());
        let backup_content = std::fs::read_to_string(backup_path).unwrap();
        assert_eq!(backup_content, content_with_br);

        // Verify nested backup structure
        let backup_nested = temp_dir.path().join("_backups/parent/child/_index.md");
        assert!(backup_nested.exists());
    }
}
