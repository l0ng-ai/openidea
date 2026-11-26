//! Locating an installed Unreal Engine.
//!
//! A launcher install registers its directory per version under `HKLM` and a source build under
//! `HKCU`, keyed by whatever the `.uproject`'s `EngineAssociation` names.

use std::path::PathBuf;

/// A registered engine, keyed by whatever the machine calls it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineInstall {
    /// `5.8` for a launcher install, a GUID-like key for a source build.
    pub id: String,
    pub root: PathBuf,
}

impl EngineInstall {
    /// The editor executable, which runs every start-up mode.
    pub fn editor(&self) -> PathBuf {
        self.root.join("Engine").join("Binaries").join("Win64").join("UnrealEditor.exe")
    }
}

/// The engine `association` names, following Unreal's own lookup: the association is the key a
/// registered directory is stored under, so an unknown or empty one locates nothing.
pub fn locate(association: Option<&str>) -> Option<EngineInstall> {
    pick(installed(), association)
}

fn pick(installs: Vec<EngineInstall>, association: Option<&str>) -> Option<EngineInstall> {
    let id = association?;
    // A registered directory that is gone is a leftover from an uninstalled engine.
    installs.into_iter().find(|i| i.id.eq_ignore_ascii_case(id) && i.root.is_dir())
}

#[cfg(windows)]
fn installed() -> Vec<EngineInstall> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let mut out = Vec::new();
    if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\EpicGames\Unreal Engine") {
        for id in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey(&id) else { continue };
            let Ok(dir) = sub.get_value::<String, _>("InstalledDirectory") else { continue };
            if !dir.trim().is_empty() {
                out.push(EngineInstall { id, root: PathBuf::from(dir) });
            }
        }
    }
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"SOFTWARE\Epic Games\Unreal Engine\Builds") {
        for (id, _) in key.enum_values().flatten() {
            let Ok(dir) = key.get_value::<String, _>(&id) else { continue };
            if !dir.trim().is_empty() {
                out.push(EngineInstall { id, root: PathBuf::from(dir) });
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn installed() -> Vec<EngineInstall> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake install whose directory exists, so `pick` treats it as usable.
    fn install(dir: &std::path::Path, id: &str) -> EngineInstall {
        let root = dir.join(format!("UE_{id}"));
        std::fs::create_dir_all(root.join("Engine/Binaries/Win64")).unwrap();
        EngineInstall { id: id.to_owned(), root }
    }

    #[test]
    fn the_association_picks_that_install_and_nothing_else() {
        let temp = tempfile::tempdir().unwrap();
        let installs = vec![install(temp.path(), "5.8"), install(temp.path(), "5.3")];
        assert_eq!(pick(installs.clone(), Some("5.3")).unwrap().id, "5.3");
        assert_eq!(pick(installs, Some("4.27")), None);
        assert_eq!(pick(Vec::new(), None), None);
    }

    #[test]
    fn a_registered_engine_that_was_deleted_is_not_picked() {
        let temp = tempfile::tempdir().unwrap();
        let ghost = EngineInstall { id: "5.8".to_owned(), root: temp.path().join("gone") };
        assert_eq!(pick(vec![ghost], Some("5.8")), None);
    }
}
