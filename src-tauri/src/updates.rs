//! Online updates from GitHub Releases (plugins.updater in tauri.conf.json).
//!
//! The app checks once a few seconds after it starts, and again whenever the user asks
//! (the page's "Check for updates" button or the macOS menu). Updates are signed in CI
//! and verified against the public key in the config before anything is installed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::engine::{self, Engine};
use crate::text::{chinese, t};

pub const RELEASES_URL: &str = "https://github.com/Wonvy/ShibaSlim/releases";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The automatic check after launch: stays quiet unless there is an update.
    Startup,
    /// The user asked: always answers, including "up to date" and errors.
    Manual,
}

/// Only one check or download at a time.
static BUSY: AtomicBool = AtomicBool::new(false);

pub fn check(app: &AppHandle, engine: Arc<Engine>, trigger: Trigger) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(&app, &engine, trigger).await {
            eprintln!("update failed: {err}");
            reset_progress(&app);
            if trigger == Trigger::Manual {
                let message = if chinese() {
                    format!("检查或下载更新时出错：\n{err}\n\n也可以到 {RELEASES_URL} 手动下载新版本。")
                } else {
                    format!("Could not check for or download the update:\n{err}\n\nYou can also download the new version from {RELEASES_URL}.")
                };
                tell(&app, t("无法更新", "Update failed"), message, MessageDialogKind::Error).await;
            }
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

async fn run(app: &AppHandle, engine: &Arc<Engine>, trigger: Trigger) -> Result<(), String> {
    let stop = engine.clone();
    let updater = app
        .updater_builder()
        // Windows: the installer replaces the engine's files, so the engine must be gone first.
        .on_before_exit(move || engine::stop(&stop))
        .build()
        .map_err(|e| e.to_string())?;

    let current = app.package_info().version.to_string();
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        if trigger == Trigger::Manual {
            let message = if chinese() {
                format!("ShibaSlim {current} 已经是最新版本。")
            } else {
                format!("ShibaSlim {current} is the latest version.")
            };
            tell(
                app,
                t("已是最新版本", "You’re up to date"),
                message,
                MessageDialogKind::Info,
            )
            .await;
        }
        return Ok(());
    };

    let message = if chinese() {
        format!(
            "ShibaSlim {} 已经发布，你现在用的是 {current}。\n\n现在下载并安装吗？安装完成后 ShibaSlim 会自动重新打开，正在进行的压缩会被中断。",
            update.version
        )
    } else {
        format!(
            "ShibaSlim {} is available; you have {current}.\n\nDownload and install it now? ShibaSlim reopens when it is done, and any compression in progress is stopped.",
            update.version
        )
    };
    if !ask(
        app,
        t("有新版本", "Update available"),
        message,
        t("现在更新", "Update Now"),
        t("以后再说", "Later"),
    )
    .await
    {
        return Ok(());
    }

    let window = app.get_webview_window("main");
    let name = app.package_info().name.clone();
    let mut received: u64 = 0;
    let mut shown = u64::MAX;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let (Some(window), Some(total)) = (&window, total.filter(|&t| t > 0)) else {
                    return;
                };
                let percent = (received * 100 / total).min(100);
                if percent != shown {
                    shown = percent;
                    let _ = window.set_title(&format!(
                        "{name} — {} {percent}%",
                        t("正在下载更新", "Downloading update")
                    ));
                    let _ = window.set_progress_bar(ProgressBarState {
                        status: Some(ProgressBarStatus::Normal),
                        progress: Some(percent),
                    });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    engine::stop(engine);
    if let Err(err) = update.install(bytes) {
        // Bring the engine back by reopening the app, then report.
        let message = if chinese() {
            format!("安装更新时出错：\n{err}\n\n也可以到 {RELEASES_URL} 手动下载新版本。")
        } else {
            format!(
                "Could not install the update:\n{err}\n\nYou can also download the new version from {RELEASES_URL}."
            )
        };
        tell(app, t("无法更新", "Update failed"), message, MessageDialogKind::Error).await;
    }
    // macOS and Linux: open the new version. (On Windows the installer has already taken over.)
    app.restart();
}

fn reset_progress(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&app.package_info().name);
        let _ = window.set_progress_bar(ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        });
    }
}

async fn ask(app: &AppHandle, title: &str, message: String, yes: &str, no: &str) -> bool {
    let builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()));
    tauri::async_runtime::spawn_blocking(move || builder.blocking_show())
        .await
        .unwrap_or(false)
}

async fn tell(app: &AppHandle, title: &str, message: String, kind: MessageDialogKind) {
    let builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::OkCustom(t("好", "OK").into()));
    let _ = tauri::async_runtime::spawn_blocking(move || builder.blocking_show()).await;
}
