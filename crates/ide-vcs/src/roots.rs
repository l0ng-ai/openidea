//! The repositories of a project (IDEA's VCS roots): the one containing the project
//! root plus those nested below it (separate clones side by side, submodules).

use crate::{Backend, FileStatus, Repo};
use ide_core::{IdeError, IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// How deep below the project root nested repositories are looked for.
const MAX_DEPTH: usize = 4;

/// Folders never searched for nested repositories (dependencies, build output).
const SKIPPED: &[&str] = &["node_modules", "target", "build", "dist", "out", "vendor", "venv", "__pycache__"];

/// The repositories of a project, sorted by root; lookups pick the innermost one.
#[derive(Clone, Default)]
pub struct Repos {
    repos: Vec<Arc<Repo>>,
    primary: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateTarget {
    pub root: IpcPath,
    pub parent: Option<IpcPath>,
    pub detached_submodule: bool,
}

impl Repos {
    /// Discovers repositories in independent project folders of a workspace.
    pub fn discover_roots(roots: &[PathBuf], skip: &dyn Fn(&Path) -> bool) -> IdeResult<Self> {
        let mut repos = Vec::new();
        for root in roots {
            for repo in Self::discover(root, skip)?.repos {
                if !repos.iter().any(|r: &Arc<Repo>| r.root() == repo.root()) {
                    repos.push(repo);
                }
            }
        }
        repos.sort_by(|a, b| a.root().cmp(b.root()));
        let primary = (!repos.is_empty()).then_some(0);
        Ok(Self { repos, primary })
    }

    /// The repository containing `project_root` and every repository whose worktree
    /// root lies below it (up to [`MAX_DEPTH`] levels; hidden and dependency folders and
    /// folders `skip` rejects are not searched).
    pub fn discover(project_root: &Path, skip: &dyn Fn(&Path) -> bool) -> IdeResult<Self> {
        let mut repos: Vec<Repo> = Vec::new();
        if let Some(r) = Repo::discover(project_root)? {
            repos.push(r);
        }
        let mut stack: Vec<(PathBuf, usize)> = vec![(project_root.to_path_buf(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let path = entry.path();
                if name.starts_with('.') || SKIPPED.contains(&name.as_ref()) || skip(&path) {
                    continue;
                }
                if path.join(".git").exists()
                    && let Ok(Some(r)) = Repo::discover(&path)
                    && r.root() == path
                    && !repos.iter().any(|x| x.root() == r.root())
                {
                    repos.push(r);
                }
                if depth + 1 < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            }
        }
        // Declared submodules remain Git roots under ignored folders or beyond the
        // filesystem scan's depth. An uninitialized submodule has no Git worktree.
        let mut next = 0;
        while next < repos.len() {
            let parent = &repos[next];
            let children = parent.initialized_submodules().unwrap_or_else(|error| {
                tracing::debug!(root = %parent.root().display(), %error, "cannot list Git submodules");
                Vec::new()
            });
            for path in children {
                if path.starts_with(project_root)
                    && !repos.iter().any(|r| r.root() == path)
                    && let Ok(Some(repo)) = Repo::discover(&path)
                    && repo.root() == path
                {
                    repos.push(repo);
                }
            }
            next += 1;
        }
        Ok(Self::new(repos, project_root))
    }

    /// Only the repository containing `project_root` (the quick lookup on project open).
    pub fn enclosing(project_root: &Path) -> IdeResult<Self> {
        Ok(Self::new(Repo::discover(project_root)?.into_iter().collect(), project_root))
    }

    /// Directory Mappings applied: the repositories at `excluded` roots are dropped (their
    /// files stay in the project) and those at `added` roots join, the primary one being the
    /// repository of `project_root` if it remains.
    pub fn mapped(&self, excluded: &[PathBuf], added: &[PathBuf], project_root: &Path) -> Self {
        let same = |a: &Path, b: &Path| a == b || dunce::canonicalize(a).ok() == dunce::canonicalize(b).ok();
        let mut repos: Vec<Arc<Repo>> =
            self.repos.iter().filter(|r| !excluded.iter().any(|e| same(e, r.root()))).cloned().collect();
        for root in added {
            if excluded.iter().any(|e| same(e, root)) || repos.iter().any(|r| same(r.root(), root)) {
                continue;
            }
            match Repo::discover(root) {
                Ok(Some(r)) if same(r.root(), root) => repos.push(Arc::new(r)),
                Ok(_) => tracing::debug!("mapped directory {} is not a git root", root.display()),
                Err(e) => tracing::debug!("mapped directory {}: {}", root.display(), e.message),
            }
        }
        repos.sort_by(|a, b| a.root().cmp(b.root()));
        let roots: Vec<&Path> = repos.iter().map(|r| r.root()).collect();
        let primary = innermost(&roots, project_root, false).or((!repos.is_empty()).then_some(0));
        Self { repos, primary }
    }

    /// Worktree roots, sorted.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.repos.iter().map(|r| r.root().to_path_buf()).collect()
    }

    fn new(mut repos: Vec<Repo>, project_root: &Path) -> Self {
        repos.sort_by(|a, b| a.root().cmp(b.root()));
        let repos: Vec<Arc<Repo>> = repos.into_iter().map(Arc::new).collect();
        let roots: Vec<&Path> = repos.iter().map(|r| r.root()).collect();
        let primary = innermost(&roots, project_root, false).or((!repos.is_empty()).then_some(0));
        Self { repos, primary }
    }

    pub fn is_empty(&self) -> bool {
        self.repos.is_empty()
    }

    pub fn all(&self) -> &[Arc<Repo>] {
        &self.repos
    }

    /// Selects the roots that Update Project operates on. Detached children are
    /// included with their selected superproject and read its updated pointer.
    pub fn project_update_plan(&self, roots: &[Option<PathBuf>]) -> IdeResult<Vec<ProjectUpdateTarget>> {
        let selected: BTreeSet<&Path> = if roots.is_empty() {
            self.repos.iter().map(|repo| repo.root()).collect()
        } else {
            roots
                .iter()
                .map(|root| {
                    match root {
                        Some(root) => self.at_root(root),
                        None => self.primary(),
                    }
                    .map(|repo| repo.root())
                    .ok_or_else(|| IdeError::unavailable("The selected repository is no longer part of the project"))
                })
                .collect::<IdeResult<_>>()?
        };
        let mut parents = BTreeMap::new();
        for parent in &self.repos {
            for path in parent.initialized_submodules().unwrap_or_default() {
                parents.insert(path, parent.root());
            }
        }
        let mut included = BTreeSet::new();
        let mut targets = Vec::new();
        for repo in &self.repos {
            let root = repo.root();
            let parent = parents.get(root).copied();
            let is_selected = selected.contains(root);
            if !is_selected && !parent.is_some_and(|p| included.contains(p)) {
                continue;
            }
            let (branch, head) = repo.head()?;
            let detached_submodule = branch.is_none() && head.is_some() && parent.is_some();
            if is_selected || detached_submodule {
                included.insert(root);
                targets.push(ProjectUpdateTarget {
                    root: root.into(),
                    parent: parent.map(Into::into),
                    detached_submodule,
                });
            }
        }
        Ok(targets)
    }

    /// The repository of the project root, else the first one.
    pub fn primary(&self) -> Option<&Arc<Repo>> {
        self.primary.map(|i| &self.repos[i])
    }

    /// The innermost repository containing `path` (a file or folder). A nested repository's
    /// root is an entry of the enclosing repository (a submodule or untracked folder there), so
    /// it belongs to that one; to the repository itself only when nothing encloses it.
    pub fn for_path(&self, path: &Path) -> Option<&Arc<Repo>> {
        let roots: Vec<&Path> = self.repos.iter().map(|r| r.root()).collect();
        let found = innermost(&roots, path, true).or_else(|| {
            // Another spelling of the same location (symlinks, /var vs /private/var).
            let canon = dunce::canonicalize(path).ok()?;
            let roots: Vec<PathBuf> =
                roots.iter().map(|r| dunce::canonicalize(r).unwrap_or_else(|_| r.to_path_buf())).collect();
            innermost(&roots.iter().map(PathBuf::as_path).collect::<Vec<_>>(), &canon, true)
        });
        found.map(|i| &self.repos[i])
    }

    /// The repository whose worktree root is `root` (the repository a repository-scoped
    /// command was given).
    pub fn at_root(&self, root: &Path) -> Option<&Arc<Repo>> {
        self.repos.iter().find(|r| r.root() == root).or_else(|| {
            let canon = dunce::canonicalize(root).ok()?;
            self.repos.iter().find(|r| dunce::canonicalize(r.root()).is_ok_and(|r| r == canon))
        })
    }

    /// `paths` grouped by the repository each belongs to (paths outside every repository are dropped).
    pub fn group(&self, paths: &[PathBuf]) -> Vec<(Arc<Repo>, Vec<PathBuf>)> {
        let mut out: Vec<(Arc<Repo>, Vec<PathBuf>)> = Vec::new();
        for p in paths {
            let Some(repo) = self.for_path(p) else { continue };
            match out.iter_mut().find(|(r, _)| Arc::ptr_eq(r, repo)) {
                Some((_, list)) => list.push(p.clone()),
                None => out.push((repo.clone(), vec![p.clone()])),
            }
        }
        out
    }

    /// Changes of every repository. A nested repository reports its own files, so the
    /// enclosing one's "untracked folder" entry for it, and its entries inside it, are dropped. A repository that cannot
    /// be read (e.g. deleted since the last scan) is left out; fails only when all fail.
    ///
    /// The reads go through [`Backend`], the Changes-view surface — repositories of a
    /// future second backend slot in here once `Repos` learns to hold them.
    pub fn status(&self) -> IdeResult<Vec<FileStatus>> {
        self.read_status(self.all_status_groups(), |repo, _| (repo as &dyn Backend).status())
    }

    /// Ignored entries for the staging tree. Commit and status consumers read the regular status.
    pub fn ignored_files(&self) -> IdeResult<Vec<FileStatus>> {
        self.read_status(self.all_status_groups(), |repo, _| repo.ignored_files())
    }

    fn all_status_groups(&self) -> Vec<(Arc<Repo>, Vec<PathBuf>)> {
        self.repos.iter().map(|repo| (repo.clone(), Vec::new())).collect()
    }

    /// [`status`](Self::status) for `paths` only: each path goes to its innermost repository,
    /// so a repository without one is not read at all and a nested repository keeps its own
    /// files (the enclosing one's "untracked folder" entry for them is dropped).
    pub fn status_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<FileStatus>> {
        self.read_status(self.group(paths), |repo, mine| (repo as &dyn Backend).status_paths(mine))
    }

    /// A nested repository reports its own files. When a repository cannot be read,
    /// the operation can still display the other repositories' results.
    fn read_status(
        &self,
        groups: Vec<(Arc<Repo>, Vec<PathBuf>)>,
        status: impl Fn(&Repo, &[PathBuf]) -> IdeResult<Vec<FileStatus>>,
    ) -> IdeResult<Vec<FileStatus>> {
        let mut out = Vec::new();
        let mut first_error = None;
        let mut read = 0;
        for (repo, mine) in groups {
            let nested: Vec<&Path> = self
                .repos
                .iter()
                .map(|r| r.root())
                .filter(|r| *r != repo.root() && r.starts_with(repo.root()))
                .collect();
            let status = match status(&repo, &mine) {
                Ok(status) => {
                    read += 1;
                    status
                }
                Err(e) => {
                    tracing::warn!("git status of {}: {e}", repo.root().display());
                    first_error.get_or_insert(e);
                    continue;
                }
            };
            // A file belongs to its innermost repository: the nested one reports what lies
            // inside it, including files the enclosing one still tracks there (#4990).
            out.extend(status.into_iter().filter(|f| {
                let skipped_root =
                    matches!(f.unstaged, Some(crate::ChangeKind::Untracked | crate::ChangeKind::Ignored))
                        && nested.iter().any(|n| f.path.0 == *n);
                let in_nested = nested.iter().any(|n| f.path.0 != *n && f.path.0.starts_with(n));
                !skipped_root && !in_nested
            }));
        }
        match first_error {
            Some(e) if read == 0 => Err(e),
            _ => Ok(out),
        }
    }
}

/// Index of the innermost of `roots` containing `path`. With `strict`, a root equal to
/// `path` counts only when no other root contains it.
fn innermost(roots: &[&Path], path: &Path, strict: bool) -> Option<usize> {
    let best = |strict: bool| {
        roots
            .iter()
            .enumerate()
            .filter(|(_, r)| path.starts_with(r) && !(strict && **r == path))
            .max_by_key(|(_, r)| r.as_os_str().len())
            .map(|(i, _)| i)
    };
    best(strict).or_else(|| best(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let ok = Command::new("git").args(["init", "-q"]).current_dir(dir).status().is_ok_and(|s| s.success());
        assert!(ok, "git init in {}", dir.display());
    }

    #[test]
    fn ignored_files_use_git_rules_without_listing_other_repositories_twice() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let nested = root.join("nested");
        git_init(&root);
        git_init(&nested);
        std::fs::write(root.join(".gitignore"), "*.tmp\n!visible.tmp\ncache/\nnested/\n").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "/private.txt\n").unwrap();
        std::fs::write(nested.join(".gitignore"), "/nested-private.txt\n").unwrap();
        std::fs::create_dir(root.join("cache")).unwrap();
        std::fs::create_dir(root.join("plain-folder")).unwrap();
        for path in [
            "space name.tmp",
            "visible.tmp",
            "tracked.tmp",
            "cache/child.txt",
            "plain-folder/child.tmp",
            "private.txt",
            "nested/nested-private.txt",
        ] {
            std::fs::write(root.join(path), "fixture\n").unwrap();
        }
        assert!(
            Command::new("git").args(["add", "-f", "--", "tracked.tmp"]).current_dir(&root).status().unwrap().success()
        );
        let repos = Repos::discover(&root, &|_| false).unwrap();
        let files = repos.ignored_files().unwrap();
        assert!(files.iter().all(|file| file.unstaged == Some(crate::ChangeKind::Ignored) && file.staged.is_none()));
        let listed: BTreeSet<_> = files.iter().map(|file| (file.path.0.clone(), file.rel_path.as_str())).collect();
        assert_eq!(
            listed,
            BTreeSet::from([
                (root.join("cache"), "cache/"),
                (root.join("plain-folder/child.tmp"), "plain-folder/child.tmp"),
                (root.join("private.txt"), "private.txt"),
                (root.join("space name.tmp"), "space name.tmp"),
                (nested.join("nested-private.txt"), "nested-private.txt"),
            ])
        );
        assert!(repos.status().unwrap().iter().all(|file| file.unstaged != Some(crate::ChangeKind::Ignored)));
    }

    #[test]
    fn directory_mappings_exclude_and_add_repositories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        let outside = root.parent().unwrap().join("sdk");
        git_init(&root);
        git_init(&root.join("app"));
        git_init(&root.join("reference-sdk"));
        git_init(&root.join("a/b/c/d/deep"));
        git_init(&outside);

        let detected = Repos::discover(&root, &|_| false).unwrap();
        let mapped =
            detected.mapped(&[root.join("reference-sdk")], &[outside.clone(), root.join("a/b/c/d/deep")], &root);
        let roots: Vec<&Path> = mapped.all().iter().map(|r| r.root()).collect();
        assert_eq!(roots, [root.as_path(), &root.join("a/b/c/d/deep"), &root.join("app"), &outside]);
        assert_eq!(mapped.primary().unwrap().root(), root);
        // The excluded repository's files belong to the enclosing one again.
        assert_eq!(mapped.for_path(&root.join("reference-sdk/lib.rs")).unwrap().root(), root);

        // The project root excluded: only the other repositories remain; a folder that is no
        // repository root is not added.
        let without_root = detected.mapped(std::slice::from_ref(&root), &[root.join("a")], &root);
        let roots: Vec<&Path> = without_root.all().iter().map(|r| r.root()).collect();
        assert_eq!(roots, [&root.join("app"), &root.join("reference-sdk")]);
        assert!(without_root.for_path(&root.join("README.md")).is_none());
    }

    #[test]
    fn finds_nested_repositories_and_routes_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git_init(&root);
        git_init(&root.join("services/api"));
        git_init(&root.join("web"));
        git_init(&root.join("node_modules/dep"));
        git_init(&root.join(".cache/repo"));
        std::fs::write(root.join("services/api/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();

        let repos = Repos::discover(&root, &|_| false).unwrap();
        let roots: Vec<&Path> = repos.all().iter().map(|r| r.root()).collect();
        assert_eq!(roots, [root.as_path(), &root.join("services/api"), &root.join("web")]);
        assert_eq!(repos.primary().unwrap().root(), root);
        assert_eq!(repos.for_path(&root.join("services/api/main.rs")).unwrap().root(), root.join("services/api"));
        assert_eq!(repos.for_path(&root.join("services/other.txt")).unwrap().root(), root);
        // A nested root is the enclosing repository's entry (submodule / untracked folder).
        assert_eq!(repos.for_path(&root.join("services/api")).unwrap().root(), root);
        assert_eq!(repos.for_path(&root).unwrap().root(), root);
        assert_eq!(repos.at_root(&root.join("services/api")).unwrap().root(), root.join("services/api"));
        assert!(repos.at_root(&root.join("services")).is_none());

        let status = repos.status().unwrap();
        let paths: Vec<String> =
            status.iter().map(|f| f.path.0.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert!(paths.contains(&"README.md".to_owned()), "{paths:?}");
        assert!(paths.contains(&"services/api/main.rs".to_owned()), "{paths:?}");
        assert!(
            !paths.iter().any(|p| p.trim_end_matches('/') == "web"),
            "nested root is not an untracked folder: {paths:?}"
        );

        let groups = repos.group(&[root.join("README.md"), root.join("services/api/main.rs"), root.join("web/x")]);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[1].1, [root.join("services/api/main.rs")]);

        let skipped = Repos::discover(&root, &|p| p.ends_with("services")).unwrap();
        assert_eq!(skipped.all().len(), 2);
    }

    /// A workspace: members in repositories of their own (one with a nested repository, not a
    /// submodule), a plain folder, and a member that is a subfolder of a bigger repository; the
    /// container's agent folder links to each member and must not add a repository again.
    #[cfg(unix)]
    #[test]
    fn workspace_members_bring_their_repositories_once() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let (api, web, plain, mono) = (base.join("api"), base.join("web"), base.join("plain"), base.join("mono"));
        git_init(&api);
        git_init(&api.join("libs/sdk"));
        git_init(&web);
        std::fs::create_dir_all(&plain).unwrap();
        git_init(&mono);
        let docs = mono.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let container = base.join("ws");
        let links = container.join(".openidea/agent-root");
        std::fs::create_dir_all(&links).unwrap();
        for (name, target) in [("api", &api), ("web", &web), ("plain", &plain), ("docs", &docs)] {
            std::os::unix::fs::symlink(target, links.join(name)).unwrap();
            // A link elsewhere in the container: never followed either.
            std::os::unix::fs::symlink(target, container.join(name)).unwrap();
        }

        let roots = [container.clone(), api.clone(), web.clone(), plain.clone(), docs.clone()];
        let repos = Repos::discover_roots(&roots, &|_| false).unwrap();
        let found: Vec<&Path> = repos.all().iter().map(|r| r.root()).collect();
        assert_eq!(found, [api.as_path(), &api.join("libs/sdk"), &mono, &web]);
        let file = api.join("libs/sdk/lib.rs");
        assert_eq!(repos.for_path(&file).unwrap().root(), api.join("libs/sdk"), "a nested file is its own repo's");
        assert_eq!(repos.for_path(&docs.join("a.md")).unwrap().root(), mono, "a subfolder member is its repo's");
        assert!(repos.for_path(&plain.join("x")).is_none());
    }

    /// A folder the enclosing repository still tracks became a repository of its own: both
    /// report its files, and each file must be listed once, by its innermost repository (#4990).
    #[test]
    fn a_file_of_a_nested_repository_is_listed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git_init(&root);
        std::fs::create_dir_all(root.join("web")).unwrap();
        std::fs::write(root.join("web/page.html"), "v1").unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let ok = Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(dir)
                .status()
                .is_ok_and(|s| s.success());
            assert!(ok, "git {args:?}");
        };
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "init"]);
        git_init(&root.join("web"));
        std::fs::write(root.join("web/page.html"), "v2").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();

        let repos = Repos::discover(&root, &|_| false).unwrap();
        assert_eq!(repos.all().len(), 2);
        for status in [repos.status().unwrap(), repos.status_paths(&[root.join("web/page.html")]).unwrap()] {
            let page: Vec<_> = status.iter().filter(|f| f.path.0 == root.join("web/page.html")).collect();
            assert_eq!(page.len(), 1, "{status:?}");
            assert_eq!(page[0].rel_path, "page.html", "listed by the nested repository");
        }
    }

    #[test]
    fn side_by_side_repositories_without_an_enclosing_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git_init(&root.join("a"));
        git_init(&root.join("b"));
        let repos = Repos::discover(&root, &|_| false).unwrap();
        assert_eq!(repos.all().len(), 2);
        assert_eq!(repos.primary().unwrap().root(), root.join("a"), "the first when none contains the project root");
        assert!(repos.for_path(&root.join("c.txt")).is_none());
    }
}
