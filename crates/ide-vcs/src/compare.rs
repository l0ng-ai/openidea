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
    /// Selected content outside registered repositories; workspace parents expand to their skipped children.
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
    /// The requested revision does not resolve to a commit in this repository.
    #[serde(default)]
    pub missing_revision: bool,
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

fn comparison_children(path: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name() != ".git" && entry.file_name() != ".openidea")
        .map(|entry| entry.path())
        .collect()
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
        let mut skipped = std::collections::BTreeSet::new();
        for path in &paths {
            if self.at_root(path).or_else(|| self.for_path(path)).is_some() {
                continue;
            }
            if self.all().iter().any(|r| r.root().starts_with(path)) {
                for child in comparison_children(path) {
                    if self.has_outside_content(&child) {
                        skipped.insert(child);
                    }
                }
            } else {
                skipped.insert(path.clone());
            }
        }
        let skipped_paths = skipped
            .into_iter()
            .map(|mut path| {
                if path.is_dir() {
                    path.push("");
                }
                IpcPath(path)
            })
            .collect();
        CompareScope { repositories, skipped_paths, single_file: paths.len() == 1 && !paths[0].is_dir() }
    }

    fn has_outside_content(&self, path: &Path) -> bool {
        if self.at_root(path).or_else(|| self.for_path(path)).is_some() {
            return false;
        }
        !self.all().iter().any(|r| r.root().starts_with(path))
            || comparison_children(path).iter().any(|child| self.has_outside_content(child))
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
            let mut missing_revision = false;
            let mut compare = || -> IdeResult<(String, Vec<WorkingTreeChange>)> {
                // Worktree comparisons must not run repository-defined clean/process filters
                // in Restricted Mode. External diff and textconv are disabled below as well.
                let overrides = cli::filter_overrides(repo.root(), cancel)?;
                let run = |args: &[&str]| {
                    let mut full: Vec<&str> = overrides.iter().map(String::as_str).collect();
                    full.extend_from_slice(args);
                    cli::run_cancellable(repo.root(), &full, cancel)
                };
                // --quiet documents exit 1 for an unresolved revision; other failures keep their diagnostics.
                let resolve_args =
                    ["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{revision}^{{commit}}")];
                let resolved = cli::run_cancellable_raw(repo.root(), &resolve_args, cancel)?;
                if resolved.code != Some(0) {
                    missing_revision = resolved.code == Some(1);
                    return Err(cli::failure(&resolve_args, &resolved.stderr, &resolved.stdout, resolved.code));
                }
                let resolved = resolved.stdout_str().trim().to_owned();
                // Disable textconv/external diff; these are also safe in untrusted projects.
                let diff = |options: &[&str]| {
                    let fixed = &["diff", "--no-ext-diff", "--no-textconv"][..];
                    run(&[fixed, cli::submodule_guards(), options, &[resolved.as_str(), "--"]].concat())
                };
                let names = diff(&["--name-status", "-z", "-M"])?;
                let stats = diff(&["--numstat", "-z", "--no-renames"])?;
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
                    let renamed = diff(&["--numstat", "-z", "-M"])?;
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
                        let bytes = std::fs::read(&absolute).unwrap_or_default();
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
                Ok((revision, files)) => {
                    RepositoryComparison { root, revision: Some(revision), files, error: None, missing_revision: false }
                }
                Err(_) if cancel.is_cancelled() => return Err(IdeError::cancelled()),
                Err(e) => RepositoryComparison {
                    root,
                    revision: None,
                    files: Vec::new(),
                    error: (!missing_revision).then_some(e.message),
                    missing_revision,
                },
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
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output()
            .unwrap();
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
        assert_eq!(scope.skipped_paths, [IpcPath(root.join("loose"))]);
        assert!(!scope.single_file);
        assert!(repos.compare_scope(&[root.join("client/src/文件 name.txt")]).single_file);
        let cancel = CancellationToken::new();
        let result = repos.compare_paths(&[root.clone(), root.join("loose")], "main", None, &cancel).unwrap();
        assert_eq!(result.repositories.len(), 3);
        assert_eq!(result.repositories.iter().filter(|r| r.missing_revision).count(), 1);
        assert!(result.repositories[0].missing_revision, "admin lacks main");
        assert!(result.repositories[0].error.is_none());
        assert_eq!(result.repositories[1].files.len(), 1);
        assert_eq!(result.repositories[2].files.len(), 1);
        assert_eq!(result.skipped_paths, [IpcPath(root.join("loose"))]);
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
    #[test]
    fn skipped_children_only_report_content_outside_repositories() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root.join("services/server"), "main");
        init(&root.join("client"), "main");
        write(&root, ".openidea/state.json", "{}");
        write(&root, ".git/config", "ignored metadata");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        assert!(repos.compare_scope(std::slice::from_ref(&root)).skipped_paths.is_empty());
        write(&root, "services/notes.txt", "loose nested content");
        write(&root, "loose/readme.txt", "loose");
        write(&root, "readme.txt", "loose file");
        let scope = repos.compare_scope(&[root.clone(), root.join("loose")]);
        assert_eq!(
            scope.skipped_paths,
            [IpcPath(root.join("loose")), IpcPath(root.join("readme.txt")), IpcPath(root.join("services")),]
        );
        assert!(scope.skipped_paths[0].0.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR));
    }

    #[test]
    fn missing_revision_is_typed_and_other_errors_keep_only_the_message() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let cancel = CancellationToken::new();
        let result = repos.compare_paths(std::slice::from_ref(&root), "missing-revision", None, &cancel).unwrap();
        assert!(result.repositories[0].missing_revision);
        assert!(result.repositories[0].error.is_none());
        std::fs::write(root.join(".git/config"), "[broken").unwrap();
        let result = repos.compare_paths(&[root], "main", None, &cancel).unwrap();
        assert!(!result.repositories[0].missing_revision);
        let error = result.repositories[0].error.as_deref().unwrap();
        assert!(error.contains("bad config"), "{error}");
        assert!(!error.starts_with("Internal:"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn untracked_read_and_metadata_failures_leave_files_with_zero_counts() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        // Reading a directory fails after successful metadata; a dangling link fails metadata.
        symlink(root.join("src"), root.join("unreadable")).unwrap();
        symlink(root.join("vanished"), root.join("missing")).unwrap();
        write(&root, "new.txt", "still counted\n");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let result = repos.compare_paths(&[root], "main", None, &CancellationToken::new()).unwrap();
        let repo = &result.repositories[0];
        assert!(repo.error.is_none(), "{repo:?}");
        assert_eq!(repo.files.len(), 3);
        for name in ["unreadable", "missing"] {
            let file = repo.files.iter().find(|f| f.path == name).unwrap();
            assert_eq!((file.kind, file.added, file.removed), (ChangeKind::Untracked, 0, 0));
        }
        assert_eq!(repo.files.iter().find(|f| f.path == "new.txt").unwrap().added, 1);
    }

    #[cfg(unix)]
    #[test]
    fn restricted_comparison_does_not_execute_repository_commands() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        let script = root.join(".git/marker.sh");
        let marker = root.join(".git/executed");
        std::fs::write(&script, "#!/bin/sh\ntouch .git/executed\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let script = script.to_str().unwrap();
        for key in [
            "core.fsmonitor",
            "filter.marker.clean",
            "filter.marker.process",
            "diff.marker.command",
            "diff.marker.textconv",
        ] {
            git(&root, &["config", key, script]);
        }
        git(&root, &["config", "filter.marker.required", "true"]);
        write(&root, ".gitattributes", "*.txt filter=marker diff=marker\n");
        write(&root, "src/文件 name.txt", "changed\n");
        write(&root, "new.txt", "untracked\n");
        let repos = Repos::discover(&root, &|_| false).unwrap();
        for repo in repos.all() {
            repo.set_execution_allowed(false);
        }
        let result = repos.compare_paths(std::slice::from_ref(&root), "main", None, &CancellationToken::new()).unwrap();
        assert!(result.repositories[0].error.is_none(), "{result:?}");
        assert_eq!(result.repositories[0].files.len(), 3);
        assert!(!marker.exists(), "Restricted Mode executed a repository command");
        // Prove the fixture's fsmonitor hook is active when the shared wrapper is bypassed.
        git(&root, &["ls-files"]);
        assert!(marker.exists(), "control invocation did not run fsmonitor");
    }

    /// git splits `-c name=value` at the first `=` and takes no name that is not UTF-8 on every
    /// platform, so such a filter cannot be emptied: Restricted Mode compares nothing instead.
    #[test]
    fn restricted_comparison_refuses_a_filter_git_cannot_be_told_to_skip() {
        for name in [&b"x=y"[..], &[0xE9]] {
            let temp = tempfile::tempdir().unwrap();
            let root = normalized(temp.path()).join("repo");
            let marker = root.with_file_name("marker");
            init(&root, "main");
            std::fs::write(root.join(".gitattributes"), [b"*.txt filter=", name, b"\n"].concat()).unwrap();
            let command = format!("echo x > '{}'; cat", marker.to_str().unwrap().replace('\\', "/"));
            let section = [b"[filter \"", name, format!("\"]\n\tclean = \"{command}\"\n").as_bytes()].concat();
            let config = root.join(".git/config");
            std::fs::write(&config, [std::fs::read(&config).unwrap(), section].concat()).unwrap();
            // The size it has in the index, so git has to read the file to tell whether it changed.
            write(&root, "src/move.txt", "more\n");
            let repos = Repos::discover(&root, &|_| false).unwrap();
            for repo in repos.all() {
                repo.set_execution_allowed(false);
            }
            let result = repos.compare_paths(std::slice::from_ref(&root), "main", None, &CancellationToken::new());
            let ran = marker.exists();
            let _ = std::fs::remove_file(&marker);
            write(&root, "src/move.txt", "less\n");
            let _ = Command::new("git").current_dir(&root).args(["status", "--porcelain"]).output();
            assert!(marker.exists(), "control: plain `git status` did not run the filter, fixture is not live");
            assert!(!ran, "Restricted Mode ran the repository's filter {name:?}");
            assert!(result.is_ok_and(|r| r.repositories[0].error.is_some()), "{name:?}");
        }
    }

    /// A repository with a second one in `sub`, which has `attributes`, committed as a submodule;
    /// returns the two roots and the path of the marker a program of the fixture leaves behind.
    fn with_submodule(temp: &Path, attributes: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = normalized(temp).join("repo");
        let sub = root.join("sub");
        init(&root, "main");
        init(&sub, "main");
        write(&sub, ".gitattributes", attributes);
        git(&sub, &["add", "."]);
        git(&sub, &["commit", "-qm", "attributes"]);
        git(&root, &["add", "sub"]);
        git(&root, &["commit", "-qm", "submodule"]);
        (root.clone(), sub, root.with_file_name("marker"))
    }

    /// git asks a submodule with changes for its own status, which runs under the submodule's config.
    #[test]
    fn restricted_reads_do_not_run_filters_of_a_submodule() {
        let temp = tempfile::tempdir().unwrap();
        let (root, sub, marker) = with_submodule(temp.path(), "*.txt filter=marker\n");
        let command = format!("echo x > '{}'; cat", marker.to_str().unwrap().replace('\\', "/"));
        git(&sub, &["config", "filter.marker.clean", &command]);
        let repos = Repos::discover(&root, &|_| false).unwrap();
        for repo in repos.all() {
            repo.set_execution_allowed(false);
        }
        let mut ran = Vec::new();
        // The size it has in the index, so git has to read the file to tell whether it changed.
        write(&sub, "src/move.txt", "more\n");
        let compared = repos.compare_paths(std::slice::from_ref(&root), "main", None, &CancellationToken::new());
        if marker.exists() {
            ran.push("compare_paths");
        }
        let _ = std::fs::remove_file(&marker);
        write(&sub, "src/move.txt", "less\n");
        let patch = repos.at_root(&root).unwrap().working_tree_patch(None, None, 1 << 20, &CancellationToken::new());
        if marker.exists() {
            ran.push("working_tree_patch");
        }
        let _ = std::fs::remove_file(&marker);
        write(&sub, "src/move.txt", "same\n");
        let _ = Command::new("git").current_dir(&root).args(["status", "--porcelain"]).output();
        assert!(marker.exists(), "control: plain `git status` did not run the filter, fixture is not live");
        assert!(ran.is_empty(), "Restricted Mode ran the submodule's filter via: {ran:?}");
        assert!(compared.unwrap().repositories.iter().all(|r| r.error.is_none()));
        patch.unwrap();
    }

    /// git runs the hooks a config names for `post-index-change` when a command writes the index
    /// back, as `git diff` does after refreshing it.
    #[test]
    fn restricted_reads_do_not_run_hooks_of_the_repository_s_config() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path()).join("repo");
        let marker = root.with_file_name("marker");
        init(&root, "main");
        git(&root, &["config", "hook.marker.event", "post-index-change"]);
        let command = format!("echo x > '{}'", marker.to_str().unwrap().replace('\\', "/"));
        git(&root, &["config", "hook.marker.command", &command]);
        let listed = Command::new("git").current_dir(&root).args(["hook", "list", "post-index-change"]).output();
        if !String::from_utf8_lossy(&listed.unwrap().stdout).contains("marker") {
            return; // This git has no hooks named by a config.
        }
        // The content it has in the index, with a time of its own that is not the index's.
        let touch = |seconds: u64| {
            let file = std::fs::File::options().write(true).open(root.join("src/move.txt")).unwrap();
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(seconds)).unwrap();
        };
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let repo = repos.at_root(&root).unwrap();
        repo.set_execution_allowed(false);
        let mut ran = Vec::new();
        touch(60);
        let compared = repos.compare_paths(std::slice::from_ref(&root), "main", None, &CancellationToken::new());
        if marker.exists() {
            ran.push("compare_paths");
        }
        let _ = std::fs::remove_file(&marker);
        touch(120);
        let patch = repo.working_tree_patch(None, None, 1 << 20, &CancellationToken::new());
        if marker.exists() {
            ran.push("working_tree_patch");
        }
        let _ = std::fs::remove_file(&marker);
        touch(180);
        let _ = Command::new("git").current_dir(&root).args(["--no-pager", "diff"]).output();
        assert!(marker.exists(), "control: plain `git diff` did not run the hook, fixture is not live");
        assert!(ran.is_empty(), "Restricted Mode ran a hook of the repository's config via: {ran:?}");
        assert!(compared.unwrap().repositories[0].error.is_none());
        assert_eq!(patch.unwrap(), "");
    }

    /// `diff.submodule=diff` has git run `git diff` in the submodule, under the submodule's config.
    #[test]
    fn restricted_patch_does_not_run_a_diff_driver_of_a_submodule() {
        let temp = tempfile::tempdir().unwrap();
        let (root, sub, marker) = with_submodule(temp.path(), "*.txt diff=marker\n");
        write(&sub, "src/move.txt", "move\nagain\n");
        git(&sub, &["commit", "-qam", "second"]);
        let command = format!("echo x > '{}'; cat", marker.to_str().unwrap().replace('\\', "/"));
        git(&sub, &["config", "diff.marker.command", &command]);
        git(&root, &["config", "diff.submodule", "diff"]);
        let repos = Repos::discover(&root, &|_| false).unwrap();
        for repo in repos.all() {
            repo.set_execution_allowed(false);
        }
        let patch = repos.at_root(&root).unwrap().working_tree_patch(None, None, 1 << 20, &CancellationToken::new());
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        let _ = Command::new("git").current_dir(&root).args(["--no-pager", "diff", "HEAD"]).output();
        assert!(marker.exists(), "control: plain `git diff` did not run the diff driver, fixture is not live");
        assert!(!ran, "Restricted Mode ran the submodule's diff driver");
        let patch = patch.unwrap();
        assert!(patch.contains("Subproject commit"), "{patch}");
    }

    /// Replaces HEAD with a copy of itself carrying a (fake) gpgsig header. `armor` labels the
    /// signature and so selects git's verifier: `PGP SIGNATURE`, `SSH SIGNATURE` or
    /// `SIGNED MESSAGE` (X.509).
    fn sign_head(root: &Path, armor: &str) {
        use std::io::Write;
        let out = Command::new("git").current_dir(root).args(["cat-file", "commit", "HEAD"]).output().unwrap();
        let body = String::from_utf8(out.stdout).unwrap();
        let (headers, message) = body.split_once("\n\n").unwrap();
        // Drop the signature of an earlier call so only the new one remains.
        let mut kept = Vec::new();
        let mut in_sig = false;
        for line in headers.lines() {
            if line.starts_with("gpgsig") {
                in_sig = true;
            } else if !(in_sig && line.starts_with(' ')) {
                in_sig = false;
                kept.push(line);
            }
        }
        let headers = kept.join("\n");
        let signed = format!(
            "{headers}\ngpgsig -----BEGIN {armor}-----\n \n iQEzBAABCAAdFiEEfake\n -----END {armor}-----\n\n{message}"
        );
        let mut child = Command::new("git")
            .current_dir(root)
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(signed.as_bytes()).unwrap();
        let id = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
        git(root, &["update-ref", "HEAD", id.trim()]);
    }

    /// Writes a script into `.git` that records its own execution. Returns the marker file it
    /// creates and its own path, spelled the way git config takes it.
    fn verifier_script(root: &Path) -> (PathBuf, String) {
        let marker = root.join("executed-marker");
        let script = root.join(".git/verifier.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho x > '{}'\nexit 1\n", marker.to_str().unwrap().replace('\\', "/")),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        (marker, script.to_str().unwrap().replace('\\', "/"))
    }

    /// Security audit lead 2: Restricted Mode `git log` must not run the repository's signature verifier.
    #[test]
    fn restricted_log_does_not_execute_signature_verifier() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        write(&root, "src/move.txt", "move\nsigned change\n");
        git(&root, &["commit", "-qam", "signed"]);
        sign_head(&root, "PGP SIGNATURE");
        let (marker, script) = verifier_script(&root);
        git(&root, &["config", "log.showSignature", "true"]);
        git(&root, &["config", "gpg.program", &script]);

        let repos = Repos::discover(&root, &|_| false).unwrap();
        let repo = repos.all().first().unwrap();
        repo.set_execution_allowed(false);
        let file = root.join("src/move.txt");
        type Call<'a> = (&'static str, Box<dyn Fn() + 'a>);
        let calls: [Call; 4] = [
            ("log_users", Box::new(|| assert_eq!(repo.log_users().unwrap(), ["Test <test@example.com>"]))),
            // Restricted Mode does not ask git to verify here: it reports E without starting it.
            (
                "log_details",
                Box::new(|| assert_eq!(repo.log_details("HEAD").unwrap().signature, "E", "signed, never verified")),
            ),
            // Passes --no-show-signature itself, so it never ran the verifier.
            (
                "file history",
                Box::new(|| {
                    let query = crate::LogQuery { path: Some(file.clone().into()), ..Default::default() };
                    assert!(!repo.log(&query).unwrap().is_empty(), "file history is empty");
                }),
            ),
            (
                "block_history",
                Box::new(|| {
                    let history =
                        repo.block_history(&file, None, (0, 1), encoding_rs::UTF_8, &CancellationToken::new()).unwrap();
                    assert!(!history.revisions.is_empty(), "block history is empty");
                }),
            ),
        ];
        let mut ran = Vec::new();
        for (name, call) in &calls {
            let _ = std::fs::remove_file(&marker);
            call();
            if marker.exists() {
                ran.push(*name);
            }
        }
        // Control: the fixture's verifier really runs when the same git is used directly.
        let _ = std::fs::remove_file(&marker);
        let git = cli::detected_git_executable().unwrap();
        let _ = Command::new(git).current_dir(&root).args(["log", "-1", "--format=%H"]).output();
        assert!(marker.exists(), "control: plain `git log` did not run gpg.program, fixture is not live");
        assert!(ran.is_empty(), "Restricted Mode ran the repository's gpg.program via: {ran:?}");
    }

    /// Security audit lead 2: turning signature display off is not enough. A git that is asked to
    /// verify (`%G?`, `--show-signature`, or a `format.pretty` the repository sets) runs the
    /// verifier of the signature's format (OpenPGP, SSH and X.509 each have a program key), so
    /// Restricted Mode must leave none of them pointing at the repository's program. And when
    /// nothing asks, the repository's `log.showSignature` must not make git look for one.
    #[test]
    fn restricted_git_does_not_execute_signature_verifier_when_asked_to_verify() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        let (marker, script) = verifier_script(&root);
        for key in ["gpg.program", "gpg.ssh.program", "gpg.x509.program"] {
            git(&root, &["config", key, &script]);
        }
        // git starts the SSH verifier only when an allowed-signers file exists.
        let signers = root.join(".git/allowed-signers");
        std::fs::write(&signers, "").unwrap();
        git(&root, &["config", "gpg.ssh.allowedSignersFile", &signers.to_str().unwrap().replace('\\', "/")]);

        git(&root, &["config", "format.pretty", "%H %G?"]);
        git(&root, &["config", "log.showSignature", "true"]);

        let unasked: &[&str] = &["log", "-1", "--format=%H"];
        let requests: [&[&str]; 4] = [
            &["log", "-1", "--format=%G?"],
            &["log", "-1", "--show-signature", "--format=%H"],
            &["log", "-1"],
            unasked,
        ];
        let mut ran = Vec::new();
        for armor in ["PGP SIGNATURE", "SSH SIGNATURE", "SIGNED MESSAGE"] {
            sign_head(&root, armor);
            for args in requests {
                for allowed in [false, true] {
                    let _ = std::fs::remove_file(&marker);
                    let out = {
                        let _scope = crate::ExecutionScope::enter(allowed);
                        cli::run(&root, args, None).unwrap()
                    };
                    assert!(!out.stdout.is_empty(), "{armor} {args:?}: git printed nothing");
                    if allowed {
                        // Control: the same request runs the fixture's verifier in a trusted project.
                        assert!(marker.exists(), "control: {armor} {args:?} did not run the verifier");
                    } else if marker.exists() {
                        ran.push(format!("{armor} {args:?}"));
                    } else if args == unasked {
                        // A git that looked for a verifier and found none says so here.
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        assert!(stderr.is_empty(), "{armor} {args:?}: git looked for a verifier: {stderr}");
                    }
                }
            }
        }
        assert!(ran.is_empty(), "Restricted Mode ran the repository's signature verifier via: {ran:?}");
    }

    /// A repository with a signed HEAD whose config has `git log` verify it with a program of
    /// its own. Returns the marker that program creates.
    fn signed_log_fixture(root: &Path) -> PathBuf {
        init(root, "main");
        git(root, &["config", "commit.gpgsign", "false"]);
        write(root, "src/move.txt", "move\nsigned change\n");
        git(root, &["commit", "-qam", "signed"]);
        sign_head(root, "PGP SIGNATURE");
        let (marker, script) = verifier_script(root);
        git(root, &["config", "log.showSignature", "true"]);
        git(root, &["config", "gpg.program", &script]);
        marker
    }

    /// Security audit lead 2: a repository nobody has vouched for is restricted. Execution is
    /// something a caller grants, not something it has to remember to take away.
    #[test]
    fn discovered_repository_runs_no_repository_program_until_execution_is_granted() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        let marker = signed_log_fixture(&root);

        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        let users = repo.log_users().unwrap();
        assert!(!marker.exists(), "a freshly discovered repository ran its gpg.program");
        assert_eq!(users, ["Test <test@example.com>"]);

        // Control: the same call runs the fixture's verifier once execution is granted.
        repo.set_execution_allowed(true);
        repo.log_users().unwrap();
        assert!(marker.exists(), "control: granting execution did not run gpg.program, fixture is not live");
    }

    /// Security audit lead 2: status is read through gitoxide, which runs the clean filter of
    /// the repository's config to compare a touched file with the index. A repository nobody
    /// has vouched for is opened without that config.
    #[test]
    fn discovered_repository_status_runs_no_repository_filter_until_execution_is_granted() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        let marker = root.join("filter-marker");
        let clean = format!("echo x > '{}'; cat", marker.to_str().unwrap().replace('\\', "/"));
        git(&root, &["config", "filter.marker.clean", &clean]);
        write(&root, ".gitattributes", "*.txt filter=marker\n");
        // Same length as the committed "move\n": only reading the content tells them apart.
        write(&root, "src/move.txt", "MOVE\n");

        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        let status = repo.status();
        assert!(!marker.exists(), "a freshly discovered repository ran its clean filter");
        assert!(status.unwrap().iter().any(|f| f.path.0.ends_with("move.txt")), "the touched file is not reported");

        // Control: the same call runs the fixture's filter once execution is granted.
        repo.set_execution_allowed(true);
        repo.status().unwrap();
        assert!(marker.exists(), "control: granting execution did not run the clean filter, fixture is not live");
    }

    /// Security audit lead 2: git started by code that declared no mode at all is restricted.
    #[test]
    fn git_started_outside_an_execution_scope_is_restricted() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        let marker = signed_log_fixture(&root);

        assert!(!cli::run(&root, &["log", "-1", "--format=%H"], None).unwrap().stdout.is_empty());
        assert!(!marker.exists(), "git outside an execution scope ran the repository's gpg.program");

        // Control: the same request runs the fixture's verifier inside a scope that allows it.
        {
            let _scope = crate::ExecutionScope::enter(true);
            cli::run(&root, &["log", "-1", "--format=%H"], None).unwrap();
        }
        assert!(marker.exists(), "control: an allowing scope did not run gpg.program, fixture is not live");
    }

    /// Security audit lead 2: git fetches an object it misses from a partial clone's promisor,
    /// running the `uploadpack` program the repository names. Listing a revision's directory in
    /// Restricted Mode must not.
    #[test]
    fn restricted_revision_listing_does_not_run_the_promisor_of_the_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = normalized(temp.path());
        init(&root, "main");
        let marker = root.join("lazy-fetch-marker");
        let spelled = |p: &Path| p.to_str().unwrap().replace('\\', "/");
        let out = Command::new("git").current_dir(&root).args(["rev-parse", "HEAD^{tree}"]).output().unwrap();
        let tree = String::from_utf8(out.stdout).unwrap().trim().to_owned();
        git(&root, &["config", "extensions.partialClone", "origin"]);
        git(&root, &["config", "remote.origin.url", &spelled(&root)]);
        git(&root, &["config", "remote.origin.promisor", "true"]);
        git(&root, &["config", "remote.origin.partialclonefilter", "blob:none"]);
        git(
            &root,
            &["config", "remote.origin.uploadpack", &format!("echo ran > '{}'; git-upload-pack", spelled(&marker))],
        );
        // The listing needs HEAD's tree; with it gone, git asks the promisor for it.
        std::fs::remove_file(root.join(".git/objects").join(&tree[..2]).join(&tree[2..])).unwrap();

        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        repo.set_execution_allowed(false);
        assert!(repo.revision_children("HEAD", "").is_err(), "the tree is missing and must stay missing");
        assert!(!marker.exists(), "Restricted Mode ran the repository's uploadpack");

        // Control: in a trusted project the same listing asks the promisor.
        repo.set_execution_allowed(true);
        let _ = repo.revision_children("HEAD", "");
        assert!(marker.exists(), "control: a trusted listing did not run uploadpack, fixture is not live");
    }
}
