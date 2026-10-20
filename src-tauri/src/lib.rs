//! Tauri backend: file-system commands and a directory watcher for the frontend.

mod ai;
mod compile;
mod spelling;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Watchers {
    next: AtomicU32,
    active: Mutex<HashMap<u32, notify::RecommendedWatcher>>,
}

struct Startup {
    file: Option<String>,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

#[derive(Serialize, Clone)]
struct FsChange {
    id: u32,
    paths: Vec<String>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Writes via a temporary file + rename so a crash never leaves a half-written file.
#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target.parent().ok_or("path has no parent directory")?;
    let name = target.file_name().ok_or("path has no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.texdesk-tmp"));
    std::fs::write(&tmp, content).map_err(|e| format!("{path}: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{path}: {e}")
    })
}

/// Creates a new file, failing if anything already exists at `path` (never overwrites).
#[tauri::command]
fn create_text(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{path}: {e}"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

#[derive(Serialize)]
struct WalkEntry {
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

/// Every file and folder under `root` (relative paths), skipping entries matched by the
/// gitignore-syntax `ignore` patterns. Hidden files are included unless ignored.
#[tauri::command]
fn list_files(root: String, ignore: Vec<String>) -> Result<Vec<WalkEntry>, String> {
    let root_path = PathBuf::from(&root);
    let mut gi = ignore::gitignore::GitignoreBuilder::new(&root_path);
    for line in &ignore {
        gi.add_line(None, line).map_err(err)?;
    }
    let gi = gi.build().map_err(err)?;
    let walker = ignore::WalkBuilder::new(&root_path)
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(move |e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            !gi.matched(e.path(), is_dir).is_ignore()
        })
        .build();
    let mut out = Vec::new();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        let rel = entry.path().strip_prefix(&root_path).map_err(err)?;
        out.push(WalkEntry {
            path: rel.to_string_lossy().into_owned(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
    }
    Ok(out)
}

/// Moves a file or folder to the system Trash (recoverable), never deleting outright.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path}: no such file or folder"));
    }
    trash::delete(&path).map_err(|e| format!("{path}: {e}"))
}

/// Renames or moves a file or folder. Fails if anything already exists at `to`, or if a
/// folder would be moved into itself.
#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    let (src, dest) = (Path::new(&from), Path::new(&to));
    if !src.exists() {
        return Err(format!("{from}: no such file or folder"));
    }
    // symlink_metadata so a dangling link at `to` still counts as "something is there".
    if dest.symlink_metadata().is_ok() && !same_file_different_case(src, dest) {
        return Err(format!("{} already exists", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(to.clone())));
    }
    if dest.starts_with(src) && dest != src {
        return Err("can't move a folder into itself".into());
    }
    std::fs::rename(src, dest).map_err(|e| format!("{from} → {to}: {e}"))
}

/// On case-insensitive file systems, renaming `a.tex` → `A.tex` sees `A.tex` as existing.
fn same_file_different_case(a: &Path, b: &Path) -> bool {
    a.parent() == b.parent()
        && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Opens a file with the system default app.
#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&path).spawn().map(|_| ()).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Save dialog for "Save PDF as…". The dialog itself asks before replacing an existing file.
#[tauri::command]
async fn pick_save_pdf(app: AppHandle, dir: String, name: String) -> Option<String> {
    app.dialog()
        .file()
        .set_directory(dir)
        .set_file_name(name)
        .add_filter("PDF", &["pdf"])
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Creates a new binary file from the raw request body; the destination path comes in the
/// percent-encoded `path` header. Fails if the file exists (never overwrites).
#[tauri::command]
fn create_binary(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::io::Write;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing path header")?;
    if let Some(dir) = Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{path}: {e}"))?;
    }
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{path}: {e}"))?;
    f.write_all(data).map_err(|e| format!("{path}: {e}"))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Raw bytes of a file, sent to the webview as an ArrayBuffer (used for PDFs).
#[tauri::command]
fn read_binary(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
}

/// A gzip-compressed text file, decompressed (used for .synctex.gz).
#[tauri::command]
fn read_gzip_text(path: String) -> Result<String, String> {
    use std::io::Read;
    let f = std::fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut s = String::new();
    flate2::read::GzDecoder::new(f).read_to_string(&mut s).map_err(|e| format!("{path}: {e}"))?;
    Ok(s)
}

#[derive(Serialize, Debug)]
struct FileTimes {
    /// Milliseconds since the epoch; creation falls back to modification where the file
    /// system has no creation time.
    created: f64,
    modified: f64,
}

fn millis(t: std::time::SystemTime) -> f64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Created/modified times for each path (null where it can't be read), in one call.
#[tauri::command]
fn file_times(paths: Vec<String>) -> Vec<Option<FileTimes>> {
    paths
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p).ok()?;
            let modified = m.modified().ok()?;
            Some(FileTimes { created: millis(m.created().unwrap_or(modified)), modified: millis(modified) })
        })
        .collect()
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME isn't set".to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
        let entry = entry.map_err(err)?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir });
    }
    Ok(out)
}

#[tauri::command]
fn mkdir_all(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

/// Watches one directory (non-recursively) and emits `fs-change` events tagged with the returned id.
#[tauri::command]
fn watch_dir(app: AppHandle, state: State<'_, Watchers>, path: String) -> Result<u32, String> {
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths = event.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            let _ = handle.emit("fs-change", FsChange { id, paths });
        }
    })
    .map_err(err)?;
    watcher.watch(Path::new(&path), RecursiveMode::NonRecursive).map_err(|e| format!("{path}: {e}"))?;
    state.active.lock().unwrap().insert(id, watcher);
    Ok(id)
}

/// Watches a whole folder tree, skipping paths matched by the gitignore-syntax `ignore`
/// patterns (like `list_files`), and emits `fs-change` events tagged with the returned id.
#[tauri::command]
fn watch_tree(app: AppHandle, state: State<'_, Watchers>, root: String, ignore: Vec<String>) -> Result<u32, String> {
    let root_path = PathBuf::from(&root);
    let mut gi = ignore::gitignore::GitignoreBuilder::new(&root_path);
    for line in &ignore {
        gi.add_line(None, line).map_err(err)?;
    }
    let gi = gi.build().map_err(err)?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    let base = root_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| p.starts_with(&base) && !gi.matched_path_or_any_parents(p, p.is_dir()).is_ignore())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !paths.is_empty() {
            let _ = handle.emit("fs-change", FsChange { id, paths });
        }
    })
    .map_err(err)?;
    watcher.watch(&root_path, RecursiveMode::Recursive).map_err(|e| format!("{root}: {e}"))?;
    state.active.lock().unwrap().insert(id, watcher);
    Ok(id)
}

#[tauri::command]
fn unwatch(state: State<'_, Watchers>, id: u32) {
    state.active.lock().unwrap().remove(&id);
}

#[tauri::command]
fn initial_file(state: State<'_, Startup>) -> Option<String> {
    state.file.clone()
}

#[tauri::command]
async fn pick_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// First CLI argument naming an existing file or folder, made absolute.
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-')).and_then(|a| {
        let p = std::fs::canonicalize(&a).ok()?;
        Some(p.to_string_lossy().into_owned())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Watchers::default())
        .manage(compile::Builds::default())
        .manage(Startup { file: startup_file() })
        .invoke_handler(tauri::generate_handler![
            read_text, write_text, create_text, path_exists, home_dir, read_dir, mkdir_all, list_files, watch_dir, watch_tree, unwatch,
            initial_file, pick_file, pick_folder, pick_save_pdf, trash_path, move_path, open_external, read_binary, read_gzip_text, create_binary,
            compile::compile, compile::cancel_compile, compile::file_sha256, compile::copy_file, spelling::check_spelling, file_times,
            ai::ai_has_key, ai::ai_set_key, ai::ai_messages
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("TeXdesk");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TeXdesk");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn spellchecker_flags_misspellings_and_suggests() {
        let words = vec!["probability".to_string(), "probabilty".to_string()];
        let misses = spelling::check_spelling(words).expect("macOS has a spellchecker");
        assert_eq!(misses.len(), 1);
        let m = serde_json::to_value(&misses[0]).unwrap();
        assert_eq!(m["word"], "probabilty");
        assert!(m["suggestions"].as_array().unwrap().iter().any(|s| s == "probability"));
    }

    #[test]
    fn file_times_reads_creation_and_modification() {
        let dir = std::env::temp_dir().join(format!("texdesk-times-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.tex");
        std::fs::write(&f, "x").unwrap();
        let t = file_times(vec![f.to_string_lossy().into(), dir.join("missing").to_string_lossy().into()]);
        std::fs::remove_dir_all(&dir).unwrap();
        let a = t[0].as_ref().unwrap();
        assert!(a.created > 1.6e12 && a.modified >= a.created - 1000.0);
        assert!(t[1].is_none());
    }

    #[test]
    fn list_files_respects_ignore_patterns() {
        let dir = std::env::temp_dir().join(format!("texdesk-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for p in ["Fa30/1-CS101/hw/hw1.tex", "Fa30/1-CS101/hw/.build/hw1.aux", ".git/HEAD", "code/node_modules/x/y.js", "code/main.py", ".texdesk/config.toml"] {
            let f = dir.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "").unwrap();
        }
        let ignore = [".git", "node_modules", ".build", "*.log"].map(String::from).to_vec();
        let mut got: Vec<String> = list_files(dir.to_string_lossy().into_owned(), ignore)
            .unwrap()
            .into_iter()
            .map(|e| if e.is_dir { format!("{}/", e.path) } else { e.path })
            .collect();
        got.sort();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got, vec![
            ".texdesk/", ".texdesk/config.toml", "Fa30/", "Fa30/1-CS101/", "Fa30/1-CS101/hw/", "Fa30/1-CS101/hw/hw1.tex",
            "code/", "code/main.py",
        ]);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("%2FUsers%2Falex%2FCS%20101%2Ffig%C3%A9.png"), "/Users/alex/CS 101/figé.png");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn move_path_refuses_to_overwrite_or_nest() {
        let d = std::env::temp_dir().join(format!("texdesk-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("a/sub")).unwrap();
        std::fs::write(d.join("a/x.tex"), "x").unwrap();
        std::fs::write(d.join("y.tex"), "y").unwrap();
        let s = |p: &str| d.join(p).to_string_lossy().into_owned();
        assert!(move_path(s("a/x.tex"), s("y.tex")).is_err());
        assert_eq!(std::fs::read_to_string(d.join("y.tex")).unwrap(), "y");
        assert!(move_path(s("a"), s("a/sub/a")).is_err());
        move_path(s("a/x.tex"), s("a/sub/x.tex")).unwrap();
        assert!(d.join("a/sub/x.tex").exists() && !d.join("a/x.tex").exists());
        move_path(s("y.tex"), s("Y.tex")).unwrap();
        assert!(d.join("Y.tex").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn create_text_never_overwrites() {
        let f = std::env::temp_dir().join(format!("texdesk-create-{}.tex", std::process::id()));
        let p = f.to_string_lossy().into_owned();
        let _ = std::fs::remove_file(&f);
        create_text(p.clone(), "one".into()).unwrap();
        assert!(create_text(p.clone(), "two".into()).is_err());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "one");
        std::fs::remove_file(&f).unwrap();
    }
}
