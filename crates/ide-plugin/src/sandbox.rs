//! Capability checks for host functions that touch the file system.

use ide_core::real_path::reaches_git_dir;
pub use ide_core::real_path::resolve_real;
use ide_extension::Capability;
use std::path::{Component, Path, PathBuf, Prefix};

/// Largest file `read-file` returns.
/// The most entries `fs.read-dir` hands over: the same cap as `find-files`.
pub const MAX_LIST_ENTRIES: usize = 4096;

pub const MAX_READ_BYTES: u64 = 16 << 20;
/// The largest file s.write may write, in bytes.
pub const MAX_WRITE_BYTES: usize = 16 << 20;

/// What a requested path is, judged from its text alone — before anything opens it. On
/// Windows even resolving a path opens it, and opening a network or pipe path connects to
/// that host or pipe, so every resolver asks this first and checks the real path after.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lexical {
    /// A local path, or a network path under one of the allowed bases.
    Resolvable,
    /// A network path outside every allowed base.
    Outside,
    /// A device, pipe or file stream, which is never a file a plugin may use.
    Refused,
}

/// Judges `path` against `bases` (absolute paths a resolver allows) from the text alone.
fn judge(path: &Path, bases: &[&Path]) -> Lexical {
    let Some((parts, remote)) = lexical_parts(path) else {
        return Lexical::Refused;
    };
    let under =
        |base: &&Path| base.is_absolute() && lexical_parts(base).is_some_and(|(base, _)| parts.starts_with(&base));
    if remote && !bases.iter().any(under) { Lexical::Outside } else { Lexical::Resolvable }
}

/// `path` split into comparable parts, `.` and `..` applied, a verbatim drive or share
/// spelled like the plain one and, on Windows, case-folded; with whether it names a network
/// location. `None` for a device or pipe (`\\.\…`, `\\?\GLOBALROOT\…`, `NUL`, `COM1`) or an
/// NTFS stream (`a.txt:s`).
fn lexical_parts(path: &Path) -> Option<(Vec<String>, bool)> {
    let mut parts = Vec::new();
    let mut remote = false;
    let mut anchored = 0;
    for part in path.components() {
        match part {
            Component::Prefix(prefix) => {
                parts.push(match prefix.kind() {
                    Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => format!("{}:", char::from(drive)),
                    Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                        remote = true;
                        format!(r"\\{}\{}", server.to_string_lossy(), share.to_string_lossy())
                    }
                    Prefix::Verbatim(_) | Prefix::DeviceNS(_) => return None,
                });
                anchored = parts.len();
            }
            Component::RootDir => {
                parts.push(std::path::MAIN_SEPARATOR_STR.to_owned());
                anchored = parts.len();
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.len() > anchored {
                    parts.pop();
                }
            }
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if cfg!(windows) && (name.contains(':') || names_device(&name)) {
                    return None;
                }
                parts.push(name.into_owned());
            }
        }
    }
    if cfg!(windows) {
        parts.iter_mut().for_each(|part| *part = part.to_lowercase());
    }
    Some((parts, remote))
}

/// A name Windows opens as a device in every folder (`NUL`, `COM1`, `con.txt`): what comes
/// before the first `.`, trailing spaces ignored.
fn names_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")).is_some_and(|number| {
            matches!(number, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        }),
    }
}

fn refused(path: &str) -> String {
    format!("{path}: devices, pipes and file streams are not allowed")
}

/// The canonical `root` and the absolute form of `path` (absolute, or relative to `root`) —
/// before any symlink or existence check — when [`judge`] lets it be resolved inside `root`.
/// `Ok(None)` for a network path outside `root`.
fn joined_path(root: &Path, path: &str) -> Result<Option<(PathBuf, PathBuf)>, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let real_root = dunce::canonicalize(root).map_err(|e| format!("project root unavailable: {e}"))?;
    let requested = Path::new(path);
    let joined = if requested.is_absolute() { requested.to_path_buf() } else { real_root.join(requested) };
    match judge(&joined, &[root, &real_root]) {
        Lexical::Resolvable => Ok(Some((real_root, joined))),
        Lexical::Outside => Ok(None),
        Lexical::Refused => Err(refused(path)),
    }
}

/// Resolves `path` (absolute, or relative to `root`) and checks that the real
/// path — after following `..` and symlinks — stays inside `root`.
pub fn resolve_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let Some((root, joined)) = joined_path(root, path)? else {
        return Err(format!("{path}: access outside the project root is not allowed"));
    };
    let real = dunce::canonicalize(&joined).map_err(|_| format!("{path}: no such file"))?;
    if !real.starts_with(&root) {
        return Err(format!("{path}: access outside the project root is not allowed"));
    }
    Ok(real)
}

/// [`resolve_in_root`] over several roots: the project root and, for a project
/// window group, its member roots. `roots` is tried in order (the project root
/// first), and the first root that contains `path` wins; a relative path may
/// name a file of any member. When no root contains it, the project root's
/// refusal is the error, as if there had been no members at all.
pub fn resolve_in_roots(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let (project_root, members) = match roots.split_first() {
        Some((project_root, members)) => (project_root, members),
        None => return Err(format!("{path}: no such file")),
    };
    match resolve_in_root(project_root, path) {
        Ok(real) => Ok(real),
        Err(project_root_error) => {
            for root in members {
                if let Ok(real) = resolve_in_root(root, path) {
                    return Ok(real);
                }
            }
            Err(project_root_error)
        }
    }
}

/// Whether `path` (absolute, or relative to `root`) lands inside `root`,
/// without requiring it to exist: `Ok(true)` also for a missing path, so
/// callers distinguish "outside" from "absent". Existing symlinks are
/// followed; a missing tail is judged at its would-be location.
pub fn inside_root(root: &Path, path: &str) -> Result<bool, String> {
    let Some((root, joined)) = joined_path(root, path)? else {
        return Ok(false);
    };
    Ok(resolve_real(&joined).starts_with(&root))
}

/// [`inside_root`] over several roots, as [`resolve_in_roots`] does: a path is
/// inside when any of them contains it.
pub fn inside_roots(roots: &[PathBuf], path: &str) -> Result<bool, String> {
    let Some((project_root, members)) = roots.split_first() else {
        return Ok(false);
    };
    if inside_root(project_root, path)? {
        return Ok(true);
    }
    for root in members {
        if inside_root(root, path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The most specific of `roots` containing `path` (absolute, and possibly not existing yet),
/// judged where it really lands. A network path outside every root is not resolved at all.
pub(crate) fn innermost_root(roots: Vec<PathBuf>, path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let roots: Vec<(PathBuf, PathBuf)> = roots
        .into_iter()
        .map(|root| {
            let real = resolve_real(&root);
            (root, real)
        })
        .collect();
    let bases: Vec<&Path> = roots.iter().flat_map(|(root, real)| [root.as_path(), real.as_path()]).collect();
    if judge(path, &bases) != Lexical::Resolvable {
        return None;
    }
    let real = resolve_real(path);
    roots
        .into_iter()
        .filter(|(_, root)| real.starts_with(root))
        .map(|(root, _)| root)
        .max_by_key(|root| root.components().count())
}

/// Like [`resolve_in_root`] for a path that may not exist yet (a file about to
/// be created) or that names a symlink itself (to delete or rename it): the
/// directory part is resolved through symlinks, the final name is kept as is,
/// and the result must stay inside `root`.
pub fn resolve_new_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let outside = || format!("{path}: access outside the project root is not allowed");
    let Some((root, joined)) = joined_path(root, path)? else {
        return Err(outside());
    };
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
    let mut real = dunce::canonicalize(existing).map_err(|e| format!("{path}: {e}"))?;
    real.extend(missing.into_iter().rev());
    real.push(name);
    if !real.starts_with(&root) {
        return Err(outside());
    }
    if reaches_git_dir(&root, &real) {
        return Err(format!("{path}: writing git's own files is not allowed"));
    }
    Ok(real)
}

/// Resolves a content write's destination, including existing and dangling
/// symlinks in the final component. Entry operations use [`resolve_new_in_root`].
pub fn resolve_writable_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let Some((root, joined)) = joined_path(root, path)? else {
        return Err(format!("{path}: access outside the project root is not allowed"));
    };
    let real = resolve_write_target(&joined, 40).map_err(|e| format!("{path}: {e}"))?;
    if !real.starts_with(&root) {
        return Err(format!("{path}: access outside the project root is not allowed"));
    }
    if reaches_git_dir(&root, &real) {
        return Err(format!("{path}: writing git's own files is not allowed"));
    }
    Ok(real)
}

/// [`resolve_writable_in_root`] over several roots, as [`resolve_in_roots`] does.
pub fn resolve_writable_in_roots(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    first_root_resolving(roots, path, resolve_writable_in_root)
}

/// [`resolve_new_in_root`] over several roots, as [`resolve_in_roots`] does.
pub fn resolve_new_in_roots(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    first_root_resolving(roots, path, resolve_new_in_root)
}

/// `resolve` against the project root, then each member; the project root's refusal when none
/// accepts `path`.
fn first_root_resolving(
    roots: &[PathBuf],
    path: &str,
    resolve: fn(&Path, &str) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let Some((project_root, members)) = roots.split_first() else {
        return Err(format!("{path}: access outside the project root is not allowed"));
    };
    resolve(project_root, path)
        .or_else(|refusal| members.iter().find_map(|root| resolve(root, path).ok()).ok_or(refusal))
}

fn resolve_write_target(path: &Path, links_left: usize) -> Result<PathBuf, std::io::Error> {
    match dunce::canonicalize(path) {
        Ok(real) => return Ok(real),
        Err(error) => match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_symlink() => {
                if links_left == 0 {
                    return Err(std::io::Error::other("too many symbolic links"));
                }
                let target = std::fs::read_link(path)?;
                let target = if target.is_absolute() { target } else { path.parent().unwrap().join(target) };
                return resolve_write_target(&target, links_left - 1);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(error),
        },
    }
    let parent = path.parent().ok_or_else(|| std::io::Error::other("no directory to put it in"))?;
    let mut real = resolve_write_target(parent, links_left)?;
    match path.components().next_back() {
        Some(std::path::Component::ParentDir) => {
            real.pop();
        }
        Some(std::path::Component::Normal(name)) => real.push(name),
        _ => {}
    }
    if real != path { resolve_write_target(&real, links_left) } else { Ok(real) }
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

/// Reads the bytes of a file that `resolve_in_root` already approved: binary
/// content is fine, the size cap is the same as [`read_text`]'s.
pub fn read_bytes(real: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{}: not a file", real.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{}: file is larger than {} MiB", real.display(), MAX_READ_BYTES >> 20));
    }
    std::fs::read(real).map_err(|e| e.to_string())
}

/// Why a read outside the project was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No `fs.read:<path>` grant covers the file; names the capability to declare.
    Denied(String),
    /// The path cannot be read as asked.
    Invalid(String),
}

/// Expands a leading `~` or `~/` to the user's home; everything else as written.
fn expand_tilde(path: &str) -> PathBuf {
    let rest = if path == "~" {
        Some("")
    } else if let Some(rest) = path.strip_prefix("~/") {
        Some(rest)
    } else {
        path.strip_prefix("~\\")
    };
    match rest {
        Some(rest) => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

/// Which grant a path is resolved against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wanted {
    Read,
    Write,
}

impl Wanted {
    fn capability(self, plain: String) -> Capability {
        match self {
            Self::Read => Capability::FsRead(plain),
            Self::Write => Capability::FsWrite(plain),
        }
    }

    /// `fs.read` / `fs.write`, for messages.
    fn prefix(self) -> &'static str {
        match self {
            Self::Read => "fs.read",
            Self::Write => "fs.write",
        }
    }
}

/// The real path of `path` when an `fs.read:<path>` grant covers it.
///
/// The grant is compared with the **real** path, so a symlink pointing out of
/// a granted tree is refused, and `fs.read:/srv/app` covers `/srv/app/x` but
/// not `/srv/application`. Windows' `\\?\` prefix (what `canonicalize` adds)
/// is stripped from the file side so a manifest may spell `C:\Program Files\X`.
pub fn resolve_granted(granted: &[Capability], path: &str) -> Result<PathBuf, Refusal> {
    resolve(granted, path, Wanted::Read)
}

/// The real path `path` would be written to, when an `fs.write:<path>` grant
/// covers it.
///
/// Missing paths and dangling links are resolved to their target location;
/// an existing file (or link) is followed first. The destination's directory
/// must exist.
pub fn resolve_writable(granted: &[Capability], path: &str) -> Result<PathBuf, Refusal> {
    resolve(granted, path, Wanted::Write)
}

fn resolve(granted: &[Capability], path: &str, wanted: Wanted) -> Result<PathBuf, Refusal> {
    let asked = expand_tilde(path);
    if !asked.is_absolute() {
        return Err(Refusal::Invalid(format!("{path}: use an absolute path (or ~/…)")));
    }
    let bases: Vec<PathBuf> = granted
        .iter()
        .filter_map(|grant| match (wanted, grant) {
            (Wanted::Read, Capability::FsRead(base)) | (Wanted::Write, Capability::FsWrite(base)) => {
                Some(expand_tilde(base))
            }
            _ => None,
        })
        .flat_map(|base| [dunce::canonicalize(&base).ok(), Some(base)])
        .flatten()
        .collect();
    match judge(&asked, &bases.iter().map(PathBuf::as_path).collect::<Vec<_>>()) {
        Lexical::Resolvable => {}
        Lexical::Outside => return Err(Refusal::Denied(wanted.capability(strip_verbatim(&asked)).to_string())),
        Lexical::Refused => return Err(Refusal::Invalid(refused(path))),
    }
    let real = match wanted {
        Wanted::Read => dunce::canonicalize(&asked).map_err(|_| Refusal::Invalid(format!("{path}: no such file")))?,
        Wanted::Write => dunce::canonicalize(&asked)
            .or_else(|_| resolve_unsaved(&asked))
            .map_err(|e| Refusal::Invalid(format!("{path}: {e}")))?,
    };
    let plain = strip_verbatim(&real);
    let cap = wanted.capability(plain.clone());
    let mut covered = false;
    for grant in granted {
        let base = match (wanted, grant) {
            (Wanted::Read, Capability::FsRead(base)) | (Wanted::Write, Capability::FsWrite(base)) => base,
            _ => continue,
        };
        // The grant is compared where it really is too: `/tmp/x` is `/private/tmp/x`
        // on macOS, and `~` is the home directory.
        let base = match dunce::canonicalize(expand_tilde(base)) {
            Ok(real) => strip_verbatim(&real),
            Err(_) => strip_verbatim(&expand_tilde(base)),
        };
        if !wanted.capability(base.clone()).covers(&cap) {
            continue;
        }
        // A directory that is its own parent is a root: `/`, `C:\`.
        if Path::new(&base).parent().is_none() {
            return Err(Refusal::Invalid(format!(
                "{plain}: {}:{base} covers a whole file system; declare a directory",
                wanted.prefix()
            )));
        }
        covered = true;
    }
    if covered { Ok(real) } else { Err(Refusal::Denied(cap.to_string())) }
}

/// Where `asked` would be created, including a dangling link's target.
fn resolve_unsaved(asked: &Path) -> Result<PathBuf, String> {
    let real = resolve_write_target(asked, 40).map_err(|e| e.to_string())?;
    let parent = real.parent().ok_or_else(|| "no directory to put it in".to_string())?;
    if !parent.is_dir() {
        return Err("its directory does not exist".into());
    }
    Ok(real)
}

/// Simplifies Windows drive paths only when the plain form preserves their meaning.
fn strip_verbatim(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::real_path::names_git_dir;

    #[cfg(windows)]
    #[test]
    fn grant_paths_simplify_drive_paths_and_preserve_unc_prefixes() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\project\a.txt")), r"C:\project\a.txt");
        for path in [r"C:\project\a.txt", r"\\?\UNC\server\share\a.txt", r"\\server\share\a.txt"] {
            assert_eq!(strip_verbatim(Path::new(path)), path);
        }
    }

    #[cfg(windows)]
    #[test]
    fn resolvers_return_plain_paths_for_plain_and_verbatim_inputs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.txt"), "text").unwrap();
        let plain = dunce::canonicalize(&root).unwrap();
        let verbatim = std::fs::canonicalize(&root).unwrap();
        assert_ne!(plain, verbatim);
        let file = plain.join("a.txt");
        let missing = plain.join("new/deep/a.txt");
        for root in [&plain, &verbatim] {
            for path in ["a.txt", file.to_str().unwrap(), verbatim.join("a.txt").to_str().unwrap()] {
                assert_eq!(resolve_in_root(root, path).unwrap(), file);
                assert_eq!(resolve_new_in_root(root, path).unwrap(), file);
                assert!(inside_root(root, path).unwrap());
            }
            for path in ["new/deep/a.txt", missing.to_str().unwrap(), verbatim.join("new/deep/a.txt").to_str().unwrap()]
            {
                assert_eq!(resolve_new_in_root(root, path).unwrap(), missing);
                assert_eq!(resolve_real(&root.join(path)), missing);
                assert!(inside_root(root, path).unwrap());
            }
            let outside = tmp.path().join("outside.txt");
            std::fs::write(&outside, "secret").unwrap();
            assert!(resolve_in_root(root, outside.to_str().unwrap()).is_err());
            assert!(resolve_new_in_root(root, outside.to_str().unwrap()).is_err());
        }
        for root in [&plain, &verbatim] {
            let read = Capability::FsRead(root.to_string_lossy().into_owned());
            let write = Capability::FsWrite(root.to_string_lossy().into_owned());
            for path in [file.clone(), verbatim.join("a.txt")] {
                assert_eq!(resolve_granted(std::slice::from_ref(&read), path.to_str().unwrap()).unwrap(), file);
                assert_eq!(resolve_writable(std::slice::from_ref(&write), path.to_str().unwrap()).unwrap(), file);
            }
            for path in [plain.join("new.txt"), verbatim.join("new.txt")] {
                assert_eq!(
                    resolve_writable(std::slice::from_ref(&write), path.to_str().unwrap()).unwrap(),
                    plain.join("new.txt")
                );
            }
        }
    }

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

    /// A project window group: the container root and its member roots.
    fn group(tmp: &tempfile::TempDir) -> (PathBuf, PathBuf, Vec<PathBuf>) {
        let container = tmp.path().join("workspace");
        let alpha = tmp.path().join("alpha");
        let beta = tmp.path().join("beta");
        for dir in [&container, &alpha, &beta] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let container = dunce::canonicalize(container).unwrap();
        let alpha = dunce::canonicalize(alpha).unwrap();
        let beta = dunce::canonicalize(beta).unwrap();
        (container, alpha.clone(), vec![alpha, beta])
    }

    #[test]
    fn member_roots_accept_their_files_and_the_container_still_confines() {
        let tmp = tempfile::tempdir().unwrap();
        let (container, alpha, members) = group(&tmp);
        std::fs::create_dir_all(container.join("src")).unwrap();
        std::fs::write(container.join("src/notes.txt"), "hi").unwrap();
        std::fs::create_dir_all(alpha.join("src")).unwrap();
        let member_file = alpha.join("src/mapper.xml");
        std::fs::write(&member_file, "hi").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();
        let roots = [container.clone()].iter().cloned().chain(members.clone()).collect::<Vec<_>>();

        // A member's absolute file resolves through its member root.
        assert_eq!(resolve_in_roots(&roots, member_file.to_str().unwrap()).unwrap(), member_file);
        // The container's own files still resolve as before.
        let container_file = container.join("src/notes.txt");
        assert_eq!(resolve_in_roots(&roots, "src/notes.txt").unwrap(), container_file);
        // A missing path is `no such file`, wherever it would land.
        let gone = container_file.with_file_name("gone.txt");
        assert_eq!(
            resolve_in_roots(&roots, gone.to_str().unwrap()).unwrap_err(),
            format!("{}: no such file", gone.display())
        );
        // Outside every root is refused with the container's refusal.
        let outside = tmp.path().join("secret.txt");
        let err = resolve_in_roots(&roots, outside.to_str().unwrap()).unwrap_err();
        assert!(err.contains("outside the project root"), "{err}");
        let err = resolve_in_roots(&roots, "../secret.txt").unwrap_err();
        assert!(err.contains("outside the project root"), "{err}");
        // `inside_roots` accepts member paths, including missing ones, and
        // refuses what no root contains.
        assert!(inside_roots(&roots, member_file.to_str().unwrap()).unwrap());
        assert!(inside_roots(&roots, "missing/one.txt").unwrap());
        assert!(inside_roots(&roots, alpha.join("src/new.xml").to_str().unwrap()).unwrap());
        assert!(!inside_roots(&roots, outside.to_str().unwrap()).unwrap());
        // No members: exactly the single-root behaviour.
        let single = [container.clone()];
        assert_eq!(resolve_in_roots(&single, "src/notes.txt").unwrap(), container_file);
        assert!(!inside_roots(&single, member_file.to_str().unwrap()).unwrap());
    }

    #[test]
    fn new_and_writable_paths_accept_members() {
        let tmp = tempfile::tempdir().unwrap();
        let (container, alpha, members) = group(&tmp);
        std::fs::create_dir_all(container.join("src")).unwrap();
        std::fs::create_dir_all(alpha.join("src")).unwrap();
        let roots = [container.clone()].iter().cloned().chain(members.iter().cloned()).collect::<Vec<_>>();

        let member_new = alpha.join("src/new.xml");
        assert_eq!(resolve_writable_in_roots(&roots, member_new.to_str().unwrap()).unwrap(), member_new);
        let container_new = container.join("src/new.txt");
        assert_eq!(resolve_writable_in_roots(&roots, "src/new.txt").unwrap(), container_new);
        let outside = tmp.path().join("escape.txt");
        let err = resolve_writable_in_roots(&roots, outside.to_str().unwrap()).unwrap_err();
        assert!(err.contains("outside the project root"), "{err}");
        let err = resolve_writable_in_roots(&roots, "../../escape.txt").unwrap_err();
        assert!(err.contains("outside the project root"), "{err}");
    }

    #[test]
    fn new_paths_are_confined_to_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_real = dunce::canonicalize(&root).unwrap();

        assert_eq!(resolve_new_in_root(&root, "src/new/a.txt").unwrap(), root_real.join("src/new/a.txt"));
        assert_eq!(resolve_new_in_root(&root, "src/../b.txt").unwrap(), root_real.join("b.txt"));
        assert!(resolve_new_in_root(&root, "../x.txt").unwrap_err().contains("outside"));
        assert!(resolve_new_in_root(&root, "src/../../x.txt").unwrap_err().contains("outside"));
        assert!(resolve_new_in_root(&root, "/etc/new.txt").is_err());
        assert!(resolve_new_in_root(&root, "").is_err());
    }

    /// Advisory #4: a content write may not reach git's own `.git` metadata, which git runs as
    /// code (hooks, `gpg.program`, filters). The `.git` folder is inside the project root, so the
    /// root confinement alone does not stop it.
    #[test]
    fn writes_cannot_reach_git_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(root.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".git/config"), "[core]\n").unwrap();
        // An ordinary write is fine; each refusal below is the `.git` rule.
        assert!(resolve_new_in_root(&root, "src/ok.txt").is_ok());
        assert!(resolve_writable_in_root(&root, "src/ok.txt").is_ok());
        for rel in [
            ".git/config",
            ".git/hooks/pre-commit",
            ".GIT/config",
            "src/../.git/config",
            ".git./config",
            ".git /config",
        ] {
            assert!(resolve_new_in_root(&root, rel).unwrap_err().contains("git's own files"), "new: {rel}");
            assert!(resolve_writable_in_root(&root, rel).unwrap_err().contains("git's own files"), "writable: {rel}");
        }
        assert!(names_git_dir(Path::new("a/.git/b")));
        assert!(!names_git_dir(Path::new("a/git/b")));
        assert!(!names_git_dir(Path::new(".github/workflows/ci.yml")));
    }

    #[test]
    fn git_folder_is_recognised_under_every_spelling_that_opens_it() {
        for path in [
            "proj/.git/hooks/pre-commit",
            "proj/.git/config",
            "proj/sub/.git",
            "proj/.GIT/config",
            "proj/.git./config",
            "proj/.git /config",
            "proj/.git::$INDEX_ALLOCATION/config",
        ] {
            assert!(names_git_dir(Path::new(path)), "{path}");
        }
        for path in ["proj/.gitignore", "proj/.github/workflows/ci.yml", "proj/src/git/.gitkeep", "proj/a.git/x"] {
            assert!(!names_git_dir(Path::new(path)), "{path}");
        }
        // A project opened from inside a git folder is git's own files all the way down.
        assert!(names_git_dir(Path::new("repo/.git/modules/lib/hooks/pre-commit")));
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
        let root_real = dunce::canonicalize(&root).unwrap();

        assert_eq!(resolve_new_in_root(&root, "link.txt").unwrap(), root_real.join("link.txt"));
        assert!(resolve_new_in_root(&root, "out/x.txt").unwrap_err().contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn writable_paths_follow_existing_and_dangling_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir(&root).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "unchanged").unwrap();
        std::fs::write(root.join("inside.txt"), "before").unwrap();
        for (name, target) in [
            ("outside", outside.clone()),
            ("dangling-outside", tmp.path().join("missing.txt")),
            ("inside", PathBuf::from("inside.txt")),
            ("dangling-inside", PathBuf::from("new/deep.txt")),
            ("chain", PathBuf::from("dangling-outside")),
            ("cycle", PathBuf::from("cycle")),
        ] {
            symlink(target, root.join(name)).unwrap();
        }
        for name in ["outside", "dangling-outside", "chain"] {
            assert!(resolve_writable_in_root(&root, name).unwrap_err().contains("outside the project root"));
            assert!(
                resolve_writable_in_root(&root, &format!("missing/../{name}"))
                    .unwrap_err()
                    .contains("outside the project root")
            );
        }
        assert!(resolve_writable_in_root(&root, "cycle").is_err());
        let inside = resolve_writable_in_root(&root, "inside").unwrap();
        assert_eq!(inside, root.join("inside.txt"));
        std::fs::write(inside, "after").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("inside.txt")).unwrap(), "after");
        assert_eq!(resolve_writable_in_root(&root, "dangling-inside").unwrap(), root.join("new/deep.txt"));
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
        assert!(!tmp.path().join("missing.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn writable_grants_confine_dangling_symlink_targets() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("granted");
        std::fs::create_dir(&root).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let grant = Capability::FsWrite(strip_verbatim(&root));
        symlink("../missing.txt", root.join("outside")).unwrap();
        symlink("new.txt", root.join("inside")).unwrap();
        assert!(matches!(
            resolve_writable(std::slice::from_ref(&grant), root.join("outside").to_str().unwrap()),
            Err(Refusal::Denied(_))
        ));
        assert_eq!(resolve_writable(&[grant], root.join("inside").to_str().unwrap()).unwrap(), root.join("new.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn entry_operations_do_not_follow_outside_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        std::fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "unchanged").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let from = resolve_new_in_root(&root, "link").unwrap();
        let to = resolve_new_in_root(&root, "renamed").unwrap();
        std::fs::rename(&from, &to).unwrap();
        assert!(!from.try_exists().unwrap());
        assert!(std::fs::symlink_metadata(&to).unwrap().is_symlink());
        std::fs::remove_file(resolve_new_in_root(&root, "renamed").unwrap()).unwrap();
        assert!(std::fs::symlink_metadata(&to).is_err());
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
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

    #[test]
    fn read_bytes_returns_the_exact_bytes_up_to_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        // The bytes binary files carry survive, where read_text refuses them.
        let binary = [0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x1b];
        std::fs::write(tmp.path().join("b.bin"), binary).unwrap();
        let p = resolve_in_root(tmp.path(), "b.bin").unwrap();
        assert_eq!(read_bytes(&p).unwrap(), binary);
        // A directory is not a file; the size cap is read_text's.
        assert!(read_bytes(&resolve_in_root(tmp.path(), ".").unwrap()).unwrap_err().contains("not a file"));
        let big = tmp.path().join("big.bin");
        std::fs::write(&big, vec![0u8; (MAX_READ_BYTES + 1) as usize]).unwrap();
        let err = read_bytes(&big).unwrap_err();
        assert!(err.contains("larger than"), "{err}");
        let at_cap = tmp.path().join("at-cap.bin");
        std::fs::write(&at_cap, vec![7u8; MAX_READ_BYTES as usize]).unwrap();
        assert_eq!(read_bytes(&at_cap).unwrap().len(), MAX_READ_BYTES as usize);
    }

    /// The grant a manifest author would write for `dir`: the plain path, no
    /// `\\?\` prefix.
    fn grant_for(dir: &Path) -> Capability {
        Capability::FsRead(strip_verbatim(&dunce::canonicalize(dir).unwrap()))
    }

    fn text_at(dir: &Path, name: &str, body: &str) -> PathBuf {
        let file = dir.join(name);
        std::fs::write(&file, body).unwrap();
        dunce::canonicalize(file).unwrap()
    }

    #[test]
    fn a_file_outside_every_grant_is_denied_naming_the_capability() {
        let tmp = tempfile::tempdir().unwrap();
        let file = text_at(tmp.path(), "app.properties", "name=YonBIP\n");
        let err = resolve_granted(&[], file.to_str().unwrap()).unwrap_err();
        match err {
            Refusal::Denied(cap) => assert!(cap.starts_with("fs.read:"), "{cap}"),
            other => panic!("expected denied, got {other:?}"),
        }
        // A grant on another tree does not cover it either.
        let elsewhere = tempfile::tempdir().unwrap();
        let err = resolve_granted(&[grant_for(elsewhere.path())], file.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, Refusal::Denied(_)), "{err:?}");
    }

    #[test]
    fn a_grant_covers_what_is_under_it_but_not_a_sibling_with_its_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let granted = tmp.path().join("seeyon");
        std::fs::create_dir_all(granted.join("conf")).unwrap();
        let file = text_at(&granted.join("conf"), "server.xml", "<server/>");
        let cap = grant_for(&granted);

        assert_eq!(resolve_granted(std::slice::from_ref(&cap), file.to_str().unwrap()).unwrap(), file);
        // The directory itself, asked for explicitly, is covered too.
        assert!(resolve_granted(std::slice::from_ref(&cap), granted.to_str().unwrap()).is_ok());

        // `/x/seeyon` must not cover `/x/seeyon-old/app.properties`.
        let sibling = tmp.path().join("seeyon-old");
        std::fs::create_dir_all(&sibling).unwrap();
        let other = text_at(&sibling, "app.properties", "x=1");
        assert!(matches!(resolve_granted(&[cap], other.to_str().unwrap()), Err(Refusal::Denied(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_grant_declared_through_a_symlinked_directory_covers_its_files() {
        // `/tmp/tool` on macOS is `/private/tmp/tool`: the grant is resolved too.
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let file = text_at(&real, "a.txt", "a");
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let cap = Capability::FsRead(link.to_string_lossy().into_owned());
        assert!(resolve_granted(std::slice::from_ref(&cap), link.join("a.txt").to_str().unwrap()).is_ok());
        assert!(resolve_granted(&[cap], file.to_str().unwrap()).is_ok());
    }

    #[test]
    fn a_granted_symlink_target_must_still_be_covered() {
        // The grant is compared with the real path, so a link inside a granted
        // tree cannot be used to read outside it.
        let tmp = tempfile::tempdir().unwrap();
        let granted = tmp.path().join("granted");
        std::fs::create_dir_all(&granted).unwrap();
        let secret = text_at(tmp.path(), "secret.txt", "s");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, granted.join("link")).unwrap();
            let cap = grant_for(&granted);
            let err = resolve_granted(&[cap], granted.join("link").to_str().unwrap()).unwrap_err();
            assert!(matches!(err, Refusal::Denied(_)), "{err:?}");
        }
        #[cfg(windows)]
        {
            // Creating symlinks needs a privilege tests do not have; hard links
            // to the same file are covered by the parent directory anyway, so
            // only the textual check is exercised here.
            let _ = secret;
            assert!(resolve_granted(&[grant_for(&granted)], granted.to_str().unwrap()).is_ok());
        }
    }

    #[test]
    fn a_path_must_be_absolute_and_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let cap = grant_for(tmp.path());
        let err = resolve_granted(std::slice::from_ref(&cap), "app.properties").unwrap_err();
        assert!(matches!(err, Refusal::Invalid(ref m) if m.contains("absolute")), "{err:?}");
        let err = resolve_granted(&[cap], tmp.path().join("missing").to_str().unwrap()).unwrap_err();
        assert!(matches!(err, Refusal::Invalid(ref m) if m.contains("no such file")), "{err:?}");
    }

    #[test]
    fn a_root_grant_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let file = text_at(tmp.path(), "a.txt", "hi");
        #[cfg(windows)]
        let cap = Capability::FsRead(format!("{}\\", std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into())));
        #[cfg(unix)]
        let cap = Capability::FsRead("/".into());
        let err = resolve_granted(&[cap], file.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, Refusal::Invalid(ref m) if m.contains("whole file system")), "{err:?}");
    }

    #[test]
    fn a_tilde_starts_at_the_users_home() {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        if home.is_none() {
            return;
        }
        let expanded = expand_tilde("~/app.properties");
        assert!(expanded.is_absolute(), "{}", expanded.display());
        assert!(expanded.starts_with(home.unwrap()));
        assert_eq!(
            expand_tilde("~"),
            PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap())
        );
        assert_eq!(expand_tilde("relative/x"), PathBuf::from("relative/x"));
    }

    /// Resolving a path must not open what it names before the path is known to be allowed:
    /// on Windows, opening a pipe or network path (even only to canonicalize it) connects to
    /// that pipe or host. Streams and reserved device names are never project files.
    #[cfg(windows)]
    mod windows_paths {
        use super::*;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::net::windows::named_pipe::ServerOptions;

        /// Every spelling of the local pipe `name` that Windows opens: device, verbatim, object
        /// manager and network (through the SMB redirector, as a remote host would be reached).
        fn spellings(name: &str) -> [String; 6] {
            [
                format!(r"\\.\pipe\{name}"),
                format!(r"//./pipe/{name}"),
                format!(r"\\?\pipe\{name}"),
                format!(r"\\?\GLOBALROOT\Device\NamedPipe\{name}"),
                format!(r"\\127.0.0.1\pipe\{name}"),
                format!(r"\\?\UNC\127.0.0.1\pipe\{name}"),
            ]
        }

        /// Each resolver, as `(name, accepts root path)`.
        type Resolver = (&'static str, fn(&Path, &str) -> bool);

        const RESOLVERS: [Resolver; 11] = [
            ("resolve_in_root", |root, path| resolve_in_root(root, path).is_ok()),
            ("resolve_in_roots", |root, path| resolve_in_roots(&[root.to_path_buf()], path).is_ok()),
            ("inside_root", |root, path| inside_root(root, path).unwrap_or(false)),
            ("inside_roots", |root, path| inside_roots(&[root.to_path_buf()], path).unwrap_or(false)),
            ("resolve_new_in_root", |root, path| resolve_new_in_root(root, path).is_ok()),
            ("resolve_new_in_roots", |root, path| resolve_new_in_roots(&[root.to_path_buf()], path).is_ok()),
            ("resolve_writable_in_root", |root, path| resolve_writable_in_root(root, path).is_ok()),
            ("resolve_writable_in_roots", |root, path| resolve_writable_in_roots(&[root.to_path_buf()], path).is_ok()),
            ("resolve_granted", |root, path| resolve_granted(&[grant_for(root)], path).is_ok()),
            ("resolve_writable", |root, path| {
                resolve_writable(&[Capability::FsWrite(strip_verbatim(&dunce::canonicalize(root).unwrap()))], path)
                    .is_ok()
            }),
            ("project_of", |root, path| innermost_root(vec![root.to_path_buf()], Path::new(path)).is_some()),
        ];

        #[test]
        fn pipe_and_network_paths_are_refused_without_being_opened() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("project");
            std::fs::create_dir(&root).unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let _context = runtime.enter();
            let mut probes = Vec::new();
            for (resolver, accepts) in RESOLVERS {
                for spelling in 0..spellings("").len() {
                    let name = format!("openidea-sandbox-{}-{resolver}-{spelling}", std::process::id());
                    let server = ServerOptions::new().first_pipe_instance(true).create(format!(r"\\.\pipe\{name}"));
                    let server = server.unwrap();
                    let opened = Arc::new(AtomicBool::new(false));
                    let flag = opened.clone();
                    runtime.spawn(async move {
                        let _ = server.connect().await;
                        flag.store(true, Ordering::SeqCst);
                    });
                    let path = spellings(&name)[spelling].clone();
                    let accepted = accepts(&root, &path);
                    probes.push((resolver, path, accepted, opened));
                }
            }
            runtime.block_on(tokio::time::sleep(std::time::Duration::from_millis(500)));
            let failures: Vec<String> = probes
                .iter()
                .filter(|(_, _, accepted, opened)| *accepted || opened.load(Ordering::SeqCst))
                .map(|(resolver, path, accepted, opened)| {
                    format!("{resolver}({path}): accepted={accepted} opened={}", opened.load(Ordering::SeqCst))
                })
                .collect();
            assert!(failures.is_empty(), "{failures:#?}");
        }

        #[test]
        fn streams_and_device_names_are_refused() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("project");
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("a.txt"), "text").unwrap();
            let root = dunce::canonicalize(root).unwrap();
            let mut accepted = Vec::new();
            for rel in ["a.txt:hidden", "a.txt::$DATA", "NUL", "con.txt", "sub/COM1", "LPT1.log", "CONIN$"] {
                for path in [rel.to_owned(), root.join(rel).to_string_lossy().into_owned()] {
                    for (resolver, accepts) in RESOLVERS {
                        if accepts(&root, &path) {
                            accepted.push(format!("{resolver}({path})"));
                        }
                    }
                }
            }
            assert!(accepted.is_empty(), "{accepted:#?}");
        }

        #[test]
        fn a_share_path_is_resolved_only_under_a_root_on_that_share() {
            let root = Path::new(r"\\?\UNC\server\share\proj");
            for path in
                [r"\\server\share\proj\a.txt", r"\\SERVER\Share\Proj\src\..\a.txt", r"\\?\UNC\server\share\proj"]
            {
                assert_eq!(judge(Path::new(path), &[root]), Lexical::Resolvable, "{path}");
            }
            for path in [
                r"\\server\other\a.txt",
                r"\\elsewhere\share\proj\a.txt",
                r"\\server\share\proj\..\..\other\a.txt",
                r"\\server\share\project\a.txt",
            ] {
                assert_eq!(judge(Path::new(path), &[root]), Lexical::Outside, "{path}");
                assert_eq!(judge(Path::new(path), &[Path::new(r"C:\proj")]), Lexical::Outside, "{path}");
            }
            for path in [r"C:\proj\a.txt", r"\\?\C:\elsewhere\a.txt", r"D:\x"] {
                assert_eq!(judge(Path::new(path), &[root]), Lexical::Resolvable, "{path}");
            }
            assert_eq!(judge(Path::new(r"\\server\share\proj\a.txt:s"), &[root]), Lexical::Refused);
            assert!(!names_device("console.log") && !names_device("com10") && !names_device("aux_utils.rs"));
        }
    }
}
