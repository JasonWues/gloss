use crate::config::StoreWrapper;
use crate::error::Error;
use crate::LockExt;
use crate::ReplaceSelectionWrapper;
use crate::StringWrapper;
use crate::APP;
use log::{error, info};
use serde_json::{json, Value};
use std::io::Read;
use tauri::Manager;

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    return state.0.lock_recover().to_string();
}

/// Whether the pending translation was started by the replace hotkey.
///
/// Read alongside `get_text`, and for the same reason: the translate window is
/// reused, so it learns about a new translation either from the `new_text`
/// event or -- on the run that created it -- by asking. Both paths need to know
/// which kind of translation this is.
#[tauri::command]
pub fn get_replace_selection(state: tauri::State<ReplaceSelectionWrapper>) -> bool {
    *state.0.lock_recover()
}

/// Paste `text` over whatever is currently selected in the foreground
/// application.
///
/// `spawn_blocking` because `set_text` is not quick: it snapshots the
/// clipboard, synthesises Ctrl+V and then waits for the paste to land before
/// putting the clipboard back. On the async runtime's own threads that would
/// park a worker for the whole of it.
#[tauri::command]
pub async fn replace_selection(text: String) -> bool {
    match tauri::async_runtime::spawn_blocking(move || selection::set_text(&text)).await {
        Ok(pasted) => pasted,
        Err(e) => {
            error!("replace_selection failed: {e}");
            false
        }
    }
}

/// Hand `text` to the translate window and bring it up, the way the clipboard
/// monitor and the local server already do.
///
/// `text_translate` clears the replace flag as a matter of course, since it
/// writes the text through `set_pending_text` -- so a translation started from
/// the history page cannot inherit a replace that was armed earlier.
///
/// `command(async)`, and that is not a nicety -- it is the same reason
/// `updater_window` carries it. A plain `#[tauri::command]` runs ON the main
/// thread, and `text_translate` builds a window, whose builder blocks until the
/// event loop services the request. The event loop is that same main thread, so
/// it deadlocks: the window is created and never finishes, and the calling
/// webview's `invoke` never resolves, wedging that window too. The clipboard
/// monitor and the local server both call `text_translate` from threads of
/// their own, which is why neither has ever met this.
#[tauri::command(async)]
pub fn translate_text(text: String) {
    crate::window::text_translate(text);
}

#[tauri::command]
pub fn reload_store() {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    state.0.reload().unwrap();
    crate::hotkey_suppression::reload_hotkey_suppression();
}

#[tauri::command]
pub fn cut_image(left: u32, top: u32, width: u32, height: u32, app_handle: tauri::AppHandle) {
    use dirs::cache_dir;
    use image::GenericImage;
    info!("Cut image: {}x{}+{}+{}", width, height, left, top);
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().identifier);
    app_cache_dir_path.push("pot_screenshot.png");
    if !app_cache_dir_path.exists() {
        return;
    }
    let mut img = match image::open(&app_cache_dir_path) {
        Ok(v) => v,
        Err(e) => {
            error!("{:?}", e.to_string());
            return;
        }
    };
    let img2 = img.sub_image(left, top, width, height);
    app_cache_dir_path.pop();
    app_cache_dir_path.push("pot_screenshot_cut.png");
    match img2.to_image().save(&app_cache_dir_path) {
        Ok(_) => {}
        Err(e) => {
            error!("{:?}", e.to_string());
        }
    }
}

#[tauri::command]
pub fn get_base64(app_handle: tauri::AppHandle) -> String {
    use base64::{engine::general_purpose, Engine as _};
    use dirs::cache_dir;
    use std::fs::File;
    use std::io::Read;
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    if !app_cache_dir_path.exists() {
        return "".to_string();
    }
    let mut file = File::open(app_cache_dir_path).unwrap();
    let mut vec = Vec::new();
    match file.read_to_end(&mut vec) {
        Ok(_) => {}
        Err(e) => {
            error!("{:?}", e.to_string());
            return "".to_string();
        }
    }
    let base64 = general_purpose::STANDARD.encode(&vec);
    base64.replace("\r\n", "")
}

#[tauri::command]
pub fn copy_img(app_handle: tauri::AppHandle) -> Result<(), Error> {
    use dirs::cache_dir;
    use image::ImageReader;
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let data = ImageReader::open(app_cache_dir_path)?.decode()?;

    // `to_rgba8`, where this used to hand over `as_bytes` unconverted. The
    // clipboard wants four channels per pixel; a PNG that decoded to anything
    // narrower -- greyscale, or RGB with no alpha -- was being read as if it
    // were RGBA, so the rows walked out of step and the paste came out as
    // noise. Screenshots are RGBA in practice, which is why it went unnoticed.
    let rgba = data.to_rgba8();
    // Dimensions from the decoded image rather than from the caller. They were
    // passed in from the `<img>`'s natural size, and the clipboard trusts them
    // to describe the buffer -- so any disagreement was read out of bounds.
    let image = tauri::image::Image::new(rgba.as_raw(), rgba.width(), rgba.height());
    app_handle.clipboard().write_image(&image)?;
    Ok(())
}

// `set_proxy` / `unset_proxy` moved to `proxy.rs`, which grew the mode handling
// and the environment capture that "follow the system" needs.

#[tauri::command]
pub fn install_plugin(path_list: Vec<String>) -> Result<i32, Error> {
    let mut success_count = 0;

    for path in path_list {
        if !path.ends_with("potext") {
            continue;
        }
        let path = std::path::Path::new(&path);
        let file_name = path.file_name().unwrap().to_str().unwrap();
        let file_name = file_name.replace(".potext", "");
        if !file_name.starts_with("plugin") {
            return Err(Error::Error(
                "Invalid Plugin: file name must start with plugin".into(),
            ));
        }

        let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        #[allow(unused_mut)]
        let mut plugin_type: String;
        if let Ok(mut info) = zip.by_name("info.json") {
            let mut content = String::new();
            info.read_to_string(&mut content)?;
            let json: serde_json::Value = serde_json::from_str(&content)?;
            plugin_type = json["plugin_type"]
                .as_str()
                .ok_or(Error::Error("can't find plugin type in info.json".into()))?
                .to_string();
        } else {
            return Err(Error::Error("Invalid Plugin: miss info.json".into()));
        }
        if zip.by_name("main.js").is_err() {
            return Err(Error::Error("Invalid Plugin: miss main.js".into()));
        }
        let config_path = dirs::config_dir().unwrap();
        let config_path =
            config_path.join(APP.get().unwrap().config().identifier.clone());
        let config_path = config_path.join("plugins");
        let config_path = config_path.join(plugin_type);
        let plugin_path = config_path.join(file_name);
        std::fs::create_dir_all(&config_path)?;
        zip.extract(&plugin_path)?;

        success_count += 1;
    }
    Ok(success_count)
}

#[tauri::command]
pub fn run_binary(
    plugin_type: String,
    plugin_name: String,
    cmd_name: String,
    args: Vec<String>,
) -> Result<Value, Error> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let config_path = dirs::config_dir().unwrap();
    let config_path = config_path.join(APP.get().unwrap().config().identifier.clone());
    let config_path = config_path.join("plugins");
    let config_path = config_path.join(plugin_type);
    let plugin_path = config_path.join(plugin_name);

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(&cmd_name);
    #[cfg(target_os = "windows")]
    let cmd = cmd.creation_flags(0x08000000);
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(&cmd_name);

    let output = cmd.args(args).current_dir(plugin_path).output()?;
    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "status": output.status.code().unwrap_or(-1),
    }))
}

#[tauri::command]
pub fn font_list() -> Result<Vec<String>, Error> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();

    Ok(source.all_families()?)
}

// The history and glossary exports write to a path the user picked in a save
// dialog, which is outside the fs plugin's `$APPCONFIG`/`$APPCACHE` scope. Going
// through a command keeps that scope closed, the same way the local backup does.
// Renamed from `export_history` when the glossary grew an export of its own --
// it was never about history, only about writing where the fs scope will not.
// Not `command(async)`: `Error` carries a `Box<dyn std::error::Error>`, which is
// not `Send`, so the generated future could not be spawned. The other commands
// returning `Error` (`install_plugin`, `run_binary`) are sync for the same reason.
#[tauri::command]
pub fn write_user_file(path: String, content: String) -> Result<(), Error> {
    std::fs::write(path, content)?;
    Ok(())
}

/// The other direction, for the glossary import.
///
/// Same reasoning as above: the path comes from an open dialog, so it is the
/// user pointing at a file rather than the page reaching for one, and the fs
/// plugin's scope stays shut.
#[tauri::command]
pub fn read_user_file(path: String) -> Result<String, Error> {
    Ok(std::fs::read_to_string(path)?)
}

#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    if !window.is_devtools_open() {
        window.open_devtools();
    } else {
        window.close_devtools();
    }
}
