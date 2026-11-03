//! Locating the Godot editor executable: the GDScript language server and debug
//! adapter run inside it, and run configurations launch games with it.
//!
//! Order: the executable chosen in settings (`tools.godot`), the search path
//! (`godot`, `godot4`, distro names), then the usual install locations per OS
//! (app bundles, Flatpak / Snap exports, Steam, Scoop / WinGet).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// The command language definitions and run configurations launch.
pub const COMMAND: &str = "godot";

pub const NOT_FOUND: &str = "Godot was not found. Install Godot 4 (https://godotengine.org/download), or set \
    the Godot executable in Settings › Languages & Frameworks › Language Servers › godot.";

/// Names Godot is installed under on the search path.
const PATH_NAMES: &[&str] = &["godot", "godot4", "godot-4", "Godot", "godot-mono", "godot4-mono"];

/// The Godot executable: `custom` (from settings) when set, else the search path,
/// else a well-known install location.
pub fn find(custom: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = custom {
        return Some(p);
    }
    find_in(&crate::exec::search_path(), &install_locations(crate::home_dir().as_deref()))
}

pub(crate) fn find_in(search: &OsStr, locations: &[PathBuf]) -> Option<PathBuf> {
    PATH_NAMES
        .iter()
        .find_map(|n| ide_run::which::find_executable(n, search))
        .or_else(|| locations.iter().find(|p| p.is_file()).cloned())
}

/// Well-known install locations, most specific first.
pub(crate) fn install_locations(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home_join = |rel: &str| home.map(|h| h.join(rel));
    if cfg!(target_os = "macos") {
        for app in ["Godot.app", "Godot_mono.app", "Godot 4.app"] {
            let rel = format!("{app}/Contents/MacOS/Godot");
            out.push(Path::new("/Applications").join(&rel));
            out.extend(home_join(&format!("Applications/{rel}")));
        }
        out.extend(home_join(
            "Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot",
        ));
    } else if cfg!(windows) {
        out.extend(home_join("scoop/shims/godot.exe"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            out.push(local.join("Microsoft/WinGet/Links/godot.exe"));
            out.push(local.join("Programs/Godot/godot.exe"));
        }
        for base in ["C:/Program Files", "C:/Program Files (x86)"] {
            out.push(Path::new(base).join("Godot/godot.exe"));
            out.push(Path::new(base).join("Steam/steamapps/common/Godot Engine/godot.windows.opt.tools.64.exe"));
        }
    } else {
        out.extend(home_join(".local/share/flatpak/exports/bin/org.godotengine.Godot"));
        out.push("/var/lib/flatpak/exports/bin/org.godotengine.Godot".into());
        out.push("/snap/bin/godot-4".into());
        out.push("/snap/bin/godot".into());
        out.extend(home_join(".local/share/Steam/steamapps/common/Godot Engine/godot.x11.opt.tools.64"));
    }
    out
}

/// A Godot project directory: it holds `project.godot`.
pub fn is_project(dir: &Path) -> bool {
    dir.join("project.godot").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_path_wins_over_install_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        let app = tmp.path().join("Godot.app/Contents/MacOS");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&app).unwrap();
        let installed = app.join("Godot");
        std::fs::write(&installed, "").unwrap();
        let search = std::env::join_paths([&bin]).unwrap();
        assert_eq!(find_in(&search, std::slice::from_ref(&installed)), Some(installed.clone()));
        let on_path = bin.join(if cfg!(windows) { "godot4.exe" } else { "godot4" });
        std::fs::write(&on_path, "").unwrap();
        assert_eq!(find_in(&search, std::slice::from_ref(&installed)), Some(on_path));
        assert_eq!(find_in(OsStr::new(""), &[tmp.path().join("missing")]), None);
    }

    #[test]
    fn custom_path_is_used_as_is() {
        assert_eq!(find(Some("/opt/godot/bin/godot".into())), Some(PathBuf::from("/opt/godot/bin/godot")));
    }

    #[test]
    fn install_locations_cover_the_platform() {
        let locations = install_locations(Some(Path::new("/home/u")));
        assert!(!locations.is_empty());
        if cfg!(target_os = "macos") {
            assert!(locations.contains(&PathBuf::from("/Applications/Godot.app/Contents/MacOS/Godot")));
            assert!(locations.contains(&PathBuf::from("/home/u/Applications/Godot.app/Contents/MacOS/Godot")));
        }
    }
}
