//! Requests from the engine for things the app does natively rather than by running system
//! commands (see `DesktopShell` in src/gui.ts): they behave the same on every system, and the
//! dialogs belong to the app's window.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::DialogExt;

use crate::engine::Engine;

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum Call {
    /// Show a result file, selected, in its folder (the page's "Show" button).
    Reveal { path: PathBuf },
    /// Open the output folder (the page's "Open" button).
    OpenFolder { path: PathBuf },
    /// Ask where results should go (the page's "Choose…" button). Answers null when cancelled.
    PickFolder { title: String },
    /// Open a comparison page the engine has finished building.
    OpenPreview { url: String, title: String },
}

/// Runs one request. Called on a thread of its own, since a folder dialog waits for the user.
pub fn handle(app: &AppHandle, engine: &Arc<Engine>, call: Call) -> Result<Value, String> {
    match call {
        Call::Reveal { path } => {
            tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        Call::OpenFolder { path } => {
            tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        Call::PickFolder { title } => {
            let mut dialog = app.dialog().file().set_title(title);
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.set_parent(&window);
            }
            let folder = dialog.blocking_pick_folder().and_then(|folder| folder.into_path().ok());
            Ok(folder.map_or(Value::Null, |path| json!(path.to_string_lossy())))
        }
        Call::OpenPreview { url, title } => {
            let url = Url::parse(&url).map_err(|e| e.to_string())?;
            if !engine.serves(&url) {
                return Err(format!("not a ShibaSlim page: {url}"));
            }
            crate::preview_window(app, engine, url, &title).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
    }
}
