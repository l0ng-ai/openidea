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
//! only ever reads the file. On other platforms the file is left alone and
//! the plugin does both.

use crate::windows;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::utils::config::WindowConfig;

/// The plugin's state file in the app config directory, keyed by window label.
const STATE_FILE: &str = ".window-state.json";
/// Where [`STATE_FILE`] is moved at startup, so a session that crashes before
/// the plugin's exit save still leaves the last geometry readable.
const STATE_BACKUP: &str = ".window-state.json.bak";

/// Geometry of one window as the plugin saved it, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

impl Geometry {
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
    /// Reads the plugin's state file and moves it aside so the plugin starts
    /// this session with nothing to restore. Prefers the live file, falling
    /// back to [`STATE_BACKUP`] left by a session that crashed before its
    /// exit save.
    pub fn take(config_dir: &Path) -> Self {
        let file = config_dir.join(STATE_FILE);
        let backup = config_dir.join(STATE_BACKUP);
        let states = read(&file).or_else(|| read(&backup)).unwrap_or_default();
        if let Err(e) = std::fs::rename(&file, &backup)
            && !matches!(e.kind(), std::io::ErrorKind::NotFound)
        {
            tracing::warn!("cannot move {STATE_FILE} aside; window-state may still restore a broken size: {e}");
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
    (backend.is_empty() || backend.starts_with("wayland"))
        && std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

/// Applies remembered `geometry` to `config` before the window is built: the
/// size (physical pixels become logical for `scale_factor`) and the
/// maximized/fullscreen state. Position is not restored — Wayland's
/// compositor places windows itself.
pub fn apply(config: &mut WindowConfig, geometry: Geometry, scale_factor: f64) {
    (config.width, config.height) = geometry
        .logical_size(scale_factor, (config.min_width.unwrap_or_default(), config.min_height.unwrap_or_default()));
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

/// Keeps the fields we restore, dropping windows that were never sized.
fn geometry(states: impl IntoIterator<Item = (String, SavedState)>) -> HashMap<String, Geometry> {
    states
        .into_iter()
        .filter(|(_, s)| s.width > 0 && s.height > 0)
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
    fn reads_the_plugin_file_and_skips_empty_entries() {
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
        assert!(!states.contains_key("stale"));
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

    #[test]
    fn take_moves_the_file_aside_and_recovers_the_backup() {
        let dir = std::env::temp_dir().join(format!("openidea-geometry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::remove_file(dir.join(STATE_BACKUP)).ok();

        std::fs::write(dir.join(STATE_FILE), r#"{ "main": { "width": 1386, "height": 1015, "maximized": true } }"#)
            .unwrap();
        let remembered = RememberedGeometry::take(&dir);
        assert!(remembered.get("main").unwrap().maximized);
        // The plugin will find no state to restore…
        assert!(!dir.join(STATE_FILE).exists());
        // …but a crashed session still can.
        assert!(dir.join(STATE_BACKUP).exists());

        // No live file (crash before the exit save): the backup is read.
        let recovered = RememberedGeometry::take(&dir);
        assert_eq!(recovered.get("main").unwrap().width, 1386);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
