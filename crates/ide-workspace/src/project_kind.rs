//! What kind of project a root directory is.
//!
//! The question is asked once per open, from the root only: a project is not
//! recognised by scanning the tree, but by the marker its own format puts at the
//! top. Unreal comes first because an engine tree contains `Samples/**/*.uproject`
//! and generates `.sln` files of its own.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    /// A game (or plugin host) driven by a `.uproject`.
    UnrealGame,
    /// Unreal Engine source checkout: `Engine/Build/Build.version`, no `.uproject`.
    UnrealEngine,
    Unity,
    /// A .NET solution or project at the root.
    Dotnet,
    #[default]
    Other,
}

/// Classifies `root`, reading only the entries it has to.
pub fn detect(root: &Path) -> ProjectKind {
    if crate::unreal::is_project(root) {
        return ProjectKind::UnrealGame;
    }
    if crate::unreal::is_engine_root(root) {
        return ProjectKind::UnrealEngine;
    }
    if crate::unity::is_project(root) {
        return ProjectKind::Unity;
    }
    if has_dotnet_entry(root) {
        return ProjectKind::Dotnet;
    }
    ProjectKind::Other
}

/// A `.sln` / `.slnx` / `.csproj` directly under the root.
fn has_dotnet_entry(root: &Path) -> bool {
    const ENTRIES: [&str; 3] = [".sln", ".slnx", ".csproj"];
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_file())
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| ENTRIES.iter().any(|ext| name.to_ascii_lowercase().ends_with(ext)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("openidea-kind-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn write(&self, relative: &str) -> &Self {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            std::fs::write(path, b"").expect("file");
            self
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_uproject_names_the_project() {
        let dir = TempDir::new("game");
        dir.write("Game.uproject");
        assert_eq!(detect(dir.path()), ProjectKind::UnrealGame);
    }

    #[test]
    fn an_engine_checkout_is_not_a_game() {
        let dir = TempDir::new("engine");
        dir.write("Engine/Build/Build.version");
        assert_eq!(detect(dir.path()), ProjectKind::UnrealEngine);
    }

    #[test]
    fn a_game_inside_an_engine_tree_is_a_game() {
        let dir = TempDir::new("engine-game");
        dir.write("Engine/Build/Build.version");
        dir.write("Samples/Games/Lyra/Lyra.uproject");
        // Only the root is read, so the nested game does not change the answer.
        assert_eq!(detect(dir.path()), ProjectKind::UnrealEngine);
    }

    #[test]
    fn a_generated_solution_does_not_make_a_unreal_project_dotnet() {
        let dir = TempDir::new("sln");
        dir.write("Game.uproject");
        dir.write("Game.sln");
        assert_eq!(detect(dir.path()), ProjectKind::UnrealGame);
    }

    #[test]
    fn a_solution_on_its_own_is_dotnet() {
        let dir = TempDir::new("dotnet");
        dir.write("App.sln");
        assert_eq!(detect(dir.path()), ProjectKind::Dotnet);
    }

    #[test]
    fn unity_wins_over_a_generated_solution() {
        let dir = TempDir::new("unity");
        dir.write("ProjectSettings/ProjectVersion.txt");
        dir.write("Assets/Scenes/Main.unity");
        dir.write("Game.sln");
        assert_eq!(detect(dir.path()), ProjectKind::Unity);
    }

    #[test]
    fn anything_else_is_other() {
        let dir = TempDir::new("other");
        dir.write("README.md");
        assert_eq!(detect(dir.path()), ProjectKind::Other);
    }
}
