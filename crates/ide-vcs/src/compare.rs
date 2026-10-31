//! Selection-scoped revision → working-tree comparison over the existing root registry.
use crate::{ChangeKind, Repos, cli, ops};
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompareScope {
    pub repositories: Vec<IpcPath>,
    /// Selections with content outside all registered repositories (including workspace parents).
    pub skipped_paths: Vec<IpcPath>,
    pub single_file: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeChange {
    pub path: String,
    pub kind: ChangeKind,
    pub old_path: Option<String>,
    pub added: u32,
    pub removed: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryComparison {
    pub root: IpcPath,
    /// Resolved commit, so opening a diff later uses the same left side as the listing.
    pub revision: Option<String>,
    pub files: Vec<WorkingTreeChange>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub repositories: Vec<RepositoryComparison>,
    pub skipped_paths: Vec<IpcPath>,
}

fn normalized(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

impl Repos {
    pub fn compare_scope(&self, paths: &[PathBuf]) -> CompareScope {
        let paths: Vec<_> = paths.iter().map(|p| normalized(p)).collect();
        let repositories = self
            .all()
            .iter()
            .filter(|r| {
                let root = normalized(r.root());
                paths.iter().any(|p| {
                    root.starts_with(p)
                        || self.at_root(p).or_else(|| self.for_path(p)).is_some_and(|owner| owner.root() == r.root())
                })
            })
            .map(|r| IpcPath(r.root().to_path_buf()))
            .collect();
        let skipped_paths = paths.iter().filter(|p| self.for_path(p).is_none()).cloned().map(IpcPath).collect();
        CompareScope { repositories, skipped_paths, single_file: paths.len() == 1 && !paths[0].is_dir() }
    }

    pub fn compare_paths(
        &self,
        paths: &[PathBuf],
        revision: &str,
        repositories: Option<&[PathBuf]>,
        cancel: &CancellationToken,
    ) -> IdeResult<CompareResult> {
        if revision.trim().is_empty() || revision.starts_with('-') {
            return Err(IdeError::invalid("invalid revision"));
        }
        let scope = self.compare_scope(paths);
        let paths: Vec<_> = paths.iter().map(|p| normalized(p)).collect();
        let mut result = CompareResult { repositories: Vec::new(), skipped_paths: scope.skipped_paths };
        for root in scope.repositories {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if repositories.is_some_and(|roots| !roots.iter().any(|r| normalized(r) == normalized(&root.0))) {
                continue;
            }
            let repo = self.at_root(&root.0).expect("scope comes from registry");
            let _scope =
                crate::ExecutionScope::enter(repo.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
            let compare = || -> IdeResult<(String, Vec<WorkingTreeChange>)> {
                // Worktree comparisons must not run repository-defined clean/process filters
                // in Restricted Mode. External diff and textconv are disabled below as well.
                let mut overrides = Vec::new();
                if !crate::execution_allowed() {
                    let config = cli::run_cancellable(repo.root(), &["config", "--null", "--list"], cancel)?;
                    for record in config.stdout_str().split('\0') {
                        let key = record.split('\n').next().unwrap_or_default();
                        if key.starts_with("filter.")
                            && (key.ends_with(".clean") || key.ends_with(".process") || key.ends_with(".required"))
                        {
                            overrides.push("-c".to_owned());
                            overrides.push(format!("{key}={}", if key.ends_with(".required") { "false" } else { "" }));
                        }
                    }
                }
                let run = |args: &[&str]| {
                    let mut full: Vec<&str> = overrides.iter().map(String::as_str).collect();
                    full.extend_from_slice(args);
                    cli::run_cancellable(repo.root(), &full, cancel)
                };
                let resolved = run(&["rev-parse", "--verify", "--end-of-options", &format!("{revision}^{{commit}}")])?
                    .stdout_str()
                    .trim()
                    .to_owned();
                // Disable textconv/external diff; these are also safe in untrusted projects.
                let names =
                    run(&["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", &resolved, "--"])?;
                let stats = run(&[
                    "diff",
                    "--numstat",
                    "-z",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    &resolved,
                    "--",
                ])?;
                let stats: std::collections::HashMap<_, _> = ops::parse_numstat(&stats.stdout_str())
                    .into_iter()
                    .map(|(path, added, removed)| (path, (added, removed)))
                    .collect();
                let mut files = Vec::new();
                let contains = |rel: &str| {
                    let absolute = repo.root().join(rel);
                    // Nested clones contribute their own files, never the enclosing repo's entries.
                    let own = self.at_root(&absolute).or_else(|| self.for_path(&absolute));
                    own.is_some_and(|r| r.root() == repo.root()) && paths.iter().any(|p| absolute.starts_with(p))
                };
                for mut file in ops::parse_name_status(&names.stdout_str()) {
                    if cancel.is_cancelled() {
                        return Err(IdeError::cancelled());
                    }
                    let new_in = contains(&file.path);
                    let old_in = file.old_path.as_deref().is_some_and(contains);
                    if !new_in && !old_in {
                        continue;
                    }
                    let original = file.path.clone();
                    if file.old_path.is_some() && new_in != old_in {
                        if old_in {
                            file.path = file.old_path.take().unwrap();
                            file.kind = ChangeKind::Deleted;
                        } else {
                            file.old_path = None;
                            file.kind = ChangeKind::Added;
                        }
                    }
                    let count = |path: &str| stats.get(path).copied().unwrap_or_default();
                    let (added, removed) = match &file.old_path {
                        Some(old) => (count(&original).0, count(old).1),
                        None => count(&file.path),
                    };
                    files.push(WorkingTreeChange {
                        path: file.path,
                        kind: file.kind,
                        old_path: file.old_path,
                        added,
                        removed,
                    });
                }
                if files.iter().any(|f| f.kind == ChangeKind::Renamed) {
                    let renamed =
                        run(&["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", &resolved, "--"])?;
                    let indexes: std::collections::HashMap<_, _> = files
                        .iter()
                        .enumerate()
                        .filter(|(_, f)| f.kind == ChangeKind::Renamed)
                        .map(|(index, f)| (f.path.clone(), index))
                        .collect();
                    let mut records =
                        renamed.stdout_str().split('\0').map(str::to_owned).collect::<Vec<_>>().into_iter();
                    while let Some(record) = records.next() {
                        if cancel.is_cancelled() {
                            return Err(IdeError::cancelled());
                        }
                        let fields: Vec<_> = record.splitn(3, '\t').collect();
                        if fields.len() == 3 && fields[2].is_empty() {
                            let _old = records.next();
                            if let Some(path) = records.next()
                                && let Some(index) = indexes.get(&path)
                            {
                                let file = &mut files[*index];
                                file.added = fields[0].parse().unwrap_or(0);
                                file.removed = fields[1].parse().unwrap_or(0);
                            }
                        }
                    }
                }
                let untracked = run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
                for path in untracked.stdout_str().split('\0').filter(|p| !p.is_empty() && contains(p)) {
                    if cancel.is_cancelled() {
                        return Err(IdeError::cancelled());
                    }
                    let absolute = repo.root().join(path);
                    // Match the existing diff viewer's large/binary-file policy without loading large files for counts.
                    let added = if std::fs::metadata(&absolute).is_ok_and(|m| m.len() <= 10 * 1024 * 1024) {
                        let bytes = std::fs::read(&absolute)?;
                        if bytes.contains(&0) {
                            0
                        } else {
                            (bytes.iter().filter(|b| **b == b'\n').count()
                                + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n')))
                                as u32
                        }
                    } else {
                        0
                    };
                    files.push(WorkingTreeChange {
                        path: path.to_owned(),
                        kind: ChangeKind::Untracked,
                        old_path: None,
                        added,
                        removed: 0,
                    });
                }
                files.sort_by(|a, b| a.path.cmp(&b.path));
                Ok((resolved, files))
            };
            let comparison = match compare() {
                Ok((revision, files)) => RepositoryComparison { root, revision: Some(revision), files, error: None },
                Err(_) if cancel.is_cancelled() => return Err(IdeError::cancelled()),
                Err(e) => RepositoryComparison { root, revision: None, files: Vec::new(), error: Some(e.to_string()) },
            };
            result.repositories.push(comparison);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git").current_dir(root).args(args).output().unwrap();
        assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn init(root: &Path, branch: &str) {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-q", "-b", branch]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        write(root, "src/文件 name.txt", "old\n");
        write(root, "src/move.txt", "move\n");
        write(root, "other/stable.txt", "stable\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "initial"]);
    }

    #[test]
    fn subtree_union_worktree_untracked_and_rename_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        git(&root, &["switch", "-qc", "feature"]);
        git(&root, &["mv", "src/move.txt", "other/moved.txt"]);
        git(&root, &["commit", "-qm", "move out"]);
        write(&root, "src/文件 name.txt", "old\nnew\n");
        write(&root, "src/untracked space 中文.txt", "new\nfile\n");
        write(&root, "other/stable.txt", "changed\n");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let cancel = CancellationToken::new();
        let result = repos.compare_paths(&[root.join("src")], "main", None, &cancel).unwrap();
        assert_eq!(result.repositories.len(), 1);
        let files = &result.repositories[0].files;
        assert_eq!(files.len(), 3, "{files:?}");
        let moved = files.iter().find(|f| f.path == "src/move.txt").unwrap();
        assert_eq!(moved.kind, ChangeKind::Deleted);
        assert_eq!((moved.added, moved.removed), (0, 1));
        assert!(moved.old_path.is_none());
        let changed = files.iter().find(|f| f.path == "src/文件 name.txt").unwrap();
        assert_eq!((changed.added, changed.removed), (1, 0));
        let untracked = files.iter().find(|f| f.path == "src/untracked space 中文.txt").unwrap();
        assert_eq!((untracked.kind, untracked.added), (ChangeKind::Untracked, 2));
        let union = repos
            .compare_paths(&[root.join("src"), root.join("other"), root.join("src")], "main", None, &cancel)
            .unwrap();
        assert_eq!(union.repositories[0].files.len(), 4);
        let rename = union.repositories[0].files.iter().find(|f| f.path == "other/moved.txt").unwrap();
        assert_eq!(rename.kind, ChangeKind::Renamed);
        assert_eq!(rename.old_path.as_deref(), Some("src/move.txt"));
        assert_eq!((rename.added, rename.removed), (0, 0));
        let into = repos.compare_paths(&[root.join("other")], "main", None, &cancel).unwrap();
        assert_eq!(
            into.repositories[0].files.iter().find(|f| f.path == "other/moved.txt").unwrap().kind,
            ChangeKind::Added
        );
    }

    #[test]
    fn workspace_roots_missing_revision_loose_paths_and_empty_results() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        for name in ["client", "server", "admin"] {
            init(&root.join(name), if name == "admin" { "trunk" } else { "main" });
        }
        write(&root, "loose/readme.txt", "not git\n");
        write(&root.join("client"), "src/new.txt", "client\n");
        write(&root.join("server"), "src/文件 name.txt", "server\n");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let scope = repos.compare_scope(std::slice::from_ref(&root));
        assert_eq!(scope.repositories.len(), 3);
        assert_eq!(scope.skipped_paths, [IpcPath(root.clone())]);
        assert!(!scope.single_file);
        assert!(repos.compare_scope(&[root.join("client/src/文件 name.txt")]).single_file);
        let cancel = CancellationToken::new();
        let result = repos.compare_paths(&[root.clone(), root.join("loose")], "main", None, &cancel).unwrap();
        assert_eq!(result.repositories.len(), 3);
        assert_eq!(result.repositories.iter().filter(|r| r.error.is_some()).count(), 1);
        assert!(result.repositories[0].error.is_some(), "admin lacks main");
        assert_eq!(result.repositories[1].files.len(), 1);
        assert_eq!(result.repositories[2].files.len(), 1);
        assert_eq!(result.skipped_paths.len(), 2);
        let filtered =
            repos.compare_paths(std::slice::from_ref(&root), "main", Some(&[root.join("server")]), &cancel).unwrap();
        assert_eq!(filtered.repositories.len(), 1);
        assert_eq!(filtered.repositories[0].root.0, root.join("server"));
        let empty = repos.compare_paths(&[root.join("server/other")], "main", None, &cancel).unwrap();
        assert!(empty.repositories[0].files.is_empty());
        let loose = repos.compare_paths(&[root.join("loose")], "main", None, &cancel).unwrap();
        assert!(loose.repositories.is_empty());
        assert_eq!(loose.skipped_paths, [IpcPath(root.join("loose"))]);
        cancel.cancel();
        assert!(repos.compare_paths(&[root], "main", None, &cancel).is_err());
    }

    #[test]
    fn nested_repositories_are_not_reported_twice_and_binary_counts_are_zero() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        init(&root.join("nested"), "main");
        write(&root.join("nested"), "src/new.txt", "nested\n");
        std::fs::write(root.join("src/image.bin"), [0, 1, 2]).unwrap();
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let result = repos.compare_paths(std::slice::from_ref(&root), "main", None, &CancellationToken::new()).unwrap();
        assert_eq!(result.repositories.len(), 2);
        assert_eq!(result.repositories[0].files.len(), 1);
        assert_eq!(result.repositories[0].files[0].added, 0);
        assert_eq!(result.repositories[1].files.len(), 1);
        let nested = repos.compare_paths(&[root.join("nested")], "main", None, &CancellationToken::new()).unwrap();
        assert_eq!(nested.repositories.len(), 1);
        assert_eq!(nested.repositories.iter().map(|r| r.files.len()).sum::<usize>(), 1);
    }
}
