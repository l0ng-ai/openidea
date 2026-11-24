//! Unified-diff patches: creating them from local changes or commits, previewing
//! and applying them (falling back to a 3-way merge that leaves conflicts for the
//! merge UI), as Create Patch / Apply Patch / Shelve do in IDEA.

use crate::cli::{self, TempIndex, run, run_env};
use crate::repo::gx;
use crate::{ApplyOutcome, ChangeKind, ChangedFile, PatchFile, Repo, Repos, StagingPatchEntry, StagingPatchSide};
use ide_core::{IdeError, IdeResult};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

pub(crate) mod file_diff;
mod mapping;
pub use mapping::{
    MappedPatch, PatchDirectoryMatches, PatchDirectoryScope, PatchPathMapping, PatchPlacement,
    discover_patch_directories,
};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Binary-safe patch of the working-tree changes (staged or not, untracked files
/// included) of `rel_paths` against HEAD, plus the files it touches (renames split
/// into delete + add). The real index is left untouched.
pub(crate) fn working_patch(
    r: &Repo,
    rel_paths: &[String],
    reverse: bool,
    detect_renames: bool,
) -> IdeResult<(String, Vec<ChangedFile>)> {
    working_patch_with_prefix(r, rel_paths, reverse, detect_renames, None)
}

pub(crate) fn working_patch_with_prefix(
    r: &Repo,
    rel_paths: &[String],
    reverse: bool,
    detect_renames: bool,
    prefix: Option<&str>,
) -> IdeResult<(String, Vec<ChangedFile>)> {
    if rel_paths.is_empty() {
        return Err(IdeError::invalid("no files selected"));
    }
    let tmp = TempIndex::new(r);
    let env = tmp.env();
    if r.has_head()? {
        run_env(r.root(), &["read-tree", "HEAD"], None, &env)?;
    } else {
        run_env(r.root(), &["read-tree", "--empty"], None, &env)?;
    }
    cli::run_paths_env(r.root(), &["--literal-pathspecs", "add", "-A", "--"], rel_paths, None, &env)?;
    let mut diff = vec![
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        if detect_renames { "-M" } else { "--no-renames" },
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if reverse {
        diff.push("-R");
    }
    let prefixes = prefix.map(|prefix| [format!("--src-prefix=a/{prefix}"), format!("--dst-prefix=b/{prefix}")]);
    if let Some(prefixes) = &prefixes {
        diff.extend(prefixes.iter().map(String::as_str));
    }
    let patch = lossless_diff(r, &diff, &env)?;
    let names = run_env(r.root(), &["diff", "--cached", "--name-status", "-z", "--no-renames"], None, &env)?;
    Ok((patch, crate::ops::parse_name_status(&names.stdout_str())))
}

pub(crate) fn staging_patch(r: &Repo, entries: &[StagingPatchEntry], reverse: bool, prefix: &str) -> IdeResult<String> {
    use StagingPatchSide::{Both, Staged, Unstaged};
    let mut selected = BTreeMap::new();
    for entry in entries {
        let path = r.given_rel_path(&entry.path.0)?;
        let old = entry.renamed_from.as_ref().map(|old| r.given_rel_path(&old.0)).transpose()?;
        if path.is_empty() || old.as_deref() == Some("") {
            return Err(IdeError::invalid("no files selected"));
        }
        let (side, names) = selected.entry(path.clone()).or_insert_with(|| (entry.side, BTreeSet::new()));
        if *side != entry.side {
            *side = Both;
        }
        names.extend(old.into_iter().chain([path]));
    }
    if selected.is_empty() {
        return Err(IdeError::invalid("no files selected"));
    }

    let repo = r.gix()?;
    let head = r.head()?.1.unwrap_or_else(|| repo.object_hash().empty_tree().to_string());
    let index = TempIndex::new(r);
    let env = index.env();
    match std::fs::copy(repo.index_path(), index.path()) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            run_env(r.root(), &["read-tree", "--empty"], None, &env)?;
        }
        Err(error) => return Err(error.into()),
    }

    // An intent-to-add entry lets Git diff an untracked file against an absent index
    // version, without staging its content or changing the user's index.
    let worktree: BTreeSet<_> =
        selected.values().filter(|(side, _)| *side != Staged).flat_map(|(_, names)| names).collect();
    if !worktree.is_empty() {
        let tracked = run_env(r.root(), &["ls-files", "--cached", "-z"], None, &env)?.stdout;
        let tracked: HashSet<_> = tracked.split(|byte| *byte == 0).collect();
        let untracked: Vec<_> = worktree
            .into_iter()
            .filter(|path| !tracked.contains(path.as_bytes()) && r.root().join(path).symlink_metadata().is_ok())
            .cloned()
            .collect();
        if !untracked.is_empty() {
            cli::run_paths_env(
                r.root(),
                &["--literal-pathspecs", "add", "--intent-to-add", "--"],
                &untracked,
                None,
                &env,
            )?;
        }
    }

    // Git swaps custom prefixes along with the endpoints under -R.
    let (a, b) = if reverse { ("b", "a") } else { ("a", "b") };
    let src = format!("--src-prefix={a}/{prefix}");
    let dst = format!("--dst-prefix={b}/{prefix}");
    let mut options = vec![
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--full-index",
        "-M",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--ita-invisible-in-index",
        &src,
        &dst,
    ];
    if reverse {
        options.push("-R");
    }
    let mut patch = String::new();
    let sides = if reverse { [Both, Unstaged, Staged] } else { [Staged, Unstaged, Both] };
    for side in sides {
        let paths: Vec<_> = selected
            .values()
            .filter(|(selected, _)| *selected == side)
            .flat_map(|(_, names)| names.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if paths.is_empty() {
            continue;
        }
        let mut args = options.clone();
        if side == Staged {
            args.push("--cached");
        }
        if side != Unstaged {
            args.push(&head);
        }
        args.push("--");
        patch.push_str(&selected_diff(r, args, &paths, prefix, &env)?);
    }
    Ok(patch)
}

/// The changes of `commits` (oldest first), each against its first parent.
pub(crate) fn commits_patch(r: &Repo, commits: &[String], reverse: bool) -> IdeResult<String> {
    if commits.is_empty() {
        return Err(IdeError::invalid("no commits selected"));
    }
    let mut out = String::new();
    let ordered: Vec<&String> = if reverse { commits.iter().rev().collect() } else { commits.iter().collect() };
    for c in ordered {
        let (parent, id) = {
            let repo = r.gix()?;
            let id = crate::repo::resolve(&repo, c)?;
            let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
            let parent = commit.parent_ids().next().map(|p| p.detach().to_string());
            (parent.unwrap_or_else(|| EMPTY_TREE.to_string()), id.to_string())
        };
        let mut args = vec!["diff", "--binary", "--full-index", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];
        if reverse {
            args.push("-R");
        }
        args.extend([parent.as_str(), id.as_str(), "--"]);
        out.push_str(&lossless_diff(r, &args, &[])?);
    }
    Ok(out)
}

/// An automatic Shelf snapshot follows the same per-path layout as a manually created shelf.
pub(crate) fn shelf_tree_patch_with_prefix(r: &Repo, base: &str, tree: &str, prefix: &str) -> IdeResult<String> {
    lossless_diff(
        r,
        &[
            "diff",
            "--binary",
            "--full-index",
            "--no-renames",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            &format!("--src-prefix=a/{prefix}"),
            &format!("--dst-prefix=b/{prefix}"),
            base,
            tree,
            "--",
        ],
        &[],
    )
}

pub(crate) fn revisions_patch(r: &Repo, before: &str, after: &str, paths: &[PathBuf]) -> IdeResult<String> {
    if [before, after].iter().any(|rev| rev.trim().is_empty() || rev.starts_with('-')) {
        return Err(IdeError::invalid("invalid revision"));
    }
    let paths = paths.iter().map(|path| r.given_rel_path(path)).collect::<IdeResult<Vec<_>>>()?;
    if paths.is_empty() || paths.iter().any(String::is_empty) {
        return Err(IdeError::invalid("no files selected"));
    }
    let empty_tree = if before == EMPTY_TREE || after == EMPTY_TREE {
        r.gix()?.object_hash().empty_tree().to_string()
    } else {
        String::new()
    };
    let before = if before == EMPTY_TREE { empty_tree.as_str() } else { before };
    let after = if after == EMPTY_TREE { empty_tree.as_str() } else { after };
    let args = vec![
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--full-index",
        "-M",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        before,
        after,
        "--",
    ];
    selected_diff(r, args, &paths, "", &[])
}

fn selected_diff<'a>(
    r: &Repo,
    mut args: Vec<&'a str>,
    paths: &'a [String],
    prefix: &str,
    env: &[(&str, &OsStr)],
) -> IdeResult<String> {
    // The long-selection fallback keeps both sides of a rename in the same diff.
    if cli::batch_paths(cli::base_command_line_len(&args), paths, cli::command_line_limit()).len() > 1 {
        let diff = prefix_rename_headers(lossless_diff(r, &args, env)?, prefix);
        let selected: HashSet<_> = paths.iter().map(|path| format!("{prefix}{path}")).collect();
        return Ok(sections(&diff)
            .into_iter()
            .filter(|(_, file)| {
                selected.contains(file.path.as_str()) || file.old_path.as_deref().is_some_and(|p| selected.contains(p))
            })
            .map(|(section, _)| section)
            .collect());
    }
    args.extend(paths.iter().map(String::as_str));
    lossless_diff(r, &args, env).map(|patch| prefix_rename_headers(patch, prefix))
}

/// Git's --src-prefix and --dst-prefix cover file headers, but not rename metadata.
fn prefix_rename_headers(patch: String, prefix: &str) -> String {
    if prefix.is_empty() {
        return patch;
    }
    let mut out = String::with_capacity(patch.len());
    for line in patch.split_inclusive('\n') {
        if let Some((tag, path)) =
            ["rename from ", "rename to "].into_iter().find_map(|tag| line.strip_prefix(tag).map(|path| (tag, path)))
        {
            let path = git_path(path.trim_end_matches('\n'));
            out.push_str(tag);
            out.push_str(&crate::diff::quote_path(&format!("{prefix}{path}")));
            out.push('\n');
        } else {
            out.push_str(line);
        }
    }
    out
}

pub(crate) fn sections(patch: &str) -> Vec<(&str, PatchFile)> {
    let mut starts: Vec<_> = patch
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    if starts.is_empty() {
        let (mut old, mut new) = (0u32, 0u32);
        let mut offset = 0;
        let mut lines = patch.split_inclusive('\n').peekable();
        while let Some(line) = lines.next() {
            if old > 0 || new > 0 {
                match line.as_bytes().first() {
                    Some(b'-') => old = old.saturating_sub(1),
                    Some(b'+') => new = new.saturating_sub(1),
                    Some(b' ') => {
                        old = old.saturating_sub(1);
                        new = new.saturating_sub(1);
                    }
                    _ => {}
                }
            } else if line.starts_with("--- ") && lines.peek().is_some_and(|l| l.starts_with("+++ ")) {
                starts.push(offset);
            }
            if let Some(range) = line.strip_prefix("@@ ") {
                let mut parts = range.split_whitespace();
                let count = |s: &str| s.split_once(',').map_or(1, |(_, n)| n.parse().unwrap_or(0));
                old = parts.next().map(count).unwrap_or(0);
                new = parts.next().map(count).unwrap_or(0);
            }
            offset += line.len();
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(n, &start)| {
            let section = &patch[start..starts.get(n + 1).copied().unwrap_or(patch.len())];
            parse_patch(section).into_iter().next().map(|file| (section, file))
        })
        .collect()
}

/// Changes the base of an exported patch without modifying its hunks or binary payloads.
pub fn rebase_patch(patch: &str, root: &Path, prefix: &str, base: &Path) -> IdeResult<String> {
    if patch.is_empty() || (root == base && prefix.is_empty()) {
        return Ok(patch.to_owned());
    }
    let patch = normalized(patch)?;
    let sections = sections(&patch);
    let Some((first, _)) = sections.first() else {
        return Err(IdeError::invalid("no file changes found in the patch"));
    };
    let relative = |path: &str| {
        let path = path
            .strip_prefix(prefix)
            .map(Path::new)
            .filter(|path| valid_patch_path(path))
            .ok_or_else(|| IdeError::invalid("The patch contains a path outside its repository"))?;
        root.join(path)
            .strip_prefix(base)
            .ok()
            .filter(|path| valid_patch_path(path))
            .map(ide_core::ipc_path::to_ipc)
            .ok_or_else(|| IdeError::invalid("The base directory must contain every selected path"))
    };
    let mut output = String::with_capacity(patch.len());
    if let Some((preamble, _)) = patch.split_once(*first) {
        output.push_str(preamble);
    }
    for (section, file) in sections {
        let before = relative(file.old_path.as_deref().unwrap_or(&file.path))?;
        let after = relative(&file.path)?;
        mapping::rewrite_headers(&mut output, section, &before, &after, false);
    }
    Ok(output)
}

fn normalized(patch: &str) -> IdeResult<String> {
    if patch.trim().is_empty() {
        return Err(IdeError::invalid("the patch is empty"));
    }
    // Git emits LF headers even when the hunk payload contains CRLF lines.
    let crlf_headers = patch
        .split('\n')
        .find(|line| line.starts_with("diff --git ") || line.starts_with("--- "))
        .is_some_and(|line| line.ends_with('\r'));
    let mut p = if crlf_headers { patch.replace("\r\n", "\n") } else { patch.to_string() };
    if !p.ends_with('\n') {
        p.push('\n');
    }
    Ok(p)
}

/// The files of a patch, whether each applies cleanly to the working tree.
pub(crate) fn preview(r: &Repo, patch: &str) -> IdeResult<Vec<PatchFile>> {
    preview_with_prefix(r, patch, "")
}

fn preview_with_prefix(r: &Repo, patch: &str, prefix: &str) -> IdeResult<Vec<PatchFile>> {
    let patch = normalized(patch)?;
    let mut files = parse_patch(&patch);
    if files.is_empty() {
        return Err(IdeError::invalid("no file changes found in the patch"));
    }
    let strip = strip_option(prefix);
    let mut args = vec!["apply", "--check", "--binary"];
    args.extend(strip.as_deref());
    args.push("-");
    let out = cli::run_raw(r.root(), &args, Some(patch.as_bytes()))?;
    if out.code != Some(0) {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        let failing = failing_paths(&err);
        for f in &mut files {
            let hit = |p: &str| failing.iter().any(|x| x == p.strip_prefix(prefix).unwrap_or(p));
            f.applies = !(hit(&f.path) || f.old_path.as_deref().is_some_and(hit));
        }
        // An error we could not attribute to a file: nothing applies cleanly.
        if files.iter().all(|f| f.applies) {
            files.iter_mut().for_each(|f| f.applies = false);
        }
    }
    for file in &mut files {
        if let Some(base) = file.old_path.as_deref().unwrap_or(&file.path).strip_prefix(prefix) {
            file.missing_base = missing_patch_base(r.root(), file, base);
        }
    }
    Ok(files)
}

fn valid_patch_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(name) if !name.eq_ignore_ascii_case(".git")))
}

fn patch_file_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() || metadata.is_symlink())
}

fn missing_patch_base(root: &Path, file: &PatchFile, before: &str) -> bool {
    let before = Path::new(before);
    file.kind != ChangeKind::Added && valid_patch_path(before) && !patch_file_exists(&root.join(before))
}

/// Paths named in `git apply` errors (`error: path: …`, `error: patch failed: path:12`).
fn failing_paths(stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("error: ") else { continue };
        if let Some(p) = rest.strip_prefix("patch failed: ") {
            if let Some((path, _line)) = p.rsplit_once(':') {
                out.push(path.to_string());
            }
        } else if let Some((path, _)) = rest.split_once(": ") {
            out.push(path.to_string());
        }
    }
    out
}

/// Applies a patch to the working tree. When it does not apply cleanly, a 3-way
/// merge is attempted; conflicting files are left with conflict markers and index
/// stages for the merge UI and returned in [`ApplyOutcome::conflicts`].
pub(crate) fn apply(r: &Repo, patch: &str) -> IdeResult<ApplyOutcome> {
    apply_with_prefix(r, patch, "")
}

/// Keep complete file sections, including rename metadata and binary payloads.
pub(crate) fn apply_selected(r: &Repo, patch: &str, paths: &[String]) -> IdeResult<ApplyOutcome> {
    let patch = normalized(patch)?;
    let selected: String = selected_sections(&patch, Some(paths))?.into_iter().map(|(section, _)| section).collect();
    apply_for_review(r, &selected, "")
}

fn selected_sections<'a>(patch: &'a str, paths: Option<&[String]>) -> IdeResult<Vec<(&'a str, PatchFile)>> {
    let mut sections = sections(patch);
    let Some(paths) = paths else { return Ok(sections) };
    if paths.is_empty() {
        return Err(IdeError::invalid("select files to apply from the patch"));
    }
    let paths: HashSet<_> = paths.iter().map(String::as_str).collect();
    let mut remaining = paths.clone();
    sections.retain(|(_, file)| {
        remaining.remove(file.path.as_str());
        paths.contains(file.path.as_str())
    });
    if !remaining.is_empty() {
        return Err(IdeError::invalid("the selection contains files outside the patch"));
    }
    Ok(sections)
}

/// An apply plan with paths based at a common project directory.
pub struct ProjectPatch {
    pub base: PathBuf,
    pub groups: Vec<ProjectPatchGroup>,
}

pub struct ProjectPatchGroup {
    pub root: PathBuf,
    prefix: String,
    patch: String,
}

impl ProjectPatchGroup {
    pub fn preview(&self, r: &Repo) -> IdeResult<Vec<PatchFile>> {
        let _scope = r.execution_scope();
        preview_with_prefix(r, &self.patch, &self.prefix)
    }

    pub fn apply(&self, r: &Repo) -> IdeResult<ApplyOutcome> {
        let _scope = r.execution_scope();
        let outcome = apply_for_review(r, &self.patch, &self.prefix)?;
        let based = |paths: Vec<String>| paths.into_iter().map(|path| format!("{}{path}", self.prefix)).collect();
        Ok(ApplyOutcome { applied: based(outcome.applied), conflicts: based(outcome.conflicts) })
    }

    pub fn file_diff(
        &self,
        r: &Repo,
        path: &str,
        encoding: &dyn Fn(&Path, &[u8]) -> crate::TextEncoding,
    ) -> IdeResult<crate::PatchFileDiff> {
        let _scope = r.execution_scope();
        file_diff::generate(r, &self.patch, path, &self.prefix, encoding)
    }
}

impl ProjectPatch {
    /// Automatically use project paths when all files map and the patch spans repositories.
    pub fn discover(repos: &Repos, project: &Path, patch: &str, multiple: bool) -> IdeResult<Option<Self>> {
        let patch = normalized(patch)?;
        let files = sections(&patch);
        let mut single = None;
        for plan in project.ancestors().filter_map(|base| Self::route(repos, base, &files)) {
            if plan.groups.len() > 1 {
                return Ok(Some(plan));
            }
            if !multiple && single.is_none() {
                single = Some(plan);
            }
        }
        Ok(single)
    }

    pub fn at_base(
        repos: &Repos,
        project: &Path,
        base: &Path,
        patch: &str,
        paths: Option<&[String]>,
    ) -> IdeResult<Self> {
        if !project.starts_with(base) || !base.is_absolute() {
            return Err(IdeError::invalid("The patch base is outside the project"));
        }
        let patch = normalized(patch)?;
        let files = selected_sections(&patch, paths)?;
        Self::route(repos, base, &files)
            .ok_or_else(|| IdeError::invalid("The patch paths do not match the project's Git repositories"))
    }

    fn route(repos: &Repos, base: &Path, files: &[(&str, PatchFile)]) -> Option<Self> {
        if files.is_empty() {
            return None;
        }
        let resolve = |path: &str| {
            let path = Path::new(path);
            if path.as_os_str().is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
                return None;
            }
            let full = base.join(path);
            let repo = repos.for_path(&full)?;
            let relative_root = repo.root().strip_prefix(base).ok()?;
            (full != repo.root()).then_some((repo.root(), relative_root))
        };
        let mut groups = BTreeMap::new();
        for (section, file) in files {
            let (root, relative_root) = resolve(&file.path)?;
            if let Some(old) = &file.old_path
                && resolve(old)?.0 != root
            {
                return None;
            }
            let group = groups.entry(root).or_insert_with(|| ProjectPatchGroup {
                root: root.to_owned(),
                prefix: if relative_root.as_os_str().is_empty() {
                    String::new()
                } else {
                    format!("{}/", ide_core::ipc_path::to_ipc(relative_root))
                },
                patch: String::new(),
            });
            group.patch.push_str(section);
        }
        Some(Self { base: base.to_owned(), groups: groups.into_values().collect() })
    }
}

pub(crate) fn strip_option(prefix: &str) -> Option<String> {
    (!prefix.is_empty()).then(|| format!("-p{}", 1 + prefix.bytes().filter(|&byte| byte == b'/').count()))
}

pub(crate) fn apply_with_prefix(r: &Repo, patch: &str, prefix: &str) -> IdeResult<ApplyOutcome> {
    apply_patch(r, patch, prefix, false)
}

pub(crate) fn apply_for_review(r: &Repo, patch: &str, prefix: &str) -> IdeResult<ApplyOutcome> {
    apply_patch(r, patch, prefix, true)
}

fn apply_patch(r: &Repo, patch: &str, prefix: &str, identify_conflicts: bool) -> IdeResult<ApplyOutcome> {
    let patch = normalized(patch)?;
    let files = parse_patch(&patch);
    let paths = files
        .iter()
        .map(|f| {
            if f.old_path.as_deref().is_some_and(|old| !old.starts_with(prefix)) {
                return Err(IdeError::invalid("The patch contains a path outside its repository"));
            }
            f.path
                .strip_prefix(prefix)
                .map(str::to_owned)
                .ok_or_else(|| IdeError::invalid("The patch contains a path outside its repository"))
        })
        .collect::<IdeResult<Vec<_>>>()?;
    let strip = strip_option(prefix);
    let mut args = vec!["apply", "--binary"];
    args.extend(strip.as_deref());
    let check = cli::run_raw(r.root(), &[args.as_slice(), &["--check", "-"]].concat(), Some(patch.as_bytes()))?;
    if check.code == Some(0) {
        run(r.root(), &[args.as_slice(), &["-"]].concat(), Some(patch.as_bytes()))?;
        return Ok(ApplyOutcome { applied: paths, conflicts: Vec::new() });
    }
    let _guard = identify_conflicts.then(|| r.conflict_mutation.lock().unwrap_or_else(|error| error.into_inner()));
    let record = identify_conflicts && unmerged(r)?.is_empty();
    if record {
        crate::conflict_resolution::clear_restore_conflicts(r);
    }
    let out = cli::run_raw(r.root(), &[args.as_slice(), &["--3way", "-"]].concat(), Some(patch.as_bytes()))?;
    let conflicts: Vec<_> = unmerged(r)?
        .into_iter()
        .filter(|path| {
            paths.contains(path)
                || files
                    .iter()
                    .any(|f| f.old_path.as_deref().and_then(|old| old.strip_prefix(prefix)) == Some(path.as_str()))
        })
        .collect();
    if out.code != Some(0) && conflicts.is_empty() {
        return Err(cli::failure(&["apply"], &out.stderr, &out.stdout, out.code));
    }
    if record && !conflicts.is_empty() {
        crate::conflict_resolution::record_conflicts(r, crate::conflict_resolution::RestoreConflict::PatchApply);
    }
    // `--3way` stages what it applied; keep the index as it was for the clean files.
    let clean: Vec<String> = paths.iter().filter(|p| !conflicts.contains(p)).cloned().collect();
    if !clean.is_empty() && r.has_head()? {
        cli::run_paths(r.root(), &["--literal-pathspecs", "reset", "-q", "--"], &clean)?;
    }
    Ok(ApplyOutcome { applied: clean, conflicts })
}

fn unmerged(r: &Repo) -> IdeResult<Vec<String>> {
    let out = run(r.root(), &["diff", "--name-only", "--diff-filter=U", "-z"], None)?;
    Ok(out.stdout_str().split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

pub(super) fn git_path(p: &str) -> String {
    let Some(p) = p.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else { return p.to_string() };
    let mut bytes = Vec::new();
    let mut chars = p.bytes().peekable();
    while let Some(c) = chars.next() {
        if c != b'\\' {
            bytes.push(c);
            continue;
        }
        let Some(c) = chars.next() else { break };
        bytes.push(match c {
            b'n' => b'\n',
            b't' => b'\t',
            b'r' => b'\r',
            b'a' => 7,
            b'b' => 8,
            b'v' => 11,
            b'f' => 12,
            b'0'..=b'7' => {
                let mut n = c - b'0';
                for _ in 0..2 {
                    if let Some(d @ b'0'..=b'7') = chars.peek().copied() {
                        chars.next();
                        n = n.wrapping_mul(8).wrapping_add(d - b'0');
                    } else {
                        break;
                    }
                }
                n
            }
            c => c,
        });
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn strip_prefix(p: &str) -> Option<String> {
    let p = if p.starts_with('"') { p } else { p.split('\t').next().unwrap_or(p) };
    if p == "/dev/null" {
        return None;
    }
    let p = git_path(p);
    Some(p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(&p).to_string())
}

/// Files changed by a unified diff (git extended headers or plain `---`/`+++`).
pub(crate) fn parse_patch(patch: &str) -> Vec<PatchFile> {
    let mut out: Vec<PatchFile> = Vec::new();
    let mut cur: Option<PatchFile> = None;
    let mut before_path: Option<String> = None;
    // From a `diff --git` header and no hunk seen yet: `---` belongs to it.
    let mut fresh_header = false;
    let (mut old_left, mut new_left) = (0u32, 0u32);
    let new_file = |path: String| PatchFile {
        path,
        old_path: None,
        kind: ChangeKind::Modified,
        added: 0,
        removed: 0,
        binary: false,
        applies: true,
        missing_base: false,
    };
    for line in patch.lines() {
        if old_left > 0 || new_left > 0 {
            let Some(c) = cur.as_mut() else { break };
            match line.as_bytes().first() {
                Some(b'+') => {
                    c.added += 1;
                    new_left = new_left.saturating_sub(1);
                }
                Some(b'-') => {
                    c.removed += 1;
                    old_left = old_left.saturating_sub(1);
                }
                Some(b'\\') => {}
                _ => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            out.extend(cur.take());
            before_path = None;
            let path = rest
                .rsplit_once(" \"b/")
                .map(|(_, b)| git_path(&format!("\"{b}")))
                .or_else(|| rest.rsplit_once(" b/").map(|(_, b)| b.to_string()))
                .unwrap_or_else(|| rest.to_string());
            let path = path.strip_prefix("b/").unwrap_or(&path).to_string();
            cur = Some(new_file(path));
            fresh_header = true;
        } else if let Some(rest) = line.strip_prefix("--- ") {
            if !fresh_header {
                out.extend(cur.take());
                cur = Some(new_file(String::new()));
            }
            fresh_header = false;
            before_path = strip_prefix(rest);
            if let Some(c) = cur.as_mut() {
                match &before_path {
                    Some(p) if c.path.is_empty() => c.path = p.clone(),
                    Some(_) => {}
                    None => c.kind = ChangeKind::Added,
                }
            }
        } else if let Some(c) = cur.as_mut() {
            if let Some(rest) = line.strip_prefix("+++ ") {
                match strip_prefix(rest) {
                    Some(p) => {
                        if let Some(old) = before_path.take().filter(|old| old != &p) {
                            c.old_path.get_or_insert(old);
                        }
                        c.path = p;
                    }
                    None => c.kind = ChangeKind::Deleted,
                }
            } else if let Some(range) = line.strip_prefix("@@ ") {
                fresh_header = false;
                let count = |spec: &str| -> u32 {
                    let spec = &spec[1..];
                    match spec.split_once(',') {
                        Some((_, n)) => n.parse().unwrap_or(0),
                        None => 1,
                    }
                };
                let mut parts = range.split_whitespace();
                old_left = parts.next().filter(|p| p.starts_with('-')).map(count).unwrap_or(0);
                new_left = parts.next().filter(|p| p.starts_with('+')).map(count).unwrap_or(0);
            } else if line.starts_with("new file mode") {
                c.kind = ChangeKind::Added;
            } else if line.starts_with("deleted file mode") {
                c.kind = ChangeKind::Deleted;
            } else if let Some(p) = line.strip_prefix("rename from ").or_else(|| line.strip_prefix("copy from ")) {
                c.old_path = Some(git_path(p));
                if line.starts_with("rename ") {
                    c.kind = ChangeKind::Renamed;
                }
            } else if let Some(p) = line.strip_prefix("rename to ").or_else(|| line.strip_prefix("copy to ")) {
                c.path = git_path(p);
            } else if line.starts_with("GIT binary patch") || line.starts_with("Binary files ") {
                c.binary = true;
            }
        }
    }
    out.extend(cur);
    out.retain(|f| !f.path.is_empty());
    out
}

/// A patch crosses the string IPC boundary. Non-UTF-8 content must travel as a
/// Git binary patch, not replacement characters or an encoding-dependent string.
fn lossless_diff(r: &Repo, args: &[&str], env: &[(&str, &OsStr)]) -> IdeResult<String> {
    let output = run_env(r.root(), args, None, env)?.stdout;
    if let Ok(text) = String::from_utf8(output) {
        return Ok(text);
    }
    // info/attributes has highest precedence. Isolate it from the real repository
    // so concurrent Git operations and user attributes are never modified.
    let temp = tempfile::tempdir()?;
    let git_dir = temp.path().to_string_lossy().into_owned();
    let format = run(r.root(), &["rev-parse", "--show-object-format"], None)?.stdout_str();
    run(r.root(), &["init", "--bare", "--quiet", &format!("--object-format={}", format.trim()), &git_dir], None)?;
    std::fs::write(temp.path().join("info/attributes"), "* -diff\n")?;
    if let Some(head) = r.head()?.1 {
        std::fs::write(temp.path().join("HEAD"), format!("{head}\n"))?;
    }
    let objects = run(r.root(), &["rev-parse", "--path-format=absolute", "--git-path", "objects"], None)?.stdout_str();
    let mut isolated = env.to_vec();
    isolated.extend([
        ("GIT_DIR", temp.path().as_os_str()),
        ("GIT_WORK_TREE", r.root().as_os_str()),
        ("GIT_OBJECT_DIRECTORY", OsStr::new(objects.trim())),
    ]);
    String::from_utf8(run_env(r.root(), args, None, &isolated)?.stdout)
        .map_err(|_| IdeError::invalid("Git produced a non-UTF-8 binary patch"))
}

/// Encode only hunk payloads; patch headers and Git paths always remain UTF-8.
pub(crate) fn encode_text_patch(
    r: &Repo,
    patch: &str,
    encoding: &dyn Fn(&std::path::Path) -> IdeResult<crate::TextEncoding>,
) -> IdeResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut header = String::new();
    let mut enc = None;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            header.clear();
            enc = None;
        }
        if line.starts_with("@@ ") {
            let file = parse_patch(&header)
                .into_iter()
                .next()
                .ok_or_else(|| IdeError::invalid("patch hunk has no file header"))?;
            enc = Some(encoding(&r.abs_path(&file.path))?);
        } else if let Some(enc) = enc {
            if line.starts_with(['+', '-', ' ']) {
                out.push(line.as_bytes()[0]);
                out.extend(crate::text_encoding::encode(&line[1..], enc, false)?);
                continue;
            }
        } else {
            header.push_str(line);
        }
        out.extend_from_slice(line.as_bytes());
    }
    Ok(out)
}

/// Apply displayed-text line selections in a temporary UTF-8 index, then
/// serialize the result. Literal escape spelling in the real index must not
/// prevent a selected patch from matching its decoded base.
pub(crate) fn stage_converted_patch(
    r: &Repo,
    patch: &str,
    encoding: &dyn Fn(&std::path::Path) -> IdeResult<crate::TextEncoding>,
) -> IdeResult<()> {
    use crate::text_encoding::{decode, encode, has_bom};
    let tmp = TempIndex::new(r);
    let env = tmp.env();
    let index = r.git_dir.join("index");
    if index.exists() {
        std::fs::copy(index, tmp.path())?;
    } else {
        run_env(r.root(), &["read-tree", "--empty"], None, &env)?;
    }
    let mut files = Vec::new();
    for file in parse_patch(patch) {
        let path = r.abs_path(&file.path);
        let enc = encoding(&path)?;
        let original = r.file_bytes_at(&path, Some(":0"))?;
        let bom = original.as_ref().is_some_and(|bytes| has_bom(bytes, enc));
        if let Some(original) = original {
            crate::write::write_index_blob(r, &file.path, decode(&original, enc).as_bytes(), &env)?;
        }
        files.push((file.path, enc, bom));
    }
    run_env(
        r.root(),
        &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "--recount", "-"],
        Some(patch.as_bytes()),
        &env,
    )?;
    for (rel, enc, bom) in files {
        let staged = cli::run_raw_env(r.root(), &["show", &format!(":0:{rel}")], None, &env)?;
        if staged.code == Some(0) {
            let text = std::str::from_utf8(&staged.stdout).map_err(|e| IdeError::invalid(e.to_string()))?;
            crate::write::write_index_blob(r, &rel, &encode(text, enc, bom)?, &[])?;
        } else {
            run(r.root(), &["--literal-pathspecs", "update-index", "--force-remove", "--", &rel], None)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_and_plain_patches() {
        let patch = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n\
diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n\
diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n\
diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n--- dashes\n";
        let files = parse_patch(patch);
        let got: Vec<(&str, ChangeKind, u32, u32)> =
            files.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed)).collect();
        assert_eq!(
            got,
            vec![
                ("src/a.rs", ChangeKind::Modified, 1, 1),
                ("n.txt", ChangeKind::Added, 1, 0),
                ("y", ChangeKind::Renamed, 0, 0),
                ("gone", ChangeKind::Deleted, 0, 1),
            ]
        );
        assert_eq!(files[2].old_path.as_deref(), Some("x"));

        let plain = "--- a/one.txt\t2024-01-01\n+++ b/one.txt\t2024-01-02\n@@ -1 +1 @@\n-a\n+b\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1,2 @@\n a\n+c\n";
        let files = parse_patch(plain);
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["one.txt", "two.txt"]);
        assert_eq!((files[1].added, files[1].removed), (1, 0));
    }

    #[test]
    fn failing_paths_from_git_apply() {
        let err = "error: patch failed: src/a.rs:3\nerror: src/a.rs: patch does not apply\nerror: n.txt: already exists in working directory\n";
        assert_eq!(failing_paths(err), vec!["src/a.rs", "src/a.rs", "n.txt"]);
    }
}
