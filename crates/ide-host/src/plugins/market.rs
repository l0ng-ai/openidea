//! The marketplace: a static index (`index.json` +
//! packages, served from any URL or folder) lists publishers and their keys,
//! plugins, and revocations. The host keeps the last index it read
//! (`market-index.json`), checks signatures against it, and disables what it
//! revokes — at start-up and on every refresh (the desktop refreshes daily).

use super::{PluginHost, PluginSource, PluginStatus};
use ide_core::{IdeError, IdeResult};
use ide_extension::Manifest;
use ide_extension::package::{self, Index, IndexEntry, PackageSignature, SIGNATURE_FILE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The official marketplace: the index the release workflow publishes with
/// the app, next to the signed packages of the official plugins.
pub const OFFICIAL_INDEX: &str = "https://github.com/l0ng-ai/openidea/releases/latest/download/plugins-index.json";

/// The last index read, in the plugins directory.
pub const INDEX_FILE: &str = "market-index.json";
const DOWNLOADS: &str = ".downloads";
const MAX_INDEX: usize = 16 << 20;
const MAX_PACKAGE: usize = 256 << 20;

/// A marketplace entry with what is installed.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    #[serde(flatten)]
    pub entry: IndexEntry,
    /// Installed version, if any.
    pub installed: Option<String>,
}

/// Reads `url`: `http(s)://…`, `file://…` or a local path.
pub fn read_url(url: &str, max: usize) -> Result<Vec<u8>, String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        let client = ide_http::client::shared().map_err(|e| e.message)?;
        let url = url.to_owned();
        return super::api::net_runtime().block_on(async move {
            let response = client.get(&url).send().await.map_err(|e| format!("{url}: {e}"))?;
            if !response.status().is_success() {
                return Err(format!("{url}: HTTP {}", response.status()));
            }
            let bytes = response.bytes().await.map_err(|e| format!("{url}: {e}"))?;
            if bytes.len() > max {
                return Err(format!("{url}: larger than {} MiB", max >> 20));
            }
            Ok(bytes.to_vec())
        });
    }
    let path = url.strip_prefix("file://").unwrap_or(url);
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > max {
        return Err(format!("{path}: larger than {} MiB", max >> 20));
    }
    Ok(bytes)
}

/// `href` relative to the index at `base`: a URL, or a local path (with the
/// platform's separators, e.g. `C:\\market\\index.json`).
pub fn resolve(base: &str, href: &str) -> String {
    if href.contains("://") || href.starts_with('/') || Path::new(href).is_absolute() {
        return href.to_owned();
    }
    if base.contains("://") {
        return match base.rfind('/') {
            Some(i) => format!("{}/{href}", &base[..i]),
            None => href.to_owned(),
        };
    }
    match Path::new(base).parent() {
        Some(dir) => dir.join(href).to_string_lossy().into_owned(),
        None => href.to_owned(),
    }
}

impl PluginHost {
    pub(super) fn load_market_index(dir: &Path) -> Option<Index> {
        let text = std::fs::read_to_string(dir.join(INDEX_FILE)).ok()?;
        Index::parse(&text).map_err(|e| tracing::warn!("{INDEX_FILE}: {e}")).ok()
    }

    /// The marketplace index URL: the user's, else the default (none: no marketplace).
    pub fn market_url(&self) -> Option<String> {
        self.state.lock().market_url.clone().or_else(|| self.default_market_url.read().clone())
    }

    /// The marketplace used while the user has set none.
    pub fn set_default_market_url(&self, url: Option<String>) {
        *self.default_market_url.write() = url.filter(|u| !u.trim().is_empty());
    }

    pub fn set_market_url(&self, url: Option<String>) {
        self.state.lock().market_url = url.filter(|u| !u.trim().is_empty());
        self.save_state();
    }

    /// Reads the index again, keeps it, and applies its revocations.
    pub fn refresh_market(&self) -> IdeResult<Vec<MarketPlugin>> {
        let url = self.market_url().ok_or_else(|| IdeError::unavailable("no plugin marketplace is configured"))?;
        let bytes = read_url(&url, MAX_INDEX).map_err(IdeError::unavailable)?;
        let text = String::from_utf8(bytes).map_err(|_| IdeError::invalid("the index is not UTF-8"))?;
        let index = Index::parse(&text).map_err(IdeError::invalid)?;
        let _ = std::fs::write(self.plugins_dir.join(INDEX_FILE), &text);
        *self.market.write() = Some(index);
        // Trust may have changed: who signed what, what is revoked.
        let installed: Vec<_> =
            self.plugins.read().values().filter(|p| p.source == PluginSource::Installed).cloned().collect();
        for plugin in installed {
            let publisher = self.verified_publisher(plugin.dir());
            plugin.meta.lock().publisher = publisher;
        }
        self.apply_revocations();
        Ok(self.market_plugins())
    }

    /// The plugins of the last index read.
    pub fn market_plugins(&self) -> Vec<MarketPlugin> {
        let Some(index) = self.market.read().clone() else { return Vec::new() };
        let plugins = self.plugins.read();
        index
            .plugins
            .iter()
            .filter(|e| index.revocation(&e.id, &e.version).is_none())
            .cloned()
            .map(|entry| {
                let installed = plugins
                    .get(&entry.id)
                    .filter(|p| p.source == PluginSource::Installed)
                    .map(|p| p.manifest().version.clone());
                MarketPlugin { entry, installed }
            })
            .collect()
    }

    /// Downloads a marketplace plugin, checks it against the index (digest and
    /// signature), and unpacks it for the install page. Returns the folder to
    /// install from.
    pub fn download_market_plugin(&self, id: &str) -> IdeResult<PathBuf> {
        let url = self.market_url().ok_or_else(|| IdeError::unavailable("no plugin marketplace is configured"))?;
        let index = self.market.read().clone().ok_or_else(|| IdeError::unavailable("refresh the marketplace first"))?;
        let entry = index
            .plugins
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or_else(|| IdeError::not_found(format!("{id} is not in the marketplace")))?;
        let bytes = read_url(&resolve(&url, &entry.download), MAX_PACKAGE).map_err(IdeError::unavailable)?;
        let downloads = self.plugins_dir.join(DOWNLOADS);
        std::fs::create_dir_all(&downloads)?;
        let archive = downloads.join(format!("{}-{}.{}", entry.id, entry.version, package::PACKAGE_EXTENSION));
        std::fs::write(&archive, bytes)?;
        let dir = self.unpack_package(&archive)?;
        let _ = std::fs::remove_file(&archive);
        let manifest = Manifest::load(&dir).map_err(IdeError::invalid)?;
        let files = self.package_files_in(&dir)?;
        let digest = package::package_digest(&dir, &files)?;
        if (manifest.id.as_str(), manifest.version.as_str(), digest.as_str())
            != (&entry.id, &entry.version, &entry.digest)
        {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(IdeError::invalid("the download does not match the marketplace's entry"));
        }
        if self.verified_publisher(&dir).is_none() {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(IdeError::invalid("the marketplace package is not signed by a trusted publisher"));
        }
        Ok(dir)
    }

    /// Unpacks a package file (`.oiplugin`, or a `.zip` of a package) next to the downloads; returns the folder.
    pub fn unpack_package(&self, archive: &Path) -> IdeResult<PathBuf> {
        let stem = archive.file_stem().and_then(|s| s.to_str()).unwrap_or("package");
        let dir = self.plugins_dir.join(DOWNLOADS).join(format!("{stem}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let unpacked = package::unpack(archive, &dir).map_err(IdeError::invalid)?;
        // Kept with the files: install checks it and keeps it with the installed copy.
        if let Some(sig) = unpacked.signature {
            let json = serde_json::to_string_pretty(&sig).map_err(|e| IdeError::internal(e.to_string()))?;
            std::fs::write(dir.join(SIGNATURE_FILE), json)?;
        }
        Ok(dir)
    }

    /// Files of the package in `dir` (what its declarations reference, and
    /// the component): what a package file holds besides the manifest.
    pub fn package_files_of(&self, dir: &Path) -> IdeResult<Vec<PathBuf>> {
        self.package_files_in(dir)
    }

    pub(super) fn package_files_in(&self, dir: &Path) -> IdeResult<Vec<PathBuf>> {
        let manifest = Manifest::load(dir).map_err(IdeError::invalid)?;
        let pkg = ide_extension::Package::new(manifest, dir.to_path_buf());
        let set = self.registry.prepare(&pkg).map_err(IdeError::invalid)?;
        Ok(set.files.into_iter().chain(pkg.manifest.wasm.clone()).collect())
    }

    /// The publisher whose valid, trusted signature the package in `dir` carries.
    pub(super) fn verified_publisher(&self, dir: &Path) -> Option<String> {
        let sig = read_signature(dir)?;
        let index = self.market.read().clone()?;
        let manifest = Manifest::load(dir).ok()?;
        let files = self.package_files_in(dir).ok()?;
        let digest = package::package_digest(dir, &files).ok()?;
        index
            .verify(&sig, &manifest.id, &manifest.version, &digest)
            .map_err(|e| tracing::warn!("{}: {e}", dir.display()))
            .ok()
    }

    /// A signature that is present but doesn't verify (tampered, foreign prefix,
    /// revoked or unknown key): installing is refused.
    pub(super) fn signature_problem(&self, dir: &Path) -> Option<String> {
        let sig = read_signature(dir)?;
        let manifest = Manifest::load(dir).ok()?;
        let files = self.package_files_in(dir).ok()?;
        let digest = package::package_digest(dir, &files).ok()?;
        if let Err(e) = sig.check(&manifest.id, &manifest.version, &digest) {
            return Some(e);
        }
        let index = self.market.read().clone()?;
        index.verify(&sig, &manifest.id, &manifest.version, &digest).err()
    }

    /// Why an installed plugin must not run (index revocations, revoked signing key).
    pub(super) fn revoked_reason(&self, id: &str, version: &str, dir: &Path) -> Option<String> {
        let market = self.market.read();
        let index = market.as_ref()?;
        if let Some(r) = index.revocation(id, version) {
            return Some(r.reason.clone());
        }
        let sig = read_signature(dir)?;
        index.key_revoked(&sig.key).then(|| "its publisher's signing key was revoked".to_owned())
    }

    /// Disables installed plugins the index revokes (telling the user once),
    /// and starts again those it no longer revokes.
    pub(super) fn apply_revocations(&self) {
        let installed: Vec<_> =
            self.plugins.read().values().filter(|p| p.source == PluginSource::Installed).cloned().collect();
        let mut changed = false;
        for plugin in installed {
            let reason = self.revoked_reason(plugin.id(), &plugin.manifest().version, plugin.dir());
            let current = plugin.meta.lock().error.clone().filter(|e| e.starts_with("revoked: "));
            match (reason, current) {
                (Some(r), Some(c)) if c == format!("revoked: {r}") => {}
                (Some(reason), was) => {
                    self.stop(&plugin);
                    {
                        let mut meta = plugin.meta.lock();
                        meta.status = PluginStatus::Failed;
                        meta.error = Some(format!("revoked: {reason}"));
                    }
                    if was.is_none() {
                        self.emit(
                            None,
                            super::PluginEvent::Notification {
                                plugin_id: plugin.id().to_owned(),
                                level: ide_plugin::NotificationLevel::Warning,
                                title: format!("{} was disabled", plugin.manifest().name),
                                body: format!("The marketplace revoked this plugin: {reason}"),
                            },
                        );
                    }
                    changed = true;
                }
                (None, Some(_)) => {
                    {
                        let mut meta = plugin.meta.lock();
                        meta.status = PluginStatus::Inactive;
                        meta.error = None;
                    }
                    if !self.state.lock().disabled.contains(plugin.id()) {
                        self.start(&plugin);
                    }
                    changed = true;
                }
                (None, None) => {}
            }
        }
        if changed {
            self.changed();
        }
    }
}

pub(super) fn read_signature(dir: &Path) -> Option<PackageSignature> {
    let text = std::fs::read_to_string(dir.join(SIGNATURE_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Keeps the signature of a package with its installed copy.
pub(super) fn copy_signature(src: &Path, installed: &Path) {
    if src.join(SIGNATURE_FILE).is_file() {
        let _ = std::fs::copy(src.join(SIGNATURE_FILE), installed.join(SIGNATURE_FILE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_resolve_against_the_index() {
        assert_eq!(resolve("https://x.dev/market/index.json", "p/a.oiplugin"), "https://x.dev/market/p/a.oiplugin");
        assert_eq!(
            Path::new(&resolve("/srv/market/index.json", "a.oiplugin")),
            Path::new("/srv/market").join("a.oiplugin")
        );
        #[cfg(windows)]
        assert_eq!(resolve(r"C:\market\index.json", "a.oiplugin"), r"C:\market\a.oiplugin");
        assert_eq!(resolve("https://x.dev/index.json", "https://cdn.dev/a"), "https://cdn.dev/a");
    }
}
