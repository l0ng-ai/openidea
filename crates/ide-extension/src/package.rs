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
        let key: [u8; 32] = B64
            .decode(&self.key)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| "signature: malformed public key".to_owned())?;
        let key = VerifyingKey::from_bytes(&key).map_err(|_| "signature: invalid public key".to_owned())?;
        let sig: [u8; 64] = B64
            .decode(&self.signature)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| "signature: malformed".to_owned())?;
        key.verify_strict(&signed_message(id, version, digest), &Signature::from_bytes(&sig))
            .map_err(|_| "the signature does not match the package (it was changed after signing)".to_owned())
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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    /// Owns plugin ids `<id>.…`.
    pub id: String,
    pub name: String,
    pub keys: Vec<KeyEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    /// Ed25519 public key, base64.
    pub key: String,
    /// Packages signed with it are no longer trusted.
    #[serde(default)]
    pub revoked: bool,
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
    /// Empty: any.
    #[serde(default)]
    pub engine: String,
}

impl IndexEntry {
    /// Whether this IDE can load the version.
    pub fn compatible(&self) -> bool {
        self.engine.is_empty() || crate::engine_compatible(&self.engine, false)
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
    pub fn parse(text: &str) -> Result<Self, String> {
        let index: Index = serde_json::from_str(text).map_err(|e| format!("index: {e}"))?;
        if index.format != INDEX_FORMAT {
            return Err(format!("index format {} is not supported (this IDE reads {INDEX_FORMAT})", index.format));
        }
        Ok(index)
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
                keys: vec![KeyEntry { key: key.public_base64(), revoked: false }],
            }],
            plugins: Vec::new(),
            revoked: vec![Revocation {
                id: "acme.bad".into(),
                versions: vec!["1.0.0".into()],
                reason: "malware".into(),
            }],
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
            engine: String::new(),
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
            ("acme.c".to_owned(), "1.0.0".to_owned(), true),
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
        Publisher { id: id.into(), name: id.into(), keys: vec![KeyEntry { key: format!("{id}-key"), revoked: false }] }
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
        };
        let community = Index {
            format: INDEX_FORMAT,
            publishers: vec![publisher("alice")],
            plugins: vec![entry("alice.arthas", "alice")],
            revoked: vec![revocation("alice.bad")],
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
        };
        let cases = [
            (with(vec![publisher("openidea")], vec![], vec![]), "may not list"),
            (with(vec![publisher("alice"), publisher("alice")], vec![], vec![]), "listed twice"),
            (with(vec![publisher("openidea.x")], vec![], vec![]), "invalid publisher"),
            (with(vec![publisher("alice")], vec![entry("openidea.a", "alice")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![entry("alice.a", "bob")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![entry("alicex.a", "alice")], vec![]), "not a plugin of"),
            (with(vec![publisher("alice")], vec![], vec![revocation("openidea.a")]), "doesn't publish"),
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
        assert!(Index::parse(r#"{"format": 2}"#).is_err());
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
}
