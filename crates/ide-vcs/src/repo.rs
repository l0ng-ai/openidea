//! Opening the repository, caching the gitoxide handle and path helpers.

use crate::Repo;
use gix::bstr::{BStr, ByteSlice};
use ide_core::{IdeError, IdeResult};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

/// Converts any displayable gitoxide error into an [`IdeError`].
pub(crate) fn gx(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(format!("git: {e}"))
}

pub(crate) struct Cache {
    repo: gix::ThreadSafeRepository,
    files: [PathBuf; 4],
    stamp: Vec<Option<(SystemTime, u64)>>,
    /// `objects/pack` directory and its modification time. An external
    /// `git fetch`/`pull`/`repack` adds packs without touching the `files`
    /// above — watching the directory catches them (issue #1919).
    pack_dir: PathBuf,
    pack_stamp: Option<SystemTime>,
}

fn cache_files(git_dir: &Path, common_dir: &Path) -> [PathBuf; 4] {
    [
        common_dir.join("config"),
        git_dir.join("config.worktree"),
        common_dir.join("config.worktree"),
        common_dir.join("packed-refs"),
    ]
}

fn stamp(files: &[PathBuf]) -> Vec<Option<(SystemTime, u64)>> {
    files
        .iter()
        .map(|f| {
            let metadata = std::fs::metadata(f).ok()?;
            Some((metadata.modified().ok()?, metadata.len()))
        })
        .collect()
}

/// The pack directory's modification time: adding or removing a pack file
/// updates it. `None` when the directory can't be read.
fn pack_stamp(pack_dir: &Path) -> Option<SystemTime> {
    std::fs::metadata(pack_dir).ok()?.modified().ok()
}

pub(crate) fn discover(path: &Path) -> IdeResult<Option<Repo>> {
    let start = if path.is_file() { path.parent().unwrap_or(path) } else { path };
    if let Err(e) = gix::discover::upwards(start) {
        use gix::discover::upwards::Error as E;
        return match e.downcast_any_ref::<E>() {
            Some(
                E::NoGitRepository { .. } | E::NoGitRepositoryWithinCeiling { .. } | E::NoGitRepositoryWithinFs { .. },
            ) => Ok(None),
            _ => Err(gx(e)),
        };
    }
    let ts = gix::ThreadSafeRepository::discover(start).map_err(gx)?;
    let repo = ts.to_thread_local();
    let Some(workdir) = repo.workdir() else {
        // Bare repositories have no worktree to show changes for.
        return Ok(None);
    };
    let root = absolute(workdir)?;
    let git_dir = absolute(repo.git_dir())?;
    let common_dir = absolute(repo.common_dir())?;
    let files = cache_files(&git_dir, &common_dir);
    let pack_dir = common_dir.join("objects").join("pack");
    let cache = Cache { stamp: stamp(&files), files, repo: ts, pack_stamp: pack_stamp(&pack_dir), pack_dir };
    Ok(Some(Repo {
        execution_allowed: std::sync::atomic::AtomicBool::new(false),
        root,
        git_dir,
        inner: std::sync::Mutex::new(cache),
        ignored: Default::default(),
        log_index: Default::default(),
        log_signatures: Default::default(),
    }))
}

pub(crate) fn absolute(p: &Path) -> IdeResult<PathBuf> {
    let p = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir()?.join(p) };
    // Lexically clean `.`/`..` without resolving symlinks, keeping the caller's spelling.
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

impl Repo {
    /// A thread-local gitoxide handle; reopened when configuration or packed refs change.
    /// gitoxide's packed-ref snapshot only reloads for a newer mtime, which a replacement may preserve.
    pub(crate) fn gix(&self) -> IdeResult<gix::Repository> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        if !self.execution_allowed.load(std::sync::atomic::Ordering::Acquire) {
            return gix::open_opts(&self.git_dir, gix::open::Options::default().filter_config_section(|_| false))
                .map_err(gx);
        }
        let mut cache = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let now = stamp(&cache.files);
        let pack_now = pack_stamp(&cache.pack_dir);
        if now != cache.stamp || pack_now != cache.pack_stamp {
            match gix::ThreadSafeRepository::open(&self.git_dir) {
                Ok(fresh) => {
                    cache.repo = fresh;
                    cache.stamp = now;
                    cache.pack_stamp = pack_now;
                }
                Err(e) => tracing::warn!("reopening repository failed: {e}"),
            }
        }
        let mut repo = cache.repo.to_thread_local();
        repo.object_cache_size_if_unset(4 * 1024 * 1024);
        Ok(repo)
    }

    /// Repository-relative path with `/` separators. Accepts absolute paths inside the
    /// worktree or paths already relative to it.
    pub(crate) fn rel_path(&self, path: &Path) -> IdeResult<String> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        Ok(self.index_spelling(self.given_rel_path(path)?))
    }

    /// The blob of `path` at `rev`. A revision may spell a file differently from the index (a
    /// case-only rename staged or made since it): the spelling given wins when the revision has
    /// it, the index's spelling is the fallback.
    pub(crate) fn blob_of(&self, path: &Path, rev: &str) -> IdeResult<Option<Vec<u8>>> {
        let repo = self.gix()?;
        let given = self.given_rel_path(path)?;
        let indexed = self.index_spelling(given.clone());
        if !rev.starts_with(':')
            && indexed != given
            && let Some(bytes) = blob_at(&repo, &given, rev)?
        {
            return Ok(Some(bytes));
        }
        blob_at(&repo, &indexed, rev)
    }

    /// `path` relative to the worktree, spelled as given.
    fn given_rel_path(&self, path: &Path) -> IdeResult<String> {
        let rel = if path.is_absolute() {
            self.strip_root(path)
                .ok_or_else(|| IdeError::invalid(format!("{} is outside the repository", path.display())))?
        } else {
            path.to_path_buf()
        };
        let mut parts: Vec<String> = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::ParentDir => {
                    if parts.pop().is_none() {
                        return Err(IdeError::invalid(format!("{} is outside the repository", path.display())));
                    }
                }
                _ => return Err(IdeError::invalid(format!("invalid path {}", path.display()))),
            }
        }
        Ok(parts.join("/"))
    }

    /// `rel` as the index spells it. On a case-insensitive worktree (`core.ignoreCase`) the
    /// IDE names a file the way the disk does, which differs from its index entry after a
    /// case-only rename of it or a parent directory; git's pathspecs and tree lookups are
    /// case-sensitive and only find the index's spelling.
    fn index_spelling(&self, rel: String) -> String {
        if rel.is_empty() {
            return rel;
        }
        let Ok(repo) = self.gix() else { return rel };
        if !ignores_case(&repo) {
            return rel;
        }
        let Ok(index) = repo.index_or_empty() else { return rel };
        index_spelling(&index, &rel).unwrap_or(rel)
    }

    fn strip_root(&self, path: &Path) -> Option<PathBuf> {
        if let Ok(rel) = path.strip_prefix(&self.root) {
            return Some(rel.to_path_buf());
        }
        // Different spelling of the same location (symlinks, /var vs /private/var).
        let canon_root = dunce::canonicalize(&self.root).ok()?;
        if let Ok(rel) = path.strip_prefix(&canon_root) {
            return Some(rel.to_path_buf());
        }
        // Canonicalize the deepest existing ancestor (the file itself may be deleted).
        let mut existing = path.to_path_buf();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if let Ok(canon) = dunce::canonicalize(&existing) {
                let mut rel = canon.strip_prefix(&canon_root).ok()?.to_path_buf();
                for t in tail.iter().rev() {
                    rel.push(t);
                }
                return Some(rel);
            }
            tail.push(existing.file_name()?.to_os_string());
            if !existing.pop() {
                return None;
            }
        }
    }

    /// Absolute path for a repository-relative path.
    pub(crate) fn abs_path(&self, rel: &str) -> PathBuf {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let mut p = self.root.clone();
        for part in rel.split('/').filter(|s| !s.is_empty()) {
            p.push(part);
        }
        p
    }
}

/// Whether the worktree's file system ignores case, as `git init`/`clone` recorded it.
pub(crate) fn ignores_case(repo: &gix::Repository) -> bool {
    repo.config_snapshot().boolean("core.ignoreCase").unwrap_or(false)
}

/// The index's spelling of the file or directory `rel` when it differs only in ASCII case
/// (git's own case folding), `None` when the index has `rel` as spelled or not at all.
fn index_spelling(index: &gix::index::State, rel: &str) -> Option<String> {
    let rel = rel.as_bytes();
    if index.entry_by_path(rel.as_bstr()).is_some() {
        return None;
    }
    let mut found = None;
    for entry in index.entries() {
        let path: &[u8] = entry.path(index);
        let spelled = match path.len().cmp(&rel.len()) {
            std::cmp::Ordering::Equal => path,
            std::cmp::Ordering::Greater if path[rel.len()] == b'/' => &path[..rel.len()],
            _ => continue,
        };
        if spelled == rel {
            return None;
        }
        if found.is_none() && spelled.eq_ignore_ascii_case(rel) {
            found = Some(spelled.to_str_lossy().into_owned());
        }
    }
    found
}

/// The mode a worktree file would be committed with (`100755` when executable,
/// `100644` otherwise, `120000` for a symlink), `None` when `abs` is not a file.
/// On filesystems without an executable bit git can't record one, so it is `100644`.
pub(crate) fn worktree_mode(root: &Path, rel: &str) -> IdeResult<Option<String>> {
    let meta = match std::fs::symlink_metadata(root.join(rel)) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if meta.file_type().is_symlink() {
        return Ok(Some("120000".to_owned()));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(Some(if meta.permissions().mode() & 0o111 != 0 { "100755" } else { "100644" }.to_owned()))
    }
    #[cfg(not(unix))]
    Ok(Some("100644".to_owned()))
}

/// The entry's mode of `rel` at `rev` as git prints it (`100644`, `100755`, `120000`,
/// `160000`…), `None` when the path is absent there. Same `rev` rules as [`blob_at`].
pub(crate) fn mode_at(repo: &gix::Repository, rel: &str, rev: &str) -> IdeResult<Option<String>> {
    if let Some(stage) = rev.strip_prefix(':') {
        let stage = match stage {
            "" | "0" => gix::index::entry::Stage::Unconflicted,
            "1" => gix::index::entry::Stage::Base,
            "2" => gix::index::entry::Stage::Ours,
            "3" => gix::index::entry::Stage::Theirs,
            other => return Err(IdeError::invalid(format!("invalid index stage :{other}"))),
        };
        let index = repo.index_or_empty().map_err(gx)?;
        let Some(entry) = index.entry_by_path_and_stage(BStr::new(rel.as_bytes()), stage) else {
            return Ok(None);
        };
        return Ok(entry.mode.to_tree_entry_mode().map(|m| format!("{:o}", m.value())));
    }
    let Some(tree) = tree_of(repo, rev)? else { return Ok(None) };
    let Some(entry) = tree.lookup_entry_by_path(Path::new(rel)).map_err(gx)? else {
        return Ok(None);
    };
    if !entry.mode().is_blob_or_symlink() {
        return Ok(None);
    }
    Ok(Some(format!("{:o}", entry.mode().value())))
}

/// Blob content of `rel` at `rev`. `rev` is a revision (`HEAD`, a branch, an id) or
/// `:N` for index stage N (`:` / `:0` = the merged index entry).
pub(crate) fn blob_at(repo: &gix::Repository, rel: &str, rev: &str) -> IdeResult<Option<Vec<u8>>> {
    if let Some(stage) = rev.strip_prefix(':') {
        let stage = match stage {
            "" | "0" => gix::index::entry::Stage::Unconflicted,
            "1" => gix::index::entry::Stage::Base,
            "2" => gix::index::entry::Stage::Ours,
            "3" => gix::index::entry::Stage::Theirs,
            other => return Err(IdeError::invalid(format!("invalid index stage :{other}"))),
        };
        let index = repo.index_or_empty().map_err(gx)?;
        let Some(entry) = index.entry_by_path_and_stage(BStr::new(rel.as_bytes()), stage) else {
            return Ok(None);
        };
        if entry.mode.is_submodule() {
            return Ok(None);
        }
        return blob_data(repo, entry.id).map(Some);
    }
    let tree = match tree_of(repo, rev)? {
        Some(t) => t,
        None => return Ok(None),
    };
    let Some(entry) = tree.lookup_entry_by_path(Path::new(rel)).map_err(gx)? else {
        return Ok(None);
    };
    if !entry.mode().is_blob_or_symlink() {
        return Ok(None);
    }
    blob_data(repo, entry.oid().to_owned()).map(Some)
}

/// A blob's bytes. Partial clones (`--filter=blob:none`) lack blobs until git
/// fetches them on demand, which gix doesn't do, so a missing one is read
/// through the git CLI.
fn blob_data(repo: &gix::Repository, id: gix::ObjectId) -> IdeResult<Vec<u8>> {
    match repo.find_object(id) {
        Ok(obj) => Ok(obj.detach().data),
        Err(e) => {
            let root = repo.workdir().unwrap_or_else(|| repo.git_dir());
            match crate::cli::run(root, &["cat-file", "blob", &id.to_string()], None) {
                Ok(out) => Ok(out.stdout),
                Err(_) => Err(gx(e)),
            }
        }
    }
}

/// Tree of a revision; `None` for an unborn `HEAD`.
pub(crate) fn tree_of<'r>(repo: &'r gix::Repository, rev: &str) -> IdeResult<Option<gix::Tree<'r>>> {
    if rev == "HEAD" {
        let head = repo.head().map_err(gx)?;
        if head.is_unborn() {
            return Ok(None);
        }
    }
    let id = resolve(repo, rev)?;
    let tree = repo.find_object(id).map_err(gx)?.peel_to_tree().map_err(gx)?;
    Ok(Some(tree))
}

/// Resolves a revision spec to an object id.
pub(crate) fn resolve(repo: &gix::Repository, rev: &str) -> IdeResult<gix::ObjectId> {
    repo.rev_parse_single(BStr::new(rev.as_bytes()))
        .map(|id| id.detach())
        .map_err(|e| IdeError::not_found(format!("unknown revision {rev}: {e}")))
}

/// Whether `rel` (or one of its parent directories) is git-ignored.
pub(crate) fn is_ignored(repo: &gix::Repository, rel: &str) -> IdeResult<bool> {
    let index = repo.index_or_empty().map_err(gx)?;
    let mut excludes = repo
        .excludes(&index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)
        .map_err(gx)?;
    let parts: Vec<&str> = rel.split('/').collect();
    for i in 1..=parts.len() {
        let prefix = parts[..i].join("/");
        let mode = if i == parts.len() { None } else { Some(gix::index::entry::Mode::DIR) };
        let platform = excludes.at_entry(prefix.as_bytes().as_bstr(), mode).map_err(gx)?;
        if platform.is_excluded() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn to_string(b: &BStr) -> String {
    b.to_str_lossy().into_owned()
}
