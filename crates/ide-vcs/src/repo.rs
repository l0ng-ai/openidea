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
    config_files: [PathBuf; 3],
    config_stamp: Vec<Option<SystemTime>>,
}

fn config_files(git_dir: &Path, common_dir: &Path) -> [PathBuf; 3] {
    [common_dir.join("config"), git_dir.join("config.worktree"), common_dir.join("config.worktree")]
}

fn stamp(files: &[PathBuf]) -> Vec<Option<SystemTime>> {
    files.iter().map(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok()).collect()
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
    let files = config_files(&git_dir, &common_dir);
    let cache = Cache { config_stamp: stamp(&files), config_files: files, repo: ts };
    Ok(Some(Repo { root, git_dir, inner: std::sync::Mutex::new(cache), ignored: Default::default() }))
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
    /// A thread-local gitoxide handle; reopened when the git configuration changed
    /// on disk (e.g. after `push --set-upstream` or `git config` in a terminal).
    pub(crate) fn gix(&self) -> IdeResult<gix::Repository> {
        let mut cache = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let now = stamp(&cache.config_files);
        if now != cache.config_stamp {
            match gix::ThreadSafeRepository::open(&self.git_dir) {
                Ok(fresh) => {
                    cache.repo = fresh;
                    cache.config_stamp = now;
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
        let mut p = self.root.clone();
        for part in rel.split('/').filter(|s| !s.is_empty()) {
            p.push(part);
        }
        p
    }
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
