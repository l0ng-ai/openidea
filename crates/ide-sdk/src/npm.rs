//! Node-based language servers installed with npm: the package behind a command.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// `command` as given (a path) or found on `path`, npm shims included.
pub(crate) fn find_command(command: &str, path: &OsStr) -> Option<PathBuf> {
    let p = Path::new(command);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let exts: &[&str] = if cfg!(windows) { &[".cmd", ".exe", ""] } else { &[""] };
    std::env::split_paths(path)
        .flat_map(|d| exts.iter().map(move |e| d.join(format!("{command}{e}"))))
        .find(|c| c.is_file())
}

/// The npm package an executable comes from: next to a `node_modules/.bin` shim
/// (the IDE's tools dir, a project), a Windows global shim (`%APPDATA%\npm`), a
/// Unix global `<prefix>/bin` or a symlink into the package.
pub(crate) fn package_dir(bin: &Path, package: &str) -> Option<PathBuf> {
    let dir = bin.parent()?;
    let mut candidates = vec![dir.join("node_modules").join(package)];
    if dir.file_name() == Some(OsStr::new(".bin"))
        && let Some(node_modules) = dir.parent()
    {
        candidates.push(node_modules.join(package));
    }
    if let Ok(real) = dunce::canonicalize(bin) {
        candidates.extend(real.ancestors().filter(|a| a.ends_with(package)).map(Path::to_path_buf));
    }
    if let Some(prefix) = dir.parent() {
        candidates.push(prefix.join("lib").join("node_modules").join(package));
    }
    candidates.into_iter().find(|c| c.join("package.json").is_file())
}
