//! Plugin distribution: the package file, its
//! signature, and the static marketplace index.
//!
//! - **Package** (`<id>-<version>.oiplugin`): a zip of the manifest, the files
//!   its declarations reference, the component and licence files, plus
//!   [`SIGNATURE_FILE`] when signed.
//! - **Signature**: Ed25519 over `openidea-plugin/1\n<id>\n<version>\n<digest>`,
//!   `digest` being [`package_digest`] of the unpacked files. A signature
//!   proves who published the bytes; whether to trust that publisher is the
//!   index's call.
//! - **Index** (`index.json`): the publishers and their keys (the trust root),
//!   the published plugin versions, and revocations. A publisher owns the id
//!   prefix `<publisher>.`; a revoked key invalidates everything it signed, a
//!   revoked plugin version is disabled where it is installed. A plugin may be
//!   listed in several versions, each with the plugin API it needs: the IDE
//!   offers the newest one it can load.
//! - **Key continuity**: an installed plugin updates silently only to a
//!   package signed with the same key, or with a key the installed one
//!   endorsed ([`Endorsement`], a publisher rotating keys); any other signer
//!   is the user's call. An IDE can pin a publisher to keys it was built with
//!   ([`Index::pin_publisher`]): the index then can't replace them.
//! - **Format**: fields are only ever added (IDEs ignore those they don't
//!   know); `format` grows only for changes older IDEs can't read, and they
//!   still apply such an index's revocations ([`Index::parse`]).

use crate::MANIFEST_FILE;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const SIGNATURE_FILE: &str = "SIGNATURE.json";
pub const PACKAGE_EXTENSION: &str = "oiplugin";
pub const INDEX_FORMAT: u32 = 1;
/// Limits when unpacking an untrusted package.
const MAX_ENTRIES: usize = 10_000;
const MAX_TOTAL: u64 = 512 << 20;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Content digest of a package: the manifest plus `files` (relative paths).
pub fn package_digest(dir: &Path, files: &[PathBuf]) -> std::io::Result<String> {
    let mut all = files.to_vec();
    all.push(PathBuf::from(MANIFEST_FILE));
    crate::ledger::package_hash(dir, &all)
}

fn signed_message(id: &str, version: &str, digest: &str) -> Vec<u8> {
    format!("openidea-plugin/1\n{id}\n{version}\n{digest}").into_bytes()
}

fn endorsement_message(publisher: &str, key: &str) -> Vec<u8> {
    format!("openidea-key/1\n{publisher}\n{key}").into_bytes()
}

/// Whether `signature` (base64) is `key`'s (base64) Ed25519 signature of
/// `message`; malformed keys and signatures are errors.
fn verify_ed25519(key: &str, message: &[u8], signature: &str) -> Result<bool, String> {
    let key: [u8; 32] = B64
        .decode(key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| "signature: malformed public key".to_owned())?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "signature: invalid public key".to_owned())?;
    let sig: [u8; 64] =
        B64.decode(signature).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| "signature: malformed".to_owned())?;
    Ok(key.verify_strict(message, &Signature::from_bytes(&sig)).is_ok())
}

/// `SIGNATURE.json` of a signed package.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignature {
    pub publisher: String,
    /// Ed25519 public key, base64.
    pub key: String,
    /// Ed25519 signature, base64.
    pub signature: String,
}

/// A publisher's key pair (the 32-byte seed, base64, in a file only the publisher has).
pub struct PublisherKey(SigningKey);

impl PublisherKey {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }

    /// The seed as written by `openidea-plugin keygen`.
    pub fn from_base64(text: &str) -> Result<Self, String> {
        let bytes = B64.decode(text.trim()).map_err(|e| format!("key file: {e}"))?;
        let seed: [u8; 32] = bytes.try_into().map_err(|_| "key file: expected a 32-byte key".to_owned())?;
        Ok(Self::from_seed(seed))
    }

    pub fn seed_base64(&self) -> String {
        B64.encode(self.0.to_bytes())
    }

    pub fn public_base64(&self) -> String {
        B64.encode(self.0.verifying_key().to_bytes())
    }

    /// Vouches for `publisher`'s new key `key` (base64), the one that follows this one.
    pub fn endorse(&self, publisher: &str, key: &str) -> Endorsement {
        let sig = self.0.sign(&endorsement_message(publisher, key));
        Endorsement { key: self.public_base64(), signature: B64.encode(sig.to_bytes()) }
    }

    pub fn sign(&self, publisher: &str, id: &str, version: &str, digest: &str) -> PackageSignature {
        let sig = self.0.sign(&signed_message(id, version, digest));
        PackageSignature {
            publisher: publisher.into(),
            key: self.public_base64(),
            signature: B64.encode(sig.to_bytes()),
        }
    }
}

impl PackageSignature {
    /// Whether the signature is valid for `id`, `version` and `digest` (the
    /// key's validity is checked against an [`Index`]).
    pub fn check(&self, id: &str, version: &str, digest: &str) -> Result<(), String> {
        if verify_ed25519(&self.key, &signed_message(id, version, digest), &self.signature)? {
            Ok(())
        } else {
            Err("the signature does not match the package (it was changed after signing)".to_owned())
        }
    }
}

/// Writes the package `out` from `dir`: the manifest, `files`, and the signature if any.
pub fn pack(dir: &Path, files: &[PathBuf], out: &Path, signature: Option<&PackageSignature>) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    let file = std::fs::File::create(out).map_err(io)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut names: Vec<PathBuf> = std::iter::once(PathBuf::from(MANIFEST_FILE)).chain(files.iter().cloned()).collect();
    names.sort();
    names.dedup();
    for rel in names {
        let name = rel.to_str().ok_or("non UTF-8 file name")?.replace('\\', "/");
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(dir.join(&rel)).map_err(|e| format!("{}: {e}", rel.display()))?;
        zip.write_all(&bytes).map_err(io)?;
    }
    if let Some(sig) = signature {
        zip.start_file(SIGNATURE_FILE, options).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string_pretty(sig).map_err(|e| e.to_string())?.as_bytes()).map_err(io)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// What [`unpack`] wrote.
#[derive(Debug)]
pub struct Unpacked {
    /// Every file but the manifest and the signature, relative.
    pub files: Vec<PathBuf>,
    pub signature: Option<PackageSignature>,
}

/// `name` as a relative path that stays inside the package.
fn safe_path(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    (!name.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))).then(|| p.to_path_buf())
}

/// Archiver metadata at the top of an archive, not part of a package
/// (`__MACOSX/…`, `.DS_Store`, AppleDouble `._…` files).
fn archiver_metadata(name: &str) -> bool {
    let top = name.split('/').next().unwrap_or_default();
    top == "__MACOSX" || top == ".DS_Store" || (top.starts_with("._") && top.len() > 2)
}

/// Where the package is inside an archive: at its root (`.oiplugin`, or a zip
/// of the package's contents) or in its only folder (a zip of the package
/// folder). `None` when neither holds a manifest.
fn package_prefix(names: &[String]) -> Option<String> {
    if names.iter().any(|n| n == MANIFEST_FILE) {
        return Some(String::new());
    }
    let mut tops = names.iter().filter(|n| !archiver_metadata(n)).map(|n| n.split('/').next().unwrap_or_default());
    let top = tops.next()?;
    if tops.any(|t| t != top) {
        return None;
    }
    let prefix = format!("{top}/");
    names.iter().any(|n| *n == format!("{prefix}{MANIFEST_FILE}")).then_some(prefix)
}

/// Extracts the package `archive` (an `.oiplugin`, or a `.zip` of a package
/// folder or of its contents) into the empty directory `dest`, refusing
/// paths leaving it, links, and oversized contents.
pub fn unpack(archive: &Path, dest: &Path) -> Result<Unpacked, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("{}: not a plugin package ({e})", archive.display()))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("more than {MAX_ENTRIES} files"));
    }
    let mut names = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if !entry.is_dir() {
            names.push(entry.name().map_err(|e| e.to_string())?.into_owned());
        }
    }
    // An IntelliJ plugin or any other zip: say what is missing rather than fail later.
    let prefix = package_prefix(&names).ok_or_else(|| {
        format!("{} is not an OpenIDEA plugin: no {MANIFEST_FILE} at its root or in its only folder", archive.display())
    })?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let (mut files, mut signature, mut total, mut manifest) = (Vec::new(), None, 0u64, false);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let full = entry.name().map_err(|e| e.to_string())?.into_owned();
        // Outside the package folder there is only archiver metadata (`package_prefix` checked).
        let Some(name) = full.strip_prefix(&prefix).map(str::to_owned) else { continue };
        if archiver_metadata(&name) {
            continue;
        }
        if entry.is_symlink() {
            return Err(format!("{full}: links are not allowed in packages"));
        }
        let rel = safe_path(&name).ok_or_else(|| format!("invalid path {full:?} in package"))?;
        let mut bytes = Vec::new();
        entry.by_ref().take(MAX_TOTAL - total + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        total += bytes.len() as u64;
        if total > MAX_TOTAL {
            return Err(format!("the package unpacks to more than {} MiB", MAX_TOTAL >> 20));
        }
        if rel == Path::new(SIGNATURE_FILE) {
            signature = Some(serde_json::from_slice(&bytes).map_err(|e| format!("{SIGNATURE_FILE}: {e}"))?);
            continue;
        }
        let to = dest.join(&rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&to, bytes).map_err(|e| e.to_string())?;
        if rel == Path::new(MANIFEST_FILE) {
            manifest = true;
        } else {
            files.push(rel);
        }
    }
    if !manifest {
        return Err(format!("the package has no {MANIFEST_FILE}"));
    }
    files.sort();
    Ok(Unpacked { files, signature })
}

// ---- index -------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub format: u32,
    #[serde(default)]
    pub publishers: Vec<Publisher>,
    #[serde(default)]
    pub plugins: Vec<IndexEntry>,
    #[serde(default)]
    pub revoked: Vec<Revocation>,
    /// The marketplace moved: its index is at this URL (relative to this
    /// one, or absolute), and the IDE reads that one instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    /// Owns plugin ids `<id>.…`.
    pub id: String,
    pub name: String,
    pub keys: Vec<KeyEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    /// Ed25519 public key, base64.
    pub key: String,
    /// Packages signed with it are no longer trusted.
    #[serde(default)]
    pub revoked: bool,
    /// The publisher's earlier key vouching for this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endorsement: Option<Endorsement>,
}

impl KeyEntry {
    pub fn new(key: String) -> Self {
        Self { key, ..Self::default() }
    }
}

/// A publisher's earlier key vouching for a newer one: plugins installed from
/// packages signed with the earlier key update to ones signed with the newer
/// key without asking the user.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Endorsement {
    /// The endorsing key, base64.
    pub key: String,
    /// Its Ed25519 signature of `openidea-key/1\n<publisher>\n<endorsed key>`, base64.
    pub signature: String,
}

/// A published plugin version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub publisher: String,
    /// The package, relative to the index (or an absolute URL).
    pub download: String,
    /// [`package_digest`] of its contents.
    pub digest: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The plugin API versions it loads in (a semver requirement): its
    /// manifest's `engines.openidea` and the API its component was built for.
    /// Required: an entry without one is offered to no IDE.
    #[serde(default)]
    pub engine: String,
    /// Marketplace categories (`CATEGORIES`); an IDE ignores those it doesn't know.
    #[serde(default)]
    pub categories: Vec<String>,
}

impl IndexEntry {
    /// Whether this IDE can load the version.
    pub fn compatible(&self) -> bool {
        crate::engine_compatible(&self.engine, false)
    }

    fn semver(&self) -> Option<semver::Version> {
        semver::Version::parse(&self.version).ok()
    }
}

/// `engines.openidea` of a manifest narrowed to the API its component was built
/// for (`major.minor`, if it has code): the requirement an index lists.
pub fn engine_requirement(manifest_engine: &str, built_for: Option<&semver::Version>) -> String {
    match built_for {
        Some(v) => format!("{manifest_engine}, ^{}.{}", v.major, v.minor),
        None => manifest_engine.to_owned(),
    }
}

/// A plugin (all versions when `versions` is empty) that must not run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub id: String,
    #[serde(default)]
    pub versions: Vec<String>,
    pub reason: String,
}

impl Index {
    /// Parses an index. One in a newer format keeps what must reach every IDE —
    /// revocations, publisher keys (revoked ones) and `moved` — and lists no
    /// plugins ([`Index::is_newer`]): the IDE needs updating to install from it.
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("index: {e}"))?;
        let format = value.get("format").and_then(serde_json::Value::as_u64).ok_or("index: `format` is missing")?;
        if format == u64::from(INDEX_FORMAT) {
            return serde_json::from_value(value).map_err(|e| format!("index: {e}"));
        }
        if format < u64::from(INDEX_FORMAT) {
            return Err(format!("index format {format} is not supported (this IDE reads {INDEX_FORMAT})"));
        }
        fn each<T: serde::de::DeserializeOwned>(value: &serde_json::Value, field: &str) -> Vec<T> {
            let items = value.get(field).and_then(serde_json::Value::as_array);
            items.into_iter().flatten().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect()
        }
        Ok(Index {
            format: u32::try_from(format).unwrap_or(u32::MAX),
            publishers: each(&value, "publishers"),
            plugins: Vec::new(),
            revoked: each(&value, "revoked"),
            moved: value.get("moved").and_then(serde_json::Value::as_str).map(str::to_owned),
        })
    }

    /// Written in a format newer than this IDE reads: it lists no plugins.
    pub fn is_newer(&self) -> bool {
        self.format > INDEX_FORMAT
    }

    /// The version of each plugin to offer, and whether this IDE can load it:
    /// the newest it can load, else the newest. Revoked versions are skipped;
    /// plugins come in the order they are first listed.
    pub fn offered(&self) -> Vec<(&IndexEntry, bool)> {
        let mut ids: Vec<&str> = Vec::new();
        for e in &self.plugins {
            if !ids.contains(&e.id.as_str()) {
                ids.push(&e.id);
            }
        }
        ids.into_iter()
            .filter_map(|id| {
                let versions: Vec<&IndexEntry> =
                    self.plugins.iter().filter(|e| e.id == id && self.revocation(id, &e.version).is_none()).collect();
                let newest = |loadable: bool| {
                    versions.iter().copied().filter(|e| !loadable || e.compatible()).max_by_key(|e| e.semver())
                };
                newest(true).map(|e| (e, true)).or_else(|| newest(false).map(|e| (e, false)))
            })
            .collect()
    }

    /// Drops the versions no IDE would pick: revoked ones, and of each plugin
    /// all but the newest version per API requirement.
    pub fn prune_versions(&mut self) {
        let plugins = std::mem::take(&mut self.plugins);
        let mut kept: Vec<IndexEntry> = Vec::new();
        for e in plugins.into_iter().filter(|e| self.revocation(&e.id, &e.version).is_none()) {
            match kept.iter_mut().find(|k| k.id == e.id && k.engine == e.engine) {
                Some(k) if e.semver() > k.semver() => *k = e,
                Some(_) => {}
                None => kept.push(e),
            }
        }
        self.plugins = kept;
    }

    /// The revocation that applies to `id` at `version`.
    pub fn revocation(&self, id: &str, version: &str) -> Option<&Revocation> {
        self.revoked.iter().find(|r| r.id == id && (r.versions.is_empty() || r.versions.iter().any(|v| v == version)))
    }

    /// Whether `key` (base64) belongs to a publisher and was revoked.
    pub fn key_revoked(&self, key: &str) -> bool {
        self.publishers.iter().flat_map(|p| &p.keys).any(|k| k.key == key && k.revoked)
    }

    /// The trusted publisher of a signed package: the signature is valid, its
    /// key is one of the publisher's and not revoked, and the publisher owns
    /// the plugin's id prefix.
    pub fn verify(&self, sig: &PackageSignature, id: &str, version: &str, digest: &str) -> Result<String, String> {
        let publisher = self
            .publishers
            .iter()
            .find(|p| p.id == sig.publisher)
            .ok_or_else(|| format!("unknown publisher {:?}", sig.publisher))?;
        let key = publisher
            .keys
            .iter()
            .find(|k| k.key == sig.key)
            .ok_or_else(|| format!("the key is not one of {}'s", publisher.name))?;
        if key.revoked {
            return Err(format!("{}'s signing key was revoked", publisher.name));
        }
        if !id.starts_with(&format!("{}.", publisher.id)) {
            return Err(format!("{} may only publish plugins named {}.*", publisher.name, publisher.id));
        }
        sig.check(id, version, digest)?;
        Ok(publisher.id.clone())
    }

    /// Whether `to` is `from`, or a key of `publisher` that `from` endorsed,
    /// directly or through keys it endorsed. Endorsements by revoked keys don't
    /// count: whoever stole a key could vouch for their own.
    pub fn succeeds(&self, publisher: &str, from: &str, to: &str) -> bool {
        let keys = self.publishers.iter().find(|p| p.id == publisher).map_or(&[][..], |p| &p.keys[..]);
        let mut key = to;
        // Each step moves to an earlier key; more steps than keys is a loop.
        for _ in 0..=keys.len() {
            if key == from {
                return true;
            }
            let Some(e) = keys.iter().find(|k| k.key == key).and_then(|k| k.endorsement.as_ref()) else {
                return false;
            };
            let endorser_valid = keys.iter().any(|k| k.key == e.key && !k.revoked);
            if !endorser_valid || verify_ed25519(&e.key, &endorsement_message(publisher, key), &e.signature) != Ok(true)
            {
                return false;
            }
            key = &e.key;
        }
        false
    }

    /// Makes `roots` (base64) the keys `publisher` signs with, whatever this
    /// index says: another key it lists stays only when a root endorsed it (a
    /// rotation the roots vouched for). Revocations of the keys are kept.
    pub fn pin_publisher(&mut self, publisher: &str, name: &str, roots: &[String]) {
        if roots.is_empty() {
            return;
        }
        let i = match self.publishers.iter().position(|p| p.id == publisher) {
            Some(i) => i,
            None => {
                self.publishers.push(Publisher { id: publisher.into(), name: name.into(), keys: Vec::new() });
                self.publishers.len() - 1
            }
        };
        for root in roots {
            if !self.publishers[i].keys.iter().any(|k| &k.key == root) {
                self.publishers[i].keys.push(KeyEntry::new(root.clone()));
            }
        }
        let keys = self.publishers[i].keys.clone();
        let trusted = keys
            .into_iter()
            .filter(|k| roots.iter().any(|r| self.succeeds(publisher, r, &k.key)))
            .map(|k| if roots.contains(&k.key) { KeyEntry { endorsement: None, ..k } } else { k })
            .collect();
        self.publishers[i].keys = trusted;
    }

    /// Replaces what this index lists for every publisher but `keep` with what
    /// `other` lists: its publishers, their plugins and their revocations
    /// (`other`'s downloads should already be absolute). `other` may only
    /// speak for its own publishers, and none of them may be in `keep`.
    pub fn include(&mut self, other: Index, keep: &[&str]) -> Result<(), String> {
        let mut theirs: Vec<&str> = Vec::new();
        for p in &other.publishers {
            if !publisher_id_ok(&p.id) {
                return Err(format!("invalid publisher id {:?}: use a-z, 0-9, '-' and '_'", p.id));
            }
            if keep.contains(&p.id.as_str()) {
                return Err(format!("may not list publisher {:?}", p.id));
            }
            if theirs.contains(&p.id.as_str()) {
                return Err(format!("publisher {:?} is listed twice", p.id));
            }
            theirs.push(&p.id);
        }
        let owned_by = |id: &str| theirs.iter().any(|p| owns(p, id));
        for e in &other.plugins {
            if !theirs.contains(&e.publisher.as_str()) || !owns(&e.publisher, &e.id) {
                return Err(format!("{}: not a plugin of publisher {:?}", e.id, e.publisher));
            }
            if semver::VersionReq::parse(&e.engine).is_err() {
                return Err(format!("{} {}: `engine` must be the plugin API it needs", e.id, e.version));
            }
        }
        if let Some(r) = other.revoked.iter().find(|r| !owned_by(&r.id)) {
            return Err(format!("{}: revoked by an index that doesn't publish it", r.id));
        }
        let kept = |id: &str| keep.iter().any(|p| owns(p, id));
        self.publishers.retain(|p| keep.contains(&p.id.as_str()));
        self.plugins.retain(|e| keep.contains(&e.publisher.as_str()));
        self.revoked.retain(|r| kept(&r.id));
        self.publishers.extend(other.publishers);
        self.plugins.extend(other.plugins);
        self.revoked.extend(other.revoked);
        Ok(())
    }
}

/// Whether a package signed `new` (`None`: unsigned) may replace an installed
/// one signed `installed` without asking the user: signed with the same key,
/// or with one the installed key endorsed (per `index`). An unsigned installed
/// copy pins nothing.
pub fn signer_continues(
    index: Option<&Index>,
    installed: Option<&PackageSignature>,
    new: Option<&PackageSignature>,
) -> bool {
    match (installed, new) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(old), Some(new)) => {
            old.publisher == new.publisher
                && (old.key == new.key || index.is_some_and(|i| i.succeeds(&new.publisher, &old.key, &new.key)))
        }
    }
}

/// Whether the plugin `id` is in `publisher`'s namespace.
fn owns(publisher: &str, id: &str) -> bool {
    id.strip_prefix(publisher).is_some_and(|rest| rest.starts_with('.'))
}

/// A publisher id is a single segment of a plugin id.
pub fn publisher_id_ok(id: &str) -> bool {
    !id.contains('.') && crate::validate_plugin_id(id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(dir: &Path) -> Vec<PathBuf> {
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), "id = \"acme.tools\"\nversion = \"1.0.0\"").unwrap();
        std::fs::write(dir.join("dist/plugin.wasm"), b"\0asm").unwrap();
        vec![PathBuf::from("dist/plugin.wasm")]
    }

    fn index(key: &PublisherKey) -> Index {
        Index {
            format: INDEX_FORMAT,
            publishers: vec![Publisher {
                id: "acme".into(),
                name: "ACME".into(),
                keys: vec![KeyEntry::new(key.public_base64())],
            }],
            plugins: Vec::new(),
            revoked: vec![Revocation {
                id: "acme.bad".into(),
                versions: vec!["1.0.0".into()],
                reason: "malware".into(),
            }],
            moved: None,
        }
    }

    #[test]
    fn signed_packages_round_trip_and_tampering_is_caught() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let files = package(&src);
        let digest = package_digest(&src, &files).unwrap();
        let key = PublisherKey::from_seed([7; 32]);
        let sig = key.sign("acme", "acme.tools", "1.0.0", &digest);
        let out = tmp.path().join("acme.tools-1.0.0.oiplugin");
        pack(&src, &files, &out, Some(&sig)).unwrap();

        let dest = tmp.path().join("dest");
        let unpacked = unpack(&out, &dest).unwrap();
        assert_eq!(unpacked.files, files);
        assert_eq!(package_digest(&dest, &unpacked.files).unwrap(), digest);
        let index = index(&key);
        assert_eq!(index.verify(unpacked.signature.as_ref().unwrap(), "acme.tools", "1.0.0", &digest).unwrap(), "acme");

        // Changed bytes, another id, someone else's prefix, a revoked key.
        assert!(index.verify(&sig, "acme.tools", "1.0.0", "0000").is_err());
        assert!(index.verify(&sig, "acme.tools", "1.0.1", &digest).is_err());
        let other = PublisherKey::from_seed([9; 32]).sign("acme", "acme.tools", "1.0.0", &digest);
        assert!(index.verify(&other, "acme.tools", "1.0.0", &digest).unwrap_err().contains("not one of"));
        let foreign = key.sign("acme", "evil.tools", "1.0.0", &digest);
        assert!(index.verify(&foreign, "evil.tools", "1.0.0", &digest).unwrap_err().contains("acme.*"));
        let mut revoked = index.clone();
        revoked.publishers[0].keys[0].revoked = true;
        assert!(revoked.verify(&sig, "acme.tools", "1.0.0", &digest).unwrap_err().contains("revoked"));
        assert!(revoked.key_revoked(&sig.key));
        assert_eq!(index.revocation("acme.bad", "1.0.0").unwrap().reason, "malware");
        assert!(index.revocation("acme.bad", "1.0.1").is_none());
        assert_eq!(PublisherKey::from_base64(&key.seed_base64()).unwrap().public_base64(), key.public_base64());
    }

    fn entry(id: &str, publisher: &str) -> IndexEntry {
        IndexEntry {
            id: id.into(),
            name: id.into(),
            version: "1.0.0".into(),
            description: String::new(),
            authors: Vec::new(),
            publisher: publisher.into(),
            download: format!("https://example.com/{id}.oiplugin"),
            digest: "d".into(),
            capabilities: Vec::new(),
            engine: "^1.0".into(),
            categories: Vec::new(),
        }
    }

    fn version(id: &str, version: &str, engine: &str) -> IndexEntry {
        IndexEntry { version: version.into(), engine: engine.into(), ..entry(id, "acme") }
    }

    #[test]
    fn the_ide_is_offered_the_newest_version_it_can_load() {
        let host = crate::ENGINE_VERSION;
        let newer = semver::Version::parse(host).unwrap().major + 1;
        let mut index = Index {
            format: INDEX_FORMAT,
            plugins: vec![
                version("acme.a", "1.0.0", &format!("^{host}")),
                version("acme.a", "1.2.0", &format!("^{host}")),
                version("acme.a", "2.0.0", &format!("^{newer}.0")),
                version("acme.b", "0.1.0", &format!("^{newer}.0")),
                version("acme.b", "0.2.0", &format!("^{newer}.1")),
                version("acme.c", "1.0.0", ""),
                version("acme.c", "1.1.0", ""),
            ],
            revoked: vec![Revocation { id: "acme.c".into(), versions: vec!["1.1.0".into()], reason: "r".into() }],
            ..Index::default()
        };
        let offered = |index: &Index| {
            index.offered().into_iter().map(|(e, ok)| (e.id.clone(), e.version.clone(), ok)).collect::<Vec<_>>()
        };
        let expected = [
            ("acme.a".to_owned(), "1.2.0".to_owned(), true),
            ("acme.b".to_owned(), "0.2.0".to_owned(), false),
            // No `engine`: listed, but no IDE installs it.
            ("acme.c".to_owned(), "1.0.0".to_owned(), false),
        ];
        assert_eq!(offered(&index), expected);

        // Pruning keeps the newest version per requirement, which changes nothing offered.
        index.prune_versions();
        let left: Vec<_> = index.plugins.iter().map(|e| format!("{} {}", e.id, e.version)).collect();
        assert_eq!(left, ["acme.a 1.2.0", "acme.a 2.0.0", "acme.b 0.1.0", "acme.b 0.2.0", "acme.c 1.0.0"]);
        assert_eq!(offered(&index), expected);

        let built_for = semver::Version::new(1, 3, 0);
        assert_eq!(engine_requirement("^1.0", Some(&built_for)), "^1.0, ^1.3");
        assert_eq!(engine_requirement("^1.0", None), "^1.0");
        assert!(semver::VersionReq::parse(&engine_requirement("^1.0", Some(&built_for))).is_ok());
    }

    fn publisher(id: &str) -> Publisher {
        Publisher { id: id.into(), name: id.into(), keys: vec![KeyEntry::new(format!("{id}-key"))] }
    }

    fn revocation(id: &str) -> Revocation {
        Revocation { id: id.into(), versions: Vec::new(), reason: "r".into() }
    }

    #[test]
    fn including_an_index_replaces_everything_but_the_kept_publishers() {
        let mut official = Index {
            format: INDEX_FORMAT,
            publishers: vec![publisher("openidea"), publisher("gone")],
            plugins: vec![entry("openidea.a", "openidea"), entry("gone.x", "gone")],
            revoked: vec![revocation("openidea.old"), revocation("gone.x")],
            moved: None,
        };
        let community = Index {
            format: INDEX_FORMAT,
            publishers: vec![publisher("alice")],
            plugins: vec![entry("alice.arthas", "alice")],
            revoked: vec![revocation("alice.bad")],
            moved: None,
        };
        official.include(community.clone(), &["openidea"]).unwrap();
        let ids = |v: &[IndexEntry]| v.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        assert_eq!(official.publishers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["openidea", "alice"]);
        assert_eq!(ids(&official.plugins), ["openidea.a", "alice.arthas"]);
        assert_eq!(official.revoked.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["openidea.old", "alice.bad"]);

        // Including again is idempotent.
        let once = official.clone();
        official.include(community.clone(), &["openidea"]).unwrap();
        assert_eq!(official, once);
    }

    #[test]
    fn an_included_index_speaks_only_for_its_own_publishers() {
        let base = Index { format: INDEX_FORMAT, publishers: vec![publisher("openidea")], ..Index::default() };
        let with = |publishers: Vec<Publisher>, plugins: Vec<IndexEntry>, revoked: Vec<Revocation>| Index {
            format: INDEX_FORMAT,
            publishers,
            plugins,
            revoked,
            moved: None,
        };
        let cases = [
            (with(vec![publisher("openidea")], vec![], vec![]), "may not list"),
            (with(vec![publisher("alice"), publisher("alice")], vec![], vec![]), "listed twice"),
            (with(vec![publisher("openidea.x")], vec![], vec![]), "invalid publisher"),
            (with(vec![publisher("alice")], vec![entry("openidea.a", "alice")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![entry("alice.a", "bob")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![entry("alicex.a", "alice")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![], vec![revocation("openidea.a")]), "doesn't publish"),
            (
                with(
                    vec![publisher("alice")],
                    vec![IndexEntry { engine: String::new(), ..entry("alice.a", "alice") }],
                    vec![],
                ),
                "`engine`",
            ),
        ];
        for (other, error) in cases {
            let mut index = base.clone();
            let err = index.include(other, &["openidea"]).unwrap_err();
            assert!(err.contains(error), "{err}");
            assert_eq!(index, base);
        }
    }

    #[test]
    fn unpacking_refuses_paths_leaving_the_package() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("evil.oiplugin");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&out).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        zip.start_file(MANIFEST_FILE, o).unwrap();
        zip.write_all(b"id = \"x\"").unwrap();
        zip.start_file("../outside.txt", o).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        let err = unpack(&out, &tmp.path().join("dest")).unwrap_err();
        assert!(err.contains("invalid path"), "{err}");
        assert!(!tmp.path().join("outside.txt").exists());
        assert!(Index::parse(r#"{"format": 2}"#).unwrap().is_newer());
    }

    fn zip_of(path: &Path, entries: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn a_zip_holds_the_package_at_its_root_or_in_its_only_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = "id = \"acme.tools\"";
        let at_root = tmp.path().join("root.zip");
        zip_of(&at_root, &[(MANIFEST_FILE, manifest), ("dist/plugin.wasm", "w"), (".DS_Store", "x")]);
        let got = unpack(&at_root, &tmp.path().join("a")).unwrap();
        assert_eq!(got.files, [PathBuf::from("dist/plugin.wasm")]);

        // What zipping the folder in Finder makes: the folder plus `__MACOSX`.
        let folder = tmp.path().join("folder.zip");
        zip_of(
            &folder,
            &[
                ("acme-tools/plugin.toml", manifest),
                ("acme-tools/dist/plugin.wasm", "w"),
                ("__MACOSX/acme-tools/._plugin.toml", "x"),
            ],
        );
        let dest = tmp.path().join("b");
        let got = unpack(&folder, &dest).unwrap();
        assert_eq!(got.files, [PathBuf::from("dist/plugin.wasm")]);
        assert!(dest.join(MANIFEST_FILE).is_file());
        assert!(!dest.join("__MACOSX").exists() && !dest.join("acme-tools").exists());

        // Two folders, a manifest one level too deep, or none (an IntelliJ plugin): not a package.
        for (name, entries) in [
            ("two.zip", &[("a/plugin.toml", manifest), ("b/x.txt", "x")][..]),
            ("deep.zip", &[("a/b/plugin.toml", manifest)][..]),
            ("intellij.zip", &[("my-plugin/lib/my-plugin.jar", "jar")][..]),
        ] {
            let path = tmp.path().join(name);
            zip_of(&path, entries);
            let err = unpack(&path, &tmp.path().join(name).with_extension("out")).unwrap_err();
            assert!(err.contains("is not an OpenIDEA plugin"), "{name}: {err}");
        }
    }

    #[test]
    fn a_newer_index_still_revokes_and_moves() {
        let newer = format!(
            r#"{{"format": {}, "plugins": [{{"anything": "new"}}], "shape": "changed",
                "publishers": [{{"id": "acme", "name": "ACME", "keys": [{{"key": "k1", "revoked": true}}]}}, {{"id": 5}}],
                "revoked": [{{"id": "acme.bad", "reason": "malware"}}, {{"oops": 1}}],
                "moved": "https://example.com/next.json"}}"#,
            INDEX_FORMAT + 1
        );
        let index = Index::parse(&newer).unwrap();
        assert!(index.is_newer());
        assert!(index.plugins.is_empty() && index.offered().is_empty());
        assert_eq!(index.revocation("acme.bad", "2.0.0").unwrap().reason, "malware");
        assert!(index.key_revoked("k1"));
        assert_eq!(index.moved.as_deref(), Some("https://example.com/next.json"));
        // Fields this IDE doesn't know are ignored in its own format.
        let current = format!(r#"{{"format": {INDEX_FORMAT}, "later": true, "plugins": []}}"#);
        assert!(!Index::parse(&current).unwrap().is_newer());
        assert!(Index::parse(r#"{"format": 0}"#).unwrap_err().contains("not supported"));
        assert!(Index::parse(r#"{"plugins": []}"#).is_err());
    }

    fn keys<'a>(index: &'a mut Index, publisher: &str) -> &'a mut Vec<KeyEntry> {
        &mut index.publishers.iter_mut().find(|p| p.id == publisher).unwrap().keys
    }

    #[test]
    fn rotated_keys_continue_through_endorsements() {
        let (k1, k2, k3) =
            (PublisherKey::from_seed([1; 32]), PublisherKey::from_seed([2; 32]), PublisherKey::from_seed([3; 32]));
        let mut index = index(&k1);
        let endorsed = |by: &PublisherKey, key: &PublisherKey| KeyEntry {
            endorsement: Some(by.endorse("acme", &key.public_base64())),
            ..KeyEntry::new(key.public_base64())
        };
        keys(&mut index, "acme").push(endorsed(&k1, &k2));
        keys(&mut index, "acme").push(endorsed(&k2, &k3));
        let (p1, p2, p3) = (k1.public_base64(), k2.public_base64(), k3.public_base64());
        assert!(index.succeeds("acme", &p1, &p1));
        assert!(index.succeeds("acme", &p1, &p3), "through k2");
        assert!(!index.succeeds("acme", &p3, &p1), "not backwards");
        assert!(!index.succeeds("other", &p1, &p2));
        // An endorsement for another publisher, or by a revoked key, doesn't count.
        let mut foreign = index.clone();
        keys(&mut foreign, "acme")[1].endorsement = Some(k1.endorse("evil", &p2));
        assert!(!foreign.succeeds("acme", &p1, &p2));
        let mut stolen = index.clone();
        keys(&mut stolen, "acme")[0].revoked = true;
        assert!(!stolen.succeeds("acme", &p1, &p2));

        let sig = |key: &PublisherKey| key.sign("acme", "acme.tools", "1.0.0", "d");
        assert!(signer_continues(Some(&index), Some(&sig(&k1)), Some(&sig(&k3))));
        assert!(signer_continues(None, Some(&sig(&k1)), Some(&sig(&k1))));
        assert!(!signer_continues(None, Some(&sig(&k1)), Some(&sig(&k2))), "no index to vouch");
        let stranger = PublisherKey::from_seed([4; 32]);
        assert!(!signer_continues(Some(&index), Some(&sig(&k1)), Some(&sig(&stranger))));
        assert!(!signer_continues(Some(&index), Some(&sig(&k1)), None), "signed, then unsigned");
        assert!(signer_continues(Some(&index), None, Some(&sig(&stranger))), "unsigned pins nothing");
    }

    #[test]
    fn pinned_publishers_keep_their_built_in_keys() {
        let (root, next, intruder) =
            (PublisherKey::from_seed([1; 32]), PublisherKey::from_seed([2; 32]), PublisherKey::from_seed([5; 32]));
        let mut index = index(&intruder);
        index.publishers[0].id = "openidea".into();
        keys(&mut index, "openidea").push(KeyEntry {
            endorsement: Some(root.endorse("openidea", &next.public_base64())),
            ..KeyEntry::new(next.public_base64())
        });
        let roots = [root.public_base64()];
        let listed = |index: &Index| -> Vec<(String, bool)> {
            let mut index = index.clone();
            index.pin_publisher("openidea", "OpenIDEA", &roots);
            keys(&mut index, "openidea").iter().map(|k| (k.key.clone(), k.revoked)).collect()
        };
        // The intruder's key goes, the successor the root endorsed stays, the root is added.
        assert_eq!(listed(&index), [(next.public_base64(), false), (root.public_base64(), false)]);
        let mut pinned = index.clone();
        pinned.pin_publisher("openidea", "OpenIDEA", &roots);
        let digest = "d";
        let signed = |k: &PublisherKey| k.sign("openidea", "openidea.tools", "1.0.0", digest);
        assert!(pinned.verify(&signed(&intruder), "openidea.tools", "1.0.0", digest).is_err());
        assert!(pinned.verify(&signed(&next), "openidea.tools", "1.0.0", digest).is_ok());
        // A revoked root stays revoked, and what it endorsed is no longer trusted.
        keys(&mut index, "openidea").push(KeyEntry { revoked: true, ..KeyEntry::new(root.public_base64()) });
        assert_eq!(listed(&index), [(root.public_base64(), true)]);

        // A publisher missing from the index is added with its roots.
        let mut empty = Index { format: INDEX_FORMAT, ..Index::default() };
        empty.pin_publisher("openidea", "OpenIDEA", &[root.public_base64()]);
        assert_eq!(empty.verify(&signed(&root), "openidea.tools", "1.0.0", digest).unwrap(), "openidea");
        // No roots: the index decides.
        let mut open = index.clone();
        open.pin_publisher("openidea", "OpenIDEA", &[]);
        assert_eq!(open, index);
    }
}
