use super::*;
use ide_core::FileEdit;

fn dir_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn linked_parent_and_project_root_support_asset_operations_and_undo() {
    for parent_alias in [false, true] {
        let tmp = project();
        let aliases = tempfile::tempdir().unwrap();
        let link = aliases.path().join("alias");
        let root = if parent_alias {
            dir_link(tmp.path().parent().unwrap(), &link);
            link.join(tmp.path().file_name().unwrap())
        } else {
            dir_link(tmp.path(), &link);
            link.clone()
        };
        let from = asset(&root, "Player.cs", "class Player {}", A);
        let to = root.join("Assets/New/Nested/Hero.cs");
        let docs = Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
        let moves = FileMoves::new();
        let token = moves
            .perform(
                &docs,
                None,
                &[FileMove { from: from.clone().into(), to: to.clone().into() }],
                &WorkspaceEdit::default(),
                "Move",
                &|_| Ok(()),
            )
            .unwrap();
        assert_eq!(id(&to), A);
        moves.undo(&docs, token).unwrap();
        assert_eq!(id(&from), A);
        copy(&from, &to).unwrap();
        assert_ne!(id(&to), A);
        assert_eq!(id(&from), A);
        delete_with(&to, &ide_vfs::delete_permanently).unwrap();
        assert!(!to.exists() && !meta_path(&to).exists());
        let intermediate = root.join("Assets/Intermediate.cs");
        docs.apply_workspace_edit(&WorkspaceEdit {
            files: vec![
                FileEdit::Rename { from: from.clone().into(), to: intermediate.clone().into() },
                FileEdit::Rename { from: intermediate.into(), to: to.clone().into() },
            ],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(id(&to), A);
        assert!(!from.exists() && !meta_path(&from).exists());
    }
}

#[test]
fn internal_directory_links_reject_asset_operations_before_mutation() {
    for relative in ["Assets/Linked", "Library", "Library/OpenIDEA", "Library/OpenIDEA/AssetOperations"] {
        let tmp = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("sentinel"), "keep").unwrap();
        let from = asset(tmp.path(), "Player.cs", "code", A);
        let link = tmp.path().join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        dir_link(outside.path(), &link);
        let to = if relative.starts_with("Assets") { link.join("Copy.cs") } else { from.with_file_name("Copy.cs") };
        assert!(copy(&from, &to).unwrap_err().message.contains("do not follow links"));
        if relative.starts_with("Assets") {
            assert!(rename(&from, &to).is_err());
            let docs =
                Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
            assert!(
                docs.apply_workspace_edit(&WorkspaceEdit {
                    files: vec![FileEdit::Rename { from: from.clone().into(), to: to.clone().into() },],
                    ..Default::default()
                })
                .is_err()
            );
            let sentinel = link.join("sentinel");
            assert!(
                docs.apply_workspace_edit(&WorkspaceEdit {
                    files: vec![FileEdit::Delete { path: sentinel.into(), recursive: false },],
                    ..Default::default()
                })
                .is_err()
            );
        } else {
            assert!(delete_with(&from, &|_| panic!("must reject before removal")).is_err());
        }
        assert_eq!(id(&from), A);
        assert!(from.exists() && !to.exists() && !meta_path(&to).exists());
        assert_eq!(fs::read_to_string(outside.path().join("sentinel")).unwrap(), "keep");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }
}

#[test]
fn linked_assets_root_and_recursive_copy_links_are_rejected() {
    let tmp = project();
    let outside = tempfile::tempdir().unwrap();
    fs::remove_dir(tmp.path().join("Assets")).unwrap();
    dir_link(outside.path(), &tmp.path().join("Assets"));
    let from = asset(tmp.path(), "Player.cs", "code", A);
    assert!(rename(&from, &from.with_file_name("Hero.cs")).is_err());
    assert!(deletion_paths(&from).is_err());
    assert_eq!(id(&from), A);

    let tmp = project();
    let from = asset(tmp.path(), "Group/Player.cs", "code", A);
    dir_link(outside.path(), &tmp.path().join("Assets/Group/Linked"));
    let to = tmp.path().join("Assets/Copy");
    assert!(copy(from.parent().unwrap(), &to).is_err());
    assert!(!to.exists() && !meta_path(&to).exists());
    assert_eq!(id(&from), A);
}

#[cfg(unix)]
#[test]
fn linked_asset_and_sidecar_leaves_are_rejected() {
    for sidecar in [false, true] {
        let tmp = project();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let from = asset(tmp.path(), "Player.cs", "code", A);
        let path = if sidecar { meta_path(&from) } else { from.clone() };
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside.path(), &path).unwrap();
        assert!(rename(&from, &from.with_file_name("Hero.cs")).is_err());
        assert!(copy(&from, &from.with_file_name("Copy.cs")).is_err());
        assert!(deletion_paths(&from).is_err());
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    }
}

#[test]
fn cross_project_operations_validate_each_root_and_keep_metadata() {
    let source = project();
    let destination = project();
    let aliases = tempfile::tempdir().unwrap();
    let a = aliases.path().join("source");
    let b = aliases.path().join("destination");
    dir_link(source.path(), &a);
    dir_link(destination.path(), &b);
    let from = asset(&a, "Player.cs", "code", A);
    let copied = b.join("Assets/Copied.cs");
    copy(&from, &copied).unwrap();
    assert_ne!(id(&copied), A);
    assert_eq!(id(&from), A);
    let moved = b.join("Assets/Moved.cs");
    rename(&from, &moved).unwrap();
    assert_eq!(id(&moved), A);
    assert!(!from.exists() && !meta_path(&from).exists());
}

#[test]
fn external_links_do_not_become_trusted_by_importing_into_unity() {
    let tmp = project();
    let external = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    fs::write(external.path().join("File.cs"), "code").unwrap();
    let link = aliases.path().join("external");
    dir_link(external.path(), &link);
    let from = link.join("File.cs");
    let to = tmp.path().join("Assets/Imported.cs");
    assert!(copy(&from, &to).is_err());
    assert!(rename(&from, &to).is_err());
    assert!(from.exists() && !to.exists());
}

#[test]
fn folder_rename_cannot_hide_linked_children_in_later_transaction_operations() {
    let tmp = project();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("sentinel"), "keep").unwrap();
    let from = tmp.path().join("Assets/Group");
    fs::create_dir(&from).unwrap();
    dir_link(outside.path(), &from.join("Linked"));
    let to = tmp.path().join("Assets/Moved");
    let docs = Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
    let error = docs
        .apply_workspace_edit(&WorkspaceEdit {
            files: vec![
                FileEdit::Rename { from: from.clone().into(), to: to.clone().into() },
                FileEdit::Delete {
                    path: (if cfg!(windows) { tmp.path().join("Assets/moved") } else { to.clone() })
                        .join("Linked/sentinel")
                        .into(),
                    recursive: false,
                },
            ],
            ..Default::default()
        })
        .unwrap_err();
    assert!(error.message.contains("do not follow links"));
    assert!(from.exists() && !to.exists());
    assert_eq!(fs::read_to_string(outside.path().join("sentinel")).unwrap(), "keep");
}

#[test]
fn directory_transactions_reject_nested_links_before_snapshotting() {
    for delete in [false, true] {
        let tmp = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("sentinel"), "keep").unwrap();
        let from = tmp.path().join("Assets/Group");
        fs::create_dir(&from).unwrap();
        dir_link(outside.path(), &from.join("Linked"));
        let to = tmp.path().join("Assets/Moved");
        let file = if delete {
            FileEdit::Delete { path: from.clone().into(), recursive: true }
        } else {
            FileEdit::Rename { from: from.clone().into(), to: to.clone().into() }
        };
        let docs = Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
        let error = docs.apply_workspace_edit(&WorkspaceEdit { files: vec![file], ..Default::default() }).unwrap_err();
        assert!(error.message.contains("do not follow links"));
        assert!(from.exists() && !to.exists());
        assert_eq!(fs::read_to_string(outside.path().join("sentinel")).unwrap(), "keep");
    }
}
