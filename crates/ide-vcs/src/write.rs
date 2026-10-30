//! Operations delegated to the git CLI (all writes, plus blame and textual diffs).

use crate::cli::{self, run};
use crate::repo::{gx, resolve};
use crate::text_encoding::{decode, encode, has_bom, is_binary};
use crate::{
    BlameLine, CheckoutMode, CheckoutOptions, CheckoutOutcome, CommitOptions, DeletedBranch, DivergedLocal,
    PushBranchOptions, Repo,
};
use encoding_rs::Encoding;
use gix::bstr::{BStr, ByteSlice};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::{Path, PathBuf};

const UNCOMMITTED_AUTHOR: &str = "Not Committed Yet";

impl Repo {
    pub(crate) fn rel_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<String>> {
        paths
            .iter()
            .map(|p| {
                let rel = self.rel_path(p)?;
                Ok(if rel.is_empty() { ".".to_string() } else { rel })
            })
            .collect()
    }

    pub(crate) fn has_head(&self) -> IdeResult<bool> {
        let repo = self.gix()?;
        Ok(!repo.head().map_err(gx)?.is_unborn())
    }
}

/// Runs a path-taking git command with literal pathspecs.
fn run_paths(r: &Repo, args: &[&str], paths: &[String]) -> IdeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut full: Vec<&str> = vec!["--literal-pathspecs"];
    full.extend_from_slice(args);
    full.push("--");
    full.extend(paths.iter().map(String::as_str));
    run(r.root(), &full, None).map(|_| ())
}

pub(crate) fn blame(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    encoding: &'static Encoding,
) -> IdeResult<Vec<BlameLine>> {
    let rel = r.rel_path(path)?;
    let disk = match std::fs::read(r.abs_path(&rel)) {
        Ok(bytes) => bytes,
        Err(_) if current_text.is_some() => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let text = current_text.map(str::to_owned).unwrap_or_else(|| decode(&disk, encoding).into_owned());
    let contents = match current_text {
        Some(_) => {
            let disk_text = decode(&disk, encoding);
            let eol = if disk_text.contains("\r\n") {
                "\r\n"
            } else if disk_text.contains('\r') {
                "\r"
            } else {
                "\n"
            };
            let contents = crate::diff::normalize_eol(&text).replace('\n', eol);
            encode(&contents, encoding, has_bom(&disk, encoding))?
        }
        None => disk,
    };
    let line_count = text.split_inclusive('\n').count();
    let tracked_in_head = {
        let repo = r.gix()?;
        crate::repo::blob_at(&repo, &rel, "HEAD")?.is_some()
    };
    if !tracked_in_head {
        return Ok(uncommitted_lines(line_count));
    }
    let out = run(
        r.root(),
        &["--literal-pathspecs", "blame", "--porcelain", "--contents", "-", "--", &rel],
        Some(&contents),
    )?;
    let mut lines = crate::blame::parse_porcelain(&out.stdout_str());
    for line in &mut lines {
        if line.commit.bytes().all(|b| b == b'0') {
            line.author = UNCOMMITTED_AUTHOR.to_string();
            line.summary = String::new();
        }
    }
    // Defensive: always exactly one entry per line.
    lines.truncate(line_count);
    while lines.len() < line_count {
        lines.extend(uncommitted_lines(1));
    }
    Ok(lines)
}

fn uncommitted_lines(n: usize) -> Vec<BlameLine> {
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    (0..n)
        .map(|_| BlameLine {
            commit: "0".repeat(40),
            author: UNCOMMITTED_AUTHOR.to_string(),
            time_ms: now,
            summary: String::new(),
        })
        .collect()
}

pub(crate) fn diff_text(r: &Repo, path: &Path, staged: bool, encoding: &'static Encoding) -> IdeResult<String> {
    let rel = r.rel_path(path)?;
    let base =
        ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.external=", "--literal-pathspecs"];
    let in_index = {
        let repo = r.gix()?;
        let index = repo.index_or_empty().map_err(gx)?;
        index.entry_index_by_path(BStr::new(rel.as_bytes())).is_ok()
    };
    let mut args: Vec<&str> = base.to_vec();
    if !staged && !in_index {
        // Untracked: show the whole file as added.
        args.extend(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", &rel]);
        let out = cli::run_raw(r.root(), &args, None)?;
        return match out.code {
            Some(0) | Some(1) => Ok(decode_diff(&out.stdout, encoding)),
            code => Err(cli::failure(&args, &out.stderr, &out.stdout, code)),
        };
    }
    args.extend(["diff", "--no-color", "--no-ext-diff"]);
    if staged {
        args.push("--cached");
    }
    args.extend(["--", &rel]);
    Ok(decode_diff(&run(r.root(), &args, None)?.stdout, encoding))
}

pub(crate) fn stage(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    let rel = r.rel_paths(paths)?;
    run_paths(r, &["add", "-A"], &rel)
}

pub(crate) fn unstage(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    let rel = r.rel_paths(paths)?;
    if r.has_head()? {
        run_paths(r, &["restore", "--staged"], &rel)
    } else {
        run_paths(r, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], &rel)
    }
}

pub(crate) fn stage_patch(
    r: &Repo,
    patch: &str,
    encoding: &dyn Fn(&Path) -> IdeResult<&'static Encoding>,
) -> IdeResult<()> {
    if patch.trim().is_empty() {
        return Ok(());
    }
    let mut patch = patch.to_string();
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    let bytes = crate::patch::encode_text_patch(r, &patch, encoding)?;
    run(r.root(), &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "--recount", "-"], Some(&bytes))
        .map(|_| ())
}

/// Paths with unresolved conflicts (index stages 1–3).
pub(crate) fn unmerged_paths(r: &Repo) -> IdeResult<Vec<String>> {
    let out = run(r.root(), &["diff", "--name-only", "--diff-filter=U", "-z"], None)?;
    Ok(out.stdout_str().split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Rolls conflicted files back to HEAD (index and working tree), which also resolves
/// them; files absent from HEAD (added by the other side) are removed.
fn discard_unmerged(r: &Repo, rel: &[String]) -> IdeResult<()> {
    let unmerged = unmerged_paths(r)?;
    let hit: Vec<String> = unmerged
        .into_iter()
        .filter(|u| rel.iter().any(|p| p == "." || p == u || u.starts_with(&format!("{}/", p.trim_end_matches('/')))))
        .collect();
    if hit.is_empty() {
        return Ok(());
    }
    let (in_head, added): (Vec<String>, Vec<String>) = {
        let repo = r.gix()?;
        let mut in_head = Vec::new();
        let mut added = Vec::new();
        for p in hit {
            if r.has_head()? && crate::repo::blob_at(&repo, &p, "HEAD")?.is_some() {
                in_head.push(p);
            } else {
                added.push(p);
            }
        }
        (in_head, added)
    };
    run_paths(r, &["restore", "--source=HEAD", "--staged", "--worktree"], &in_head)?;
    run_paths(r, &["rm", "--cached", "-f", "-q", "--ignore-unmatch"], &added)?;
    for p in &added {
        let abs = r.abs_path(p);
        if abs.is_file() || abs.is_symlink() {
            std::fs::remove_file(&abs)?;
        }
    }
    Ok(())
}

pub(crate) fn discard(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    let rel = r.rel_paths(paths)?;
    // `git restore --worktree` refuses unmerged paths: roll those back to HEAD first.
    discard_unmerged(r, &rel)?;
    let (mut tracked, mut untracked) = (Vec::new(), Vec::new());
    {
        let repo = r.gix()?;
        let index = repo.index_or_empty().map_err(gx)?;
        for p in rel {
            let exact = index.entry_index_by_path(BStr::new(p.as_bytes())).is_ok();
            let dir_prefix = if p == "." { String::new() } else { format!("{}/", p.trim_end_matches('/')) };
            let has_tracked_children = index.prefixed_entries(BStr::new(dir_prefix.as_bytes())).is_some();
            if exact {
                tracked.push(p);
            } else if r.abs_path(&p).is_dir() {
                if has_tracked_children {
                    tracked.push(p.clone());
                }
                untracked.push(p);
            } else {
                untracked.push(p);
            }
        }
    }
    run_paths(r, &["restore", "--worktree"], &tracked)?;
    if !untracked.is_empty() {
        // `git clean` keeps ignored files and refuses paths outside the worktree.
        run_paths(r, &["clean", "-f", "-d", "-q"], &untracked)?;
        // An explicitly named untracked file that clean skipped (e.g. ignored) is still removed.
        for p in &untracked {
            let abs = r.abs_path(p);
            if abs.is_file() || abs.is_symlink() {
                std::fs::remove_file(&abs)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn commit(
    r: &Repo,
    message: &str,
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<&'static Encoding>,
) -> IdeResult<String> {
    let mut args = vec!["commit", "-q", "--cleanup=whitespace"];
    if options.amend {
        args.push("--amend");
    }
    if options.sign_off {
        args.push("--signoff");
    }
    if !options.run_hooks {
        args.push("--no-verify");
    }
    let author = options.author.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(|a| format!("--author={a}"));
    if let Some(a) = &author {
        args.push(a.as_str());
    }
    let stdin = if options.amend && message.trim().is_empty() {
        args.push("--no-edit");
        None
    } else {
        if message.trim().is_empty() {
            return Err(IdeError::invalid("commit message is empty"));
        }
        args.extend(["-F", "-"]);
        Some(message.as_bytes())
    };
    if options.partial.is_empty() {
        run(r.root(), &args, stdin)?;
    } else {
        commit_partial(r, &args, stdin, &options.partial, encoding)?;
    }
    let repo = r.gix()?;
    Ok(repo.head_id().map_err(gx)?.detach().to_string())
}

/// Removes the temporary index however the partial commit ends.
struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

/// Commits the index with only the chosen hunks of `partial` files, through a copy of the
/// index (`GIT_INDEX_FILE`), as IDEA's partial commit does: the working tree and the
/// user's index are left alone except that the partial files' entries end up matching
/// the new commit.
fn commit_partial(
    r: &Repo,
    commit_args: &[&str],
    stdin: Option<&[u8]>,
    partial: &[crate::PartialCommitFile],
    encoding: &dyn Fn(&Path) -> IdeResult<&'static Encoding>,
) -> IdeResult<()> {
    let tmp = TempIndex(r.git_dir.join("openidea-partial-index"));
    let index = r.git_dir.join("index");
    if index.exists() {
        std::fs::copy(&index, &tmp.0)?;
    }
    let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
    let mut rels = Vec::new();
    for file in partial {
        let rel = r.rel_path(&file.path.0)?;
        let head = {
            let repo = r.gix()?;
            crate::repo::blob_at(&repo, &rel, "HEAD")?
        }
        .ok_or_else(|| {
            IdeError::invalid(format!("{rel}: only changes of a file in HEAD can be committed partially"))
        })?;
        let disk = std::fs::read(r.abs_path(&rel))?;
        let encoding = encoding(&file.path.0)?;
        let bom = has_bom(&head, encoding);
        if is_binary(&head, encoding) || is_binary(&disk, encoding) {
            return Err(IdeError::invalid(format!("{rel}: binary files cannot be committed partially")));
        }
        let (head, disk) = (decode(&head, encoding), decode(&disk, encoding));
        let hunks = crate::diff::line_hunks(&head, &disk);
        let mut selected = Vec::new();
        for want in &file.hunks {
            let found = hunks.iter().position(|h| {
                (h.start, h.lines, h.old_start, h.old_lines) == (want.start, want.lines, want.old_start, want.old_lines)
            });
            match found {
                Some(i) => selected.push(i),
                None => return Err(IdeError::invalid(format!("{rel} changed on disk; review its changes again"))),
            }
        }
        cli::run_env(r.root(), &["--literal-pathspecs", "reset", "-q", "HEAD", "--", &rel], None, &env)?;
        let text = crate::diff::selected_text(&head, &disk, &selected);
        let bytes = encode(&text, encoding, bom)?;
        write_index_blob(r, &rel, &bytes, &env)?;
        rels.push(rel);
    }
    cli::run_env(r.root(), commit_args, stdin, &env)?;
    // The user's index still holds the partial files' previous entries: align them with
    // the commit so the remaining changes show as unstaged, nothing as staged.
    run_paths(r, &["reset", "-q", "HEAD"], &rels)
}

pub(crate) fn checkout(r: &Repo, branch: &str, create: bool) -> IdeResult<()> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(IdeError::invalid("branch name is empty"));
    }
    if create {
        return run(r.root(), &["switch", "-c", branch], None).map(|_| ());
    }
    let repo = r.gix()?;
    let local = format!("refs/heads/{branch}");
    if repo.try_find_reference(local.as_str()).map_err(gx)?.is_some() {
        return run(r.root(), &["switch", branch], None).map(|_| ());
    }
    let remote_ref = format!("refs/remotes/{branch}");
    if repo.try_find_reference(remote_ref.as_str()).map_err(gx)?.is_some()
        && let Some((_, name)) = branch.split_once('/')
    {
        let local = format!("refs/heads/{name}");
        if repo.try_find_reference(local.as_str()).map_err(gx)?.is_some() {
            return run(r.root(), &["switch", name], None).map(|_| ());
        }
        return run(r.root(), &["switch", "-c", name, "--track", branch], None).map(|_| ());
    }
    // A tag or commit: detached HEAD.
    resolve(&repo, branch)?;
    run(r.root(), &["switch", "--detach", branch], None).map(|_| ())
}

/// What a checkout of `branch` runs.
enum SwitchPlan {
    Switch(Vec<String>),
    /// `git rebase <remote> <local>`.
    Rebase {
        local: String,
        remote: String,
    },
    Ahead {
        local: String,
        remote: String,
    },
}

fn switch_plan(r: &Repo, branch: &str, create: bool, diverged: Option<DivergedLocal>) -> IdeResult<SwitchPlan> {
    let args = |a: &[&str]| SwitchPlan::Switch(a.iter().map(|s| s.to_string()).collect());
    if create {
        return Ok(args(&["switch", "-c", branch]));
    }
    let repo = r.gix()?;
    let exists = |name: &str| repo.try_find_reference(name).map_err(gx).map(|r| r.is_some());
    if exists(&format!("refs/heads/{branch}"))? {
        return Ok(args(&["switch", branch]));
    }
    if exists(&format!("refs/remotes/{branch}"))?
        && let Some((_, name)) = branch.split_once('/')
    {
        if !exists(&format!("refs/heads/{name}"))? {
            return Ok(args(&["switch", "-c", name, "--track", branch]));
        }
        // IDEA: a local namesake that is merely behind is fast-forwarded; one with commits
        // of its own needs the user's choice.
        let range = format!("{branch}..refs/heads/{name}");
        let ahead = run(r.root(), &["rev-list", "--count", &range], None)?.stdout_str().trim() != "0";
        return Ok(match (ahead, diverged) {
            (true, None) => SwitchPlan::Ahead { local: name.to_string(), remote: branch.to_string() },
            (true, Some(DivergedLocal::Rebase)) => {
                SwitchPlan::Rebase { local: name.to_string(), remote: branch.to_string() }
            }
            _ => args(&["switch", "-C", name, "--track", branch]),
        });
    }
    // A tag or commit: detached HEAD.
    resolve(&repo, branch)?;
    Ok(args(&["switch", "--detach", branch]))
}

/// Files git refuses to overwrite with local changes, from its error message.
fn overwritten_files(stderr: &str) -> Option<Vec<String>> {
    let mut lines =
        stderr.lines().skip_while(|l| !l.contains("local changes to the following files would be overwritten"));
    lines.next()?;
    Some(lines.take_while(|l| l.starts_with('\t')).map(|l| l.trim().to_string()).collect())
}

pub(crate) fn checkout_with(
    r: &Repo,
    branch: &str,
    create: bool,
    options: &CheckoutOptions,
) -> IdeResult<CheckoutOutcome> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(IdeError::invalid("branch name is empty"));
    }
    if branch.starts_with('-') {
        return Err(IdeError::invalid(format!("invalid revision '{branch}'")));
    }
    let mut args = match switch_plan(r, branch, create, options.diverged)? {
        SwitchPlan::Ahead { local, remote } => return Ok(CheckoutOutcome::LocalBranchAhead { local, remote }),
        SwitchPlan::Rebase { local, remote } => {
            let out = cli::run_raw(r.root(), &["rebase", "--autostash", &remote, &local], None)?;
            if out.code == Some(0) {
                return Ok(CheckoutOutcome::Done);
            }
            let files = unmerged_paths(r)?;
            if files.is_empty() {
                return Err(cli::failure(&["rebase"], &out.stderr, &out.stdout, out.code));
            }
            return Ok(CheckoutOutcome::Conflicts { files });
        }
        SwitchPlan::Switch(args) => args,
    };
    if options.mode == CheckoutMode::Force {
        args.push("--discard-changes".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = cli::run_raw(r.root(), &argv, None)?;
    if out.code == Some(0) {
        return Ok(CheckoutOutcome::Done);
    }
    let Some(files) = overwritten_files(&String::from_utf8_lossy(&out.stderr)) else {
        return Err(cli::failure(&argv, &out.stderr, &out.stdout, out.code));
    };
    if options.mode != CheckoutMode::Smart {
        return Ok(CheckoutOutcome::LocalChanges { files });
    }
    // Smart Checkout: stash → switch → unstash, like IDEA.
    let before = stash_count(r)?;
    run(r.root(), &["stash", "push", "-q", "-m", &format!("Uncommitted changes before checkout of {branch}")], None)?;
    if stash_count(r)? == before {
        return Err(IdeError::invalid("could not save the local changes"));
    }
    if let Err(e) = run(r.root(), &argv, None) {
        run(r.root(), &["stash", "pop", "-q", "--index"], None)?;
        return Err(e);
    }
    let pop = cli::run_raw(r.root(), &["stash", "pop", "-q"], None)?;
    if pop.code == Some(0) {
        return Ok(CheckoutOutcome::Done);
    }
    let files = unmerged_paths(r)?;
    if files.is_empty() {
        return Err(cli::failure(&["stash", "pop"], &pop.stderr, &pop.stdout, pop.code));
    }
    Ok(CheckoutOutcome::Conflicts { files })
}

fn stash_count(r: &Repo) -> IdeResult<usize> {
    Ok(run(r.root(), &["stash", "list"], None)?.stdout_str().lines().count())
}

/// Creates `name` at `start` (default HEAD); a remote-tracking start point is tracked.
pub(crate) fn create_branch(r: &Repo, name: &str, start: Option<&str>, checkout: bool) -> IdeResult<()> {
    let name = name.trim();
    let valid = !name.is_empty()
        && !name.starts_with('-')
        && name != "HEAD"
        && cli::run_raw(r.root(), &["check-ref-format", "--branch", name], None)?.code == Some(0);
    if !valid {
        return Err(IdeError::invalid(format!("'{name}' is not a valid branch name")));
    }
    let start = start.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = start {
        if s.starts_with('-') {
            return Err(IdeError::invalid("invalid start point"));
        }
        let repo = r.gix()?;
        resolve(&repo, s)?;
    }
    let mut args = if checkout { vec!["switch", "-c", name] } else { vec!["branch", "--", name] };
    args.extend(start);
    run(r.root(), &args, None).map(|_| ())
}

/// Undo Commit: moves the current branch back to the parent of `commit` (which must be
/// HEAD), keeping its changes staged. Returns the undone commit's message.
pub(crate) fn undo_commit(r: &Repo, commit: &str) -> IdeResult<String> {
    if r.branch_info()?.operation.is_some() {
        return Err(IdeError::invalid("cannot undo a commit while a merge, rebase or cherry-pick is in progress"));
    }
    let (message, parents, head_named) = {
        let repo = r.gix()?;
        let head = repo.head_id().map_err(|_| IdeError::invalid("there is no commit to undo"))?.detach();
        let target = repo.find_object(resolve(&repo, commit)?).map_err(gx)?.peel_to_commit().map_err(gx)?.id;
        if target != head {
            return Err(IdeError::invalid("only the latest commit of the current branch can be undone"));
        }
        let c = repo.find_commit(head).map_err(gx)?;
        let message = crate::repo::to_string(c.message_raw_sloppy()).trim_end().to_string();
        (message, c.parent_ids().count(), repo.head_name().map_err(gx)?.is_some())
    };
    match parents {
        0 if head_named => {
            // The initial commit: back to an unborn branch; the index keeps every file (staged as added).
            run(r.root(), &["update-ref", "-d", "HEAD"], None)?;
        }
        0 => return Err(IdeError::invalid("cannot undo the initial commit on a detached HEAD")),
        1 => {
            run(r.root(), &["reset", "-q", "--soft", "HEAD~1", "--"], None)?;
        }
        _ => {
            return Err(IdeError::invalid(
                "cannot undo a merge commit; use Reset Current Branch to Here on its first parent instead",
            ));
        }
    }
    Ok(message)
}

pub(crate) fn delete_branch(r: &Repo, branch: &str, force: bool) -> IdeResult<()> {
    run(r.root(), &["branch", if force { "-D" } else { "-d" }, "--", branch], None).map(|_| ())
}

pub(crate) fn delete_branch_restorable(r: &Repo, branch: &str) -> IdeResult<DeletedBranch> {
    check_local_branch(r, branch)?;
    let tip = run(r.root(), &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}^{{commit}}")], None)?
        .stdout_str()
        .trim()
        .to_string();
    let upstream =
        cli::run_raw(r.root(), &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")], None)?
            .stdout_str()
            .trim()
            .to_string();
    let out = cli::run_raw(r.root(), &["branch", "-d", "--", branch], None)?;
    let unmerged = match out.code {
        Some(0) => false,
        _ if String::from_utf8_lossy(&out.stderr).contains("not fully merged") => {
            run(r.root(), &["branch", "-D", "--", branch], None)?;
            true
        }
        code => return Err(cli::failure(&["branch"], &out.stderr, &out.stdout, code)),
    };
    Ok(DeletedBranch { name: branch.to_string(), tip, upstream: (!upstream.is_empty()).then_some(upstream), unmerged })
}

pub(crate) fn restore_branch(r: &Repo, deleted: &DeletedBranch) -> IdeResult<()> {
    let tip = check_rev(&deleted.tip)?;
    run(r.root(), &["branch", "--", &deleted.name, tip], None)?;
    if let Some(upstream) = &deleted.upstream {
        let target = format!("--set-upstream-to={upstream}");
        run(r.root(), &["branch", &target, "--", &deleted.name], None)?;
    }
    Ok(())
}

pub(crate) fn rename_branch(r: &Repo, from: &str, to: &str) -> IdeResult<()> {
    let to = to.trim();
    if to.is_empty() {
        return Err(IdeError::invalid("branch name is empty"));
    }
    run(r.root(), &["branch", "-m", "--", from, to], None).map(|_| ())
}

fn check_rev(rev: &str) -> IdeResult<&str> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(IdeError::invalid(format!("invalid revision '{rev}'")));
    }
    Ok(rev)
}

/// Local changes are stashed and restored around the merge (IDEA's "save local changes").
pub(crate) fn merge(r: &Repo, branch: &str) -> IdeResult<()> {
    run(r.root(), &["merge", "--no-edit", "--autostash", check_rev(branch)?], None).map(|_| ())
}

pub(crate) fn rebase(r: &Repo, onto: &str) -> IdeResult<()> {
    run(r.root(), &["rebase", "--autostash", check_rev(onto)?], None).map(|_| ())
}

pub(crate) fn stash_push(r: &Repo, message: Option<&str>, include_untracked: bool, keep_index: bool) -> IdeResult<()> {
    let mut args = vec!["stash", "push", "-q"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if keep_index {
        args.push("--keep-index");
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["-m", m]);
    }
    run(r.root(), &args, None).map(|_| ())
}

pub(crate) fn stash_apply(r: &Repo, index: u32, pop: bool, reinstate_index: bool) -> IdeResult<()> {
    let spec = format!("stash@{{{index}}}");
    let mut args = vec!["stash", if pop { "pop" } else { "apply" }, "-q"];
    if reinstate_index {
        args.push("--index");
    }
    args.push(&spec);
    run(r.root(), &args, None).map(|_| ())
}

pub(crate) fn stash_branch(r: &Repo, index: u32, branch: &str) -> IdeResult<()> {
    let branch = branch.trim();
    let valid = !branch.is_empty()
        && !branch.starts_with('-')
        && cli::run_raw(r.root(), &["check-ref-format", "--branch", branch], None)?.code == Some(0);
    if !valid {
        return Err(IdeError::invalid(format!("'{branch}' is not a valid branch name")));
    }
    let spec = format!("stash@{{{index}}}");
    run(r.root(), &["stash", "branch", branch, &spec], None).map(|_| ())
}

pub(crate) fn stash_drop(r: &Repo, index: u32) -> IdeResult<()> {
    let spec = format!("stash@{{{index}}}");
    run(r.root(), &["stash", "drop", "-q", &spec], None).map(|_| ())
}

pub(crate) fn delete_remote_branch(
    r: &Repo,
    branch: &str,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let repo = r.gix()?;
    let names: Vec<String> = repo.remote_names().iter().map(|n| n.to_string()).collect();
    // Longest matching remote name wins (remotes may contain '/').
    let (remote, name) = names
        .iter()
        .filter_map(|remote| branch.strip_prefix(remote.as_str())?.strip_prefix('/').map(|n| (remote.as_str(), n)))
        .max_by_key(|(remote, _)| remote.len())
        .ok_or_else(|| IdeError::invalid(format!("'{branch}' is not a remote branch")))?;
    if name.is_empty() || name.starts_with('-') || name == "HEAD" {
        return Err(IdeError::invalid(format!("invalid remote branch '{branch}'")));
    }
    cli::run_streaming(r.root(), &["push", "--progress", remote, "--delete", name], cancel, on_output)
}

pub(crate) fn push(
    r: &Repo,
    force_with_lease: bool,
    set_upstream: bool,
    tags: Option<crate::PushTags>,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    if tags == Some(crate::PushTags::CurrentBranch) {
        args.push("--follow-tags".into());
    }
    if set_upstream {
        let repo = r.gix()?;
        let head =
            repo.head_name().map_err(gx)?.ok_or_else(|| IdeError::invalid("cannot set upstream: HEAD is detached"))?;
        let short = head.as_ref().shorten().to_str_lossy().into_owned();
        let remote = repo
            .branch_remote_name(short.as_str(), gix::remote::Direction::Push)
            .map(|n| n.as_bstr().to_str_lossy().into_owned())
            .or_else(|| {
                let names = repo.remote_names();
                if names.iter().any(|n| n.as_ref() as &[u8] == b"origin") {
                    Some("origin".to_string())
                } else {
                    names.iter().next().map(|n| n.to_string())
                }
            })
            .ok_or_else(|| IdeError::invalid("no remote configured"))?;
        args.extend(["--set-upstream".into(), remote, short]);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_streaming(r.root(), &argv, cancel, on_output)?;
    if tags == Some(crate::PushTags::All) {
        // `git push --tags` alone pushes only tags, so it runs after the branch push.
        let remote = push_remote(r)?;
        cli::run_streaming(r.root(), &["push", "--progress", &remote, "--tags"], cancel, on_output)?;
    }
    Ok(())
}

/// Remote and branch name a local branch pulls from (`branch.<b>.remote` / `.merge`).
fn branch_upstream(r: &Repo, branch: &str) -> Option<(String, String)> {
    let get = |key: &str| {
        let out = cli::run_raw(r.root(), &["config", "--get", key], None).ok()?;
        let v = out.stdout_str().trim().to_string();
        (out.code == Some(0) && !v.is_empty()).then_some(v)
    };
    let remote = get(&format!("branch.{branch}.remote"))?;
    let merge = get(&format!("branch.{branch}.merge"))?;
    let name = merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string();
    (remote != ".").then_some((remote, name))
}

fn check_local_branch(r: &Repo, branch: &str) -> IdeResult<()> {
    let branch = check_rev(branch)?;
    run(r.root(), &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")], None)
        .map(|_| ())
        .map_err(|_| IdeError::invalid(format!("'{branch}' is not a local branch")))
}

/// Pushes local `branch` (or only up to `opts.revision`) to its upstream; a branch
/// without one goes to the default remote under the same name and, when pushed whole,
/// gets it as upstream.
pub(crate) fn push_branch(
    r: &Repo,
    branch: &str,
    opts: PushBranchOptions<'_>,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let PushBranchOptions { revision, target, remote: remote_override, force_with_lease } = opts;
    check_local_branch(r, branch)?;
    let remote_override = remote_override.map(str::trim).filter(|s| !s.is_empty());
    let (remote, mut name, set_upstream) = match (remote_override, branch_upstream(r, branch)) {
        // An explicit remote keeps the upstream's branch name but pushes elsewhere.
        (Some(remote), Some((_, name))) => (check_rev(remote)?.to_string(), name, false),
        (Some(remote), None) => (check_rev(remote)?.to_string(), branch.to_string(), revision.is_none()),
        (None, Some((remote, name))) => (remote, name, false),
        (None, None) => (push_remote(r)?, branch.to_string(), revision.is_none()),
    };
    if let Some(t) = target.map(str::trim).filter(|t| !t.is_empty()) {
        let valid =
            !t.starts_with('-') && cli::run_raw(r.root(), &["check-ref-format", "--branch", t], None)?.code == Some(0);
        if !valid {
            return Err(IdeError::invalid(format!("'{t}' is not a valid branch name")));
        }
        name = t.to_string();
    }
    let target = name;
    let source = match revision {
        Some(rev) => check_rev(rev)?.to_string(),
        None => format!("refs/heads/{branch}"),
    };
    let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    if set_upstream {
        args.push("--set-upstream".into());
    }
    args.extend([remote, format!("{source}:refs/heads/{target}")]);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_streaming(r.root(), &argv, cancel, on_output)
}

/// Fast-forwards local `branch` (not checked out) to its upstream, fetching it first.
pub(crate) fn update_branch(
    r: &Repo,
    branch: &str,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    check_local_branch(r, branch)?;
    let (remote, name) =
        branch_upstream(r, branch).ok_or_else(|| IdeError::invalid(format!("'{branch}' has no tracked branch")))?;
    let refspec = format!("refs/heads/{name}:refs/heads/{branch}");
    cli::run_streaming(r.root(), &["fetch", "--progress", &remote, &refspec], cancel, on_output)
}

/// The remote the current branch pushes to (`origin`, or the only remote, by default).
fn push_remote(r: &Repo) -> IdeResult<String> {
    let repo = r.gix()?;
    let from_branch = repo.head_name().map_err(gx)?.and_then(|head| {
        let short = head.as_ref().shorten().to_str_lossy().into_owned();
        repo.branch_remote_name(short.as_str(), gix::remote::Direction::Push)
            .map(|n| n.as_bstr().to_str_lossy().into_owned())
    });
    from_branch
        .or_else(|| {
            let names = repo.remote_names();
            if names.iter().any(|n| n.as_ref() as &[u8] == b"origin") {
                Some("origin".to_string())
            } else {
                names.iter().next().map(|n| n.to_string())
            }
        })
        .ok_or_else(|| IdeError::invalid("no remote configured"))
}

fn write_index_blob(r: &Repo, rel: &str, bytes: &[u8], env: &[(&str, &std::ffi::OsStr)]) -> IdeResult<()> {
    let entry =
        cli::run_env(r.root(), &["--literal-pathspecs", "ls-files", "--stage", "--", rel], None, env)?.stdout_str();
    let mode = entry.split_whitespace().next().unwrap_or("100644");
    let id = run(r.root(), &["hash-object", "-w", "--stdin"], Some(bytes))?.stdout_str();
    cli::run_env(r.root(), &["update-index", "--add", "--cacheinfo", mode, id.trim(), rel], None, env)?;
    Ok(())
}

pub(crate) fn stage_hunks(
    r: &Repo,
    path: &Path,
    current: &str,
    selected: &[usize],
    encoding: &'static Encoding,
) -> IdeResult<()> {
    if selected.is_empty() {
        return Ok(());
    }
    let rel = r.rel_path(path)?;
    let base = r.file_bytes_at(path, Some(":0"))?.unwrap_or_default();
    if is_binary(&base, encoding) {
        return Err(IdeError::invalid("binary files cannot be staged partially"));
    }
    let old = decode(&base, encoding);
    let hunks = crate::diff::line_hunks(&old, current);
    if selected.iter().any(|&i| i >= hunks.len()) {
        return Err(IdeError::invalid("hunk no longer exists"));
    }
    let text = crate::diff::selected_text(&old, current, selected);
    let bytes = encode(&text, encoding, has_bom(&base, encoding))?;
    write_index_blob(r, &rel, &bytes, &[])
}

// Git headers contain UTF-8 paths; only source lines use the file's encoding.
fn decode_diff(bytes: &[u8], encoding: &'static Encoding) -> String {
    let mut hunks = false;
    let mut text = String::new();
    for line in bytes.split_inclusive(|&b| b == b'\n') {
        if line.starts_with(b"diff --git ") {
            hunks = false;
        }
        if line.starts_with(b"@@ ") {
            hunks = true;
        }
        if hunks {
            text.push_str(&decode(line, encoding));
        } else {
            text.push_str(&String::from_utf8_lossy(line));
        }
    }
    text
}
