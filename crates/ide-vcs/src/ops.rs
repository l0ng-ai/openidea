//! History-rewriting operations (cherry-pick, revert, reset, tags) and the
//! Continue / Abort / Skip controls of an operation that stopped half-way.

use crate::cli::{self, run};
use crate::repo::{gx, resolve};
use crate::{
    ApplyCommitOptions, ChangeKind, ChangedFile, FileLineStats, MergeSides, RebaseAction, RebaseEntry, Repo, ResetMode,
};
use ide_core::workflow_settings::EmptyCherryPickAction;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::HashSet;
use std::io::Write;

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
        None if !crate::write::unmerged_paths(r)?.is_empty() => {
            use crate::conflict_resolution::RestoreConflict;
            let (name, reversed) = match crate::conflict_resolution::restore_conflict(r)? {
                Some(RestoreConflict::ManualStash) => ("stash-apply", false),
                Some(RestoreConflict::AutomaticShelf) => ("unshelve", true),
                Some(RestoreConflict::PatchApply) => ("apply-patch", false),
                // During automatic restoration stage 2 is the new HEAD, stage 3 the user's work.
                None => ("unstash", true),
            };
            sides.operation = Some(name.into());
            sides.reversed = reversed;
        }
        _ => {}
    }
    Ok(sides)
}

/// Three-way merge of file contents (`git merge-file --diff3`): changes that don't
/// conflict are merged, each conflict is left as a diff3 block.
pub(crate) fn merge_file(r: &Repo, ours: &str, base: &str, theirs: &str) -> IdeResult<String> {
    let dir = tempfile::tempdir()?;
    let file = |name: &str, text: &str| -> IdeResult<String> {
        let path = dir.path().join(name);
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
            run(r.root(), &["for-each-ref", "--points-at", commit, crate::refs::DIRECT_BRANCH_FORMAT, refs], None)
                .ok()?;
        let names: Vec<String> = out.stdout_str().lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
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

/// Why a rebase can't continue: tracked files changed while it was stopped, not staged.
pub const UNSTAGED_CHANGES_PREVENT_REBASE: &str =
    "There are unstaged changes in tracked files preventing rebase from continuing";

fn changed_paths(r: &Repo, args: &[&str]) -> IdeResult<Vec<String>> {
    let text = run(r.root(), args, None)?.stdout_str();
    Ok(text.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// Concludes the operation in progress once every conflict is resolved (staged).
/// `stage` first stages the changes of tracked files (Stage and Retry). Without it a
/// rebase stages only edits of files already staged (made while resolving them) and
/// otherwise fails with [`UNSTAGED_CHANGES_PREVENT_REBASE`].
pub(crate) fn continue_op<T>(r: &Repo, stage: bool, run_command: impl FnOnce(&[&str]) -> IdeResult<T>) -> IdeResult<T> {
    let op = sequencer(r)?;
    let unresolved = unmerged_paths(r)?;
    if !unresolved.is_empty() {
        return Err(IdeError::invalid(format!("resolve all conflicts before continuing: {}", unresolved.join(", "))));
    }
    if stage {
        run(r.root(), &["add", "-u"], None)?;
    } else if op == "rebase" {
        let unstaged = changed_paths(r, &["diff", "--name-only", "-z", "--no-ext-diff"])?;
        if !unstaged.is_empty() {
            let staged: HashSet<String> =
                changed_paths(r, &["diff", "--cached", "--name-only", "-z", "--no-ext-diff"])?.into_iter().collect();
            if !unstaged.iter().all(|p| staged.contains(p)) {
                return Err(IdeError::invalid(UNSTAGED_CHANGES_PREVENT_REBASE));
            }
            cli::run_paths(r.root(), &["add", "-u"], &unstaged)?;
        }
    }
    let args: &[&str] = match op {
        // `git merge --continue` commits with the prepared MERGE_MSG.
        "merge" => &["merge", "--continue"],
        "rebase" => &["rebase", "--continue"],
        "cherry-pick" => &["cherry-pick", "--continue"],
        "revert" => &["revert", "--continue"],
        _ => &["am", "--continue"],
    };
    let result = run_command(args);
    let finished = finish_operation(r);
    result.and_then(|value| finished.map(|()| value))
}

pub(crate) fn commit_apply_message(
    r: &Repo,
    message: &str,
    options: &ApplyCommitOptions,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(&r.git_dir)?;
    file.write_all(message.as_bytes())?;
    let path = file.path().to_str().ok_or_else(|| IdeError::invalid("Invalid commit message file path"))?;
    let flags = crate::write::commit_metadata_flags(
        options.sign_off,
        options.run_hooks,
        options.author.as_deref(),
        options.author_date.as_deref(),
    );
    let mut args = vec!["commit", "--cleanup=whitespace", "-F", path];
    args.extend(flags.iter().map(String::as_str));
    cli::run_streaming(r.root(), &args, cancel, out)
}

pub(crate) fn abort_op(
    r: &Repo,
    expected: Option<&str>,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    let op = sequencer(r)?;
    if expected.is_some_and(|expected| expected != op) {
        return Err(IdeError::invalid("Git operation changed before it could be aborted"));
    }
    let result = cli::run_streaming(r.root(), &[op, "--abort"], cancel, out);
    let finished = finish_operation(r);
    result.and(finished)
}

pub(crate) fn finish_merge(
    r: &Repo,
    branch: Option<&str>,
    head: &str,
    target: &str,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    let (current_branch, current_head) = r.head()?;
    let merge_head = std::fs::read_to_string(r.git_dir.join("MERGE_HEAD")).ok();
    if current_branch.as_deref() != branch
        || current_head.as_deref() != Some(head)
        || merge_head.as_deref().map(str::trim) != Some(target)
    {
        return Err(IdeError::invalid("The merge changed before it could be finished"));
    }
    let result = cli::run_streaming(r.root(), &["merge", "--continue"], cancel, out);
    let finished = finish_operation(r);
    result.and(finished)
}

pub(crate) fn skip_op<T>(r: &Repo, run_command: impl FnOnce(&[&str]) -> IdeResult<T>) -> IdeResult<T> {
    let op = sequencer(r)?;
    if op == "merge" {
        return Err(IdeError::invalid("a merge cannot be skipped; abort it instead"));
    }
    let result = run_command(&[op, "--skip"]);
    let finished = finish_operation(r);
    result.and_then(|value| finished.map(|()| value))
}

/// Merge commits need a mainline (`-m`), which IDEA doesn't offer for cherry-pick / revert.
pub(crate) fn checked_apply_commits(r: &Repo, commits: &[String], verb: &str) -> IdeResult<Vec<String>> {
    check_commits(commits)?;
    let repo = r.gix()?;
    commits
        .iter()
        .map(|c| {
            let commit = repo.find_object(resolve(&repo, c)?).map_err(gx)?.peel_to_commit().map_err(gx)?;
            let hex = commit.id.to_string();
            if commit.parent_ids().count() > 1 {
                return Err(IdeError::invalid(format!("cannot {verb} merge commit {}", &hex[..8])));
            }
            Ok(hex)
        })
        .collect()
}

pub(crate) fn apply_cherry_pick(
    r: &Repo,
    commits: &[String],
    record_origin: bool,
    empty_action: EmptyCherryPickAction,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<u32> {
    let mut args = vec!["cherry-pick"];
    if record_origin {
        args.push("-x");
    }
    args.extend(commits.iter().map(String::as_str));
    apply_resolving_empty(r, "cherry-pick", &args, empty_action, cancel, out)
}

/// Creates commits undoing `commits`, in the given order (pass newest first).
pub(crate) fn revert(r: &Repo, commits: &[String], cancel: &CancellationToken, out: &dyn Fn(String)) -> IdeResult<()> {
    let commits = checked_apply_commits(r, commits, "revert")?;
    let mut args = vec!["revert", "--no-edit"];
    args.extend(commits.iter().map(String::as_str));
    apply_resolving_empty(r, "revert", &args, EmptyCherryPickAction::Skip, cancel, out).map(|_| ())
}

/// Resolves empty steps while leaving conflicts and other failures to the caller.
pub(crate) fn apply_resolving_empty(
    r: &Repo,
    verb: &str,
    args: &[&str],
    action: EmptyCherryPickAction,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<u32> {
    let cherry_pick = verb == "cherry-pick";
    let head_file = if cherry_pick { "CHERRY_PICK_HEAD" } else { "REVERT_HEAD" };
    let is_empty = std::cell::Cell::new(false);
    let run = |args: &[&str]| {
        is_empty.set(false);
        cli::run_streaming(r.root(), args, cancel, &|line| {
            // Git runs with LC_ALL=C. An empty pick leaves a prepared commit message.
            is_empty.set(
                is_empty.get()
                    || line.contains("nothing to commit")
                    || line.contains("nothing added to commit but untracked files present")
                    || line.contains("previous cherry-pick is now empty"),
            );
            out(line);
        })
    };
    let mut empty_count = 0;
    let mut result = run(args);
    while result.is_err() && !cancel.is_cancelled() {
        let Ok(stopped) = std::fs::read_to_string(r.git_dir.join(head_file)) else {
            if is_empty.get() && action == EmptyCherryPickAction::Skip && r.operation()?.is_none() {
                out("Skipped: its changes are already applied".into());
                return Ok(empty_count + 1);
            }
            break;
        };
        if (cherry_pick && !is_empty.get())
            || !unmerged_paths(r)?.is_empty()
            || cli::run_raw(r.root(), &["diff", "--cached", "--quiet", "--"], None)?.code != Some(0)
        {
            break;
        }
        let id = stopped.trim();
        let short = &id[..id.len().min(8)];
        empty_count += 1;
        match action {
            EmptyCherryPickAction::Skip => {
                out(format!("{short} skipped: its changes are already applied"));
                result = run(&[verb, "--skip"]);
            }
            EmptyCherryPickAction::CreateEmpty => {
                cli::run_streaming(r.root(), &["commit", "--allow-empty"], cancel, out)?;
                // The commit clears CHERRY_PICK_HEAD. A native multi-pick still has its todo.
                if !r.git_dir.join("sequencer/todo").is_file() {
                    return Ok(empty_count);
                }
                result = run(&[verb, "--continue"]);
            }
        }
    }
    result.map(|()| empty_count)
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
        let wants_message =
            matches!(e.action, RebaseAction::Reword | RebaseAction::Squash | RebaseAction::Fixup | RebaseAction::Pick);
        if let Some(m) = message.filter(|_| wants_message) {
            if next_joins {
                return Err(IdeError::invalid(
                    "set the message on the last commit of a squash group, not on the commit squashed into",
                ));
            }
            let file = work.join(format!("msg-{i}"));
            std::fs::write(&file, m)?;
            todo.push_str(&format!(
                "exec git commit --amend --allow-empty --no-verify --quiet --cleanup=whitespace -F {}\n",
                quote_for_shell(&file)
            ));
        }
    }
    let args = ["rebase", "--interactive", "--no-autosquash", base.unwrap_or("--root")];
    run_rebase_todo(r, &work, &todo, &args, cancel, out)
}

pub(crate) fn quote_for_shell(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"))
}

pub(crate) fn run_rebase_todo(
    r: &Repo,
    work: &std::path::Path,
    todo: &str,
    args: &[&str],
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    let todo_file = work.join("todo");
    std::fs::write(&todo_file, todo)?;
    let editor = format!("cp {}", quote_for_shell(&todo_file));
    // Local changes are put aside and restored when the rebase is over, staged ones as
    // staged (git's --autostash would bring them all back unstaged).
    crate::preserve::save(r, "Local changes saved before rebase")?;
    let env = [("GIT_SEQUENCE_EDITOR", std::ffi::OsStr::new(&editor))];
    let result = cli::run_streaming_env(r.root(), args, &env, cancel, out);
    // A stopped rebase still needs the message files for its remaining `exec` lines.
    let finished = finish_operation(r);
    result.and(finished)
}

/// Once a rebase / merge / cherry-pick / revert is over, brings back the local changes
/// put aside for it; the plan files of [`interactive_rebase`] go once it is done.
pub(crate) fn finish_operation(r: &Repo) -> IdeResult<()> {
    if r.branch_info()?.operation.is_some() {
        return Ok(());
    }
    crate::cherry_pick_plan::clear(r);
    let _ = std::fs::remove_dir_all(r.git_dir.join("openidea-rebase"));
    crate::preserve::restore(r)
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

fn tag_ref(name: &str) -> IdeResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.contains("..") || name.contains(':') {
        return Err(IdeError::invalid(format!("'{name}' is not a valid tag name")));
    }
    Ok(format!("refs/tags/{name}"))
}

pub(crate) fn delete_tag(r: &Repo, name: &str) -> IdeResult<crate::DeletedTag> {
    let tag = tag_ref(name)?;
    let target = run(r.root(), &["rev-parse", "-q", "--verify", &tag], None)
        .map_err(|_| IdeError::invalid(format!("Could not find tag {name}")))?
        .stdout_str();
    let target = target.trim().to_string();
    run(r.root(), &["update-ref", "-d", &tag, &target], None)?;
    Ok(crate::DeletedTag { name: name.trim().to_string(), target })
}

pub(crate) fn restore_tag(r: &Repo, deleted: &crate::DeletedTag) -> IdeResult<()> {
    let tag = tag_ref(&deleted.name)?;
    let target = deleted.target.trim();
    if target.is_empty() || target.starts_with('-') {
        return Err(IdeError::invalid("invalid tag target"));
    }
    // Only recreates it: a tag made with that name meanwhile stays.
    run(r.root(), &["update-ref", &tag, target, ""], None).map(|_| ())
}

pub(crate) fn push_tag(
    r: &Repo,
    name: &str,
    remote: &str,
    delete: bool,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<crate::PushReport> {
    let tag = tag_ref(name)?;
    remote_push_urls(r, remote, cancel)?;
    let spec = if delete { format!(":{tag}") } else { format!("{tag}:{tag}") };
    let mut report = crate::PushReport::new(Some(remote.to_owned()));
    crate::push_report::run(
        &mut report,
        r.root(),
        &["push", "--progress", "--porcelain", "--", remote, &spec],
        cancel,
        on_output,
    )?;
    Ok(report)
}

pub(crate) fn remote_fetch_url(r: &Repo, remote: &str, cancel: &CancellationToken) -> IdeResult<String> {
    let output = cli::run_cancellable(r.root(), &["remote", "get-url", "--", remote], cancel)?;
    output
        .stdout_str()
        .lines()
        .next()
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| IdeError::invalid(format!("remote '{remote}' has no fetch URL")))
}

pub(crate) fn remote_push_urls(r: &Repo, remote: &str, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
    if remote.is_empty() || remote.starts_with('-') {
        return Err(IdeError::invalid(format!("invalid remote '{remote}'")));
    }
    let output = cli::run_cancellable(r.root(), &["remote", "get-url", "--push", "--all", remote], cancel)?;
    let urls: Vec<_> = output.stdout_str().lines().filter(|url| !url.is_empty()).map(str::to_owned).collect();
    if urls.is_empty() {
        return Err(IdeError::invalid(format!("remote '{remote}' has no push URL")));
    }
    Ok(urls)
}

pub(crate) fn delete_tag_on_remotes(
    r: &Repo,
    deleted: &crate::DeletedTag,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<()> {
    let tag = tag_ref(&deleted.name)?;
    let expected = gix::ObjectId::from_hex(deleted.target.as_bytes()).map_err(gx)?.to_string();
    let lease = format!("--force-with-lease={tag}:{expected}");
    let deletion = format!(":{tag}");
    let mut failures = Vec::new();
    for remote in r.remotes()? {
        out(format!("Checking tag {} on {}", deleted.name, remote.name));
        let urls = match remote_push_urls(r, &remote.name, cancel) {
            Ok(urls) => urls,
            Err(e) if cancel.is_cancelled() => return Err(e),
            Err(e) => {
                failures.push(format!("{}: {e}", remote.name));
                continue;
            }
        };
        let receive_pack =
            if urls.len() > 1 { r.config_get(&format!("remote.{}.receivepack", remote.name))? } else { None };
        for url in &urls {
            let push_target = if urls.len() == 1 { remote.name.as_str() } else { url.as_str() };
            let result = (|| {
                let args = ["ls-remote", "--exit-code", "--refs", "--tags", "--", url, &tag];
                let refs = cli::run_cancellable_raw(r.root(), &args, cancel)?;
                if !matches!(refs.code, Some(0 | 2)) {
                    return Err(cli::failure(&args, &refs.stderr, &refs.stdout, refs.code));
                }
                if !refs.stdout_str().lines().any(|line| line.split_once('\t').is_some_and(|(_, name)| name == tag)) {
                    out(format!("Tag {} is already absent on {}", deleted.name, remote.name));
                    return Ok(());
                }
                let mut args = vec!["push", "--progress", &lease];
                if let Some(receive_pack) = receive_pack.as_deref() {
                    args.extend(["--receive-pack", receive_pack]);
                }
                args.extend(["--", push_target, &deletion]);
                cli::run_streaming(r.root(), &args, cancel, out)
            })();
            if let Err(e) = result {
                if cancel.is_cancelled() {
                    return Err(e);
                }
                failures.push(format!("{}: {e}", remote.name));
            }
        }
    }
    if failures.is_empty() { Ok(()) } else { Err(IdeError::invalid(failures.join("\n"))) }
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
    if !crate::execution_allowed() {
        let out = run(
            r.root(),
            &["diff", "--cached", "--name-status", "-z", "--no-ext-diff", "--no-textconv", rev, "--"],
            None,
        )?;
        let mut paths: std::collections::BTreeSet<String> =
            parse_name_status(&out.stdout_str()).into_iter().map(|c| c.path).collect();
        paths.extend(r.status()?.into_iter().filter(|s| s.unstaged != Some(ChangeKind::Untracked)).map(|s| s.rel_path));
        let repo = r.gix()?;
        let mut changes = Vec::new();
        for path in paths {
            let old = crate::repo::blob_at(&repo, &path, rev)?;
            let new = match std::fs::read(r.abs_path(&path)) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            if old == new {
                continue;
            }
            let kind = if old.is_none() {
                ChangeKind::Added
            } else if new.is_none() {
                ChangeKind::Deleted
            } else {
                ChangeKind::Modified
            };
            changes.push(ChangedFile { path, kind, old_path: None, link: None });
        }
        return Ok(changes);
    }
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

/// Added and deleted lines between two revisions. `paths` limits the diff (pass both names of
/// a rename); an empty list, or one too long for the command line, diffs every file.
pub(crate) fn diff_numstat(r: &Repo, from: &str, to: &str, paths: &[String]) -> IdeResult<Vec<FileLineStats>> {
    check_commits(&[from.to_string(), to.to_string()])?;
    let mut args = vec!["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", from, to];
    // Windows command lines are short; past this, the unfiltered diff still contains these paths.
    let limited = !paths.is_empty() && paths.iter().map(|p| p.len() + 1).sum::<usize>() <= 16_000;
    if limited {
        args.push("--");
        args.extend(paths.iter().filter(|p| !p.is_empty()).map(String::as_str));
    }
    let out = run(r.root(), &args, None)?;
    Ok(parse_numstat_z(&out.stdout_str()))
}

/// `git diff --numstat -z -M`: `added\tremoved\tpath\0`, or `added\tremoved\0old\0new\0` for a rename.
/// Binary files (`-`) count as 0.
pub(crate) fn parse_numstat_z(text: &str) -> Vec<FileLineStats> {
    let mut parts = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(rec) = parts.next() {
        let mut fields = rec.splitn(3, '\t');
        let added = fields.next().unwrap_or("0").parse().unwrap_or(0);
        let removed = fields.next().unwrap_or("0").parse().unwrap_or(0);
        let (path, old_path) = if let Some(path) = fields.next().filter(|p| !p.is_empty()) {
            (path.to_owned(), None)
        } else {
            let (Some(old), Some(new)) = (parts.next(), parts.next()) else { break };
            (new.to_owned(), Some(old.to_owned()))
        };
        if !path.is_empty() {
            out.push(FileLineStats { path, old_path, added, removed });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.old_path.cmp(&b.old_path)));
    out
}

/// Files that differ between two revisions (Update Project's "N files updated").
pub(crate) fn diff_revisions(r: &Repo, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
    check_commits(&[from.to_string(), to.to_string()])?;
    let out = run(r.root(), &["diff", "--raw", "-z", "-M", "--no-ext-diff", "--no-textconv", from, to, "--"], None)?;
    let mut files = parse_raw_diff(&out.stdout_str());
    if files.iter().any(|(_, link)| *link) {
        let repo = r.gix()?;
        let (old_tree, new_tree) = (crate::repo::tree_of(&repo, from)?, crate::repo::tree_of(&repo, to)?);
        for (file, link) in &mut files {
            if *link {
                // A deleted link is described as it was at `from`.
                let tree = if file.kind == ChangeKind::Deleted { old_tree.as_ref() } else { new_tree.as_ref() };
                file.link = tree.and_then(|t| crate::repo::link_target(&repo, t, &file.path));
            }
        }
    }
    Ok(files.into_iter().map(|(file, _)| file).collect())
}

/// Parses `git diff --raw -z` output: each file, and whether it is a symbolic link after the
/// change (before it, for a deletion).
fn parse_raw_diff(text: &str) -> Vec<(ChangedFile, bool)> {
    const LINK_MODE: &str = "120000";
    let mut parts = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(header) = parts.next() {
        let fields: Vec<&str> = header.trim_start_matches(':').split(' ').collect();
        let [old_mode, new_mode, _, _, status] = fields[..] else { continue };
        let kind = match status.as_bytes().first() {
            Some(b'A') | Some(b'C') => ChangeKind::Added,
            Some(b'D') => ChangeKind::Deleted,
            Some(b'R') => ChangeKind::Renamed,
            Some(b'U') => ChangeKind::Conflicted,
            _ => ChangeKind::Modified,
        };
        let (path, old_path) = if matches!(status.as_bytes().first(), Some(b'R' | b'C')) {
            let old = parts.next().unwrap_or_default().to_string();
            (parts.next().unwrap_or_default().to_string(), Some(old))
        } else {
            (parts.next().unwrap_or_default().to_string(), None)
        };
        let link = if kind == ChangeKind::Deleted { old_mode == LINK_MODE } else { new_mode == LINK_MODE };
        if !path.is_empty() {
            out.push((ChangedFile { path, kind, old_path, link: None }, link));
        }
    }
    out.sort_by(|a, b| a.0.path.cmp(&b.0.path));
    out
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
            out.push(ChangedFile { path, kind, old_path, link: None });
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
    fn raw_diff_parsing_marks_symbolic_links() {
        let link = "120000";
        let file = "100644";
        let none = "000000";
        let z = "0000000000000000000000000000000000000000";
        let text = format!(
            ":{file} {file} {z} {z} M\0a.txt\0:{none} {link} {z} {z} A\0new link\0\
             :{link} {none} {z} {z} D\0gone\0:{link} {link} {z} {z} R100\0old\0renamed\0\
             :{link} {file} {z} {z} T\0now file\0"
        );
        let files: Vec<_> =
            parse_raw_diff(&text).into_iter().map(|(f, link)| (f.path, f.kind, f.old_path, link)).collect();
        assert_eq!(
            files,
            [
                ("a.txt".into(), ChangeKind::Modified, None, false),
                ("gone".into(), ChangeKind::Deleted, None, true),
                ("new link".into(), ChangeKind::Added, None, true),
                ("now file".into(), ChangeKind::Modified, None, false),
                ("renamed".into(), ChangeKind::Renamed, Some("old".into()), true),
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

    #[test]
    fn numstat_z_parsing_counts_renames_and_binaries_as_zero() {
        let text = "1\t0\timg.bin\u{0}2\t1\u{0}file.txt\u{0}renamed.txt\u{0}-\t-\tbin.dat\u{0}";
        assert_eq!(
            parse_numstat_z(text),
            vec![
                FileLineStats { path: "bin.dat".into(), old_path: None, added: 0, removed: 0 },
                FileLineStats { path: "img.bin".into(), old_path: None, added: 1, removed: 0 },
                FileLineStats { path: "renamed.txt".into(), old_path: Some("file.txt".into()), added: 2, removed: 1 },
            ]
        );
    }
}
