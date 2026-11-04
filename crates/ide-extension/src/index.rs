//! The contribution index: validated UI
//! declarations of installed packages, kept on disk so start-up does not
//! validate them again (sanitising thousands of icon SVGs, say).
//!
//! Only packages with a [`Package::digest`] are indexed: installed copies,
//! which the host never modifies after install. An entry is keyed by that
//! digest, the extension point, the declaration and a salt naming the
//! validation logic (the IDE version), so a new package version, a changed
//! declaration or an IDE upgrade simply misses. A miss or an unreadable entry
//! only costs the validation.

use crate::point::Package;
use crate::ui::UiDecl;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Bumped when [`UiDecl`]'s serialized shape changes.
const FORMAT: u32 = 1;

pub struct ContributionIndex {
    dir: PathBuf,
    salt: String,
}

impl ContributionIndex {
    /// `salt` names the validators' version (the IDE version).
    pub fn new(dir: PathBuf, salt: &str) -> Self {
        Self { dir, salt: format!("{FORMAT}:{salt}") }
    }

    /// Entries start with a prefix of the package digest, for pruning.
    fn file(&self, digest: &str, point: &str, decl: &toml::Value) -> PathBuf {
        let mut h = blake3::Hasher::new();
        for part in [self.salt.as_str(), digest, point, &decl.to_string()] {
            h.update(part.as_bytes());
            h.update(&[0]);
        }
        let key = h.finalize().to_hex();
        self.dir.join(format!("{}-{}.json", prefix(digest), &key[..32]))
    }

    pub fn get(&self, pkg: &Package, point: &str, decl: &toml::Value) -> Option<UiDecl> {
        let digest = pkg.digest.as_deref()?;
        let bytes = std::fs::read(self.file(digest, point, decl)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn put(&self, pkg: &Package, point: &str, decl: &toml::Value, ui: &UiDecl) {
        let Some(digest) = pkg.digest.as_deref() else { return };
        let Ok(bytes) = serde_json::to_vec(ui) else { return };
        let file = self.file(digest, point, decl);
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = file.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &file)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Removes entries of packages other than `live` (digests).
    pub fn prune<'a>(&self, live: impl IntoIterator<Item = &'a str>) {
        let keep: BTreeSet<String> = live.into_iter().map(|d| prefix(d).to_owned()).collect();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.split_once('-').is_some_and(|(p, _)| keep.contains(p)) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn prefix(digest: &str) -> &str {
    let d = digest.strip_prefix("blake3:").unwrap_or(digest);
    let end = d.char_indices().nth(16).map_or(d.len(), |(i, _)| i);
    &d[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;

    #[test]
    fn hits_only_the_same_package_point_declaration_and_salt() {
        let tmp = tempfile::tempdir().unwrap();
        let index = ContributionIndex::new(tmp.path().join("idx"), "1.0");
        let manifest =
            Manifest::parse("id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n").unwrap();
        let pkg = Package::new(manifest, tmp.path().to_path_buf()).with_digest("blake3:00aa11bb22cc33dd44ee");
        let decl: toml::Value = toml::from_str("id = \"x\"").unwrap();
        let ui = UiDecl::new("x", "X", serde_json::json!({ "id": "x" }));
        assert!(index.get(&pkg, "pt", &decl).is_none());
        index.put(&pkg, "pt", &decl, &ui);
        assert_eq!(index.get(&pkg, "pt", &decl).unwrap().label, "X");
        assert!(index.get(&pkg, "other", &decl).is_none());
        assert!(index.get(&pkg, "pt", &toml::from_str("id = \"y\"").unwrap()).is_none());
        assert!(ContributionIndex::new(tmp.path().join("idx"), "1.1").get(&pkg, "pt", &decl).is_none());
        let unhashed = Package { digest: None, ..pkg.clone() };
        assert!(index.get(&unhashed, "pt", &decl).is_none(), "not an installed copy");

        index.prune(["blake3:ffff"]);
        assert!(index.get(&pkg, "pt", &decl).is_none());
    }
}
