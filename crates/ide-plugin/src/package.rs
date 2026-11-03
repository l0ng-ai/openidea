//! Plugin packages on disk: a folder, its `plugin.toml`, or a `.zip` of the folder.

use crate::MANIFEST_FILE;
use ide_core::{IdeError, IdeResult};
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

/// Far above any real package; stops a zip bomb before it fills the disk.
const MAX_ENTRIES: usize = 10_000;
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) fn is_zip(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn invalid_zip(zip: &Path, reason: impl std::fmt::Display) -> IdeError {
    IdeError::invalid(format!("{} is not a valid plugin archive: {reason}", zip.display()))
}

/// Unpacks `zip` into `dest` and returns the package folder inside it. Refuses the
/// whole archive when an entry would leave `dest` or is a symbolic link.
pub(crate) fn unpack_zip(zip: &Path, dest: &Path) -> IdeResult<PathBuf> {
    let mut archive = zip::ZipArchive::new(BufReader::new(File::open(zip)?)).map_err(|e| invalid_zip(zip, e))?;
    if archive.len() > MAX_ENTRIES {
        return Err(invalid_zip(zip, format!("more than {MAX_ENTRIES} entries")));
    }
    let mut budget = MAX_UNPACKED_BYTES;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| invalid_zip(zip, e))?;
        let name = entry.name().to_owned();
        let Some(rel) = entry.enclosed_name() else {
            return Err(invalid_zip(zip, format!("unsafe path {name:?}")));
        };
        if entry.is_symlink() {
            return Err(invalid_zip(zip, format!("symbolic link {name:?}")));
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        // One byte over the budget tells a full budget from a file that exactly fits.
        let written =
            io::copy(&mut (&mut entry).take(budget + 1), &mut File::create(&out)?).map_err(|e| invalid_zip(zip, e))?;
        if written > budget {
            return Err(invalid_zip(zip, "it unpacks to more than 1 GB"));
        }
        budget -= written;
    }
    package_root(dest).ok_or_else(|| {
        IdeError::invalid(format!(
            "{} is not an OpenIDEA plugin: no {MANIFEST_FILE} at its root or in its only folder",
            zip.display()
        ))
    })
}

/// `dir` itself, or its only folder as when a zip holds the package folder.
/// Archiver metadata (`__MACOSX`, dot files) does not count as a second folder.
fn package_root(dir: &Path) -> Option<PathBuf> {
    if dir.join(MANIFEST_FILE).is_file() {
        return Some(dir.to_path_buf());
    }
    let mut folders = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        p.is_dir() && !name.starts_with('.') && name != "__MACOSX"
    });
    let only = folders.next().filter(|_| folders.next().is_none())?;
    only.join(MANIFEST_FILE).is_file().then_some(only)
}
