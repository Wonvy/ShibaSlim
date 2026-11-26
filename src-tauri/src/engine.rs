//! The compression engine: the same Node.js code as `shibaslim gui`, run with the bundled
//! Node runtime. It reports to the app with one JSON line per message on stdout, and
//! shuts down when its stdin closes, so it never outlives the app, even after a crash.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::shell::{self, Call};
use crate::updates::{self, Trigger};

/// File name of the bundled Node runtime (see `bundle.externalBin`).
const NODE_SIDECAR: &str = "shibaslim-node";
/// How long the engine gets to clean up its temp folder before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Lines of engine stderr kept for the error screen.
const STDERR_LINES: usize = 40;
/// The automatic update check waits until the window has settled.
const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(4);

#[derive(Default)]
pub struct Engine {
    process: Mutex<Option<EngineProcess>>,
    /// `http://127.0.0.1:<port>`, set once the engine reports its address.
    origin: OnceLock<String>,
    stderr: Mutex<VecDeque<String>>,
    /// A startup failure to show once the splash screen has loaded.
    pub error: Mutex<Option<String>>,
    /// Set when the app stops the engine itself (quitting, updating), so its exit is expected.
    stopping: AtomicBool,
    pub preview_count: AtomicUsize,
}

struct EngineProcess {
    child: Child,
    /// Dropping this closes the engine's stdin, which tells it to shut down.
    stdin: Option<ChildStdin>,
}

/// One line the engine prints on stdout (see desktop/engine.mjs).
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum EngineMessage {
    Ready {
        url: String,
    },
    /// The page's quit button (hidden in the desktop app).
    Quit,
    /// The page's "Check for updates" button.
    #[serde(rename = "check-update")]
    CheckUpdate,
    /// Something to do natively; answered on the engine's stdin with the same id.
    Request {
        id: u64,
        call: Call,
    },
}

impl Engine {
    /// Whether a URL belongs to the engine's page.
    pub fn serves(&self, url: &Url) -> bool {
        self.origin
            .get()
            .is_some_and(|origin| url.origin().ascii_serialization() == *origin)
    }
}

/// Where the engine's files and the Node runtime live: next to the app when bundled,
/// and in target/<profile>/ when run with `tauri dev`.
fn paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
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

pub fn start(app: &AppHandle, engine: &Arc<Engine>, window: WebviewWindow) -> Result<(), String> {
    let (node, script) = paths(app)?;
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(script.parent().unwrap())
        // Shown next to the "Check for updates" button.
        .env("SHIBASLIM_APP_VERSION", app.package_info().version.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("{}: {e}", node.display()))?;
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
        thread::spawn(move || read_stdout(stdout, engine, &app, &window));
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

fn read_stdout(stdout: impl Read, engine: Arc<Engine>, app: &AppHandle, window: &WebviewWindow) {
    let mut ready = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        match serde_json::from_str::<EngineMessage>(&line) {
            Ok(EngineMessage::Ready { url }) => match Url::parse(&url) {
                Ok(url) => {
                    if cfg!(debug_assertions) {
                        // Development builds: lets the page's API be driven by hand.
                        eprintln!("[engine] ready at {url}");
                    }
                    let _ = engine.origin.set(url.origin().ascii_serialization());
                    ready = true;
                    if let Err(err) = window.navigate(url) {
                        show_error(&engine, window, &err.to_string());
                    }
                    // Development builds would offer to replace themselves with the released app.
                    if !cfg!(debug_assertions) {
                        let app = app.clone();
                        let engine = engine.clone();
                        thread::spawn(move || {
                            thread::sleep(UPDATE_CHECK_DELAY);
                            updates::check(&app, engine, Trigger::Startup);
                        });
                    }
                }
                Err(err) => show_error(&engine, window, &format!("bad address from engine: {err}")),
            },
            Ok(EngineMessage::Quit) => {
                app.exit(0);
                return;
            }
            Ok(EngineMessage::CheckUpdate) => updates::check(app, engine.clone(), Trigger::Manual),
            Ok(EngineMessage::Request { id, call }) => {
                let app = app.clone();
                let engine = engine.clone();
                thread::spawn(move || {
                    let result = shell::handle(&app, &engine, call);
                    reply(&engine, id, result);
                });
            }
            Err(_) => println!("[engine] {line}"),
        }
    }

    // stdout closed: the engine has exited or is about to.
    if engine.stopping.load(Ordering::SeqCst) {
        return;
    }
    let status = wait_for_exit(&engine, Duration::from_secs(2));
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
        show_error(&engine, window, &details);
    }
    // If it died after the page loaded, the page shows its own "disconnected" banner.
}

/// Answers a request on the engine's stdin.
fn reply(engine: &Engine, id: u64, result: Result<Value, String>) {
    let line = match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(error) => json!({ "id": id, "error": error }),
    };
    if let Some(stdin) = engine.process.lock().unwrap().as_mut().and_then(|p| p.stdin.as_mut()) {
        let _ = writeln!(stdin, "{line}");
        let _ = stdin.flush();
    }
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

/// Stops the engine, giving it a moment to delete its temp files. Safe to call more than once.
pub fn stop(engine: &Engine) {
    engine.stopping.store(true, Ordering::SeqCst);
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
pub fn show_error(engine: &Engine, window: &WebviewWindow, details: &str) {
    *engine.error.lock().unwrap() = Some(details.to_owned());
    eval_error(window, details);
}

pub fn eval_error(window: &WebviewWindow, details: &str) {
    let details = serde_json::to_string(details).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.showEngineError && window.showEngineError({details})"));
}
