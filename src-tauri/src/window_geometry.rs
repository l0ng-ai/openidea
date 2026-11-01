//! Window geometry remembered by `tauri-plugin-window-state`, applied on GTK
//! Wayland before a window is built.
//!
//! There the plugin's restore (a resize issued while the compositor is still
//! negotiating the window's first configure) is dropped by GTK and even
//! collapses the window to its minimum size — every launch starts at 800×500
//! no matter what was saved (#594). Applying the remembered size to the window
//! config instead goes through GTK's default-size path, which Wayland honours.
//!
//! At startup on Wayland the plugin's state file is moved aside so the plugin
//! finds nothing to restore. It still tracks resizes and writes a fresh file
//! at exit — only its restore is broken, its save is fine — so this module
//! merges each exit save into a backup before removing the live file. On other
//! platforms the file is left alone and the plugin does both.

use crate::windows;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::utils::config::WindowConfig;

/// The plugin's state file in the app config directory, keyed by window label.
const STATE_FILE: &str = ".window-state.json";
/// Merged geometry from previous sessions, also used after a crash before
/// the plugin's exit save.
const STATE_BACKUP: &str = ".window-state.json.bak";

/// Geometry of one window as the plugin saved it, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

impl Geometry {
    pub fn has_size(self) -> bool {
        self.width > 0 && self.height > 0
    }

    /// Logical size for `scale_factor`, clamped to a window's configured minimum.
    pub fn logical_size(self, scale_factor: f64, min: (f64, f64)) -> (f64, f64) {
        (
            (f64::from(self.width) / scale_factor).round().max(min.0),
            (f64::from(self.height) / scale_factor).round().max(min.1),
        )
    }
}

/// Last session's geometry per window label; empty where the plugin restores
/// by itself (everywhere but GTK Wayland).
#[derive(Default)]
pub struct RememberedGeometry(Mutex<HashMap<String, Geometry>>);

impl RememberedGeometry {
    /// Merges the plugin's exit save into the backup, retaining windows not
    /// opened this session and normal sizes missing from maximized entries.
    /// Removes the live file only after the merged backup is safely written,
    /// so the plugin starts this session with nothing to restore.
    pub fn take(config_dir: &Path) -> Self {
        let file = config_dir.join(STATE_FILE);
        let backup = config_dir.join(STATE_BACKUP);
        let mut states = read(&backup).unwrap_or_default();
        for (label, mut live) in read(&file).unwrap_or_default() {
            if !live.has_size()
                && let Some(previous) = states.get(&label)
            {
                (live.width, live.height) = (previous.width, previous.height);
            }
            states.insert(label, live);
        }
        if file.exists() || backup.exists() {
            if let Err(e) = write_backup(&backup, &states) {
                tracing::warn!("cannot save {STATE_BACKUP}; leaving {STATE_FILE} in place: {e}");
            } else if let Err(e) = std::fs::remove_file(&file)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("cannot remove {STATE_FILE}; window-state may still restore a broken size: {e}");
            }
        }
        Self(Mutex::new(states))
    }

    /// The geometry remembered for window `label`, if any. Settings windows
    /// share one entry, mirroring the label mapping the plugin is configured
    /// with (see `lib.rs`).
    pub fn get(&self, label: &str) -> Option<Geometry> {
        let key = if windows::is_settings_window(label) { "settings" } else { label };
        self.0.lock().get(key).copied()
    }
}

/// Whether GTK will use Wayland, where the plugin's restore resize is dropped.
/// `GDK_BACKEND` naming another backend overrides the session type.
pub fn is_wayland() -> bool {
    let backend = std::env::var("GDK_BACKEND").unwrap_or_default();
    cfg!(target_os = "linux")
        && (backend.is_empty() || backend.starts_with("wayland"))
        && std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

/// Applies remembered `geometry` to `config` before the window is built: the
/// size (physical pixels become logical for `scale_factor`) and the
/// maximized/fullscreen state. Position is not restored — Wayland's
/// compositor places windows itself.
pub fn apply(config: &mut WindowConfig, geometry: Geometry, scale_factor: f64) {
    if geometry.has_size() {
        (config.width, config.height) = geometry
            .logical_size(scale_factor, (config.min_width.unwrap_or_default(), config.min_height.unwrap_or_default()));
    }
    config.maximized |= geometry.maximized;
    config.fullscreen |= geometry.fullscreen;
}

/// One entry of the plugin's state file; fields it lacks or we don't know are
/// defaulted, so newer plugin versions and partial files both parse.
#[derive(Default, Deserialize)]
#[serde(default)]
struct SavedState {
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}

fn read(path: &Path) -> Option<HashMap<String, Geometry>> {
    let json =
        std::fs::read_to_string(path).inspect_err(|e| tracing::debug!("cannot read {}: {e}", path.display())).ok()?;
    let states: HashMap<String, SavedState> =
        serde_json::from_str(&json).inspect_err(|e| tracing::debug!("cannot parse {}: {e}", path.display())).ok()?;
    Some(geometry(states))
}

fn write_backup(path: &Path, states: &HashMap<String, Geometry>) -> ide_core::IdeResult<()> {
    let json = serde_json::to_vec(states).map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    ide_vfs::write_atomic_strict(path, &json)?;
    Ok(())
}

/// Keeps window state even when the plugin has not observed a normal size yet.
fn geometry(states: impl IntoIterator<Item = (String, SavedState)>) -> HashMap<String, Geometry> {
    states
        .into_iter()
        .map(|(label, s)| {
            (label, Geometry { width: s.width, height: s.height, maximized: s.maximized, fullscreen: s.fullscreen })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(json: &str) -> HashMap<String, Geometry> {
        geometry(serde_json::from_str::<HashMap<String, SavedState>>(json).unwrap())
    }

    #[test]
    fn reads_the_plugin_file_and_keeps_unsized_entries() {
        // The shape tauri-plugin-window-state writes.
        let states = saved(
            r#"{
              "main": { "width": 1386, "height": 1015, "x": 0, "y": 0, "prev_x": 0, "prev_y": 0,
                        "maximized": false, "visible": true, "decorated": true, "fullscreen": false },
              "settings": { "width": 818, "height": 598, "maximized": true, "fullscreen": false },
              "stale": { "width": 0, "height": 0 }
            }"#,
        );
        assert_eq!(
            states.get("main"),
            Some(&Geometry { width: 1386, height: 1015, maximized: false, fullscreen: false })
        );
        // Fields the plugin adds later are ignored, missing ones defaulted.
        assert_eq!(
            states.get("settings"),
            Some(&Geometry { width: 818, height: 598, maximized: true, fullscreen: false })
        );
        assert_eq!(states.get("stale"), Some(&Geometry { width: 0, height: 0, maximized: false, fullscreen: false }));
    }

    #[test]
    fn physical_sizes_become_logical_clamped_to_the_minimum() {
        let g = Geometry { width: 1001, height: 701, maximized: false, fullscreen: false };
        assert_eq!(g.logical_size(1.0, (800.0, 500.0)), (1001.0, 701.0));
        assert_eq!(g.logical_size(2.0, (800.0, 500.0)), (800.0, 500.0));
        let hi_dpi = Geometry { width: 2002, height: 1402, maximized: false, fullscreen: false };
        assert_eq!(hi_dpi.logical_size(2.0, (800.0, 500.0)), (1001.0, 701.0));
    }

    #[test]
    fn settings_windows_share_one_entry() {
        let remembered = RememberedGeometry(Mutex::new(saved(r#"{ "settings": { "width": 818, "height": 598 } }"#)));
        assert_eq!(
            remembered.get("settings-project-1"),
            Some(Geometry { width: 818, height: 598, maximized: false, fullscreen: false })
        );
        assert_eq!(remembered.get("project-1"), None);
    }

    #[test]
    fn apply_sets_logical_size_and_window_state() {
        let mut config: WindowConfig =
            serde_json::from_str(r#"{ "label": "main", "minWidth": 800, "minHeight": 500 }"#).unwrap();
        apply(&mut config, Geometry { width: 2772, height: 1402, maximized: true, fullscreen: false }, 2.0);
        assert_eq!((config.width, config.height), (1386.0, 701.0));
        assert!(config.maximized);
        assert!(!config.fullscreen);
    }

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::var_os("OPENIDEA_GEOMETRY_TEST_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let path = root.join(format!("openidea-geometry-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, filename: &str, states: serde_json::Value) {
            std::fs::write(self.0.join(filename), serde_json::to_vec(&states).unwrap()).unwrap();
        }

        fn take(&self) -> RememberedGeometry {
            RememberedGeometry::take(&self.0)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    // Include all fields written by tauri-plugin-window-state 2.5.0.
    fn plugin_state(width: u32, height: u32, maximized: bool, fullscreen: bool) -> serde_json::Value {
        serde_json::json!({
            "width": width, "height": height, "x": 0, "y": 0, "prev_x": 0, "prev_y": 0,
            "maximized": maximized, "visible": true, "decorated": true, "fullscreen": fullscreen
        })
    }

    #[test]
    fn maximize_quit_launch_quit_launch_keeps_normal_size_and_state() {
        for (maximized, fullscreen) in [(true, false), (false, true)] {
            let dir = TestDir::new();
            dir.write(STATE_FILE, serde_json::json!({ "main": plugin_state(1386, 1015, false, false) }));
            assert_eq!(dir.take().get("main").unwrap().width, 1386);

            // Maximize, quit, launch, then quit while still maximized and launch again.
            for (width, height) in [(1386, 1015), (0, 0), (0, 0)] {
                dir.write(
                    STATE_FILE,
                    serde_json::json!({ "main": plugin_state(width, height, maximized, fullscreen) }),
                );
                let remembered = dir.take();
                assert_eq!(remembered.get("main"), Some(Geometry { width: 1386, height: 1015, maximized, fullscreen }));
                assert!(!dir.0.join(STATE_FILE).exists());
                // A further launch without an exit save must recover the merged backup, too.
                assert_eq!(dir.take().get("main"), remembered.get("main"));
            }
        }
    }

    #[test]
    fn session_without_settings_or_other_projects_keeps_their_geometry() {
        let dir = TestDir::new();
        dir.write(
            STATE_FILE,
            serde_json::json!({
                "main": plugin_state(1386, 1015, false, false),
                "settings": plugin_state(900, 700, false, false),
                "project-2": plugin_state(1200, 800, true, false)
            }),
        );
        let original = dir.take();
        // Only main was created in this session, so only main is in the plugin cache.
        dir.write(STATE_FILE, serde_json::json!({ "main": plugin_state(1500, 1100, false, false) }));
        for _ in 0..2 {
            let remembered = dir.take();
            assert_eq!(remembered.get("main").unwrap().width, 1500);
            assert_eq!(remembered.get("settings-project-1"), original.get("settings-main"));
            assert_eq!(remembered.get("project-2"), original.get("project-2"));
        }
    }

    #[test]
    fn live_state_overlays_flags_and_only_complete_sizes() {
        for (width, height, expected) in [(0, 700, (1200, 800)), (900, 0, (1200, 800)), (1600, 1000, (1600, 1000))] {
            let dir = TestDir::new();
            dir.write(STATE_BACKUP, serde_json::json!({ "main": plugin_state(1200, 800, true, true) }));
            dir.write(STATE_FILE, serde_json::json!({ "main": plugin_state(width, height, false, false) }));
            assert_eq!(
                dir.take().get("main"),
                Some(Geometry { width: expected.0, height: expected.1, maximized: false, fullscreen: false })
            );
        }
    }

    #[test]
    fn unsized_live_entry_keeps_defaults_but_restores_window_state() {
        let dir = TestDir::new();
        dir.write(STATE_FILE, serde_json::json!({ "main": plugin_state(0, 0, true, true) }));
        for _ in 0..2 {
            let geometry = dir.take().get("main").expect("unsized entries still carry window state");
            let mut config: WindowConfig = serde_json::from_str(
                r#"{ "label": "main", "width": 1400, "height": 900, "minWidth": 800, "minHeight": 500 }"#,
            )
            .unwrap();
            apply(&mut config, geometry, 2.0);
            assert_eq!((config.width, config.height), (1400.0, 900.0));
            assert!(config.maximized);
            assert!(config.fullscreen);
        }
    }

    #[test]
    fn malformed_file_does_not_destroy_the_other_file() {
        for (valid, malformed) in [(STATE_BACKUP, STATE_FILE), (STATE_FILE, STATE_BACKUP)] {
            let dir = TestDir::new();
            dir.write(valid, serde_json::json!({ "main": plugin_state(1386, 1015, true, false) }));
            std::fs::write(dir.0.join(malformed), "{broken").unwrap();
            for _ in 0..2 {
                assert_eq!(
                    dir.take().get("main"),
                    Some(Geometry { width: 1386, height: 1015, maximized: true, fullscreen: false })
                );
            }
        }
    }

    #[test]
    fn empty_missing_or_malformed_files_do_not_panic() {
        let dir = TestDir::new();
        assert_eq!(dir.take().get("main"), None);
        dir.write(STATE_FILE, serde_json::json!({}));
        assert_eq!(dir.take().get("main"), None);
        std::fs::write(dir.0.join(STATE_FILE), "{broken").unwrap();
        std::fs::write(dir.0.join(STATE_BACKUP), "[]").unwrap();
        assert_eq!(dir.take().get("main"), None);
    }

    #[test]
    fn failed_backup_write_leaves_the_live_file_intact() {
        let dir = TestDir::new();
        std::fs::create_dir(dir.0.join(STATE_BACKUP)).unwrap();
        let states = serde_json::json!({ "main": plugin_state(1386, 1015, true, false) });
        dir.write(STATE_FILE, states.clone());
        assert_eq!(dir.take().get("main").unwrap().width, 1386);
        let live: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.0.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(live, states);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn wayland_is_disabled_outside_linux() {
        assert!(!is_wayland());
    }

    #[test]
    fn take_moves_the_file_aside_and_recovers_the_backup() {
        let test_dir = TestDir::new();
        let dir = &test_dir.0;

        std::fs::write(dir.join(STATE_FILE), r#"{ "main": { "width": 1386, "height": 1015, "maximized": true } }"#)
            .unwrap();
        let remembered = RememberedGeometry::take(dir);
        assert!(remembered.get("main").unwrap().maximized);
        // The plugin will find no state to restore…
        assert!(!dir.join(STATE_FILE).exists());
        // …but a crashed session still can.
        assert!(dir.join(STATE_BACKUP).exists());

        // No live file (crash before the exit save): the backup is read.
        let recovered = RememberedGeometry::take(dir);
        assert_eq!(recovered.get("main").unwrap().width, 1386);
    }
}
