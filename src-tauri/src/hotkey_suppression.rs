//! Unregister Gloss's global shortcuts while selected processes are running.
//!
//! This deliberately unregisters the shortcuts instead of merely ignoring
//! their callbacks: the target application must receive the key combination.

use log::{info, warn};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

pub const PROCESS_LIST_CONFIG_KEY: &str = "hotkey_suppressed_processes";
pub const STATUS_EVENT: &str = "hotkey_suppression_changed";
const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RunningProcess {
    name: String,
    pids: Vec<u32>,
}

fn refresh_processes(system: &mut System) {
    // Avoid refreshing CPU, memory, command lines, environment, users and
    // executable metadata; the monitor and picker only need names and PIDs.
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
}

fn running_processes(system: &System) -> Vec<RunningProcess> {
    let mut processes: std::collections::BTreeMap<String, Vec<u32>> = Default::default();
    for (pid, process) in system.processes() {
        if let Some(name) = normalize_process_name(&process.name().to_string_lossy()) {
            processes.entry(name).or_default().push(pid.as_u32());
        }
    }
    processes
        .into_iter()
        .map(|(name, mut pids)| {
            pids.sort_unstable();
            RunningProcess { name, pids }
        })
        .collect()
}

/// Snapshot only on demand: the settings dialog does not make the background
/// monitor's one-second process scan more frequent.
#[tauri::command(async)]
pub fn list_running_processes() -> Vec<RunningProcess> {
    let mut system = System::new();
    refresh_processes(&mut system);
    running_processes(&system)
}

struct Monitor {
    process_names: Mutex<Vec<String>>,
    wake: Condvar,
}

static MONITOR: OnceLock<Monitor> = OnceLock::new();

impl Monitor {
    fn lock(&self) -> MutexGuard<'_, Vec<String>> {
        // Only whole-value replacements happen under this lock. Recovering the
        // value is therefore safer than leaving process monitoring disabled.
        self.process_names.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn monitor() -> &'static Monitor {
    MONITOR.get_or_init(|| Monitor {
        process_names: Mutex::new(Vec::new()),
        wake: Condvar::new(),
    })
}

/// Match a basename, never a substring. Accepting a path in the settings is a
/// convenience, but the final comparison is still against the executable name.
fn normalize_process_name(value: &str) -> Option<String> {
    let name = value
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    (!name.is_empty()).then_some(name)
}

fn normalize_process_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut names: Vec<String> = values
        .iter()
        .filter_map(|value| normalize_process_name(value))
        .filter(|value| seen.insert(value.clone()))
        .collect();
    names.sort();
    names
}

fn configured_process_list() -> Vec<String> {
    let values = crate::config::get(PROCESS_LIST_CONFIG_KEY)
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    normalize_process_list(values)
}

fn process_is_running(system: &System, process_names: &[String]) -> bool {
    system.processes().values().any(|process| {
        let name = process.name().to_string_lossy();
        normalize_process_name(&name).is_some_and(|name| process_names.contains(&name))
    })
}

/// Update the effective list immediately; the config page persists the same
/// list through `useConfig`. Hand-edited/restored config arrives through
/// `reload_hotkey_suppression` below.
#[tauri::command]
pub fn update_hotkey_suppressed_processes(process_names: Vec<String>) -> Vec<String> {
    let process_names = normalize_process_list(process_names);
    // Persist before waking the worker. The frontend also mirrors this through
    // useConfig for cross-window React state, but doing it here closes the gap
    // where another window's save could reload the previous list meanwhile.
    crate::config::set(PROCESS_LIST_CONFIG_KEY, process_names.clone());
    *monitor().lock() = process_names.clone();
    monitor().wake.notify_all();
    process_names
}

pub fn reload_hotkey_suppression() {
    if MONITOR.get().is_some() {
        update_hotkey_suppressed_processes(configured_process_list());
    }
}

#[tauri::command]
pub fn get_hotkey_suppression_status() -> bool {
    crate::hotkey::hotkeys_suspended()
}

fn set_suspended(app: &AppHandle, suspended: bool) {
    match crate::hotkey::set_hotkeys_suspended(app, suspended) {
        Ok(()) => {
            info!(
                "Global shortcuts {}",
                if suspended {
                    "suspended by process blocklist"
                } else {
                    "restored after process blocklist stopped matching"
                }
            );
            if let Err(error) = app.emit(STATUS_EVENT, suspended) {
                warn!("Could not publish hotkey suppression status: {error}");
            }
        }
        // Leave the previous effective state untouched. The next scan sees the
        // mismatch and retries; restoration begins by unregistering everything,
        // so a partially successful earlier attempt cannot duplicate handlers.
        Err(error) => warn!("Could not change global shortcut suppression: {error}"),
    }
}

/// Start one worker for the lifetime of the app. An empty list puts it to sleep
/// on a condvar: no process enumeration and no periodic wakeups are needed.
pub fn start_hotkey_suppression(app: AppHandle) {
    *monitor().lock() = configured_process_list();

    std::thread::spawn(move || {
        let mut system = System::new();
        loop {
            let process_names = monitor().lock().clone();
            let running = if process_names.is_empty() {
                false
            } else {
                refresh_processes(&mut system);
                process_is_running(&system, &process_names)
            };

            if running != crate::hotkey::hotkeys_suspended() {
                set_suspended(&app, running);
            }

            let state = monitor().lock();
            if state.is_empty() && !crate::hotkey::hotkeys_suspended() {
                // Spurious wakeups are harmless: the outer loop rechecks the
                // list before doing any process work.
                let _guard = monitor()
                    .wake
                    .wait(state)
                    .unwrap_or_else(|e| e.into_inner());
            } else {
                let _ = monitor()
                    .wake
                    .wait_timeout(state, POLL_INTERVAL)
                    .unwrap_or_else(|e| e.into_inner());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_names_match_case_insensitively() {
        assert_eq!(
            normalize_process_name("  Game.EXE  "),
            Some("game.exe".into())
        );
        assert_eq!(
            normalize_process_name(r"C:\Games\Game.EXE"),
            Some("game.exe".into())
        );
        assert_eq!(
            normalize_process_name("/opt/game/game"),
            Some("game".into())
        );
    }

    #[test]
    fn empty_entries_are_ignored_and_names_are_not_partial_matches() {
        assert_eq!(normalize_process_name(""), None);
        assert_eq!(normalize_process_name("   "), None);
        assert_eq!(normalize_process_name("game"), Some("game".into()));
        assert_ne!(normalize_process_name("game"), Some("my-game".into()));
    }

    #[test]
    fn running_processes_are_grouped_by_name() {
        let mut system = System::new();
        refresh_processes(&mut system);
        let processes = running_processes(&system);
        let mut names: Vec<&str> = processes
            .iter()
            .map(|process| process.name.as_str())
            .collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "process names must be unique");
        assert!(processes.iter().all(|process| !process.pids.is_empty()));
        assert!(processes.windows(2).all(|pair| pair[0].name < pair[1].name));
    }

    #[test]
    fn process_list_is_trimmed_deduplicated_and_stable() {
        assert_eq!(
            normalize_process_list(vec![
                " Zed.exe ".into(),
                "game.exe".into(),
                "GAME.EXE".into(),
                "".into(),
            ]),
            vec!["game.exe", "zed.exe"]
        );
    }
}
