//! Capability checks for host functions that touch the file system.

use std::path::{Path, PathBuf};

/// Largest file `read-file` returns.
pub const MAX_READ_BYTES: u64 = 16 << 20;

/// Resolves `path` (absolute, or relative to `root`) and checks that the real
/// path — after following `..` and symlinks — stays inside `root`.
pub fn resolve_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let root = root.canonicalize().map_err(|e| format!("project root unavailable: {e}"))?;
    let requested = Path::new(path);
    let joined = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    let real = joined.canonicalize().map_err(|_| format!("{path}: no such file"))?;
    if !real.starts_with(&root) {
        return Err(format!("{path}: access outside the project root is not allowed"));
    }
    Ok(real)
}

/// Like [`resolve_in_root`] for a path that may not exist yet (a file about to
/// be created) or that names a symlink itself (to delete or rename it): the
/// directory part is resolved through symlinks, the final name is kept as is,
/// and the result must stay inside `root`.
pub fn resolve_new_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let outside = || format!("{path}: access outside the project root is not allowed");
    if path.is_empty() {
        return Err("empty path".into());
    }
    let root = root.canonicalize().map_err(|e| format!("project root unavailable: {e}"))?;
    let requested = Path::new(path);
    let joined = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    let mut lexical = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                lexical.pop();
            }
            std::path::Component::CurDir => {}
            part => lexical.push(part),
        }
    }
    let (Some(name), Some(parent)) = (lexical.file_name(), lexical.parent()) else {
        return Err(outside());
    };
    let mut missing = Vec::new();
    let mut existing = parent;
    while !existing.exists() {
        let (Some(dir), Some(above)) = (existing.file_name(), existing.parent()) else {
            return Err(outside());
        };
        missing.push(dir);
        existing = above;
    }
    let mut real = existing.canonicalize().map_err(|e| format!("{path}: {e}"))?;
    real.extend(missing.into_iter().rev());
    real.push(name);
    if !real.starts_with(&root) {
        return Err(outside());
    }
    Ok(real)
}

/// Reads a UTF-8 file that `resolve_in_root` already approved.
pub fn read_text(real: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{}: not a file", real.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{}: file is larger than {} MiB", real.display(), MAX_READ_BYTES >> 20));
    }
    let bytes = std::fs::read(real).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| format!("{}: not valid UTF-8 text", real.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_reads_to_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "hi").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();

        let ok = resolve_in_root(&root, "src/a.txt").unwrap();
        assert_eq!(read_text(&ok).unwrap(), "hi");
        let abs = root.join("src/a.txt");
        assert!(resolve_in_root(&root, abs.to_str().unwrap()).is_ok());
        assert!(resolve_in_root(&root, "src/../src/a.txt").is_ok());

        let escape = resolve_in_root(&root, "../secret.txt").unwrap_err();
        assert!(escape.contains("outside the project root"), "{escape}");
        let abs_out = tmp.path().join("secret.txt");
        assert!(resolve_in_root(&root, abs_out.to_str().unwrap()).is_err());
        assert!(resolve_in_root(&root, "/etc/passwd").is_err());
        assert!(resolve_in_root(&root, "").is_err());
        assert!(resolve_in_root(&root, "missing.txt").unwrap_err().contains("no such file"));
        assert!(read_text(&resolve_in_root(&root, "src").unwrap()).unwrap_err().contains("not a file"));
    }

    #[test]
    fn new_paths_are_confined_to_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_real = root.canonicalize().unwrap();

        assert_eq!(resolve_new_in_root(&root, "src/new/a.txt").unwrap(), root_real.join("src/new/a.txt"));
        assert_eq!(resolve_new_in_root(&root, "src/../b.txt").unwrap(), root_real.join("b.txt"));
        assert!(resolve_new_in_root(&root, "../x.txt").unwrap_err().contains("outside"));
        assert!(resolve_new_in_root(&root, "src/../../x.txt").unwrap_err().contains("outside"));
        assert!(resolve_new_in_root(&root, "/etc/new.txt").is_err());
        assert!(resolve_new_in_root(&root, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_named_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("target.txt"), "t").unwrap();
        std::os::unix::fs::symlink(root.join("target.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), root.join("out")).unwrap();
        let root_real = root.canonicalize().unwrap();

        assert_eq!(resolve_new_in_root(&root, "link.txt").unwrap(), root_real.join("link.txt"));
        assert!(resolve_new_in_root(&root, "out/x.txt").unwrap_err().contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("link")).unwrap();
        assert!(resolve_in_root(&root, "link").unwrap_err().contains("outside"));
    }

    #[test]
    fn rejects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let p = resolve_in_root(tmp.path(), "b.bin").unwrap();
        assert!(read_text(&p).unwrap_err().contains("UTF-8"));
    }
}
