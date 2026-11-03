//! Git menu dialogs: Merge / Rebase / Pull with options, Manage Remotes and Worktrees.

use crate::Repo;
use crate::cli::{self, run};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

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
    /// `-m`: message of the merge commit (Merge dialog only).
    #[serde(default)]
    pub message: Option<String>,
}

/// Rebase dialog options.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOptions {
    /// `--onto <newbase>`: replay `upstream..HEAD` onto this revision instead.
    #[serde(default)]
    pub onto: Option<String>,
    #[serde(default)]
    pub rebase_merges: bool,
    #[serde(default)]
    pub keep_empty: bool,
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
    Ok(flags)
}

/// `git merge` arguments for the Merge dialog (local changes are stashed and restored).
pub(crate) fn merge_args(branches: &[String], o: &MergeOptions) -> IdeResult<Vec<String>> {
    if branches.is_empty() {
        return Err(IdeError::invalid("no branch to merge"));
    }
    let mut args: Vec<String> = vec!["merge".into(), "--autostash".into()];
    args.extend(merge_flags(o)?.into_iter().map(String::from));
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
pub(crate) fn rebase_args(upstream: &str, o: &RebaseOptions) -> IdeResult<Vec<String>> {
    let mut args: Vec<String> = vec!["rebase".into(), "--autostash".into()];
    if o.rebase_merges {
        args.push("--rebase-merges".into());
    }
    if o.keep_empty {
        args.push("--keep-empty".into());
    }
    if let Some(onto) = o.onto.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.extend(["--onto".into(), arg(onto, "revision")?]);
    }
    args.push(arg(upstream, "revision")?);
    Ok(args)
}

/// `git pull` arguments for the Pull dialog: `remote` and its `branches` (none = the
/// upstream's configured merge branch).
pub(crate) fn pull_args(remote: &str, branches: &[String], rebase: bool, o: &MergeOptions) -> IdeResult<Vec<String>> {
    let mut args: Vec<String> = vec!["pull".into(), "--progress".into(), "--autostash".into()];
    if rebase {
        if o.no_ff || o.ff_only || o.squash || o.no_commit {
            return Err(IdeError::invalid("--rebase cannot be combined with merge options"));
        }
        args.push("--rebase".into());
    } else {
        args.push("--no-rebase".into());
        args.extend(merge_flags(o)?.into_iter().map(String::from));
    }
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
    /// Merges `branches` into the current branch (Git › Merge…).
    pub fn merge_with(&self, branches: &[String], options: &MergeOptions) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let args = merge_args(branches, options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(self.root(), &args, None).map(|_| ())
    }

    /// Rebases the current branch onto `upstream` (or `upstream..HEAD` onto `options.onto`).
    pub fn rebase_with(&self, upstream: &str, options: &RebaseOptions) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let args = rebase_args(upstream, options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(self.root(), &args, None).map(|_| ())
    }

    /// Git › Pull…: pulls `branches` of `remote` into the current branch.
    pub fn pull_from(
        &self,
        remote: &str,
        branches: &[String],
        rebase: bool,
        options: &MergeOptions,
        cancel: &CancellationToken,
        on_output: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let args = pull_args(remote, branches, rebase, options)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        cli::run_streaming(self.root(), &args, cancel, on_output)
    }

    /// Manage Remotes: adds, removes or edits a remote.
    pub fn edit_remote(&self, edit: &RemoteEdit) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
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
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let out = run(self.root(), &["worktree", "list", "--porcelain"], None)?;
        Ok(parse_worktrees(&out.stdout_str()))
    }

    /// Git › New Worktree…: checks out `commitish` at `path`, on a new branch `new_branch`
    /// when given (otherwise `commitish` must be a branch not checked out elsewhere).
    pub fn add_worktree(&self, path: &Path, commitish: &str, new_branch: Option<&str>) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let path = path.to_string_lossy().into_owned();
        let commitish = arg(commitish, "revision")?;
        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        if let Some(b) = new_branch.map(str::trim).filter(|b| !b.is_empty()) {
            args.extend(["-b".into(), arg(b, "branch name")?]);
        }
        args.extend(["--".into(), path, commitish]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(self.root(), &args, None).map(|_| ())
    }

    pub fn remove_worktree(&self, path: &Path, force: bool) -> IdeResult<()> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        let path = path.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.extend(["--", &path]);
        run(self.root(), &args, None).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_args_follow_the_options() {
        let o = MergeOptions { no_ff: true, message: Some("Merge it".into()), ..Default::default() };
        assert_eq!(
            merge_args(&["dev".into()], &o).unwrap(),
            ["merge", "--autostash", "--no-ff", "-m", "Merge it", "dev"]
        );
        assert_eq!(
            merge_args(&["a".into(), "b".into()], &MergeOptions::default()).unwrap(),
            ["merge", "--autostash", "--no-edit", "a", "b"]
        );
        let bad = MergeOptions { ff_only: true, squash: true, ..Default::default() };
        assert!(merge_args(&["dev".into()], &bad).is_err());
        assert!(merge_args(&["--evil".into()], &MergeOptions::default()).is_err());
        assert!(merge_args(&[], &MergeOptions::default()).is_err());
    }

    #[test]
    fn rebase_and_pull_args() {
        let o = RebaseOptions { onto: Some("main".into()), rebase_merges: true, keep_empty: false };
        assert_eq!(
            rebase_args("feature~3", &o).unwrap(),
            ["rebase", "--autostash", "--rebase-merges", "--onto", "main", "feature~3"]
        );
        assert_eq!(
            pull_args("origin", &["main".into()], false, &MergeOptions { ff_only: true, ..Default::default() })
                .unwrap(),
            ["pull", "--progress", "--autostash", "--no-rebase", "--ff-only", "origin", "main"]
        );
        assert_eq!(
            pull_args("origin", &[], true, &MergeOptions::default()).unwrap(),
            ["pull", "--progress", "--autostash", "--rebase", "origin"]
        );
        assert!(pull_args("origin", &[], true, &MergeOptions { squash: true, ..Default::default() }).is_err());
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
