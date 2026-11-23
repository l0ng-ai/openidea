//! Locating an installed Unreal Engine.
//!
//! A launcher install registers its directory per version under `HKLM` and a source build under
//! `HKCU`, but a project sitting inside an engine tree names no association at all — its engine
//! is simply the one above it, which is why `locate` also looks upwards.

use std::path::{Path, PathBuf};

/// A registered engine, keyed by whatever the machine calls it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineInstall {
    /// `5.8` for a launcher install, a GUID for a source build.
    pub id: String,
    pub root: PathBuf,
}

impl EngineInstall {
    /// The editor executable, which runs every start-up mode.
    pub fn editor(&self) -> PathBuf {
        self.root.join("Engine").join("Binaries").join("Win64").join("UnrealEditor.exe")
    }
}

/// The engine for `association` (the `.uproject`'s `EngineAssociation`), else the source build
/// above `project`, else the newest registered install.
pub fn locate(association: Option<&str>, project: &Path) -> Option<EngineInstall> {
    // No association names no install: such a project is parked inside its own engine tree.
    if association.is_none_or(|id| id.trim().is_empty())
        && let Some(found) = in_place(project)
    {
        return Some(found);
    }
    pick(installed(), association)
}

/// The nearest ancestor holding `Engine/Build/Build.version`, which only an engine tree has.
fn in_place(project: &Path) -> Option<EngineInstall> {
    let root = project.ancestors().skip(1).find(|dir| version_file(dir).is_file())?;
    let id = version(root).unwrap_or_else(|| "source".to_owned());
    Some(EngineInstall { id, root: root.to_path_buf() })
}

/// `Engine/Build/Build.version` of an engine tree.
fn version_file(root: &Path) -> PathBuf {
    root.join("Engine").join("Build").join("Build.version")
}

/// `5.8` from the engine's own `Build.version`.
fn version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(version_file(root)).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let major = json.get("MajorVersion")?.as_u64()?;
    let minor = json.get("MinorVersion")?.as_u64()?;
    Some(format!("{major}.{minor}"))
}

fn pick(installs: Vec<EngineInstall>, association: Option<&str>) -> Option<EngineInstall> {
    // A registered directory that is gone is a leftover from an uninstalled engine.
    let mut usable: Vec<EngineInstall> = installs.into_iter().filter(|i| i.root.is_dir()).collect();
    if let Some(id) = association
        && let Some(found) = usable.iter().find(|i| i.id.eq_ignore_ascii_case(id))
    {
        return Some(found.clone());
    }
    // Newest first; a source build has no version to compare and sorts last.
    usable.sort_by(|a, b| match (version_key(&a.id), version_key(&b.id)) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    usable.into_iter().next()
}

fn version_key(id: &str) -> Option<(u32, u32)> {
    let (major, minor) = id.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
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

    /// A project parked inside a source build, the way `Samples/` ships.
    fn source_build(dir: &std::path::Path, version: &str) -> (PathBuf, PathBuf) {
        let root = dir.join("EngineTree");
        let (major, minor) = version.split_once('.').unwrap();
        std::fs::create_dir_all(root.join("Engine/Build")).unwrap();
        std::fs::write(
            root.join("Engine/Build/Build.version"),
            format!(r#"{{"MajorVersion":{major},"MinorVersion":{minor},"PatchVersion":4}}"#),
        )
        .unwrap();
        let project = root.join("Samples/Games/Lyra");
        std::fs::create_dir_all(&project).unwrap();
        (root, project)
    }

    #[test]
    fn the_association_wins_over_a_newer_install() {
        let temp = tempfile::tempdir().unwrap();
        let installs = vec![install(temp.path(), "5.8"), install(temp.path(), "5.3")];
        assert_eq!(pick(installs.clone(), Some("5.3")).unwrap().id, "5.3");
        assert_eq!(pick(installs, None).unwrap().id, "5.8");
    }

    #[test]
    fn ten_is_newer_than_eight() {
        let temp = tempfile::tempdir().unwrap();
        let installs = vec![install(temp.path(), "5.8"), install(temp.path(), "5.10")];
        assert_eq!(pick(installs, Some("4.27")).unwrap().id, "5.10");
    }

    #[test]
    fn a_registered_engine_that_was_deleted_is_not_picked() {
        let temp = tempfile::tempdir().unwrap();
        let ghost = EngineInstall { id: "5.8".to_owned(), root: temp.path().join("gone") };
        assert_eq!(pick(vec![ghost], Some("5.8")), None);
    }

    #[test]
    fn a_project_inside_an_engine_tree_uses_that_engine() {
        let temp = tempfile::tempdir().unwrap();
        let (root, project) = source_build(temp.path(), "5.8");
        let found = locate(None, &project).unwrap();
        assert_eq!(found.root, root);
        assert_eq!(found.id, "5.8");
        assert_eq!(locate(Some(""), &project).unwrap().root, root);
        assert_eq!(found.editor(), root.join("Engine/Binaries/Win64/UnrealEditor.exe"));
    }
}
