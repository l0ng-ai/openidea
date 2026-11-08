//! Capability checks for host functions that touch the file system.

use ide_extension::Capability;
use std::path::{Path, PathBuf};

/// Largest file `read-file` returns.
/// The most entries `fs.read-dir` hands over: the same cap as `find-files`.
pub const MAX_LIST_ENTRIES: usize = 4096;

pub const MAX_READ_BYTES: u64 = 16 << 20;
/// The largest file s.write may write, in bytes.
pub const MAX_WRITE_BYTES: usize = 16 << 20;

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
pub fn resolve_real(joined: &Path) -> PathBuf {
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
/// A file that does not exist yet cannot be canonicalized, so its directory is
/// canonicalized instead and the name appended; an existing file (or link) is
/// followed first, so a link cannot be used to write outside the grant.
pub fn resolve_writable(granted: &[Capability], path: &str) -> Result<PathBuf, Refusal> {
    resolve(granted, path, Wanted::Write)
}

fn resolve(granted: &[Capability], path: &str, wanted: Wanted) -> Result<PathBuf, Refusal> {
    let asked = expand_tilde(path);
    if !asked.is_absolute() {
        return Err(Refusal::Invalid(format!("{path}: use an absolute path (or ~/…)")));
    }
    let real = match wanted {
        Wanted::Read => asked.canonicalize().map_err(|_| Refusal::Invalid(format!("{path}: no such file")))?,
        Wanted::Write => asked
            .canonicalize()
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
        let base = match expand_tilde(base).canonicalize() {
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

/// Where `asked` would be created: its directory, resolved, plus its name.
fn resolve_unsaved(asked: &Path) -> Result<PathBuf, String> {
    let name = asked.file_name().ok_or_else(|| "not a file name".to_string())?;
    let parent = asked.parent().ok_or_else(|| "no directory to put it in".to_string())?;
    let dir = parent.canonicalize().map_err(|_| "its directory does not exist".to_string())?;
    Ok(dir.join(name))
}

/// `\\?\C:\…` (what `canonicalize` returns on Windows) as `C:\…`.
fn strip_verbatim(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
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

    /// The grant a manifest author would write for `dir`: the plain path, no
    /// `\\?\` prefix.
    fn grant_for(dir: &Path) -> Capability {
        Capability::FsRead(strip_verbatim(&dir.canonicalize().unwrap()))
    }

    fn text_at(dir: &Path, name: &str, body: &str) -> PathBuf {
        let file = dir.join(name);
        std::fs::write(&file, body).unwrap();
        file.canonicalize().unwrap()
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
}
