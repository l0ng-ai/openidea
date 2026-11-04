//! The extension point contract (plan 4.1).

use crate::capability::Capability;
use crate::manifest::{Manifest, check_relative};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where a contribution takes effect (plan 3, placement rules).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    /// Projected to the client (menus, keybindings, themes, icons).
    Ui,
    /// Takes effect on the machine the project is on (languages, LSP, run configurations).
    Workspace,
}

/// The package a declaration comes from, as extension points see it.
#[derive(Clone, Debug)]
pub struct Package {
    pub manifest: Arc<Manifest>,
    /// Package directory.
    pub dir: PathBuf,
    /// Hash of the package's files when they never change (an installed
    /// copy): validated declarations are then reused from the
    /// [`ContributionIndex`](crate::ContributionIndex).
    pub digest: Option<Arc<str>>,
}

/// Largest single package file an extension point reads.
pub const MAX_PACKAGE_FILE: u64 = 8 << 20;

impl Package {
    pub fn new(manifest: Manifest, dir: PathBuf) -> Self {
        Self { manifest: Arc::new(manifest), dir, digest: None }
    }

    pub fn with_digest(mut self, digest: &str) -> Self {
        self.digest = Some(digest.into());
        self
    }

    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    /// Resolves a package-relative path, refusing anything that leaves the
    /// package (`..`, absolute paths, symlinks pointing outside).
    pub fn resolve(&self, rel: &Path) -> Result<PathBuf, String> {
        check_relative(rel, "path")?;
        let joined = self.dir.join(rel);
        let real = joined.canonicalize().map_err(|_| format!("{}: no such file in the plugin", rel.display()))?;
        let root = self.dir.canonicalize().map_err(|e| format!("plugin directory: {e}"))?;
        if !real.starts_with(&root) {
            return Err(format!("{}: points outside the plugin", rel.display()));
        }
        Ok(real)
    }

    pub fn read_bytes(&self, rel: &Path) -> Result<Vec<u8>, String> {
        let real = self.resolve(rel)?;
        let meta = std::fs::metadata(&real).map_err(|e| format!("{}: {e}", rel.display()))?;
        if !meta.is_file() {
            return Err(format!("{}: not a file", rel.display()));
        }
        if meta.len() > MAX_PACKAGE_FILE {
            return Err(format!("{}: larger than {} MiB", rel.display(), MAX_PACKAGE_FILE >> 20));
        }
        std::fs::read(&real).map_err(|e| format!("{}: {e}", rel.display()))
    }

    pub fn read_text(&self, rel: &Path) -> Result<String, String> {
        String::from_utf8(self.read_bytes(rel)?).map_err(|_| format!("{}: not UTF-8 text", rel.display()))
    }
}

/// Undoes one committed contribution. Dropping without [`dispose`](Self::dispose) also disposes.
#[must_use = "dropping a Disposable undoes the contribution"]
pub struct Disposable(Option<Box<dyn FnOnce() + Send>>);

impl Disposable {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(f)))
    }

    /// A contribution with nothing to undo.
    pub fn noop() -> Self {
        Self(None)
    }

    pub fn dispose(mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

impl Drop for Disposable {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

impl std::fmt::Debug for Disposable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Disposable")
    }
}

pub type Commit = Box<dyn FnOnce() -> Result<Disposable, String> + Send>;

/// A validated declaration, ready to take effect.
pub struct Prepared {
    /// Capabilities this declaration needs (a language with an LSP → `process:<binary>`).
    pub capabilities: Vec<Capability>,
    /// Package files the declaration references (copied on install).
    pub files: Vec<PathBuf>,
    /// Identity within the point: a later declaration with the same key replaces
    /// the earlier one of the same plugin (re-registering a command).
    pub key: Option<String>,
    /// User-facing one-liner for the plugin details page ("Insert Date").
    pub label: String,
    /// Makes it take effect. Must not fail for reasons `prepare` could have checked.
    pub commit: Commit,
}

impl Prepared {
    pub fn new(label: impl Into<String>, commit: impl FnOnce() -> Result<Disposable, String> + Send + 'static) -> Self {
        Self { capabilities: Vec::new(), files: Vec::new(), key: None, label: label.into(), commit: Box::new(commit) }
    }

    pub fn key(mut self, key: impl Into<String>) -> Self {
        self.key = Some(key.into());
        self
    }

    pub fn file(mut self, path: impl Into<PathBuf>) -> Self {
        self.files.push(path.into());
        self
    }

    pub fn capability(mut self, cap: Capability) -> Self {
        if !self.capabilities.contains(&cap) {
            self.capabilities.push(cap);
        }
        self
    }
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared").field("key", &self.key).field("label", &self.label).finish_non_exhaustive()
    }
}

/// A kind of contribution (`contributes.<id>` in the manifest). Implemented by
/// the crate that owns the feature; registered once in an [`crate::ExtensionRegistry`].
pub trait ExtensionPoint: Send + Sync {
    /// `"languages"`, `"iconThemes"`, …
    fn id(&self) -> &'static str;

    fn placement(&self) -> Placement;

    /// Parses and validates one declaration without side effects, and works
    /// out the capabilities it needs. `Ui` points validate completely here: the
    /// client's projection is not allowed to fail.
    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String>;
}

/// Deserializes a declaration with serde, prefixing errors with the point id.
pub fn decode<T: serde::de::DeserializeOwned>(point: &str, decl: toml::Value) -> Result<T, String> {
    decl.try_into().map_err(|e: toml::de::Error| format!("contributes.{point}: {}", e.message()))
}
