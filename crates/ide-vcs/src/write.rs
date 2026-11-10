//! Operations delegated to the git CLI (all writes, plus blame and textual diffs).

use crate::TextEncoding;
use crate::cli::{self, run};
use crate::repo::{gx, resolve};
use crate::text_encoding::{decode, encode, has_bom, is_binary};
use crate::{
    BlameLine, CheckoutMode, CheckoutOptions, CheckoutOutcome, CommitOptions, DeletedBranch, DivergedLocal,
    PushBranchOptions, Repo,
};
use gix::bstr::{BStr, ByteSlice};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::{Path, PathBuf};

const UNCOMMITTED_AUTHOR: &str = "Not Committed Yet";

impl Repo {
    pub(crate) fn rel_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<String>> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
        paths
            .iter()
            .map(|p| {
                let rel = self.rel_path(p)?;
                Ok(if rel.is_empty() { ".".to_string() } else { rel })
            })
            .collect()
    }

    pub(crate) fn has_head(&self) -> IdeResult<bool> {
        let _scope = crate::ExecutionScope::enter(self.execution_allowed.load(std::sync::atomic::Ordering::Acquire));
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

pub(crate) fn blame(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    revision: Option<&str>,
    encoding: TextEncoding,
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
    if encoding.has_ascii_conversion() {
        return converted_blame(r, path, &rel, &text, revision, encoding);
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
    let contents_args = ["--literal-pathspecs", "blame", "--porcelain", "--contents", "-", revision, "--", &rel];
    let plain_args: &[&str] = if crate::execution_allowed() {
        &["--literal-pathspecs", "blame", "--porcelain", revision, "--", &rel]
    } else {
        &["--literal-pathspecs", "blame", "--no-textconv", "--porcelain", revision, "--", &rel]
    };
    let (out, contents_blame) = if crate::execution_allowed() {
        let out = cli::run_raw(r.root(), &contents_args, Some(&contents))?;
        if out.code == Some(0) {
            (out, true)
        } else if String::from_utf8_lossy(&out.stderr).contains("cannot use --contents") {
            (run(r.root(), plain_args, None)?, false)
        } else {
            return Err(cli::failure(&contents_args, &out.stderr, &out.stdout, out.code));
        }
    } else {
        (run(r.root(), plain_args, None)?, false)
    };
    let mut lines = crate::blame::parse_porcelain(&out.stdout_str());
    for line in &mut lines {
        if line.commit.bytes().all(|b| b == b'0') {
            line.author = UNCOMMITTED_AUTHOR.to_string();
            line.summary = String::new();
        }
    }
    if !contents_blame {
        let base = r.file_at(path, Some(revision), encoding)?.unwrap_or_default();
        for hunk in crate::diff::line_hunks(&base, &text).into_iter().rev() {
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

fn converted_blame(
    r: &Repo,
    path: &Path,
    rel: &str,
    text: &str,
    revision: &str,
    encoding: TextEncoding,
) -> IdeResult<Vec<BlameLine>> {
    let current = crate::diff::normalize_eol(text);
    let mut result = uncommitted_lines(current.split_inclusive('\n').count());
    let Some(base) = r.file_bytes_at(path, Some(revision))? else { return Ok(result) };
    let args: &[&str] = if crate::execution_allowed() {
        &["--literal-pathspecs", "blame", "--porcelain", revision, "--", rel]
    } else {
        &["--literal-pathspecs", "blame", "--no-textconv", "--porcelain", revision, "--", rel]
    };
    let out = run(r.root(), args, None)?;
    let physical = crate::blame::parse_porcelain(&out.stdout_str());
    let raw = crate::text_encoding::decode_raw(&base, encoding);
    let raw = crate::diff::normalize_eol(&raw);
    let mut logical = Vec::new();
    for (line, metadata) in raw.split_inclusive('\n').zip(physical) {
        let displayed = encoding.display_text(line);
        let displayed = crate::diff::normalize_eol(&displayed);
        logical.extend(std::iter::repeat_n(metadata, displayed.split_inclusive('\n').count()));
    }
    let base = decode(&base, encoding);
    let hunks = crate::diff::line_hunks(&base, &current);
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
    encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
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
        cli::run_paths_env(r.root(), args, &exclude, None, &env)?;
    }
    let mut rels = rel_paths(&options.stage)?;
    cli::run_paths_env(r.root(), &["--literal-pathspecs", "add", "-A", "--"], &rels, None, &env)?;
    for file in &options.partial {
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
    Ok(rels)
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
    listed_files(stderr, "local changes to the following files would be overwritten")
}

/// Untracked files git refuses to overwrite, from its error message.
fn overwritten_untracked(stderr: &str) -> Option<Vec<String>> {
    listed_files(stderr, "untracked working tree files would be")
}

fn listed_files(stderr: &str, header: &str) -> Option<Vec<String>> {
    let mut lines = stderr.lines().skip_while(|l| !l.contains(header));
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
    let stderr = String::from_utf8_lossy(&out.stderr);
    if let Some(files) = overwritten_untracked(&stderr) {
        return Ok(CheckoutOutcome::UntrackedFiles { files });
    }
    let Some(files) = overwritten_files(&stderr) else {
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
    // Staged changes come back staged; when the index can't be restored as it was (it
    // conflicts with the new branch), the changes come back unstaged.
    let pop = cli::run_raw(r.root(), &["stash", "pop", "-q", "--index"], None)?;
    if pop.code == Some(0) {
        return Ok(CheckoutOutcome::Done);
    }
    let pop = if unmerged_paths(r)?.is_empty() && stash_count(r)? > before {
        cli::run_raw(r.root(), &["stash", "pop", "-q"], None)?
    } else {
        pop
    };
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
pub(crate) fn create_branch(
    r: &Repo,
    name: &str,
    start: Option<&str>,
    checkout: bool,
    overwrite: bool,
) -> IdeResult<()> {
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
    let mut args = match (checkout, overwrite) {
        (true, false) => vec!["switch", "-c", name],
        (true, true) => vec!["switch", "-C", name],
        (false, false) => vec!["branch", "--", name],
        (false, true) => vec!["branch", "--force", "--", name],
    };
    args.extend(start);
    run(r.root(), &args, None).map(|_| ())
}

/// Undo Commit: moves the current branch back to the parent of `commit` (which must be
/// HEAD), keeping its changes staged. Returns the undone commit's message.
/// Edit Commit Message: writes `commit` again with `message`, and its descendants on top
/// of it with their own trees, then moves HEAD to the new tip. Trees don't change, so the
/// index and the working tree stay as they are (local changes included). Returns HEAD
/// before and after, for [`restore_head`].
pub(crate) fn reword(r: &Repo, commit: &str, message: &str) -> IdeResult<(String, String)> {
    if r.branch_info()?.operation.is_some() {
        return Err(IdeError::invalid(
            "cannot edit a commit message while a merge, rebase or cherry-pick is in progress",
        ));
    }
    let message = message.trim();
    if message.is_empty() {
        return Err(IdeError::invalid("commit message is empty"));
    }
    let (target, head) = {
        let repo = r.gix()?;
        let head = repo.head_id().map_err(|_| IdeError::invalid("there is no commit to edit"))?.detach();
        let target = repo.find_object(resolve(&repo, commit)?).map_err(gx)?.peel_to_commit().map_err(gx)?.id;
        (target.to_string(), head.to_string())
    };
    if cli::run_raw(r.root(), &["merge-base", "--is-ancestor", &target, &head], None)?.code != Some(0) {
        return Err(IdeError::invalid("the commit is not in the current branch"));
    }
    // target..HEAD must be a straight line on top of the target.
    let range = format!("{target}..{head}");
    let listed = run(r.root(), &["rev-list", "--reverse", "--topo-order", "--parents", &range], None)?.stdout_str();
    let mut chain = vec![target.clone()];
    for line in listed.lines() {
        let ids: Vec<&str> = line.split_whitespace().collect();
        if ids.len() != 2 || ids[1] != chain.last().unwrap() {
            return Err(IdeError::invalid("the commits after this one are not a linear history"));
        }
        chain.push(ids[0].to_string());
    }
    let mut parent: Option<String> = None;
    for (i, id) in chain.iter().enumerate() {
        let raw = run(r.root(), &["cat-file", "commit", id], None)?.stdout;
        let text = String::from_utf8_lossy(&raw);
        let (headers, body) = text.split_once("\n\n").unwrap_or((&text, ""));
        let mut tree = "";
        let mut parents = Vec::new();
        let mut author = "";
        for line in headers.lines() {
            if let Some(v) = line.strip_prefix("tree ") {
                tree = v;
            } else if let Some(v) = line.strip_prefix("parent ") {
                parents.push(v.to_string());
            } else if let Some(v) = line.strip_prefix("author ") {
                author = v;
            }
        }
        if parents.len() > 1 {
            return Err(IdeError::invalid("merge commits cannot be reworded"));
        }
        if let Some(p) = &parent {
            parents = vec![p.clone()];
        }
        let (name, rest) = author.split_once(" <").unwrap_or((author, ""));
        let (email, date) = rest.split_once("> ").unwrap_or((rest, ""));
        let env = [
            ("GIT_AUTHOR_NAME", std::ffi::OsStr::new(name)),
            ("GIT_AUTHOR_EMAIL", std::ffi::OsStr::new(email)),
            ("GIT_AUTHOR_DATE", std::ffi::OsStr::new(date)),
        ];
        let mut args = vec!["commit-tree", tree];
        for p in &parents {
            args.extend(["-p", p.as_str()]);
        }
        let new_message = if i == 0 { format!("{message}\n") } else { body.to_string() };
        let created = cli::run_env(r.root(), &args, Some(new_message.as_bytes()), &env)?.stdout_str();
        parent = Some(created.trim().to_string());
    }
    let new_head = parent.expect("the chain holds the target");
    let reason = format!("reword: {}", message.lines().next().unwrap_or_default());
    run(r.root(), &["update-ref", "-m", &reason, "HEAD", &new_head, &head], None)?;
    Ok((head, new_head))
}

/// Undo of a history rewrite: moves HEAD from `after` back to `before`, keeping local
/// changes (`git reset --keep`). Refused when HEAD has moved since.
pub(crate) fn restore_head(r: &Repo, before: &str, after: &str) -> IdeResult<()> {
    if r.branch_info()?.operation.is_some() {
        return Err(IdeError::invalid("cannot undo while a merge, rebase or cherry-pick is in progress"));
    }
    let head = run(r.root(), &["rev-parse", "--verify", "HEAD"], None)?.stdout_str();
    if head.trim() != after {
        return Err(IdeError::invalid("the branch has changed since; undo is no longer possible"));
    }
    let before = check_rev(before)?;
    let tree = |rev: &str| run(r.root(), &["rev-parse", &format!("{rev}^{{tree}}")], None).map(|o| o.stdout_str());
    if tree(before)? == tree(after)? {
        run(r.root(), &["update-ref", "-m", "undo", "HEAD", before, after], None)?;
    } else {
        run(r.root(), &["reset", "-q", "--keep", before, "--"], None)?;
    }
    Ok(())
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

/// The short name (`origin/main`) of the branch a local branch tracks, as the branch list shows it.
fn upstream_name(r: &Repo, branch: &str) -> IdeResult<Option<String>> {
    let out = run(r.root(), &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{branch}")], None)?;
    let upstream = out.stdout_str().trim().to_string();
    Ok((!upstream.is_empty()).then_some(upstream))
}

pub(crate) fn delete_branch_restorable(r: &Repo, branch: &str) -> IdeResult<DeletedBranch> {
    check_local_branch(r, branch)?;
    let tip = run(r.root(), &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}^{{commit}}")], None)?
        .stdout_str()
        .trim()
        .to_string();
    let upstream = upstream_name(r, branch)?;
    let out = cli::run_raw(r.root(), &["branch", "-d", "--", branch], None)?;
    let unmerged = match out.code {
        Some(0) => false,
        _ if String::from_utf8_lossy(&out.stderr).contains("not fully merged") => {
            run(r.root(), &["branch", "-D", "--", branch], None)?;
            true
        }
        code => return Err(cli::failure(&["branch"], &out.stderr, &out.stdout, code)),
    };
    Ok(DeletedBranch { name: branch.to_string(), tip, upstream, unmerged })
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

/// `unset_upstream` drops the tracking that `git branch -m` moves to the new name.
pub(crate) fn rename_branch(r: &Repo, from: &str, to: &str, unset_upstream: bool) -> IdeResult<()> {
    let to = to.trim();
    if to.is_empty() {
        return Err(IdeError::invalid("branch name is empty"));
    }
    let has_upstream = unset_upstream && upstream_name(r, from)?.is_some();
    run(r.root(), &["branch", "-m", "--", from, to], None)?;
    if has_upstream {
        run(r.root(), &["branch", "--unset-upstream", "--", to], None).map_err(|mut error| {
            error.message =
                format!("Renamed branch '{from}' to '{to}', but could not unset its upstream: {}", error.message);
            error
        })?;
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

/// Local changes are stashed and restored around the merge (IDEA's "save local changes").
pub(crate) fn merge(r: &Repo, branch: &str) -> IdeResult<()> {
    let branch = check_rev(branch)?;
    crate::preserve::around(r, "Local changes saved before merge", || {
        run(r.root(), &["merge", "--no-edit", branch], None).map(|_| ())
    })
}

pub(crate) fn rebase(r: &Repo, onto: &str) -> IdeResult<()> {
    let onto = check_rev(onto)?;
    crate::preserve::around(r, "Local changes saved before rebase", || {
        run(r.root(), &["rebase", onto], None).map(|_| ())
    })
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
    o: crate::PushOptions,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<()> {
    let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
    args.extend(force_args(o.force, o.force_with_lease, o.no_verify));
    if o.tags == Some(crate::PushTags::CurrentBranch) {
        args.push("--follow-tags".into());
    }
    if o.set_upstream {
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
    } else if let Some((remote, target)) = renamed_upstream(r)? {
        args.extend([remote, format!("HEAD:{target}")]);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_streaming(r.root(), &argv, cancel, on_output)?;
    if o.tags == Some(crate::PushTags::All) {
        // `git push --tags` alone pushes only tags, so it runs after the branch push.
        let remote = push_remote(r)?;
        let mut args = vec!["push", "--progress"];
        if o.no_verify {
            args.push("--no-verify");
        }
        args.extend([remote.as_str(), "--tags"]);
        cli::run_streaming(r.root(), &args, cancel, on_output)?;
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
    let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
    args.extend(force_args(force, force_with_lease, no_verify));
    if untracked || (set_upstream && revision.is_none()) {
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

/// Update Project › Reset to the Remote Branch: fetches the current branch's tracked
/// branch and moves the branch to it, dropping local commits. Local changes are put
/// aside and brought back (an error with the conflicts left in place when they clash).
pub(crate) fn reset_to_upstream(r: &Repo, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
    let head = run(r.root(), &["symbolic-ref", "-q", "--short", "HEAD"], None)
        .map_err(|_| IdeError::invalid("cannot reset: HEAD is detached"))?
        .stdout_str();
    let head = head.trim();
    let no_tracked =
        || IdeError::invalid(format!("no tracked branch configured for branch {head} or the branch doesn't exist"));
    let (remote, name) = branch_upstream(r, head).ok_or_else(no_tracked)?;
    cli::run_streaming(r.root(), &["fetch", "--progress", &remote], cancel, on_output)?;
    let tracked = format!("refs/remotes/{remote}/{name}");
    if run(r.root(), &["rev-parse", "-q", "--verify", &format!("{tracked}^{{commit}}")], None).is_err() {
        return Err(no_tracked());
    }
    crate::preserve::around(r, "Local changes saved before reset", || {
        run(r.root(), &["reset", "-q", "--keep", &tracked], None).map(|_| ())
    })
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

pub(crate) fn write_index_blob(r: &Repo, rel: &str, bytes: &[u8], env: &[(&str, &std::ffi::OsStr)]) -> IdeResult<()> {
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
    write_index_blob(r, &rel, &bytes, &[])
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
