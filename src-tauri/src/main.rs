// ShibaSlim desktop app.
//
// The compression engine is the same Node.js code as `shibaslim gui`. The app
// ships its own Node runtime (a sidecar binary) plus the engine's files as
// resources, starts the engine's local server on 127.0.0.1, and shows that page
// in a native window. Nothing needs to be installed on the user's machine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
#[cfg(target_os = "macos")]
mod menu;
mod text;
mod updates;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use engine::Engine;

/// The page's background colours (gui/style.css), so nothing flashes white in dark mode.
const LIGHT: Color = Color(0xf4, 0xf3, 0xf0, 0xff);
const DARK: Color = Color(0x14, 0x14, 0x14, 0xff);

/// Pages the app itself ships (the startup screen).
fn is_app_page(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn background(theme: Option<Theme>) -> Color {
    if theme == Some(Theme::Dark) {
        DARK
    } else {
        LIGHT
    }
}

fn main() {
    let engine = Arc::new(Engine::default());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event({
        let engine = engine.clone();
        move |app, event| match event.id().as_ref() {
            menu::CHECK_UPDATE => updates::check(app, engine.clone(), updates::Trigger::Manual),
            menu::HOMEPAGE => {
                let _ = tauri_plugin_opener::open_url(menu::HOMEPAGE_URL, None::<&str>);
            }
            _ => {}
        }
    });

    let app = builder
        .setup({
            let engine = engine.clone();
            move |app| {
                let window = main_window(app.handle(), &engine)?;
                // Comparison windows belong to the main one: closing it quits the app. (Only on the user's
                // close; reacting to the window being destroyed would also fire while the app restarts
                // after an update, and exiting from there would cancel the restart.)
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        handle.exit(0);
                    }
                });
                if let Err(message) = engine::start(app.handle(), &engine, window.clone()) {
                    engine::show_error(&engine, &window, &message);
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start ShibaSlim");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            engine::stop(&engine);
        }
    });
}

fn main_window(app: &AppHandle, engine: &Arc<Engine>) -> tauri::Result<WebviewWindow> {
    let navigation = engine.clone();
    let popups = engine.clone();
    let splash = engine.clone();
    let app_for_popups = app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("ShibaSlim")
        .inner_size(960.0, 820.0)
        .min_inner_size(520.0, 560.0)
        // Shown once the startup screen has painted, in the system's light or dark colours.
        .visible(false)
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
                let _ = window.show();
                if let Some(message) = splash.error.lock().unwrap().clone() {
                    engine::eval_error(&window, &message);
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
        .build()?;
    let _ = window.set_background_color(Some(background(window.theme().ok())));

    // Never leave the window hidden, even if the startup screen fails to load.
    let fallback = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let _ = fallback.show();
    });
    Ok(window)
}

/// The comparison page opens in its own window. It is generated on demand and can take a few seconds.
fn preview_window(
    app: &AppHandle,
    engine: &Arc<Engine>,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::Result<WebviewWindow> {
    let n = engine.preview_count.fetch_add(1, Ordering::Relaxed) + 1;
    let navigation = engine.clone();
    let theme = app.get_webview_window("main").and_then(|w| w.theme().ok());
    WebviewWindowBuilder::new(
        app,
        format!("preview-{n}"),
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("ShibaSlim")
    .inner_size(1200.0, 860.0)
    .min_inner_size(480.0, 400.0)
    .background_color(background(theme))
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
