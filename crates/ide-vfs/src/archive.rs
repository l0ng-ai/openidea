//! Read-only browsing of zip archives (jar, zip, war…), IDEA's `jar://` file
//! system: `<archive>!` is the archive's root and `<archive>!/<entry>` an entry
//! inside it. Listing and reading go through a small cache of parsed central
//! directories, refreshed when the archive changes on disk.

use crate::{EntryKind, FileEntry, mtime_ms, natural_cmp};
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::SystemTime;

/// File extensions browsed as zip archives.
pub const ARCHIVE_EXTENSIONS: &[&str] = &["jar", "zip", "war", "ear", "aar", "srcjar"];

/// Separator between the archive and the entry path (`/jdk/lib/src.zip!/java.base/…`).
pub const ARCHIVE_SEPARATOR: char = '!';

/// Parsed archives kept open.
const CACHE_SIZE: usize = 8;

/// Whether `path` names a file browsed as an archive (by extension).
pub fn is_archive_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ARCHIVE_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)))
}

/// `(archive, entry)` for `<archive>!` (entry `""`) or `<archive>!/<entry>`;
/// `None` for ordinary paths. The entry is `/`-separated without leading or trailing `/`.
pub fn split_archive_path(path: &Path) -> Option<(PathBuf, String)> {
    let s = path.to_str()?;
    for (i, _) in s.match_indices(ARCHIVE_SEPARATOR) {
        let rest = &s[i + 1..];
        if !(rest.is_empty() || rest.starts_with(['/', '\\'])) {
            continue;
        }
        let archive = Path::new(&s[..i]);
        if is_archive_file(archive) {
            let entry = rest.replace('\\', "/");
            return Some((archive.to_path_buf(), entry.trim_matches('/').to_owned()));
        }
    }
    None
}

/// Whether `path` lies inside an archive (`<archive>!…`).
pub fn is_archive_path(path: &Path) -> bool {
    split_archive_path(path).is_some()
}

/// The root of `archive` as a browsable folder: `<archive>!`.
pub fn archive_root(archive: &Path) -> PathBuf {
    let mut s = archive.as_os_str().to_owned();
    s.push("!");
    PathBuf::from(s)
}

/// `<archive>!/<entry>` (the root for an empty entry).
pub fn archive_entry_path(archive: &Path, entry: &str) -> PathBuf {
    let entry = entry.trim_matches('/');
    if entry.is_empty() {
        return archive_root(archive);
    }
    let mut s = archive.as_os_str().to_owned();
    s.push("!/");
    s.push(entry);
    PathBuf::from(s)
}

struct Node {
    dir: bool,
    size: u64,
    /// Index in the zip's central directory (`None` for implicit directories).
    index: Option<usize>,
    children: Vec<String>,
}

struct Archive {
    stamp: (Option<SystemTime>, u64),
    mtime_ms: f64,
    /// Entry path (`""` = root) → node.
    nodes: HashMap<String, Node>,
    zip: Mutex<zip::ZipArchive<File>>,
}

/// Most recently used first.
type Cache = Vec<(PathBuf, Arc<Archive>)>;

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

fn zip_error(archive: &Path, e: zip::result::ZipError) -> IdeError {
    match e {
        zip::result::ZipError::Io(e) => e.into(),
        zip::result::ZipError::FileNotFound => IdeError::not_found(format!("entry not found in {}", archive.display())),
        e => IdeError::invalid(format!("{}: {e}", archive.display())),
    }
}

/// Normalises a zip entry name: `/`-separated, no leading `/` or `./`, no trailing `/`.
fn clean_name(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    (!parts.is_empty() && !parts.contains(&"..")).then(|| parts.join("/"))
}

fn parent_of(name: &str) -> (&str, &str) {
    match name.rfind('/') {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => ("", name),
    }
}

impl Archive {
    fn open(path: &Path, stamp: (Option<SystemTime>, u64), mtime_ms: f64) -> IdeResult<Self> {
        let mut zip = zip::ZipArchive::new(File::open(path)?).map_err(|e| zip_error(path, e))?;
        let mut nodes: HashMap<String, Node> = HashMap::new();
        nodes.insert(String::new(), Node { dir: true, size: 0, index: None, children: Vec::new() });
        for i in 0..zip.len() {
            let Ok(file) = zip.by_index_raw(i) else { continue };
            let Ok(name) = file.name() else { continue };
            let Some(name) = clean_name(&name) else { continue };
            let (dir, size) = (file.is_dir(), file.size());
            drop(file);
            let mut parent = parent_of(&name).0;
            while !nodes.contains_key(parent) {
                nodes.insert(parent.to_owned(), Node { dir: true, size: 0, index: None, children: Vec::new() });
                parent = parent_of(parent).0;
            }
            let node = nodes.entry(name).or_insert(Node { dir, size: 0, index: None, children: Vec::new() });
            node.dir |= dir;
            node.index = Some(i);
            node.size = if node.dir { 0 } else { size };
        }
        let links: Vec<(String, String)> = nodes
            .keys()
            .filter(|k| !k.is_empty())
            .map(|k| {
                let (parent, base) = parent_of(k);
                (parent.to_owned(), base.to_owned())
            })
            .collect();
        for (parent, base) in links {
            if let Some(p) = nodes.get_mut(&parent) {
                p.dir = true;
                p.children.push(base);
            }
        }
        Ok(Self { stamp, mtime_ms, nodes, zip: Mutex::new(zip) })
    }
}

/// The parsed archive at `path`, from the cache unless it changed on disk.
fn archive(path: &Path) -> IdeResult<Arc<Archive>> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(IdeError::invalid(format!("{} is not an archive", path.display())));
    }
    let stamp = (meta.modified().ok(), meta.len());
    {
        let mut cache = CACHE.lock();
        if let Some(i) = cache.iter().position(|(p, a)| p == path && a.stamp == stamp) {
            let hit = cache.remove(i);
            let a = hit.1.clone();
            cache.insert(0, hit);
            return Ok(a);
        }
    }
    let parsed = Arc::new(Archive::open(path, stamp, mtime_ms(&meta))?);
    let mut cache = CACHE.lock();
    cache.retain(|(p, _)| p != path);
    cache.insert(0, (path.to_path_buf(), parsed.clone()));
    cache.truncate(CACHE_SIZE);
    Ok(parsed)
}

/// Lists one folder of an archive (`dir` = `""` for its root): directories
/// first, then files, in natural order. Entries are never ignored or excluded.
pub fn read_archive_dir(archive_path: &Path, dir: &str) -> IdeResult<Vec<FileEntry>> {
    let a = archive(archive_path)?;
    let dir = dir.trim_matches('/');
    let node = a
        .nodes
        .get(dir)
        .ok_or_else(|| IdeError::not_found(format!("{dir} not found in {}", archive_path.display())))?;
    if !node.dir {
        return Err(IdeError::invalid(format!("{dir} is not a directory")));
    }
    let mut entries: Vec<FileEntry> = node
        .children
        .iter()
        .filter_map(|name| {
            let full = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            let child = a.nodes.get(&full)?;
            Some(FileEntry {
                name: name.clone(),
                path: archive_entry_path(archive_path, &full).into(),
                kind: if child.dir { EntryKind::Dir } else { EntryKind::File },
                size: child.size,
                mtime_ms: a.mtime_ms,
                ignored: false,
                excluded: false,
                hidden: name.starts_with('.'),
                target_kind: None,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let (da, db) = (a.kind == EntryKind::Dir, b.kind == EntryKind::Dir);
        db.cmp(&da).then_with(|| natural_cmp(&a.name, &b.name))
    });
    Ok(entries)
}

/// Uncompressed size of an archive entry.
pub(crate) fn entry_size(archive_path: &Path, entry: &str) -> IdeResult<(u64, f64)> {
    let a = archive(archive_path)?;
    let node = a
        .nodes
        .get(entry)
        .ok_or_else(|| IdeError::not_found(format!("{entry} not found in {}", archive_path.display())))?;
    if node.dir {
        return Err(IdeError::invalid(format!("{entry} is a directory")));
    }
    Ok((node.size, a.mtime_ms))
}

/// The contents of a file inside an archive, and the archive's mtime (ms).
pub fn read_archive_entry(archive_path: &Path, entry: &str) -> IdeResult<(Vec<u8>, f64)> {
    let a = archive(archive_path)?;
    let index = match a.nodes.get(entry) {
        Some(Node { dir: false, index: Some(i), .. }) => *i,
        Some(_) => return Err(IdeError::invalid(format!("{entry} is a directory"))),
        None => return Err(IdeError::not_found(format!("{entry} not found in {}", archive_path.display()))),
    };
    let mut zip = a.zip.lock();
    let mut file = zip.by_index(index).map_err(|e| zip_error(archive_path, e))?;
    let mut bytes = Vec::with_capacity(file.size().min(crate::MAX_OPEN_SIZE) as usize);
    file.read_to_end(&mut bytes)?;
    Ok((bytes, a.mtime_ms))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Writes a zip with `files` (`name` ending in `/` = explicit directory entry).
    pub(crate) fn write_zip(path: &Path, files: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, text) in files {
            if name.ends_with('/') {
                w.add_directory(*name, opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(text.as_bytes()).unwrap();
            }
        }
        w.finish().unwrap();
    }

    #[test]
    fn splits_archive_paths() {
        assert_eq!(split_archive_path(Path::new("/a/b.txt")), None);
        assert_eq!(split_archive_path(Path::new("/a/x!/y")), None, "not an archive extension");
        assert_eq!(split_archive_path(Path::new("/a/s.zip!")), Some((PathBuf::from("/a/s.zip"), String::new())));
        assert_eq!(
            split_archive_path(Path::new("/a/lib.JAR!/org/x/A.java")),
            Some((PathBuf::from("/a/lib.JAR"), "org/x/A.java".into()))
        );
        assert_eq!(split_archive_path(Path::new("/a/s.zip!/dir/")), Some((PathBuf::from("/a/s.zip"), "dir".into())));
        assert_eq!(archive_entry_path(Path::new("/a/s.zip"), "x/y.java"), PathBuf::from("/a/s.zip!/x/y.java"));
        assert_eq!(archive_entry_path(Path::new("/a/s.zip"), ""), PathBuf::from("/a/s.zip!"));
        assert!(is_archive_path(Path::new("/a/s.zip!/x")));
    }

    #[test]
    fn lists_and_reads_entries_with_implicit_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("src.zip");
        write_zip(
            &zip,
            &[
                ("java.base/java/lang/String.java", "class String {}"),
                ("java.base/java/lang/Object.java", "class Object {}"),
                ("java.base/java/util/", ""),
                ("java.base/module-info.java", "module java.base {}"),
                ("README", "hi"),
                ("../evil", "x"),
            ],
        );
        let names = |dir: &str| -> Vec<(String, EntryKind)> {
            read_archive_dir(&zip, dir).unwrap().into_iter().map(|e| (e.name, e.kind)).collect()
        };
        assert_eq!(names(""), vec![("java.base".into(), EntryKind::Dir), ("README".into(), EntryKind::File)]);
        assert_eq!(
            names("java.base"),
            vec![("java".into(), EntryKind::Dir), ("module-info.java".into(), EntryKind::File)]
        );
        assert_eq!(names("java.base/java"), vec![("lang".into(), EntryKind::Dir), ("util".into(), EntryKind::Dir)]);
        let lang = read_archive_dir(&zip, "java.base/java/lang").unwrap();
        assert_eq!(lang.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Object.java", "String.java"]);
        assert_eq!(*lang[1].path, *archive_entry_path(&zip, "java.base/java/lang/String.java"));
        assert!(names("java.base/java/util").is_empty());
        assert_eq!(read_archive_entry(&zip, "java.base/java/lang/String.java").unwrap().0, b"class String {}");
        assert_eq!(read_archive_entry(&zip, "missing").unwrap_err().kind, ide_core::error::ErrorKind::NotFound);
        assert!(read_archive_entry(&zip, "java.base").is_err());
        assert!(read_archive_dir(&zip, "README").is_err());

        // A rewritten archive is re-read.
        write_zip(&zip, &[("only.txt", "1")]);
        let f = File::options().write(true).open(&zip).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(names(""), vec![("only.txt".into(), EntryKind::File)]);
    }

    #[test]
    fn read_dir_and_load_text_go_through_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp.path().join("lib-sources.jar");
        write_zip(&jar, &[("org/x/A.java", "class A {}\n"), ("org/x/B.class", "\0\0bin")]);
        let root = crate::read_dir(&archive_root(&jar), &[]).unwrap();
        assert_eq!(root.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["org"]);
        assert_eq!(crate::read_dir(&jar, &[]).unwrap().len(), 1, "the archive file itself lists its root");
        let a = crate::load_text(&archive_entry_path(&jar, "org/x/A.java")).unwrap();
        assert_eq!((a.text.as_str(), a.encoding.as_str(), a.binary), ("class A {}\n", "utf-8", false));
        assert!(crate::load_text(&archive_entry_path(&jar, "org/x/B.class")).unwrap().binary);
        let gbk = crate::load_text_as(&archive_entry_path(&jar, "org/x/A.java"), "gbk").unwrap();
        assert_eq!(gbk.encoding, "gbk");
        let probe = crate::probe(&archive_entry_path(&jar, "org/x/B.class")).unwrap();
        assert!(probe.binary && probe.size == 5);
        let range = crate::read_range(&archive_entry_path(&jar, "org/x/A.java"), 6, 3).unwrap();
        assert_eq!((range.offset, range.data.as_str(), range.total), (6, crate::base64(b"A {").as_str(), 11));
    }
}
