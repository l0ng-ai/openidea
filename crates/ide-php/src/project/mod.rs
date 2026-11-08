//! Which files belong to a PHP project, and where its namespaces live.
//!
//! A [`ProjectLayout`] is worked out from:
//!
//! - **The project folder.** Every PHP file below it is the project's own
//!   code, whether or not an autoload rule names it (entry scripts, config
//!   files and templates use the project's classes too). The walk is the one
//!   the rest of the IDE indexes and searches with (`ide_vfs::walk_files`):
//!   `.gitignore` and the excluded folders apply. The Composer vendor
//!   directory is left out of it.
//! - **The root `composer.json`.** `autoload` and `autoload-dev` (`psr-4`,
//!   `psr-0`, `classmap`, `files`) give the [`AutoloadMap`], and any of their
//!   paths outside the project folder (`../shared/src`) are project code too.
//!   `config.vendor-dir` moves the vendor directory.
//! - **`<vendor>/composer/installed.json`.** Each installed package
//!   contributes the files its own `autoload` names, minus its
//!   `exclude-from-classmap` patterns, so a package's tests and tooling stay
//!   out. Without the file nothing from the vendor directory is indexed.
//! - **Include paths** from Settings › PHP (`ide_sdk::php::include_paths`).
//!
//! The excluded folders apply to every file below the project folder, the
//! vendor directory included. [`ProjectLayout::from_settings`] passes the
//! user's exclusions (`Settings::exclude_globs`), not the auto-detected roots:
//! detection excludes `vendor`, which is exactly where the Composer libraries
//! are. Vendor files are reached through `installed.json` instead of the walk,
//! so `.gitignore` (which usually lists `vendor/`) does not hide them.
//!
//! [`ProjectLayout::files`] walks the disk; [`ProjectLayout::origin_of`]
//! answers for one path without walking (watcher batches), with the same
//! rules except `.gitignore`, which the watcher has already applied.

mod autoload;
pub(crate) mod composer;
#[cfg(test)]
mod tests;

pub use autoload::{AutoloadMap, AutoloadStandard, NamespaceRoot};

use composer::{Autoload, InstalledPackage, RootManifest};
use ide_core::settings::Settings;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_vfs::ExcludeMatcher;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// File extensions treated as PHP (compared case-insensitively).
pub const PHP_EXTENSIONS: &[&str] = &["php", "phtml", "php3", "php4", "php5", "php7", "php8"];

/// Why a file belongs to the project.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Origin {
    /// The project's own code.
    Project,
    /// An installed Composer package (its name, `vendor/package`).
    Package(String),
    /// A folder from Settings › PHP › Include paths.
    IncludePath,
}

/// What [`ProjectLayout::load`] needs besides the files on disk.
#[derive(Clone, Debug, Default)]
pub struct LayoutConfig {
    pub root: PathBuf,
    /// Absolute folders (Settings › PHP › Include paths).
    pub include_paths: Vec<PathBuf>,
    /// Exclude globs relative to `root`, as `ide_vfs::ExcludeMatcher` reads them
    /// (`/var/cache` anchored, `*.tpl.php` at any depth).
    pub excludes: Vec<String>,
}

/// A folder or file outside the project walk whose PHP files belong to the project.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LibraryRoot {
    /// Absolute and normalized.
    path: PathBuf,
    /// A `files` / `classmap` entry naming one file: it counts whatever its extension.
    is_file: bool,
    origin: Origin,
    /// The package directory `exclude_from_classmap` is relative to.
    base: PathBuf,
    exclude_from_classmap: Vec<String>,
}

/// The files of a PHP project and its namespace mapping. Cheap to clone.
#[derive(Clone, Debug)]
pub struct ProjectLayout {
    root: PathBuf,
    vendor_dir: PathBuf,
    has_manifest: bool,
    excludes: Vec<String>,
    matcher: ExcludeMatcher,
    libraries: Vec<LibraryRoot>,
    autoload: AutoloadMap,
}

impl ProjectLayout {
    /// The layout from Settings › PHP include paths and the user's excluded
    /// folders and patterns.
    pub fn from_settings(root: &Path, settings: &Settings) -> Self {
        Self::load(&LayoutConfig {
            root: root.to_path_buf(),
            include_paths: ide_sdk::php::include_paths(root, settings).into_iter().map(PathBuf::from).collect(),
            excludes: settings.exclude_globs(),
        })
    }

    /// Reads `composer.json` and `installed.json`. Missing or broken manifests
    /// leave the project folder (and the include paths) as the only sources.
    pub fn load(config: &LayoutConfig) -> Self {
        let root = normalize(&config.root);
        let manifest = RootManifest::read(&root);
        let vendor_dir = normalize(&root.join(manifest.as_ref().map_or("vendor", |m| m.vendor_dir.as_str())));
        let mut layout = Self {
            root: root.clone(),
            vendor_dir: vendor_dir.clone(),
            has_manifest: manifest.is_some(),
            excludes: config.excludes.clone(),
            matcher: ExcludeMatcher::new(&config.excludes),
            libraries: Vec::new(),
            autoload: AutoloadMap::default(),
        };
        if let Some(manifest) = &manifest {
            layout.add_autoload(&root, &manifest.autoload, false, Origin::Project, false);
            layout.add_autoload(&root, &manifest.autoload_dev, true, Origin::Project, false);
            for package in composer::installed_packages(&vendor_dir) {
                let InstalledPackage { name, dir, autoload, dev } = package;
                layout.add_autoload(&normalize(&dir), &autoload, dev, Origin::Package(name), true);
            }
        }
        for path in &config.include_paths {
            let path = normalize(path);
            if path.as_os_str().is_empty() {
                continue;
            }
            layout.push_library(LibraryRoot {
                path: path.clone(),
                is_file: path.is_file(),
                origin: Origin::IncludePath,
                base: path,
                exclude_from_classmap: Vec::new(),
            });
        }
        layout
    }

    /// Records one autoload section of the package in `base`.
    fn add_autoload(&mut self, base: &Path, autoload: &Autoload, dev: bool, origin: Origin, use_excludes: bool) {
        let package = match &origin {
            Origin::Package(name) => Some(name.clone()),
            _ => None,
        };
        let excludes: Vec<String> = if use_excludes { autoload.exclude_from_classmap.clone() } else { Vec::new() };
        let library = |layout: &mut Self, rel: &str, is_file: bool| {
            let path = normalize(&base.join(rel));
            // The project's own paths inside the walk are already covered by
            // it, except a `files` entry the walk skips for its extension.
            if origin == Origin::Project && layout.in_project_walk(&path) && (!is_file || is_php_path(&path)) {
                return;
            }
            layout.push_library(LibraryRoot {
                path,
                is_file,
                origin: origin.clone(),
                base: base.to_path_buf(),
                exclude_from_classmap: excludes.clone(),
            });
        };
        for (standard, rules) in [(AutoloadStandard::Psr4, &autoload.psr4), (AutoloadStandard::Psr0, &autoload.psr0)] {
            for (prefix, dirs) in rules {
                for dir in dirs {
                    self.autoload.push(NamespaceRoot {
                        prefix: prefix.clone(),
                        dir: normalize(&base.join(dir)),
                        standard,
                        dev,
                        package: package.clone(),
                    });
                    library(self, dir, false);
                }
            }
        }
        for entry in &autoload.classmap {
            let is_file = base.join(entry).is_file();
            library(self, entry, is_file);
        }
        for file in &autoload.files {
            library(self, file, true);
        }
    }

    fn push_library(&mut self, library: LibraryRoot) {
        if !self.libraries.contains(&library) {
            self.libraries.push(library);
        }
    }

    /// The project folder (normalized).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The Composer vendor directory (normalized; it need not exist).
    pub fn vendor_dir(&self) -> &Path {
        &self.vendor_dir
    }

    /// Whether the project has a readable root `composer.json`.
    pub fn has_composer(&self) -> bool {
        self.has_manifest
    }

    /// The namespace ⇄ directory mapping.
    pub fn autoload(&self) -> &AutoloadMap {
        &self.autoload
    }

    /// Whether a change to `path` changes the layout itself, so it must be
    /// loaded again: the root `composer.json` or `installed.json`.
    pub fn is_manifest(&self, path: &Path) -> bool {
        let path = normalize(path);
        path == self.root.join("composer.json") || path == self.vendor_dir.join("composer").join("installed.json")
    }

    /// Whether `path` is below the project folder, outside the vendor directory.
    fn in_project_walk(&self, path: &Path) -> bool {
        path.starts_with(&self.root) && !path.starts_with(&self.vendor_dir)
    }

    /// Whether the excluded folders or patterns rule out `path`.
    fn is_excluded(&self, path: &Path) -> bool {
        match path.strip_prefix(&self.root) {
            Ok(rel) if !rel.as_os_str().is_empty() => self.matcher.is_excluded(rel),
            _ => false,
        }
    }

    /// Why `path` belongs to the project, or `None` when it doesn't. The
    /// project itself wins over a package, and a package over an include path.
    /// `.gitignore` is not consulted (see the module docs).
    pub fn origin_of(&self, path: &Path) -> Option<Origin> {
        let path = normalize(path);
        if self.is_excluded(&path) {
            return None;
        }
        if self.in_project_walk(&path) && is_php_path(&path) {
            return Some(Origin::Project);
        }
        self.libraries.iter().filter(|library| library.contains(&path)).map(|library| library.origin.clone()).min()
    }

    /// Every file of the project with its [`Origin`], sorted by path. Stops
    /// with `Cancelled` between folders once `cancel` is cancelled.
    pub fn files(&self, cancel: &CancellationToken) -> IdeResult<Vec<(PathBuf, Origin)>> {
        let mut found: BTreeMap<PathBuf, Origin> = BTreeMap::new();
        if self.root.is_dir() {
            let mut excludes = self.excludes.clone();
            if let Ok(rel) = self.vendor_dir.strip_prefix(&self.root)
                && !rel.as_os_str().is_empty()
            {
                excludes.push(format!("/{}", rel.to_string_lossy().replace('\\', "/")));
            }
            let collected = Mutex::new(Vec::new());
            ide_vfs::walk_files(&self.root, &excludes, |path| {
                if !cancel.is_cancelled() && is_php_path(path) {
                    collected.lock().push(normalize(path));
                }
            });
            for path in collected.into_inner() {
                found.insert(path, Origin::Project);
            }
        }
        for library in &self.libraries {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            for path in library.walk() {
                if self.is_excluded(&path) {
                    continue;
                }
                found
                    .entry(path)
                    .and_modify(|origin| *origin = origin.clone().min(library.origin.clone()))
                    .or_insert_with(|| library.origin.clone());
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(found.into_iter().collect())
    }
}

impl LibraryRoot {
    fn contains(&self, path: &Path) -> bool {
        let inside = if self.is_file { path == self.path } else { path.starts_with(&self.path) && is_php_path(path) };
        inside && !self.excluded_from_classmap(path)
    }

    fn excluded_from_classmap(&self, path: &Path) -> bool {
        if self.exclude_from_classmap.is_empty() {
            return false;
        }
        let Ok(rel) = path.strip_prefix(&self.base) else {
            return false;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        self.exclude_from_classmap.iter().any(|pattern| {
            let pattern = pattern.replace('\\', "/");
            let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
            !pattern.is_empty() && prefix_glob(pattern.as_bytes(), rel.as_bytes())
        })
    }

    /// The files of this root on disk. Library folders are walked without
    /// ignore files (a vendor package's `.gitignore` describes its own
    /// repository, not what's installed); symlinked folders, which Composer
    /// path repositories install, are followed.
    fn walk(&self) -> Vec<PathBuf> {
        if self.is_file {
            return if self.path.is_file() && !self.excluded_from_classmap(&self.path) {
                vec![self.path.clone()]
            } else {
                Vec::new()
            };
        }
        if !self.path.is_dir() {
            return Vec::new();
        }
        let collected = Mutex::new(Vec::new());
        let mut builder = ignore::WalkBuilder::new(&self.path);
        builder.standard_filters(false).follow_links(true);
        builder.filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git");
        builder.build_parallel().run(|| {
            Box::new(|result| {
                match result {
                    Ok(entry) if entry.file_type().is_some_and(|ft| ft.is_file()) => {
                        let path = normalize(entry.path());
                        if self.contains(&path) {
                            collected.lock().push(path);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => tracing::debug!("php layout walk: {e}"),
                }
                ignore::WalkState::Continue
            })
        });
        collected.into_inner()
    }
}

/// Whether `path` has one of the [`PHP_EXTENSIONS`].
pub fn is_php_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| PHP_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)))
}

/// Composer's `exclude-from-classmap` match: `**` is anything, `*` anything
/// but `/`, and the pattern only has to match the start of the path (Composer
/// turns it into an unanchored-at-the-end regex the same way).
fn prefix_glob(pattern: &[u8], path: &[u8]) -> bool {
    match pattern {
        [] => true,
        [b'*', b'*', rest @ ..] => (0..=path.len()).any(|i| prefix_glob(rest, &path[i..])),
        [b'*', rest @ ..] => {
            for i in 0..=path.len() {
                if prefix_glob(rest, &path[i..]) {
                    return true;
                }
                if path.get(i) == Some(&b'/') {
                    break;
                }
            }
            false
        }
        [c, rest @ ..] => path.first() == Some(c) && prefix_glob(rest, &path[1..]),
    }
}

/// Removes `.` components and folds `..` into their parent, without touching
/// the disk (the paths may not exist, and symlinks must stay as written).
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out
}
