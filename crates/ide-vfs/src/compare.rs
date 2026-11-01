//! Disk comparisons use the same excludes and layered ignore files as the project tree.
use crate::{EntryKind, ExcludeMatcher, rules::GitignoreStack};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryCompareStatus {
    LeftOnly,
    RightOnly,
    Different,
    Equal,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCompareEntry {
    pub path: String,
    pub status: DirectoryCompareStatus,
    pub left_kind: Option<EntryKind>,
    pub right_kind: Option<EntryKind>,
    #[specta(optional)]
    pub left_link: Option<String>,
    #[specta(optional)]
    pub right_link: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCompareProgress {
    pub scanned: u32,
    pub compared: u32,
    pub total: Option<u32>,
    pub bytes_read: f64,
    pub path: String,
}

struct Entry {
    kind: EntryKind,
    size: u64,
    link: Option<PathBuf>,
}

fn check(cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() { Err(IdeError::cancelled()) } else { Ok(()) }
}

struct Rules {
    base: PathBuf,
    excludes: ExcludeMatcher,
    ignore: GitignoreStack,
}

impl Rules {
    fn new(root: &Path, project: Option<&Path>, excludes: &[String]) -> Self {
        Self {
            base: project.filter(|p| root.starts_with(p)).unwrap_or(root).to_path_buf(),
            excludes: ExcludeMatcher::new(excludes),
            ignore: GitignoreStack::new(root),
        }
    }

    fn excluded(&self, path: &Path, dir: bool) -> bool {
        path.file_name().is_some_and(|n| n == ".git")
            || self.excludes.is_excluded(path.strip_prefix(&self.base).unwrap_or(path))
            || self.ignore.is_ignored(path, dir)
    }
}

fn scan(
    root: &Path,
    rules: &Rules,
    cancel: &CancellationToken,
    progress: &mut DirectoryCompareProgress,
    emit: &impl Fn(DirectoryCompareProgress),
) -> IdeResult<BTreeMap<String, Entry>> {
    if !fs::metadata(root)?.is_dir() {
        return Err(IdeError::invalid(format!("{} is not a directory", root.display())));
    }
    let mut result = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        check(cancel)?;
        for item in fs::read_dir(dir)? {
            check(cancel)?;
            let path = item?.path();
            let meta = fs::symlink_metadata(&path)?;
            if rules.excluded(&path, meta.is_dir()) {
                continue;
            }
            let kind = if meta.file_type().is_symlink() {
                EntryKind::Symlink
            } else if meta.is_dir() {
                pending.push(path.clone());
                EntryKind::Dir
            } else if meta.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let rel = path.strip_prefix(root).map_err(|e| IdeError::internal(e.to_string()))?;
            let rel = ide_core::ipc_path::to_ipc(rel);
            let link = if kind == EntryKind::Symlink { Some(fs::read_link(&path)?) } else { None };
            result.insert(rel.clone(), Entry { kind, size: meta.len(), link });
            progress.scanned += 1;
            progress.path = rel;
            emit(progress.clone());
        }
    }
    Ok(result)
}

fn hash(
    path: &Path,
    cancel: &CancellationToken,
    progress: &mut DirectoryCompareProgress,
    emit: &impl Fn(DirectoryCompareProgress),
) -> IdeResult<gix::hash::ObjectId> {
    let mut file = fs::File::open(path)?;
    let mut hash = gix::hash::hasher(gix::hash::Kind::Sha256);
    let mut buffer = [0; 64 * 1024];
    loop {
        check(cancel)?;
        let len = file.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hash.update(&buffer[..len]);
        progress.bytes_read += len as f64;
        emit(progress.clone());
    }
    hash.try_finalize().map_err(|e| IdeError::internal(e.to_string()))
}

/// Size checks avoid reading unequal files. Equal-sized files are hashed in bounded,
/// cancellable chunks; symlinks compare their link text and are never traversed.
pub fn compare_directories(
    left: &Path,
    right: &Path,
    project: Option<&Path>,
    excludes: &[String],
    cancel: &CancellationToken,
    emit: impl Fn(DirectoryCompareProgress),
) -> IdeResult<Vec<DirectoryCompareEntry>> {
    check(cancel)?;
    let mut progress = DirectoryCompareProgress::default();
    emit(progress.clone());
    let l = scan(left, &Rules::new(left, project, excludes), cancel, &mut progress, &emit)?;
    let r = scan(right, &Rules::new(right, project, excludes), cancel, &mut progress, &emit)?;
    let mut paths: Vec<_> = l.keys().chain(r.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    progress.total = Some(paths.len() as u32);
    let mut rows = BTreeMap::new();
    for path in paths {
        check(cancel)?;
        progress.path.clone_from(&path);
        let status = match (l.get(&path), r.get(&path)) {
            (Some(_), None) => DirectoryCompareStatus::LeftOnly,
            (None, Some(_)) => DirectoryCompareStatus::RightOnly,
            (Some(a), Some(b)) => {
                let equal = a.kind == b.kind
                    && match a.kind {
                        EntryKind::Dir => true,
                        EntryKind::Symlink => a.link == b.link,
                        EntryKind::File => {
                            a.size == b.size
                                && hash(&left.join(&path), cancel, &mut progress, &emit)?
                                    == hash(&right.join(&path), cancel, &mut progress, &emit)?
                        }
                    };
                if equal { DirectoryCompareStatus::Equal } else { DirectoryCompareStatus::Different }
            }
            _ => unreachable!(),
        };
        rows.insert(
            path.clone(),
            DirectoryCompareEntry {
                path: path.clone(),
                status,
                left_kind: l.get(&path).map(|e| e.kind),
                right_kind: r.get(&path).map(|e| e.kind),
                left_link: l.get(&path).and_then(|e| e.link.as_ref()).map(|p| p.to_string_lossy().into_owned()),
                right_link: r.get(&path).and_then(|e| e.link.as_ref()).map(|p| p.to_string_lossy().into_owned()),
            },
        );
        progress.compared += 1;
        emit(progress.clone());
    }
    let changed: Vec<_> =
        rows.values().filter(|r| r.status != DirectoryCompareStatus::Equal).map(|r| r.path.clone()).collect();
    for path in changed {
        for parent in Path::new(&path).ancestors().skip(1) {
            if let Some(row) = rows.get_mut(&ide_core::ipc_path::to_ipc(parent))
                && row.status == DirectoryCompareStatus::Equal
            {
                row.status = DirectoryCompareStatus::Different;
            }
        }
    }
    check(cancel)?;
    Ok(rows.into_values().collect())
}

/// Merges a subtree without following links inside the comparison roots. Existing files
/// require explicit overwrite; directory merges preserve destination-only entries.
pub fn copy_merge(
    from: &Path,
    to: &Path,
    overwrite: bool,
    project: Option<&Path>,
    excludes: &[String],
    roots: (&Path, &Path),
) -> IdeResult<()> {
    fn resolve(path: &Path) -> IdeResult<PathBuf> {
        if path.exists() {
            return Ok(dunce::canonicalize(path)?);
        }
        let parent = path.parent().ok_or_else(|| IdeError::invalid("copy requires an absolute path"))?;
        Ok(resolve(parent)?.join(path.file_name().ok_or_else(|| IdeError::invalid("missing file name"))?))
    }
    if !from.is_absolute() || !to.is_absolute() {
        return Err(IdeError::invalid("copy requires absolute paths"));
    }
    if !from.starts_with(roots.0) || !to.starts_with(roots.1) {
        return Err(IdeError::invalid("copy paths must belong to the comparison roots"));
    }
    let source = resolve(from)?;
    let target = resolve(to)?;
    if source.starts_with(&target) || target.starts_with(&source) {
        return Err(IdeError::invalid("cannot copy overlapping paths"));
    }
    for parent in to.ancestors().skip(1) {
        // The user explicitly selected this root; aliases above it (e.g. /tmp
        // on macOS) are valid. Links inside the copied subtree are not followed.
        if to == roots.1 || parent == roots.1 {
            break;
        }
        if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(IdeError::invalid("cannot copy through a destination symlink"));
        }
    }
    let source_base = project.filter(|p| from.starts_with(p)).or(Some(roots.0));
    let target_base = project.filter(|p| to.starts_with(p)).or(Some(roots.1));
    let rules = Rules::new(from, source_base, excludes);
    let target_rules = Rules::new(to, target_base, excludes);
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = pending.pop() {
        let meta = fs::symlink_metadata(&src)?;
        if rules.excluded(&src, meta.is_dir()) || target_rules.excluded(&dst, meta.is_dir()) {
            continue;
        }
        let existing = fs::symlink_metadata(&dst).ok();
        let merge = meta.is_dir() && existing.as_ref().is_some_and(|m| m.is_dir());
        if existing.is_some() && !merge && !overwrite {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, dst.display().to_string()).into());
        }
        if meta.is_dir() {
            if existing.is_some() && !merge {
                crate::delete(&dst)?;
            }
            fs::create_dir_all(&dst)?;
            for entry in fs::read_dir(&src)? {
                let entry = entry?;
                pending.push((entry.path(), dst.join(entry.file_name())));
            }
        } else {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            // Stage the complete file before touching its destination.
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let temp = dst.with_file_name(format!(".openidea-copy-{}-{id}", std::process::id()));
            let mut staged = false;
            let result: IdeResult<()> = (|| {
                #[cfg(windows)]
                if meta.file_type().is_symlink() {
                    use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
                    let target = fs::read_link(&src)?;
                    if meta.file_type().is_symlink_dir() {
                        symlink_dir(target, &temp)?;
                    } else {
                        symlink_file(target, &temp)?;
                    }
                } else {
                    crate::copy(&src, &temp)?;
                }
                #[cfg(not(windows))]
                crate::copy(&src, &temp)?;
                staged = true;
                // Recheck after staging: another writer may have created the target.
                if fs::symlink_metadata(&dst).is_ok() {
                    if !overwrite {
                        return Err(
                            std::io::Error::new(std::io::ErrorKind::AlreadyExists, dst.display().to_string()).into()
                        );
                    }
                    crate::delete(&dst)?;
                }
                fs::rename(&temp, &dst)?;
                Ok(())
            })();
            if let Err(error) = &result
                && (staged || error.kind != ide_core::error::ErrorKind::AlreadyExists)
            {
                let _ = crate::delete_permanently(&temp);
            }
            result?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::error::ErrorKind;

    fn put(root: &Path, path: &str, content: &[u8]) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn reports_add_delete_modify_equal_binary_unicode_empty_and_type_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "子目录/仅左.txt", b"left");
        put(&right, "only-right", b"right");
        for (path, a, b) in [
            ("same", b"same".as_slice(), b"same".as_slice()),
            ("binary", &[0, 255, 10], &[0, 254, 10]),
            ("size", b"a", b"bb"),
            ("conflict", b"file", b""),
        ] {
            put(&left, path, a);
            if path == "conflict" {
                put(&right, "conflict/child", b"child");
            } else {
                put(&right, path, b);
            }
        }
        fs::create_dir(left.join("empty")).unwrap();
        fs::create_dir(right.join("empty")).unwrap();
        let rows = compare_directories(&left, &right, None, &[], &CancellationToken::new(), |_| {}).unwrap();
        let status = |path| rows.iter().find(|r| r.path == path).unwrap().status;
        assert_eq!(status("same"), DirectoryCompareStatus::Equal);
        assert_eq!(status("empty"), DirectoryCompareStatus::Equal);
        for path in ["binary", "size", "conflict"] {
            assert_eq!(status(path), DirectoryCompareStatus::Different);
        }
        assert_eq!(status("子目录/仅左.txt"), DirectoryCompareStatus::LeftOnly);
        assert_eq!(status("only-right"), DirectoryCompareStatus::RightOnly);
        assert_eq!(status("conflict/child"), DirectoryCompareStatus::RightOnly);
    }

    #[test]
    fn applies_project_anchored_excludes_and_layered_ignores() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        for root in [&left, &right] {
            put(root, "nested/node_modules/x", b"ignored");
            put(root, "target/x", b"ignored");
            put(root, ".git/config", b"ignored");
            put(root, "generated/x", b"ignored");
            put(root, ".gitignore", b"*.log\n");
            put(root, "nested/debug.log", b"ignored");
            put(root, "kept", b"kept");
        }
        let excludes = ["**/node_modules", "**/target", "/left/generated", "/right/generated"].map(String::from);
        let rows =
            compare_directories(&left, &right, Some(tmp.path()), &excludes, &CancellationToken::new(), |_| {}).unwrap();
        assert!(
            rows.iter()
                .all(|r| !["node_modules", "target", ".git/", "generated", ".log"].iter().any(|p| r.path.contains(p)))
        );
        assert!(rows.iter().any(|r| r.path == "kept"));
    }

    #[test]
    fn cancellation_stops_before_scan_during_scan_and_during_hashing() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "big", &vec![1; 1024 * 1024]);
        put(&right, "big", &vec![1; 1024 * 1024]);
        for phase in 0..3 {
            let cancel = CancellationToken::new();
            if phase == 0 {
                cancel.cancel();
            }
            let result = compare_directories(&left, &right, None, &[], &cancel, |p| {
                if phase == 1 && p.scanned > 0 || phase == 2 && p.bytes_read > 0.0 {
                    cancel.cancel();
                }
            });
            assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        }
    }

    #[test]
    fn size_mismatches_are_not_hashed_and_directory_status_tracks_children() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "nested/file", b"a");
        put(&right, "nested/file", b"ab");
        let bytes = std::cell::Cell::new(0.0);
        let rows =
            compare_directories(&left, &right, None, &[], &CancellationToken::new(), |p| bytes.set(p.bytes_read))
                .unwrap();
        assert_eq!(bytes.get(), 0.0);
        assert!(rows.iter().all(|r| r.status == DirectoryCompareStatus::Different));
    }

    #[test]
    fn merges_copies_with_explicit_overwrite_and_keeps_destination_only_files() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "file", b"new");
        put(&left, "target/ignored", b"ignored");
        put(&right, "file", b"old");
        put(&right, "keep", b"keep");
        assert_eq!(
            copy_merge(&left, &right, false, None, &["target".into()], (&left, &right)).unwrap_err().kind,
            ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(right.join("file")).unwrap(), b"old");
        copy_merge(&left, &right, true, None, &["target".into()], (&left, &right)).unwrap();
        assert_eq!(fs::read(right.join("file")).unwrap(), b"new");
        assert_eq!(fs::read(right.join("keep")).unwrap(), b"keep");
        assert!(!right.join("target").exists());
        for (from, to) in [(&left, left.clone()), (&left, left.join("child")), (&right, tmp.path().to_path_buf())] {
            assert_eq!(
                copy_merge(from, &to, true, None, &[], (tmp.path(), tmp.path())).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn subtree_copy_keeps_excludes_anchored_to_each_comparison_root() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "sub/build/keep", b"included below sub");
        put(&left, "sub/protected", b"do not overwrite");
        put(&right, "sub/protected", b"keep destination");
        put(&right, ".gitignore", b"sub/protected\n");
        copy_merge(&left.join("sub"), &right.join("sub"), true, None, &["/build".into()], (&left, &right)).unwrap();
        assert_eq!(fs::read(right.join("sub/build/keep")).unwrap(), b"included below sub");
        assert_eq!(fs::read(right.join("sub/protected")).unwrap(), b"keep destination");
    }

    #[test]
    fn confirmed_copy_replaces_file_directory_type_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        put(&left, "file", b"file");
        put(&right, "file/child", b"old directory");
        put(&left, "tree/child", b"new directory");
        put(&right, "tree", b"old file");
        for path in ["file", "tree"] {
            copy_merge(&left.join(path), &right.join(path), true, None, &[], (&left, &right)).unwrap();
        }
        assert_eq!(fs::read(right.join("file")).unwrap(), b"file");
        assert_eq!(fs::read(right.join("tree/child")).unwrap(), b"new directory");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_compare_link_text_and_are_not_followed_when_copying() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let left = tmp.path().join("left");
        let right = tmp.path().join("right");
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        symlink(".", left.join("loop")).unwrap();
        symlink("missing", right.join("loop")).unwrap();
        let rows = compare_directories(&left, &right, None, &[], &CancellationToken::new(), |_| {}).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, DirectoryCompareStatus::Different);
        copy_merge(&left.join("loop"), &right.join("copied"), false, None, &[], (&left, &right)).unwrap();
        assert_eq!(fs::read_link(right.join("copied")).unwrap(), PathBuf::from("."));
        symlink(&right, tmp.path().join("alias")).unwrap();
        assert_eq!(
            copy_merge(&left.join("loop"), &tmp.path().join("alias/new"), true, None, &[], (tmp.path(), tmp.path()))
                .unwrap_err()
                .kind,
            ErrorKind::InvalidInput
        );
    }
}
