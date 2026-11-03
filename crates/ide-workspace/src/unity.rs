//! Unity project identity. Generated C# solutions are optional, not root markers.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Read;
use std::path::Path;

pub const VERSION_FILE: &str = "ProjectSettings/ProjectVersion.txt";
/// Root-relative caches and build outputs, including folders not created yet.
pub const GENERATED_DIRS: &[&str] = &["Library", "Temp", "Obj", "obj", "Logs", "Build", "Builds", "UserSettings"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnityProjectInfo {
    pub editor_version: Option<String>,
    /// File names relative to the Unity root, in stable order.
    pub solutions: Vec<String>,
    pub projects: Vec<String>,
}

pub fn is_project(root: &Path) -> bool {
    root.join("Assets").is_dir() && root.join(VERSION_FILE).is_file()
}

pub fn detect(root: &Path) -> Option<UnityProjectInfo> {
    if !is_project(root) {
        return None;
    }
    let mut text = String::new();
    let _ = std::fs::File::open(root.join(VERSION_FILE)).and_then(|f| f.take(64 * 1024).read_to_string(&mut text));
    let editor_version = text.lines().find_map(|line| {
        let (key, value) = line.trim_start_matches('\u{feff}').split_once(':')?;
        let value = value.trim();
        (key.trim() == "m_EditorVersion" && !value.is_empty() && value.len() <= 128).then(|| value.to_owned())
    });
    let mut info = UnityProjectInfo { editor_version, solutions: Vec::new(), projects: Vec::new() };
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.path().extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
                Some("sln" | "slnx") => info.solutions.push(name),
                Some("csproj") => info.projects.push(name),
                _ => {}
            }
        }
    }
    info.solutions.sort();
    info.projects.sort();
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_fresh_and_legacy_projects_without_packages_or_solutions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir(root.join("Assets")).unwrap();
        assert!(detect(root).is_none());
        std::fs::create_dir(root.join("ProjectSettings")).unwrap();
        std::fs::write(
            root.join(VERSION_FILE),
            "\u{feff}m_EditorVersion: 2022.3.62f1\r\nm_EditorVersionWithRevision: ignored\r\n",
        )
        .unwrap();
        let info = detect(root).unwrap();
        assert_eq!(info.editor_version.as_deref(), Some("2022.3.62f1"));
        assert!(info.solutions.is_empty() && info.projects.is_empty());
        std::fs::write(root.join("Game.sln"), "").unwrap();
        std::fs::write(root.join("Game.slnx"), "").unwrap();
        std::fs::write(root.join("Assembly-CSharp.csproj"), "").unwrap();
        std::fs::create_dir(root.join("NotAProject.csproj")).unwrap();
        let info = detect(root).unwrap();
        assert_eq!(info.solutions, ["Game.sln", "Game.slnx"]);
        assert_eq!(info.projects, ["Assembly-CSharp.csproj"]);
        std::fs::write(root.join(VERSION_FILE), "malformed").unwrap();
        assert_eq!(detect(root).unwrap().editor_version, None);
    }

    #[test]
    fn ordinary_csharp_projects_are_not_unity_projects() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("App.csproj"), "").unwrap();
        std::fs::create_dir(temp.path().join("Assets")).unwrap();
        assert!(detect(temp.path()).is_none());
    }
}
