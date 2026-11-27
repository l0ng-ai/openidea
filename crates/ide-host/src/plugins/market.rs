//! The marketplace: a static index (`index.json` +
//! packages, served from any URL or folder) lists publishers and their keys,
//! plugins, and revocations. The host keeps the last index it read
//! (`market-index.json`), checks signatures against it, and disables what it
//! revokes — at start-up and on every refresh (the desktop refreshes daily).
//! Release builds pin the official publisher to the keys they were built
//! with, so no index can sign `openidea.*` plugins with another key.

use super::icons::{MAX_PLUGIN_ICON, sanitize_svg};
use super::{PackageFile, PluginEvent, PluginHost, PluginSource, PluginStatus, PluginUpdate, install};
use ide_core::{IdeError, IdeResult};
use ide_extension::package::{self, Index, IndexEntry, PackageSignature, PluginIcon, SIGNATURE_FILE};
use ide_extension::{MANIFEST_FILE, Manifest};
use ide_tools::mirror;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

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
const MAX_SUGGESTIONS: usize = 8;

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
    /// The publisher's display name, as the index lists it.
    #[serde(default)]
    pub publisher_name: Option<String>,
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

/// An index's icon as the UI may show it: sanitised again, as any index may
/// have written it; without a light variant that passes, none.
fn safe_icon(icon: PluginIcon) -> Option<PluginIcon> {
    // Before sanitising too: an index may hold megabytes of it.
    let clean = |svg: String| (svg.len() <= MAX_PLUGIN_ICON).then(|| sanitize_svg(&svg).ok()).flatten();
    Some(PluginIcon { light: clean(icon.light)?, dark: icon.dark.and_then(clean) })
}

/// Paths an index suggests a plugin for, as the UI may look them up: relative,
/// inside the project, and few.
fn safe_suggestions(paths: Vec<String>) -> Vec<String> {
    let ok = |p: &String| {
        !p.is_empty()
            && p.len() <= 128
            && !p.starts_with('/')
            && !p.contains(['\\', ':', '\0', '*', '?'])
            && p.split('/').all(|part| !matches!(part, "" | "." | ".."))
    };
    paths.into_iter().filter(ok).take(MAX_SUGGESTIONS).collect()
}

/// Whether `url` is read over the network: `http(s)://…`, not `file://…` or a local path.
fn remote(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Whether an index read from `base` may send the IDE to `href` (resolved). One read over
/// the network names nothing on this machine: the IDE would read the file for it, or sign
/// in to the share it names.
pub fn reachable_from(base: &str, href: &str) -> bool {
    !remote(base) || remote(href)
}

/// The slowest transfer a read over the network waits for, in bytes per second: with
/// `READ_GRACE`, the largest index is given up on after about five minutes, the largest
/// package after a little over an hour.
const SLOWEST_READ: usize = 64 << 10;
/// What a read over the network may take before its first byte.
const READ_GRACE: Duration = Duration::from_secs(30);

/// Reads `url`: `http(s)://…`, `file://…` or a local path.
pub fn read_url(url: &str, max: usize) -> Result<Vec<u8>, String> {
    if remote(url) {
        return read_remote(url, max, READ_GRACE + Duration::from_secs((max / SLOWEST_READ) as u64));
    }
    let path = url.strip_prefix("file://").unwrap_or(url);
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > max {
        return Err(format!("{path}: larger than {} MiB", max >> 20));
    }
    Ok(bytes)
}

/// Reads `url` over http(s): no more than `max` bytes, whatever the server announces or
/// sends, and within `deadline` from the request to the last byte. The marketplace is read
/// with nobody asking, so its server decides neither how much is kept nor for how long.
fn read_remote(url: &str, max: usize, deadline: Duration) -> Result<Vec<u8>, String> {
    let client = ide_http::client::shared().map_err(|e| e.message)?;
    super::api::net_runtime().block_on(async move {
        let failed = |e: reqwest::Error| match e.is_timeout() {
            true => format!("{url}: no answer in time"),
            // With its cause: "error sending request" alone does not say what failed.
            false => format!("{url}: {}", ide_http::client::describe(&e.without_url())),
        };
        let too_large = || format!("{url}: larger than {} MiB", max >> 20);
        let mut response = client.get(url).timeout(deadline).send().await.map_err(failed)?;
        if !response.status().is_success() {
            return Err(format!("{url}: HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|announced| announced > max as u64) {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            if bytes.len() + chunk.len() > max {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    })
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
                if !reachable_from(&url, &next) {
                    return Err(IdeError::invalid("the marketplace moved to an address that is not on the network"));
                }
                url = next;
            }
            None => {
                for e in &mut index.plugins {
                    e.download = resolve(&url, &e.download);
                }
                // Judged here, against where this index was read: the address in use may be
                // an index on this machine that moved to it.
                let listed = index.plugins.len();
                index.plugins.retain(|e| reachable_from(&url, &e.download));
                if index.plugins.len() < listed {
                    tracing::warn!(
                        "plugin marketplace: {} downloads are not on the network; they are not offered",
                        listed - index.plugins.len()
                    );
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

    /// Where plugin packages are fetched from first (Tools › Download sources).
    pub fn set_downloads(&self, downloads: ide_core::settings::ToolDownloadSettings) {
        *self.downloads.write() = downloads;
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
                let mut entry = entry.clone();
                entry.icon = entry.icon.and_then(safe_icon);
                entry.suggest = safe_suggestions(std::mem::take(&mut entry.suggest));
                let publisher_name = index.publishers.iter().find(|p| p.id == entry.publisher).map(|p| p.name.clone());
                MarketPlugin { entry, installed, compatible, publisher_name }
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
        let download = resolve(&url, &entry.download);
        // An index read by this version holds only downloads it may reach. The one kept by an
        // earlier version does not say where it was read: it is judged against the marketplace in use.
        if !reachable_from(&url, &download) {
            return Err(IdeError::invalid(format!(
                "the marketplace's download of {} {} is not on the network",
                entry.id, entry.version
            )));
        }
        let candidates = mirror::candidates(&download, &self.downloads.read());
        let downloads = self.plugins_dir.join(DOWNLOADS);
        std::fs::create_dir_all(&downloads)?;
        let archive = downloads.join(format!("{}-{}.{}", entry.id, entry.version, package::PACKAGE_EXTENSION));
        let picked = try_sources(&candidates, |index, candidate| {
            // Bytes a failed source left behind must not be unpacked as the next one's.
            if index > 0 {
                let _ = std::fs::remove_file(&archive);
            }
            // Which source a package comes from is the first thing to look at when an install
            // is slow or fails (a mirror is one of several candidates), so it goes in the log.
            tracing::info!(
                "plugins: {} {} from {} ({}){}",
                entry.id,
                entry.version,
                candidate.url,
                candidate.describe(),
                if candidates.len() > 1 {
                    format!(", source {} of {}", index + 1, candidates.len())
                } else {
                    String::new()
                }
            );
            let fetched = self.fetch_market_package(&candidate.url, &entry, &archive);
            if let Some(mirror) = &candidate.mirror {
                mirror::report(mirror, fetched.is_ok());
            }
            if let Err(e) = &fetched {
                tracing::warn!("plugins: {} from {} failed: {}", entry.id, candidate.url, e.message);
            }
            fetched
        });
        match picked {
            Ok((dir, index)) => {
                tracing::info!(
                    "plugins: {} {} installed from {}",
                    entry.id,
                    entry.version,
                    candidates[index].describe()
                );
                Ok(dir)
            }
            Err(e) => Err(e),
        }
    }

    /// Fetches the package of `entry` from `url`, checks it against the index (its digest, then
    /// the publisher's signature) and only then hands it over, unpacked. A failure here is that
    /// source's failure.
    ///
    /// The index has no hash of the archive itself, only [`package_digest`] of the unpacked
    /// contents, so the bytes have to be unpacked before they can be checked. The unpacked
    /// files of a source that does **not** check are therefore kept out of reach until they
    /// pass: they go to a staging folder of this attempt, and every exit but the verified one
    /// removes it, so nothing a mirror served is ever left where the install page reads from.
    fn fetch_market_package(&self, url: &str, entry: &IndexEntry, archive: &Path) -> IdeResult<PathBuf> {
        let bytes = read_url(url, MAX_PACKAGE).map_err(IdeError::unavailable)?;
        std::fs::write(archive, bytes)?;
        let unpacked = self.unpack_package(archive);
        // The archive is needed only until it is unpacked; a failed source leaves none behind.
        let _ = std::fs::remove_file(archive);
        let dir = unpacked?;
        self.verify_market_package(&dir, entry).inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&dir);
        })?;
        Ok(dir)
    }

    /// Whether the unpacked package in `dir` is the one `entry` names: same id, version and
    /// digest, and signed by a publisher the index trusts.
    fn verify_market_package(&self, dir: &Path, entry: &IndexEntry) -> IdeResult<()> {
        let manifest = Manifest::load(dir).map_err(IdeError::invalid)?;
        let files = self.package_files_in(dir)?;
        let digest = package::package_digest(dir, &files)?;
        if (manifest.id.as_str(), manifest.version.as_str(), digest.as_str())
            != (&entry.id, &entry.version, &entry.digest)
        {
            return Err(IdeError::invalid("the download does not match the marketplace's entry"));
        }
        if self.verified_publisher(dir).is_none() {
            return Err(IdeError::invalid("the marketplace package is not signed by a trusted publisher"));
        }
        Ok(())
    }

    /// Unpacks a package file (`.oiplugin`, or a `.zip` of a package) next to the downloads; returns the folder.
    ///
    /// A package that fails to unpack leaves nothing: the folder is removed, so a half-written
    /// zip is never mistaken for a package (a mirror's bytes reach here before they are checked).
    pub fn unpack_package(&self, archive: &Path) -> IdeResult<PathBuf> {
        let stem = archive.file_stem().and_then(|s| s.to_str()).unwrap_or("package");
        let dir = self.plugins_dir.join(DOWNLOADS).join(format!("{stem}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let unpacked = match package::unpack(archive, &dir) {
            Ok(unpacked) => unpacked,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(IdeError::invalid(e));
            }
        };
        // Kept with the files: install checks it and keeps it with the installed copy.
        if let Some(sig) = unpacked.signature {
            let json = serde_json::to_string_pretty(&sig).map_err(|e| IdeError::internal(e.to_string()));
            let written = json.and_then(|json| std::fs::write(dir.join(SIGNATURE_FILE), json).map_err(IdeError::from));
            if let Err(e) = written {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
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
        let set = self.prepare(&pkg).map_err(IdeError::invalid)?;
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
                                actions: Vec::new(),
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

/// The first `candidate` whose `attempt` succeeds, with its index.
///
/// A mirror is a third party: when one fails, that failure is its own and the official host
/// below still gets its turn. The official host is the last candidate, so its failure is the
/// download's: returned as it is when nothing came before it, else with the mirrors' reasons.
fn try_sources<T>(
    candidates: &[mirror::Candidate],
    mut attempt: impl FnMut(usize, &mirror::Candidate) -> IdeResult<T>,
) -> IdeResult<(T, usize)> {
    let mut failures: Vec<String> = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        match attempt(index, candidate) {
            Ok(value) => return Ok((value, index)),
            // A mirror's failure is its own: the next source still gets a turn.
            Err(e) if candidate.mirror.is_some() => failures.push(format!("{}: {}", candidate.describe(), e.message)),
            Err(e) if failures.is_empty() => return Err(e),
            Err(e) => {
                failures.push(format!("{}: {}", candidate.describe(), e.message));
                return Err(IdeError::unavailable(format!("could not download ({})", failures.join("; "))));
            }
        }
    }
    Err(IdeError::unavailable(format!("could not download ({})", failures.join("; "))))
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

    #[test]
    fn suggestions_stay_inside_the_project() {
        let paths = ["pom.xml", "config/routes.rb", "/etc/passwd", "../x", "a//b", "C:x", "*.php", ""];
        assert_eq!(safe_suggestions(paths.iter().map(|p| p.to_string()).collect()), ["pom.xml", "config/routes.rb"]);
        assert_eq!(safe_suggestions(vec!["a".into(); 20]).len(), MAX_SUGGESTIONS);
    }

    #[test]
    fn an_index_read_over_the_network_reaches_only_the_network() {
        let base = "https://x.dev/market/index.json";
        let reaches = |href: &str| reachable_from(base, &resolve(base, href));
        for href in ["p/a.oiplugin", "../a.oiplugin", "https://cdn.dev/a"] {
            assert!(reaches(href), "{href}");
        }
        for href in ["/etc/passwd", "//attacker/share/a", "file:///etc/passwd", "file://attacker/share/a"] {
            assert!(!reaches(href), "{href}");
        }
        #[cfg(windows)]
        for href in [r"C:\Users\me\.ssh\id_ed25519", r"\\attacker\share\a", r"\\?\UNC\attacker\share\a"] {
            assert!(!reaches(href), "{href}");
        }
        // A local index names what whoever put it there chose.
        assert!(reachable_from("/srv/market/index.json", "/srv/market/a.oiplugin"));
    }

    #[test]
    fn a_mirror_that_serves_a_bad_package_leaves_the_official_host_its_turn() {
        // Two sources: the mirror, then the official host. The mirror answers with bytes that
        // do not verify — which is exactly the failure `fetch_market_package` reports for a
        // tampered package — and the official host must still be asked.
        let candidates = mirror::candidates(
            "https://github.com/acme/hello/releases/download/v1/acme.hello-1.0.0.oiplugin",
            &ide_core::settings::ToolDownloadSettings {
                github_mirror: "https://gh-proxy.com/".into(),
                ..Default::default()
            },
        );
        let asked: std::cell::RefCell<Vec<usize>> = std::cell::RefCell::new(Vec::new());
        let picked = try_sources(&candidates, |index, candidate| {
            asked.borrow_mut().push(index);
            match candidate.mirror.is_some() {
                true => Err(IdeError::invalid("the download does not match the marketplace's entry")),
                false => Ok("the official copy"),
            }
        });
        let (copy, index) = picked.unwrap();
        assert_eq!((copy, index), ("the official copy", 1));
        assert_eq!(*asked.borrow(), [0, 1], "the mirror was tried first, then the official host");

        // Both failing: the official host's error is the download's, with the mirror's folded in.
        let err = try_sources(&candidates, |index, candidate| -> IdeResult<&str> {
            match candidate.mirror.is_some() {
                true => Err(IdeError::invalid("the download does not match the marketplace's entry")),
                false => Err(IdeError::unavailable(format!("nothing at {index}"))),
            }
        })
        .unwrap_err();
        assert!(err.message.contains("https://gh-proxy.com/"), "{}", err.message);
        assert!(err.message.contains("nothing at 1"), "{}", err.message);
    }

    #[test]
    fn a_download_goes_to_the_mirror_first_and_the_official_host_last() {
        let url = "https://github.com/acme/hello/releases/download/v1/acme.hello-1.0.0.oiplugin";
        let through = mirror::candidates(
            url,
            &ide_core::settings::ToolDownloadSettings {
                github_mirror: "https://gh-proxy.com/".into(),
                ..Default::default()
            },
        );
        assert_eq!(through.len(), 2);
        assert_eq!(through[0].url, format!("https://gh-proxy.com/{url}"));
        assert!(through[0].mirror.is_some());
        assert_eq!((through[1].url.as_str(), through[1].mirror.is_none()), (url, true));

        // A local index's own package is not on GitHub: no prefix may carry it.
        let local = mirror::candidates(
            "/srv/market/a.oiplugin",
            &ide_core::settings::ToolDownloadSettings {
                github_mirror: "https://gh-proxy.com/".into(),
                ..Default::default()
            },
        );
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].url, "/srv/market/a.oiplugin");
    }

    #[test]
    fn a_failed_read_says_why() {
        // A port nothing listens on: refused.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/a.oiplugin");
        let err = read_url(&url, 1 << 20).unwrap_err();
        assert_eq!(err.matches(&url).count(), 1, "{err}");
        // The cause follows the URL. Its wording is the OS's, and localised: assert that it is
        // there rather than spelling out any one language's phrase for a refused connection.
        let cause = err.strip_prefix(&url).unwrap_or_default().trim_start_matches([':', ' ']);
        assert!(cause.len() > 1, "the failure says nothing beyond the URL: {err}");
    }

    #[test]
    fn a_server_that_stops_answering_does_not_hold_the_read() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/index.json", listener.local_addr().unwrap().port());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    line.clear();
                }
                // The headers, then nothing for longer than the read waits.
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n");
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        let err = read_remote(&url, MAX_INDEX, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("no answer in time"), "{err}");
    }
}
