//! The marketplace: a static index (`index.json` +
//! packages, served from any URL or folder) lists publishers and their keys,
//! plugins, and revocations. The host keeps the last index it read
//! (`market-index.json`), checks signatures against it, and disables what it
//! revokes — at start-up and on every refresh (the desktop refreshes daily).
//! Release builds pin the official publisher to the keys they were built
//! with, so no index can sign `openidea.*` plugins with another key.

use super::{PackageFile, PluginEvent, PluginHost, PluginSource, PluginStatus, PluginUpdate, install};
use ide_core::{IdeError, IdeResult};
use ide_extension::package::{self, Index, IndexEntry, PackageSignature, SIGNATURE_FILE};
use ide_extension::{MANIFEST_FILE, Manifest};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The official marketplace: the index the release workflow publishes with
/// the app, next to the signed packages of the official plugins.
pub const OFFICIAL_INDEX: &str = "https://github.com/l0ng-ai/openidea/releases/latest/download/plugins-index.json";

/// The publisher of the official plugins.
pub const OFFICIAL_PUBLISHER: &str = "openidea";

/// The last index read, in the plugins directory.
pub const INDEX_FILE: &str = "market-index.json";
const DOWNLOADS: &str = ".downloads";
const MAX_INDEX: usize = 16 << 20;
const MAX_PACKAGE: usize = 256 << 20;
const MAX_STAGED_FILES: usize = 256;
const MAX_STAGED_BYTES: usize = 16 << 20;
/// `moved` links followed before giving up (a loop, or a misconfiguration).
const MAX_MOVES: usize = 3;

/// A marketplace entry with what is installed.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    #[serde(flatten)]
    pub entry: IndexEntry,
    /// Installed version, if any.
    pub installed: Option<String>,
    /// Whether this IDE can load `entry` (the newest version it can, else the newest).
    pub compatible: bool,
}

impl MarketPlugin {
    /// A version this IDE can load, newer than the one installed.
    pub fn is_update(&self) -> bool {
        let newer = |installed: &String| match (Version::parse(&self.entry.version), Version::parse(installed)) {
            (Ok(offered), Ok(installed)) => offered > installed,
            _ => false,
        };
        self.compatible && self.installed.as_ref().is_some_and(newer)
    }
}

/// The official publisher's keys this IDE was built with
/// (`OPENIDEA_OFFICIAL_PLUGIN_KEYS`: base64, comma-separated). Development
/// builds have none: the index decides.
pub(super) fn built_in_official_keys() -> Vec<String> {
    let keys = option_env!("OPENIDEA_OFFICIAL_PLUGIN_KEYS").unwrap_or_default();
    keys.split(',').map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned).collect()
}

fn pinned(mut index: Index, official_keys: &[String]) -> Index {
    index.pin_publisher(OFFICIAL_PUBLISHER, "OpenIDEA", official_keys);
    index
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

/// The index at `url`, following `moved`, with downloads made absolute against
/// where it was read from.
fn read_index(url: &str) -> IdeResult<Index> {
    let mut url = url.to_owned();
    for _ in 0..=MAX_MOVES {
        let bytes = read_url(&url, MAX_INDEX).map_err(IdeError::unavailable)?;
        let text = String::from_utf8(bytes).map_err(|_| IdeError::invalid("the index is not UTF-8"))?;
        let mut index = Index::parse(&text).map_err(IdeError::invalid)?;
        match index.moved.take().filter(|m| !m.trim().is_empty()) {
            Some(next) => {
                let next = resolve(&url, &next);
                if url.starts_with("https://") && !next.starts_with("https://") {
                    return Err(IdeError::invalid(format!("the marketplace moved to {next}, which isn't https")));
                }
                url = next;
            }
            None => {
                for e in &mut index.plugins {
                    e.download = resolve(&url, &e.download);
                }
                return Ok(index);
            }
        }
    }
    Err(IdeError::unavailable(format!("the marketplace index moved more than {MAX_MOVES} times")))
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
    pub(super) fn load_market_index(dir: &Path, official_keys: &[String]) -> Option<Index> {
        let text = std::fs::read_to_string(dir.join(INDEX_FILE)).ok()?;
        let index = Index::parse(&text).map_err(|e| tracing::warn!("{INDEX_FILE}: {e}")).ok()?;
        Some(pinned(index, official_keys))
    }

    /// Pins the official publisher to `keys` (base64) instead of the built-in
    /// ones, from the next index read.
    pub fn set_official_keys(&self, keys: Vec<String>) {
        *self.official_keys.write() = keys;
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

    /// The marketplace's plugins: read again when `refresh`, else the last index
    /// read. Reads it when none has been read yet (first run, nothing cached).
    pub fn market_listing(&self, refresh: bool) -> IdeResult<Vec<MarketPlugin>> {
        if refresh || (self.market.read().is_none() && self.market_url().is_some()) {
            self.refresh_market()
        } else {
            Ok(self.market_plugins())
        }
    }

    /// Reads the index again, keeps it, and applies its revocations. Announces
    /// updates of installed plugins it hasn't announced yet.
    pub fn refresh_market(&self) -> IdeResult<Vec<MarketPlugin>> {
        let url = self.market_url().ok_or_else(|| IdeError::unavailable("no plugin marketplace is configured"))?;
        let index = read_index(&url)?;
        if let Ok(json) = serde_json::to_string(&index) {
            let _ = std::fs::write(self.plugins_dir.join(INDEX_FILE), json);
        }
        let newer = index.is_newer().then_some(index.format);
        *self.market.write() = Some(pinned(index, &self.official_keys.read()));
        // Trust may have changed: who signed what, what is revoked.
        let installed: Vec<_> =
            self.plugins.read().values().filter(|p| p.source == PluginSource::Installed).cloned().collect();
        for plugin in installed {
            let publisher = self.verified_publisher(plugin.dir());
            plugin.meta.lock().publisher = publisher;
        }
        self.apply_revocations();
        if let Some(format) = newer {
            return Err(IdeError::unavailable(format!(
                "the marketplace needs a newer OpenIDEA (index format {format}); its revocations still apply"
            )));
        }
        let plugins = self.market_plugins();
        self.announce_updates(&plugins);
        Ok(plugins)
    }

    /// Tells the windows about updates once per set of versions: a later
    /// refresh offering the same ones says nothing.
    fn announce_updates(&self, plugins: &[MarketPlugin]) {
        let updates: Vec<PluginUpdate> = plugins
            .iter()
            .filter(|p| p.is_update())
            .map(|p| PluginUpdate {
                id: p.entry.id.clone(),
                name: p.entry.name.clone(),
                version: p.entry.version.clone(),
            })
            .collect();
        let key: Vec<String> = updates.iter().map(|u| format!("{}@{}", u.id, u.version)).collect();
        if std::mem::replace(&mut *self.announced_updates.lock(), key.clone()) != key && !updates.is_empty() {
            self.emit(None, PluginEvent::UpdatesAvailable { updates });
        }
    }

    /// Whether the package in `src` would replace the installed `id`'s copy
    /// with one signed by another key than that copy, without that key's
    /// endorsement: the user confirms the change of signer.
    pub(super) fn signer_changed(&self, id: &str, src: &Path) -> bool {
        let Some(current) = install::active_dir(&self.plugins_dir.join(id)) else { return false };
        let market = self.market.read();
        !package::signer_continues(market.as_ref(), read_signature(&current).as_ref(), read_signature(src).as_ref())
    }

    /// The plugins of the last index read.
    pub fn market_plugins(&self) -> Vec<MarketPlugin> {
        let Some(index) = self.market.read().clone() else { return Vec::new() };
        let plugins = self.plugins.read();
        index
            .offered()
            .into_iter()
            .map(|(entry, compatible)| {
                let installed = plugins
                    .get(&entry.id)
                    .filter(|p| p.source == PluginSource::Installed)
                    .map(|p| p.manifest().version.clone());
                MarketPlugin { entry: entry.clone(), installed, compatible }
            })
            .collect()
    }

    /// Downloads a marketplace plugin, checks it against the index (digest and
    /// signature), and unpacks it for the install page. Returns the folder to
    /// install from.
    pub fn download_market_plugin(&self, id: &str) -> IdeResult<PathBuf> {
        let url = self.market_url().ok_or_else(|| IdeError::unavailable("no plugin marketplace is configured"))?;
        let index = self.market.read().clone().ok_or_else(|| IdeError::unavailable("refresh the marketplace first"))?;
        let (entry, compatible) = index
            .offered()
            .into_iter()
            .find(|(e, _)| e.id == id)
            .map(|(e, ok)| (e.clone(), ok))
            .ok_or_else(|| IdeError::not_found(format!("{id} is not in the marketplace")))?;
        if !compatible {
            return Err(IdeError::unavailable(format!(
                "{} {} needs plugin API {}: update OpenIDEA",
                entry.name, entry.version, entry.engine
            )));
        }
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

    /// Writes a package the UI generated (an imported IntelliJ theme) into a
    /// folder next to the downloads, named after `name` (its plugin id); returns the folder.
    /// The install page validates it like any other package.
    pub fn stage_package(&self, name: &str, files: &[PackageFile]) -> IdeResult<PathBuf> {
        ide_extension::validate_item_id(name, "package name").map_err(IdeError::invalid)?;
        if !files.iter().any(|f| f.path == MANIFEST_FILE) {
            return Err(IdeError::invalid(format!("a package needs a {MANIFEST_FILE}")));
        }
        let total: usize = files.iter().map(|f| f.text.len()).sum();
        if files.len() > MAX_STAGED_FILES || total > MAX_STAGED_BYTES {
            return Err(IdeError::invalid("the package is too large"));
        }
        let mut seen = std::collections::HashSet::new();
        for f in files {
            let valid = !f.path.is_empty()
                && f.path.len() <= 255
                && f.path.split('/').all(|part| {
                    !matches!(part, "" | "." | "..") && !part.contains(['\\', ':', '\0']) && !part.starts_with('.')
                });
            if !valid {
                return Err(IdeError::invalid(format!("invalid package path {:?}", f.path)));
            }
            if !seen.insert(f.path.to_ascii_lowercase()) {
                return Err(IdeError::invalid(format!("{} is in the package twice", f.path)));
            }
        }
        // One folder per package, replaced by the next import of it: they don't pile up.
        let dir = self.plugins_dir.join(DOWNLOADS).join(format!("{name}-generated"));
        let _ = std::fs::remove_dir_all(&dir);
        for f in files {
            let path = dir.join(&f.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, &f.text)?;
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
