//! Built-in declarations from the bundled
//! [phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs): `strlen`,
//! `ArrayIterator`, `PHP_EOL` and the rest of PHP and its extensions.
//!
//! - **What ships:** the pinned release's extension folders (only their
//!   `.php` files, plus `LICENSE` and `README.md`) are checked in as one
//!   deflated archive, `crates/ide-php/stubs/phpstorm-stubs.zip`, and
//!   embedded in the binary with `include_bytes!`. That follows how the repo
//!   bundles other third-party assets (the Lombok jar is checked in too) and
//!   keeps builds offline. `scripts/php-stubs.sh` rebuilds it from the
//!   pinned tag ([`STUBS_TAG`], [`STUBS_COMMIT`]).
//! - **Why sources, not summaries:** the summary format changes with almost
//!   every phase ([`crate::summary::SCHEMA_VERSION`]), and hover and goto
//!   definition need the stub text anyway (descriptions are not kept in
//!   summaries). So the archive holds the PHP sources, and
//!   [`BundledStubs::get`] unpacks, parses and summarises them once per
//!   process, in parallel, into the ready-made set every project filters.
//! - **Filtering** ([`BundledStubs::summaries`] with a [`StubFilter`]):
//!   - by extension: each top-level folder is a stub set (`standard`,
//!     `SPL`, `Zend OPcache`, …), compared with
//!     [`ide_sdk::php::stub_key`]; a project's sets come from
//!     [`ide_sdk::php::stub_sets`];
//!   - by PHP version ([`ide_sdk::php::language_level`], else
//!     [`PhpVersion::LATEST`]): a declaration or parameter whose
//!     `#[PhpStormStubsElementAvailable(from, to)]` range excludes the
//!     version is dropped, and in the sets bundled with PHP (the
//!     [defaults](ide_sdk::php::default_stub_sets)) so is one whose
//!     docblock says `@since` a later version or `@removed` in an earlier
//!     one (other extensions use `@since` for their own versions);
//!   - `#[LanguageLevelTypeAware(['8.0' => 'T', …], default: 'D')]` picks the
//!     type for the version: the entry with the highest version not above it,
//!     else the default (`''` for no type).
//!
//! Stub paths are relative to the archive root and use `/`
//! (`standard/standard_1.php`); [`STUB_ROOT`] is the logical folder they are
//! parsed under.

mod rules;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ide_core::settings::Settings;
use rayon::prelude::*;

use crate::summary::{ClassLike, ConstantDecl, FileSummary, FunctionDecl, Loc, Param, TypeHint};
use crate::syntax::ParsedFile;
use rules::Rules;

/// The phpstorm-stubs release in `stubs/phpstorm-stubs.zip`.
pub const STUBS_TAG: &str = "v2026.2";
/// The commit [`STUBS_TAG`] points at.
pub const STUBS_COMMIT: &str = "709e512210784a7c0a677b3a89d35def844a59b9";
/// The logical folder stub files are parsed under.
pub const STUB_ROOT: &str = "phpstorm-stubs";

static ARCHIVE: &[u8] = include_bytes!("../../stubs/phpstorm-stubs.zip");

/// A PHP language level: major and minor version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PhpVersion {
    pub major: u8,
    pub minor: u8,
}

impl PhpVersion {
    /// The newest version the bundled stubs describe; the level when a
    /// project names none.
    pub const LATEST: Self = Self::new(8, 5);

    pub const fn new(major: u8, minor: u8) -> Self {
        Self { major, minor }
    }

    /// `8`, `8.1`, `8.1.0`, `v8.1`; anything after the minor version is
    /// ignored. `None` when it does not start with a number.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().trim_start_matches(['v', 'V']);
        let mut parts = text.split('.');
        let number = |part: &str| -> Option<u8> {
            let digits = &part[..part.find(|c: char| !c.is_ascii_digit()).unwrap_or(part.len())];
            digits.parse().ok()
        };
        let major = number(parts.next()?)?;
        let minor = parts.next().and_then(number).unwrap_or(0);
        Some(Self { major, minor })
    }
}

impl fmt::Display for PhpVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// Which stubs a project sees: its PHP version and its enabled stub sets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StubFilter {
    pub version: PhpVersion,
    /// [`ide_sdk::php::stub_key`]s of the enabled sets; `None` enables all.
    extensions: Option<HashSet<String>>,
}

impl StubFilter {
    /// The given stub sets (folder names such as `standard` or
    /// `Zend OPcache`, in any spelling [`ide_sdk::php::stub_key`] accepts).
    pub fn new<S: AsRef<str>>(version: PhpVersion, extensions: impl IntoIterator<Item = S>) -> Self {
        let extensions = extensions.into_iter().map(|ext| ide_sdk::php::stub_key(ext.as_ref())).collect();
        Self { version, extensions: Some(extensions) }
    }

    /// Every bundled stub set.
    pub fn all_extensions(version: PhpVersion) -> Self {
        Self { version, extensions: None }
    }

    /// The project's language level and stub sets from Settings › PHP and
    /// its `composer.json`.
    pub fn from_settings(root: &Path, settings: &Settings) -> Self {
        let version = ide_sdk::php::language_level(root, settings)
            .and_then(|level| PhpVersion::parse(&level))
            .unwrap_or(PhpVersion::LATEST);
        Self::new(version, ide_sdk::php::stub_sets(root, settings))
    }

    /// Whether the stub set (a top-level folder) is enabled.
    pub fn includes_extension(&self, extension: &str) -> bool {
        self.extensions.as_ref().is_none_or(|enabled| enabled.contains(&ide_sdk::php::stub_key(extension)))
    }
}

impl Default for StubFilter {
    /// Every stub set at the latest PHP version.
    fn default() -> Self {
        Self::all_extensions(PhpVersion::LATEST)
    }
}

/// One stub file's declarations as a project sees them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StubFile {
    /// Relative to the archive root, `/`-separated.
    pub path: String,
    /// The stub set: the top-level folder.
    pub extension: String,
    pub summary: FileSummary,
}

/// The built-in declarations for one [`StubFilter`].
#[derive(Clone, Debug, Default)]
pub struct StubSet {
    pub files: Vec<StubFile>,
}

impl StubSet {
    /// The function with this fully qualified name (case-insensitive).
    pub fn function(&self, fqn: &str) -> Option<(&StubFile, &FunctionDecl)> {
        self.files.iter().find_map(|file| Some((file, file.summary.function(fqn)?)))
    }

    /// The class-like with this fully qualified name (case-insensitive).
    pub fn class_like(&self, fqn: &str) -> Option<(&StubFile, &ClassLike)> {
        self.files.iter().find_map(|file| Some((file, file.summary.class_like(fqn)?)))
    }

    /// The constant with this fully qualified name (case-sensitive).
    pub fn constant(&self, fqn: &str) -> Option<(&StubFile, &ConstantDecl)> {
        let fqn = fqn.trim_start_matches('\\');
        self.files.iter().find_map(|file| Some((file, file.summary.constants.iter().find(|c| c.fqn == fqn)?)))
    }
}

/// Every bundled stub file, parsed and summarised, with the availability
/// rules needed to filter it.
pub struct BundledStubs {
    files: Vec<Entry>,
    by_path: HashMap<String, usize>,
}

struct Entry {
    path: String,
    extension: String,
    text: Arc<str>,
    summary: FileSummary,
    rules: Rules,
}

impl BundledStubs {
    /// The embedded stubs, loaded on first use.
    pub fn get() -> &'static Self {
        static STUBS: OnceLock<BundledStubs> = OnceLock::new();
        STUBS.get_or_init(|| Self::load(ARCHIVE).expect("the embedded phpstorm-stubs archive is valid"))
    }

    /// Unpacks an archive laid out like `stubs/phpstorm-stubs.zip` and
    /// summarises its `.php` files.
    pub fn load(archive: &[u8]) -> Result<Self, zip::result::ZipError> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))?;
        let mut sources = Vec::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let path = entry.name()?.into_owned();
            let Some((extension, _)) = path.split_once('/') else { continue };
            if !entry.is_file() || !path.ends_with(".php") {
                continue;
            }
            let mut text = String::with_capacity(entry.size() as usize);
            entry.read_to_string(&mut text)?;
            sources.push((path.clone(), extension.to_owned(), text));
        }
        let core: HashSet<String> =
            ide_sdk::php::default_stub_sets().iter().map(|set| ide_sdk::php::stub_key(set)).collect();
        let files: Vec<Entry> = sources
            .into_par_iter()
            .map(|(path, extension, text)| {
                let parsed = ParsedFile::parse(&format!("{STUB_ROOT}/{path}"), text);
                let doc_versions = core.contains(&ide_sdk::php::stub_key(&extension));
                Entry {
                    summary: FileSummary::extract(&parsed),
                    rules: rules::collect(&parsed, doc_versions),
                    text: parsed.shared_text(),
                    path,
                    extension,
                }
            })
            .collect();
        let by_path = files.iter().enumerate().map(|(i, file)| (file.path.clone(), i)).collect();
        Ok(Self { files, by_path })
    }

    /// The stub file paths, in archive order.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.iter().map(|file| file.path.as_str())
    }

    /// The stub sets (top-level folders), sorted.
    pub fn extensions(&self) -> Vec<&str> {
        let mut extensions: Vec<&str> = self.files.iter().map(|file| file.extension.as_str()).collect();
        extensions.sort_unstable();
        extensions.dedup();
        extensions
    }

    /// The text of a stub file.
    pub fn source(&self, path: &str) -> Option<&str> {
        self.by_path.get(path).map(|&i| &*self.files[i].text)
    }

    /// The stub file's path on disk once [materialized](Self::materialize)
    /// below `dir`: `dir/<STUBS_TAG>/<path>`.
    pub fn stub_path(dir: &Path, path: &str) -> PathBuf {
        let mut out = dir.join(STUBS_TAG);
        out.extend(path.split('/'));
        out
    }

    /// Writes the bundled stub file `path` below `dir` (see
    /// [`stub_path`](Self::stub_path)) unless it is already there with the
    /// same length, so goto definition can open built-in declarations as
    /// ordinary read-only files. `None` for an unknown path or a write error.
    pub fn materialize(dir: &Path, path: &str) -> Option<PathBuf> {
        let text = Self::get().source(path)?;
        let target = Self::stub_path(dir, path);
        let current = std::fs::metadata(&target).ok().map(|m| m.len());
        if current != Some(text.len() as u64) {
            std::fs::create_dir_all(target.parent()?).ok()?;
            std::fs::write(&target, text).map_err(|e| tracing::warn!("php stubs {}: {e}", target.display())).ok()?;
        }
        Some(target)
    }

    /// The unfiltered summary of a stub file: every declaration, whatever
    /// its PHP version.
    pub fn raw_summary(&self, path: &str) -> Option<&FileSummary> {
        self.by_path.get(path).map(|&i| &self.files[i].summary)
    }

    /// The declarations a project with this filter sees.
    pub fn summaries(&self, filter: &StubFilter) -> StubSet {
        let files = self
            .files
            .par_iter()
            .filter(|file| filter.includes_extension(&file.extension))
            .map(|file| StubFile {
                path: file.path.clone(),
                extension: file.extension.clone(),
                summary: apply(&file.summary, &file.rules, filter.version),
            })
            .collect();
        StubSet { files }
    }
}

/// The summary as seen at `version`: unavailable declarations and
/// parameters dropped, version-dependent types chosen.
fn apply(summary: &FileSummary, rules: &Rules, version: PhpVersion) -> FileSummary {
    let keep = |loc: &Loc| rules.get(&loc.start).is_none_or(|rule| rule.available(version));
    let retype = |loc: &Loc, hint: &mut Option<TypeHint>| {
        if let Some(ty) = rules.get(&loc.start).and_then(|rule| rule.ty.as_ref()) {
            *hint = ty.at(version);
        }
    };
    let params = |params: &mut Vec<Param>| {
        params.retain(|param| keep(&param.name_loc));
        for param in params {
            retype(&param.name_loc, &mut param.type_hint);
        }
    };

    let mut out = summary.clone();
    out.functions.retain(|function| keep(&function.name_loc));
    for function in &mut out.functions {
        retype(&function.name_loc, &mut function.return_type);
        params(&mut function.params);
    }
    out.constants.retain(|constant| keep(&constant.name_loc));
    out.class_likes.retain(|class| keep(&class.name_loc));
    for class in &mut out.class_likes {
        class.methods.retain(|method| keep(&method.name_loc));
        for method in &mut class.methods {
            retype(&method.name_loc, &mut method.return_type);
            params(&mut method.params);
        }
        class.properties.retain(|property| keep(&property.name_loc));
        for property in &mut class.properties {
            retype(&property.name_loc, &mut property.type_hint);
        }
        class.constants.retain(|constant| keep(&constant.name_loc));
        for constant in &mut class.constants {
            retype(&constant.name_loc, &mut constant.type_hint);
        }
        class.cases.retain(|case| keep(&case.name_loc));
    }
    out
}
