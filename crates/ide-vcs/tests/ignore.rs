//! Runtime tests against real temporary repositories and the Git executable.
use ide_vcs::{IgnoreDestination::*, add_to_ignore};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}
struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "core.excludesFile", if cfg!(windows) { "NUL" } else { "/dev/null" }]);
        Self { _tmp: tmp, root }
    }
    fn file(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "data\n").unwrap();
        path
    }
    fn ignored(&self, rel: &str) {
        assert!(!git(&self.root, &["check-ignore", "--", &format!("./{rel}")]).is_empty());
        assert!(
            git(&self.root, &["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", rel])
                .is_empty()
        );
    }
}

#[test]
fn shared_literals_multiselect_and_directory_are_anchored() {
    let fx = Fixture::new();
    let mut names = vec!["has space", "#hash", "!bang", "[ab].txt", "-dash", "中文.txt"];
    // Win32 filenames cannot contain wildcard characters or end in a space.
    if cfg!(unix) {
        names.extend(["has space ", "[ab]*?.txt", ":(top)literal", ":!literal", ":(glob)*"]);
    }
    let mut paths: Vec<_> = names.iter().map(|n| fx.file(n)).collect();
    fx.file("literal");
    fx.file("cache/a.txt");
    fx.file("other/cache/a.txt");
    paths.push(fx.root.join("cache"));
    for name in &names {
        fx.file(&format!("other/{name}"));
    }
    add_to_ignore(&paths, Gitignore).unwrap();
    for name in &names {
        fx.ignored(name);
    }
    fx.ignored("cache/a.txt");
    let status = git(&fx.root, &["status", "--porcelain", "--untracked-files=all"]);
    assert!(status.contains("other/cache/a.txt"));
    assert!(status.contains("other/!bang"));
    assert!(status.lines().any(|line| line == "?? literal"));
    let text = std::fs::read_to_string(fx.root.join(".gitignore")).unwrap();
    assert!(text.contains("/cache/\n"));
    assert!(text.contains("/\\[ab\\].txt\n"));
    if cfg!(unix) {
        assert!(text.contains("/\\[ab\\]\\*\\?.txt\n"));
    }
}

#[test]
fn local_exclude_is_local_preserves_comments_crlf_and_deduplicates() {
    let fx = Fixture::new();
    let path = fx.file("private.txt");
    let exclude = fx.root.join(".git/info/exclude");
    std::fs::write(&exclude, "# keep this\r\n/other\r\n# no final newline").unwrap();
    add_to_ignore(&[path.clone(), path.clone()], LocalExclude).unwrap();
    let once = std::fs::read(&exclude).unwrap();
    assert_eq!(
        String::from_utf8(once.clone()).unwrap(),
        "# keep this\r\n/other\r\n# no final newline\r\n/private.txt\r\n"
    );
    add_to_ignore(&[path], LocalExclude).unwrap();
    assert_eq!(std::fs::read(&exclude).unwrap(), once);
    fx.ignored("private.txt");
    assert!(git(&fx.root, &["status", "--porcelain"]).is_empty());
    assert!(!fx.root.join(".gitignore").exists());
}

#[test]
fn nearest_existing_ignore_and_nested_repositories_use_correct_bases() {
    let fx = Fixture::new();
    let a = fx.file("pkg/deep/a.txt");
    std::fs::write(fx.root.join("pkg/.gitignore"), "# nested\n").unwrap();
    add_to_ignore(&[a], Gitignore).unwrap();
    fx.ignored("pkg/deep/a.txt");
    assert_eq!(std::fs::read_to_string(fx.root.join("pkg/.gitignore")).unwrap(), "# nested\n/deep/a.txt\n");
    assert!(!fx.root.join(".gitignore").exists());
    let b = fx.file("nested/b.txt");
    git(&fx.root.join("nested"), &["init", "-q"]);
    add_to_ignore(&[b], Gitignore).unwrap();
    assert_eq!(std::fs::read_to_string(fx.root.join("nested/.gitignore")).unwrap(), "/b.txt\n");
    assert!(!fx.root.join(".gitignore").exists());
}

#[test]
fn tracked_files_and_directories_fail_before_any_write() {
    let fx = Fixture::new();
    let tracked = fx.file("dir/tracked");
    let new = fx.file("new");
    git(&fx.root, &["add", "dir/tracked"]);
    for path in [tracked, fx.root.join("dir")] {
        let error = add_to_ignore(&[new.clone(), path], Gitignore).unwrap_err();
        assert!(error.message.contains("tracked files"));
        assert!(!fx.root.join(".gitignore").exists());
    }
    assert!(git(&fx.root, &["diff", "--cached", "--name-only"]).contains("dir/tracked"));
}

#[test]
fn worktree_and_submodule_git_files_resolve_common_exclude() {
    let fx = Fixture::new();
    fx.file("initial");
    git(&fx.root, &["add", "initial"]);
    git(
        &fx.root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "initial",
        ],
    );
    let worktree = fx.root.parent().unwrap().join("linked");
    git(&fx.root, &["worktree", "add", "-qb", "linked", worktree.to_str().unwrap()]);
    let p = worktree.join("private");
    std::fs::write(&p, "x").unwrap();
    add_to_ignore(&[p], LocalExclude).unwrap();
    assert!(std::fs::read_to_string(fx.root.join(".git/info/exclude")).unwrap().contains("/private\n"));
    assert_eq!(git(&worktree, &["check-ignore", "private"]), "private\n");
    assert!(git(&worktree, &["status", "--porcelain"]).is_empty());
    // A real gitfile layout like a submodule, with metadata outside its worktree.
    let sub = fx.root.join("sub");
    std::fs::create_dir(&sub).unwrap();
    let metadata = fx.root.join(".git/modules/sub");
    std::fs::create_dir_all(metadata.parent().unwrap()).unwrap();
    git(&sub, &["init", "-q", "--separate-git-dir", metadata.to_str().unwrap()]);
    std::fs::write(sub.join("tracked"), "x").unwrap();
    git(&sub, &["add", "tracked"]);
    git(
        &sub,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "submodule initial",
        ],
    );
    let commit = git(&sub, &["rev-parse", "HEAD"]);
    std::fs::write(
        fx.root.join(".gitmodules"),
        "[submodule \"sub\"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n",
    )
    .unwrap();
    git(&fx.root, &["update-index", "--add", "--cacheinfo", "160000", commit.trim(), "sub"]);
    assert!(add_to_ignore(std::slice::from_ref(&sub), LocalExclude).unwrap_err().message.contains("tracked files"));
    std::fs::write(sub.join("private"), "x").unwrap();
    add_to_ignore(&[sub.join("private")], LocalExclude).unwrap();
    assert!(std::fs::read_to_string(metadata.join("info/exclude")).unwrap().contains("/private\n"));
    assert_eq!(git(&sub, &["check-ignore", "private"]), "private\n");
}

#[test]
fn lock_failure_invalid_destination_and_traversal_preserve_data() {
    let fx = Fixture::new();
    let path = fx.file("new");
    let file = fx.root.join(".gitignore");
    std::fs::write(&file, "# original\n").unwrap();
    std::fs::write(fx.root.join(".gitignore.lock"), "another writer").unwrap();
    assert!(add_to_ignore(std::slice::from_ref(&path), Gitignore).unwrap_err().message.contains("locked"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# original\n");
    assert_eq!(std::fs::read_to_string(fx.root.join(".gitignore.lock")).unwrap(), "another writer");
    assert!(add_to_ignore(&[fx.root.join("dir/../new")], Gitignore).is_err());
    std::fs::remove_file(fx.root.join(".gitignore.lock")).unwrap();
    std::fs::write(&file, b"# invalid\xff").unwrap();
    assert!(add_to_ignore(&[path], Gitignore).is_err());
    assert_eq!(std::fs::read(file).unwrap(), b"# invalid\xff");
    assert!(!fx.root.join(".gitignore.lock").exists());
}

#[cfg(unix)]
#[test]
fn backslash_is_literal_newlines_and_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let fx = Fixture::new();
    let backslash = fx.file("back\\slash");
    add_to_ignore(&[backslash], Gitignore).unwrap();
    fx.ignored("back\\slash");
    let original = std::fs::read(fx.root.join(".gitignore")).unwrap();
    for name in ["line\nname", "line\rname"] {
        let path = fx.file(name);
        assert!(add_to_ignore(&[path], Gitignore).is_err());
    }
    let outside = fx.root.parent().unwrap().join("outside");
    std::fs::write(&outside, "safe").unwrap();
    std::fs::remove_file(fx.root.join(".gitignore")).unwrap();
    symlink(&outside, fx.root.join(".gitignore")).unwrap();
    assert!(add_to_ignore(&[fx.file("new")], Gitignore).is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "safe");
    std::fs::remove_file(fx.root.join(".gitignore")).unwrap();
    std::fs::write(fx.root.join(".gitignore"), &original).unwrap();
    symlink(fx.root.parent().unwrap(), fx.root.join("link")).unwrap();
    assert!(add_to_ignore(&[fx.root.join("link/outside")], LocalExclude).is_err());
    assert_eq!(std::fs::read(fx.root.join(".gitignore")).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn symlink_leaf_is_ignored_by_name_without_a_directory_slash() {
    use std::os::unix::fs::symlink;
    let fx = Fixture::new();
    let target = fx.root.join("real");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("a.txt"), "x").unwrap();
    let link = fx.root.join("link-dir");
    symlink(&target, &link).unwrap();
    add_to_ignore(std::slice::from_ref(&link), Gitignore).unwrap();
    assert_eq!(std::fs::read_to_string(fx.root.join(".gitignore")).unwrap(), "/link-dir\n");
    fx.ignored("link-dir");
    // Already covered: nothing is written and no link is refused.
    add_to_ignore(&[link], Gitignore).unwrap();
    assert_eq!(std::fs::read_to_string(fx.root.join(".gitignore")).unwrap(), "/link-dir\n");
}

#[cfg(windows)]
#[test]
fn junction_leaf_is_ignored_by_name_without_a_directory_slash() {
    let fx = Fixture::new();
    let target = fx.root.join("real");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("a.txt"), "x").unwrap();
    let link = fx.root.join("_exp");
    let created = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(created.success(), "mklink /J failed");
    add_to_ignore(std::slice::from_ref(&link), Gitignore).unwrap();
    assert_eq!(std::fs::read_to_string(fx.root.join(".gitignore")).unwrap(), "/_exp\n");
    fx.ignored("_exp");
    // Already covered by a directory rule, as in project trees that ignore every `_*` directory.
    std::fs::write(fx.root.join(".gitignore"), "_*/\n").unwrap();
    add_to_ignore(&[link], Gitignore).unwrap();
    assert_eq!(std::fs::read_to_string(fx.root.join(".gitignore")).unwrap(), "_*/\n");
    fx.ignored("_exp");
}

#[test]
fn overridden_local_rule_is_not_duplicated_and_explains_precedence() {
    let fx = Fixture::new();
    let path = fx.file("private");
    std::fs::write(fx.root.join(".gitignore"), "!/private\n").unwrap();
    let error = add_to_ignore(std::slice::from_ref(&path), LocalExclude).unwrap_err();
    assert!(error.message.contains("higher-priority"));
    let exclude = fx.root.join(".git/info/exclude");
    let once = std::fs::read(&exclude).unwrap();
    assert!(add_to_ignore(&[path], LocalExclude).is_err());
    assert_eq!(std::fs::read(exclude).unwrap(), once);
}

#[test]
fn readonly_and_nonfile_destinations_remain_untouched() {
    let fx = Fixture::new();
    let path = fx.file("new");
    let file = fx.root.join(".gitignore");
    std::fs::create_dir(&file).unwrap();
    assert!(add_to_ignore(std::slice::from_ref(&path), Gitignore).is_err());
    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, "# original\n").unwrap();
    let original = std::fs::metadata(&file).unwrap().permissions();
    let mut permissions = original.clone();
    permissions.set_readonly(true);
    std::fs::set_permissions(&file, permissions).unwrap();
    let result = add_to_ignore(&[path], Gitignore);
    std::fs::set_permissions(&file, original).unwrap();
    assert!(result.unwrap_err().message.contains("read-only"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "# original\n");
}

#[test]
fn existing_bytes_are_preserved_for_newline_and_bom_variants() {
    for original in [b"# comment".as_slice(), b"unrelated\\", b"\xef\xbb\xbf# BOM\r\n", b"# LF\n", b""] {
        let fx = Fixture::new();
        let path = fx.file("new");
        let file = fx.root.join(".gitignore");
        std::fs::write(&file, original).unwrap();
        add_to_ignore(&[path], Gitignore).unwrap();
        assert!(std::fs::read(file).unwrap().starts_with(original));
        fx.ignored("new");
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_paths_are_rejected_without_creating_ignore_files() {
    use std::os::unix::ffi::OsStringExt;
    let fx = Fixture::new();
    let path = fx.root.join(std::ffi::OsString::from_vec(b"invalid\xff".to_vec()));
    // APFS rejects creation of this filename; the request must fail clearly before I/O.
    assert!(add_to_ignore(&[path], Gitignore).unwrap_err().message.contains("UTF-8"));
    assert!(!fx.root.join(".gitignore").exists());
}

#[test]
fn later_negations_allow_reignoring_shared_and_local_paths_without_batch_duplicates() {
    for destination in [Gitignore, LocalExclude] {
        let fx = Fixture::new();
        let path = fx.file("private");
        let file = match destination {
            Gitignore => fx.root.join(".gitignore"),
            LocalExclude => fx.root.join(".git/info/exclude"),
        };
        std::fs::write(&file, "/private\n!/private\n").unwrap();
        assert!(git(&fx.root, &["status", "--porcelain", "--untracked-files=all"]).contains("private"));
        add_to_ignore(&[path.clone(), path.clone()], destination).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "/private\n!/private\n/private\n");
        fx.ignored("private");
        let once = std::fs::read(&file).unwrap();
        add_to_ignore(&[path], destination).unwrap();
        assert_eq!(std::fs::read(file).unwrap(), once);
    }
}
