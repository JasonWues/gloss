// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod clipboard;
mod cmd;
mod config;
mod edge_tts;
mod error;
mod hotkey;
mod hotkey_suppression;
mod lang_detect;
mod ocr_layout;
mod proxy;
mod screenshot;
mod server;
mod system_ocr;
mod tray;
mod tts;
mod updater;
mod window;

use backup::*;
use clipboard::*;
use cmd::*;
use config::*;
use edge_tts::{edge_tts, edge_tts_voices};
use hotkey::*;
use hotkey_suppression::{
    get_hotkey_suppression_status, list_running_processes, start_hotkey_suppression,
    update_hotkey_suppressed_processes,
};
use lang_detect::*;
use ocr_layout::system_ocr_layout;
use log::{error, info, warn};
use proxy::{apply_proxy, get_system_proxy};
use screenshot::screenshot;
use server::*;
use std::sync::Mutex;
use std::sync::OnceLock;
use system_ocr::*;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_notification::NotificationExt;
use tray::*;
use tts::*;
use updater::check_update;
use window::config_window;
use window::updater_window;

// Global AppHandle
pub static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

// Text to be translated
pub struct StringWrapper(pub Mutex<String>);

// Whether the pending translation should be pasted back over the user's
// selection instead of being shown. It answers "how did this translation
// start", so it is written beside the text above and never on its own --
// `window::set_pending_text` is the only writer, for exactly that reason.
pub struct ReplaceSelectionWrapper(pub Mutex<bool>);

// `lock().unwrap()` turns one panic into a permanent one: the mutex stays
// poisoned for the rest of the process, so every later lock panics too and the
// subsystem behind it is dead until restart. That is the right default when a
// panic could leave the guarded value half-updated -- but none of the three
// mutexes here can be caught that way. `StringWrapper` and
// `ClipboardMonitorEnableWrapper` are whole-value replacements
// (`replace_range(.., ..)`) or copies out (`to_string()`), and `PENDING_CAPTURE`
// is a `take()`/assign of an `Option<JoinHandle>`. There is no intermediate
// state for a panic to strand, so recovering the value is strictly better than
// inheriting the poison.
pub trait LockExt<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// A panic in a background thread -- the http server, the clipboard monitor, a
// hotkey callback -- writes to stderr and nowhere else. Release builds are
// `windows_subsystem = "windows"` and so have no stderr at all, which is how the
// http server could die on its first request with the log file showing only that
// the request arrived. Everything user-facing is diagnosed from the log dir
// (tray -> View Log), so panics have to arrive there too.
fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = match info.location() {
            Some(l) => format!("{}:{}:{}", l.file(), l.line(), l.column()),
            None => "unknown location".to_string(),
        };
        // The payload is pulled out rather than logging `info` directly, whose
        // Display repeats the location and then breaks the message onto a second
        // line -- which in a log file full of other threads is a line that no
        // longer says what it belongs to.
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        error!("Panic on thread '{name}' at {location}: {message}");
        previous(info);
    }));
}

fn main() {
    // Before anything can overwrite them: on Linux the inherited proxy variables
    // are the system setting, and "follow the system" restores exactly these.
    proxy::capture_inherited_env();

    let builder = tauri::Builder::default();

    // Debug builds expose an MCP bridge, which lets an AI assistant screenshot the
    // webviews, read the DOM and watch IPC -- the things that otherwise can only be
    // reached by asking the user to reproduce a bug by hand. `localhost_only` is not
    // the plugin's default: it otherwise binds 0.0.0.0, which would let anyone on
    // the network drive these windows. `cfg(debug_assertions)` keeps it out of
    // release builds entirely.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init_with_config(
        tauri_plugin_mcp_bridge::Config::localhost_only(),
    ));

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, cwd| {
            let _ = app
                .notification()
                .builder()
                .title("The program is already running. Please do not start it again!")
                .body(cwd)
                .icon("Gloss")
                .show();
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // Opening a FOLDER is not something the shell plugin will do: its `open`
        // scope defaults to `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`, so a
        // filesystem path never validates. The opener plugin is v2's answer, and
        // its scope is a path allowlist rather than a URL regex -- see
        // capabilities/default.json, which limits it to the log and config dirs.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // After the log plugin, so the hook has a logger to write to.
            log_panics();
            info!("============== Start App ==============");
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let trusted =
                    macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
                info!("MacOS Accessibility Trusted: {}", trusted);
            }
            // Global AppHandle
            APP.get_or_init(|| app.handle().clone());
            // Init Config
            info!("Init Config Store");
            init_config(app);
            // Before any window exists: `useConfig` seeds a missing key with its
            // default, so a webview that reaches `proxy_mode` first would write
            // "system" and the migration below would then decline to run, quietly
            // dropping a manual proxy.
            proxy::migrate_config();
            // Check First Run
            if is_first_run() {
                // Open Config Window
                info!("First Run, opening config window");
                config_window();
            }
            app.manage(StringWrapper(Mutex::new("".to_string())));
            app.manage(ReplaceSelectionWrapper(Mutex::new(false)));
            // Attach handlers to the tray icon created from `app.trayIcon` in the config
            match app.tray_by_id(TRAY_ID) {
                Some(tray) => {
                    tray.on_menu_event(tray_menu_event_handler);
                    tray.on_tray_icon_event(tray_icon_event_handler);
                }
                None => warn!("Tray icon '{}' not found, tray menu is disabled", TRAY_ID),
            }
            // Update Tray Menu
            update_tray(app.handle().clone(), "".to_string(), "".to_string());
            // Start http server
            start_server();
            // Register Global Shortcut
            match register_shortcut("all") {
                Ok(()) => {}
                Err(e) => {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Failed to register global shortcut")
                        .body(&e)
                        .icon("Gloss")
                        .show();
                }
            }
            start_hotkey_suppression(app.handle().clone());
            if let Err(e) = apply_proxy() {
                warn!("Failed to apply the proxy setting: {e}");
            }
            // Check Update
            check_update(app.handle().clone());
            if let Some(engine) = get("translate_detect_engine") {
                if engine.as_str().unwrap() == "local" {
                    init_lang_detect();
                }
            }
            let clipboard_monitor = match get("clipboard_monitor") {
                Some(v) => v.as_bool().unwrap(),
                None => {
                    set("clipboard_monitor", false);
                    false
                }
            };
            app.manage(ClipboardMonitorEnableWrapper(Mutex::new(
                clipboard_monitor.to_string(),
            )));
            start_clipboard_monitor(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reload_store,
            get_text,
            get_replace_selection,
            replace_selection,
            translate_text,
            cut_image,
            get_base64,
            copy_img,
            system_ocr,
            system_ocr_layout,
            system_tts,
            system_tts_voices,
            get_system_proxy,
            edge_tts,
            edge_tts_voices,
            run_binary,
            open_devtools,
            register_shortcut_by_frontend,
            update_hotkey_suppressed_processes,
            list_running_processes,
            get_hotkey_suppression_status,
            update_tray,
            updater_window,
            screenshot,
            lang_detect,
            webdav,
            local,
            install_plugin,
            write_user_file,
            read_user_file,
            font_list,
            aliyun
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // 窗口关闭不退出
        .run(|_app_handle, event| {
            // Only the last window closing is prevented. Tauri 2 also routes
            // `AppHandle::exit`/`restart` through `ExitRequested`, unlike v1 where
            // they exited directly, so preventing those too left the tray's Quit
            // and Restart items doing nothing. `code` tells the two apart: `None`
            // is user interaction, `Some` is a programmatic exit.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
