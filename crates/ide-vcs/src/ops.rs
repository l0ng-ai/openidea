//! History-rewriting operations (cherry-pick, revert, reset, tags) and the
//! Continue / Abort / Skip controls of an operation that stopped half-way.

use crate::cli::{self, run};
use crate::repo::{gx, resolve};
use crate::{ChangeKind, ChangedFile, MergeSides, RebaseAction, RebaseEntry, Repo, ResetMode};
use ide_core::{CancellationToken, IdeError, IdeResult};

/// The in-progress operation git can continue / abort / skip.
fn sequencer(r: &Repo) -> IdeResult<&'static str> {
    match r.branch_info()?.operation.as_deref() {
        Some("rebase") => Ok("rebase"),
        Some("merge") => Ok("merge"),
        Some("cherry-pick") => Ok("cherry-pick"),
        Some("revert") => Ok("revert"),
        Some("am") => Ok("am"),
        _ => Err(IdeError::invalid("no merge, rebase, cherry-pick or revert is in progress")),
    }
}

use crate::write::unmerged_paths;

/// The sides of the operation in progress, read from the files git keeps in `.git`.
pub(crate) fn merge_sides(r: &Repo) -> IdeResult<MergeSides> {
    let repo = r.gix()?;
    let operation = crate::refs::operation(&repo);
    let read = |name: &str| {
        std::fs::read_to_string(r.git_dir.join(name))
            .ok()
            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
            .filter(|s| !s.is_empty())
    };
    let short = |id: String| id.chars().take(8).collect::<String>();
    let head_branch = repo.head_name().map_err(gx)?.map(|n| crate::repo::to_string(n.as_ref().shorten()));
    let mut sides = MergeSides { operation: operation.clone(), branch: head_branch, ..Default::default() };
    match operation.as_deref() {
        Some("rebase") => {
            sides.reversed = true;
            let dir = ["rebase-merge", "rebase-apply"].into_iter().find(|d| r.git_dir.join(d).is_dir());
            if let Some(dir) = dir {
                if let Some(head) = read(&format!("{dir}/head-name")) {
                    sides.branch = Some(head.strip_prefix("refs/heads/").unwrap_or(&head).to_string());
                }
                sides.other_branch = read(&format!("{dir}/onto")).and_then(|onto| branch_at(r, &onto));
            }
            sides.commit = read("REBASE_HEAD").map(short);
        }
        Some("merge") => {
            let head = read("MERGE_HEAD");
            // git quotes the merged ref on the first line: `Merge branch 'main' into feature`.
            sides.other_branch = read("MERGE_MSG")
                .and_then(|m| m.split('\'').nth(1).map(str::to_string))
                .filter(|b| !b.is_empty())
                .or_else(|| head.as_deref().and_then(|h| branch_at(r, h)));
            sides.commit = head.map(short);
        }
        Some("cherry-pick") => sides.commit = read("CHERRY_PICK_HEAD").map(short),
        Some("revert") => sides.commit = read("REVERT_HEAD").map(short),
        // Conflicts outside an operation come from restoring stashed changes (Smart
        // Checkout, update with autostash): stage 2 is the new HEAD, stage 3 the user's.
        None if !crate::write::unmerged_paths(r)?.is_empty() => {
            sides.operation = Some("unstash".into());
            sides.reversed = true;
        }
        _ => {}
    }
    Ok(sides)
}

/// Three-way merge of file contents (`git merge-file --diff3`): changes that don't
/// conflict are merged, each conflict is left as a diff3 block.
pub(crate) fn merge_file(r: &Repo, ours: &str, base: &str, theirs: &str) -> IdeResult<String> {
    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let dir = TempDir(r.git_dir.join(format!("openidea-merge-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0)?;
    let file = |name: &str, text: &str| -> IdeResult<String> {
        let path = dir.0.join(name);
        std::fs::write(&path, text)?;
        Ok(path.to_string_lossy().into_owned())
    };
    let (o, b, t) = (file("ours", ours)?, file("base", base)?, file("theirs", theirs)?);
    let args = ["merge-file", "-p", "--diff3", "-L", "yours", "-L", "base", "-L", "theirs", &o, &b, &t];
    let out = cli::run_raw(r.root(), &args, None)?;
    // The exit status is the number of conflicts; only a negative one is a failure.
    match out.code {
        Some(code) if code >= 0 => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        code => Err(cli::failure(&args, &out.stderr, &out.stdout, code)),
    }
}

/// The single branch (local first, then remote) pointing at `commit`.
fn branch_at(r: &Repo, commit: &str) -> Option<String> {
    if commit.starts_with('-') {
        return None;
    }
    ["refs/heads", "refs/remotes"].into_iter().find_map(|refs| {
        let out =
            run(r.root(), &["for-each-ref", "--points-at", commit, "--format=%(refname:short)", refs], None).ok()?;
        let names: Vec<String> =
            out.stdout_str().lines().filter(|l| !l.is_empty() && !l.ends_with("/HEAD")).map(str::to_string).collect();
        match names.as_slice() {
            [one] => Some(one.clone()),
            _ => None,
        }
    })
}

fn check_commits(commits: &[String]) -> IdeResult<()> {
    if commits.is_empty() {
        return Err(IdeError::invalid("no commits selected"));
    }
    if commits.iter().any(|c| c.trim().is_empty() || c.starts_with('-')) {
        return Err(IdeError::invalid("invalid revision"));
    }
    Ok(())
}

/// Concludes the operation in progress once every conflict is resolved (staged).
pub(crate) fn continue_op(r: &Repo, cancel: &CancellationToken, out: &dyn Fn(String)) -> IdeResult<()> {
    let op = sequencer(r)?;
    let unresolved = unmerged_paths(r)?;
    if !unresolved.is_empty() {
        return Err(IdeError::invalid(format!("resolve all conflicts before continuing: {}", unresolved.join(", "))));
    }
    let args: &[&str] = match op {
        // `git merge --continue` commits with the prepared MERGE_MSG.
        "merge" => &["merge", "--continue"],
        "rebase" => &["rebase", "--continue"],
        "cherry-pick" => &["cherry-pick", "--continue"],
        "revert" => &["revert", "--continue"],
        _ => &["am", "--continue"],
    };
    cli::run_streaming(r.root(), args, cancel, out)
}

pub(crate) fn abort_op(r: &Repo, cancel: &CancellationToken, out: &dyn Fn(String)) -> IdeResult<()> {
    let op = sequencer(r)?;
    cli::run_streaming(r.root(), &[op, "--abort"], cancel, out)
}

pub(crate) fn skip_op(r: &Repo, cancel: &CancellationToken, out: &dyn Fn(String)) -> IdeResult<()> {
    let op = sequencer(r)?;
    if op == "merge" {
        return Err(IdeError::invalid("a merge cannot be skipped; abort it instead"));
    }
    cli::run_streaming(r.root(), &[op, "--skip"], cancel, out)
}

/// Merge commits need a mainline (`-m`), which IDEA doesn't offer for cherry-pick / revert.
fn reject_merges(r: &Repo, commits: &[String], verb: &str) -> IdeResult<()> {
    let repo = r.gix()?;
    for c in commits {
        let commit = repo.find_object(resolve(&repo, c)?).map_err(gx)?.peel_to_commit().map_err(gx)?;
        if commit.parent_ids().count() > 1 {
            let hex = commit.id.to_string();
            return Err(IdeError::invalid(format!("cannot {verb} merge commit {}", &hex[..8])));
        }
    }
    Ok(())
}

/// Applies `commits` on top of HEAD, in the given order (pass oldest first).
pub(crate) fn cherry_pick(
    r: &Repo,
    commits: &[String],
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    check_commits(commits)?;
    reject_merges(r, commits, "cherry-pick")?;
    let mut args = vec!["cherry-pick"];
    args.extend(commits.iter().map(String::as_str));
    cli::run_streaming(r.root(), &args, cancel, out)
}

/// Creates commits undoing `commits`, in the given order (pass newest first).
pub(crate) fn revert(r: &Repo, commits: &[String], cancel: &CancellationToken, out: &dyn Fn(String)) -> IdeResult<()> {
    check_commits(commits)?;
    reject_merges(r, commits, "revert")?;
    let mut args = vec!["revert", "--no-edit"];
    args.extend(commits.iter().map(String::as_str));
    cli::run_streaming(r.root(), &args, cancel, out)
}

pub(crate) fn reset(
    r: &Repo,
    commit: &str,
    mode: ResetMode,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    check_commits(&[commit.to_string()])?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
        ResetMode::Keep => "--keep",
    };
    cli::run_streaming(r.root(), &["reset", flag, commit, "--"], cancel, out)
}

/// Interactive rebase of `base..HEAD` (`base == None`: the whole history) with the
/// given todo list, oldest first. Every commit of the range must appear exactly once.
/// Rewords and squash messages are applied by `exec git commit --amend` lines, so the
/// rebase runs without an editor; conflicts stop it like any rebase.
pub(crate) fn interactive_rebase(
    r: &Repo,
    base: Option<&str>,
    entries: &[RebaseEntry],
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    if r.branch_info()?.operation.is_some() {
        return Err(IdeError::invalid("another merge, rebase, cherry-pick or revert is in progress"));
    }
    if entries.is_empty() {
        return Err(IdeError::invalid("no commits to rebase"));
    }
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = base {
        check_commits(&[b.to_string()])?;
    }
    // The commits of the range, resolved to full ids.
    let range = match base {
        Some(b) => format!("{b}..HEAD"),
        None => "HEAD".to_string(),
    };
    let listed = run(r.root(), &["rev-list", "--parents", "--end-of-options", &range], None)?.stdout_str();
    let mut in_range = std::collections::HashSet::new();
    for line in listed.lines() {
        let mut ids = line.split_whitespace();
        let Some(id) = ids.next() else { continue };
        if ids.count() > 1 {
            return Err(IdeError::invalid("interactive rebase of a range containing merge commits is not supported"));
        }
        in_range.insert(id.to_string());
    }
    let mut ids = Vec::with_capacity(entries.len());
    {
        let repo = r.gix()?;
        for e in entries {
            check_commits(std::slice::from_ref(&e.commit))?;
            let id = repo.find_object(resolve(&repo, &e.commit)?).map_err(gx)?.peel_to_commit().map_err(gx)?.id;
            ids.push(id.to_string());
        }
    }
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if unique.len() != ids.len() || unique.len() != in_range.len() || ids.iter().any(|id| !in_range.contains(id)) {
        return Err(IdeError::invalid("the commit list does not match the commits being rebased; refresh the log"));
    }
    let first_kept = entries.iter().position(|e| e.action != RebaseAction::Drop);
    if let Some(i) = first_kept
        && matches!(entries[i].action, RebaseAction::Squash | RebaseAction::Fixup)
    {
        return Err(IdeError::invalid("the first commit cannot be squashed or fixed up into a previous one"));
    }

    let work = r.git_dir.join("openidea-rebase");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)?;
    let quote = |p: &std::path::Path| format!("'{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"));
    let mut todo = String::new();
    for (i, (e, id)) in entries.iter().zip(&ids).enumerate() {
        let verb = match e.action {
            RebaseAction::Pick | RebaseAction::Reword => "pick",
            RebaseAction::Edit => "edit",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
            RebaseAction::Drop => "drop",
        };
        todo.push_str(&format!("{verb} {id}\n"));
        // A new message applies after the commit (and anything squashed into it).
        let next_joins =
            entries.get(i + 1).is_some_and(|n| matches!(n.action, RebaseAction::Squash | RebaseAction::Fixup));
        let message = e.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let wants_message = matches!(e.action, RebaseAction::Reword | RebaseAction::Squash | RebaseAction::Pick);
        if let Some(m) = message.filter(|_| wants_message) {
            if next_joins {
                return Err(IdeError::invalid(
                    "set the message on the last commit of a squash group, not on the commit squashed into",
                ));
            }
            let file = work.join(format!("msg-{i}"));
            std::fs::write(&file, m)?;
            todo.push_str(&format!(
                "exec git commit --amend --allow-empty --no-verify --quiet --cleanup=strip -F {}\n",
                quote(&file)
            ));
        }
    }
    let todo_file = work.join("todo");
    std::fs::write(&todo_file, todo)?;
    let editor = format!("cp {}", quote(&todo_file));
    let mut args = vec!["rebase", "--interactive", "--autostash", "--no-autosquash"];
    args.push(base.unwrap_or("--root"));
    let env = [("GIT_SEQUENCE_EDITOR", std::ffi::OsStr::new(&editor))];
    cli::run_streaming_env(r.root(), &args, &env, cancel, out)?;
    // A stopped rebase still needs the message files for its remaining `exec` lines.
    if r.branch_info()?.operation.is_none() {
        let _ = std::fs::remove_dir_all(&work);
    }
    Ok(())
}

/// Creates a tag on `commit`: annotated when `message` is non-empty, else lightweight.
pub(crate) fn create_tag(r: &Repo, name: &str, commit: &str, message: Option<&str>, force: bool) -> IdeResult<()> {
    let name = name.trim();
    let valid = !name.is_empty()
        && !name.starts_with('-')
        && cli::run_raw(r.root(), &["check-ref-format", &format!("refs/tags/{name}")], None)?.code == Some(0);
    if !valid {
        return Err(IdeError::invalid(format!("'{name}' is not a valid tag name")));
    }
    {
        let repo = r.gix()?;
        resolve(&repo, commit)?;
    }
    let mut args = vec!["tag"];
    if force {
        args.push("-f");
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if message.is_some() {
        args.extend(["-a", "-F", "-"]);
    }
    args.extend(["--", name, commit]);
    run(r.root(), &args, message.map(str::as_bytes)).map(|_| ())
}

/// Tag names, sorted.
pub(crate) fn tags(r: &Repo) -> IdeResult<Vec<String>> {
    let repo = r.gix()?;
    let refs = repo.references().map_err(gx)?;
    let mut out: Vec<String> =
        refs.tags().map_err(gx)?.filter_map(Result::ok).map(|t| crate::repo::to_string(t.name().shorten())).collect();
    out.sort();
    Ok(out)
}

/// Tracked files that differ between `rev` and the working tree (Compare with Local).
pub(crate) fn diff_with_worktree(r: &Repo, rev: &str) -> IdeResult<Vec<ChangedFile>> {
    check_commits(&[rev.to_string()])?;
    let out = run(r.root(), &["diff", "--name-status", "-z", "-M", "--no-ext-diff", rev, "--"], None)?;
    Ok(parse_name_status(&out.stdout_str()))
}

/// Added / deleted line counts of tracked files whose working-tree content differs from `rev`
/// (`git diff --numstat`); binary files count 0.
pub(crate) fn numstat_with_worktree(r: &Repo, rev: &str) -> IdeResult<Vec<(String, u32, u32)>> {
    check_commits(&[rev.to_string()])?;
    let out = run(r.root(), &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", rev, "--"], None)?;
    Ok(parse_numstat(&out.stdout_str()))
}

pub(crate) fn parse_numstat(text: &str) -> Vec<(String, u32, u32)> {
    text.split('\0')
        .filter_map(|rec| {
            let mut parts = rec.splitn(3, '\t');
            let added = parts.next()?.parse().unwrap_or(0);
            let deleted = parts.next()?.parse().unwrap_or(0);
            let path = parts.next().filter(|p| !p.is_empty())?;
            Some((path.to_owned(), added, deleted))
        })
        .collect()
}

/// Files that differ between two revisions (Update Project's "N files updated").
pub(crate) fn diff_revisions(r: &Repo, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
    check_commits(&[from.to_string(), to.to_string()])?;
    let out = run(r.root(), &["diff", "--name-status", "-z", "-M", "--no-ext-diff", from, to, "--"], None)?;
    Ok(parse_name_status(&out.stdout_str()))
}

/// Parses `git diff --name-status -z` output.
pub(crate) fn parse_name_status(text: &str) -> Vec<ChangedFile> {
    let mut parts = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(status) = parts.next() {
        let kind = match status.as_bytes()[0] {
            b'A' => ChangeKind::Added,
            b'D' => ChangeKind::Deleted,
            b'R' => ChangeKind::Renamed,
            b'C' => ChangeKind::Added,
            b'U' => ChangeKind::Conflicted,
            _ => ChangeKind::Modified,
        };
        let (path, old_path) = if matches!(status.as_bytes()[0], b'R' | b'C') {
            let old = parts.next().unwrap_or_default().to_string();
            (parts.next().unwrap_or_default().to_string(), Some(old))
        } else {
            (parts.next().unwrap_or_default().to_string(), None)
        };
        if !path.is_empty() {
            out.push(ChangedFile { path, kind, old_path });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_parsing() {
        let files = parse_name_status("M\0a.txt\0R087\0old.rs\0new.rs\0A\0b c.txt\0D\0gone\0");
        let got: Vec<(&str, ChangeKind, Option<&str>)> =
            files.iter().map(|f| (f.path.as_str(), f.kind, f.old_path.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("a.txt", ChangeKind::Modified, None),
                ("b c.txt", ChangeKind::Added, None),
                ("gone", ChangeKind::Deleted, None),
                ("new.rs", ChangeKind::Renamed, Some("old.rs")),
            ]
        );
    }

    #[test]
    fn numstat_parsing() {
        let got = parse_numstat("3\t1\tsrc/a.rs\0-\t-\timg.png\0\x30\t7\tdir/b c.txt\0");
        assert_eq!(
            got,
            vec![("src/a.rs".to_owned(), 3, 1), ("img.png".to_owned(), 0, 0), ("dir/b c.txt".to_owned(), 0, 7)]
        );
    }
}
