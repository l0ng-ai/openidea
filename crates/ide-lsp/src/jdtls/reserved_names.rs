//! Windows reserved device names (`nul`, `con`, …) inside a Java project.
//!
//! On Windows, a directory listing returns such a file (often left by a shell
//! redirect like `2>nul` in Git Bash), but `Files.exists` reports it missing as the
//! name resolves to the device. Eclipse's resource refresh then builds a child path
//! with an empty name and the Maven / Gradle import aborts during JDT LS
//! initialization with "Path must include project and resource name", so no Java
//! project is created. The user only sees every run fail with "module is not
//! imported"; this names the files that cause it.

use std::path::{Path, PathBuf};

/// What JDT LS logs when the import aborts on such an entry.
pub(crate) const IMPORT_FAILURE: &str = "Path must include project and resource name";

/// Directory entries visited per scan, and reserved names reported at most.
const MAX_VISITED: usize = 200_000;
const MAX_REPORTED: usize = 20;

/// Whether Windows treats `name` as a device: CON, PRN, AUX, NUL, COM0–9 or LPT0–9
/// (also with superscript digits), in any case, with or without an extension and
/// trailing spaces or dots.
pub(crate) fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str()) {
        return true;
    }
    let mut chars = upper.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let digit: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && matches!(digit.as_slice(), [d] if d.is_ascii_digit() || matches!(d, '¹' | '²' | '³'))
}

/// Entries below `root` with a reserved device name, in walk order (bounded).
/// Ignore files are not honoured: Eclipse's refresh does not honour them either.
pub(crate) fn reserved_entries(root: &Path) -> Vec<PathBuf> {
    ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .follow_links(false)
        .build()
        .take(MAX_VISITED)
        .filter_map(Result::ok)
        .filter(|entry| entry.depth() > 0 && entry.file_name().to_str().is_some_and(is_reserved_device_name))
        .map(ignore::DirEntry::into_path)
        .take(MAX_REPORTED)
        .collect()
}

/// The notification body for a JDT LS log `message` from the server at `root`:
/// the reserved-name entries that abort the import, when the message is that
/// failure and the host is Windows (elsewhere such names are ordinary files).
pub(crate) fn import_failure_hint(root: &Path, message: &str, windows: bool) -> Option<String> {
    if !windows || !message.contains(IMPORT_FAILURE) {
        return None;
    }
    let entries = reserved_entries(root);
    if entries.is_empty() {
        return None;
    }
    let paths = entries
        .iter()
        .map(|path| path.strip_prefix(root).unwrap_or(path).display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "The Java project cannot be imported because these files use a name Windows reserves for devices: {paths}. Delete or rename them, then restart the Java language server."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path Windows does not resolve to a device (`\\?\`): the only way to create a
    /// file named `nul` there. Elsewhere such names are ordinary files.
    fn verbatim(path: &Path) -> PathBuf {
        let text = path.to_string_lossy();
        if cfg!(windows) && !text.starts_with(r"\\?\") {
            PathBuf::from(format!(r"\\?\{text}"))
        } else {
            path.to_path_buf()
        }
    }

    /// Writes `root` / `parts` (joined per component: verbatim paths take no `/`).
    fn write(root: &Path, parts: &[&str], text: &str) {
        let path = parts.iter().fold(root.to_path_buf(), |path, part| path.join(part));
        std::fs::create_dir_all(verbatim(path.parent().unwrap())).unwrap();
        std::fs::write(verbatim(&path), text).unwrap();
    }

    /// Removes a tree that may hold reserved names, which a plain path cannot delete on Windows.
    fn remove(dir: tempfile::TempDir) {
        let _ = std::fs::remove_dir_all(verbatim(&dir.keep()));
    }

    #[test]
    fn reserved_device_names() {
        for name in [
            "nul",
            "NUL",
            "Nul",
            "nul.txt",
            "nul.tar.gz",
            "nul ",
            "con",
            "prn",
            "aux",
            "com1",
            "COM9",
            "com0",
            "lpt1",
            "LPT9",
            "com¹",
            "lpt³",
            "aux.java",
        ] {
            assert!(is_reserved_device_name(name), "{name}");
        }
        for name in [
            "null",
            "nuls",
            "anul",
            "console",
            "auxiliary",
            "com",
            "com10",
            "lpt",
            "lptx",
            "comA",
            ".nul",
            "",
            "src",
            "pom.xml",
            "nul_file",
        ] {
            assert!(!is_reserved_device_name(name), "{name}");
        }
    }

    #[test]
    fn import_failure_names_the_reserved_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, &["nul"], "54 bytes of shell output");
        write(root, &["module", "aux.txt"], "");
        write(root, &["node_modules", "x", "con"], "");
        write(root, &["module", "src", "Null.java"], "class Null {}");
        write(root, &[".gitignore"], "nul\nnode_modules/\n");
        let message = "Initialization failed | java.lang.IllegalArgumentException: Path must include project and resource name: /bkbits-parent | at UnifiedTree.createChildNodeFromFileSystem(UnifiedTree.java:320)";

        let hint = import_failure_hint(root, message, true).unwrap();
        let sep = std::path::MAIN_SEPARATOR;
        for path in ["nul".to_owned(), format!("module{sep}aux.txt"), format!("node_modules{sep}x{sep}con")] {
            assert!(hint.contains(&path), "{path} missing from {hint}");
        }
        assert!(!hint.contains("Null.java"));
        assert!(hint.ends_with("then restart the Java language server."));

        // Other failures, other hosts, and projects without such names stay silent.
        assert_eq!(import_failure_hint(root, "Initialization failed | java.lang.NullPointerException", true), None);
        assert_eq!(import_failure_hint(root, message, false), None);
        let clean = tempfile::tempdir().unwrap();
        write(clean.path(), &["pom.xml"], "<project/>");
        assert_eq!(import_failure_hint(clean.path(), message, true), None);
        remove(dir);
    }

    #[test]
    fn reports_a_bounded_number_of_entries() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..30 {
            write(dir.path(), &[&format!("m{i}"), "nul"], "");
        }
        assert_eq!(reserved_entries(dir.path()).len(), MAX_REPORTED);
        remove(dir);
    }
}
