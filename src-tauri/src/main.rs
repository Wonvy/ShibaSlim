// ShibaSlim desktop app.
//
// The compression engine is the same Node.js code as `shibaslim gui`. The app
// ships its own Node runtime (a sidecar binary) plus the engine's files as
// resources, starts the engine's local server on 127.0.0.1, and shows that page
// in a native window. Nothing needs to be installed on the user's machine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// File name of the bundled Node runtime (see `bundle.externalBin`).
const NODE_SIDECAR: &str = "shibaslim-node";
/// How long the engine gets to clean up its temp folder before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Lines of engine stderr kept for the error screen.
const STDERR_LINES: usize = 40;

#[derive(Default)]
struct Engine {
    process: Mutex<Option<EngineProcess>>,
    /// `http://127.0.0.1:<port>`, set once the engine reports its address.
    origin: OnceLock<String>,
    stderr: Mutex<VecDeque<String>>,
    /// A startup failure to show once the splash screen has loaded.
    error: Mutex<Option<String>>,
    preview_count: AtomicUsize,
}

struct EngineProcess {
    child: Child,
    /// Dropping this closes the engine's stdin, which tells it to shut down.
    stdin: Option<ChildStdin>,
}

/// One line the engine prints on stdout.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum EngineMessage {
    Ready { url: String },
    Quit,
}

impl Engine {
    fn serves(&self, url: &Url) -> bool {
        self.origin
            .get()
            .is_some_and(|origin| url.origin().ascii_serialization() == *origin)
    }
}

/// Pages the app itself ships (the startup screen).
fn is_app_page(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn main() {
    let engine = Arc::new(Engine::default());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup({
            let engine = engine.clone();
            move |app| {
                let window = main_window(app.handle(), &engine)?;
                // Comparison windows belong to the main one: closing it quits the app.
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Destroyed = event {
                        handle.exit(0);
                    }
                });
                if let Err(message) = start_engine(app.handle(), &engine, window.clone()) {
                    show_error(&engine, &window, &message);
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start ShibaSlim");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            stop_engine(&engine);
        }
    });
}

fn main_window(app: &AppHandle, engine: &Arc<Engine>) -> tauri::Result<WebviewWindow> {
    let navigation = engine.clone();
    let popups = engine.clone();
    let splash = engine.clone();
    let app_for_popups = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("ShibaSlim")
        .inner_size(960.0, 820.0)
        .min_inner_size(520.0, 560.0)
        // Let the page receive dropped files and folders as ordinary HTML drag and drop.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if is_app_page(url) || navigation.serves(url) {
                return true;
            }
            open_in_browser(url);
            false
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished && is_app_page(payload.url()) {
                if let Some(message) = splash.error.lock().unwrap().clone() {
                    eval_error(&window, &message);
                }
            }
        })
        .on_new_window(move |url, features| {
            if popups.serves(&url) && url.path().starts_with("/api/preview/") {
                match preview_window(&app_for_popups, &popups, features) {
                    Ok(window) => return NewWindowResponse::Create { window },
                    Err(err) => eprintln!("could not open the comparison window: {err}"),
                }
            } else {
                open_in_browser(&url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

/// The comparison page opens in its own window. It is generated on demand and can take a few seconds.
fn preview_window(
    app: &AppHandle,
    engine: &Arc<Engine>,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::Result<WebviewWindow> {
    let n = engine.preview_count.fetch_add(1, Ordering::Relaxed) + 1;
    let navigation = engine.clone();
    WebviewWindowBuilder::new(
        app,
        format!("preview-{n}"),
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("ShibaSlim")
    .inner_size(1200.0, 860.0)
    .min_inner_size(480.0, 400.0)
    .window_features(features)
    .on_navigation(move |url| {
        if url.scheme() == "about" || navigation.serves(url) {
            return true;
        }
        open_in_browser(url);
        false
    })
    .on_document_title_changed(|window, title| {
        if !title.is_empty() {
            let _ = window.set_title(&title);
        }
    })
    .build()
}

/// Where the engine's files and the Node runtime live: next to the app when bundled,
/// and in target/<profile>/ when run with `tauri dev`.
fn engine_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin_dir = exe.parent().ok_or("cannot locate the app folder")?;
    let node = bin_dir.join(format!("{NODE_SIDECAR}{}", std::env::consts::EXE_SUFFIX));
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("engine")
        .join("main.mjs");
    for path in [&node, &script] {
        if !path.exists() {
            return Err(format!("missing {}", path.display()));
        }
    }
    Ok((node, script))
}

fn start_engine(
    app: &AppHandle,
    engine: &Arc<Engine>,
    window: WebviewWindow,
) -> Result<(), String> {
    let (node, script) = engine_paths(app)?;
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(script.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("{}: {e}", node.display()))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = child.stdin.take();
    *engine.process.lock().unwrap() = Some(EngineProcess { child, stdin });

    {
        let engine = engine.clone();
        thread::spawn(move || read_stderr(stderr, &engine));
    }
    {
        let engine = engine.clone();
        let app = app.clone();
        thread::spawn(move || read_stdout(stdout, &engine, &app, &window));
    }
    Ok(())
}

fn read_stderr(stderr: impl Read, engine: &Engine) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[engine] {line}");
        let mut lines = engine.stderr.lock().unwrap();
        if lines.len() == STDERR_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }
}

fn read_stdout(stdout: impl Read, engine: &Engine, app: &AppHandle, window: &WebviewWindow) {
    let mut ready = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        match serde_json::from_str::<EngineMessage>(&line) {
            Ok(EngineMessage::Ready { url }) => match Url::parse(&url) {
                Ok(url) => {
                    let _ = engine.origin.set(url.origin().ascii_serialization());
                    ready = true;
                    if let Err(err) = window.navigate(url) {
                        show_error(engine, window, &err.to_string());
                    }
                }
                Err(err) => show_error(engine, window, &format!("bad address from engine: {err}")),
            },
            // The page's own "quit" button.
            Ok(EngineMessage::Quit) => {
                app.exit(0);
                return;
            }
            Err(_) => println!("[engine] {line}"),
        }
    }

    // stdout closed: the engine has exited or is about to.
    let status = wait_for_exit(engine, Duration::from_secs(2));
    if ready && status == Some(true) {
        // It shut down cleanly on its own, e.g. after the page asked it to quit.
        app.exit(0);
    } else if !ready {
        // Give the stderr reader a moment to collect the last lines.
        thread::sleep(Duration::from_millis(200));
        let details = engine
            .stderr
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        show_error(engine, window, &details);
    }
    // If it died after the page loaded, the page shows its own "disconnected" banner.
}

/// Waits for the engine process to exit. Returns whether it succeeded, or None if it is still running.
fn wait_for_exit(engine: &Engine, timeout: Duration) -> Option<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut guard = engine.process.lock().unwrap();
            let Some(process) = guard.as_mut() else {
                return Some(true);
            };
            if let Ok(Some(status)) = process.child.try_wait() {
                return Some(status.success());
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn stop_engine(engine: &Engine) {
    let Some(mut process) = engine.process.lock().unwrap().take() else {
        return;
    };
    // Closing stdin asks the engine to finish up and delete its temp files.
    drop(process.stdin.take());
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = process.child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
}

/// Shows a startup failure on the splash screen, now or as soon as it has loaded.
fn show_error(engine: &Engine, window: &WebviewWindow, details: &str) {
    *engine.error.lock().unwrap() = Some(details.to_owned());
    eval_error(window, details);
}

fn eval_error(window: &WebviewWindow, details: &str) {
    let details = serde_json::to_string(details).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!(
        "window.showEngineError && window.showEngineError({details})"
    ));
}
