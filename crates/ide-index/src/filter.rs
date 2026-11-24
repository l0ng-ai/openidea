//! Which paths belong in the index: `.gitignore`/`.ignore` rules (via the
//! `ignore` crate) plus the user's `files.exclude` globs, below the project root
//! and the extra content roots (Project Structure).
//!
//! Git-ignored files and folders are listed by name only: Go to File finds them
//! without reading their contents or indexing their symbols. Excluded folders
//! (including project-model outputs and dependencies) are not walked at all.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::{WalkBuilder, WalkState};
use std::collections::HashSet;
use std::ffi::OsStr;
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
    /// What the filter was built from: `(extra roots, exclude globs)`.
    config: (crate::IndexRoots, Vec<String>),
}

struct ExtraRoot {
    path: PathBuf,
    /// Shown before the paths inside it (`shared-lib/src/x.rs`).
    name: String,
    /// Its own exclude globs (an attached project's); `None` shares the project's.
    excludes: Option<GlobSet>,
}

/// Whether an ignore-aware content walk of `root` leaves out `dir` or an ancestor.
/// An ignored folder can be an explicit content root with its own ignore rules,
/// promoting its files from filename-only entries to indexable content.
pub fn walk_skips(root: &Path, dir: &Path) -> bool {
    if dir == root || !dir.starts_with(root) || !dir.is_dir() {
        return false;
    }
    let target = dir.to_path_buf();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(ide_core::ignored::inside_git_repo(root))
        .follow_links(false)
        // Only the folders on the way down to `dir`.
        .filter_entry(move |e| target.starts_with(e.path()))
        .build();
    !walker.flatten().any(|e| e.path() == dir)
}

/// Exclude globs as gitignore reads them: a leading `/` anchors at the root, a bare name matches at any depth.
fn glob_set(exclude_globs: &[String]) -> GlobSet {
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
    set.build().unwrap_or_else(|_| GlobSet::empty())
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

/// Whether `path` below `root` matches the exclude globs.
fn glob_excluded(excludes: &GlobSet, root: &Path, path: &Path) -> bool {
    match path.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => {
            let rel = rel.to_string_lossy();
            let rel = if std::path::MAIN_SEPARATOR == '/' { rel } else { rel.replace('\\', "/").into() };
            excludes.is_match(rel.as_ref())
        }
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Found {
    pub path: PathBuf,
    pub mtime: u64,
    pub size: u64,
    /// Matched by an ignore file: listed by name only.
    pub ignored: bool,
}

pub(crate) fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64)
}

impl PathFilter {
    pub(crate) fn new(root: &Path, extra_roots: &crate::IndexRoots, exclude_globs: &[String]) -> Self {
        let excludes = glob_set(exclude_globs);
        let mut extra: Vec<ExtraRoot> = Vec::new();
        for r in &extra_roots.folders {
            let path = dunce::canonicalize(r).unwrap_or_else(|_| r.clone());
            // A folder inside the root is a root of its own only when the root's walk skips it.
            let inside = path.starts_with(root) && !walk_skips(root, &path);
            let nested = (extra_roots.include_root && (inside || root.starts_with(&path)))
                || extra.iter().any(|e| path.starts_with(&e.path) || e.path.starts_with(&path));
            if nested || !path.is_dir() {
                continue;
            }
            // Inside the root it goes by its path there, elsewhere by its folder name.
            let name = match path.strip_prefix(root) {
                Ok(rel) if extra_roots.include_root => rel_string(rel),
                _ => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            };
            let excludes = extra_roots.excludes.get(r).map(|globs| glob_set(globs));
            extra.push(ExtraRoot { name, path, excludes });
        }
        Self {
            root: root.to_owned(),
            include_root: extra_roots.include_root,
            extra,
            excludes,
            config: (extra_roots.clone(), exclude_globs.to_vec()),
        }
    }

    /// Whether the filter was built from these roots and globs.
    pub(crate) fn same_config(&self, extra_roots: &crate::IndexRoots, excludes: &[String]) -> bool {
        &self.config.0 == extra_roots && self.config.1 == excludes
    }

    /// Stable fingerprint of the persisted-scope configuration; a start-up
    /// snapshot is only trusted when this still matches.
    pub(crate) fn stamp(&self) -> String {
        let mut stamp = format!("ignored_folders=names\ninclude_root={}\n", self.config.0.include_root);
        for folder in &self.config.0.folders {
            stamp.push_str(&folder.to_string_lossy());
            stamp.push('\n');
        }
        stamp.push_str("--\n");
        for exclude in &self.config.1 {
            stamp.push_str(exclude);
            stamp.push('\n');
        }
        for (folder, excludes) in &self.config.0.excludes {
            stamp.push_str(&format!("-- {}\n", folder.to_string_lossy()));
            for exclude in excludes {
                stamp.push_str(exclude);
                stamp.push('\n');
            }
        }
        stamp
    }

    pub(crate) fn reload(&self) -> Self {
        Self::new(&self.root, &self.config.0, &self.config.1)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Whether content roots outside the project root are indexed with it.
    pub(crate) fn has_extra_roots(&self) -> bool {
        !self.extra.is_empty()
    }

    /// The project root, then the extra content roots.
    pub(crate) fn roots(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.root.as_path())
            .filter(|_| self.include_root)
            .chain(self.extra.iter().map(|e| e.path.as_path()))
    }

    /// The root containing `path` and its display prefix (`None` for the project root).
    fn base_of(&self, path: &Path) -> Option<(&Path, Option<&str>)> {
        // An extra root inside the project root wins: its own rules apply below it.
        if let Some(e) = self.extra.iter().find(|e| path.starts_with(&e.path)) {
            return Some((e.path.as_path(), Some(e.name.as_str())));
        }
        (self.include_root && path.starts_with(&self.root)).then_some((self.root.as_path(), None))
    }

    /// Whether `path` is (at or) below one of the roots.
    pub(crate) fn contains(&self, path: &Path) -> bool {
        self.base_of(path).is_some()
    }

    /// `/`-separated path relative to its root, as displayed; paths in extra
    /// content roots start with the root's folder name.
    pub(crate) fn rel(&self, path: &Path) -> Option<String> {
        let (base, prefix) = self.base_of(path)?;
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
        if !self.include_root || self.extra.iter().any(|e| path.starts_with(&e.path)) {
            return None;
        }
        let rel = rel_string(path.strip_prefix(&self.root).ok()?);
        (!rel.is_empty()).then_some(rel)
    }

    /// Recent Files' stored form: the store key for a project file, the absolute
    /// path for one outside it (a scratch file). Loading joins it to the root,
    /// which leaves an absolute path as it is.
    pub(crate) fn recent_key(&self, path: &Path) -> Option<String> {
        self.store_key(path).or_else(|| {
            (path.is_absolute() && !path.starts_with(&self.root)).then(|| path.to_str().map(str::to_owned))?
        })
    }

    /// The exclude globs below `base` (a root): its own, or the project's.
    fn excludes_of(&self, base: &Path) -> &GlobSet {
        self.extra.iter().find(|e| e.path == base).and_then(|e| e.excludes.as_ref()).unwrap_or(&self.excludes)
    }

    fn skip_name(name: &str) -> bool {
        ALWAYS_SKIP.contains(&name)
    }

    /// Whether a path is outside the roots, VCS metadata, or explicitly excluded.
    /// Git-ignore rules classify files as filename-only, not excluded.
    pub(crate) fn is_excluded(&self, path: &Path) -> bool {
        let Some((base, _)) = self.base_of(path) else { return true };
        let rel = path.strip_prefix(base).map(rel_string).unwrap_or_default();
        if rel.is_empty() {
            return true;
        }
        let excludes = self.excludes_of(base);
        let mut prefix = String::new();
        for seg in rel.split('/') {
            if Self::skip_name(seg) {
                return true;
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            if excludes.is_match(&prefix) {
                return true;
            }
        }
        false
    }

    /// A filename walk: only explicit exclusions prune directories. Extra roots
    /// inside another root are walked separately, with their own ignore rules.
    fn walker(&self, dir: &Path) -> Option<WalkBuilder> {
        let (root, _) = self.base_of(dir)?;
        if dir != root && self.is_excluded(dir) {
            return None;
        }
        let excludes = self.excludes_of(root).clone();
        let root = root.to_path_buf();
        let extra: Vec<PathBuf> = self.extra.iter().filter(|e| e.path != dir).map(|e| e.path.clone()).collect();
        let mut builder = WalkBuilder::new(dir);
        builder.standard_filters(false).follow_links(false).filter_entry(move |e| {
            !Self::skip_name(&e.file_name().to_string_lossy())
                && !glob_excluded(&excludes, &root, e.path())
                && !extra.iter().any(|r| e.path() == r)
        });
        Some(builder)
    }

    /// All directories at or below `dir` that the index would walk, in walk order.
    pub(crate) fn dirs(&self, dir: &Path) -> Vec<PathBuf> {
        let Some(builder) = self.walker(dir) else { return Vec::new() };
        builder.build().flatten().filter(|e| e.file_type().is_some_and(|t| t.is_dir())).map(|e| e.into_path()).collect()
    }

    pub(crate) fn directories_with_names(&self, names: &HashSet<&OsStr>) -> Vec<PathBuf> {
        let matches = parking_lot::Mutex::new(Vec::new());
        for root in self.roots() {
            let Some(mut builder) = self.walker(root) else { continue };
            builder.standard_filters(true).hidden(false).require_git(ide_core::ignored::inside_git_repo(root));
            let matches = &matches;
            builder.build_parallel().run(|| {
                Box::new(move |entry| {
                    if let Ok(entry) = entry
                        && entry.file_type().is_some_and(|ty| ty.is_dir())
                        && names.contains(entry.file_name())
                    {
                        matches.lock().push(entry.into_path());
                    }
                    WalkState::Continue
                })
            });
        }
        matches.into_inner()
    }

    /// All indexable files at or below `dir`, walked in parallel.
    /// Stops early (returning what was found so far) once `cancel` is set.
    pub(crate) fn walk(&self, dir: &Path, cancel: &AtomicBool) -> Vec<Found> {
        self.walk_to(dir, None, cancel)
    }

    /// The indexable files directly in `dir`, classified by the same rules as [`Self::walk`].
    pub(crate) fn list_dir(&self, dir: &Path) -> Vec<Found> {
        self.walk_to(dir, Some(1), &AtomicBool::new(false))
    }

    fn walk_to(&self, dir: &Path, max_depth: Option<usize>, cancel: &AtomicBool) -> Vec<Found> {
        let Some(mut builder) = self.walker(dir) else { return Vec::new() };
        let Some((root, _)) = self.base_of(dir) else { return Vec::new() };
        // Keep the matcher's root at the content root, even for a watcher scan
        // starting inside an ignored folder, so ancestor rules still apply.
        let matcher = WalkBuilder::new(root)
            .hidden(false)
            .require_git(ide_core::ignored::inside_git_repo(root))
            .build_matchers()
            .pop()
            .expect("one content root");
        let (tx, rx) = mpsc::channel::<Vec<Found>>();
        builder.max_depth(max_depth).build_parallel().run(|| {
            let mut matcher = matcher.clone();
            let mut batch = Batch { tx: tx.clone(), items: Vec::with_capacity(256) };
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if entry.file_type().is_some_and(|t| t.is_file())
                    && let Ok(meta) = entry.metadata()
                    && let Ok(rel) = entry.path().strip_prefix(root)
                {
                    let ignored = matcher.matched(rel, false).is_ignore();
                    batch.items.push(Found {
                        path: entry.into_path(),
                        mtime: mtime_of(&meta),
                        size: meta.len(),
                        ignored,
                    });
                }
                if batch.items.len() >= 256 && batch.tx.send(std::mem::take(&mut batch.items)).is_err() {
                    return WalkState::Quit;
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
        let filter = PathFilter::new(
            &root,
            &vec![].into(),
            &["**/node_modules".into(), "target".into(), "/build".into(), "docs/**".into()],
        );
        let mut found: Vec<String> =
            filter.walk(&root, &AtomicBool::new(false)).iter().filter_map(|f| filter.rel(&f.path)).collect();
        found.sort();
        assert_eq!(found, vec![".github/workflows/ci.yml", ".gitignore", "src/a.rs", "src/deep/b.rs"]);

        assert!(filter.is_excluded(&root.join("node_modules/y.js")));
        assert!(filter.is_excluded(&root.join("a/target/z.rs")));
        assert!(filter.is_excluded(&root.join("build/new.rs")));
        assert!(filter.is_excluded(&root.join(".git/HEAD")));
        assert!(filter.is_excluded(Path::new("/elsewhere/x.rs")));
        assert!(!filter.is_excluded(&root.join("src/new.rs")));
    }

    #[test]
    fn ignored_files_and_directories_are_listed_by_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for f in [
            ".env",
            "src/a.rs",
            "src/debug.log",
            "src/local/secrets.json",
            "pkg/.gitignore",
            "pkg/gen.rs",
            "pkg/keep.rs",
            "build/out.rs",
            "build/nested/deep.rs",
            "logs/app.log",
            "node_modules/x/.env",
            "src/.DS_Store",
            "src/.git",
        ] {
            touch(&root, f);
        }
        std::fs::write(
            root.join(".gitignore"),
            ".env
*.log
build/
logs/
src/local/
",
        )
        .unwrap();
        std::fs::write(
            root.join("pkg/.gitignore"),
            "gen.rs
",
        )
        .unwrap();
        let filter = PathFilter::new(&root, &vec![].into(), &["**/node_modules".into(), "**/.DS_Store".into()]);
        let mut found: Vec<(String, bool)> = filter
            .walk(&root, &AtomicBool::new(false))
            .iter()
            .filter_map(|f| Some((filter.rel(&f.path)?, f.ignored)))
            .collect();
        found.sort();
        let expected = [
            (".env", true),
            (".gitignore", false),
            ("build/nested/deep.rs", true),
            ("build/out.rs", true),
            ("logs/app.log", true),
            ("pkg/.gitignore", false),
            ("pkg/gen.rs", true),
            ("pkg/keep.rs", false),
            ("src/a.rs", false),
            ("src/debug.log", true),
            ("src/local/secrets.json", true),
        ];
        assert_eq!(found, expected.map(|(p, i)| (p.to_owned(), i)));

        // One directory at a time (watcher updates): same classification, no descent.
        let mut listed: Vec<(String, bool)> =
            filter.list_dir(&root.join("pkg")).iter().filter_map(|f| Some((filter.rel(&f.path)?, f.ignored))).collect();
        listed.sort();
        let expected = [("pkg/.gitignore", false), ("pkg/gen.rs", true), ("pkg/keep.rs", false)];
        assert_eq!(listed, expected.map(|(p, i)| (p.to_owned(), i)));
        let top: Vec<String> = filter.list_dir(&root).iter().filter_map(|f| filter.rel(&f.path)).collect();
        assert!(top.iter().all(|p| !p.contains('/')), "{top:?}");

        for rel in
            [".env", "src/new.log", "src/new.rs", "build/x.rs", "logs/app.log", "src/local/x.json", "build", "src"]
        {
            assert!(!filter.is_excluded(&root.join(rel)), "{rel}");
        }
        let listed = filter.list_dir(&root.join("src/local"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, root.join("src/local/secrets.json"));
        assert!(listed[0].ignored);
    }

    #[test]
    fn a_nested_repository_is_not_hidden_by_the_outer_repositorys_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        for f in ["projects/nested/src/a.rs", "projects/nested/out/x.rs"] {
            touch(&base, f);
        }
        std::fs::create_dir(base.join(".git")).unwrap();
        std::fs::create_dir(base.join("projects/nested/.git")).unwrap();
        std::fs::write(base.join("projects/.gitignore"), "*\n!.gitignore\n").unwrap();
        std::fs::write(base.join("projects/nested/.gitignore"), "out/\n").unwrap();
        let root = base.join("projects/nested");
        let filter = PathFilter::new(&root, &vec![].into(), &[]);
        let mut found: Vec<String> =
            filter.walk(&root, &AtomicBool::new(false)).iter().filter_map(|f| filter.rel(&f.path)).collect();
        found.sort();
        assert_eq!(found, [".gitignore", "out/x.rs", "src/a.rs"]);
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
        assert_eq!(found, ["shared-lib/.gitignore", "shared-lib/out/x.rs", "shared-lib/src/b.rs", "src/a.rs"]);
        assert_eq!(filter.store_key(&shared.join("src/b.rs")), None, "extra roots are not persisted");
        assert_eq!(filter.store_key(&root.join("src/a.rs")).as_deref(), Some("src/a.rs"));
        assert!(!filter.is_excluded(&shared.join("src/new.rs")));
        assert!(filter.is_excluded(&shared.join("target/y.rs")));
        assert!(!filter.is_excluded(&shared.join("out/y.rs")));
        assert!(filter.same_config(&vec![shared.clone(), root.join("src")].into(), &["target".into()]));
        assert!(!filter.same_config(&vec![shared].into(), &["target".into()]));
    }

    #[test]
    fn each_root_applies_its_own_excluded_folders() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let (root, attached, shared) = (base.join("app"), base.join("lib"), base.join("shared"));
        for f in ["app/target/a.rs", "app/gen/b.rs", "lib/target/c.rs", "lib/gen/d.rs", "shared/target/e.rs"] {
            touch(&base, f);
        }
        let roots = crate::IndexRoots {
            include_root: true,
            folders: vec![attached.clone(), shared.clone()],
            excludes: [(attached.clone(), vec!["/gen".to_owned()])].into(),
        };
        let filter = PathFilter::new(&root, &roots, &["/target".into()]);
        let mut found: Vec<String> = filter
            .roots()
            .flat_map(|r| filter.walk(r, &AtomicBool::new(false)))
            .filter_map(|f| filter.rel(&f.path))
            .collect();
        found.sort();
        // `lib` has exclusions of its own; `shared` shares the project's.
        assert_eq!(found, ["gen/b.rs", "lib/target/c.rs"]);
        assert!(filter.is_excluded(&attached.join("gen/new.rs")));
        assert!(!filter.is_excluded(&root.join("gen/new.rs")));
        assert!(filter.stamp().contains("/gen"));
        assert!(!filter.same_config(&vec![attached, shared].into(), &["/target".into()]));
    }

    #[test]
    fn an_ignored_folder_inside_the_root_is_a_root_with_its_own_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let nested = root.join(".wt/feature");
        for f in ["src/a.rs", "lib/d.rs", ".wt/feature/src/b.rs", ".wt/feature/out/c.rs"] {
            touch(&root, f);
        }
        // A git worktree kept inside the repository it belongs to, which ignores it.
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::write(root.join(".git/info/exclude"), "/.wt/\n").unwrap();
        std::fs::write(nested.join(".git"), "gitdir: ../../.git/worktrees/feature\n").unwrap();
        std::fs::write(nested.join(".gitignore"), "out/\n").unwrap();
        assert!(walk_skips(&root, &nested));
        assert!(!walk_skips(&root, &root.join("lib")));

        let filter = PathFilter::new(&root, &vec![nested.clone(), root.join("lib")].into(), &[]);
        assert_eq!(filter.roots().count(), 2, "a folder the root's walk covers is not a root of its own");
        let mut found: Vec<String> = filter
            .roots()
            .flat_map(|r| filter.walk(r, &AtomicBool::new(false)))
            .filter_map(|f| filter.rel(&f.path))
            .collect();
        found.sort();
        assert_eq!(
            found,
            [".wt/feature/.gitignore", ".wt/feature/out/c.rs", ".wt/feature/src/b.rs", "lib/d.rs", "src/a.rs"]
        );
        assert_eq!(filter.store_key(&nested.join("src/b.rs")), None, "extra roots are not persisted");
        assert!(!filter.is_excluded(&nested.join("src/new.rs")));
        assert!(!filter.is_excluded(&nested.join("out/new.rs")));
        assert!(!filter.is_excluded(&root.join(".wt/other/x.rs")));
        let own_files = filter.walk(&nested, &AtomicBool::new(false));
        assert!(!own_files.iter().find(|f| f.path == nested.join("src/b.rs")).unwrap().ignored);
        assert!(own_files.iter().find(|f| f.path == nested.join("out/c.rs")).unwrap().ignored);
    }

    #[test]
    fn explicit_exclusions_prune_filename_walks_and_watcher_subtrees() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        // The caller supplies files.exclude and the project model's anchored
        // output/dependency/environment roots; ignored business folders stay in.
        let excluded = ["node_modules", "jvm/build", "rust/target", ".venv", "python/__pycache__", "private"];
        for folder in excluded {
            touch(&root, &format!("{folder}/nested/hidden.ts"));
        }
        touch(&root, "notes/nested/todo.ts");
        touch(&root, "internal/build/source.ts");
        std::fs::write(root.join(".gitignore"), "notes/\ninternal/\n").unwrap();
        let globs: Vec<String> = excluded.iter().map(|p| format!("/{p}")).collect();
        let filter = PathFilter::new(&root, &vec![].into(), &globs);
        let mut found = filter.walk(&root, &AtomicBool::new(false));
        found.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            found.iter().map(|f| filter.rel(&f.path).unwrap()).collect::<Vec<_>>(),
            [".gitignore", "internal/build/source.ts", "notes/nested/todo.ts"]
        );
        assert!(found[1..].iter().all(|f| f.ignored));
        let dirs = filter.dirs(&root);
        assert!(dirs.contains(&root.join("notes/nested")));
        for folder in excluded {
            let subtree = root.join(folder).join("nested");
            assert!(filter.is_excluded(&subtree));
            assert!(filter.walk(&subtree, &AtomicBool::new(false)).is_empty());
            assert!(filter.list_dir(&subtree).is_empty());
            assert!(!dirs.iter().any(|d| d.starts_with(root.join(folder))));
        }
    }
}
