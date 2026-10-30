//! Which paths belong in the index: `.gitignore`/`.ignore` rules (via the
//! `ignore` crate) plus the user's `files.exclude` globs, below the project root
//! and the extra content roots (Project Structure).

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::UNIX_EPOCH;

/// VCS metadata directories are never indexed, whatever the ignored names say.
const ALWAYS_SKIP: &[&str] = &[".git", ".hg", ".svn", ".jj"];

pub(crate) struct PathFilter {
    root: PathBuf,
    include_root: bool,
    /// Content roots outside `root`, indexed as `<folder name>/<path>`.
    extra: Vec<ExtraRoot>,
    excludes: GlobSet,
    /// Root-level ignore files, for paths reported by the watcher (the walker
    /// applies nested ignore files itself).
    gitignore: Gitignore,
    /// What the filter was built from: `(extra roots, exclude globs)`.
    config: (crate::IndexRoots, Vec<String>),
}

struct ExtraRoot {
    path: PathBuf,
    /// Shown before the paths inside it (`shared-lib/src/x.rs`).
    name: String,
    gitignore: Gitignore,
}

fn root_ignores(root: &Path) -> Gitignore {
    let mut gi = GitignoreBuilder::new(root);
    for f in [".gitignore", ".ignore", ".git/info/exclude"] {
        let path = root.join(f);
        if path.is_file()
            && let Some(e) = gi.add(&path)
        {
            tracing::debug!("{}: {e}", path.display());
        }
    }
    gi.build().unwrap_or_else(|_| Gitignore::empty())
}

fn rel_string(rel: &Path) -> String {
    let mut out = String::new();
    for c in rel.components() {
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&c.as_os_str().to_string_lossy());
    }
    out
}

#[derive(Clone, Debug)]
pub(crate) struct Found {
    pub path: PathBuf,
    pub mtime: u64,
    pub size: u64,
}

pub(crate) fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64)
}

impl PathFilter {
    pub(crate) fn new(root: &Path, extra_roots: &crate::IndexRoots, exclude_globs: &[String]) -> Self {
        let mut set = GlobSetBuilder::new();
        for raw in exclude_globs {
            let p = raw.trim().trim_end_matches('/');
            let anchored = p.starts_with('/');
            let p = p.trim_start_matches("./").trim_start_matches('/');
            if p.is_empty() {
                continue;
            }
            let mut patterns = vec![p.to_owned()];
            if !anchored && !p.contains('/') {
                patterns.push(format!("**/{p}"));
            }
            for pat in patterns {
                match GlobBuilder::new(&pat).literal_separator(true).build() {
                    Ok(g) => {
                        set.add(g);
                    }
                    Err(e) => tracing::warn!("invalid exclude glob {raw:?}: {e}"),
                }
            }
        }
        let excludes = set.build().unwrap_or_else(|_| GlobSet::empty());
        let mut extra: Vec<ExtraRoot> = Vec::new();
        for r in &extra_roots.folders {
            let path = dunce::canonicalize(r).unwrap_or_else(|_| r.clone());
            let nested = (extra_roots.include_root && (path.starts_with(root) || root.starts_with(&path)))
                || extra.iter().any(|e| path.starts_with(&e.path) || e.path.starts_with(&path));
            if nested || !path.is_dir() {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            extra.push(ExtraRoot { gitignore: root_ignores(&path), name, path });
        }
        Self {
            root: root.to_owned(),
            include_root: extra_roots.include_root,
            extra,
            excludes,
            gitignore: root_ignores(root),
            config: (extra_roots.clone(), exclude_globs.to_vec()),
        }
    }

    /// Whether the filter was built from these roots and globs.
    pub(crate) fn same_config(&self, extra_roots: &crate::IndexRoots, excludes: &[String]) -> bool {
        &self.config.0 == extra_roots && self.config.1 == excludes
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The project root, then the extra content roots.
    pub(crate) fn roots(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.root.as_path())
            .filter(|_| self.include_root)
            .chain(self.extra.iter().map(|e| e.path.as_path()))
    }

    /// The root containing `path`, its display prefix (`None` for the project root) and ignore rules.
    fn base_of(&self, path: &Path) -> Option<(&Path, Option<&str>, &Gitignore)> {
        if self.include_root && path.starts_with(&self.root) {
            return Some((&self.root, None, &self.gitignore));
        }
        self.extra
            .iter()
            .find(|e| path.starts_with(&e.path))
            .map(|e| (e.path.as_path(), Some(e.name.as_str()), &e.gitignore))
    }

    /// Whether `path` is (at or) below one of the roots.
    pub(crate) fn contains(&self, path: &Path) -> bool {
        self.base_of(path).is_some()
    }

    /// `/`-separated path relative to its root, as displayed; paths in extra
    /// content roots start with the root's folder name.
    pub(crate) fn rel(&self, path: &Path) -> Option<String> {
        let (base, prefix, _) = self.base_of(path)?;
        let rel = rel_string(path.strip_prefix(base).ok()?);
        if rel.is_empty() {
            return None;
        }
        Some(match prefix {
            Some(p) => format!("{p}/{rel}"),
            None => rel,
        })
    }

    /// Key of `path` in the persistent store: only files below the project root
    /// are persisted (extra content roots are rescanned when the project opens).
    pub(crate) fn store_key(&self, path: &Path) -> Option<String> {
        if !self.include_root {
            return None;
        }
        let rel = rel_string(path.strip_prefix(&self.root).ok()?);
        (!rel.is_empty()).then_some(rel)
    }

    fn excluded_rel(&self, rel: &str) -> bool {
        self.excludes.is_match(rel)
    }

    fn skip_name(name: &str) -> bool {
        ALWAYS_SKIP.contains(&name)
    }

    /// Whether a path reported by the watcher should be ignored (outside the
    /// root, inside an excluded/ignored directory, or ignored itself).
    pub(crate) fn is_excluded(&self, path: &Path, is_dir: bool) -> bool {
        let Some((base, _, gitignore)) = self.base_of(path) else { return true };
        let rel = path.strip_prefix(base).map(rel_string).unwrap_or_default();
        if rel.is_empty() {
            return true;
        }
        let mut prefix = String::new();
        for seg in rel.split('/') {
            if Self::skip_name(seg) {
                return true;
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            if self.excluded_rel(&prefix) {
                return true;
            }
        }
        gitignore.matched_path_or_any_parents(path, is_dir).is_ignore()
    }

    /// All indexable files at or below `dir`, walked in parallel.
    /// Stops early (returning what was found so far) once `cancel` is set.
    pub(crate) fn walk(&self, dir: &Path, cancel: &AtomicBool) -> Vec<Found> {
        let (tx, rx) = mpsc::channel::<Vec<Found>>();
        let Some((root, _, _)) = self.base_of(dir) else { return Vec::new() };
        let root = root.to_path_buf();
        let excludes = self.excludes.clone();
        let walker = WalkBuilder::new(dir)
            .hidden(false)
            .parents(true)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .require_git(false)
            .follow_links(false)
            .filter_entry(move |e| {
                let name = e.file_name().to_string_lossy();
                if Self::skip_name(&name) {
                    return false;
                }
                match e.path().strip_prefix(&root) {
                    Ok(rel) if !rel.as_os_str().is_empty() => {
                        let rel = rel.to_string_lossy();
                        let rel = if std::path::MAIN_SEPARATOR == '/' { rel } else { rel.replace('\\', "/").into() };
                        !excludes.is_match(rel.as_ref())
                    }
                    _ => true,
                }
            })
            .build_parallel();
        walker.run(|| {
            let mut batch = Batch { tx: tx.clone(), items: Vec::with_capacity(256) };
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if entry.file_type().is_some_and(|t| t.is_file())
                    && let Ok(meta) = entry.metadata()
                {
                    batch.items.push(Found { path: entry.into_path(), mtime: mtime_of(&meta), size: meta.len() });
                    if batch.items.len() >= 256 && batch.tx.send(std::mem::take(&mut batch.items)).is_err() {
                        return WalkState::Quit;
                    }
                }
                WalkState::Continue
            })
        });
        drop(tx);
        rx.into_iter().flatten().collect()
    }
}

/// Per-walker-thread buffer; the remainder is sent when the walker drops the visitor.
struct Batch {
    tx: mpsc::Sender<Vec<Found>>,
    items: Vec<Found>,
}

impl Drop for Batch {
    fn drop(&mut self) {
        if !self.items.is_empty() {
            let _ = self.tx.send(std::mem::take(&mut self.items));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn walk_honours_gitignore_and_excludes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for f in [
            "src/a.rs",
            "src/deep/b.rs",
            "node_modules/x/index.js",
            "target/debug/out.rs",
            "build/gen.rs",
            ".git/config",
            ".github/workflows/ci.yml",
            "docs/skip.md",
        ] {
            touch(&root, f);
        }
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        let filter =
            PathFilter::new(&root, &vec![].into(), &["**/node_modules".into(), "target".into(), "docs/**".into()]);
        let mut found: Vec<String> =
            filter.walk(&root, &AtomicBool::new(false)).iter().filter_map(|f| filter.rel(&f.path)).collect();
        found.sort();
        assert_eq!(found, vec![".github/workflows/ci.yml", ".gitignore", "src/a.rs", "src/deep/b.rs"]);

        assert!(filter.is_excluded(&root.join("node_modules/y.js"), false));
        assert!(filter.is_excluded(&root.join("a/target/z.rs"), false));
        assert!(filter.is_excluded(&root.join("build/new.rs"), false));
        assert!(filter.is_excluded(&root.join(".git/HEAD"), false));
        assert!(filter.is_excluded(Path::new("/elsewhere/x.rs"), false));
        assert!(!filter.is_excluded(&root.join("src/new.rs"), false));
    }

    #[test]
    fn extra_content_roots_are_walked_and_prefixed() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let (root, shared) = (base.join("app"), base.join("shared-lib"));
        for f in ["app/src/a.rs", "shared-lib/src/b.rs", "shared-lib/target/gen.rs", "shared-lib/out/x.rs"] {
            touch(&base, f);
        }
        std::fs::write(shared.join(".gitignore"), "out/\n").unwrap();
        let filter = PathFilter::new(&root, &vec![shared.clone(), root.join("src")].into(), &["target".into()]);
        assert_eq!(filter.roots().count(), 2, "roots inside the project are not extra roots");
        let mut found: Vec<String> = filter
            .roots()
            .flat_map(|r| filter.walk(r, &AtomicBool::new(false)))
            .filter_map(|f| filter.rel(&f.path))
            .collect();
        found.sort();
        assert_eq!(found, ["shared-lib/.gitignore", "shared-lib/src/b.rs", "src/a.rs"]);
        assert_eq!(filter.store_key(&shared.join("src/b.rs")), None, "extra roots are not persisted");
        assert_eq!(filter.store_key(&root.join("src/a.rs")).as_deref(), Some("src/a.rs"));
        assert!(!filter.is_excluded(&shared.join("src/new.rs"), false));
        assert!(filter.is_excluded(&shared.join("target/y.rs"), false));
        assert!(filter.is_excluded(&shared.join("out/y.rs"), false));
        assert!(filter.same_config(&vec![shared.clone(), root.join("src")].into(), &["target".into()]));
        assert!(!filter.same_config(&vec![shared].into(), &["target".into()]));
    }
}
