//! Copying a package into the plugins directory without ever leaving the
//! plugin missing. Installed plugins are versioned:
//! `<plugins>/<id>/<version>/` plus an `active` pointer file (and `previous`,
//! the version to roll back to). A new version is written to a staging
//! directory, renamed into place, and only then made active by replacing the
//! pointer; a swap interrupted by a crash is undone on the next start
//! ([`recover`]). Older installs used `<plugins>/<id>/` directly; they are
//! moved into the versioned layout on their next update.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Top-level files copied with a package besides those its declarations reference.
pub const LICENSE_FILES: &[&str] =
    &["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md", "NOTICE.txt", "COPYING", "README.md"];
/// Written into an installed package: the package hash the grant ledger compares.
pub const HASH_FILE: &str = ".package-hash";

const STAGING: &str = ".staging-";
const OLD: &str = ".old-";
/// `<root>/active`: the version in use.
pub const ACTIVE_FILE: &str = "active";
/// `<root>/previous`: the version an update replaced (for rollback).
pub const PREVIOUS_FILE: &str = "previous";

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct PendingUninstall {
    pub id: String,
    pub name: String,
    pub version: String,
    pub flat: bool,
    pub secrets: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

impl PendingUninstall {
    fn validate(&self) -> io::Result<()> {
        if self.id.is_empty()
            || self.id.starts_with('.')
            || Path::new(&self.id).components().count() != 1
            || !matches!(Path::new(&self.id).components().next(), Some(std::path::Component::Normal(_)))
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        version_dir(&self.version)?;
        Ok(())
    }

    pub(super) fn package_dir(&self, root: &Path) -> PathBuf {
        let dir = root.join(&self.id);
        if self.flat { dir } else { dir.join(&self.version) }
    }
}

pub(super) fn check_not_symlink(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if meta.file_type().is_symlink() || reparse {
                Err(io::Error::other("refusing symlink in plugin cleanup path"))
            } else {
                Ok(())
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub(super) fn check_cleanup_parent(root: &Path, path: &Path) -> io::Result<()> {
    let relative = path.strip_prefix(root).map_err(io::Error::other)?;
    let mut parent = root.to_path_buf();
    for part in relative.parent().unwrap_or(Path::new("")).components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(io::Error::other("invalid plugin cleanup path"));
        }
        parent.push(part);
        check_not_symlink(&parent)?;
    }
    Ok(())
}

fn uninstall_file(root: &Path, id: &str) -> PathBuf {
    root.join(".uninstall").join(format!("{id}.json"))
}

pub(super) fn remember_uninstall(root: &Path, pending: &PendingUninstall, dir: &Path) -> io::Result<()> {
    use std::io::Write;
    pending.validate()?;
    if pending.package_dir(root) != dir {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let file = uninstall_file(root, &pending.id);
    check_not_symlink(file.parent().unwrap())?;
    std::fs::create_dir_all(file.parent().unwrap())?;
    check_not_symlink(&file)?;
    let mut out = tempfile::NamedTempFile::new_in(file.parent().unwrap())?;
    out.write_all(&serde_json::to_vec(pending)?)?;
    out.as_file().sync_all()?;
    out.persist(file).map(|_| ()).map_err(|e| e.error)
}

pub(super) fn pending_uninstalls(root: &Path) -> Vec<PendingUninstall> {
    if check_not_symlink(&root.join(".uninstall")).is_err() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root.join(".uninstall")) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                return None;
            }
            let read = || -> io::Result<PendingUninstall> {
                check_not_symlink(&path)?;
                let pending: PendingUninstall = serde_json::from_slice(&std::fs::read(&path)?)?;
                pending.validate()?;
                if path != uninstall_file(root, &pending.id) {
                    return Err(io::Error::from(io::ErrorKind::InvalidData));
                }
                Ok(pending)
            };
            match read() {
                Ok(pending) => Some(pending),
                Err(e) => {
                    tracing::warn!(path = %path.display(), "cannot recover pending plugin uninstall: {e}");
                    None
                }
            }
        })
        .collect()
}

pub(super) fn uninstall_pending(root: &Path, id: &str) -> io::Result<bool> {
    uninstall_file(root, id).try_exists()
}

pub(super) fn forget_uninstall(root: &Path, id: &str) -> io::Result<()> {
    check_not_symlink(&root.join(".uninstall"))?;
    match std::fs::remove_file(uninstall_file(root, id)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn nonce() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    format!("{n:x}-{}", std::process::id())
}

/// Copies `files` (plus manifest and licence files) from `src` into `target`
/// atomically, recording `hash`.
pub fn install_package(src: &Path, target: &Path, files: &[PathBuf], hash: &str) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| io::Error::other("plugin target has no parent"))?;
    let name = target.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::other("bad target"))?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!("{STAGING}{name}-{}", nonce()));
    let result = (|| {
        std::fs::create_dir_all(&staging)?;
        std::fs::copy(src.join(ide_extension::MANIFEST_FILE), staging.join(ide_extension::MANIFEST_FILE))?;
        for file in files {
            let to = staging.join(file);
            if let Some(dir) = to.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::copy(src.join(file), to)?;
        }
        for lic in LICENSE_FILES {
            if src.join(lic).is_file() {
                std::fs::copy(src.join(lic), staging.join(lic))?;
            }
        }
        std::fs::write(staging.join(HASH_FILE), hash)?;
        swap(&staging, target, |from, to| std::fs::rename(from, to))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// A version as a directory name (semver: `[0-9A-Za-z.+-]`).
fn version_dir(version: &str) -> io::Result<&str> {
    let ok = !version.is_empty()
        && version.len() <= 64
        && !version.starts_with('.')
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'));
    if ok { Ok(version) } else { Err(io::Error::other(format!("version {version:?} cannot name a directory"))) }
}

fn read_pointer(root: &Path, name: &str) -> Option<String> {
    let v = std::fs::read_to_string(root.join(name)).ok()?;
    let v = v.trim();
    (!v.is_empty() && version_dir(v).is_ok()).then(|| v.to_owned())
}

/// Replaces the pointer file `name` atomically.
fn write_pointer(root: &Path, name: &str, version: &str) -> io::Result<()> {
    let tmp = root.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, version)?;
    std::fs::rename(&tmp, root.join(name))
}

/// The directory of a plugin's active version under its `root`
/// (`<plugins>/<id>`): `<root>/<active>`, or `root` itself in the flat layout.
pub fn active_dir(root: &Path) -> Option<PathBuf> {
    if let Some(v) = read_pointer(root, ACTIVE_FILE) {
        let dir = root.join(v);
        return dir.join(ide_extension::MANIFEST_FILE).is_file().then_some(dir);
    }
    root.join(ide_extension::MANIFEST_FILE).is_file().then(|| root.to_path_buf())
}

/// The version an update replaced, if it is still there.
pub fn previous_version(root: &Path) -> Option<String> {
    read_pointer(root, PREVIOUS_FILE).filter(|v| root.join(v).join(ide_extension::MANIFEST_FILE).is_file())
}

/// Moves a flat install (`<root>/plugin.toml`) to `<root>/<version>/`.
fn migrate_flat(root: &Path, version_of: impl Fn(&Path) -> Option<String>) -> io::Result<()> {
    if read_pointer(root, ACTIVE_FILE).is_some() || !root.join(ide_extension::MANIFEST_FILE).is_file() {
        return Ok(());
    }
    let version = version_of(root).unwrap_or_else(|| "0.0.0".into());
    let version = version_dir(&version).map(str::to_owned).unwrap_or_else(|_| "0.0.0".into());
    let parent = root.parent().unwrap_or(Path::new("."));
    let name = root.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::other("bad plugin directory"))?;
    // `.old-<name>-…` is restored by `recover` if this is interrupted.
    let old = parent.join(format!("{OLD}{name}-{}", nonce()));
    std::fs::rename(root, &old)?;
    std::fs::create_dir_all(root)?;
    std::fs::rename(&old, root.join(&version))?;
    write_pointer(root, ACTIVE_FILE, &version)
}

/// Installs `files` of `src` as `<root>/<version>` and makes it the active
/// version. Returns the version it replaced (now `previous`).
pub fn install_version(
    src: &Path,
    root: &Path,
    version: &str,
    files: &[PathBuf],
    hash: &str,
    version_of: impl Fn(&Path) -> Option<String>,
) -> io::Result<Option<String>> {
    let version = version_dir(version)?;
    std::fs::create_dir_all(root)?;
    migrate_flat(root, version_of)?;
    install_package(src, &root.join(version), files, hash)?;
    let previous = read_pointer(root, ACTIVE_FILE).filter(|v| v != version);
    if let Some(p) = &previous {
        write_pointer(root, PREVIOUS_FILE, p)?;
    }
    write_pointer(root, ACTIVE_FILE, version)?;
    Ok(previous)
}

/// Makes `version` active again (rollback). The replaced version stays until [`prune`].
pub fn activate_version(root: &Path, version: &str) -> io::Result<()> {
    let version = version_dir(version)?;
    if !root.join(version).join(ide_extension::MANIFEST_FILE).is_file() {
        return Err(io::Error::other(format!("version {version} is not installed")));
    }
    let _ = std::fs::remove_file(root.join(PREVIOUS_FILE));
    write_pointer(root, ACTIVE_FILE, version)
}

/// Removes versions other than the active and the previous one.
pub fn prune(root: &Path) {
    let keep: Vec<String> = [ACTIVE_FILE, PREVIOUS_FILE].iter().filter_map(|f| read_pointer(root, f)).collect();
    if keep.is_empty() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if path.is_dir() && !keep.contains(&name) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Moves `staging` to `target`, keeping the old `target` until the new one is in place.
fn swap(staging: &Path, target: &Path, rename: impl Fn(&Path, &Path) -> io::Result<()>) -> io::Result<()> {
    if !target.exists() {
        return rename(staging, target);
    }
    let parent = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("plugin");
    let old = parent.join(format!("{OLD}{name}-{}", nonce()));
    rename(target, &old)?;
    if let Err(e) = rename(staging, target) {
        // Put the previous version back.
        rename(&old, target)?;
        return Err(e);
    }
    if let Err(e) = std::fs::remove_dir_all(&old) {
        tracing::warn!("removing the previous version {}: {e}", old.display());
    }
    Ok(())
}

/// Undoes interrupted installs in `dir`: restores `.old-<name>-*` when
/// `<name>` is missing, and removes leftover staging and old directories.
pub fn recover(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // Inside a versioned plugin: staging and old versions of a version swap.
        if path.is_dir() && read_pointer(&path, ACTIVE_FILE).is_some() {
            recover(&path);
            continue;
        }
        let Some(file) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        if file.starts_with(STAGING) {
            let _ = std::fs::remove_dir_all(&path);
        } else if let Some(rest) = file.strip_prefix(OLD) {
            // `<name>-<nonce>-<pid>`: the name is everything before the last two parts.
            let parts: Vec<&str> = rest.rsplitn(3, '-').collect();
            let name = parts.get(2).copied().unwrap_or_default();
            let target = dir.join(name);
            // A layout migration interrupted after creating the new root: it is still empty.
            if !name.is_empty() && target.is_dir() && active_dir(&target).is_none() {
                let _ = std::fs::remove_dir_all(&target);
            }
            if !name.is_empty() && !target.exists() {
                tracing::warn!("restoring {} after an interrupted install", target.display());
                let _ = std::fs::rename(&path, &target);
            } else {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_uninstall_records_reject_paths_outside_the_package() {
        let tmp = tempfile::tempdir().unwrap();
        let mut pending = PendingUninstall {
            id: "p".into(),
            name: "Plugin".into(),
            version: "1.0.0".into(),
            flat: false,
            secrets: vec!["key".into()],
            error: None,
        };
        remember_uninstall(tmp.path(), &pending, &tmp.path().join("p/1.0.0")).unwrap();
        assert_eq!(pending_uninstalls(tmp.path())[0].secrets, ["key"]);
        for (id, version) in [
            ("../outside", "1"),
            ("/outside", "1"),
            (".data", "p"),
            ("other", "1"),
            ("p", "../outside"),
            ("p", "1/nested"),
        ] {
            pending.id = id.into();
            pending.version = version.into();
            std::fs::write(uninstall_file(tmp.path(), "p"), serde_json::to_vec(&pending).unwrap()).unwrap();
            assert!(pending_uninstalls(tmp.path()).is_empty(), "{id}/{version}");
        }
        pending.id = "invalid-1-0-0".into();
        assert!(remember_uninstall(tmp.path(), &pending, &tmp.path().join("other/1.0.0")).is_err());
        forget_uninstall(tmp.path(), "p").unwrap();
        assert!(pending_uninstalls(tmp.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn pending_uninstall_records_do_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let pending = PendingUninstall {
            id: "p".into(),
            name: "Plugin".into(),
            version: "1.0.0".into(),
            flat: false,
            secrets: Vec::new(),
            error: None,
        };
        let record = outside.path().join("p.json");
        std::fs::write(&record, "untouched").unwrap();
        let parent = tmp.path().join(".uninstall");
        symlink(outside.path(), &parent).unwrap();
        assert!(remember_uninstall(tmp.path(), &pending, &tmp.path().join("p/1.0.0")).is_err());
        assert!(forget_uninstall(tmp.path(), "p").is_err());
        assert!(pending_uninstalls(tmp.path()).is_empty());
        std::fs::remove_file(&parent).unwrap();
        std::fs::create_dir(&parent).unwrap();
        symlink(&record, uninstall_file(tmp.path(), "p")).unwrap();
        assert!(remember_uninstall(tmp.path(), &pending, &tmp.path().join("p/1.0.0")).is_err());
        assert!(pending_uninstalls(tmp.path()).is_empty());
        forget_uninstall(tmp.path(), "p").unwrap();
        symlink(&record, parent.join("p.tmp")).unwrap();
        remember_uninstall(tmp.path(), &pending, &tmp.path().join("p/1.0.0")).unwrap();
        assert_eq!(pending_uninstalls(tmp.path()).len(), 1);
        assert_eq!(std::fs::read_to_string(&record).unwrap(), "untouched");
    }

    #[cfg(windows)]
    #[test]
    fn pending_uninstall_records_do_not_follow_junctions() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let record = outside.path().join("p.json");
        std::fs::write(&record, "untouched").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(tmp.path().join(".uninstall"))
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success());
        let pending = PendingUninstall {
            id: "p".into(),
            name: "Plugin".into(),
            version: "1.0.0".into(),
            flat: false,
            secrets: Vec::new(),
            error: None,
        };
        assert!(remember_uninstall(tmp.path(), &pending, &tmp.path().join("p/1.0.0")).is_err());
        assert!(forget_uninstall(tmp.path(), "p").is_err());
        assert!(pending_uninstalls(tmp.path()).is_empty());
        assert_eq!(std::fs::read_to_string(record).unwrap(), "untouched");
    }

    #[test]
    fn failed_swap_keeps_the_old_version() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("p");
        let staging = tmp.path().join(".staging-p-1");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("v"), "1").unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("v"), "2").unwrap();
        let calls = std::cell::Cell::new(0);
        let err = swap(&staging, &target, |a, b| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 { Err(io::Error::other("disk full")) } else { std::fs::rename(a, b) }
        });
        assert!(err.is_err());
        assert_eq!(std::fs::read_to_string(target.join("v")).unwrap(), "1");
        swap(&staging, &target, |a, b| std::fs::rename(a, b)).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("v")).unwrap(), "2");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1, "old version removed");
    }

    #[test]
    fn versions_are_installed_side_by_side_and_rolled_back() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let root = tmp.path().join("plugins/acme.tools");
        let version_of = |_: &Path| Some("0.9.0".to_owned());
        // A flat install from before versioning.
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(ide_extension::MANIFEST_FILE), "v0.9").unwrap();
        assert_eq!(active_dir(&root), Some(root.clone()));

        std::fs::write(src.join(ide_extension::MANIFEST_FILE), "v1").unwrap();
        assert_eq!(install_version(&src, &root, "1.0.0", &[], "h1", version_of).unwrap().as_deref(), Some("0.9.0"));
        assert_eq!(active_dir(&root), Some(root.join("1.0.0")));
        std::fs::write(src.join(ide_extension::MANIFEST_FILE), "v2").unwrap();
        assert_eq!(install_version(&src, &root, "2.0.0", &[], "h2", version_of).unwrap().as_deref(), Some("1.0.0"));
        assert_eq!(previous_version(&root).as_deref(), Some("1.0.0"));
        prune(&root);
        assert!(!root.join("0.9.0").exists(), "older than previous: pruned");

        activate_version(&root, "1.0.0").unwrap();
        assert_eq!(
            std::fs::read_to_string(active_dir(&root).unwrap().join(ide_extension::MANIFEST_FILE)).unwrap(),
            "v1"
        );
        assert_eq!(previous_version(&root), None);
        assert!(install_version(&src, &root, "../x", &[], "h", version_of).is_err());
    }

    #[test]
    fn recover_restores_an_interrupted_swap() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".old-acme.tools-1a2b-77")).unwrap();
        std::fs::write(tmp.path().join(".old-acme.tools-1a2b-77/v"), "1").unwrap();
        std::fs::create_dir_all(tmp.path().join(".staging-acme.tools-1a2c-77")).unwrap();
        std::fs::create_dir_all(tmp.path().join("x")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".old-x-1-2")).unwrap();
        recover(tmp.path());
        assert_eq!(std::fs::read_to_string(tmp.path().join("acme.tools/v")).unwrap(), "1");
        let mut names: Vec<_> =
            std::fs::read_dir(tmp.path()).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["acme.tools", "x"]);
    }
}
