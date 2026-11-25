//! Git menu dialogs: Merge / Rebase / Pull with options, Manage Remotes and Worktrees.

use crate::Repo;
use crate::cli::{self, run};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// Merge dialog › Modify options (shared by the Pull dialog).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeOptions {
    #[serde(default)]
    pub no_ff: bool,
    #[serde(default)]
    pub ff_only: bool,
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub no_commit: bool,
    #[serde(default)]
    pub no_verify: bool,
    /// Merge histories whose commits have no common ancestor.
    #[serde(default)]
    pub allow_unrelated_histories: bool,
    /// `-m`: message of the merge commit (Merge dialog only).
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MergeOutcome {
    Done,
    LocalChanges { files: Vec<String> },
    Conflicts,
    AlreadyUpToDate,
    ReadyToCommit,
    Squashed,
}

/// Rebase dialog options.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOptions {
    /// Replay the selected commits onto this revision instead.
    #[serde(default)]
    pub onto: Option<String>,
    /// Switch to this local branch before rebasing it.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub rebase_merges: bool,
    #[serde(default)]
    pub keep_empty: bool,
    #[serde(default)]
    pub update_refs: bool,
    #[serde(default)]
    pub autosquash: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: ide_core::IpcPath,
    /// Checked-out commit; `None` for a bare main repository.
    pub head: Option<String>,
    /// Short branch name; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The main working tree (cannot be removed).
    pub main: bool,
    pub locked: bool,
    pub prunable: bool,
    /// This worktree belongs to a repository checked out as a submodule.
    #[serde(default)]
    #[specta(optional)]
    pub submodule: bool,
}

/// Manage Remotes edits.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum RemoteEdit {
    Add {
        name: String,
        url: String,
    },
    Remove {
        name: String,
    },
    /// Renames `name` to `new_name` (when different) and sets its URL.
    Edit {
        name: String,
        new_name: String,
        url: String,
    },
}

fn arg(value: &str, what: &str) -> IdeResult<String> {
    let v = value.trim();
    if v.is_empty() || v.starts_with('-') {
        return Err(IdeError::invalid(format!("invalid {what} '{value}'")));
    }
    Ok(v.to_string())
}

fn merge_flags(o: &MergeOptions) -> IdeResult<Vec<&'static str>> {
    if o.ff_only && (o.no_ff || o.squash) {
        return Err(IdeError::invalid("--ff-only cannot be combined with --no-ff or --squash"));
    }
    if o.no_ff && o.squash {
        return Err(IdeError::invalid("--no-ff cannot be combined with --squash"));
    }
    let mut flags = Vec::new();
    if o.no_ff {
        flags.push("--no-ff");
    }
    if o.ff_only {
        flags.push("--ff-only");
    }
    if o.squash {
        flags.push("--squash");
    }
    if o.no_commit {
        flags.push("--no-commit");
    }
    if o.no_verify {
        flags.push("--no-verify");
    }
    Ok(flags)
}

/// `git merge` arguments for the Merge dialog (local changes are stashed and restored).
pub(crate) fn merge_args(branches: &[String], o: &MergeOptions) -> IdeResult<Vec<String>> {
    if branches.is_empty() {
        return Err(IdeError::invalid("no branch to merge"));
    }
    let mut args: Vec<String> = vec!["merge".into()];
    args.extend(merge_flags(o)?.into_iter().map(String::from));
    if o.allow_unrelated_histories {
        args.push("--allow-unrelated-histories".into());
    }
    match o.message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => args.extend(["-m".into(), m.to_string()]),
        None => args.push("--no-edit".into()),
    }
    for b in branches {
        args.push(arg(b, "branch")?);
    }
    Ok(args)
}

/// `git rebase` arguments for the Rebase dialog.
pub(crate) fn rebase_args(upstream: Option<&str>, o: &RebaseOptions) -> IdeResult<Vec<String>> {
    let mut args: Vec<String> = vec!["rebase".into()];
    if o.rebase_merges {
        args.push("--rebase-merges".into());
    }
    if o.keep_empty {
        args.push("--keep-empty".into());
    }
    if o.update_refs {
        args.push("--update-refs".into());
    }
    if let Some(autosquash) = o.autosquash {
        args.push(if autosquash { "--autosquash" } else { "--no-autosquash" }.into());
    }
    if let Some(onto) = o.onto.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.extend(["--onto".into(), arg(onto, "revision")?]);
    }
    if let Some(upstream) = upstream {
        args.push(arg(upstream, "revision")?);
    } else {
        args.push("--root".into());
    }
    if let Some(branch) = o.branch.as_deref() {
        args.push(arg(branch, "branch")?);
    }
    Ok(args)
}

/// `git pull` arguments for the Pull dialog: `remote` and its `branches` (none = the
/// upstream's configured merge branch).
pub(crate) fn pull_args(
    remote: &str,
    branches: &[String],
    rebase: Option<bool>,
    o: &MergeOptions,
) -> IdeResult<Vec<String>> {
    let mut args: Vec<String> = vec!["pull".into(), "--progress".into()];
    if rebase == Some(true) {
        if o.no_ff || o.ff_only || o.squash || o.no_commit {
            return Err(IdeError::invalid("--rebase cannot be combined with merge options"));
        }
        args.push("--rebase".into());
    } else if rebase == Some(false) {
        args.push("--no-rebase".into());
    }
    args.extend(merge_flags(o)?.into_iter().map(String::from));
    args.push(arg(remote, "remote")?);
    for b in branches {
        args.push(arg(b, "branch")?);
    }
    Ok(args)
}

/// Parses `git worktree list --porcelain`.
pub(crate) fn parse_worktrees(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    for block in text.split("\n\n") {
        let mut wt: Option<Worktree> = None;
        let mut bare = false;
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => {
                    wt = Some(Worktree {
                        path: value.into(),
                        head: None,
                        branch: None,
                        main: out.is_empty(),
                        locked: false,
                        prunable: false,
                        submodule: false,
                    })
                }
                "HEAD" => {
                    if let Some(w) = wt.as_mut() {
                        w.head = Some(value.to_string());
                    }
                }
                "branch" => {
                    if let Some(w) = wt.as_mut() {
                        w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string());
                    }
                }
                "locked" => {
                    if let Some(w) = wt.as_mut() {
                        w.locked = true;
                    }
                }
                "prunable" => {
                    if let Some(w) = wt.as_mut() {
                        w.prunable = true;
                    }
                }
                "bare" => bare = true,
                _ => {}
            }
        }
        if let Some(mut w) = wt {
            if bare {
                w.head = None;
            }
            out.push(w);
        }
    }
    out
}

impl Repo {
    /// Git can list the repository's separate Git directory as the first worktree.
    fn main_worktree_checkout(&self, reported: &Path) -> Option<PathBuf> {
        let repo = self.gix().ok()?;
        let common = crate::repo::absolute(repo.common_dir()).ok()?;
        if reported != common {
            return None;
        }
        if self.git_dir == common {
            return Some(self.root().to_path_buf());
        }
        let configured = repo.config_snapshot().string("core.worktree")?;
        let path = crate::repo::absolute(&common.join(gix::path::from_bstr(&configured).ok()?)).ok()?;
        let main = Self::discover(&path).ok()??;
        (main.root() == path && main.git_dir == common).then_some(path)
    }

    /// Merges `branches` into the current branch (Git › Merge…).
    pub fn merge_with(&self, branches: &[String], options: &MergeOptions) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let args = merge_args(branches, options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::preserve::around(self, "Local changes saved before merge", || run(self.root(), &args, None).map(|_| ()))
    }

    /// Tries the merge as requested. Smart Merge preserves local changes after user confirmation.
    pub fn merge_attempt(&self, branches: &[String], options: &MergeOptions, smart: bool) -> IdeResult<MergeOutcome> {
        let _scope = self.execution_scope();
        let branches = branches
            .iter()
            .map(|branch| crate::write::unambiguous_branch_name(self, branch.trim()).to_owned())
            .collect::<Vec<_>>();
        let args = merge_args(&branches, options)?;
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        crate::write::merge_attempt(self, &args, options, smart)
    }

    /// Predicts which tracked local changes a branch merge may have to save.
    pub fn merge_affected_files(&self, branch: &str) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        crate::write::merge_affected_files(self, branch)
    }

    /// Rebases the chosen branch or HEAD. Without an upstream, rebases from the root.
    pub fn rebase_with(&self, upstream: Option<&str>, options: &RebaseOptions) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let args = rebase_args(upstream, options)?;
        self.validate_rebase(options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::preserve::around(self, "Local changes saved before rebase", || run(self.root(), &args, None).map(|_| ()))
    }

    pub(crate) fn validate_rebase(&self, options: &RebaseOptions) -> IdeResult<()> {
        if self.operation()?.is_some() {
            return Err(IdeError::invalid("another merge, rebase, cherry-pick or revert is in progress"));
        }
        if let Some(branch) = options.branch.as_deref() {
            let name = format!("refs/heads/{}", branch.trim());
            if self.gix()?.try_find_reference(name.as_str()).map_err(crate::repo::gx)?.is_none() {
                return Err(IdeError::invalid("Select an existing local branch to rebase."));
            }
        }
        Ok(())
    }

    /// Git › Pull…: pulls `branches` of `remote` into the current branch.
    pub fn pull_from(
        &self,
        remote: &str,
        branches: &[String],
        rebase: Option<bool>,
        options: &MergeOptions,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let args = pull_args(remote, branches, rebase, options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::preserve::around(self, "Local changes saved before update", || {
            cli::run_streaming(self.root(), &args, cancel, on_output)
        })
    }

    /// Manage Remotes: adds, removes or edits a remote.
    pub fn edit_remote(&self, edit: &RemoteEdit) -> IdeResult<()> {
        let _scope = self.execution_scope();
        match edit {
            RemoteEdit::Add { name, url } => {
                let (name, url) = (arg(name, "remote name")?, arg(url, "URL")?);
                run(self.root(), &["remote", "add", "--", &name, &url], None)?;
            }
            RemoteEdit::Remove { name } => {
                let name = arg(name, "remote name")?;
                run(self.root(), &["remote", "remove", &name], None)?;
            }
            RemoteEdit::Edit { name, new_name, url } => {
                let (name, new_name, url) =
                    (arg(name, "remote name")?, arg(new_name, "remote name")?, arg(url, "URL")?);
                if name != new_name {
                    run(self.root(), &["remote", "rename", &name, &new_name], None)?;
                }
                run(self.root(), &["remote", "set-url", "--", &new_name, &url], None)?;
            }
        }
        Ok(())
    }

    /// Working trees of the repository, the main one first.
    pub fn worktrees(&self) -> IdeResult<Vec<Worktree>> {
        let _scope = self.execution_scope();
        let out = run(self.root(), &["worktree", "list", "--porcelain"], None)?;
        let mut trees = parse_worktrees(&out.stdout_str());
        if let Some(main) = trees.first_mut().filter(|main| main.head.is_some()) {
            if let Some(path) = self.main_worktree_checkout(&main.path) {
                main.path = path.into();
            }
            let parent = main.path.parent().and_then(|path| Self::discover(path).ok().flatten());
            let submodule =
                parent.and_then(|parent| parent.file_mode_at(&main.path, Some(":0")).ok().flatten()).as_deref()
                    == Some("160000");
            if submodule {
                for tree in &mut trees {
                    tree.submodule = true;
                }
            }
        }
        Ok(trees)
    }

    /// Checks out a local branch, a new branch, or a detached revision in a new worktree.
    pub fn add_worktree(&self, path: &Path, commitish: &str, new_branch: Option<&str>) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let path = path.to_string_lossy().into_owned();
        let commitish = arg(commitish, "revision")?;
        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        if let Some(b) = new_branch.map(str::trim).filter(|b| !b.is_empty()) {
            if crate::write::renamed_remote_start(self, b, &commitish) {
                args.push("--no-track".into());
            }
            args.extend(["-b".into(), arg(b, "branch name")?]);
        } else if commitish.starts_with("refs/tags/") {
            args.push("--detach".into());
        }
        args.extend(["--".into(), path, commitish]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(self.root(), &args, None).map(|_| ())
    }

    /// Move Worktree…: moves a linked worktree's folder to exactly `to`. An empty folder there
    /// is replaced (Git would move the worktree inside it); any other existing `to` is refused.
    pub fn move_worktree(&self, path: &Path, to: &Path) -> IdeResult<()> {
        let _scope = self.execution_scope();
        if std::fs::symlink_metadata(to).is_ok() {
            let empty_dir = to.is_dir() && std::fs::read_dir(to).is_ok_and(|mut d| d.next().is_none());
            if !empty_dir {
                return Err(IdeError::invalid(format!("{} already exists", to.display())));
            }
            std::fs::remove_dir(to)?;
        }
        let (path, to) = (path.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
        run(self.root(), &["worktree", "move", "--", &path, &to], None).map(|_| ())
    }

    pub fn remove_worktree(&self, path: &Path, force: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let path = path.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.extend(["--", &path]);
        run(self.root(), &args, None).map(|_| ())
    }

    pub fn set_worktree_locked(&self, path: &Path, locked: bool) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let operation = if locked { "lock" } else { "unlock" };
        run(self.root(), &["worktree", operation, "--", &path.to_string_lossy()], None).map(|_| ())
    }

    pub fn prune_worktrees(&self) -> IdeResult<()> {
        let _scope = self.execution_scope();
        run(self.root(), &["worktree", "prune", "--expire", "now"], None).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_args_follow_the_options() {
        let o = MergeOptions {
            no_ff: true,
            no_verify: true,
            allow_unrelated_histories: true,
            message: Some("Merge it".into()),
            ..Default::default()
        };
        assert_eq!(
            merge_args(&["dev".into()], &o).unwrap(),
            ["merge", "--no-ff", "--no-verify", "--allow-unrelated-histories", "-m", "Merge it", "dev"]
        );
        assert_eq!(
            merge_args(&["a".into(), "b".into()], &MergeOptions::default()).unwrap(),
            ["merge", "--no-edit", "a", "b"]
        );
        let bad = MergeOptions { ff_only: true, squash: true, ..Default::default() };
        assert!(merge_args(&["dev".into()], &bad).is_err());
        assert!(merge_args(&["--evil".into()], &MergeOptions::default()).is_err());
        assert!(merge_args(&[], &MergeOptions::default()).is_err());
    }

    #[test]
    fn rebase_and_pull_args() {
        let o = RebaseOptions { onto: Some("main".into()), rebase_merges: true, ..Default::default() };
        assert_eq!(
            rebase_args(Some("feature~3"), &o).unwrap(),
            ["rebase", "--rebase-merges", "--onto", "main", "feature~3"]
        );
        let root = RebaseOptions {
            onto: Some("main".into()),
            branch: Some("topic".into()),
            update_refs: true,
            autosquash: Some(false),
            ..Default::default()
        };
        assert_eq!(
            rebase_args(None, &root).unwrap(),
            ["rebase", "--update-refs", "--no-autosquash", "--onto", "main", "--root", "topic"]
        );
        assert!(rebase_args(Some("--quit"), &o).is_err());
        assert_eq!(
            pull_args("origin", &["main".into()], Some(false), &MergeOptions { ff_only: true, ..Default::default() })
                .unwrap(),
            ["pull", "--progress", "--no-rebase", "--ff-only", "origin", "main"]
        );
        assert_eq!(
            pull_args("origin", &[], Some(true), &MergeOptions { no_verify: true, ..Default::default() }).unwrap(),
            ["pull", "--progress", "--rebase", "--no-verify", "origin"]
        );
        assert_eq!(
            pull_args("origin", &["main".into()], None, &MergeOptions::default()).unwrap(),
            ["pull", "--progress", "origin", "main"]
        );
        assert!(pull_args("origin", &[], Some(true), &MergeOptions { squash: true, ..Default::default() }).is_err());
    }

    #[test]
    fn parses_worktree_list() {
        let text = "worktree /repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree /wt/fix\nHEAD 2222\ndetached\nlocked\n\nworktree /wt/gone\nHEAD 3333\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n";
        let wts = parse_worktrees(text);
        assert_eq!(wts.len(), 3);
        assert!(wts[0].main && wts[0].branch.as_deref() == Some("main"));
        assert!(!wts[1].main && wts[1].branch.is_none() && wts[1].locked);
        assert!(wts[2].prunable && wts[2].head.as_deref() == Some("3333"));
    }
}
