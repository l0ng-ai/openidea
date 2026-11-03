use super::*;
use crate::{documents::Documents, file_moves::FileMoves};
use ide_core::{LanguageId, WorkspaceEdit};
use std::sync::Arc;

const A: &str = "11111111111111111111111111111111";
const B: &str = "22222222222222222222222222222222";
const C: &str = "33333333333333333333333333333333";

fn project() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join("Assets")).unwrap();
    fs::create_dir(tmp.path().join("ProjectSettings")).unwrap();
    fs::write(tmp.path().join(super::super::VERSION_FILE), "m_EditorVersion: 6000.0.1f1").unwrap();
    tmp
}

fn asset(root: &Path, name: &str, content: &str, id: &str) -> PathBuf {
    let path = root.join("Assets").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, content).unwrap();
    fs::write(meta_path(&path), format!("fileFormatVersion: 2\r\nguid: {id}\r\nImporter:\r\n  setting: keep\r\n"))
        .unwrap();
    path
}

fn id(path: &Path) -> String {
    fs::read_to_string(meta_path(path))
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("guid: ").map(str::to_owned))
        .unwrap()
}

#[test]
fn rename_preserves_metadata_and_undo_retries_after_conflict() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "class Player {}", A);
    let dst = src.with_file_name("Hero.cs");
    let docs = Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
    let stack = FileMoves::new();
    let moves = [FileMove { from: src.clone().into(), to: dst.clone().into() }];
    let token = stack.perform(&docs, None, &moves, &WorkspaceEdit::default(), "Rename", &|_| Ok(())).unwrap();
    assert_eq!(id(&dst), A);
    assert!(!meta_path(&src).exists());
    fs::write(meta_path(&src), "conflict").unwrap();
    assert!(stack.undo(&docs, token).is_err());
    assert!(stack.can_undo(token));
    assert!(dst.exists());
    fs::remove_file(meta_path(&src)).unwrap();
    let undone = stack.undo(&docs, token).unwrap();
    assert_eq!(undone.moves.len(), 2);
    assert_eq!(id(&src), A);
    assert!(!dst.exists());
}

#[test]
fn orphan_metadata_conflicts_and_standalone_metadata_are_protected() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "code", A);
    let dst = src.with_file_name("Hero.cs");
    fs::write(meta_path(&dst), "orphan").unwrap();
    assert!(rename(&src, &dst).is_err());
    assert!(copy(&src, &dst).is_err());
    assert!(src.exists() && !dst.exists());
    assert_eq!(id(&src), A);
    assert!(rename(&meta_path(&src), &src.with_file_name("Other.meta")).is_err());
    assert!(delete_with(&meta_path(&src), &|_| panic!("must reject before deletion")).is_err());
    assert!(rename(&tmp.path().join("Assets"), &tmp.path().join("Renamed")).is_err());
}

#[test]
fn folder_copy_regenerates_guids_and_only_internal_references() {
    let tmp = project();
    let root = tmp.path();
    let text = format!(
        "%YAML 1.1\n--- !u!1 &1\nObject:\n  internal: {{fileID: 1, guid: {B}, type: 3}}\n  external: {{fileID: 2, guid: {C}, type: 3}}\n  quoted: \"guid: {B}\"\n  block: |\n    guid: {B}\n"
    );
    let src = asset(root, "Group/Scene.prefab", &text, A);
    asset(root, "Group/Script.cs", "// untouched", B);
    fs::write(root.join("Assets/Group.meta"), format!("guid: {C}\nfolderAsset: yes\n")).unwrap();
    // An actual external id not copied into Group.
    let external = "44444444444444444444444444444444";
    fs::write(
        &src,
        text.replace(&format!("external: {{fileID: 2, guid: {C}"), &format!("external: {{fileID: 2, guid: {external}")),
    )
    .unwrap();
    fs::write(root.join("Assets/Group/Assembly.asmdef"), format!(r#"{{"references":["GUID:{B}","GUID:{external}"]}}"#))
        .unwrap();
    let to = root.join("Assets/Group Copy");
    copy(&root.join("Assets/Group"), &to).unwrap();
    let script = id(&to.join("Script.cs"));
    assert_ne!(script, B);
    assert_ne!(id(&to.join("Scene.prefab")), A);
    assert_ne!(id(&to), C);
    assert_eq!(id(&src), A);
    let copied = fs::read_to_string(to.join("Scene.prefab")).unwrap();
    assert!(copied.contains(&format!("internal: {{fileID: 1, guid: {script}")));
    assert!(copied.contains(&format!("external: {{fileID: 2, guid: {external}")));
    assert!(copied.contains(&format!("quoted: \"guid: {B}\"")));
    assert!(copied.contains(&format!("block: |\n    guid: {B}")));
    assert!(fs::read_to_string(meta_path(&to.join("Script.cs"))).unwrap().contains("setting: keep\r\n"));
    let assembly = fs::read_to_string(to.join("Assembly.asmdef")).unwrap();
    assert!(assembly.contains(&format!("GUID:{script}")) && assembly.contains(external));
}

#[test]
fn invalid_or_binary_copy_never_publishes_partial_assets() {
    let tmp = project();
    let src = asset(tmp.path(), "Group/Data.asset", "binary data", A);
    let from = src.parent().unwrap();
    let to = from.with_file_name("Copy");
    assert!(copy(from, &to).is_err());
    assert!(!to.exists() && !meta_path(&to).exists());
    assert_eq!(id(&src), A);
    fs::write(&src, "%YAML 1.1\n--- !u!1 &1\n").unwrap();
    fs::write(meta_path(&src), "guid: invalid\n").unwrap();
    assert!(copy(from, &to).is_err());
    assert!(!to.exists());
}

#[test]
fn deletion_groups_sidecar_and_restores_both_on_trash_failure() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "code", A);
    assert_eq!(deletion_paths(&src).unwrap(), vec![src.clone(), meta_path(&src)]);
    let error = delete_with(&src, &|stage| {
        assert!(stage.join("files/Player.cs").exists());
        assert!(stage.join("files/Player.cs.meta").exists());
        let destinations: Vec<PathBuf> =
            serde_json::from_slice(&fs::read(stage.join("restore-paths.json")).unwrap()).unwrap();
        assert_eq!(destinations, vec![src.clone(), meta_path(&src)]);
        Err(IdeError::internal("trash unavailable"))
    })
    .unwrap_err();
    assert!(error.message.contains("trash unavailable"));
    assert!(src.exists());
    assert_eq!(id(&src), A);
    delete_with(&src, &ide_vfs::delete_permanently).unwrap();
    assert!(!src.exists() && !meta_path(&src).exists());
}

#[test]
fn selecting_both_asset_and_sidecar_does_not_move_twice() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "code", A);
    let dst = src.with_file_name("Hero.cs");
    let expanded = expand_moves(&[
        FileMove { from: src.clone().into(), to: dst.clone().into() },
        FileMove { from: meta_path(&src).into(), to: meta_path(&dst).into() },
    ])
    .unwrap();
    assert_eq!(expanded.len(), 2);
    move_files(&expanded).unwrap();
    assert_eq!(id(&dst), A);
}

#[test]
fn non_unity_operations_do_not_touch_adjacent_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("file.txt");
    let dst = tmp.path().join("copy.txt");
    fs::write(&src, "text").unwrap();
    fs::write(meta_path(&src), "unrelated").unwrap();
    copy(&src, &dst).unwrap();
    assert!(!meta_path(&dst).exists());
    rename(&src, &tmp.path().join("moved.txt")).unwrap();
    assert!(meta_path(&src).exists());
}

#[test]
fn failed_second_move_rolls_back_metadata() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "code", A);
    let meta_dst = src.with_file_name("Moved.cs.meta");
    let blocker = tmp.path().join("Assets/blocked");
    fs::write(&blocker, "not a directory").unwrap();
    let moves = [
        FileMove { from: meta_path(&src).into(), to: meta_dst.clone().into() },
        FileMove { from: src.clone().into(), to: blocker.join("Moved.cs").into() },
    ];
    assert!(move_files(&moves).is_err());
    assert_eq!(id(&src), A);
    assert!(src.exists() && !meta_dst.exists());
}

#[test]
fn yaml_scalar_text_does_not_change_reference_detection() {
    let tmp = project();
    let text = format!(
        "%YAML 1.1\n--- !u!1 &1\nObject:\n  name: Hero's Sword\n  self: {{fileID: 1, guid: {A}, type: 3}}\n  text: \"escaped \\\" guid: {A}\"\n  multiline: 'value\n    guid: {A}'\n  selfAgain: {{fileID: 1, guid: {A}, type: 3}}\n"
    );
    let src = asset(tmp.path(), "Player.prefab", &text, A);
    let dst = src.with_file_name("Copied.prefab");
    copy(&src, &dst).unwrap();
    let new_id = id(&dst);
    let copied = fs::read_to_string(&dst).unwrap();
    assert!(copied.contains(&format!("self: {{fileID: 1, guid: {new_id}")));
    assert!(copied.contains(&format!("selfAgain: {{fileID: 1, guid: {new_id}")));
    assert!(copied.contains(&format!("multiline: 'value\n    guid: {A}'")));
    assert!(copied.contains(&format!("text: \"escaped \\\" guid: {A}\"")));
}

#[cfg(windows)]
#[test]
fn case_only_rename_keeps_metadata() {
    let tmp = project();
    let src = asset(tmp.path(), "Player.cs", "code", A);
    let dst = src.with_file_name("player.cs");
    rename(&src, &dst).unwrap();
    assert_eq!(id(&dst), A);
    assert!(fs::read_dir(dst.parent().unwrap()).unwrap().any(|e| e.unwrap().file_name() == "player.cs.meta"));
}
