//! Capability checks for host functions that touch the file system.

use std::path::{Path, PathBuf};

/// Largest file `read-file` returns.
pub const MAX_READ_BYTES: u64 = 16 << 20;
/// Most entries `list-dir` returns (the first ones by name).
pub const MAX_DIR_ENTRIES: usize = 10_000;

/// One entry of a `list-dir` answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    /// A directory; symbolic links are not followed, so a link is neither a file nor a directory.
    pub is_dir: bool,
}

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

/// Lists a directory that `resolve_in_root` already approved: its entries
/// sorted by name (no recursion), at most [`MAX_DIR_ENTRIES`].
pub fn list_dir(real: &Path) -> Result<Vec<DirEntry>, String> {
    let meta = std::fs::metadata(real).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err(format!("{}: not a directory", real.display()));
    }
    let entries = std::fs::read_dir(real).map_err(|e| format!("{}: {e}", real.display()))?;
    let mut out: Vec<DirEntry> = entries
        .filter_map(|e| e.ok())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: e.file_type().is_ok_and(|t| t.is_dir()),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(MAX_DIR_ENTRIES);
    Ok(out)
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
    fn lists_a_directory_sorted_without_recursion() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("app/views/photos")).unwrap();
        std::fs::write(root.join("app/views/show.html.erb"), "").unwrap();
        std::fs::write(root.join("app/views/index.html.erb"), "").unwrap();
        std::fs::write(root.join("app/views/_form.html.erb"), "").unwrap();
        std::fs::write(root.join("app/views/photos/show.html.erb"), "").unwrap();

        let entries = list_dir(&resolve_in_root(&root, "app/views").unwrap()).unwrap();
        let listed: Vec<(&str, bool)> = entries.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
        assert_eq!(
            listed,
            [("_form.html.erb", false), ("index.html.erb", false), ("photos", true), ("show.html.erb", false)]
        );
        assert!(
            list_dir(&resolve_in_root(&root, "app/views/show.html.erb").unwrap())
                .unwrap_err()
                .contains("not a directory")
        );
        assert!(resolve_in_root(&root, "../").unwrap_err().contains("outside"));
        assert!(resolve_in_root(&root, "app/nope").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn listed_symlinks_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside"), root.join("src/link")).unwrap();
        let entries = list_dir(&resolve_in_root(&root, "src").unwrap()).unwrap();
        assert_eq!(entries, [DirEntry { name: "link".into(), is_dir: false }]);
        // Following the link is rejected by the root check.
        assert!(resolve_in_root(&root, "src/link").unwrap_err().contains("outside"));
    }

    #[test]
    fn rejects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let p = resolve_in_root(tmp.path(), "b.bin").unwrap();
        assert!(read_text(&p).unwrap_err().contains("UTF-8"));
    }
}
