//! Unreal Engine project identity, read from the `.uproject` at the root.
//!
//! Only `Source/` is looked into, one level deep: everything else in a UE project is
//! content, generated output, or engine code, and must never be walked.

pub mod engine;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// Generated directory beside the project root; excluded from the index, the search and the tree.
pub const GENERATED_DIRS: &[&str] = &["Binaries", "Intermediate", "Saved", "DerivedDataCache"];

const TARGET_SUFFIX: &str = ".Target.cs";
const MODULE_SUFFIX: &str = ".Build.cs";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnrealProjectInfo {
    /// `EngineAssociation`: a launcher version like `5.8`, a build GUID, or empty for a source build.
    pub engine_association: Option<String>,
    /// The engine the project builds against. `None` means none could be located, which is the
    /// only reason such a project offers no run configuration at all.
    pub engine: Option<UnrealEngine>,
    /// `Source/*.Target.cs` without the suffix; empty for a blueprint-only project.
    pub targets: Vec<String>,
    /// `Source/<Module>/<Module>.Build.cs` without the suffix.
    pub modules: Vec<String>,
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

/// What a target builds, from `Type = TargetType.X` in its `.Target.cs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetType {
    Editor,
    Game,
    Server,
    Client,
    Program,
}

/// A `Source/*.Target.cs`, named without the suffix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub name: String,
    pub kind: TargetType,
}

/// The `.uproject` directly inside `root`, when there is exactly one to pick from.
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

/// The root of an engine tree, which is a project in its own right: `Engine/Build/Build.version`
/// exists nowhere else. Its `.NET` programs are engine tools, so it must not be probed as one.
pub const ENGINE_VERSION_FILE: &str = "Engine/Build/Build.version";

pub fn is_engine_root(root: &Path) -> bool {
    root.join(ENGINE_VERSION_FILE).is_file()
}

pub fn detect(root: &Path) -> Option<UnrealProjectInfo> {
    let file = project_file(root)?;
    let engine_association = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("EngineAssociation")?.as_str().map(|v| v.trim().to_owned()))
        .filter(|v| !v.is_empty());
    let engine = engine::locate(engine_association.as_deref(), root)
        .map(|found| UnrealEngine { id: found.id, root: found.root.to_string_lossy().into_owned() });
    Some(UnrealProjectInfo {
        engine_association,
        engine,
        targets: targets(root).into_iter().map(|target| target.name).collect(),
        modules: source_dir(root).map(|dir| module_names(&dir)).unwrap_or_default(),
    })
}

/// `Source/*.Target.cs` one level down, with the type each one declares. A target that does not
/// say otherwise is a game target, which is also what the editor's own target files do.
pub fn targets(root: &Path) -> Vec<Target> {
    let Some(dir) = source_dir(root) else { return Vec::new() };
    names_with_suffix(&dir, TARGET_SUFFIX)
        .into_iter()
        .map(|name| {
            let kind = std::fs::read_to_string(dir.join(format!("{name}{TARGET_SUFFIX}")))
                .map(|text| target_type(&text))
                .unwrap_or(TargetType::Game);
            Target { name, kind }
        })
        .collect()
}

fn target_type(source: &str) -> TargetType {
    const TYPES: [(&str, TargetType); 4] = [
        ("TargetType.Editor", TargetType::Editor),
        ("TargetType.Server", TargetType::Server),
        ("TargetType.Client", TargetType::Client),
        ("TargetType.Program", TargetType::Program),
    ];
    TYPES.iter().find(|(text, _)| source.contains(text)).map(|(_, kind)| *kind).unwrap_or(TargetType::Game)
}

fn source_dir(root: &Path) -> Option<PathBuf> {
    let dir = root.join("Source");
    dir.is_dir().then_some(dir)
}

/// Plain files in `dir` ending in `suffix`, returned without the suffix and sorted.
fn names_with_suffix(dir: &Path, suffix: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(suffix).map(str::to_owned))
        .collect();
    names.sort();
    names
}

/// Module files live in `Source/<Module>/`; the module name is the `Build.cs` file's name.
fn module_names(source: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(source) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .flat_map(|e| names_with_suffix(&e.path(), MODULE_SUFFIX))
        .collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn a_blueprint_only_project_has_no_targets_or_modules() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("Arts.uproject"), r#"{"FileVersion":3,"EngineAssociation":"5.8","Plugins":[]}"#);
        std::fs::create_dir_all(root.join("Content")).unwrap();
        assert!(is_project(root));
        let info = detect(root).unwrap();
        assert_eq!(info.engine_association.as_deref(), Some("5.8"));
        assert!(info.targets.is_empty() && info.modules.is_empty());
    }

    #[test]
    fn targets_and_modules_come_from_one_level_of_source() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("Game.uproject"), r#"{"EngineAssociation":""}"#);
        write(&root.join("Source/Game.Target.cs"), "");
        write(&root.join("Source/GameEditor.Target.cs"), "");
        write(&root.join("Source/Game/Game.Build.cs"), "");
        write(&root.join("Source/GameEditor/GameEditor.Build.cs"), "");
        // Nested build files below a module are not modules of the project.
        write(&root.join("Source/Game/Private/Nested.Build.cs"), "");
        let info = detect(root).unwrap();
        assert_eq!(info.engine_association, None);
        assert_eq!(info.targets, ["Game", "GameEditor"]);
        assert_eq!(info.modules, ["Game", "GameEditor"]);
    }

    #[test]
    fn a_directory_without_a_uproject_is_not_a_project() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("Source/Game.Target.cs"), "");
        assert!(!is_project(temp.path()));
        assert!(detect(temp.path()).is_none());
    }

    #[test]
    fn each_target_file_declares_what_it_builds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("Game.uproject"), "{}");
        write(&root.join("Source/Game.Target.cs"), "Type = TargetType.Game;");
        write(
            &root.join("Source/GameEditor.Target.cs"),
            "public class GameEditorTarget : TargetRules { public GameEditorTarget(TargetInfo Target) : base(Target) { Type = TargetType.Editor; } }",
        );
        write(&root.join("Source/GameServer.Target.cs"), "Type = TargetType.Server;");
        write(&root.join("Source/UnrealBuildTool.Target.cs"), "Type = TargetType.Program;");
        let kinds: Vec<(String, TargetType)> = targets(root).into_iter().map(|t| (t.name, t.kind)).collect();
        assert_eq!(
            kinds,
            [
                ("Game".to_owned(), TargetType::Game),
                ("GameEditor".to_owned(), TargetType::Editor),
                ("GameServer".to_owned(), TargetType::Server),
                ("UnrealBuildTool".to_owned(), TargetType::Program),
            ]
        );
        // A target file that sets no type is a game target.
        assert_eq!(target_type("public class X { }"), TargetType::Game);
    }
}
