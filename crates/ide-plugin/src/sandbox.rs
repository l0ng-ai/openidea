//! Capability checks for host functions that touch the file system.

use std::path::{Path, PathBuf};

/// Largest file `read-file` returns.
pub const MAX_READ_BYTES: u64 = 16 << 20;

/// The canonical `root` and the absolute form of `path` (absolute, or
/// relative to `root`) — before any symlink or existence check.
fn joined_path(root: &Path, path: &str) -> Result<(PathBuf, PathBuf), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let root = root.canonicalize().map_err(|e| format!("project root unavailable: {e}"))?;
    let requested = Path::new(path);
    let joined = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    Ok((root, joined))
}

/// `joined` after `..`/symlink resolution as far as the file system allows:
/// the canonical path when it exists, else the canonicalized deepest existing
/// ancestor with the still-missing tail resolved textually — so the location
/// of a missing path is still judged where it would really land.
fn resolve_real(joined: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut candidate = joined.to_path_buf();
    let mut real = loop {
        match candidate.canonicalize() {
            Ok(real) => break real,
            Err(_) => {
                let Some(last) = candidate.components().next_back() else {
                    return joined.to_path_buf();
                };
                tail.push(last.as_os_str().to_owned());
                if !candidate.pop() {
                    return joined.to_path_buf();
                }
            }
        }
    };
    for part in tail.iter().rev() {
        if part == ".." {
            real.pop();
        } else if part != "." {
            real.push(part);
        }
    }
    real
}

/// Resolves `path` (absolute, or relative to `root`) and checks that the real
/// path — after following `..` and symlinks — stays inside `root`.
pub fn resolve_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let (root, joined) = joined_path(root, path)?;
    let real = joined.canonicalize().map_err(|_| format!("{path}: no such file"))?;
    if !real.starts_with(&root) {
        return Err(format!("{path}: access outside the project root is not allowed"));
    }
    Ok(real)
}

/// Whether `path` (absolute, or relative to `root`) lands inside `root`,
/// without requiring it to exist: `Ok(true)` also for a missing path, so
/// callers distinguish "outside" from "absent". Existing symlinks are
/// followed; a missing tail is judged at its would-be location.
pub fn inside_root(root: &Path, path: &str) -> Result<bool, String> {
    let (root, joined) = joined_path(root, path)?;
    Ok(resolve_real(&joined).starts_with(&root))
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
    fn inside_root_covers_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "hi").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();

        assert!(inside_root(&root, "src/a.txt").unwrap());
        assert!(inside_root(&root, "src").unwrap());
        assert!(inside_root(&root, "missing.txt").unwrap());
        assert!(inside_root(&root, "missing/deep/nested.txt").unwrap());
        assert!(inside_root(&root, "missing/../src/a.txt").unwrap());
        assert!(!inside_root(&root, "../secret.txt").unwrap());
        assert!(!inside_root(&root, "missing/../../secret.txt").unwrap());
        assert!(!inside_root(&root, "missing/sub/../../../secret.txt").unwrap());
        let abs_out = tmp.path().join("secret.txt");
        assert!(!inside_root(&root, abs_out.to_str().unwrap()).unwrap());
        assert!(inside_root(&root, "").is_err());
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
        assert!(!inside_root(&root, "link").unwrap());
        assert!(!inside_root(&root, "link/../x").unwrap());
        std::os::unix::fs::symlink(tmp.path(), root.join("dirlink")).unwrap();
        assert!(!inside_root(&root, "dirlink/secret.txt").unwrap());
        assert!(!inside_root(&root, "dirlink/missing.txt").unwrap());
    }

    #[test]
    fn rejects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let p = resolve_in_root(tmp.path(), "b.bin").unwrap();
        assert!(read_text(&p).unwrap_err().contains("UTF-8"));
    }
}
