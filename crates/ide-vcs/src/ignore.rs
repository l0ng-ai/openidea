//! Literal ignore rules for Project view's Git › Add to .gitignore.
use crate::{Repo, cli};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IgnoreDestination {
    Gitignore,
    LocalExclude,
}

struct IgnoreRule {
    pattern: String,
    relative: PathBuf,
    directory: bool,
}

/// Validate the whole selection before writing. Each destination is replaced atomically;
/// a failure in a later repository may leave earlier destinations updated (safe to retry).
/// Never modifies the index or a selected file.
pub fn add_to_ignore(paths: &[PathBuf], destination: IgnoreDestination) -> IdeResult<Vec<PathBuf>> {
    let mut edits: BTreeMap<PathBuf, Vec<IgnoreRule>> = BTreeMap::new();
    let mut verify = Vec::new();
    for path in paths {
        // Validate before filesystem access: APFS cannot even stat invalid UTF-8 names.
        path.to_str().ok_or_else(|| IdeError::invalid("Path is not UTF-8"))?;
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(IdeError::invalid("Select an absolute path without '..'"));
        }
        no_symlinks(path)?;
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_file() && !meta.is_dir() {
            return Err(IdeError::invalid("Only regular files and directories can be ignored"));
        }
        // A selected nested repository directory is an entry of its enclosing repository.
        let start = path.parent().ok_or_else(|| IdeError::invalid("Cannot ignore a filesystem root"))?;
        let repo = Repo::discover(start)?.ok_or_else(|| IdeError::invalid("Selection is not in a Git repository"))?;
        let rel =
            path.strip_prefix(repo.root()).map_err(|_| IdeError::invalid("Selection is outside its repository"))?;
        let literal = pattern(rel, meta.is_dir())?;
        if rel.components().any(|c| c.as_os_str() == ".git") {
            return Err(IdeError::invalid("Git administration files cannot be ignored"));
        }
        let rel_str = rel.to_str().ok_or_else(|| IdeError::invalid("Path is not UTF-8"))?;
        let tracked = cli::run(repo.root(), &["--literal-pathspecs", "ls-files", "-z", "--", rel_str], None)?;
        if !tracked.stdout.is_empty() {
            return Err(IdeError::invalid(format!(
                "{} contains tracked files. Ignore rules only affect unversioned files; no files were untracked.",
                path.display()
            )));
        }
        // check-ignore rejects --literal-pathspecs; a ./ prefix prevents pathspec
        // magic in valid filenames such as :(top)private from being interpreted.
        let literal_query = format!("./{rel_str}");
        let ignored = cli::run_raw(repo.root(), &["check-ignore", "-q", "--", &literal_query], None)?;
        match ignored.code {
            Some(0) => continue,
            Some(1) => {}
            _ => return Err(IdeError::invalid(ignored.stdout_str() + &String::from_utf8_lossy(&ignored.stderr))),
        }
        verify.push((repo.root().to_path_buf(), rel_str.to_owned()));
        let (file, rule, base) = match destination {
            IgnoreDestination::LocalExclude => {
                let output = cli::run(
                    repo.root(),
                    &["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
                    None,
                )?;
                // Strip only Git's output terminator; spaces are valid in the path.
                let raw = output.stdout_str();
                let file = crate::repo::absolute(Path::new(
                    raw.strip_suffix("\r\n").or_else(|| raw.strip_suffix('\n')).unwrap_or(&raw),
                ))?;
                let common = crate::repo::absolute(repo.gix()?.common_dir())?;
                if file != common.join("info/exclude") {
                    return Err(IdeError::invalid("Git returned an unexpected exclude path"));
                }
                (file, literal, repo.root())
            }
            IgnoreDestination::Gitignore => {
                let base = start
                    .ancestors()
                    .take_while(|p| p.starts_with(repo.root()))
                    .find(|p| p.join(".gitignore").symlink_metadata().is_ok())
                    .unwrap_or(repo.root());
                (base.join(".gitignore"), pattern(path.strip_prefix(base).unwrap(), meta.is_dir())?, base)
            }
        };
        no_symlinks(file.parent().unwrap())?;
        validate_file(&file)?;
        edits.entry(file).or_default().push(IgnoreRule {
            pattern: rule,
            relative: path.strip_prefix(base).unwrap().to_path_buf(),
            directory: meta.is_dir(),
        });
    }
    let mut changed = Vec::new();
    for (file, rules) in edits {
        append(&file, &rules).map_err(|e| {
            IdeError::new(
                e.kind,
                format!(
                    "Could not update {}: {}. Earlier destinations may have succeeded; refresh and retry.",
                    file.display(),
                    e.message
                ),
            )
        })?;
        changed.push(file);
    }
    for (root, rel) in verify {
        if cli::run_raw(&root, &["check-ignore", "-q", "--", &format!("./{rel}")], None)?.code != Some(0) {
            return Err(IdeError::invalid(format!(
                "Rule saved, but {rel} is still visible to Git. A higher-priority .gitignore rule may override it; edit that file and retry."
            )));
        }
    }
    Ok(changed)
}

fn pattern(path: &Path, directory: bool) -> IdeResult<String> {
    let mut rule = String::from("/");
    for (i, part) in path.components().enumerate() {
        let Component::Normal(part) = part else { return Err(IdeError::invalid("Unsafe ignore path")) };
        let part = part.to_str().ok_or_else(|| IdeError::invalid("Path is not UTF-8"))?;
        if part.contains(['\n', '\r', '\0']) {
            return Err(IdeError::invalid(
                "Paths containing a newline or NUL cannot be represented safely in an ignore file",
            ));
        }
        if i > 0 {
            rule.push('/');
        }
        for ch in part.chars() {
            if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '#' | '!' | ' ') {
                rule.push('\\');
            }
            rule.push(ch);
        }
    }
    if rule == "/" {
        return Err(IdeError::invalid("Cannot ignore a repository root"));
    }
    if directory {
        rule.push('/');
    }
    Ok(rule)
}

/// Refuse symlinked ancestors too: writing through them could affect another repository.
fn no_symlinks(path: &Path) -> IdeResult<()> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(IdeError::invalid(format!("Refusing symlink path: {}", part.display())));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn validate_file(file: &Path) -> IdeResult<()> {
    match fs::symlink_metadata(file) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            Err(IdeError::invalid("Ignore destination must be a regular file, not a symlink"))
        }
        Ok(m) if m.permissions().readonly() => {
            Err(IdeError::invalid(format!("{} is read-only; make it writable and retry", file.display())))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[derive(PartialEq, Eq)]
struct Snapshot {
    bytes: Vec<u8>,
    modified: Option<std::time::SystemTime>,
    permissions: fs::Permissions,
}

fn snapshot(file: &Path) -> IdeResult<Option<Snapshot>> {
    validate_file(file)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself rather than following a last-component link.
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    match options.open(file) {
        Ok(mut handle) => {
            let metadata = handle.metadata()?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(IdeError::invalid("Ignore destination must be a regular file"));
            }
            let mut bytes = Vec::new();
            handle.read_to_end(&mut bytes)?;
            Ok(Some(Snapshot { bytes, modified: metadata.modified().ok(), permissions: metadata.permissions() }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn append(file: &Path, rules: &[IgnoreRule]) -> IdeResult<()> {
    no_symlinks(file.parent().unwrap())?;
    fs::create_dir_all(file.parent().unwrap())?;
    // Conventional sibling lock: create_new never follows a preexisting symlink.
    let lock_path = file.with_file_name(format!("{}.lock", file.file_name().unwrap().to_string_lossy()));
    let lock = fs::OpenOptions::new().write(true).create_new(true).open(&lock_path);
    // Keep lock cleanup scoped to successfully acquired locks only.
    let _lock = Lock {
        file: lock.map_err(|_| {
            IdeError::invalid(format!("{} is locked or not writable; close other writers and retry", file.display()))
        })?,
        path: lock_path,
    };
    let before = snapshot(file)?;
    let bytes = before.as_ref().map(|s| s.bytes.as_slice()).unwrap_or_default();
    let text =
        std::str::from_utf8(bytes).map_err(|_| IdeError::invalid("Ignore file is not UTF-8; edit it manually"))?;
    if text.contains('\0') {
        return Err(IdeError::invalid("Ignore file contains NUL; edit it manually"));
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    // Identical text earlier in the file may have been overridden by a later
    // negation. Deduplicate only rules that this file still applies to the path.
    let mut builder = ignore::gitignore::GitignoreBuilder::new("");
    for (index, line) in text.lines().enumerate() {
        let line = if index == 0 { line.trim_start_matches('\u{feff}') } else { line };
        if let Err(error) = builder.add_line(None, line) {
            tracing::debug!("{}: {error}", file.display());
        }
    }
    let existing = builder.build().map_err(|e| IdeError::invalid(format!("Cannot parse ignore rules: {e}")))?;
    let mut requested = HashSet::new();
    let mut updated = bytes.to_vec();
    for rule in rules {
        if !requested.insert(rule.pattern.as_str())
            || existing.matched_path_or_any_parents(&rule.relative, rule.directory).is_ignore()
        {
            continue;
        }
        if !updated.is_empty() && !updated.ends_with(b"\n") {
            updated.extend_from_slice(newline.as_bytes());
        }
        updated.extend_from_slice(rule.pattern.as_bytes());
        updated.extend_from_slice(newline.as_bytes());
    }
    if updated == bytes {
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(file.parent().unwrap())?;
    let permissions = match fs::metadata(file) {
        Ok(meta) => meta.permissions(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => _lock.file.metadata()?.permissions(),
        Err(e) => return Err(e.into()),
    };
    temp.as_file().set_permissions(permissions)?;
    temp.write_all(&updated)?;
    temp.as_file().sync_all()?;
    replace_if_unchanged(file, before, temp)
}

fn replace_if_unchanged(file: &Path, before: Option<Snapshot>, temp: tempfile::NamedTempFile) -> IdeResult<()> {
    no_symlinks(file.parent().unwrap())?;
    if snapshot(file)? != before {
        return Err(IdeError::invalid("Ignore file changed while preparing the update; retry"));
    }
    temp.persist(file).map_err(|e| IdeError::from(e.error))?;
    Ok(())
}

struct Lock {
    file: fs::File,
    path: PathBuf,
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = &self.file;
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_writer_is_detected_without_overwriting_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let file = root.join(".gitignore");
        fs::write(&file, "before\n").unwrap();
        let before = snapshot(&file).unwrap();
        let mut temp = tempfile::NamedTempFile::new_in(&root).unwrap();
        temp.write_all(b"before\n/new\n").unwrap();
        fs::write(&file, "external writer\n").unwrap();
        assert!(replace_if_unchanged(&file, before, temp).unwrap_err().message.contains("changed"));
        assert_eq!(fs::read_to_string(file).unwrap(), "external writer\n");
    }
}
