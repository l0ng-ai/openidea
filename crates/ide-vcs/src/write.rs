//! Operations delegated to the git CLI (all writes, plus blame and textual diffs).

use crate::TextEncoding;
use crate::cli::{self, run};
use crate::push_report;
use crate::repo::{gx, resolve};
use crate::text_encoding::{decode, encode, has_bom, is_binary};
use crate::{
    BlameLine, BranchCreation, BranchCreationOutcome, BranchRebasePlan, BranchUpdate, BranchUpdateStatus, CheckoutMode,
    CheckoutOptions, CheckoutOutcome, CheckoutRebasePlan, CommitOptions, DeletedBranch, DivergedLocal, HistoryTip,
    LargeCommitFile, MergeOptions, MergeOutcome, PartialCommitFile, PushBranchOptions, PushRefStatus, PushReport,
    PushTags, Repo, UpstreamTracking,
};
use gix::bstr::{BStr, ByteSlice};
use ide_core::error::{ErrorData, ErrorKind, PushDivergence};
use ide_core::workflow_settings::{FetchTagsMode, GitAnnotateMovement, GitAnnotateSettings};
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const UNCOMMITTED_AUTHOR: &str = "Not Committed Yet";

impl Repo {
    pub(crate) fn rel_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<String>> {
        let _scope = self.execution_scope();
        paths
            .iter()
            .map(|p| {
                let rel = self.rel_path(p)?;
                Ok(if rel.is_empty() { ".".to_string() } else { rel })
            })
            .collect()
    }

    pub(crate) fn has_head(&self) -> IdeResult<bool> {
        let _scope = self.execution_scope();
        let repo = self.gix()?;
        Ok(!repo.head().map_err(gx)?.is_unborn())
    }
}

/// Runs a path-taking git command with literal pathspecs, in as many invocations as
/// the platform's command-line limit needs (a large rollback would otherwise fail with
/// `os error 206` on Windows).
fn run_paths(r: &Repo, args: &[&str], paths: &[String]) -> IdeResult<()> {
    let mut base: Vec<&str> = vec!["--literal-pathspecs"];
    base.extend_from_slice(args);
    base.push("--");
    cli::run_paths(r.root(), &base, paths).map(|_| ())
}

/// The annotate ignore list at the worktree root: git's conventional `blame.ignoreRevsFile`.
pub const BLAME_IGNORE_REVS_FILE: &str = ".git-blame-ignore-revs";

/// The file `blame.ignoreRevsFile` names, resolved from the worktree root as git does (it may not
/// exist). The value comes from the gitoxide config snapshot, which Restricted Mode still parses,
/// so resolving it starts no program.
fn configured_ignore_revs(r: &Repo) -> Option<PathBuf> {
    let repo = r.gix().ok()?;
    let configured = repo.config_snapshot().string("blame.ignoreRevsFile")?;
    let configured = configured.to_str_lossy();
    let configured = configured.trim();
    if configured.is_empty() {
        return None;
    }
    let path = Path::new(configured);
    Some(if path.is_absolute() { path.to_path_buf() } else { r.root().join(path) })
}

/// Arguments for the file `blame.ignoreRevsFile` names, which git does not accept as an
/// absent file: with a value configured but missing from disk, `--no-ignore-revs-file`
/// clears it so annotate still works.
fn ignore_revs_args(r: &Repo) -> Vec<String> {
    match configured_ignore_revs(r) {
        Some(path) if path.is_file() => vec!["--ignore-revs-file".to_string(), path.to_string_lossy().into_owned()],
        Some(_) => vec!["--no-ignore-revs-file".to_string()],
        None => Vec::new(),
    }
}

/// `existing` (an ignore list's text) with `commit` appended: lines keep their text and order, a
/// listed commit isn't repeated, and the result ends with a newline in the list's line ending.
fn append_revision(existing: &str, commit: &str) -> String {
    let revision = commit.trim();
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<&str> = existing.lines().collect();
    if !revision.is_empty() && !lines.iter().any(|line| line.trim() == revision) {
        lines.push(revision);
    }
    if lines.is_empty() { String::new() } else { lines.join(newline) + newline }
}

/// Adds `commit` to the list `blame.ignoreRevsFile` names; with none configured, to
/// `.git-blame-ignore-revs` at the worktree root, which the local config then names.
pub(crate) fn ignore_blame_revision(r: &Repo, commit: &str) -> IdeResult<()> {
    let configured = configured_ignore_revs(r);
    let path = configured.clone().unwrap_or_else(|| r.root().join(BLAME_IGNORE_REVS_FILE));
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let updated = append_revision(&existing, commit);
    if updated != existing {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, updated)?;
    }
    if configured.is_none() {
        cli::run(r.root(), &["config", "--local", "blame.ignoreRevsFile", BLAME_IGNORE_REVS_FILE], None)?;
    }
    Ok(())
}

pub(crate) fn blame(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    revision: Option<&str>,
    encoding: TextEncoding,
    options: GitAnnotateSettings,
) -> IdeResult<Vec<BlameLine>> {
    let rel = r.rel_path(path)?;
    let revision = match revision {
        Some(rev) => check_rev(rev)?,
        None => "HEAD",
    };
    let disk = match std::fs::read(r.abs_path(&rel)) {
        Ok(bytes) => bytes,
        Err(_) if current_text.is_some() => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let text = current_text.map(str::to_owned).unwrap_or_else(|| decode(&disk, encoding).into_owned());
    let ignore = ignore_revs_args(r);
    let mut args = vec!["--literal-pathspecs", "blame", "--porcelain"];
    if options.ignore_whitespace {
        args.push("-w");
    }
    match options.movement {
        GitAnnotateMovement::None => {}
        GitAnnotateMovement::WithinFile => args.push("-M"),
        GitAnnotateMovement::AcrossFiles => args.push("-C"),
    }
    if !crate::execution_allowed() {
        args.push("--no-textconv");
    }
    args.extend(ignore.iter().map(String::as_str));
    let plain_args = [args.as_slice(), &[revision, "--", &rel]].concat();
    if encoding.has_ascii_conversion() {
        return converted_blame(r, path, (&rel, revision), &text, encoding, &plain_args, options.ignore_whitespace);
    }
    let contents = match current_text {
        Some(_) if crate::diff::normalize_eol(&text) == crate::diff::normalize_eol(&decode(&disk, encoding)) => disk,
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
        crate::repo::blob_at(&repo, &rel, revision)?.is_some()
    };
    if !tracked_in_head {
        return Ok(uncommitted_lines(line_count));
    }
    // Restricted blame reads committed blobs only. Feeding working-tree bytes to
    // Git's --contents path would run configured clean filters, so it blames the
    // revision plain. Git learned to combine `--contents` with a revision in 2.41;
    // older releases reject the pair (`fatal: cannot use --contents with final
    // commit object name`) and take the same plain path — the edited lines are
    // marked uncommitted below either way (issue #755).
    let (out, contents_blame) = if crate::execution_allowed() {
        args.extend(["--contents", "-"]);
        if revision != "HEAD" {
            args.push(revision);
        }
        args.extend(["--", &rel]);
        let out = cli::run_raw(r.root(), &args, Some(&contents))?;
        if out.code == Some(0) {
            (out, true)
        } else if String::from_utf8_lossy(&out.stderr).contains("cannot use --contents") {
            (run(r.root(), &plain_args, None)?, false)
        } else {
            return Err(cli::failure(&args, &out.stderr, &out.stdout, out.code));
        }
    } else {
        (run(r.root(), &plain_args, None)?, false)
    };
    let mut lines = crate::blame::parse_porcelain(&out.stdout_str(), r.root(), &rel);
    for line in &mut lines {
        if line.commit.bytes().all(|b| b == b'0') {
            line.author = UNCOMMITTED_AUTHOR.to_string();
            line.summary = String::new();
            line.origin_path = None;
        }
    }
    if !contents_blame {
        let base = r.file_at(path, Some(revision), encoding)?.unwrap_or_default();
        for hunk in blame_hunks(&base, &text, options.ignore_whitespace).into_iter().rev() {
            let start = (hunk.old_start as usize).min(lines.len());
            let end = (start + hunk.old_lines as usize).min(lines.len());
            lines.splice(start..end, uncommitted_lines(hunk.lines as usize));
        }
    }
    // Defensive: always exactly one entry per line.
    lines.truncate(line_count);
    while lines.len() < line_count {
        lines.extend(uncommitted_lines(1));
    }
    Ok(lines)
}

fn blame_hunks(base: &str, text: &str, ignore_whitespace: bool) -> Vec<crate::LineHunk> {
    if !ignore_whitespace {
        return crate::diff::line_hunks(base, text);
    }
    let strip = |text: &str| {
        let text = crate::diff::normalize_eol(text);
        let mut normalized = text.replace([' ', '\t', '\u{b}', '\u{c}'], "");
        if !text.is_empty() && !text.ends_with('\n') {
            normalized.push('\n');
        }
        normalized
    };
    crate::diff::line_hunks(&strip(base), &strip(text))
}

fn converted_blame(
    r: &Repo,
    path: &Path,
    (rel, revision): (&str, &str),
    text: &str,
    encoding: TextEncoding,
    args: &[&str],
    ignore_whitespace: bool,
) -> IdeResult<Vec<BlameLine>> {
    let current = crate::diff::normalize_eol(text);
    let mut result = uncommitted_lines(current.split_inclusive('\n').count());
    let Some(base) = r.file_bytes_at(path, Some(revision))? else { return Ok(result) };
    let out = run(r.root(), args, None)?;
    let physical = crate::blame::parse_porcelain(&out.stdout_str(), r.root(), rel);
    let raw = crate::text_encoding::decode_raw(&base, encoding);
    let raw = crate::diff::normalize_eol(&raw);
    let mut logical = Vec::new();
    for (line, metadata) in raw.split_inclusive('\n').zip(physical) {
        let displayed = encoding.display_text(line);
        let displayed = crate::diff::normalize_eol(&displayed);
        logical.extend(std::iter::repeat_n(metadata, displayed.split_inclusive('\n').count()));
    }
    let base = decode(&base, encoding);
    let hunks = blame_hunks(&base, &current, ignore_whitespace);
    let (mut old, mut new) = (0usize, 0usize);
    for h in hunks {
        let unchanged = h.start as usize - new;
        for i in 0..unchanged {
            if let Some(metadata) = logical.get(old + i) {
                result[new + i] = metadata.clone();
            }
        }
        old = (h.old_start + h.old_lines) as usize;
        new = (h.start + h.lines) as usize;
    }
    for (line, metadata) in result[new..].iter_mut().zip(&logical[old.min(logical.len())..]) {
        *line = metadata.clone();
    }
    Ok(result)
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
            origin_path: None,
        })
        .collect()
}

pub(crate) fn diff_text(r: &Repo, path: &Path, staged: bool, encoding: TextEncoding) -> IdeResult<String> {
    let rel = r.rel_path(path)?;
    if !crate::execution_allowed() {
        let old = r.file_at(path, Some(if staged { "HEAD" } else { ":0" }), encoding)?.unwrap_or_default();
        let new = if staged {
            r.file_at(path, Some(":0"), encoding)?.unwrap_or_default()
        } else {
            std::fs::read(r.abs_path(&rel)).map(|b| decode(&b, encoding).into_owned()).unwrap_or_default()
        };
        let selected: Vec<_> = (0..crate::diff::line_hunks(&old, &new).len()).collect();
        return Ok(crate::diff::build_partial_patch(&rel, &old, &new, &selected));
    }
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

pub(crate) fn stage_without_content(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    run_paths(r, &["add", "--intent-to-add"], &r.rel_paths(paths)?)
}

pub(crate) fn restore_unstaged(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    use gix::index::entry::{Flags, Stage};
    let rel = r.rel_paths(paths)?;
    let repo = r.gix()?;
    let index = repo.index_or_empty().map_err(gx)?;
    for path in &rel {
        // An intent-to-add entry stands in for an absent file, even though Git gives it an empty blob.
        if index
            .entry_by_path_and_stage(BStr::new(path.as_bytes()), Stage::Unconflicted)
            .is_none_or(|entry| entry.flags.contains(Flags::INTENT_TO_ADD))
        {
            return Err(IdeError::invalid(format!("No staged version to restore for {path}")));
        }
    }
    run_paths(r, &["restore", "--worktree"], &rel)
}

pub(crate) fn unstage(r: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    let rel = r.rel_paths(paths)?;
    if r.has_head()? {
        run_paths(r, &["restore", "--staged"], &rel)
    } else {
        run_paths(r, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], &rel)
    }
}

pub(crate) fn stage_patch(r: &Repo, patch: &str, encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>) -> IdeResult<()> {
    if patch.trim().is_empty() {
        return Ok(());
    }
    let mut patch = patch.to_string();
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    if crate::patch::parse_patch(&patch)
        .iter()
        .any(|file| encoding(&r.abs_path(&file.path)).is_ok_and(TextEncoding::has_ascii_conversion))
    {
        return crate::patch::stage_converted_patch(r, &patch, encoding);
    }
    let bytes = crate::patch::encode_text_patch(r, &patch, encoding)?;
    run(r.root(), &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "--recount", "-"], Some(&bytes))
        .map(|_| ())
}

/// Paths with unresolved conflicts (index stages 1–3).
pub(crate) fn unmerged_paths(r: &Repo) -> IdeResult<Vec<String>> {
    let out = run(
        r.root(),
        &["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U", "-z"],
        None,
    )?;
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
    let (mut tracked, mut untracked, mut submodules) = (Vec::new(), Vec::new(), Vec::new());
    {
        let repo = r.gix()?;
        let index = repo.index_or_empty().map_err(gx)?;
        for p in rel {
            let exact = index.entry_index_by_path(BStr::new(p.as_bytes())).ok().map(|i| &index.entries()[i]);
            let dir_prefix = if p == "." { String::new() } else { format!("{}/", p.trim_end_matches('/')) };
            let children = index.prefixed_entries(BStr::new(dir_prefix.as_bytes()));
            if let Some(entry) = exact {
                if entry.mode.is_submodule() {
                    submodules.push(p);
                } else {
                    tracked.push(p);
                }
            } else if r.abs_path(&p).is_dir() {
                if let Some(children) = children {
                    submodules
                        .extend(children.iter().filter(|e| e.mode.is_submodule()).map(|e| e.path(&index).to_string()));
                    tracked.push(p.clone());
                }
                untracked.push(p);
            } else {
                untracked.push(p);
            }
        }
    }
    run_paths(r, &["restore", "--worktree"], &tracked)?;
    // A plain restore leaves a submodule alone. This one checks out the commit the index
    // records there and restores its tracked files, keeping its untracked ones.
    if crate::execution_allowed() {
        run_paths(r, &["restore", "--recurse-submodules", "--worktree"], &submodules)?;
    }
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

pub(crate) fn commit_metadata_flags(
    sign_off: bool,
    run_hooks: bool,
    author: Option<&str>,
    author_date: Option<&str>,
) -> Vec<String> {
    let mut flags = Vec::new();
    if sign_off {
        flags.push("--signoff".into());
    }
    if !run_hooks {
        flags.push("--no-verify".into());
    }
    flags.extend(author.map(str::trim).filter(|a| !a.is_empty()).map(|a| format!("--author={a}")));
    flags.extend(author_date.map(str::trim).filter(|d| !d.is_empty()).map(|d| format!("--date={d}")));
    flags
}

pub(crate) fn commit(
    r: &Repo,
    message: &str,
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<String> {
    if matches!(r.operation()?.as_deref(), Some("cherry-pick" | "revert")) {
        return Err(IdeError::invalid("Use Continue to commit the paused cherry-pick or revert"));
    }
    let mut args = vec!["commit", "-q", "--cleanup=whitespace"];
    let specific = options.amend_target.as_ref();
    if specific.is_some() {
        if !options.amend {
            return Err(IdeError::invalid("an amend target requires Amend mode"));
        }
        args.push("--allow-empty");
    } else if options.amend {
        args.push("--amend");
    }
    let flags = commit_metadata_flags(
        options.sign_off,
        options.run_hooks,
        options.author.as_deref(),
        options.author_date.as_deref(),
    );
    args.extend(flags.iter().map(String::as_str));
    if let Some(target) = specific {
        args.extend(["-F", "-"]);
        return crate::commit_rewrite::amend(r, target, message, &args, options, encoding);
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
    if selects(options) {
        commit_selected(r, &args, stdin, options, encoding)?;
    } else {
        run(r.root(), &args, stdin)?;
    }
    // A commit concluding a merge brings back the local changes put aside for it.
    let _ = crate::preserve::restore(r);
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

/// Whether `options` commit something else than the index as it is.
fn selects(options: &CommitOptions) -> bool {
    !(options.partial.is_empty() && options.stage.is_empty() && options.exclude.is_empty())
}

/// Commits a selection of the changes through a copy of the index (`GIT_INDEX_FILE`):
/// see [`select_into`]. The working tree and the user's index are left alone
/// except that the committed files' entries end up matching the new commit, so changes
/// left out keep their staged state.
fn commit_selected(
    r: &Repo,
    commit_args: &[&str],
    stdin: Option<&[u8]>,
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<()> {
    let tmp = TempIndex(r.git_dir.join("openidea-partial-index"));
    let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
    let rels = select_into(r, &tmp, options, encoding)?;
    cli::run_env(r.root(), commit_args, stdin, &env)?;
    // The user's index still holds the partial files' previous entries: align them with
    // the commit so the remaining changes show as unstaged, nothing as staged.
    run_paths(r, &["reset", "-q", "HEAD"], &rels)
}

/// Fills `tmp`, a copy of the index, with what a commit of `options` holds: `exclude`
/// goes back to HEAD, `stage` takes its working-tree content and `partial` only the
/// chosen hunks. Returns the root-relative paths of `stage` and `partial`.
fn select_into(
    r: &Repo,
    tmp: &TempIndex,
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<Vec<String>> {
    let index = r.git_dir.join("index");
    if index.exists() {
        std::fs::copy(&index, &tmp.0)?;
    }
    let env = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
    fill_commit_index(r, &env, options, encoding)
}

pub(crate) fn fill_commit_index(
    r: &Repo,
    env: &[(&str, &std::ffi::OsStr)],
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<Vec<String>> {
    let rel_paths = |paths: &[ide_core::IpcPath]| -> IdeResult<Vec<String>> {
        let paths: Vec<PathBuf> = paths.iter().map(|p| p.0.clone()).collect();
        r.rel_paths(&paths)
    };
    let exclude = rel_paths(&options.exclude)?;
    if !exclude.is_empty() {
        let args: &[&str] = if r.has_head()? {
            &["--literal-pathspecs", "reset", "-q", "HEAD", "--"]
        } else {
            &["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"]
        };
        cli::run_paths_env(r.root(), args, &exclude, None, env)?;
    }
    let mut rels = rel_paths(&options.stage)?;
    cli::run_paths_env(r.root(), &["--literal-pathspecs", "add", "-A", "--"], &rels, None, env)?;
    for file in &options.partial {
        let rel = r.rel_path(&file.path.0)?;
        let encoding = encoding(&file.path.0)?;
        let (text, bom) = partial_commit_text(r, &rel, file, encoding)?;
        cli::run_env(r.root(), &["--literal-pathspecs", "reset", "-q", "HEAD", "--", &rel], None, env)?;
        let bytes = encode(&text, encoding, bom)?;
        write_index_blob(r, &rel, &bytes, env)?;
        rels.push(rel);
    }
    Ok(rels)
}

pub(crate) fn partial_commit_text(
    r: &Repo,
    rel: &str,
    file: &PartialCommitFile,
    encoding: TextEncoding,
) -> IdeResult<(String, bool)> {
    let (selected, bom) = select_partial_commit_text(r, rel, file, encoding)?;
    let Some(prepared) = &file.prepared else { return Ok((selected, bom)) };
    if crate::diff::normalize_eol(&selected) != prepared.before {
        return Err(IdeError::invalid(format!("{rel} changed on disk; review its changes again")));
    }
    if prepared.text.contains('\0') {
        return Err(IdeError::invalid(format!("{rel}: binary files cannot be committed partially")));
    }
    Ok((crate::diff::replace_text(&selected, &prepared.text), bom))
}

fn select_partial_commit_text(
    r: &Repo,
    rel: &str,
    file: &PartialCommitFile,
    encoding: TextEncoding,
) -> IdeResult<(String, bool)> {
    let repo = r.gix()?;
    let head = crate::repo::blob_at(&repo, rel, "HEAD")?.ok_or_else(|| {
        IdeError::invalid(format!("{rel}: only changes of a file in HEAD can be committed partially"))
    })?;
    let disk = std::fs::read(r.abs_path(rel))?;
    let bom = has_bom(&head, encoding);
    if is_binary(&head, encoding) || is_binary(&disk, encoding) {
        return Err(IdeError::invalid(format!("{rel}: binary files cannot be committed partially")));
    }
    let (head, disk) = (decode(&head, encoding), decode(&disk, encoding));
    let hunks = crate::diff::line_hunks(&head, &disk);
    let stale = || IdeError::invalid(format!("{rel} changed on disk; review its changes again"));
    let find = |want: &crate::HunkRange| {
        hunks
            .iter()
            .position(|h| {
                (h.start, h.lines, h.old_start, h.old_lines) == (want.start, want.lines, want.old_start, want.old_lines)
            })
            .ok_or_else(stale)
    };
    let selected = file.hunks.iter().map(find).collect::<IdeResult<Vec<_>>>()?;
    if file.line_hunks.is_empty() {
        return Ok((crate::diff::selected_text(&head, &disk, &selected), bom));
    }
    let normalized = crate::diff::normalize_eol(&disk);
    let lines: Vec<_> = normalized.split_inclusive('\n').collect();
    let mut partial = BTreeMap::new();
    for change in &file.line_hunks {
        let index = find(&change.range)?;
        let hunk = &hunks[index];
        let current = &lines[hunk.start as usize..(hunk.start + hunk.lines) as usize];
        if hunk.old_text != change.old_text || current.concat() != change.new_text {
            return Err(stale());
        }
        if selected.contains(&index)
            || partial.insert(index, change).is_some()
            || change.deletions.iter().any(|&line| line >= hunk.old_lines)
            || change.additions.iter().any(|&line| line >= hunk.lines)
        {
            return Err(IdeError::invalid(format!("{rel}: invalid partial commit line selection")));
        }
    }
    Ok((crate::diff::selected_lines_text(&head, &disk, &selected, &partial), bom))
}

enum CommitFileSource<'a> {
    Worktree,
    Partial(&'a PartialCommitFile),
}

/// Overrides for files whose selected content comes from outside the index.
fn commit_file_sources<'a>(r: &Repo, options: &'a CommitOptions) -> IdeResult<BTreeMap<String, CommitFileSource<'a>>> {
    let mut sources = BTreeMap::new();
    for path in &options.stage {
        sources.insert(r.rel_path(&path.0)?, CommitFileSource::Worktree);
    }
    for file in &options.partial {
        sources.insert(r.rel_path(&file.path.0)?, CommitFileSource::Partial(file));
    }
    Ok(sources)
}

pub(crate) fn commit_crlf_paths(
    r: &Repo,
    paths: &[PathBuf],
    options: &CommitOptions,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    cancel: &CancellationToken,
) -> IdeResult<Vec<IpcPath>> {
    // Git converts CRLF on commit for `input` and for every spelling of a true boolean.
    if paths.is_empty()
        || matches!(
            r.config_get("core.autocrlf")?.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
            Some("true" | "yes" | "on" | "1" | "input")
        )
    {
        return Ok(Vec::new());
    }
    let paths = r.rel_paths(paths)?;
    let file_sources = commit_file_sources(r, options)?;
    let args = ["--literal-pathspecs", "ls-files", "--eol", "-z", "--cached", "--others", "--exclude-standard", "--"];
    let mut problems = BTreeSet::new();
    for batch in cli::batch_paths(cli::base_command_line_len(&args), &paths, cli::command_line_limit()) {
        let mut full = args.to_vec();
        full.extend(batch.iter().map(String::as_str));
        let out = cli::run_cancellable(r.root(), &full, cancel)?;
        let requested: BTreeSet<_> = batch.iter().map(String::as_str).collect();
        for row in out.stdout.split(|byte| *byte == 0) {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let row = String::from_utf8_lossy(row);
            let Some((fields, rel)) = row.split_once('\t') else { continue };
            let Some((sources, attrs)) = fields.split_once("attr/") else { continue };
            if !attrs.trim().is_empty() || !requested.contains(rel) {
                continue;
            }
            let mut sources = sources.split_whitespace();
            let staged_eol = sources.next().and_then(|field| field.strip_prefix("i/"));
            let working_eol = sources.next().and_then(|field| field.strip_prefix("w/"));
            let has_crlf = match file_sources.get(rel) {
                Some(CommitFileSource::Partial(file)) => encoding(&file.path.0)
                    .and_then(|encoding| partial_commit_text(r, rel, file, encoding))
                    .is_ok_and(|(text, _)| text.contains("\r\n")),
                Some(CommitFileSource::Worktree) => matches!(working_eol, Some("crlf" | "mixed")),
                None => matches!(staged_eol, Some("crlf" | "mixed")),
            };
            if has_crlf {
                problems.insert(r.abs_path(rel));
            }
        }
    }
    Ok(problems.into_iter().map(IpcPath).collect())
}

pub(crate) fn commit_large_files(
    r: &Repo,
    paths: &[PathBuf],
    options: &CommitOptions,
    limit: u64,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    cancel: &CancellationToken,
) -> IdeResult<Vec<LargeCommitFile>> {
    if paths.is_empty() || limit == 0 || r.config_get("lfs.repositoryformatversion")?.is_some() {
        return Ok(Vec::new());
    }
    let paths = r.rel_paths(paths)?;
    let sources = commit_file_sources(r, options)?;
    let repo = r.gix()?;
    let index = repo.index_or_empty().map_err(gx)?;
    let mut large = Vec::new();
    for rel in paths {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let path = r.abs_path(&rel);
        let size = match sources.get(&rel) {
            Some(CommitFileSource::Worktree) => {
                std::fs::symlink_metadata(&path).ok().filter(std::fs::Metadata::is_file).map(|meta| meta.len())
            }
            Some(CommitFileSource::Partial(file)) => encoding(&file.path.0)
                .and_then(|encoding| {
                    let (text, bom) = partial_commit_text(r, &rel, file, encoding)?;
                    encode(&text, encoding, bom)
                })
                .ok()
                .map(|bytes| bytes.len() as u64),
            None => index
                .entry_by_path_and_stage(BStr::new(rel.as_bytes()), gix::index::entry::Stage::Unconflicted)
                .filter(|entry| !entry.mode.is_submodule())
                .and_then(|entry| repo.try_find_header(entry.id).ok().flatten())
                .filter(|header| header.kind() == gix::object::Kind::Blob)
                .map(|header| header.size()),
        };
        if let Some(size) = size.filter(|size| *size > limit) {
            large.push(LargeCommitFile { path: IpcPath(path), size });
        }
    }
    Ok(large)
}

/// The changes a commit of `options` would make, as `git diff` reports them (renames
/// detected), from HEAD (an empty tree without one). Nothing is committed and the
/// working tree and the index are left alone: a selection is made in a copy of the
/// index. Patches stop growing at `max_bytes` in all.
pub(crate) fn pending_changes(
    r: &Repo,
    options: &CommitOptions,
    max_bytes: usize,
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
) -> IdeResult<Vec<PendingChange>> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = TempIndex(r.git_dir.join(format!("openidea-pending-index-{}-{n}", std::process::id())));
    let env_tmp = [("GIT_INDEX_FILE", tmp.0.as_os_str())];
    let env: &[(&str, &std::ffi::OsStr)] = if selects(options) {
        select_into(r, &tmp, options, encoding)?;
        &env_tmp
    } else {
        &[]
    };
    // `--cached` compares with HEAD, or with an empty tree on an unborn branch.
    let base = ["diff", "--cached", "-M", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative"];
    let names = cli::run_env(r.root(), &[&base[..], &["--name-status", "-z"]].concat(), None, env)?;
    let patch = cli::run_env(
        r.root(),
        &[&base[..], &["--patch", "--src-prefix=a/", "--dst-prefix=b/", "--full-index"]].concat(),
        None,
        env,
    )?;
    let mut changes = parse_name_status(&names.stdout, r.root());
    let sections = split_patch(&patch.stdout);
    let mut budget = max_bytes;
    for (change, section) in changes.iter_mut().zip(sections) {
        if patch_is_binary(section) {
            continue;
        }
        let charset = encoding(&change.path).unwrap_or_else(|_| encoding_rs::UTF_8.into());
        let text = crate::text_encoding::decode_raw(section, charset);
        if text.len() <= budget {
            budget -= text.len();
            change.diff = Some(text.into_owned());
        } else {
            let mut cut = budget.min(text.len());
            // Whole lines only, at a character boundary.
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            let kept = text[..cut].rfind('\n').map_or(0, |i| i + 1);
            budget -= kept;
            change.diff = Some(text[..kept].to_owned());
            change.truncated = true;
        }
    }
    Ok(changes)
}

/// A file a pending commit changes ([`Repo::pending_changes`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChange {
    pub path: PathBuf,
    /// The path before a rename or copy.
    pub old_path: Option<PathBuf>,
    /// `added`, `modified`, `deleted`, `renamed`, `copied` or `type-changed`.
    pub status: &'static str,
    /// Its section of the unified diff; `None` for binary content.
    pub diff: Option<String>,
    /// `diff` was cut at the size limit.
    pub truncated: bool,
}

/// `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`.
fn parse_name_status(out: &[u8], root: &Path) -> Vec<PendingChange> {
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    let path = |f: &[u8]| root.join(String::from_utf8_lossy(f).as_ref());
    let mut changes = Vec::new();
    while let Some(code) = fields.next() {
        let status = match code.first() {
            Some(b'A') => "added",
            Some(b'D') => "deleted",
            Some(b'R') => "renamed",
            Some(b'C') => "copied",
            Some(b'T') => "type-changed",
            _ => "modified",
        };
        let two = matches!(code.first(), Some(b'R' | b'C'));
        let first = fields.next().map(path);
        let (old_path, path) = if two { (first, fields.next().map(path)) } else { (None, first) };
        let Some(path) = path else { break };
        changes.push(PendingChange { path, old_path, status, diff: None, truncated: false });
    }
    changes
}

/// The per-file sections of a patch, each starting at its `diff --git` line.
fn split_patch(patch: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    for line in patch.split_inclusive(|b| *b == b'\n') {
        if line.starts_with(b"diff --git ") {
            starts.push(at);
        }
        at += line.len();
    }
    starts.iter().enumerate().map(|(i, &s)| &patch[s..starts.get(i + 1).copied().unwrap_or(patch.len())]).collect()
}

fn patch_is_binary(section: &[u8]) -> bool {
    section
        .split(|b| *b == b'\n')
        .take_while(|l| !l.starts_with(b"@@"))
        .any(|l| l.starts_with(b"Binary files ") || l.starts_with(b"GIT binary patch"))
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
    Switch {
        args: Vec<String>,
        target: String,
    },
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
    let switch = |args: &[&str], target: String| SwitchPlan::Switch {
        args: args.iter().map(|s| s.to_string()).collect(),
        target,
    };
    if create {
        return Ok(switch(&["switch", "-c", branch], "HEAD".into()));
    }
    let repo = r.gix()?;
    let detached = || Ok(switch(&["switch", "--detach", branch], resolve(&repo, branch)?.to_string()));
    // Revision expressions such as `HEAD~1` are not branch names.
    let candidate = format!("refs/heads/{branch}");
    if <&gix::refs::FullNameRef>::try_from(candidate.as_str()).is_err() {
        return detached();
    }
    let exists = |name: &str| repo.try_find_reference(name).map_err(gx).map(|r| r.is_some());
    let qualified = branch.starts_with("refs/");
    let local_name = branch.strip_prefix("refs/heads/");
    if let Some(name) = local_name.or_else(|| (!qualified).then_some(branch)) {
        let local = format!("refs/heads/{name}");
        if exists(&local)? {
            return Ok(switch(&["switch", "--no-guess", check_rev(name)?], local));
        }
        if local_name.is_some() {
            return Err(IdeError::not_found(format!("unknown revision {branch}")));
        }
    }
    let remote_name = branch.strip_prefix("refs/remotes/");
    if let Some(remote) = remote_name.or_else(|| (!qualified).then_some(branch)) {
        let remote_ref = format!("refs/remotes/{remote}");
        if exists(&remote_ref)?
            && let Some(name) = remote_branch_name(&repo, remote)
        {
            if !exists(&format!("refs/heads/{name}"))? {
                return Ok(switch(&["switch", "-c", name, "--track", &remote_ref], remote_ref.clone()));
            }
            // A local namesake with its own commits needs the user's choice.
            let range = format!("{remote_ref}..refs/heads/{name}");
            let ahead = run(r.root(), &["rev-list", "--count", &range], None)?.stdout_str().trim() != "0";
            return Ok(match (ahead, diverged) {
                (true, None) => SwitchPlan::Ahead { local: name.to_owned(), remote: remote.to_owned() },
                (true, Some(DivergedLocal::Rebase)) => SwitchPlan::Rebase {
                    local: name.to_owned(),
                    remote: unambiguous_branch_name(r, &remote_ref).to_owned(),
                },
                _ => switch(&["switch", "-C", name, "--track", &remote_ref], remote_ref.clone()),
            });
        }
        if remote_name.is_some() {
            return Err(IdeError::not_found(format!("unknown revision {branch}")));
        }
    }
    detached()
}

fn remote_branch_name<'a>(repo: &gix::Repository, remote_ref: &'a str) -> Option<&'a str> {
    repo.remote_names()
        .iter()
        .filter_map(|remote| remote_ref.strip_prefix(&format!("{remote}/")))
        .min_by_key(|name| name.len())
        .or_else(|| remote_ref.split_once('/').map(|(_, name)| name))
}

pub(crate) fn checkout_affected_files(r: &Repo, branch: &str) -> IdeResult<Vec<String>> {
    let branch = check_rev(branch.trim())?;
    let SwitchPlan::Switch { target, .. } = switch_plan(r, branch, false, None)? else { return Ok(Vec::new()) };
    if !r.has_head()? || r.operation()?.is_some() {
        return Ok(Vec::new());
    }
    // The dry run leaves the index and worktree alone, but reports only the first failure.
    let dry = cli::run_raw(r.root(), &["read-tree", "--dry-run", "-m", "-u", "HEAD", &target], None)?;
    if dry.code == Some(0) {
        return Ok(Vec::new());
    }
    affected_tree_files(r, "HEAD", &target, false)
}

pub(crate) fn merge_affected_files(r: &Repo, branch: &str) -> IdeResult<Vec<String>> {
    if r.operation()?.is_some() {
        return Ok(Vec::new());
    }
    let branch = check_rev(branch.trim())?;
    let Some(head) = r.head()?.1 else { return Ok(Vec::new()) };
    let target = resolve(&r.gix()?, branch)?.to_string();
    let Some(base) = r.merge_base(&head, &target)? else { return Ok(Vec::new()) };
    if base == target {
        return Ok(Vec::new());
    }
    // A three-way merge can also refuse staged edits even on paths unchanged by the incoming branch.
    affected_tree_files(r, &base, &target, base != head)
}

fn affected_tree_files(r: &Repo, base: &str, target: &str, include_staged: bool) -> IdeResult<Vec<String>> {
    let changed = run(r.root(), &["diff", "--name-only", "-z", "--no-renames", base, target, "--"], None)?;
    let changed = changed.stdout_str();
    let changed: BTreeSet<_> = changed.split_terminator('\0').collect();
    let dirty = run(
        r.root(),
        &["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"],
        None,
    )?;
    let dirty = dirty.stdout_str();
    let affected = dirty.split_terminator('\0').filter_map(|entry| {
        let path = entry.get(3..)?;
        if include_staged && !entry.starts_with(' ') {
            return Some(path.to_owned());
        }
        let prefix = format!("{path}/");
        let incoming = changed.contains(path)
            || path.match_indices('/').any(|(i, _)| changed.contains(&path[..i]))
            || changed.range(prefix.as_str()..).next().is_some_and(|changed| changed.starts_with(&prefix));
        incoming.then(|| path.to_owned())
    });
    Ok(affected.collect())
}

/// Files git refuses to overwrite with local changes, from its error message.
fn overwritten_files(stderr: &str) -> Option<Vec<String>> {
    listed_files(stderr, "local changes to the following files would be overwritten")
}

/// Untracked files git refuses to lose, from its error message: they would be *removed*
/// by the checkout (tracked here, absent from the target) or *overwritten* by it (present
/// in the target). Returns the files and whether they would be removed.
fn refused_untracked(stderr: &str) -> Option<(Vec<String>, bool)> {
    if let Some(files) = listed_files(stderr, "untracked working tree files would be removed") {
        return Some((files, true));
    }
    Some((listed_files(stderr, "untracked working tree files would be")?, false))
}

/// The branch git refused to check out or update because another worktree has it, from
/// its error message: a switch says `'<branch>' is already used by worktree at '<path>'`,
/// a forced update says `cannot force update the branch '<branch>' used by worktree at
/// '<path>'`; git before 2.42 says `'<branch>' is already checked out at '<path>'`.
fn branch_of_other_worktree(stderr: &str) -> Option<(String, String)> {
    const MARKERS: [&str; 3] =
        ["' is already used by worktree at '", "' used by worktree at '", "' is already checked out at '"];
    let (before, path) = stderr.lines().find_map(|l| MARKERS.iter().find_map(|m| l.split_once(m)))?;
    let branch = before.rsplit('\'').next()?.to_string();
    Some((branch, path.strip_suffix('\'').unwrap_or(path).to_string()))
}

fn listed_files(stderr: &str, header: &str) -> Option<Vec<String>> {
    let mut files = Vec::new();
    let mut in_list = false;
    for line in stderr.lines() {
        if let Some(path) = line.strip_prefix('\t') {
            if in_list {
                files.push(path.to_owned());
            }
        } else {
            in_list = line.contains(header);
        }
    }
    files.sort_unstable();
    files.dedup();
    (!files.is_empty()).then_some(files)
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
    let args = match switch_plan(r, branch, create, options.diverged)? {
        SwitchPlan::Ahead { local, remote } => return Ok(CheckoutOutcome::LocalBranchAhead { local, remote }),
        SwitchPlan::Rebase { local, remote } => {
            crate::preserve::save(r, "Local changes saved before checkout")?;
            let out = cli::run_raw(r.root(), &["rebase", &remote, &local], None)?;
            if out.code == Some(0) {
                crate::preserve::restore(r)?;
                return Ok(CheckoutOutcome::Done);
            }
            crate::preserve::restore(r)?;
            let files = unmerged_paths(r)?;
            if files.is_empty() {
                return Err(cli::failure(&["rebase"], &out.stderr, &out.stdout, out.code));
            }
            return Ok(CheckoutOutcome::Conflicts { files });
        }
        SwitchPlan::Switch { args, .. } => args,
    };
    switch_with(r, branch, args.iter().map(String::as_str).collect(), options)
}

fn switch_with(r: &Repo, branch: &str, mut argv: Vec<&str>, options: &CheckoutOptions) -> IdeResult<CheckoutOutcome> {
    if options.mode == CheckoutMode::Force {
        argv.push("--discard-changes");
    }
    if options.ignore_other_worktrees {
        argv.push("--ignore-other-worktrees");
    }
    let out = cli::run_raw(r.root(), &argv, None)?;
    if out.code == Some(0) {
        return Ok(CheckoutOutcome::Done);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if let Some((branch, path)) = branch_of_other_worktree(&stderr) {
        return Ok(CheckoutOutcome::CheckedOutInWorktree { branch, path: path.into() });
    }
    if let Some((files, removed)) = refused_untracked(&stderr) {
        return Ok(CheckoutOutcome::UntrackedFiles { files, removed });
    }
    let Some(files) = overwritten_files(&stderr) else {
        return Err(cli::failure(&argv, &out.stderr, &out.stdout, out.code));
    };
    if options.mode != CheckoutMode::Smart {
        return Ok(CheckoutOutcome::LocalChanges { files });
    }
    let restored = crate::preserve::checkout(r, &format!("Uncommitted changes before checkout of {branch}"), || {
        run(r.root(), &argv, None).map(|_| ())
    })?;
    Ok(match restored {
        Ok(files) if files.is_empty() => CheckoutOutcome::Done,
        Ok(files) => CheckoutOutcome::Conflicts { files },
        Err(error) => CheckoutOutcome::RestoreFailed { message: error.message },
    })
}

/// Creates `name` at `start` (default HEAD); a remote-tracking start point is tracked.
pub(crate) fn create_branch(
    r: &Repo,
    name: &str,
    start: Option<&str>,
    checkout: Option<&CheckoutOptions>,
    overwrite: bool,
    expected_tip: Option<&str>,
) -> IdeResult<BranchCreationOutcome> {
    let name = name.trim();
    let valid = !name.is_empty()
        && !name.starts_with('-')
        && name != "HEAD"
        && cli::run_raw(r.root(), &["check-ref-format", "--branch", name], None)?.code == Some(0);
    if !valid {
        return Err(IdeError::invalid(format!("'{name}' is not a valid branch name")));
    }
    let start = start.map(str::trim).filter(|s| !s.is_empty());
    let revision = check_rev(start.unwrap_or("HEAD"))?;
    let tip = run(r.root(), &["rev-parse", "--verify", &format!("{revision}^{{commit}}")], None)?
        .stdout_str()
        .trim()
        .to_string();
    let reference = format!("refs/heads/{name}");
    let previous_tip = if overwrite {
        let out = cli::run_raw(r.root(), &["rev-parse", "--verify", "-q", &reference], None)?;
        (out.code == Some(0)).then(|| out.stdout_str().trim().to_string())
    } else {
        None
    };
    if expected_tip.is_some() && previous_tip.as_deref() != expected_tip {
        return Err(branch_creation_changed(name));
    }
    let no_track = previous_tip.is_some() || start.is_some_and(|s| renamed_remote_start(r, name, s));
    let mut args = match (checkout.is_some(), overwrite) {
        (true, false) => vec!["switch", "-c", name],
        (true, true) => vec!["switch", "-C", name],
        (false, false) => vec!["branch"],
        (false, true) => vec!["branch", "--force"],
    };
    if no_track {
        args.push("--no-track");
    }
    if checkout.is_none() {
        args.extend(["--", name]);
    }
    args.extend(start);
    let checkout = match checkout {
        Some(options) => switch_with(r, name, args, options)?,
        None => {
            run(r.root(), &args, None)?;
            CheckoutOutcome::Done
        }
    };
    let created = checkout.switched().then_some(BranchCreation { tip, previous_tip });
    Ok(BranchCreationOutcome { checkout, created })
}

fn branch_creation_changed(name: &str) -> IdeError {
    IdeError::invalid(format!("Branch '{name}' changed during branch creation"))
}

pub(crate) fn undo_branch_creation(
    r: &Repo,
    name: &str,
    created: &BranchCreation,
    previous_head: Option<&HistoryTip>,
) -> IdeResult<()> {
    check_local_branch(r, name)?;
    let reference = format!("refs/heads/{name}");
    let tip = run(r.root(), &["rev-parse", "--verify", &reference], None)?.stdout_str();
    if tip.trim() != created.tip {
        return Err(branch_creation_changed(name));
    }
    if let Some(before) = previous_head {
        let current = r.branch_info()?;
        if current.head.as_deref() != Some(name)
            || current.head_commit.as_deref() != Some(created.tip.as_str())
            || current.operation.is_some()
        {
            return Err(branch_creation_changed(name));
        }
        if before.branch.as_deref() == Some(name) {
            if created.previous_tip.as_deref() != Some(before.commit.as_str()) {
                return Err(branch_creation_changed(name));
            }
            return restore_head(r, &before.commit, &created.tip, before.branch.as_deref());
        }
        let rev = check_rev(before.branch.as_deref().unwrap_or(&before.commit))?;
        if let Some(branch) = &before.branch {
            check_local_branch(r, branch)?;
        }
        let options = CheckoutOptions { mode: CheckoutMode::Smart, ..Default::default() };
        if !matches!(checkout_with(r, rev, false, &options)?, CheckoutOutcome::Done) {
            return Err(IdeError::invalid("Could not check out the previous branch"));
        }
    }
    if let Some(previous) = &created.previous_tip {
        if r.worktrees()?.iter().any(|tree| tree.branch.as_deref() == Some(name)) {
            return Err(branch_creation_changed(name));
        }
        let previous = check_rev(previous)?;
        let expected = check_rev(&created.tip)?;
        run(r.root(), &["update-ref", "-m", "undo branch creation", &reference, previous, expected], None)?;
        Ok(())
    } else {
        // Git checks all worktrees and clears the tracking config it may have added.
        if run(r.root(), &["rev-parse", "--verify", &reference], None)?.stdout_str().trim() != created.tip {
            return Err(branch_creation_changed(name));
        }
        delete_branch(r, name, true)
    }
}

/// Whether `start` is a remote-tracking branch with another name than the new branch
/// `name`. Git would make it the upstream, so pushing the new branch would go to the
/// start branch (`feature` from `origin/main` pushes to `main`); such a branch is left
/// without upstream and gets its own one on the first push. A remote branch under the
/// same name stays tracked.
pub(crate) fn renamed_remote_start(r: &Repo, name: &str, start: &str) -> bool {
    let Ok(out) = cli::run_raw(r.root(), &["rev-parse", "--verify", "--quiet", "--symbolic-full-name", start], None)
    else {
        return false;
    };
    let full = out.stdout_str().trim().to_string();
    let Some(rest) = full.strip_prefix("refs/remotes/").filter(|_| out.code == Some(0)) else { return false };
    let Ok(repo) = r.gix() else { return false };
    remote_branch_name(&repo, rest).is_some_and(|branch| branch != name)
}

/// Undo of a history rewrite: moves HEAD from `after` back to `before`, preserving local changes.
pub(crate) fn restore_head(r: &Repo, before: &str, after: &str, branch: Option<&str>) -> IdeResult<()> {
    let check = || {
        if r.operation()?.is_some() {
            return Err(IdeError::invalid("cannot undo while a merge, rebase or cherry-pick is in progress"));
        }
        let (current, head) = r.head()?;
        if head.as_deref() != Some(after) || branch.is_some_and(|expected| current.as_deref() != Some(expected)) {
            return Err(IdeError::invalid("the branch has changed since; undo is no longer possible"));
        }
        Ok(())
    };
    check()?;
    let before = check_rev(before)?;
    let tree = |rev: &str| run(r.root(), &["rev-parse", &format!("{rev}^{{tree}}")], None).map(|o| o.stdout_str());
    if tree(before)? == tree(after)? {
        let reference = branch.map_or_else(|| "HEAD".to_owned(), |branch| format!("refs/heads/{branch}"));
        run(r.root(), &["update-ref", "-m", "undo", &reference, before, after], None)?;
    } else {
        // Reset --keep preserves the files on disk but unstages previously staged changes.
        crate::preserve::around(r, "Local changes saved before undo", || {
            check()?;
            run(r.root(), &["reset", "-q", "--keep", before, "--"], None).map(|_| ())
        })?;
    }
    Ok(())
}

/// Returns to the original checkout and restores the branch that was rebased.
pub(crate) fn restore_rebase_checkout(
    r: &Repo,
    before: &str,
    after: &str,
    branch: &str,
    checkout: &HistoryTip,
) -> IdeResult<()> {
    let before = check_rev(before)?;
    let after = check_rev(after)?;
    check_local_branch(r, branch)?;
    let reference = format!("refs/heads/{branch}");
    let checkout_commit = check_rev(&checkout.commit)?;
    let switch = if let Some(name) = &checkout.branch {
        check_local_branch(r, name)?;
        if name == branch {
            return Err(IdeError::invalid("Cannot restore the checkout to the rebased branch"));
        }
        vec!["switch", "--no-guess", name.as_str()]
    } else {
        vec!["switch", "--detach", checkout_commit]
    };
    let check = || {
        let (current, tip) = r.head()?;
        if r.operation()?.is_some() || current.as_deref() != Some(branch) || tip.as_deref() != Some(after) {
            return Err(IdeError::invalid("the branch has changed since; undo is no longer possible"));
        }
        if let Some(name) = &checkout.branch {
            let tip = resolve(&r.gix()?, &format!("refs/heads/{name}"))?;
            if Some(tip) != gix::ObjectId::from_hex(checkout_commit.as_bytes()).ok() {
                return Err(IdeError::invalid("The previous branch has changed since the rebase"));
            }
        }
        Ok(())
    };
    check()?;
    crate::preserve::around(r, "Local changes saved before undo", || {
        check()?;
        // A refused switch leaves both refs untouched. Update the rebased branch by its exact
        // name and expected tip after it is no longer checked out.
        run(r.root(), &switch, None)?;
        if before != after {
            if r.worktrees()?.iter().any(|tree| !tree.prunable && tree.branch.as_deref() == Some(branch)) {
                return Err(IdeError::invalid("The rebased branch is now checked out"));
            }
            run(r.root(), &["update-ref", "-m", "undo checkout and rebase", &reference, before, after], None)?;
        }
        Ok(())
    })
}

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

fn branch_deletion_receipt(r: &Repo, branch: &str) -> IdeResult<(DeletedBranch, Option<String>)> {
    check_local_branch(r, branch)?;
    let tip = run(r.root(), &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}^{{commit}}")], None)?
        .stdout_str()
        .trim()
        .to_string();
    let out = run(
        r.root(),
        &[
            "for-each-ref",
            "--format=%(upstream:short)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)",
            &format!("refs/heads/{branch}"),
        ],
        None,
    )?;
    let output = out.stdout_str();
    let mut fields = output.trim_end_matches(['\r', '\n']).split('\t');
    let upstream = fields.next().filter(|name| !name.is_empty()).map(str::to_owned);
    let full_ref = fields.next().filter(|name| !name.is_empty()).map(str::to_owned);
    let remote = fields.next().filter(|name| !name.is_empty() && *name != ".");
    let remote_branch = fields.next().and_then(|name| name.strip_prefix("refs/heads/"));
    let remote_upstream = remote
        .zip(remote_branch)
        .map(|(remote, branch)| UpstreamTracking { remote: remote.to_owned(), branch: branch.to_owned() });
    Ok((
        DeletedBranch { name: branch.to_owned(), tip, upstream, remote_upstream, unmerged_base: None, unmerged: false },
        full_ref,
    ))
}

pub(crate) fn delete_branch_restorable(
    r: &Repo,
    branch: &str,
    expected: Option<(&str, &str)>,
) -> IdeResult<DeletedBranch> {
    let (mut deleted, upstream_ref) = branch_deletion_receipt(r, branch)?;
    if let Some((tip, upstream)) = expected
        && (deleted.tip != tip
            || deleted
                .remote_upstream
                .as_ref()
                .is_none_or(|tracking| format!("{}/{}", tracking.remote, tracking.branch) != upstream))
    {
        return Err(IdeError::invalid(format!("Tracking branch '{branch}' changed before it could be deleted")));
    }
    let out = cli::run_raw(r.root(), &["branch", "-d", "--", branch], None)?;
    deleted.unmerged = match out.code {
        Some(0) => false,
        _ if String::from_utf8_lossy(&out.stderr).contains("not fully merged") => {
            let repo = r.gix()?;
            deleted.unmerged_base = upstream_ref
                .as_deref()
                .and_then(|upstream| resolve(&repo, upstream).ok())
                .or_else(|| repo.head_id().ok().map(|id| id.detach()))
                .map(|id| id.to_string());
            run(r.root(), &["branch", "-D", "--", branch], None)?;
            true
        }
        code => return Err(cli::failure(&["branch"], &out.stderr, &out.stdout, code)),
    };
    Ok(deleted)
}

pub(crate) fn delete_merged_branch(r: &Repo, branch: &str, expected_tip: &str) -> IdeResult<DeletedBranch> {
    let (deleted, _) = branch_deletion_receipt(r, branch)?;
    if deleted.tip != expected_tip {
        return Err(IdeError::invalid(format!("Branch '{branch}' changed since the merge")));
    }
    // ':' cannot name a remote. With no upstream, Git checks HEAD for reachability
    // and still refuses to delete branches in use by any worktree.
    // The environment form accepts '=' in a branch name, which '-c key=value' splits.
    let index = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|count| count.parse::<u32>().ok()).unwrap_or(0);
    let key = format!("branch.{branch}.remote");
    let count = index.saturating_add(1).to_string();
    cli::run_env(
        r.root(),
        &["branch", "-d", "--", branch],
        None,
        &[
            ("GIT_CONFIG_COUNT", count.as_ref()),
            (&format!("GIT_CONFIG_KEY_{index}"), key.as_ref()),
            (&format!("GIT_CONFIG_VALUE_{index}"), ":".as_ref()),
        ],
    )?;
    Ok(deleted)
}

pub(crate) fn restore_branch(r: &Repo, deleted: &DeletedBranch) -> IdeResult<()> {
    let tip = check_rev(&deleted.tip)?;
    run(r.root(), &["branch", "--", &deleted.name, tip], None)?;
    if let Some(tracking) = &deleted.remote_upstream {
        // Keep the configured upstream even if its remote-tracking ref was pruned.
        let remote_key = format!("branch.{}.remote", deleted.name);
        let merge_key = format!("branch.{}.merge", deleted.name);
        let merge = format!("refs/heads/{}", tracking.branch);
        run(r.root(), &["config", "--local", "--replace-all", "--", &remote_key, &tracking.remote], None)?;
        run(r.root(), &["config", "--local", "--replace-all", "--", &merge_key, &merge], None)?;
    } else if let Some(upstream) = &deleted.upstream {
        let target = format!("--set-upstream-to={upstream}");
        run(r.root(), &["branch", &target, "--", &deleted.name], None)?;
    }
    Ok(())
}

/// `unset_upstream` drops the tracking that `git branch -m` moves to the new name.
pub(crate) fn rename_branch(r: &Repo, from: &str, to: &str, unset_upstream: bool) -> IdeResult<()> {
    let to = to.trim();
    if to.is_empty() {
        return Err(IdeError::invalid("branch name is empty"));
    }
    if from == to {
        check_local_branch(r, from)?;
    } else {
        run(r.root(), &["branch", "-m", "--", from, to], None)?;
    }
    if unset_upstream {
        let args = ["branch", "--unset-upstream", "--", to];
        let out = cli::run_raw(r.root(), &args, None)?;
        let no_upstream = format!("fatal: branch '{to}' has no upstream information");
        if out.code != Some(0) && !String::from_utf8_lossy(&out.stderr).lines().any(|line| line == no_upstream) {
            let mut error = cli::failure(&args, &out.stderr, &out.stdout, out.code);
            if from != to {
                error.message =
                    format!("Renamed branch '{from}' to '{to}', but could not unset its upstream: {}", error.message);
            }
            return Err(error);
        }
    }
    Ok(())
}

fn check_rev(rev: &str) -> IdeResult<&str> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(IdeError::invalid(format!("invalid revision '{rev}'")));
    }
    Ok(rev)
}

/// The short name of a full branch ref (`refs/heads/x`, `refs/remotes/origin/x`) when it
/// names that same branch: git writes the name it is given into the merge message and the
/// reflog. A name a tag shares stays a full ref, the case IDEA also passes in full.
pub(crate) fn unambiguous_branch_name<'a>(r: &Repo, rev: &'a str) -> &'a str {
    let Some(short) = rev.strip_prefix("refs/heads/").or_else(|| rev.strip_prefix("refs/remotes/")) else {
        return rev;
    };
    // An ambiguous name prints nothing (git reports it on stderr).
    let full = cli::run_raw(r.root(), &["rev-parse", "--verify", "-q", "--symbolic-full-name", short], None);
    match full {
        Ok(out) if out.code == Some(0) && out.stdout_str().trim() == rev => short,
        _ => rev,
    }
}

/// Local changes are stashed and restored around the merge (IDEA's "save local changes").
pub(crate) fn merge(r: &Repo, branch: &str) -> IdeResult<()> {
    let branch = unambiguous_branch_name(r, check_rev(branch)?);
    crate::preserve::around(r, "Local changes saved before merge", || {
        run(r.root(), &["merge", "--no-edit", branch], None).map(|_| ())
    })
}

pub(crate) fn merge_attempt(r: &Repo, args: &[&str], options: &MergeOptions, smart: bool) -> IdeResult<MergeOutcome> {
    let attempt = || {
        let out = cli::run_raw(r.root(), args, None)?;
        let stdout = out.stdout_str();
        let stderr = String::from_utf8_lossy(&out.stderr);
        let conflicts = stdout
            .lines()
            .chain(stderr.lines())
            .any(|line| line.starts_with("CONFLICT (") || line.contains("Applying autostash resulted in conflicts"));
        if conflicts && !unmerged_paths(r)?.is_empty() {
            return Ok(MergeOutcome::Conflicts);
        }
        if out.code == Some(0) {
            if stdout.lines().chain(stderr.lines()).any(|line| {
                matches!(
                    line.trim_end_matches('.'),
                    "Already up to date" | "Already up-to-date" | "Already up to date. (nothing to squash)"
                )
            }) {
                return Ok(MergeOutcome::AlreadyUpToDate);
            }
            if options.squash {
                return Ok(MergeOutcome::Squashed);
            }
            if options.no_commit && r.operation()?.as_deref() == Some("merge") {
                return Ok(MergeOutcome::ReadyToCommit);
            }
            return Ok(MergeOutcome::Done);
        }
        if let Some(files) = merge_overwritten_files(r, &stderr)? {
            return Ok(MergeOutcome::LocalChanges { files });
        }
        Err(cli::failure(args, &out.stderr, &out.stdout, out.code))
    };
    if !smart {
        return attempt();
    }
    crate::preserve::save(r, "Local changes saved before merge")?;
    let result = attempt();
    if matches!(result, Ok(MergeOutcome::Conflicts)) {
        return result;
    }
    let restored = crate::preserve::restore(r);
    let value = result?;
    if let Err(error) = restored {
        if !unmerged_paths(r)?.is_empty() {
            return Ok(MergeOutcome::Conflicts);
        }
        return Err(error);
    }
    Ok(value)
}

fn merge_overwritten_files(r: &Repo, stderr: &str) -> IdeResult<Option<Vec<String>>> {
    const HEADER: &str = "local changes to the following files would be overwritten by merge";
    let mut files = listed_files(stderr, HEADER).unwrap_or_default();
    // The three-way strategy prints an undelimited list of staged paths, some of which may contain spaces.
    if stderr
        .lines()
        .zip(stderr.lines().skip(1))
        .any(|(header, line)| header.contains(HEADER) && line.starts_with("  "))
    {
        let staged = run(r.root(), &["diff", "--cached", "--name-only", "-z", "--no-renames", "--"], None)?;
        files.extend(staged.stdout_str().split_terminator('\0').map(ToOwned::to_owned));
        files.sort_unstable();
        files.dedup();
    }
    Ok((!files.is_empty()).then_some(files))
}

pub(crate) fn rebase(r: &Repo, onto: &str) -> IdeResult<()> {
    let onto = unambiguous_branch_name(r, check_rev(onto)?);
    crate::preserve::around(r, "Local changes saved before rebase", || {
        run(r.root(), &["rebase", onto], None).map(|_| ())
    })
}

pub(crate) fn rebase_branch(
    r: &Repo,
    plan: &BranchRebasePlan,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<HistoryTip> {
    let target = check_rev(&plan.target)?;
    let check = || {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if r.operation()?.is_some() || !unmerged_paths(r)?.is_empty() {
            return Err(IdeError::invalid("finish the Git operation or resolve the conflicts before rebasing"));
        }
        let (branch, commit) = r.head()?;
        if branch.is_none() || branch != plan.head.branch || commit.as_deref() != Some(plan.head.commit.as_str()) {
            return Err(IdeError::invalid("The current branch changed before rebase"));
        }
        if Some(resolve(&r.gix()?, target)?) != gix::ObjectId::from_hex(plan.onto.as_bytes()).ok() {
            return Err(IdeError::invalid("The target branch changed before rebase"));
        }
        Ok(())
    };
    check()?;
    crate::preserve::around(r, "Local changes saved before rebase", || {
        check()?;
        cli::run_streaming(r.root(), &["rebase", unambiguous_branch_name(r, target)], cancel, out)?;
        completed_rebase(r, plan.head.branch.as_deref())
    })
}

fn completed_rebase(r: &Repo, expected: Option<&str>) -> IdeResult<HistoryTip> {
    if r.operation()?.as_deref() == Some("rebase") {
        return Err(IdeError::invalid("Rebase paused"));
    }
    let (branch, commit) = r.head()?;
    if branch.as_deref() == expected
        && let Some(commit) = commit
    {
        return Ok(HistoryTip { branch, commit });
    }
    Err(IdeError::invalid("The current branch changed during rebase"))
}

pub(crate) fn checkout_rebase(
    r: &Repo,
    plan: &CheckoutRebasePlan,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<HistoryTip> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let branch = check_rev(&plan.branch)?;
    run(r.root(), &["check-ref-format", &format!("refs/heads/{branch}")], None)?;
    if plan.base.branch.as_deref() == Some(branch) {
        return Err(IdeError::invalid("check out another branch to rebase it onto the current branch"));
    }
    if r.operation()?.is_some() || !unmerged_paths(r)?.is_empty() {
        return Err(IdeError::invalid("finish the Git operation or resolve the conflicts before rebasing"));
    }
    if let Some(tree) = r.worktrees()?.into_iter().find(|tree| tree.branch.as_deref() == Some(branch) && !tree.prunable)
    {
        return Err(IdeError::invalid(format!("branch '{branch}' is checked out at {}", tree.path.0.display())));
    }

    check_checkout_rebase_refs(r, plan, branch)?;
    crate::preserve::around(r, "Local changes saved before rebase", || {
        check_checkout_rebase_refs(r, plan, branch)?;
        if let Some(remote) = &plan.remote
            && (plan.branch_tip.is_none() || remote.drop_local_commits)
        {
            let start = format!("refs/remotes/{}", remote.name);
            let create = if plan.branch_tip.is_some() { "-C" } else { "-c" };
            cli::run_streaming(r.root(), &["switch", create, branch, &start], cancel, out)?;
            cli::run_streaming(r.root(), &["rebase", &plan.base.commit], cancel, out)?;
        } else {
            cli::run_streaming(r.root(), &["rebase", &plan.base.commit, branch], cancel, out)?;
        }
        completed_rebase(r, Some(branch))
    })
}

fn check_checkout_rebase_refs(r: &Repo, plan: &CheckoutRebasePlan, branch: &str) -> IdeResult<()> {
    let repo = r.gix()?;
    let (head, oid) = crate::refs::head(&repo)?;
    let changed = || IdeError::invalid("a branch changed since checkout and rebase was requested; try again");
    if head != plan.base.branch || oid.as_deref() != Some(plan.base.commit.as_str()) {
        return Err(changed());
    }
    let mut local = repo.try_find_reference(format!("refs/heads/{branch}").as_str()).map_err(gx)?;
    let local_tip =
        local.as_mut().map(|reference| reference.peel_to_id().map(|id| id.to_string())).transpose().map_err(gx)?;
    if local_tip != plan.branch_tip {
        return Err(changed());
    }
    let Some(remote) = &plan.remote else {
        return local_tip.map(|_| ()).ok_or_else(changed);
    };
    let mut tracking =
        repo.try_find_reference(format!("refs/remotes/{}", remote.name).as_str()).map_err(gx)?.ok_or_else(changed)?;
    if gix::ObjectId::from_hex(remote.commit.as_bytes()).ok() != Some(tracking.peel_to_id().map_err(gx)?.detach()) {
        return Err(changed());
    }
    if let Some(local) = local
        && crate::refs::upstream_of(&repo, local.name()).is_some_and(|(upstream, _)| upstream != remote.name)
    {
        return Err(IdeError::invalid(format!("branch '{branch}' tracks a different remote branch")));
    }
    Ok(())
}

pub(crate) fn stash_push(
    r: &Repo,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
    paths: &[PathBuf],
) -> IdeResult<()> {
    let rel = r.rel_paths(paths)?;
    // Literal pathspecs only for the chosen files: git's whole-tree stash passes itself `:/`,
    // which a literal pathspec turns into a file of that name.
    let mut args = if rel.is_empty() { vec![] } else { vec!["--literal-pathspecs"] };
    args.extend(["stash", "push", "-q"]);
    if include_untracked {
        args.push("--include-untracked");
    }
    if keep_index {
        args.push("--keep-index");
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["-m", m]);
    }
    if !rel.is_empty() {
        args.push("--");
        args.extend(rel.iter().map(String::as_str));
    }
    run(r.root(), &args, None).map(|_| ())
}

pub(crate) fn stash_apply(
    r: &Repo,
    spec: &str,
    pop: bool,
    reinstate_index: bool,
) -> IdeResult<crate::StashApplyOutcome> {
    let mut args = vec!["stash", if pop { "pop" } else { "apply" }, "-q"];
    if reinstate_index {
        args.push("--index");
    }
    args.push(spec);
    crate::conflict_resolution::run_manual_unstash(r, &args)
}

pub(crate) fn stash_branch(r: &Repo, spec: &str, branch: &str) -> IdeResult<crate::StashApplyOutcome> {
    let branch = branch.trim();
    let valid = !branch.is_empty()
        && !branch.starts_with('-')
        && cli::run_raw(r.root(), &["check-ref-format", "--branch", branch], None)?.code == Some(0);
    if !valid {
        return Err(IdeError::invalid(format!("'{branch}' is not a valid branch name")));
    }
    crate::conflict_resolution::run_manual_unstash(r, &["stash", "branch", branch, spec])
}

pub(crate) fn stash_drop(r: &Repo, index: u32) -> IdeResult<()> {
    let spec = format!("stash@{{{index}}}");
    run(r.root(), &["stash", "drop", "-q", &spec], None).map(|_| ())
}

/// Linked worktrees have different indexes but share this stash reflog.
pub(crate) fn lock_stashes(r: &Repo) -> IdeResult<std::fs::File> {
    let [_, common_dir] = r.metadata_dirs()?;
    let lock = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(common_dir.join("openidea-stash.lock"))?;
    lock.lock()?;
    Ok(lock)
}

pub(crate) fn selected_stash_index(r: &Repo, selected: &crate::Stash) -> IdeResult<Option<u32>> {
    let entries = r.stashes()?;
    let mut matching = entries.iter().filter(|entry| entry.same_entry(selected)).map(|entry| entry.index);
    let index = matching.next();
    if matching.next().is_some() {
        return Err(IdeError::invalid("The selected stash is ambiguous because the stash list changed"));
    }
    Ok(index)
}

fn require_stash_index(r: &Repo, stash: &crate::Stash) -> IdeResult<u32> {
    selected_stash_index(r, stash)?.ok_or_else(|| IdeError::invalid("The selected stash is no longer available"))
}

pub(crate) fn drop_selected_stash(r: &Repo, stash: &crate::Stash) -> IdeResult<u32> {
    let _stash_lock = lock_stashes(r)?;
    let index = require_stash_index(r, stash)?;
    stash_drop(r, index)?;
    Ok(index)
}

pub(crate) fn drop_restored_stash(r: &Repo, stash: &crate::Stash) -> IdeResult<()> {
    let drop_entry = || {
        if let Some(index) = selected_stash_index(r, stash)? {
            stash_drop(r, index)?;
        }
        Ok::<_, IdeError>(())
    };
    drop_entry().map_err(|error| {
        IdeError::invalid(format!("Stash changes were restored, but the stash entry could not be dropped: {error}"))
    })
}

pub(crate) fn unstash_selected(
    r: &Repo,
    stash: &crate::Stash,
    pop: bool,
    reinstate_index: bool,
    branch: Option<&str>,
) -> IdeResult<crate::StashApplyResult> {
    let _stash_lock = lock_stashes(r)?;
    let index = require_stash_index(r, stash)?;
    // Git resolves an index again when a pop finishes. Use the saved commit for the
    // restore, then look up the entry again before removing it.
    let outcome = match branch {
        Some(name) => stash_branch(r, &stash.id, name),
        None => stash_apply(r, &stash.id, false, reinstate_index),
    }?;
    if outcome == crate::StashApplyOutcome::Done && (pop || branch.is_some()) {
        drop_restored_stash(r, stash)?;
    }
    Ok(crate::StashApplyResult { index, outcome })
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
    let reference = format!("refs/heads/{name}");
    let missing = format!("error: unable to delete '{reference}': remote ref does not exist");
    let result =
        cli::run_streaming(r.root(), &["push", "--progress", "--delete", "--", remote, &reference], cancel, on_output);
    match result {
        Err(error) if error.message.lines().any(|line| line == missing) => {
            // Another repository may have just deleted the branch from the same remote.
            cli::run_streaming(r.root(), &["remote", "prune", "--", remote], cancel, on_output)
        }
        result => result,
    }
}

pub(crate) fn push(
    r: &Repo,
    o: crate::PushOptions,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<PushReport> {
    let mut args: Vec<String> = vec!["push".into(), "--progress".into(), "--porcelain".into()];
    args.extend(force_args(o.force, o.force_with_lease, o.no_verify));
    if o.tags == Some(PushTags::CurrentBranch) {
        args.push("--follow-tags".into());
    }
    let remote = if o.set_upstream {
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
        args.extend(["--set-upstream".into(), remote.clone(), short]);
        Some(remote)
    } else if let Some((upstream_remote, target)) = renamed_upstream(r)? {
        args.extend([upstream_remote.clone(), format!("HEAD:{target}")]);
        Some(upstream_remote)
    } else if !o.force && !o.force_with_lease {
        push_remote(r).ok()
    } else {
        None
    };
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut report = PushReport::new(remote.clone().or_else(|| push_remote(r).ok()));
    if let Err(mut error) = push_report::run(&mut report, r.root(), &argv, cancel, on_output) {
        if !o.force
            && !o.force_with_lease
            && let Some(rejection) =
                remote.as_deref().and_then(|remote| tracked_push_rejection(r, remote, &error, cancel))
        {
            error.data = Some(rejection);
        }
        return Err(error);
    }
    push_all_tags(&mut report, r, o.tags, o.no_verify, cancel, on_output)?;
    Ok(report)
}

fn tracked_push_rejection(r: &Repo, remote: &str, error: &IdeError, cancel: &CancellationToken) -> Option<ErrorData> {
    let report = match &error.data {
        // A previous push URL may have accepted the branch itself. In that case the
        // result needs review instead of an automatic update and retry.
        Some(ErrorData::PushPartiallyApplied { report })
            if report
                .refs
                .iter()
                .all(|r| r.status == PushRefStatus::UpToDate || r.reference.starts_with("refs/tags/")) =>
        {
            Some(report)
        }
        None => None,
        _ => return None,
    };
    let mut rejected = error.message.lines().filter_map(|line| line.strip_prefix("!\t"));
    let (refs, reason) = rejected.next()?.split_once('\t')?;
    let known = reason == "[rejected] (non-fast-forward)";
    if (!known && reason != "[rejected] (fetch first)") || rejected.next().is_some() {
        return None;
    }
    let (source_ref, target_ref) = refs.split_once(':')?;
    let target = target_ref.strip_prefix("refs/heads/")?;
    let repo = r.gix().ok()?;
    let head = repo.head_name().ok()??;
    let head_ref = head.as_bstr().to_str_lossy();
    if source_ref != head_ref && source_ref != "HEAD" {
        return None;
    }
    let source = head.as_ref().shorten().to_str_lossy().into_owned();
    if branch_upstream(r, &source)? != (remote.to_owned(), target.to_owned()) {
        return None;
    }
    let tracking = crate::refs::upstream_of(&repo, head.as_ref());
    let divergence = tracking
        .as_ref()
        .filter(|_| known)
        .and_then(|(_, tip)| push_divergence(r, &repo, &source, remote, target, *tip, cancel))
        .map(Box::new);
    let upstream = tracking.map_or_else(|| format!("{remote}/{target}"), |(name, _)| name);
    Some(ErrorData::PushRejected { source, upstream, divergence, report: report.cloned() })
}

pub(crate) fn push_selected(
    r: &Repo,
    selection: &crate::PushSelection,
    inspected: Option<&crate::PushInspection>,
    options: crate::PushOptions,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<PushReport> {
    let (source_ref, target, tip) = selection.refs(r, cancel)?;
    let urls = crate::ops::remote_push_urls(r, &selection.remote, cancel)?;
    let mut args = vec!["push".to_string(), "--progress".into(), "--porcelain".into()];
    let mut pinned = false;
    if inspected.is_some_and(|review| review.local_tip != tip) {
        return Err(IdeError::invalid(
            "Push source or destination changed. Open Push again to review the current branches.",
        ));
    }
    let expected = if options.force_with_lease { inspected } else { None };
    if let Some(expected) = expected {
        if expected.state == crate::PushTargetState::FetchRequired {
            return Err(IdeError::invalid("Fetch the remote commits before force pushing."));
        }
        if let Some(remote_tip) = expected.remote_tip.as_ref() {
            if urls.len() != 1
                || (!remote_tip.is_empty()
                    && (remote_tip.len() != tip.len() || !remote_tip.bytes().all(|b| b.is_ascii_hexdigit())))
            {
                return Err(IdeError::invalid(
                    "Push source or destination changed. Open Push again to review the current branches.",
                ));
            }
            args.push(format!("--force-with-lease={target}:{remote_tip}"));
            pinned = true;
        }
    }
    if !pinned
        && !options.force
        && selection.branch.is_none()
        && inspected.is_some_and(|review| review.remote_checked && review.remote_tip.as_deref() == Some(""))
    {
        // This destination was shown as a new branch. Refuse a concurrent creation.
        args.push(format!("--force-with-lease={target}:"));
        pinned = true;
    }
    let force = options.force && !pinned;
    if options.force_with_lease && !pinned && !force {
        args.push(format!("--force-with-lease={target}"));
    }
    if options.no_verify {
        args.push("--no-verify".into());
    }
    let set_upstream =
        options.set_upstream && source_ref.is_some() && selection.revision.is_none() && !selection.special_ref;
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if let Some(tags) = options.tags {
        args.push(push_tags_arg(tags).into());
    }
    let source = if selection.revision.is_some() || (pinned && !set_upstream) {
        tip.as_str()
    } else {
        source_ref.as_deref().unwrap_or(&tip)
    };
    // Force applies to the selected destination only, even when tags travel with it.
    let prefix = if force { "+" } else { "" };
    args.extend(["--".into(), selection.remote.clone(), format!("{prefix}{source}:{target}")]);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut report = PushReport::new(Some(selection.remote.clone()));
    if let Err(mut error) = push_report::run(&mut report, r.root(), &argv, cancel, out) {
        if !options.force
            && !options.force_with_lease
            && selection.revision.is_none()
            && let Some(rejection) = tracked_push_rejection(r, &selection.remote, &error, cancel)
        {
            error.data = Some(rejection);
        }
        return Err(error);
    }
    Ok(report)
}

fn push_divergence(
    r: &Repo,
    repo: &gix::Repository,
    source: &str,
    remote: &str,
    target: &str,
    tip: gix::ObjectId,
    cancel: &CancellationToken,
) -> Option<PushDivergence> {
    if crate::ops::remote_push_urls(r, remote, cancel).ok()?.len() != 1 {
        return None;
    }
    let local_tip = repo.head_id().ok()?.to_string();
    let remote_tip = tip.to_string();
    let range = format!("{local_tip}...{remote_tip}");
    let counts = cli::run_cancellable(r.root(), &["rev-list", "--left-right", "--count", &range], cancel).ok()?;
    let counts = counts.stdout_str();
    let (local, incoming) = counts.trim().split_once('\t')?;
    let remote_commits: u32 = incoming.parse().ok()?;
    (local.parse::<u32>().ok()? > 0 && remote_commits > 0).then(|| PushDivergence {
        source: source.to_owned(),
        remote: remote.to_owned(),
        target: target.to_owned(),
        local_tip,
        remote_tip,
        remote_commits,
    })
}

pub(crate) fn force_push_rejected(
    r: &Repo,
    divergence: &PushDivergence,
    tags: Option<PushTags>,
    no_verify: bool,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<PushReport> {
    let PushDivergence { source, remote, target, local_tip, remote_tip, .. } = divergence;
    let (head, tip) = r.head()?;
    if head.as_ref() != Some(source)
        || tip.as_ref() != Some(local_tip)
        || branch_upstream(r, source).as_ref() != Some(&(remote.clone(), target.clone()))
        || crate::ops::remote_push_urls(r, remote, cancel)?.len() != 1
        || remote_tip.len() != local_tip.len()
        || !remote_tip.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(IdeError::invalid(
            "Push source or destination changed. Open Push again to review the current branches.",
        ));
    }
    let target = format!("refs/heads/{target}");
    let lease = format!("--force-with-lease={target}:{remote_tip}");
    let refspec = format!("{local_tip}:{target}");
    let mut args = vec!["push", "--progress", "--porcelain", &lease];
    if no_verify {
        args.push("--no-verify");
    }
    if let Some(tags) = tags {
        args.push(push_tags_arg(tags));
    }
    args.extend(["--", remote, &refspec]);
    let mut report = PushReport::new(Some(remote.clone()));
    push_report::run(&mut report, r.root(), &args, cancel, on_output)?;
    Ok(report)
}

fn push_tags_arg(tags: PushTags) -> &'static str {
    match tags {
        PushTags::All => "--tags",
        PushTags::CurrentBranch => "--follow-tags",
    }
}

fn push_all_tags(
    report: &mut PushReport,
    r: &Repo,
    tags: Option<PushTags>,
    no_verify: bool,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    if tags == Some(PushTags::All) {
        let remote = report
            .remote
            .clone()
            .map_or_else(|| push_remote(r), Ok)
            .map_err(|e| push_report::with_partial_push(e, report))?;
        let mut args = vec!["push", "--progress", "--porcelain"];
        if no_verify {
            args.push("--no-verify");
        }
        args.extend(["--tags", "--", remote.as_str()]);
        push_report::run(report, r.root(), &args, cancel, on_output)?;
    }
    Ok(())
}

/// `--force` / `--force-with-lease` and `--no-verify` of a push.
fn force_args(force: bool, force_with_lease: bool, no_verify: bool) -> Vec<String> {
    let mut args = Vec::new();
    if force {
        args.push("--force".into());
    } else if force_with_lease {
        args.push("--force-with-lease".into());
    }
    if no_verify {
        args.push("--no-verify".into());
    }
    args
}

pub(crate) fn has_hook(r: &Repo, name: &str) -> IdeResult<bool> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(IdeError::invalid(format!("invalid hook name '{name}'")));
    }
    let path = run(r.root(), &["rev-parse", "--git-path", &format!("hooks/{name}")], None)?.stdout_str();
    let path = r.root().join(path.trim());
    let Ok(meta) = std::fs::metadata(&path) else { return Ok(false) };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    Ok(meta.is_file())
}

/// Remote and branch name a local branch pulls from (`branch.<b>.remote` / `.merge`).
pub(crate) fn branch_upstream(r: &Repo, branch: &str) -> Option<(String, String)> {
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

pub(crate) fn require_checked_out_branch(root: &Path, branch: &str, cancel: &CancellationToken) -> IdeResult<()> {
    let actual = cli::run_cancellable_raw(root, &["symbolic-ref", "-q", "HEAD"], cancel)?;
    if actual.stdout_str().trim().strip_prefix("refs/heads/") == Some(branch) {
        return Ok(());
    }
    Err(IdeError::invalid(format!("Branch '{branch}' is no longer checked out")))
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
) -> IdeResult<PushReport> {
    let PushBranchOptions {
        revision,
        target,
        remote: remote_override,
        force_with_lease,
        force,
        set_upstream,
        no_verify,
    } = opts;
    check_local_branch(r, branch)?;
    let remote_override = remote_override.map(str::trim).filter(|s| !s.is_empty());
    let (remote, mut name, untracked) = match (remote_override, branch_upstream(r, branch)) {
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
    let mut args: Vec<String> = vec!["push".into(), "--progress".into(), "--porcelain".into()];
    args.extend(force_args(force, force_with_lease, no_verify));
    if untracked || (set_upstream && revision.is_none()) {
        args.push("--set-upstream".into());
    }
    let mut report = PushReport::new(Some(remote.clone()));
    args.extend(["--".into(), remote, format!("{source}:refs/heads/{target}")]);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    push_report::run(&mut report, r.root(), &argv, cancel, on_output)?;
    Ok(report)
}

/// Fetches each remote once, then fast-forwards ref-only branches and checked-out worktrees.
pub(crate) fn update_branches(
    r: &Repo,
    branches: &[String],
    tags: FetchTagsMode,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<Vec<BranchUpdate>> {
    let mut fetched: Vec<(String, Result<(), String>)> = Vec::new();
    let mut out = Vec::with_capacity(branches.len());
    for branch in branches {
        check_local_branch(r, branch)?;
        let result = |status, message, worktree| BranchUpdate { branch: branch.clone(), status, message, worktree };
        let Some((remote, _)) = branch_upstream(r, branch) else {
            out.push(result(BranchUpdateStatus::NoUpstream, None, None));
            continue;
        };
        let fetch = match fetched.iter().find(|(name, _)| *name == remote) {
            Some((_, done)) => done.clone(),
            None => {
                let done = match fetch_for_update(r, &remote, tags, cancel, on_output) {
                    Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                    done => done.map_err(|e| e.message),
                };
                fetched.push((remote, done.clone()));
                done
            }
        };
        let (status, message, worktree) = match fetch {
            Err(message) => (BranchUpdateStatus::Failed, Some(message), None),
            Ok(()) => match fast_forward(r, branch, cancel, on_output) {
                Ok(result) => result,
                Err(error) if error.kind == ErrorKind::Cancelled => return Err(error),
                Err(error) => (BranchUpdateStatus::Failed, Some(error.message), None),
            },
        };
        out.push(result(status, message, worktree));
    }
    Ok(out)
}

fn fast_forward(
    r: &Repo,
    branch: &str,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<(BranchUpdateStatus, Option<String>, Option<IpcPath>)> {
    let rev = |args: &[&str]| run(r.root(), args, None).ok().map(|o| o.stdout_str().trim().to_string());
    let ancestor = |a: &str, b: &str| {
        cli::run_raw(r.root(), &["merge-base", "--is-ancestor", a, b], None).is_ok_and(|o| o.code == Some(0))
    };
    let local = format!("refs/heads/{branch}");
    let tracked =
        rev(&["rev-parse", "--symbolic-full-name", &format!("{branch}@{{upstream}}")]).filter(|t| !t.is_empty());
    let target = tracked.as_deref().and_then(|t| rev(&["rev-parse", "-q", "--verify", &format!("{t}^{{commit}}")]));
    let (Some(tracked), Some(target), Some(tip)) = (tracked, target, rev(&["rev-parse", "-q", "--verify", &local]))
    else {
        return Ok((BranchUpdateStatus::Failed, Some(format!("the tracked branch of '{branch}' was not found")), None));
    };
    if tip == target || ancestor(&target, &tip) {
        return Ok((BranchUpdateStatus::UpToDate, None, None));
    }
    if !ancestor(&tip, &target) {
        return Ok((BranchUpdateStatus::NotFastForward, None, None));
    }

    let mut holders = r.worktrees()?.into_iter().filter(|worktree| worktree.branch.as_deref() == Some(branch));
    let holder = holders.next();
    if holders.next().is_some() {
        return Err(IdeError::invalid(format!("Branch '{branch}' is checked out in more than one worktree")));
    }
    let mut linked = None;
    if let Some(worktree) = holder.as_ref().filter(|worktree| worktree.prunable) {
        return Err(IdeError::invalid(format!(
            "Branch '{branch}' is checked out in a missing worktree at '{}'. Prune the worktree first.",
            worktree.path.0.display()
        )));
    }
    let updated = if let Some(worktree) = holder {
        let path = &worktree.path.0;
        let canonical = dunce::canonicalize(path)?;
        if canonical != dunce::canonicalize(r.root())? {
            let tree = gix::discover(path).map_err(gx)?;
            if tree.workdir().and_then(|root| dunce::canonicalize(root).ok()).as_deref() != Some(&canonical)
                || dunce::canonicalize(tree.common_dir())? != dunce::canonicalize(r.gix()?.common_dir())?
            {
                return Err(IdeError::invalid(format!(
                    "The worktree at '{}' no longer belongs to this repository",
                    path.display()
                )));
            }
            linked = Some(worktree.path.clone());
        }
        require_checked_out_branch(path, branch, cancel)
            .and_then(|()| cli::run_streaming(path, &["merge", "--ff-only", &target], cancel, on_output))
    } else {
        let refspec = format!("{tracked}:{local}");
        cli::run_streaming(r.root(), &["fetch", ".", &refspec], cancel, on_output)
    };
    match updated {
        Ok(()) => Ok((BranchUpdateStatus::Updated, None, linked)),
        Err(e) if e.kind == ErrorKind::Cancelled => Err(e),
        Err(e) => Ok((BranchUpdateStatus::Failed, Some(e.message), linked)),
    }
}

/// Update Project › Reset to the Remote Branch: fetches the current branch's tracked
/// branch and moves the branch to it, dropping local commits. Local changes are put
/// aside and brought back (an error with the conflicts left in place when they clash).
pub(crate) fn reset_to_upstream(
    r: &Repo,
    tags: FetchTagsMode,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let head = run(r.root(), &["symbolic-ref", "-q", "--short", "HEAD"], None)
        .map_err(|_| IdeError::invalid("cannot reset: HEAD is detached"))?
        .stdout_str();
    let head = head.trim();
    let no_tracked =
        || IdeError::invalid(format!("no tracked branch configured for branch {head} or the branch doesn't exist"));
    let (remote, name) = branch_upstream(r, head).ok_or_else(no_tracked)?;
    fetch_for_update(r, &remote, tags, cancel, on_output)?;
    let tracked = format!("refs/remotes/{remote}/{name}");
    if run(r.root(), &["rev-parse", "-q", "--verify", &format!("{tracked}^{{commit}}")], None).is_err() {
        return Err(no_tracked());
    }
    crate::preserve::around(r, "Local changes saved before reset", || {
        run(r.root(), &["reset", "-q", "--keep", &tracked], None).map(|_| ())
    })
}

fn fetch_for_update(
    r: &Repo,
    remote: &str,
    tags: FetchTagsMode,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let mut args = vec!["fetch", "--progress"];
    args.extend(crate::remotes::fetch_tag_args(tags, false));
    args.extend(["--", remote]);
    cli::run_streaming(r.root(), &args, cancel, on_output)
}

/// The remote the current branch pushes to (`origin`, or the only remote, by default).
/// The remote and ref HEAD's branch tracks when the ref has another name: a plain
/// `git push` refuses that under the default `push.default=simple`.
fn renamed_upstream(r: &Repo) -> IdeResult<Option<(String, String)>> {
    let repo = r.gix()?;
    let Some(head) = repo.head_name().map_err(gx)? else { return Ok(None) };
    let direction = gix::remote::Direction::Fetch;
    let Some(Ok(merge)) = repo.branch_remote_ref_name(head.as_ref(), direction) else { return Ok(None) };
    if merge.as_ref() == head.as_ref() {
        return Ok(None);
    }
    let target = merge.as_bstr().to_str_lossy().into_owned();
    let short = head.as_ref().shorten().to_str_lossy().into_owned();
    Ok(repo
        .branch_remote_name(short.as_str(), direction)
        .map(|remote| (remote.as_bstr().to_str_lossy().into_owned(), target)))
}

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

pub(crate) fn write_index_blob(
    r: &Repo,
    rel: &str,
    bytes: &[u8],
    env: &[(&str, &std::ffi::OsStr)],
) -> IdeResult<String> {
    let entry =
        cli::run_env(r.root(), &["--literal-pathspecs", "ls-files", "--stage", "--", rel], None, env)?.stdout_str();
    let mode = entry.split_whitespace().next().unwrap_or("100644");
    let id = run(r.root(), &["hash-object", "-w", "--stdin"], Some(bytes))?.stdout_str();
    cli::run_env(r.root(), &["update-index", "--add", "--cacheinfo", mode, id.trim(), rel], None, env)?;
    Ok(id.trim().to_owned())
}

pub(crate) fn stage_hunks(
    r: &Repo,
    path: &Path,
    current: &str,
    selected: &[usize],
    encoding: TextEncoding,
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
    write_index_blob(r, &rel, &bytes, &[]).map(|_| ())
}

// Git headers contain UTF-8 paths; only source lines use the file's encoding.
fn decode_diff(bytes: &[u8], encoding: TextEncoding) -> String {
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
            text.push_str(&crate::text_encoding::decode_raw(line, encoding));
        } else {
            text.push_str(&String::from_utf8_lossy(line));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{append_revision, branch_of_other_worktree};

    #[test]
    fn the_worktree_holding_a_branch_is_read_from_each_git_wording() {
        let held = |b: &str, p: &str| Some((b.to_string(), p.to_string()));
        assert_eq!(
            branch_of_other_worktree("fatal: 'topic' is already used by worktree at '/w/t'\n"),
            held("topic", "/w/t")
        );
        assert_eq!(
            branch_of_other_worktree("fatal: cannot force update the branch 'topic' used by worktree at '/w/t'"),
            held("topic", "/w/t")
        );
        assert_eq!(branch_of_other_worktree("fatal: 'a/b' is already checked out at '/w/t'"), held("a/b", "/w/t"));
        assert_eq!(branch_of_other_worktree("fatal: invalid reference: x"), None);
    }

    #[test]
    fn a_revision_is_appended_once_keeping_the_list() {
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        assert_eq!(append_revision("", &b), format!("{b}\n"));
        assert_eq!(append_revision(&format!("{a}\n# comment\n"), &b), format!("{a}\n# comment\n{b}\n"));
        assert_eq!(append_revision(&a, &b), format!("{a}\n{b}\n"));
        let listed = format!("# reformat\n  {b}  \n{a}\n");
        assert_eq!(append_revision(&listed, &b), listed);
        assert_eq!(append_revision(&format!("{a}\r\n"), &b), format!("{a}\r\n{b}\r\n"));
    }
}
