//! Bounded discovery of independent projects selected through the workspace folder picker.

use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 4;
const MAX_ENTRIES: usize = 20_000;
const SKIP_DIRS: &[&str] = &["node_modules", "target", "build", "dist", "vendor", ".venv", ".git"];

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct DiscoveredProject {
    pub path: IpcPath,
    pub root: IpcPath,
    pub relative_path: String,
}

#[derive(Debug, Default, Serialize, Deserialize, specta::Type)]
pub struct ProjectDiscovery {
    /// Selected projects and folders with no discovered projects retain the direct-add behaviour.
    pub direct: Vec<IpcPath>,
    pub projects: Vec<DiscoveredProject>,
    pub truncated: bool,
}

fn check_cancel(cancel: &CancellationToken) -> IdeResult<()> {
    if cancel.is_cancelled() { Err(IdeError::cancelled()) } else { Ok(()) }
}

fn is_project(dir: &Path, cancel: &CancellationToken) -> IdeResult<bool> {
    for marker in crate::roots::BUILD_FILES.iter().chain([".git", ".idea", "CMakeLists.txt"].iter()) {
        check_cancel(cancel)?;
        if std::fs::symlink_metadata(dir.join(marker))
            .is_ok_and(|m| m.is_file() || matches!(*marker, ".git" | ".idea") && m.is_dir())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Does not follow symlinks or descend into a project. The entry budget spans all selected folders.
pub fn discover(folders: Vec<PathBuf>, cancel: &CancellationToken) -> IdeResult<ProjectDiscovery> {
    discover_with_limit(folders, cancel, MAX_ENTRIES)
}

fn discover_with_limit(
    folders: Vec<PathBuf>,
    cancel: &CancellationToken,
    mut remaining: usize,
) -> IdeResult<ProjectDiscovery> {
    let mut result = ProjectDiscovery::default();
    let mut seen_roots = HashSet::new();
    let mut seen_projects = HashSet::new();
    for root in folders {
        check_cancel(cancel)?;
        if !seen_roots.insert(root.clone()) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&root)?;
        // A link explicitly selected by the picker may still be added, but never traversed.
        if metadata.is_symlink() || is_project(&root, cancel)? {
            result.direct.push(root.into());
            continue;
        }
        if !metadata.is_dir() {
            return Err(IdeError::invalid("Choose a project folder"));
        }
        let mut found = false;
        let mut queue = VecDeque::from([(root.clone(), 0)]);
        while let Some((dir, depth)) = queue.pop_front() {
            check_cancel(cancel)?;
            if depth > 0 && is_project(&dir, cancel)? {
                found = true;
                if seen_projects.insert(dir.clone()) {
                    result.projects.push(DiscoveredProject {
                        relative_path: ide_core::ipc_path::to_ipc(dir.strip_prefix(&root).unwrap()),
                        path: dir.into(),
                        root: root.clone().into(),
                    });
                }
                continue;
            }
            if depth == MAX_DEPTH {
                continue;
            }
            if remaining == 0 {
                result.truncated = true;
                continue;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if depth == 0 => return Err(error.into()),
                Err(_) => continue,
            };
            let mut children = Vec::new();
            for entry in entries {
                check_cancel(cancel)?;
                if remaining == 0 {
                    result.truncated = true;
                    break;
                }
                remaining -= 1;
                let Ok(entry) = entry else { continue };
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    children.push(entry.path());
                }
            }
            children.sort();
            queue.extend(children.into_iter().map(|path| (path, depth + 1)));
        }
        if !found {
            result.direct.push(root.into());
        }
    }
    check_cancel(cancel)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project(root: &Path, relative: &str, marker: &str) -> PathBuf {
        let dir = root.join(relative);
        fs::create_dir_all(&dir).unwrap();
        if marker == ".idea" || marker == ".git" {
            fs::create_dir(dir.join(marker)).unwrap();
        } else {
            fs::write(dir.join(marker), "").unwrap();
        }
        dir
    }

    #[test]
    fn detects_shared_build_files_and_workspace_markers_without_descending() {
        for marker in crate::roots::BUILD_FILES.iter().chain([".git", ".idea", "CMakeLists.txt"].iter()) {
            let tmp = tempfile::tempdir().unwrap();
            let parent = project(tmp.path(), "app", marker);
            project(&parent, "module", "package.json");
            let result = discover(vec![tmp.path().into()], &CancellationToken::new()).unwrap();
            assert!(result.direct.is_empty(), "{marker}");
            assert_eq!(result.projects.len(), 1, "{marker}");
            assert_eq!(result.projects[0].path, parent);
            assert_eq!(result.projects[0].relative_path, "app");
            let direct = discover(vec![parent.clone()], &CancellationToken::new()).unwrap();
            assert_eq!(direct.direct[0], parent);
            assert!(direct.projects.is_empty());
        }
    }

    #[test]
    fn skips_dependencies_outputs_and_hidden_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // .git is itself a marker, so test it below a hidden directory.
        for skip in SKIP_DIRS.iter().filter(|name| **name != ".git").chain([&".hidden"]) {
            project(root, &format!("{skip}/app"), "Cargo.toml");
        }
        project(root, ".hidden/.git/app", "go.mod");
        let result = discover(vec![root.into()], &CancellationToken::new()).unwrap();
        assert!(result.projects.is_empty());
        assert_eq!(result.direct[0], root);
    }

    #[test]
    fn finds_depth_four_but_not_five_and_retains_empty_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let expected = project(tmp.path(), "a/b/c/app", "pom.xml");
        project(tmp.path(), "deep/b/c/d/app", "package.json");
        let empty = tmp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        let result = discover(vec![tmp.path().into(), empty.clone()], &CancellationToken::new()).unwrap();
        assert_eq!(result.projects.len(), 1);
        assert_eq!(result.projects[0].path, expected);
        assert_eq!(result.direct[0], empty);
    }

    #[test]
    fn deduplicates_overlapping_selections_and_shares_the_entry_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        project(root, "a/app", "go.mod");
        let result = discover(vec![root.into(), root.join("a"), root.into()], &CancellationToken::new()).unwrap();
        assert_eq!(result.projects.len(), 1);
        assert!(result.direct.is_empty());
        let result = discover_with_limit(vec![root.into(), root.join("a")], &CancellationToken::new(), 1).unwrap();
        assert!(result.truncated);
        assert!(result.projects.is_empty());
    }

    #[test]
    fn cancellation_also_stops_direct_adds() {
        let tmp = tempfile::tempdir().unwrap();
        let root = project(tmp.path(), "app", "Cargo.toml");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = discover(vec![root], &cancel).unwrap_err();
        assert_eq!(error.kind, ide_core::error::ErrorKind::Cancelled);
    }

    #[test]
    fn git_worktree_files_are_project_markers() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(".git"), "gitdir: ../main/.git/worktrees/app").unwrap();
        let result = discover(vec![tmp.path().into()], &CancellationToken::new()).unwrap();
        assert_eq!(result.direct[0], tmp.path().to_path_buf());
        assert!(result.projects.is_empty());
    }

    #[test]
    fn reports_truncation_and_keeps_projects_found_before_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let expected = project(&first, "app", "Cargo.toml");
        let second = tmp.path().join("second");
        project(&second, "app", "package.json");
        let result = discover_with_limit(vec![first, second.clone()], &CancellationToken::new(), 1).unwrap();
        assert!(result.truncated);
        assert_eq!(result.projects.len(), 1);
        assert_eq!(result.projects[0].path, expected);
        assert_eq!(result.direct[0], second);
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlink_loops_or_linked_projects_or_markers() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("container");
        fs::create_dir(&root).unwrap();
        let external = project(tmp.path(), "outside", "package.json");
        symlink(&root, root.join("loop")).unwrap();
        symlink(&external, root.join("linked")).unwrap();
        symlink(external.join("package.json"), root.join("package.json")).unwrap();
        let result = discover(vec![root.clone()], &CancellationToken::new()).unwrap();
        assert!(result.projects.is_empty());
        assert_eq!(result.direct[0], root);
    }
}
