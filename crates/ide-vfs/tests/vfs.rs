use ide_core::error::ErrorKind;
use ide_core::{IdeEvent, SharedSink};
use ide_vfs::*;
use parking_lot::Mutex;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn root() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let path = dunce::canonicalize(tmp.path()).unwrap();
    (tmp, path)
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn read_dir_sorting_and_flags() {
    let (_t, r) = root();
    fs::create_dir(r.join(".git")).unwrap();
    write(&r.join(".gitignore"), "*.log\n/build/\n");
    write(&r.join("sub/.gitignore"), "local.txt\n!keep.log\n");
    for name in ["file10.txt", "File2.txt", "file1.txt", "a.log", "B.md"] {
        write(&r.join(name), "x");
    }
    fs::create_dir(r.join("build")).unwrap();
    fs::create_dir(r.join("src")).unwrap();
    fs::create_dir(r.join("node_modules")).unwrap();
    fs::create_dir(r.join("Docs")).unwrap();
    write(&r.join("sub/local.txt"), "x");
    write(&r.join("sub/keep.log"), "x");
    write(&r.join("sub/other.log"), "x");
    write(&r.join("node_modules/pkg/index.js"), "x");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(r.join("src"), r.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(r.join("B.md"), r.join("link-file")).unwrap();
    }

    let excludes = vec!["**/node_modules".to_string(), "**/.git".to_string()];
    let entries = read_dir(&r, &excludes).unwrap();
    #[cfg_attr(not(unix), allow(unused_variables))]
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    #[cfg(unix)]
    assert_eq!(
        names,
        vec![
            ".git",
            "build",
            "Docs",
            "link-dir",
            "node_modules",
            "src",
            "sub",
            ".gitignore",
            "a.log",
            "B.md",
            "file1.txt",
            "File2.txt",
            "file10.txt",
            "link-file"
        ]
    );
    let get = |n: &str| entries.iter().find(|e| e.name == n).unwrap();
    assert!(get(".git").ignored && get(".git").hidden);
    assert!(get("build").ignored);
    assert!(get("a.log").ignored);
    assert!(get("node_modules").ignored);
    // Excluded (settings) vs only git-ignored, like IDEA's excluded folders.
    assert!(get("node_modules").excluded && get(".git").excluded);
    assert!(!get("build").excluded && !get("a.log").excluded);
    assert!(!get("src").ignored && !get("B.md").ignored && !get(".gitignore").ignored);
    assert_eq!(get("src").kind, EntryKind::Dir);
    assert_eq!(get("B.md").kind, EntryKind::File);
    assert_eq!(get("B.md").size, 1);
    assert!(get("B.md").mtime_ms > 1.0e12);
    #[cfg(unix)]
    {
        assert_eq!(get("link-dir").kind, EntryKind::Symlink);
        assert_eq!(get("link-file").kind, EntryKind::Symlink);
        assert_eq!(get("link-file").size, 1);
        assert_eq!(get("link-dir").target_kind, Some(EntryKind::Dir));
        assert_eq!(get("link-file").target_kind, Some(EntryKind::File));
        assert_eq!(get("src").target_kind, None);
        std::os::unix::fs::symlink(r.join("nowhere"), r.join("dangling")).unwrap();
        let again = read_dir(&r, &excludes).unwrap();
        let dangling = again.iter().find(|e| e.name == "dangling").unwrap();
        assert_eq!((dangling.kind, dangling.target_kind), (EntryKind::Symlink, None));
        let json = serde_json::to_value(get("src")).unwrap();
        assert_eq!(json["targetKind"], serde_json::Value::Null, "null for non-symlinks: {json}");
        let json = serde_json::to_value(get("link-dir")).unwrap();
        assert_eq!(json["targetKind"], "dir");
    }

    let sub = read_dir(&r.join("sub"), &excludes).unwrap();
    let ignored: BTreeSet<&str> = sub.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
    assert_eq!(ignored, BTreeSet::from(["local.txt", "other.log"]));

    let nm = read_dir(&r.join("node_modules"), &excludes).unwrap();
    assert!(nm.iter().all(|e| e.ignored && e.excluded), "children of excluded dirs are excluded");

    assert_eq!(read_dir(&r.join("B.md"), &excludes).unwrap_err().kind, ErrorKind::InvalidInput);
    assert_eq!(read_dir(&r.join("missing"), &excludes).unwrap_err().kind, ErrorKind::NotFound);
}

#[test]
fn load_and_save_round_trips() {
    let (_t, r) = root();
    let cases: Vec<(&str, bool, &str)> = vec![
        ("utf-8", false, "plain ascii\nüñí 😀\n"),
        ("utf-8", true, "with bom\n"),
        ("utf-16le", true, "utf16 le 中文\n"),
        ("utf-16be", true, "utf16 be 😀\n"),
        ("gbk", false, "这是一段比较长的中文文本，用于测试编码检测是否正确。\n"),
        ("shift_jis", false, "これは日本語のテキストです。エンコーディングの検出をテストします。\n"),
    ];
    for (i, (enc, bom, text)) in cases.into_iter().enumerate() {
        let path = r.join(format!("f{i}.txt"));
        let mtime = save_text(&path, text, enc, bom).unwrap();
        let loaded = load_text(&path).unwrap();
        assert_eq!(loaded.text, text, "{enc}");
        assert_eq!(loaded.encoding, enc, "{enc}");
        assert_eq!(loaded.has_bom, bom, "{enc}");
        assert!(!loaded.binary && !loaded.too_large);
        assert_eq!(loaded.mtime_ms, mtime);
    }

    let bin = r.join("bin.dat");
    fs::write(&bin, [0x89, b'P', b'N', b'G', 0, 0, 0, 13, 0xff, 0x00, 0x10]).unwrap();
    let loaded = load_text(&bin).unwrap();
    assert!(loaded.binary);
    assert!(loaded.text.is_empty());

    assert_eq!(load_text(&r.join("nope")).unwrap_err().kind, ErrorKind::NotFound);
    assert_eq!(load_text(&r).unwrap_err().kind, ErrorKind::InvalidInput);
    assert_eq!(save_text(&r.join("x"), "中", "windows-1252", false).unwrap_err().kind, ErrorKind::InvalidInput);
}

#[test]
fn large_files_are_flagged() {
    let (_t, r) = root();
    let path = r.join("big.txt");
    let line = "0123456789abcdef\n".repeat(64);
    let mut content = String::with_capacity(LARGE_FILE_THRESHOLD as usize + line.len());
    while content.len() as u64 <= LARGE_FILE_THRESHOLD {
        content.push_str(&line);
    }
    fs::write(&path, &content).unwrap();
    let loaded = load_text(&path).unwrap();
    assert!(loaded.large && !loaded.too_large);
    assert_eq!(loaded.text.len(), content.len());

    let small = r.join("small.txt");
    fs::write(&small, "x").unwrap();
    let loaded = load_text(&small).unwrap();
    assert!(!loaded.large && !loaded.too_large);

    // Sparse file: read-only threshold without writing 50 MB of data.
    let huge = r.join("huge.txt");
    let f = fs::File::create(&huge).unwrap();
    f.set_len(READ_ONLY_THRESHOLD + 1).unwrap();
    drop(f);
    let loaded = load_text(&huge).unwrap();
    // All NULs: binary; the size flags are still reported.
    assert!(loaded.large && loaded.too_large && loaded.binary);
}

#[cfg(unix)]
#[test]
fn save_preserves_permissions_and_symlinks() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, r) = root();
    let target = r.join("script.sh");
    fs::write(&target, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o751)).unwrap();
    save_text(&target, "#!/bin/sh\necho hi\n", "utf-8", false).unwrap();
    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o751);

    let link = r.join("link.sh");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    save_text(&link, "via link\n", "utf-8", false).unwrap();
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "via link\n");

    let leftovers: Vec<_> = fs::read_dir(&r)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("openidea-tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn file_operations() {
    let (_t, r) = root();
    let f = r.join("a/b/new.txt");
    create_file(&f).unwrap();
    assert!(f.is_file());
    assert_eq!(create_file(&f).unwrap_err().kind, ErrorKind::AlreadyExists);
    create_dir(&r.join("d/e")).unwrap();
    assert_eq!(create_dir(&r.join("d")).unwrap_err().kind, ErrorKind::AlreadyExists);

    fs::write(&f, "content").unwrap();
    let moved = r.join("moved/x.txt");
    rename(&f, &moved).unwrap();
    assert!(!f.exists());
    assert_eq!(fs::read_to_string(&moved).unwrap(), "content");
    fs::write(r.join("other.txt"), "o").unwrap();
    assert_eq!(rename(&moved, &r.join("other.txt")).unwrap_err().kind, ErrorKind::AlreadyExists);
    assert_eq!(rename(&r.join("missing"), &r.join("m2")).unwrap_err().kind, ErrorKind::NotFound);
    // Case-only rename.
    rename(&r.join("other.txt"), &r.join("Other.txt")).unwrap();
    assert!(fs::read_dir(&r).unwrap().any(|e| e.unwrap().file_name() == "Other.txt"));

    write(&r.join("tree/one.txt"), "1");
    write(&r.join("tree/nested/two.txt"), "2");
    copy(&r.join("tree"), &r.join("tree-copy")).unwrap();
    assert_eq!(fs::read_to_string(r.join("tree-copy/nested/two.txt")).unwrap(), "2");
    assert_eq!(copy(&r.join("tree"), &r.join("tree-copy")).unwrap_err().kind, ErrorKind::AlreadyExists);
    assert_eq!(copy(&r.join("tree"), &r.join("tree/nested/inner")).unwrap_err().kind, ErrorKind::InvalidInput);
    copy(&r.join("tree/one.txt"), &r.join("one-copy.txt")).unwrap();
    assert_eq!(fs::read_to_string(r.join("one-copy.txt")).unwrap(), "1");

    delete_permanently(&r.join("tree-copy")).unwrap();
    assert!(!r.join("tree-copy").exists());
    assert_eq!(delete_permanently(&r.join("tree-copy")).unwrap_err().kind, ErrorKind::NotFound);
}

#[test]
fn walk_honours_ignores() {
    let (_t, r) = root();
    write(&r.join(".gitignore"), "*.log\ngen/\n");
    write(&r.join("src/main.rs"), "");
    write(&r.join("src/lib.rs"), "");
    write(&r.join("app.log"), "");
    write(&r.join("gen/out.rs"), "");
    write(&r.join(".github/ci.yml"), "");
    write(&r.join("node_modules/x/index.js"), "");
    write(&r.join(".git/HEAD"), "ref: refs/heads/main\n");
    write(&r.join("deep/.ignore"), "secret.txt\n");
    write(&r.join("deep/secret.txt"), "");
    write(&r.join("deep/open.txt"), "");

    let found = Mutex::new(BTreeSet::new());
    walk_files(&r, &["**/node_modules".into()], |p| {
        found.lock().insert(p.strip_prefix(&r).unwrap().to_string_lossy().replace('\\', "/"));
    });
    let found = found.into_inner();
    let expected: BTreeSet<String> =
        [".github/ci.yml", ".gitignore", "deep/.ignore", "deep/open.txt", "src/lib.rs", "src/main.rs"]
            .into_iter()
            .map(String::from)
            .collect();
    assert_eq!(found, expected);
}

fn wait_for(events: &Mutex<Vec<FsBatch>>, pred: impl Fn(&[FsBatch]) -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if pred(&events.lock()) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn watcher_reports_changes() {
    let (_t, r) = root();
    write(&r.join(".gitignore"), "*.log\n");
    write(&r.join(".git/HEAD"), "ref: refs/heads/main\n");
    write(&r.join("existing.txt"), "1");

    let batches: Arc<Mutex<Vec<FsBatch>>> = Arc::default();
    let sunk: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink: SharedSink = {
        let sunk = sunk.clone();
        Arc::new(move |e: IdeEvent| sunk.lock().push(e))
    };
    let watcher = {
        let batches = batches.clone();
        Watcher::start(&r, vec!["**/target".into()], sink, Box::new(move |b| batches.lock().push(b.clone()))).unwrap()
    };
    std::thread::sleep(Duration::from_millis(300));

    write(&r.join("new.txt"), "hello");
    write(&r.join("noise.log"), "ignored");
    write(&r.join("target/debug/out"), "excluded");
    write(&r.join(".git/objects/aa"), "internal");
    write(&r.join(".git/HEAD"), "ref: refs/heads/other\n");
    fs::remove_file(r.join("existing.txt")).unwrap();

    let all = |b: &[FsBatch]| -> BTreeSet<PathBuf> {
        b.iter().flat_map(|b| b.created.iter().chain(&b.modified).chain(&b.removed).cloned()).collect()
    };
    assert!(
        wait_for(&batches, |b| {
            let paths = all(b);
            paths.contains(&r.join("new.txt"))
                && paths.contains(&r.join(".git/HEAD"))
                && b.iter().any(|b| b.removed.contains(&r.join("existing.txt")))
        }),
        "batches: {:?}",
        batches.lock()
    );
    let paths = all(&batches.lock());
    assert!(!paths.contains(&r.join("noise.log")));
    assert!(!paths.iter().any(|p| p.starts_with(r.join("target"))));
    assert!(!paths.contains(&r.join(".git/objects/aa")));
    assert!(sunk.lock().iter().any(|e| matches!(e, IdeEvent::FsChanged { .. })));

    drop(watcher);
    let n = batches.lock().len();
    write(&r.join("after-drop.txt"), "x");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(batches.lock().len(), n, "no events after drop");
}

#[test]
fn worktree_and_nested_repository_local_excludes_are_reflected_in_listings() {
    fn git(root: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git").current_dir(root).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("repo");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    std::fs::write(root.join("initial"), "x").unwrap();
    git(&root, &["add", "initial"]);
    git(
        &root,
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
    let linked = root.parent().unwrap().join("linked");
    git(&root, &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()]);
    std::fs::write(linked.join("private"), "x").unwrap();
    std::fs::write(root.join(".git/info/exclude"), "/private\n").unwrap();
    let entries = ide_vfs::read_dir(&linked, &[]).unwrap();
    assert!(entries.iter().find(|e| e.name == "private").unwrap().ignored);
    assert!(!entries.iter().find(|e| e.name == "private").unwrap().excluded);
    let nested = linked.join("nested");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-q"]);
    std::fs::write(nested.join("private"), "x").unwrap();
    let entries = ide_vfs::read_dir(&nested, &[]).unwrap();
    assert!(!entries.iter().find(|e| e.name == "private").unwrap().ignored);
    std::fs::write(nested.join(".git/info/exclude"), "/private\n").unwrap();
    let entries = ide_vfs::read_dir(&nested, &[]).unwrap();
    assert!(entries.iter().find(|e| e.name == "private").unwrap().ignored);
}
