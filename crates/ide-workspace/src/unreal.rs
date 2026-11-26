//! Unreal Engine project identity, read from the `.uproject` at the root.
//!
//! Only the root and the engine tree are looked at: everything else in a UE project is
//! content, generated output, or engine code, and must never be walked.

pub mod engine;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// Generated directory beside the project root; excluded from the index, the search and the tree.
pub const GENERATED_DIRS: &[&str] = &["Binaries", "Intermediate", "Saved", "DerivedDataCache"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnrealProjectInfo {
    /// The engine the project builds against. `None` means none could be located, which is the
    /// only reason such a project offers no run configuration at all.
    pub engine: Option<UnrealEngine>,
}

/// A located engine, shown so a project without run configurations says why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnrealEngine {
    /// `5.8` for a launcher install, or the registry key a source build registered under.
    pub id: String,
    /// Absolute engine root.
    pub root: String,
}

/// The `.uproject` directly inside `root`, picked by name order when a folder has several.
pub fn project_file(root: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("uproject")))
        .collect();
    found.sort();
    found.into_iter().next()
}

pub fn is_project(root: &Path) -> bool {
    project_file(root).is_some()
}

pub fn detect(root: &Path) -> Option<UnrealProjectInfo> {
    let file = project_file(root)?;
    let association = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("EngineAssociation")?.as_str().map(|v| v.trim().to_owned()))
        .filter(|v| !v.is_empty());
    let engine = engine::locate(association.as_deref())
        .map(|found| UnrealEngine { id: found.id, root: found.root.to_string_lossy().into_owned() });
    Some(UnrealProjectInfo { engine })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn a_directory_holding_a_uproject_is_a_project() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("Arts.uproject"), r#"{"FileVersion":3,"EngineAssociation":"5.8","Plugins":[]}"#);
        std::fs::create_dir_all(root.join("Content")).unwrap();
        assert!(is_project(root));
        assert!(detect(root).is_some());
    }

    #[test]
    fn a_directory_without_a_uproject_is_not_a_project() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("Source/Game.Target.cs"), "");
        assert!(!is_project(temp.path()));
        assert!(detect(temp.path()).is_none());
    }
}
