//! Operations on the commits recorded for submodules.

use crate::{Repo, cli, preserve, repo::gx};
use gix::bstr::{BStr, ByteSlice};
use gix::index::entry::Stage;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleRollbackSource {
    Head,
    Index,
}

impl Repo {
    pub(crate) fn submodule_links(&self) -> IdeResult<Vec<(PathBuf, gix::ObjectId)>> {
        let repo = self.gix()?;
        let Some(modules) = repo.submodules().map_err(gx)? else { return Ok(Vec::new()) };
        let index = repo.index_or_empty().map_err(gx)?;
        let mut links = Vec::new();
        for module in modules {
            let raw = module.path().map_err(gx)?;
            let Ok(name) = raw.to_str() else { continue };
            let path = Path::new(name);
            if name.is_empty() || !path.components().all(|part| matches!(part, Component::Normal(_))) {
                continue;
            }
            if let Some(entry) = index.entry_by_path_and_stage(BStr::new(name.as_bytes()), Stage::Unconflicted)
                && entry.mode.is_submodule()
            {
                links.push((path.to_path_buf(), entry.id));
            }
        }
        Ok(links)
    }

    pub(crate) fn initialized_submodule(&self, rel: &Path) -> Option<PathBuf> {
        let path = self.root().join(rel);
        if !path.join(".git").exists() {
            return None;
        }
        let root = dunce::canonicalize(self.root()).ok()?;
        (dunce::canonicalize(&path).ok()?.strip_prefix(root).ok()? == rel).then_some(path)
    }

    pub(crate) fn initialized_submodules(&self) -> IdeResult<Vec<PathBuf>> {
        Ok(self.submodule_links()?.into_iter().filter_map(|(rel, _)| self.initialized_submodule(&rel)).collect())
    }

    /// Restores the parent index, an initialized checkout, or a missing submodule directory.
    pub fn rollback_submodule(
        &self,
        path: &Path,
        source: SubmoduleRollbackSource,
        restore_checkout: bool,
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        if !crate::execution_allowed() {
            return Err(IdeError::invalid("Submodule rollback requires a trusted project"));
        }
        let rel = self.rel_path(path)?;
        let index = self.diff_entry_at(path, ":0")?;
        let head = if source == SubmoduleRollbackSource::Head { self.head()?.1 } else { None };
        let recorded = head.as_deref().map(|rev| self.diff_entry_at(path, rev)).transpose()?.flatten();
        let index_commit = index.as_ref().and_then(|entry| entry.gitlink.as_deref());
        let target = match source {
            SubmoduleRollbackSource::Head => recorded.as_ref().and_then(|entry| entry.gitlink.as_deref()),
            SubmoduleRollbackSource::Index => index_commit,
        };
        if target.is_none() && (source != SubmoduleRollbackSource::Head || index_commit.is_none()) {
            return Err(IdeError::invalid(format!("{rel} is no longer a submodule change")));
        }
        let reset_index = source == SubmoduleRollbackSource::Head && target != index_commit;
        if restore_checkout && let Some(target) = target {
            let checkout = self.root().join(&rel);
            let child = self
                .initialized_submodule(Path::new(&rel))
                .and_then(|root| Self::discover(&root).ok().flatten().filter(|repo| repo.root() == root));
            if let Some(child) = child {
                child.set_execution_allowed(true);
                if child.head()?.1.as_deref() != Some(target) {
                    if child.operation()?.is_some() || !crate::write::unmerged_paths(&child)?.is_empty() {
                        return Err(IdeError::invalid(
                            "Finish the Git operation in the submodule before rolling it back",
                        ));
                    }
                    // A normal checkout lets Git carry edits across or refuse an overwrite. Nested
                    // submodules are separate changes in the parent Commit tree.
                    cli::run(child.root(), &["checkout", "--no-recurse-submodules", "--detach", target, "--"], None)?;
                }
            } else if std::fs::symlink_metadata(checkout)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                let mut args = vec!["--literal-pathspecs", "restore", "--worktree", "--no-recurse-submodules"];
                if let Some(rev) = head.as_deref() {
                    args.extend(["--source", rev]);
                }
                args.extend(["--", &rel]);
                cli::run(self.root(), &args, None)?;
            } else if !reset_index {
                return Err(IdeError::invalid(format!("Submodule checkout is unavailable for {rel}")));
            }
        }
        if reset_index {
            if let Some(head) = head {
                cli::run(
                    self.root(),
                    &[
                        "--literal-pathspecs",
                        "restore",
                        "--staged",
                        "--no-recurse-submodules",
                        "--source",
                        &head,
                        "--",
                        &rel,
                    ],
                    None,
                )?;
            } else {
                crate::write::unstage(self, std::slice::from_ref(&path.to_path_buf()))?;
            }
        }
        Ok(())
    }

    /// Updates a single detached checkout. The caller visits every child in parent-first order
    /// so Git does not switch checked-out branches or bypass protection in nested worktrees.
    pub fn update_from_superproject(
        &self,
        parent: &Repo,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        // The superproject's git runs it; the submodule can only restrict what it may do.
        let _parent = parent.execution_scope();
        let _scope = self.execution_scope();
        if !crate::execution_allowed() {
            return Err(IdeError::invalid("Submodule update requires a trusted project"));
        }
        let relative = self
            .root()
            .strip_prefix(parent.root())
            .map_err(|_| IdeError::invalid("The submodule is outside its parent repository"))?;
        let Some((_, target)) = parent.submodule_links()?.into_iter().find(|(path, _)| path == relative) else {
            return Ok(());
        };
        if !parent.initialized_submodules()?.iter().any(|path| path == self.root()) {
            return Err(IdeError::invalid("The submodule worktree is no longer available"));
        }
        let (branch, head) = self.head()?;
        if branch.is_some() {
            return Err(IdeError::invalid("The submodule is now on a branch. Update it again to use its upstream."));
        }
        if head.as_deref() == Some(target.to_string().as_str()) {
            return Ok(());
        }
        if parent.operation()?.is_some() || !crate::write::unmerged_paths(parent)?.is_empty() {
            return Err(IdeError::invalid(
                "Finish the Git operation in the parent repository before updating its submodule",
            ));
        }
        if self.operation()?.is_some() || !crate::write::unmerged_paths(self)?.is_empty() {
            return Err(IdeError::invalid("Finish the Git operation in the submodule before updating it"));
        }
        let path = ide_core::ipc_path::to_ipc(relative);
        preserve::around(self, "Local changes saved before update", || {
            if self.head()?.0.is_some() {
                return Err(IdeError::invalid(
                    "The submodule is now on a branch. Update it again to use its upstream.",
                ));
            }
            cli::run_streaming(
                parent.root(),
                &["-c", "submodule.recurse=false", "--literal-pathspecs", "submodule", "update", "--", &path],
                cancel,
                on_output,
            )
        })
    }
}
