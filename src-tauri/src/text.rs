//! The few strings the app draws natively (menu, update dialogs) follow the system
//! language: Chinese when the first preferred language is Chinese, English otherwise.
//! The page and the startup screen pick their language in the browser engine the same way.

use std::sync::OnceLock;

pub fn chinese() -> bool {
    static CHINESE: OnceLock<bool> = OnceLock::new();
    *CHINESE.get_or_init(|| {
        sys_locale::get_locales()
            .next()
            .is_some_and(|locale| locale.to_ascii_lowercase().starts_with("zh"))
    })
}

/// Picks the Chinese or the English text.
pub fn t(zh: &'static str, en: &'static str) -> &'static str {
    if chinese() {
        zh
    } else {
        en
    }
}
