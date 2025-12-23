use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use zinnia_core::{
    Note, NoteMetadata, NotesApi, RankingMode, WatcherEvent, cleanup_br_tags, setup_watcher,
};

// Application state holding the NotesApi instance
pub struct AppState {
    notes_api: Arc<Mutex<NotesApi>>,
}

// Serializable versions of the core types for Tauri/JSON
#[derive(Serialize, Deserialize)]
pub struct NoteDTO {
    id: i64,
    path: String,
    content: String,
    modified: u64, // Unix timestamp
}

#[derive(Serialize, Deserialize)]
pub struct NoteMetadataDTO {
    id: i64,
    path: String,
    modified: u64, // Unix timestamp
    archived: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RankingModeDTO {
    Visits,
    Frecency,
}

impl From<RankingModeDTO> for RankingMode {
    fn from(dto: RankingModeDTO) -> Self {
        match dto {
            RankingModeDTO::Visits => RankingMode::Visits,
            RankingModeDTO::Frecency => RankingMode::Frecency,
        }
    }
}

// Convert core types to DTOs
impl From<Note> for NoteDTO {
    fn from(note: Note) -> Self {
        NoteDTO {
            id: note.id,
            path: note.path,
            content: note.content,
            modified: note
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
}

impl From<NoteMetadata> for NoteMetadataDTO {
    fn from(meta: NoteMetadata) -> Self {
        NoteMetadataDTO {
            id: meta.id,
            path: meta.path,
            modified: meta
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            archived: meta.archived,
        }
    }
}

// Tauri Commands

#[tauri::command]
fn create_note(path: String, state: State<AppState>) -> Result<NoteDTO, String> {
    let mut api = state.notes_api.lock().unwrap();
    api.create_note(&path)
        .map(|note| note.into())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn get_note(path: String, state: State<AppState>) -> Result<NoteDTO, String> {
    let mut api = state.notes_api.lock().unwrap();
    api.get_note(&path)
        .map(|note| note.into())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn save_note(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.save_note(&path, &content)
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn delete_note(path: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.delete_note(&path).map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn rename_note(old_path: String, new_path: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.rename_note(&old_path, &new_path)
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn get_children(path: String, state: State<AppState>) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.get_children(&path)
        .map(|children| children.into_iter().map(|c| c.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn has_children(path: String, state: State<AppState>) -> Result<bool, String> {
    let api = state.notes_api.lock().unwrap();
    api.has_children(&path).map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn get_ancestors(path: String, state: State<AppState>) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.get_ancestors(&path)
        .map(|ancestors| ancestors.into_iter().map(|a| a.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn get_root_notes(state: State<AppState>) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.get_root_notes()
        .map(|notes| notes.into_iter().map(|n| n.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn get_all_notes(state: State<AppState>) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.get_all_notes()
        .map(|notes| notes.into_iter().map(|n| n.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn fuzzy_search_notes(
    query: String,
    limit: Option<usize>,
    ranking_mode: RankingModeDTO,
    context_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.fuzzy_search(&query, limit, ranking_mode.into(), context_path.as_deref())
        .map(|results| results.into_iter().map(|r| r.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn search_notes(query: String, state: State<AppState>) -> Result<Vec<NoteMetadataDTO>, String> {
    let api = state.notes_api.lock().unwrap();
    api.search(&query)
        .map(|results| results.into_iter().map(|r| r.into()).collect())
        .map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn archive_note(path: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.archive_note(&path).map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn unarchive_note(path: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.unarchive_note(&path).map_err(|e| format!("{:?}", e))
}

#[tauri::command]
fn trash_note(path: String, state: State<AppState>) -> Result<(), String> {
    let mut api = state.notes_api.lock().unwrap();
    api.trash_note(&path).map_err(|e| format!("{:?}", e))
}

#[tauri::command]
async fn download_image(
    note_path: String,
    image_url: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Get the notes root directory
    let notes_root = {
        let api = state.notes_api.lock().unwrap();
        api.notes_root().to_path_buf()
    };

    // Create attachments directory for this note
    let note_dir = if note_path.is_empty() {
        notes_root.clone()
    } else {
        notes_root.join(&note_path)
    };
    let attachments_dir = note_dir.join("_attachments");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| format!("Failed to create attachments directory: {:?}", e))?;

    // Download the image
    let response = reqwest::get(&image_url)
        .await
        .map_err(|e| format!("Failed to download image: {:?}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download image: HTTP {}",
            response.status()
        ));
    }

    // Get the file extension from URL or content type
    let extension = image_url
        .split('/')
        .last()
        .and_then(|s| s.split('?').next())
        .and_then(|s| s.split('.').last())
        .filter(|ext| ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(ext))
        .or_else(|| {
            response
                .headers()
                .get("content-type")
                .and_then(|ct| ct.to_str().ok())
                .and_then(|ct| match ct {
                    "image/png" => Some("png"),
                    "image/jpeg" => Some("jpg"),
                    "image/gif" => Some("gif"),
                    "image/webp" => Some("webp"),
                    "image/svg+xml" => Some("svg"),
                    _ => None,
                })
        })
        .unwrap_or("png");

    // Generate a unique filename based on timestamp
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let filename = format!("image-{}.{}", timestamp, extension);
    let file_path = attachments_dir.join(&filename);

    // Save the image
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image data: {:?}", e))?;
    std::fs::write(&file_path, bytes).map_err(|e| format!("Failed to save image: {:?}", e))?;

    // Return relative path from note (for markdown)
    Ok(format!("_attachments/{}", filename))
}

#[tauri::command]
fn get_note_file_path(path: String, state: State<AppState>) -> Result<String, String> {
    let api = state.notes_api.lock().unwrap();
    let notes_root = api.notes_root();
    let note_dir = if path.is_empty() {
        notes_root.to_path_buf()
    } else {
        notes_root.join(&path)
    };
    let file_path = note_dir.join("_index.md");
    file_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path".to_string())
}

#[tauri::command]
fn resolve_image_path(
    note_path: String,
    image_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    // Get the notes root directory
    let notes_root = {
        let api = state.notes_api.lock().unwrap();
        api.notes_root().to_path_buf()
    };

    // Build the full path to the image
    let note_dir = if note_path.is_empty() {
        notes_root.clone()
    } else {
        notes_root.join(&note_path)
    };

    let full_path = if image_path.starts_with("./") {
        note_dir.join(&image_path[2..])
    } else if image_path.starts_with("_attachments/") {
        note_dir.join(&image_path)
    } else {
        // Assume it's a relative path
        note_dir.join(&image_path)
    };

    // Return the absolute path as a string
    full_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path".to_string())
}

fn run_br_tags_migration(app: &tauri::App, notes_api: &Arc<Mutex<NotesApi>>) {
    let store = app
        .store("app-state.json")
        .expect("Failed to load app-state store");
    let migration_completed = store
        .get("brTagsMigrationCompleted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !migration_completed {
        eprintln!("Running br tag cleanup migration...");
        let notes_root = {
            let api = notes_api.lock().unwrap();
            api.notes_root().to_path_buf()
        };

        if let Err(e) = cleanup_br_tags(&notes_root) {
            eprintln!("Warning: Failed to run br tag cleanup migration: {:?}", e);
        } else {
            // Mark migration as completed
            store.set("brTagsMigrationCompleted", serde_json::json!(true));
            if let Err(e) = store.save() {
                eprintln!("Warning: Failed to save store: {:?}", e);
            }
            eprintln!("br tag cleanup migration completed successfully");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut api =
        NotesApi::with_default_path(cfg!(debug_assertions)).expect("Failed to initialize NotesApi");

    api.startup_sync().expect("Failed to sync notes database");

    let notes_api = Arc::new(Mutex::new(api));

    let state = AppState {
        notes_api: Arc::clone(&notes_api),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            create_note,
            get_note,
            save_note,
            delete_note,
            rename_note,
            get_children,
            has_children,
            get_ancestors,
            get_root_notes,
            get_all_notes,
            fuzzy_search_notes,
            search_notes,
            archive_note,
            unarchive_note,
            trash_note,
            download_image,
            resolve_image_path,
            get_note_file_path,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let app_handle_frecency = app.handle().clone();

            // Run migrations
            // run_br_tags_migration(app, &notes_api);

            // Set up frecency callback
            {
                let mut api = notes_api.lock().unwrap();
                api.set_frecency_callback(move || {
                    if let Err(e) = app_handle_frecency.emit("notes:frecency", ()) {
                        eprintln!("Failed to emit frecency event: {:?}", e);
                    }
                });
            }

            // Setup filesystem watcher with event emission
            let _watcher = setup_watcher(
                notes_api,
                Some(move |event| {
                    let event_name = match event {
                        WatcherEvent::NotesChanged => "notes:changed",
                        WatcherEvent::NotesRenamed => "notes:renamed",
                        WatcherEvent::FrecencyUpdated => "notes:frecency",
                    };

                    // Emit event to frontend
                    if let Err(e) = app_handle.emit(event_name, ()) {
                        eprintln!("Failed to emit watcher event: {:?}", e);
                    }
                }),
            );

            // Keep watcher alive for app lifetime
            app.manage(_watcher);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
