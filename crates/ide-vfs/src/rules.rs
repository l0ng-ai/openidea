//! Ignore rules shared by directory listing, walking and watching:
//! user exclude globs plus layered `.gitignore` / `.ignore` files.

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// Exclude globs from settings (`files.exclude`), e.g. `**/node_modules`.
///
/// Patterns are matched against paths relative to a base directory; a path is
/// excluded when it or any of its ancestors (below the base) matches. Patterns
/// without a `/` match at any depth, like gitignore; a leading `/` anchors at the base.
#[derive(Clone, Debug)]
pub struct ExcludeMatcher {
    set: GlobSet,
}

impl ExcludeMatcher {
    pub fn new(patterns: &[String]) -> Self {
        let mut builder = GlobSetBuilder::new();
        for raw in patterns {
            let pattern = raw.trim().trim_end_matches('/');
            if pattern.is_empty() {
                continue;
            }
            // A leading `/` anchors the pattern at the base, like gitignore.
            let anchored = pattern.starts_with('/');
            let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
            if pattern.is_empty() {
                continue;
            }
            let mut variants = vec![pattern.to_owned()];
            if !anchored && !pattern.contains('/') {
                variants.push(format!("**/{pattern}"));
            }
            for v in variants {
                match Glob::new(&v) {
                    Ok(glob) => {
                        builder.add(glob);
                    }
                    Err(e) => tracing::warn!("invalid exclude pattern {raw:?}: {e}"),
                }
            }
        }
        let set = builder.build().unwrap_or_else(|e| {
            tracing::warn!("invalid exclude patterns: {e}");
            GlobSet::empty()
        });
        Self { set }
    }

    /// Whether `rel` itself matches (ancestors are not consulted).
    pub fn is_match(&self, rel: &Path) -> bool {
        !self.set.is_empty() && self.set.is_match(rel)
    }

    /// `rel` is relative to the base directory.
    pub fn is_excluded(&self, rel: &Path) -> bool {
        if self.set.is_empty() {
            return false;
        }
        rel.ancestors().filter(|p| !p.as_os_str().is_empty()).any(|p| self.set.is_match(p))
    }
}

/// Walks up from `start` looking for a directory containing `.git`.
pub(crate) fn find_repo_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|dir| dir.join(".git").exists()).map(Path::to_path_buf)
}

/// `info/exclude` of the repository at `root` (shared by its worktrees).
fn exclude_path(root: &Path) -> PathBuf {
    gix::discover(root)
        .ok()
        .map(|r| r.common_dir().join("info/exclude"))
        .unwrap_or_else(|| root.join(".git/info/exclude"))
}

#[derive(Default)]
struct NestedRepos {
    /// Directory -> enclosing repository root when different from `GitignoreStack::repo_root`.
    by_dir: HashMap<PathBuf, Option<PathBuf>>,
    /// Repository root -> shared `GitignoreStack` for that nested repository.
    by_root: HashMap<PathBuf, Arc<GitignoreStack>>,
}

/// Layered gitignore matching: per-directory `.gitignore` / `.ignore` from the
/// path's directory up to the repository root (or the file system root when
/// not in a repository), then `.git/info/exclude` and the global excludes file.
pub(crate) struct GitignoreStack {
    repo_root: Option<PathBuf>,
    /// `.git/info/exclude` and the global excludes file, rooted at the repo root.
    repo_level: RwLock<Vec<Gitignore>>,
    cache: Mutex<HashMap<PathBuf, Option<Arc<Gitignore>>>>,
    nested: Mutex<NestedRepos>,
}

/// How long [`GitignoreStack::cached`] reuses the repository lookup of a directory.
const REPO_LEVEL_TTL: Duration = Duration::from_secs(3);

/// What changes when `.git/info/exclude` is edited.
type Stamp = Option<(SystemTime, u64)>;

struct RepoLevel {
    at: Instant,
    repo_root: Option<PathBuf>,
    /// `<common dir>/info/exclude`, found by a repository discovery.
    exclude: Option<PathBuf>,
    stamp: Stamp,
    rules: Vec<Gitignore>,
}

/// Repo-level rules by the directory they were looked up for.
static REPO_LEVEL: Mutex<Option<HashMap<PathBuf, Arc<RepoLevel>>>> = Mutex::new(None);

fn stamp_of(file: Option<&Path>) -> Stamp {
    let meta = std::fs::metadata(file?).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl GitignoreStack {
    pub fn new(near: &Path) -> Self {
        let repo_root = find_repo_root(near);
        let repo_level = RwLock::new(Self::load_repo_level(repo_root.as_deref()));
        Self { repo_root, repo_level, cache: Mutex::default(), nested: Mutex::default() }
    }

    /// [`new`](Self::new) for listing a directory over and over (expanding a tree, a slow share):
    /// the walk up to the repository root and the repository discovery are reused for
    /// [`REPO_LEVEL_TTL`]. An edit of `.git/info/exclude` is still seen at once (its mtime and size
    /// are checked), as is any `.gitignore` / `.ignore`, which are read fresh. Only a repository
    /// created in the directory, or a change of the global excludes file, can lag by the TTL.
    pub fn cached(near: &Path) -> Self {
        let now = Instant::now();
        let hit = REPO_LEVEL
            .lock()
            .as_ref()
            .and_then(|m| m.get(near))
            .cloned()
            .filter(|e| now.duration_since(e.at) < REPO_LEVEL_TTL && stamp_of(e.exclude.as_deref()) == e.stamp);
        let entry = hit.unwrap_or_else(|| {
            let repo_root = find_repo_root(near);
            let exclude = repo_root.as_deref().map(exclude_path);
            let entry = Arc::new(RepoLevel {
                at: now,
                stamp: stamp_of(exclude.as_deref()),
                rules: Self::load_repo_level_from(repo_root.as_deref(), exclude.as_deref()),
                repo_root,
                exclude,
            });
            let mut guard = REPO_LEVEL.lock();
            let map = guard.get_or_insert_with(HashMap::new);
            map.retain(|_, e| now.duration_since(e.at) < REPO_LEVEL_TTL);
            map.insert(near.to_path_buf(), entry.clone());
            entry
        });
        Self {
            repo_root: entry.repo_root.clone(),
            repo_level: RwLock::new(entry.rules.clone()),
            cache: Mutex::default(),
            nested: Mutex::default(),
        }
    }

    fn load_repo_level(repo_root: Option<&Path>) -> Vec<Gitignore> {
        Self::load_repo_level_from(repo_root, repo_root.map(exclude_path).as_deref())
    }

    fn load_repo_level_from(repo_root: Option<&Path>, exclude: Option<&Path>) -> Vec<Gitignore> {
        let mut repo_level = Vec::new();
        if let Some(root) = repo_root {
            let mut builder = GitignoreBuilder::new(root);
            if let Some(exclude) = exclude.filter(|f| f.is_file()) {
                builder.add(exclude);
            }
            if let Ok(gi) = builder.build()
                && !gi.is_empty()
            {
                repo_level.push(gi);
            }
            let (global, err) = GitignoreBuilder::new(root).build_global();
            if let Some(err) = err {
                tracing::debug!("global gitignore: {err}");
            }
            if !global.is_empty() {
                repo_level.push(global);
            }
        }
        repo_level
    }

    /// Re-reads `.git/info/exclude` and the global excludes file.
    pub fn reload_repo_level(&self) {
        if let (Some(root), Some(map)) = (&self.repo_root, REPO_LEVEL.lock().as_mut()) {
            map.retain(|dir, _| !dir.starts_with(root));
        }
        self.nested.lock().by_root.values().for_each(|s| s.reload_repo_level());
        *self.repo_level.write() = Self::load_repo_level(self.repo_root.as_deref());
    }

    /// Forgets the cached rules of `dir` and every directory below it.
    pub fn invalidate_tree(&self, dir: &Path) {
        {
            let mut nested = self.nested.lock();
            let target = if dir.file_name().is_some_and(|n| n == ".git") { dir.parent().unwrap_or(dir) } else { dir };
            if nested.by_dir.contains_key(target) || nested.by_root.contains_key(target) {
                nested.by_dir.retain(|k, _| !k.starts_with(target));
                nested.by_root.retain(|k, _| !k.starts_with(target));
            }
            for stack in nested.by_root.values() {
                stack.invalidate_tree(dir);
            }
        }
        let mut cache = self.cache.lock();
        // Lookups always populate every ancestor, so no key below `dir` exists without `dir`.
        if cache.contains_key(dir) {
            cache.retain(|k, _| !k.starts_with(dir));
        }
    }

    pub fn repo_root(&self) -> Option<&Path> {
        self.repo_root.as_deref()
    }

    /// Forgets the cached rules of `dir` (after its `.gitignore` changed).
    pub fn invalidate(&self, dir: &Path) {
        for stack in self.nested.lock().by_root.values() {
            stack.invalidate(dir);
        }
        self.cache.lock().remove(dir);
    }

    /// Returns the shared `GitignoreStack` of the nested repository enclosing `dir`, if any.
    fn nested_for(&self, dir: &Path) -> Option<Arc<GitignoreStack>> {
        let mut nested = self.nested.lock();
        let root = if let Some(cached) = nested.by_dir.get(dir) {
            cached.clone()
        } else {
            let mut chain = Vec::new();
            let mut found = None;
            for anc in dir.ancestors() {
                if let Some(cached) = nested.by_dir.get(anc) {
                    found = cached.clone();
                    break;
                }
                chain.push(anc.to_path_buf());
                if self.repo_root.as_deref() == Some(anc) {
                    found = None;
                    break;
                }
                if anc.join(".git").exists() {
                    found = Some(anc.to_path_buf());
                    break;
                }
            }
            for p in chain {
                nested.by_dir.insert(p, found.clone());
            }
            found
        }?;
        Some(
            nested
                .by_root
                .entry(root.clone())
                .or_insert_with(|| {
                    let repo_level = RwLock::new(Self::load_repo_level(Some(&root)));
                    Arc::new(Self {
                        repo_root: Some(root),
                        repo_level,
                        cache: Mutex::default(),
                        nested: Mutex::default(),
                    })
                })
                .clone(),
        )
    }

    fn matcher_for(&self, dir: &Path) -> Option<Arc<Gitignore>> {
        if let Some(cached) = self.cache.lock().get(dir) {
            return cached.clone();
        }
        let mut builder = GitignoreBuilder::new(dir);
        let mut any = false;
        for name in [".gitignore", ".ignore"] {
            let file = dir.join(name);
            if file.is_file() {
                any = true;
                if let Some(err) = builder.add(&file) {
                    tracing::debug!("{}: {err}", file.display());
                }
            }
        }
        let matcher = if any {
            match builder.build() {
                Ok(gi) if !gi.is_empty() => Some(Arc::new(gi)),
                Ok(_) => None,
                Err(e) => {
                    tracing::debug!("{}: {e}", dir.display());
                    None
                }
            }
        } else {
            None
        };
        self.cache.lock().insert(dir.to_path_buf(), matcher.clone());
        matcher
    }

    /// Whether `path` (absolute) is ignored. `is_dir` refers to `path` itself.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        // A project's watcher can span independent nested repositories. Their local
        // excludes and ignore ancestry must stop at their own repository boundary.
        if let Some(parent) = path.parent()
            && let Some(nested) = self.nested_for(parent)
        {
            return nested.is_ignored(path, is_dir);
        }
        if self.repo_root.as_deref() == Some(path) {
            return false;
        }
        for dir in path.ancestors().skip(1) {
            if let Some(m) = self.matcher_for(dir)
                && let Ok(rel) = path.strip_prefix(dir)
            {
                match m.matched_path_or_any_parents(rel, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if self.repo_root.as_deref() == Some(dir) {
                break;
            }
        }
        if let Some(root) = &self.repo_root
            && let Ok(rel) = path.strip_prefix(root)
            && !rel.as_os_str().is_empty()
        {
            for gi in self.repo_level.read().iter() {
                match gi.matched_path_or_any_parents(rel, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
        }
        false
    }

    /// Like [`is_ignored`], but only checks whether `path` itself matches —
    /// ignored ancestors do not count. Lets a directory like `target/` (itself
    /// ignored) still emit its own create/remove so the tree can show it
    /// appearing marked as ignored, while files inside it stay filtered out.
    pub fn is_ignored_self(&self, path: &Path, is_dir: bool) -> bool {
        if let Some(parent) = path.parent()
            && let Some(nested) = self.nested_for(parent)
        {
            return nested.is_ignored_self(path, is_dir);
        }
        if self.repo_root.as_deref() == Some(path) {
            return false;
        }
        for dir in path.ancestors().skip(1) {
            if let Some(m) = self.matcher_for(dir)
                && let Ok(rel) = path.strip_prefix(dir)
            {
                match m.matched(rel, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if self.repo_root.as_deref() == Some(dir) {
                break;
            }
        }
        if let Some(root) = &self.repo_root
            && let Ok(rel) = path.strip_prefix(root)
            && !rel.as_os_str().is_empty()
        {
            for gi in self.repo_level.read().iter() {
                match gi.matched(rel, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_patterns() {
        let m = ExcludeMatcher::new(&["**/node_modules".into(), "target".into(), "docs/*.tmp".into(), "[".into()]);
        assert!(m.is_excluded(Path::new("node_modules")));
        assert!(m.is_excluded(Path::new("a/node_modules/x/y.js")));
        assert!(m.is_excluded(Path::new("target")));
        assert!(m.is_excluded(Path::new("crates/x/target/debug")));
        assert!(m.is_excluded(Path::new("docs/a.tmp")));
        assert!(!m.is_excluded(Path::new("src/main.rs")));
        assert!(!m.is_excluded(Path::new("targets")));
        assert!(!ExcludeMatcher::new(&[]).is_excluded(Path::new("x")));
        // A leading `/` anchors at the base (Project Structure › Excluded folders).
        let anchored = ExcludeMatcher::new(&["/build".into()]);
        assert!(anchored.is_excluded(Path::new("build/out.o")));
        assert!(!anchored.is_excluded(Path::new("web/build/out.o")));
    }

    fn repo_with_exclude(rule: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git/info")).unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join(".git/info/exclude"), rule).unwrap();
        tmp
    }

    #[test]
    fn cached_stack_sees_every_edit_of_the_ignore_files_at_once() {
        let tmp = repo_with_exclude("secret.txt\n");
        let (src, secret, note) =
            (tmp.path().join("src"), tmp.path().join("src/secret.txt"), tmp.path().join("src/note.md"));
        assert!(GitignoreStack::cached(&src).is_ignored(&secret, false));
        assert!(!GitignoreStack::cached(&src).is_ignored(&note, false));
        std::fs::write(src.join(".gitignore"), "*.md\n").unwrap();
        assert!(GitignoreStack::cached(&src).is_ignored(&note, false), "directory .gitignore");
        std::fs::write(tmp.path().join(".git/info/exclude"), "").unwrap();
        assert!(!GitignoreStack::cached(&src).is_ignored(&secret, false), "info/exclude");
        std::fs::write(tmp.path().join(".git/info/exclude"), "note.md\nsecret.txt\n").unwrap();
        assert!(GitignoreStack::cached(&src).is_ignored(&secret, false), "info/exclude again");
    }

    #[test]
    fn cached_stack_reuses_the_repository_lookup() {
        let tmp = repo_with_exclude("");
        let src = tmp.path().join("src");
        let first = GitignoreStack::cached(&src);
        let entry = REPO_LEVEL.lock().as_ref().unwrap().get(&src).unwrap().clone();
        let again = GitignoreStack::cached(&src);
        assert!(Arc::ptr_eq(&entry, REPO_LEVEL.lock().as_ref().unwrap().get(&src).unwrap()));
        assert_eq!(first.repo_root(), again.repo_root());
        assert_eq!(again.repo_root(), Some(tmp.path()));
    }

    #[test]
    fn nested_repository_shares_one_gitignore_stack_across_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path();
        let repo = workspace.join("yolo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("a/b/c")).unwrap();
        std::fs::create_dir_all(repo.join("x/y/z")).unwrap();
        std::fs::write(repo.join(".gitignore"), "*.ignored\n").unwrap();

        let stack = GitignoreStack::new(workspace);
        assert!(stack.is_ignored(&repo.join("a/b/c/file.ignored"), false));
        assert!(stack.is_ignored(&repo.join("x/y/z/other.ignored"), false));
        assert!(!stack.is_ignored(&repo.join("x/y/z/keep.rs"), false));

        assert_eq!(stack.nested.lock().by_root.len(), 1);
        let nested = stack.nested.lock().by_root.get(&repo).unwrap().clone();
        assert!(nested.cache.lock().contains_key(&repo));

        // Invalidating a leaf file or directory inside the nested repo keeps its shared stack.
        stack.invalidate_tree(&repo.join("a/b/c/new.rs"));
        assert_eq!(stack.nested.lock().by_root.len(), 1);
        assert!(Arc::ptr_eq(&nested, stack.nested.lock().by_root.get(&repo).unwrap()));
    }

    #[test]
    fn a_repository_created_inside_the_workspace_becomes_a_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path();
        std::fs::create_dir_all(workspace.join(".git")).unwrap();
        std::fs::create_dir_all(workspace.join("sub/deep")).unwrap();
        std::fs::write(workspace.join(".gitignore"), "*.tmp\n").unwrap();

        let stack = GitignoreStack::new(workspace);
        assert!(stack.is_ignored(&workspace.join("sub/deep/a.tmp"), false));

        std::fs::create_dir(workspace.join("sub/.git")).unwrap();
        stack.invalidate_tree(&workspace.join("sub/.git"));
        assert!(!stack.is_ignored(&workspace.join("sub/deep/a.tmp"), false));

        std::fs::remove_dir(workspace.join("sub/.git")).unwrap();
        stack.invalidate_tree(&workspace.join("sub/.git"));
        assert!(stack.is_ignored(&workspace.join("sub/deep/a.tmp"), false));
    }
}
