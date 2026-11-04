//! The files of a search scope, for analyses that read whole files
//! (Inspect Code, Locate Duplicates, Structural Search).

use crate::engine::{rel_path, roots};
use crate::{FileMask, PathFilter, SearchScope};
use ide_core::{CancellationToken, IdeResult};
use ignore::{WalkBuilder, WalkState};
use std::path::PathBuf;
use std::sync::Mutex;

/// A file in a scope with its `/`-separated project-relative path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeFile {
    pub path: PathBuf,
    pub rel_path: String,
}

/// Lists the files of `scope` under `root` the way Find in Files walks them
/// (`.gitignore` honoured, hidden files and `.git` skipped), filtered by
/// `mask` and `filter`, sorted by relative path. Explicitly listed files are
/// kept even when they do not exist on disk (unsaved buffers). Returns what was
/// found so far when cancelled.
pub fn scope_files(
    root: &std::path::Path,
    scope: &SearchScope,
    mask: &FileMask,
    filter: Option<PathFilter<'_>>,
    cancel: &CancellationToken,
) -> IdeResult<Vec<ScopeFile>> {
    let pattern = scope.pattern()?;
    let keep = |rel: &str| {
        mask.matches(rel) && pattern.as_ref().is_none_or(|p| p.matches(rel)) && filter.is_none_or(|f| f(rel))
    };
    let found = Mutex::new(Vec::new());
    let mut on_disk = Vec::new();
    for path in roots(root, scope)? {
        if !path.exists() && matches!(scope, SearchScope::Files { .. }) {
            let rel = rel_path(root, &path);
            if keep(&rel) {
                found.lock().unwrap_or_else(|e| e.into_inner()).push(ScopeFile { path, rel_path: rel });
            }
        } else {
            on_disk.push(path);
        }
    }
    if let Some((first, rest)) = on_disk.split_first() {
        let mut walk = WalkBuilder::new(first);
        for path in rest {
            walk.add(path);
        }
        ide_vfs::bound_gitignore_to_repo(&mut walk, root)
            .hidden(true)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .parents(true)
            .follow_links(false)
            .threads(std::thread::available_parallelism().map_or(4, |n| n.get()).min(12))
            .filter_entry(|e| e.file_name() != ".git");
        walk.build_parallel().run(|| {
            let found = &found;
            let keep = &keep;
            Box::new(move |entry| {
                if cancel.is_cancelled() {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if entry.file_type().is_some_and(|t| t.is_file()) && !ide_vfs::is_archive_file(entry.path()) {
                    let rel = rel_path(root, entry.path());
                    if keep(&rel) {
                        found
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(ScopeFile { path: entry.into_path(), rel_path: rel });
                    }
                }
                WalkState::Continue
            })
        });
    }
    let mut files = found.into_inner().unwrap_or_else(|e| e.into_inner());
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/sub")).unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::write(root.join("src/a.rs"), "a").unwrap();
        std::fs::write(root.join("src/sub/b.rs"), "b").unwrap();
        std::fs::write(root.join("src/c.txt"), "c").unwrap();
        std::fs::write(root.join("ignored/d.rs"), "d").unwrap();
        dir
    }

    fn rels(files: &[ScopeFile]) -> Vec<&str> {
        files.iter().map(|f| f.rel_path.as_str()).collect()
    }

    #[test]
    fn project_scope_honours_gitignore_and_masks() {
        let dir = tree();
        let none = FileMask::new(&[], &[]).unwrap();
        let cancel = CancellationToken::new();
        let all = scope_files(dir.path(), &SearchScope::Project, &none, None, &cancel).unwrap();
        assert_eq!(rels(&all), vec!["src/a.rs", "src/c.txt", "src/sub/b.rs"]);

        let rs = FileMask::new(&["*.rs".into()], &[]).unwrap();
        let only_rs = scope_files(dir.path(), &SearchScope::Project, &rs, None, &cancel).unwrap();
        assert_eq!(rels(&only_rs), vec!["src/a.rs", "src/sub/b.rs"]);

        let not_sub: PathFilter<'_> = &|rel: &str| !rel.starts_with("src/sub/");
        let filtered = scope_files(dir.path(), &SearchScope::Project, &none, Some(not_sub), &cancel).unwrap();
        assert_eq!(rels(&filtered), vec!["src/a.rs", "src/c.txt"]);
    }

    #[test]
    fn directory_and_file_scopes() {
        let dir = tree();
        let none = FileMask::new(&[], &[]).unwrap();
        let cancel = CancellationToken::new();
        let sub = SearchScope::Directory { path: ide_core::IpcPath(dir.path().join("src/sub")) };
        assert_eq!(rels(&scope_files(dir.path(), &sub, &none, None, &cancel).unwrap()), vec!["src/sub/b.rs"]);
        let files = SearchScope::Files {
            paths: vec![
                ide_core::IpcPath(dir.path().join("src/a.rs")),
                ide_core::IpcPath(dir.path().join("src/new.rs")),
                ide_core::IpcPath(dir.path().join("src/a.rs")),
            ],
        };
        assert_eq!(
            rels(&scope_files(dir.path(), &files, &none, None, &cancel).unwrap()),
            vec!["src/a.rs", "src/new.rs"]
        );
    }

    #[test]
    fn pattern_scope() {
        let dir = tree();
        let none = FileMask::new(&[], &[]).unwrap();
        let cancel = CancellationToken::new();
        let scope = SearchScope::Pattern { pattern: "file:src//*.rs&&!file:src/sub//*".into() };
        assert_eq!(rels(&scope_files(dir.path(), &scope, &none, None, &cancel).unwrap()), vec!["src/a.rs"]);
        let bad = SearchScope::Pattern { pattern: "(".into() };
        assert!(scope_files(dir.path(), &bad, &none, None, &cancel).is_err());
    }
}
