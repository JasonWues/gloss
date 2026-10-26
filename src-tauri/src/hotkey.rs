use crate::config::{get, set};
use crate::window::{
    input_translate, ocr_recognize, ocr_translate, selection_replace, selection_translate,
};
use crate::{LockExt, APP};
use log::{info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// Set while a hotkey's handler is in flight, cleared when it finishes.
//
// Handlers run on the main thread, and opening a window there pumps messages, so
// the next hotkey can be delivered *inside* the handler that is still running.
// Starting a second session from there means a second `build_window` in the
// middle of one that is only half built -- and `build_window` unwraps its build,
// so the loser of that race takes the thread down with no window to show for it.
// One session at a time is enough anyway: the window the user asked for is
// already on its way.
static HOTKEY_SESSION: AtomicBool = AtomicBool::new(false);

// Process suppression and the settings page both change the same OS-global
// registrations. One lock makes unregister/register pairs atomic with respect
// to each other; the atomic lets a callback cheaply reject an event already in
// flight when suppression begins.
static HOTKEY_REGISTRATION_LOCK: Mutex<()> = Mutex::new(());
static HOTKEYS_SUSPENDED: AtomicBool = AtomicBool::new(false);

pub fn hotkeys_suspended() -> bool {
    HOTKEYS_SUSPENDED.load(Ordering::SeqCst)
}

// Holds the claim on `HOTKEY_SESSION` until the handler it belongs to is done,
// including when that handler is dropped before it ever runs.
struct Session;

impl Session {
    fn begin() -> Option<Self> {
        HOTKEY_SESSION
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        HOTKEY_SESSION.store(false, Ordering::SeqCst);
    }
}

// Hand a hotkey's work to the event loop instead of doing it in the shortcut
// callback.
//
// `tauri-plugin-global-shortcut` keeps its `shortcuts` mutex locked for the whole
// of the callback it gives us: lib.rs:417 is
// `if let Some(shortcut) = shortcuts_.lock().unwrap().get(&e.id)`, and the guard
// of an `if let` scrutinee is dropped at the end of the `if let`, so it is still
// held while the handler runs. `std::sync::Mutex` is not reentrant, so a handler
// must not pump messages while that lock is held -- and opening a webview is all
// pumping: wry waits for the WebView2 controller in
// `webview2_com::wait_with_pump`, that pump dispatches the next `WM_HOTKEY`,
// the plugin's callback locks the mutex its own thread is still holding, and the
// main thread stops for good. That is the freeze in gloss.DMP (2026-09-17
// 11:51), where "main" sits in `Mutex::lock_contended` underneath exactly that
// `if let`.
//
// The hop through the async runtime is not decoration: `run_on_main_thread` runs
// its closure *inline* when it is called from the main thread
// (tauri-runtime-wry `send_user_message`), and a hotkey callback is already
// there, so the task has to be posted from another thread for the event loop to
// pick it up once this callback has returned and released the lock.
fn run_from_event_loop<F: FnOnce() + Send + 'static>(app: &AppHandle, work: F) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = app.run_on_main_thread(work) {
            warn!("Could not hand a hotkey to the event loop: {e}");
        }
    });
}

fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + Sync + 'static,
{
    let hotkey = {
        if key.is_empty() {
            match get(name) {
                Some(v) => v.as_str().unwrap().to_string(),
                None => {
                    set(name, "");
                    String::new()
                }
            }
        } else {
            key.to_string()
        }
    };

    if !hotkey.is_empty() {
        let handler = Arc::new(handler);
        let label = name.to_string();
        let shortcut = hotkey.clone();
        match app_handle.global_shortcut().on_shortcut(
            hotkey.as_str(),
            move |app, _shortcut, event| {
                // v2 fires on both press and release, only react to the press
                if event.state != ShortcutState::Pressed || hotkeys_suspended() {
                    return;
                }
                let Some(session) = Session::begin() else {
                    info!("{label}: still opening the previous window, ignoring {shortcut}");
                    return;
                };
                let handler = Arc::clone(&handler);
                run_from_event_loop(app, move || {
                    let _session = session;
                    handler();
                });
            },
        ) {
            Ok(()) => {
                info!("Registered global shortcut: {} for {}", hotkey, name);
            }
            Err(e) => {
                warn!("Failed to register global shortcut: {} {:?}", hotkey, e);
                return Err(e.to_string());
            }
        };
    }
    Ok(())
}

// Register global shortcuts. The caller must hold HOTKEY_REGISTRATION_LOCK.
fn register_shortcut_unlocked(shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().unwrap();
    match shortcut {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            "",
        )?,
        "hotkey_selection_replace" => register(
            app_handle,
            "hotkey_selection_replace",
            selection_replace,
            "",
        )?,
        "hotkey_input_translate" => {
            register(app_handle, "hotkey_input_translate", input_translate, "")?
        }
        "hotkey_ocr_recognize" => register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?,
        "hotkey_ocr_translate" => register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?,
        "all" => {
            register(
                app_handle,
                "hotkey_selection_translate",
                selection_translate,
                "",
            )?;
            register(
                app_handle,
                "hotkey_selection_replace",
                selection_replace,
                "",
            )?;
            register(app_handle, "hotkey_input_translate", input_translate, "")?;
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?;
            register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?;
        }
        _ => {}
    }
    Ok(())
}

pub fn register_shortcut(shortcut: &str) -> Result<(), String> {
    let _guard = HOTKEY_REGISTRATION_LOCK.lock_recover();
    if hotkeys_suspended() {
        info!("Ignoring shortcut registration while process suppression is active");
        return Ok(());
    }
    register_shortcut_unlocked(shortcut)
}

/// Apply the process blocklist. Restoration first clears all registrations so
/// a failed, partially restored attempt can safely be retried one second later.
pub fn set_hotkeys_suspended(app_handle: &AppHandle, suspended: bool) -> Result<(), String> {
    let _guard = HOTKEY_REGISTRATION_LOCK.lock_recover();
    if suspended {
        HOTKEYS_SUSPENDED.store(true, Ordering::SeqCst);
        if let Err(error) = app_handle.global_shortcut().unregister_all() {
            HOTKEYS_SUSPENDED.store(false, Ordering::SeqCst);
            return Err(error.to_string());
        }
        return Ok(());
    }

    app_handle
        .global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    register_shortcut_unlocked("all")?;
    HOTKEYS_SUSPENDED.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let _guard = HOTKEY_REGISTRATION_LOCK.lock_recover();
    if hotkeys_suspended() {
        // Save the explicit value here as well as in useConfig: the latter is
        // debounced, and restoration must not be able to read the previous
        // shortcut if a blocked process exits within that debounce window.
        if matches!(
            name,
            "hotkey_selection_translate"
                | "hotkey_selection_replace"
                | "hotkey_input_translate"
                | "hotkey_ocr_recognize"
                | "hotkey_ocr_translate"
        ) {
            set(name, shortcut);
        }
        return Ok(());
    }
    let app_handle = APP.get().unwrap();
    match name {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            shortcut,
        )?,
        "hotkey_selection_replace" => register(
            app_handle,
            "hotkey_selection_replace",
            selection_replace,
            shortcut,
        )?,
        "hotkey_input_translate" => register(
            app_handle,
            "hotkey_input_translate",
            input_translate,
            shortcut,
        )?,
        "hotkey_ocr_recognize" => {
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, shortcut)?
        }
        "hotkey_ocr_translate" => {
            register(app_handle, "hotkey_ocr_translate", ocr_translate, shortcut)?
        }
        _ => {}
    }
    Ok(())
}
