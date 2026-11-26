//! The macOS menu bar, in the system language. Windows and Linux windows have no menu bar.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

use crate::text::t;

pub const CHECK_UPDATE: &str = "check-update";
pub const HOMEPAGE: &str = "homepage";
pub const HOMEPAGE_URL: &str = "https://github.com/Wonvy/ShibaSlim";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let name = info.name.as_str();
    let separator = || PredefinedMenuItem::separator(app);

    let about = PredefinedMenuItem::about(
        app,
        Some(&format!("{} {name}", t("关于", "About"))),
        Some(AboutMetadata {
            version: Some(info.version.to_string()),
            copyright: Some("MIT License · Wonvy".into()),
            website: Some(HOMEPAGE_URL.into()),
            ..Default::default()
        }),
    )?;
    let check = MenuItem::with_id(
        app,
        CHECK_UPDATE,
        t("检查更新…", "Check for Updates…"),
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &about,
            &separator()?,
            &check,
            &separator()?,
            &PredefinedMenuItem::services(app, Some(t("服务", "Services")))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some(&format!("{} {name}", t("隐藏", "Hide"))))?,
            &PredefinedMenuItem::hide_others(app, Some(t("隐藏其他", "Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(t("全部显示", "Show All")))?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some(&format!("{} {name}", t("退出", "Quit"))))?,
        ],
    )?;

    // Without an Edit menu, copy and paste shortcuts do not work in the page's text fields.
    let edit = Submenu::with_items(
        app,
        t("编辑", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(t("撤销", "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(t("重做", "Redo")))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some(t("剪切", "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(t("拷贝", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(t("粘贴", "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(t("全选", "Select All")))?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        t("显示", "View"),
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(t("进入全屏幕", "Enter Full Screen")),
        )?],
    )?;

    let window = Submenu::with_items(
        app,
        t("窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(t("最小化", "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(t("缩放", "Zoom")))?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, Some(t("关闭窗口", "Close Window")))?,
        ],
    )?;
    window.set_as_windows_menu_for_nsapp()?;

    let homepage = MenuItem::with_id(
        app,
        HOMEPAGE,
        t("ShibaSlim 主页", "ShibaSlim Website"),
        true,
        None::<&str>,
    )?;
    let help = Submenu::with_items(app, t("帮助", "Help"), true, &[&homepage])?;
    help.set_as_help_menu_for_nsapp()?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}
