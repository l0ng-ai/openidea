use ide_core::CancellationToken;
use ide_vcs::Repo;
use std::{fs, path::Path, process::Command};

const POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

fn git(root: &Path, args: &[&str]) {
    // The machine's own LFS filters must not rewrite the fixture's pointer files.
    let result = Command::new("git")
        .current_dir(root)
        .args(["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.smudge=cat"])
        .args(["-c", "filter.lfs.required=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
}

#[test]
fn lists_lfs_files_still_checked_out_as_pointers() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    git(&root, &["init", "-qb", "main"]);
    git(&root, &["config", "user.name", "LFS fixture"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    fs::write(root.join(".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n").unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    for name in ["assets/model.bin", "assets/downloaded.bin", "pointer-like.txt"] {
        fs::write(root.join(name), POINTER).unwrap();
    }
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "--no-gpg-sign", "-qm", "assets"]);
    // As after `git lfs pull`: the real content replaced this pointer.
    fs::write(root.join("assets/downloaded.bin"), vec![0u8; 4096]).unwrap();

    let repo = Repo::discover(&root).unwrap().unwrap();
    assert!(repo.uses_lfs());
    let cancel = CancellationToken::default();
    assert!(repo.lfs_status(&cancel).is_err(), "untrusted projects run no LFS commands");
    repo.set_execution_allowed(true);
    // A pointer-like file outside the LFS patterns is ordinary content.
    assert_eq!(repo.lfs_status(&cancel).unwrap().pointers, ["assets/model.bin"]);

    fs::write(root.join(".gitattributes"), "*.txt text\n").unwrap();
    assert!(!repo.uses_lfs());
}
