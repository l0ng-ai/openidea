//! File system access for the IDE. The UI never touches the disk directly.

mod archive;
mod bytes;
mod encoding;
mod ops;
mod rules;
mod watch;

use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use archive::{
    ARCHIVE_EXTENSIONS, archive_entry_path, archive_root, is_archive_file, is_archive_path, read_archive_dir,
    read_archive_entry, split_archive_path,
};
pub use bytes::{ByteRange, FileProbe, MAX_RANGE_LEN, base64, image_mime, probe, read_data_url, read_range};
use encoding::SNIFF_LEN;
pub use encoding::{
    LARGE_FILE_THRESHOLD, MAX_OPEN_SIZE, READ_ONLY_THRESHOLD, encode, write_atomic, write_atomic_strict,
};
pub use rules::ExcludeMatcher;
pub use watch::{WatchMode, Watcher};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: ide_core::IpcPath,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub mtime_ms: f64,
    /// Matched by .gitignore or the exclude settings.
    pub ignored: bool,
    /// Matched by the exclude settings (IDEA's "excluded": dimmed, excluded-folder icon).
    pub excluded: bool,
    pub hidden: bool,
    /// For symlinks: what the link points to (`None` when dangling); `None`
    /// for other entries.
    #[specta(optional)]
    pub target_kind: Option<EntryKind>,
}

/// Milliseconds since the Unix epoch of a file's modification time (0 when unknown).
pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as f64 / 1_000_000.0)
        .unwrap_or(0.0)
}

/// Case-insensitive natural ordering: `file2 < file10`, `a < B`.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (n, m) = (take(&mut x), take(&mut y));
                let (nt, mt) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let ord = nt.len().cmp(&mt.len()).then_with(|| nt.cmp(mt)).then_with(|| n.len().cmp(&m.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
    a.cmp(b)
}

/// Lists one directory level: directories first, then files, each sorted
/// case-insensitively with natural number ordering.
///
/// Symlinks are reported as [`EntryKind::Symlink`] but sorted (and sized) by
/// what they point to. `excluded` reflects `excludes` (relative to the enclosing
/// repository root, else to `dir`); `ignored` also the applicable `.gitignore`/`.ignore` files.
///
/// Inside an archive (`<archive>!/<entry>`, or the archive file itself) lists its entries.
pub fn read_dir(dir: &Path, excludes: &[String]) -> IdeResult<Vec<FileEntry>> {
    if let Some((archive, entry)) = split_archive_path(dir) {
        return read_archive_dir(&archive, &entry);
    }
    if is_archive_file(dir) && fs::metadata(dir).is_ok_and(|m| m.is_file()) {
        return read_archive_dir(dir, "");
    }
    if !fs::metadata(dir)?.is_dir() {
        return Err(IdeError::invalid(format!("{} is not a directory", dir.display())));
    }
    let gitignore = rules::GitignoreStack::new(dir);
    let base = gitignore.repo_root().unwrap_or(dir).to_path_buf();
    let excludes = ExcludeMatcher::new(excludes);

    let mut entries: Vec<(bool, FileEntry)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::debug!("read_dir {}: {e}", dir.display());
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(lmeta) = fs::symlink_metadata(&path) else { continue };
        let (kind, meta, target_kind) = if lmeta.file_type().is_symlink() {
            match fs::metadata(&path) {
                Ok(m) => {
                    let target = if m.is_dir() { EntryKind::Dir } else { EntryKind::File };
                    (EntryKind::Symlink, m, Some(target))
                }
                Err(_) => (EntryKind::Symlink, lmeta, None),
            }
        } else if lmeta.is_dir() {
            (EntryKind::Dir, lmeta, None)
        } else {
            (EntryKind::File, lmeta, None)
        };
        let is_dir = meta.is_dir();
        let rel = path.strip_prefix(&base).unwrap_or(&path);
        let excluded = excludes.is_excluded(rel);
        let ignored = excluded || gitignore.is_ignored(&path, is_dir);
        entries.push((
            is_dir,
            FileEntry {
                hidden: name.starts_with('.'),
                size: if is_dir { 0 } else { meta.len() },
                mtime_ms: mtime_ms(&meta),
                name,
                path: path.into(),
                kind,
                ignored,
                excluded,
                target_kind,
            },
        ));
    }
    entries.sort_by(|(da, a), (db, b)| db.cmp(da).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(entries.into_iter().map(|(_, e)| e).collect())
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadedText {
    pub text: String,
    /// WHATWG encoding label, e.g. `utf-8`, `gbk`, `utf-16le`.
    pub encoding: String,
    pub has_bom: bool,
    /// File looked binary; `text` is empty and the UI should show a placeholder.
    pub binary: bool,
    /// File exceeds [`LARGE_FILE_THRESHOLD`]: expensive features are disabled.
    #[specta(optional)]
    pub large: bool,
    /// File exceeds [`READ_ONLY_THRESHOLD`]: opened read-only.
    pub too_large: bool,
    pub mtime_ms: f64,
}

/// Loads a text file, detecting BOM / encoding (chardetng) and binary content.
///
/// Files over [`LARGE_FILE_THRESHOLD`] load with `large`, over
/// [`READ_ONLY_THRESHOLD`] with `too_large`; files over [`MAX_OPEN_SIZE`] are
/// refused with `InvalidInput`.
pub fn load_text(path: &Path) -> IdeResult<LoadedText> {
    encoding::load_text(path)
}

/// Like [`load_text`], but text that is neither valid UTF-8 nor marked by a BOM
/// is decoded as `fallback` (the configured project encoding) instead of guessed.
pub fn load_text_with_fallback(path: &Path, fallback: Option<&str>) -> IdeResult<LoadedText> {
    let loaded = encoding::load_text(path)?;
    match fallback {
        Some(enc)
            if !loaded.binary
                && !loaded.has_bom
                && loaded.encoding != "utf-8"
                && !loaded.encoding.starts_with("utf-16") =>
        {
            encoding::load_text_as(path, enc).or(Ok(loaded))
        }
        _ => Ok(loaded),
    }
}

/// Like [`load_text`] but decodes with the given encoding instead of detecting it.
pub fn load_text_as(path: &Path, encoding: &str) -> IdeResult<LoadedText> {
    encoding::load_text_as(path, encoding)
}

/// Writes atomically (temp file + rename), re-encoding to `encoding`.
/// Returns the new mtime in ms. Fails with `InvalidInput` when the text has
/// characters `encoding` cannot represent (rather than corrupting them).
pub fn save_text(path: &Path, text: &str, encoding: &str, has_bom: bool) -> IdeResult<f64> {
    let bytes = encode(text, encoding, has_bom)?;
    write_atomic(path, &bytes)
}

/// Creates an empty file (and missing parent directories). Fails with
/// `AlreadyExists` rather than truncating an existing file.
pub fn create_file(path: &Path) -> IdeResult<()> {
    ops::create_file(path)
}
/// Creates a directory and missing parents; `AlreadyExists` if present.
pub fn create_dir(path: &Path) -> IdeResult<()> {
    ops::create_dir(path)
}
/// Sets or clears the file's writable bit (owner write when making it writable).
pub fn set_writable(path: &Path, writable: bool) -> IdeResult<()> {
    ops::set_writable(path, writable)
}
/// Renames / moves; refuses to overwrite an existing target (case-only renames
/// are allowed). Falls back to copy + delete across devices.
pub fn rename(from: &Path, to: &Path) -> IdeResult<()> {
    ops::rename(from, to)
}
/// Moves to the OS trash (recoverable), like IDEA's safe delete for files.
/// Deletes permanently when the trash is unavailable.
pub fn delete(path: &Path) -> IdeResult<()> {
    ops::delete(path, !cfg!(test))
}
/// Deletes without going through the trash.
pub fn delete_permanently(path: &Path) -> IdeResult<()> {
    ops::delete(path, false)
}
/// Copies a file, symlink or directory tree; refuses to overwrite `to`.
pub fn copy(from: &Path, to: &Path) -> IdeResult<()> {
    ops::copy(from, to)
}

/// Walks every non-ignored file of a project in parallel (ignore crate),
/// honouring .gitignore, .ignore and `excludes`. Shared by index and search.
///
/// Hidden files are included; `.git` is always skipped. `.gitignore` applies
/// even outside a git repository. Symlinks to files are visited, symlinked
/// directories are not followed.
pub fn walk_files(root: &Path, excludes: &[String], visit: impl Fn(&Path) + Send + Sync) {
    let excludes = Arc::new(ExcludeMatcher::new(excludes));
    let base = root.to_path_buf();
    let mut builder = ignore::WalkBuilder::new(root);
    builder.hidden(false).require_git(false).follow_links(false);
    builder.filter_entry(move |entry| {
        if entry.depth() > 0 && entry.file_name() == ".git" {
            return false;
        }
        match entry.path().strip_prefix(&base) {
            Ok(rel) if !rel.as_os_str().is_empty() => !excludes.is_match(rel),
            _ => true,
        }
    });
    let visit = &visit;
    builder.build_parallel().run(|| {
        Box::new(move |result| {
            match result {
                Ok(entry) => {
                    let is_file = match entry.file_type() {
                        Some(ft) if ft.is_file() => true,
                        Some(ft) if ft.is_symlink() => entry.path().is_file(),
                        _ => false,
                    };
                    if is_file {
                        visit(entry.path());
                    }
                }
                Err(e) => tracing::debug!("walk: {e}"),
            }
            ignore::WalkState::Continue
        })
    });
}

#[derive(Clone, Debug, Default)]
pub struct FsBatch {
    pub created: Vec<PathBuf>,
    pub modified: Vec<PathBuf>,
    pub removed: Vec<PathBuf>,
}

impl FsBatch {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_ordering() {
        let mut names = vec!["file10", "File2", "file1", "b", "A", "file02", "a", "x9y", "x10y", "readme"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["A", "a", "b", "file1", "File2", "file02", "file10", "readme", "x9y", "x10y"]);
    }

    #[test]
    fn toggles_the_writable_bit() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("x");
        fs::write(&f, "1").unwrap();
        set_writable(&f, false).unwrap();
        assert!(fs::metadata(&f).unwrap().permissions().readonly());
        set_writable(&f, true).unwrap();
        assert!(!fs::metadata(&f).unwrap().permissions().readonly());
        assert_eq!(
            set_writable(&tmp.path().join("missing"), true).unwrap_err().kind,
            ide_core::error::ErrorKind::NotFound
        );
    }

    #[test]
    fn delete_in_tests_is_permanent() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("x");
        fs::write(&f, "1").unwrap();
        delete(&f).unwrap();
        assert!(!f.exists());
        assert_eq!(delete(&f).unwrap_err().kind, ide_core::error::ErrorKind::NotFound);
    }
}

#[cfg(test)]
mod assertions {
    fn send_sync<T: Send + Sync>() {}

    #[test]
    fn types_are_thread_safe() {
        send_sync::<super::Watcher>();
        send_sync::<super::FsBatch>();
    }
}
