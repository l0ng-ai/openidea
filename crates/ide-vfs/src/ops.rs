//! Create / rename / delete / copy.

use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeResult};
use std::fs;
use std::path::Path;

fn already_exists(path: &Path) -> IdeError {
    IdeError::new(ErrorKind::AlreadyExists, format!("{} already exists", path.display()))
}

fn not_found(path: &Path) -> IdeError {
    IdeError::not_found(format!("{} does not exist", path.display()))
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn ensure_parent(path: &Path) -> IdeResult<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub(crate) fn create_file(path: &Path) -> IdeResult<()> {
    if exists(path) {
        return Err(already_exists(path));
    }
    ensure_parent(path)?;
    fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    Ok(())
}

pub(crate) fn create_file_bytes(path: &Path, data: &[u8]) -> IdeResult<()> {
    use std::io::Write;
    if exists(path) {
        return Err(already_exists(path));
    }
    ensure_parent(path)?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(data)?;
    Ok(())
}

/// IDEA's "Toggle Read-only Attribute": read-only clears every write bit,
/// writable adds the owner's.
pub(crate) fn set_writable(path: &Path, writable: bool) -> IdeResult<()> {
    let meta = fs::metadata(path).map_err(|_| not_found(path))?;
    let mut perms = meta.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        perms.set_mode(if writable { mode | 0o200 } else { mode & !0o222 });
    }
    #[cfg(not(unix))]
    perms.set_readonly(!writable);
    fs::set_permissions(path, perms)?;
    Ok(())
}

pub(crate) fn create_dir(path: &Path) -> IdeResult<()> {
    if exists(path) {
        return Err(already_exists(path));
    }
    fs::create_dir_all(path)?;
    Ok(())
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

pub(crate) fn rename(from: &Path, to: &Path) -> IdeResult<()> {
    if !exists(from) {
        return Err(not_found(from));
    }
    if from == to {
        return Ok(());
    }
    // A case-only rename on a case-insensitive file system sees `to` as existing.
    if exists(to) && !same_file(from, to) {
        return Err(already_exists(to));
    }
    ensure_parent(to)?;
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_recursive(from, to)?;
            remove_permanently(from)
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn remove_permanently(path: &Path) -> IdeResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub(crate) fn delete(path: &Path, use_trash: bool) -> IdeResult<()> {
    if !exists(path) {
        return Err(not_found(path));
    }
    if use_trash {
        #[allow(unused_mut)]
        let mut ctx = trash::TrashContext::default();
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            // No Finder scripting: no permission prompt, no sound.
            ctx.set_delete_method(DeleteMethod::NsFileManager);
        }
        match ctx.delete(path) {
            Ok(()) => return Ok(()),
            Err(e) => tracing::warn!("cannot move {} to trash ({e}); deleting permanently", path.display()),
        }
    }
    remove_permanently(path)
}

pub(crate) fn copy(from: &Path, to: &Path) -> IdeResult<()> {
    let meta = fs::symlink_metadata(from).map_err(|_| not_found(from))?;
    if exists(to) {
        return Err(already_exists(to));
    }
    if meta.is_dir() {
        let src = fs::canonicalize(from)?;
        let dst_parent = to.parent().map(|p| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));
        if dst_parent.is_some_and(|p| p.starts_with(&src)) {
            return Err(IdeError::invalid(format!("cannot copy {} into itself", from.display())));
        }
    }
    ensure_parent(to)?;
    copy_recursive(from, to)
}

fn copy_recursive(from: &Path, to: &Path) -> IdeResult<()> {
    let meta = fs::symlink_metadata(from)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        copy_symlink(from, to)
    } else if ft.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, meta.permissions())?;
        Ok(())
    } else {
        fs::copy(from, to)?;
        Ok(())
    }
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> IdeResult<()> {
    let target = fs::read_link(from)?;
    std::os::unix::fs::symlink(target, to)?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_symlink(from: &Path, to: &Path) -> IdeResult<()> {
    if fs::metadata(from)?.is_dir() {
        copy_recursive(&fs::canonicalize(from)?, to)
    } else {
        fs::copy(from, to)?;
        Ok(())
    }
}
