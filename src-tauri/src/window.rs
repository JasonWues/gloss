use std::fs;

use crate::config::get;
use crate::config::set;
use crate::LockExt;
use crate::ReplaceSelectionWrapper;
use crate::StringWrapper;
use crate::APP;
use dirs::cache_dir;
use log::{info, warn};
use tauri::Emitter;
use tauri::Listener;
use tauri::Manager;
use tauri::Monitor;
use tauri::WebviewWindow;
use tauri::WebviewWindowBuilder;

// Get daemon window instance
fn get_daemon_window() -> WebviewWindow {
    let app_handle = APP.get().unwrap();
    match app_handle.get_webview_window("daemon") {
        Some(v) => v,
        None => {
            warn!("Daemon window not found, create new daemon window!");
            WebviewWindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WebviewUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .visible(false)
            .build()
            .unwrap()
        }
    }
}

// Mouse physical position, relative to the top-left corner of the desktop.
pub fn get_mouse_position() -> tauri::PhysicalPosition<i32> {
    match APP.get().unwrap().cursor_position() {
        Ok(position) => tauri::PhysicalPosition::new(position.x as i32, position.y as i32),
        Err(e) => {
            warn!("Mouse position not found ({}), using (0, 0) as default", e);
            tauri::PhysicalPosition::new(0, 0)
        }
    }
}

// Get monitor where the mouse is currently located.
//
// `None` when the platform can report no monitor at all. That is not a bug to
// crash on: `primary_monitor` answers `Ok(None)` on a machine that genuinely has
// none right now -- an RDP session that disconnected, every display asleep, the
// moment between a hotplug removing one and the next arriving. It used to be two
// stacked `unwrap()`s, and in the branch that only runs once the cursor has
// already failed to land on any known monitor, so the fallback panicked in
// exactly the state it existed to cover.
fn get_current_monitor(x: i32, y: i32) -> Option<Monitor> {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window();
    let monitors = match daemon_window.available_monitors() {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "Failed to list monitors ({}), letting the OS place the window",
                e
            );
            return None;
        }
    };

    for m in monitors {
        let size = m.size();
        let position = m.position();

        if x >= position.x
            && x <= (position.x + size.width as i32)
            && y >= position.y
            && y <= (position.y + size.height as i32)
        {
            info!("Current Monitor: {:?}", m);
            return Some(m);
        }
    }
    warn!("Current Monitor not found, using primary monitor");
    match daemon_window.primary_monitor() {
        Ok(Some(m)) => Some(m),
        Ok(None) => {
            warn!("No primary monitor either, letting the OS place the window");
            None
        }
        Err(e) => {
            warn!(
                "Failed to get the primary monitor ({}), letting the OS place the window",
                e
            );
            None
        }
    }
}

// Creating a window on the mouse monitor
//
// `focus` is false only for the replace-selection path, which translates in a
// window that never appears. Taking focus there would be fatal rather than
// untidy: the result is delivered by synthesising Ctrl+V into whatever is in
// the foreground, so a window that steals the foreground first would paste the
// translation into itself and leave the user's selection untouched.
fn build_window(label: &str, title: &str, focus: bool) -> (WebviewWindow, bool) {
    let mouse_position = get_mouse_position();
    // `position()` on the builder is logical, the monitor reports physical, so the
    // two have to be reconciled or the window lands off-screen on a scaled setup.
    let position = get_current_monitor(mouse_position.x, mouse_position.y)
        .map(|m| m.position().to_logical::<f64>(m.scale_factor()));

    let app_handle = APP.get().unwrap();
    match app_handle.get_webview_window(label) {
        Some(v) => {
            info!("Window existence: {}", label);
            if focus {
                v.set_focus().unwrap();
            }
            (v, true)
        }
        None => {
            info!("Window not existence, Creating new window: {}", label);
            let mut builder = tauri::WebviewWindowBuilder::new(
                app_handle,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            // No `--disable-web-security`: Tauri 2 runs its IPC over
            // `http://ipc.localhost` and identifies the calling webview by the
            // request's `Origin` header, which that flag makes WebView2 drop. Every
            // `invoke` then fails with "missing Origin header". Nothing needs it
            // anymore either — all HTTP goes through the Rust http plugin.
            .focused(focus)
            .title(title)
            .visible(false);

            // Anchored to the monitor under the cursor when there is one. With
            // none to anchor to, leaving `position` unset lets the OS choose,
            // which beats forcing a coordinate that may itself be off-screen.
            if let Some(position) = position {
                builder = builder.position(position.x, position.y);
            }

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.transparent(true).decorations(false);
            }
            #[cfg(not(target_os = "linux"))]
            {
                builder = builder.shadow(label != "screenshot");
            }
            let window = builder.build().unwrap();

            let _ = window.current_monitor();
            (window, false)
        }
    }
}

pub fn config_window() {
    let (window, _exists) = build_window("config", "Config", true);
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();
    // 900 wide, not 800: the settings pages put a named gutter beside their rows,
    // so the rows themselves get ~136px less than the window is. The minimum stays
    // 800, which is still enough for the narrowest of them.
    window.set_size(tauri::LogicalSize::new(900, 600)).unwrap();
    window.center().unwrap();
    log_window_geometry(&window);
}

// The windows are transparent and undecorated, so a window that is off-screen and
// a window whose webview never rendered look exactly the same: nothing appears.
// Logging the geometry tells the two apart.
fn log_window_geometry(window: &WebviewWindow) {
    match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => info!(
            "Window '{}' placed at {:?} with size {:?}",
            window.label(),
            position,
            size
        ),
        _ => warn!("Window '{}' geometry unavailable", window.label()),
    }
}

fn translate_window() -> WebviewWindow {
    translate_window_focused(true)
}

fn translate_window_focused(focus: bool) -> WebviewWindow {
    let mut mouse_position = get_mouse_position();
    let (window, exists) = build_window("translate", "Translate", focus);
    if exists {
        return window;
    }
    window.set_skip_taskbar(true).unwrap();
    // Get Translate Window Size.
    //
    // 440x580, up from the 350x420 this shipped with. The window is a column of
    // sections now -- titlebar, source, languages, then one row per configured
    // service -- and at 420 tall a single expanded result filled it, so every
    // other service was below the fold before the first translation returned.
    //
    // These are seeded into the store on first run only, so an existing install
    // keeps whatever size it already has: this default reaches new installs, and
    // everyone else changes it by resizing with `translate_remember_window_size`
    // on, or by clearing the two keys.
    let width = match get("translate_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_width", 440);
            440
        }
    };
    let height = match get("translate_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_height", 580);
            580
        }
    };

    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();

    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();

    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };

    match position_type.as_str() {
        "mouse" => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_size_width = monitor_size.width as f64;
            let monitor_size_height = monitor_size.height as f64;
            let monitor_position = monitor.position();
            let monitor_position_x = monitor_position.x as f64;
            let monitor_position_y = monitor_position.y as f64;

            if mouse_position.x as f64 + width as f64 * dpi
                > monitor_position_x + monitor_size_width
            {
                mouse_position.x -= (width as f64 * dpi) as i32;
                if (mouse_position.x as f64) < monitor_position_x {
                    mouse_position.x = monitor_position_x as i32;
                }
            }
            if mouse_position.y as f64 + height as f64 * dpi
                > monitor_position_y + monitor_size_height
            {
                mouse_position.y -= (height as f64 * dpi) as i32;
                if (mouse_position.y as f64) < monitor_position_y {
                    mouse_position.y = monitor_position_y as i32;
                }
            }

            window
                .set_position(tauri::PhysicalPosition::new(
                    mouse_position.x,
                    mouse_position.y,
                ))
                .unwrap();
        }
        _ => {
            let position_x = match get("translate_window_position_x") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            let position_y = match get("translate_window_position_y") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            window
                .set_position(tauri::PhysicalPosition::new(
                    (position_x as f64) * dpi,
                    (position_y as f64) * dpi,
                ))
                .unwrap();
        }
    }

    window
}

/// The text the translate window will pick up, and whether its result should be
/// pasted back over the user's selection rather than shown.
///
/// One function so the two cannot drift. The flag describes how *this*
/// translation started, so every entry point that writes the text has to answer
/// it -- otherwise a replace would stay armed and the next ordinary translation
/// would type itself into whatever happened to have focus.
fn set_pending_text(text: &str, replace: bool) {
    let app_handle = APP.get().unwrap();
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock_recover().replace_range(.., text);
    let replace_state: tauri::State<ReplaceSelectionWrapper> = app_handle.state();
    *replace_state.0.lock_recover() = replace;
}

pub fn selection_translate() {
    use selection::get_text;
    // Get Selected Text
    let text = get_text();
    if !text.trim().is_empty() {
        set_pending_text(&text, false);
    }

    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

/// Translate the selection and paste the result back over it.
///
/// The window still does the translating -- that is where the services, the
/// glossary and the cache live -- it just never shows itself, and the first
/// result is sent back to `selection::set_text` instead of being displayed.
pub fn selection_replace() {
    use selection::get_text;
    let text = get_text();
    // Unlike `selection_translate`, an empty selection ends it here. That one
    // opens a window the user can type into; there is nothing to replace.
    if text.trim().is_empty() {
        info!("selection_replace: nothing selected");
        return;
    }

    set_pending_text(&text, true);
    // Unfocused, and it stays hidden: the frontend delivers the result by
    // pasting into whatever is in the foreground, which has to remain the
    // application the user selected the text in.
    let window = translate_window_focused(false);
    // No `unwrap`: this runs on a hotkey callback, where a panic takes the
    // thread down with no window ever appearing to say why.
    if let Err(e) = window.emit("new_text", text) {
        warn!("selection_replace: could not hand the text to the window: {e}");
    }
}

pub fn input_translate() {
    set_pending_text("[INPUT_TRANSLATE]", false);
    let window = translate_window();
    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };
    if position_type == "mouse" {
        window.center().unwrap();
    }

    window.emit("new_text", "[INPUT_TRANSLATE]").unwrap();
}

pub fn text_translate(text: String) {
    set_pending_text(&text, false);
    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

pub fn image_translate() {
    set_pending_text("[IMAGE_TRANSLATE]", false);
    let window = translate_window();
    window.emit("new_text", "[IMAGE_TRANSLATE]").unwrap();
}

pub fn recognize_window() {
    let (window, exists) = build_window("recognize", "Recognize", true);
    if exists {
        window.emit("new_image", "").unwrap();
        return;
    }
    let width = match get("recognize_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_width", 800);
            800
        }
    };
    let height = match get("recognize_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_height", 400);
            400
        }
    };
    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();
    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();
    window.center().unwrap();
    window.emit("new_image", "").unwrap();
}

#[cfg(not(target_os = "macos"))]
fn screenshot_window() -> WebviewWindow {
    let (window, _exists) = build_window("screenshot", "Screenshot", true);

    window.set_skip_taskbar(true).unwrap();
    #[cfg(target_os = "macos")]
    {
        let monitor = window.current_monitor().unwrap().unwrap();
        let size = monitor.size();
        window.set_decorations(false).unwrap();
        window.set_size(*size).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(true).unwrap();

    window.set_always_on_top(true).unwrap();
    window
}

pub fn ocr_recognize() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            recognize_window();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Capture first: it then runs while the overlay's webview starts up,
        // instead of after it. See `screenshot::start_capture`.
        crate::screenshot::start_capture();
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            recognize_window();
            window_.unlisten(event.id())
        });
    }
}
pub fn ocr_translate() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            image_translate();
            ();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::screenshot::start_capture();
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            image_translate();
            window_.unlisten(event.id())
        });
    }
}

#[tauri::command(async)]
pub fn updater_window() {
    let (window, _exists) = build_window("updater", "Updater", true);
    window
        .set_min_size(Some(tauri::LogicalSize::new(600, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(600, 400)).unwrap();
    window.center().unwrap();
}
