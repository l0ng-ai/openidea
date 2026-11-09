use ide_workspace::file_ops;
use std::{fs, path::Path};

fn metadata_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".meta");
    name.into()
}

fn unity_project(root: &Path) {
    fs::create_dir_all(root.join("Assets")).unwrap();
    fs::create_dir_all(root.join("ProjectSettings")).unwrap();
    fs::write(root.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2022.3.40f1").unwrap();
}

fn directory_alias(target: &Path, alias: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, alias).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(alias.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn ordinary_rename_through_an_alias_keeps_vfs_same_file_behavior() {
    let dir = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    let alias = aliases.path().join("project");
    directory_alias(dir.path(), &alias);
    let from = dir.path().join("File.txt");
    let to = alias.join("File.txt");
    fs::write(&from, "keep").unwrap();
    ide_vfs::rename(&from, &to).unwrap();
    file_ops::rename(&from, &to).unwrap();
    let copied = alias.join("Copy.txt");
    file_ops::copy(&to, &copied).unwrap();
    assert_eq!(fs::read_to_string(copied).unwrap(), "keep");
    assert_eq!(fs::read_to_string(from).unwrap(), "keep");
}

#[test]
fn plain_files_and_non_assets_in_unity_keep_adjacent_metadata_untouched() {
    for unity in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        if unity {
            unity_project(dir.path());
        }
        let from = dir.path().join("File.txt");
        let copied = dir.path().join("Copy.txt");
        let renamed = dir.path().join("file.txt");
        fs::write(&from, "data").unwrap();
        fs::write(metadata_path(&from), "unrelated").unwrap();
        file_ops::copy(&from, &copied).unwrap();
        assert!(!metadata_path(&copied).exists());
        file_ops::rename(&from, &renamed).unwrap();
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "data");
        assert_eq!(file_ops::deletion_paths(&renamed).unwrap(), [renamed]);
        assert_eq!(fs::read_to_string(metadata_path(&from)).unwrap(), "unrelated");
    }
}

#[test]
fn mixed_move_and_undo_apply_rules_only_to_unity_assets() {
    use ide_core::{LanguageId, WorkspaceEdit};
    use ide_workspace::{Documents, FileMove, FileMoves};
    use std::sync::Arc;

    let unity = tempfile::tempdir().unwrap();
    unity_project(unity.path());
    let plain = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    let alias = aliases.path().join("plain");
    directory_alias(plain.path(), &alias);
    let source = unity.path().join("Assets/Player.cs");
    let destination = unity.path().join("Assets/Hero.cs");
    let ordinary = alias.join("plain.txt");
    let ordinary_to = alias.join("moved.txt");
    fs::write(&source, "class Player {}").unwrap();
    fs::write(metadata_path(&source), "guid: 11111111111111111111111111111111\n").unwrap();
    fs::write(&ordinary, "plain").unwrap();
    fs::write(metadata_path(&ordinary), "unrelated").unwrap();
    let docs = Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
    let moves = FileMoves::new();
    let token = moves
        .perform(
            &docs,
            None,
            &[
                FileMove { from: ordinary.clone().into(), to: ordinary_to.clone().into() },
                FileMove { from: source.clone().into(), to: destination.clone().into() },
            ],
            &WorkspaceEdit::default(),
            "Move",
            &|_| Ok(()),
        )
        .unwrap();
    assert!(destination.exists() && metadata_path(&destination).exists());
    assert!(ordinary_to.exists() && !metadata_path(&ordinary_to).exists());
    assert!(metadata_path(&ordinary).exists());
    moves.undo(&docs, token).unwrap();
    assert!(source.exists() && metadata_path(&source).exists());
    assert!(ordinary.exists() && metadata_path(&ordinary).exists());
    assert!(!destination.exists() && !metadata_path(&destination).exists());

    let blocker = alias.join("blocked");
    fs::write(&blocker, "not a directory").unwrap();
    assert!(
        moves
            .perform(
                &docs,
                None,
                &[
                    FileMove { from: source.clone().into(), to: destination.clone().into() },
                    FileMove { from: ordinary.clone().into(), to: blocker.join("file.txt").into() },
                ],
                &WorkspaceEdit::default(),
                "Move",
                &|_| Ok(()),
            )
            .is_err()
    );
    assert!(source.exists() && metadata_path(&source).exists());
    assert!(ordinary.exists() && metadata_path(&ordinary).exists());
    assert!(!destination.exists() && !metadata_path(&destination).exists());
}

#[test]
fn vfs_operations_remain_unaware_of_unity_metadata() {
    let dir = tempfile::tempdir().unwrap();
    unity_project(dir.path());
    let from = dir.path().join("Assets/Player.cs");
    let to = dir.path().join("Assets/Hero.cs");
    fs::write(&from, "code").unwrap();
    fs::write(metadata_path(&from), "metadata").unwrap();
    ide_vfs::rename(&from, &to).unwrap();
    assert!(to.exists() && !metadata_path(&to).exists());
    assert!(metadata_path(&from).exists());
}
