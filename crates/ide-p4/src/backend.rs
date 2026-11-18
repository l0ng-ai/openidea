//! [`ide_vcs::Backend`] for a Perforce workspace: the Changes view, diff
//! viewer, annotate and log on top of opened files and submitted changelists.
//!
//! Perforce has no index, so every change is reported as `unstaged`; "staging"
//! opens a file (`p4 edit` / `p4 add`) and the commit is `p4 submit`.

use crate::cli::{args, escape, unescape};
use crate::workspace::{OpenedFile, Workspace, decode};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use ide_vcs::{
    Backend, BlameLine, BlockHistory, ChangeKind, ChangedFile, Commit, CommitOptions, FileStatus, LineHunk, LogQuery,
    PendingChange, RevisionChange, TextEncoding, build_partial_patch, diff_hunks,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Changes read to answer a filtered log page, at most.
const LOG_SCAN: u32 = 5000;

impl Workspace {
    /// The unified diff of `path` between two texts, in `git diff` form.
    fn patch(&self, path: &Path, old: &str, new: &str) -> String {
        let hunks: Vec<usize> = (0..diff_hunks(old, new).len()).collect();
        build_partial_patch(&self.rel(path), old, new, &hunks)
    }

    fn working_text(path: &Path, encoding: TextEncoding) -> String {
        std::fs::read(path).map(|b| decode(&b, encoding)).unwrap_or_default()
    }

    fn working_patch(&self, path: &Path, encoding: TextEncoding) -> IdeResult<String> {
        let old = self.base_text(path, encoding)?;
        let new = Self::working_text(path, encoding);
        Ok(self.patch(path, old.as_deref().map(String::as_str).unwrap_or_default(), &new))
    }

    /// The files of a changelist with what it did to each (`p4 describe -s`;
    /// `shelved:<n>` reads the shelf of a pending one).
    pub fn change_files(&self, change: &str) -> IdeResult<Vec<(String, String, u32)>> {
        let mut argv = args(["describe", "-s"]);
        match change.strip_prefix("shelved:") {
            Some(number) => argv.extend(args(["-S", number])),
            None => argv.push(change.trim_end_matches('^').to_owned()),
        }
        let out = self.tagged(&argv)?;
        let Some(record) = out.records.first() else {
            return Err(IdeError::not_found(format!("changelist {change} does not exist")));
        };
        let (files, actions, revs) = (record.list("depotFile"), record.list("action"), record.list("rev"));
        Ok(files
            .into_iter()
            .enumerate()
            .map(|(i, file)| {
                let action = actions.get(i).cloned().unwrap_or_default();
                let rev = revs.get(i).and_then(|r| r.parse().ok()).unwrap_or(0);
                (unescape(&file), action, rev)
            })
            .collect())
    }

    /// The full description of a changelist.
    pub fn description(&self, change: &str) -> IdeResult<String> {
        let out = self.tagged(&args(["describe", "-s", change.trim_end_matches('^')]))?;
        match out.records.first() {
            Some(record) => Ok(record.text("desc").trim_end().to_owned()),
            None => Err(IdeError::not_found(format!("changelist {change} does not exist"))),
        }
    }

    /// Workspace-relative paths of depot files; one outside the client view keeps its depot path.
    fn rel_paths(&self, depot_files: &[String]) -> IdeResult<HashMap<String, String>> {
        let local = self.local_paths(depot_files)?;
        Ok(depot_files
            .iter()
            .map(|depot| {
                let rel = local.get(depot).map(|p| self.rel(p)).unwrap_or_else(|| depot.clone());
                (depot.clone(), rel)
            })
            .collect())
    }

    fn changed_files(&self, change: &str) -> IdeResult<Vec<ChangedFile>> {
        let files = self.change_files(change)?;
        let rel = self.rel_paths(&files.iter().map(|(f, _, _)| f.clone()).collect::<Vec<_>>())?;
        let mut out: Vec<ChangedFile> = files
            .iter()
            .map(|(depot, action, _)| ChangedFile {
                path: rel[depot].clone(),
                kind: action_kind(action),
                old_path: None,
                link: None,
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn commit_of(record: &crate::cli::Record, older: Option<&str>) -> Commit {
        let id = record.text("change");
        let message = record.text("desc").trim_end().to_owned();
        let time_ms = record.get("time").and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0) * 1000.0;
        let user = record.text("user");
        Commit {
            short_id: id.clone(),
            id,
            parents: Vec::new(),
            graph_parents: Some(older.map(|o| vec![o.to_owned()]).unwrap_or_default()),
            graph_dashed: Vec::new(),
            history_path: None,
            log_position: None,
            log_total: None,
            log_merge_time_ms: None,
            graph_boundary_parents: Vec::new(),
            on_current_branch: Some(true),
            email: format!("{user}@{}", record.text("client")),
            committer: user.clone(),
            committer_email: String::new(),
            author: user,
            time_ms,
            summary: message.lines().next().unwrap_or_default().to_owned(),
            message,
            message_truncated: false,
            refs: Vec::new(),
            commit_time_ms: time_ms,
            dashed: Vec::new(),
        }
    }

    /// Files opened for the commit: `options.stage`, or everything opened when it is empty.
    fn commit_selection(&self, options: &CommitOptions) -> IdeResult<Vec<OpenedFile>> {
        let wanted: Vec<PathBuf> = options.stage.iter().map(|p| p.0.clone()).collect();
        let excluded: Vec<&PathBuf> = options.exclude.iter().map(|p| &p.0).collect();
        let opened = self.opened(&[])?;
        Ok(opened
            .into_iter()
            .filter(|f| (wanted.is_empty() || wanted.contains(&f.path.0)) && !excluded.contains(&&f.path.0))
            .collect())
    }
}

pub(crate) fn action_kind(action: &str) -> ChangeKind {
    match action {
        "add" | "branch" | "import" | "move/add" => ChangeKind::Added,
        "delete" | "move/delete" | "purge" | "archive" => ChangeKind::Deleted,
        _ => ChangeKind::Modified,
    }
}

fn unsupported(what: &str) -> IdeError {
    IdeError::new(ErrorKind::Unavailable, format!("{what} is not available for Perforce workspaces"))
}

impl Backend for Workspace {
    fn root(&self) -> &Path {
        Workspace::root(self)
    }

    fn status(&self) -> IdeResult<Vec<FileStatus>> {
        self.status_of(&[])
    }

    fn status_paths(&self, paths: &[PathBuf]) -> IdeResult<Vec<FileStatus>> {
        let scope = self.file_args(paths);
        if scope.is_empty() { Ok(Vec::new()) } else { self.status_of(&scope) }
    }

    fn file_at(&self, path: &Path, rev: Option<&str>, encoding: TextEncoding) -> IdeResult<Option<String>> {
        match rev {
            None | Some("HEAD" | ":0" | "") => Ok(self.base_text(path, encoding)?.map(|t| t.as_ref().clone())),
            rev => self.text_at(path, rev, encoding),
        }
    }

    fn file_mode_at(&self, path: &Path, rev: Option<&str>) -> IdeResult<Option<String>> {
        let working = rev == Some("WT");
        let file = if working { escape(path) } else { self.revision_arg(path, rev) };
        let out = match self.tagged(&args(["fstat", "-T", "depotFile,headType,type", &file])) {
            Ok(out) => out,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let Some(record) = out.records.first() else { return Ok(None) };
        let opened = record.get("type").filter(|_| working);
        Ok(opened.or(record.get("headType")).map(str::to_owned))
    }

    fn diff_text(&self, path: &Path, _staged: bool, encoding: TextEncoding) -> IdeResult<String> {
        self.working_patch(path, encoding)
    }

    fn working_tree_patch(
        &self,
        path: Option<&Path>,
        against: Option<&str>,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<String> {
        let encoding = TextEncoding::from(encoding_rs::UTF_8);
        let files: Vec<PathBuf> = match path {
            Some(path) => vec![path.to_path_buf()],
            None => self.opened(&[])?.into_iter().map(|f| f.path.0).collect(),
        };
        let mut patch = String::new();
        for file in files {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let old = match against {
                None => self.base_text(&file, encoding)?.map(|t| t.as_ref().clone()),
                rev => self.text_at(&file, rev, encoding)?,
            };
            let new = Self::working_text(&file, encoding);
            patch.push_str(&self.patch(&file, old.as_deref().unwrap_or_default(), &new));
            if patch.len() > max_bytes {
                let mut cut = max_bytes;
                while !patch.is_char_boundary(cut) {
                    cut -= 1;
                }
                patch.truncate(cut);
                break;
            }
        }
        Ok(patch)
    }

    fn line_hunks(
        &self,
        path: &Path,
        current_text: &str,
        _against_index: bool,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<LineHunk>> {
        // A file that is not in the depot yet has no markers: all of it is new.
        let Some(base) = self.base_text(path, encoding)? else { return Ok(Vec::new()) };
        Ok(diff_hunks(&base, current_text))
    }

    fn blame(
        &self,
        path: &Path,
        text: Option<&str>,
        revision: Option<&str>,
        encoding: TextEncoding,
    ) -> IdeResult<Vec<BlameLine>> {
        let file = self.revision_arg(path, revision);
        let out = self.tagged(&args(["annotate", "-c", "-u", "-q", &file]))?;
        let lines: Vec<&crate::cli::Record> = out.records.iter().filter(|r| r.has("lower")).collect();
        let mut changes: Vec<String> = lines.iter().map(|r| r.text("lower")).collect();
        changes.sort();
        changes.dedup();
        let mut described: HashMap<String, (f64, String)> = HashMap::new();
        for chunk in changes.chunks(crate::workspace::BATCH) {
            let mut argv = args(["describe", "-s"]);
            argv.extend(chunk.iter().cloned());
            for r in self.tagged(&argv)?.records {
                let time = r.get("time").and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0) * 1000.0;
                let summary = r.text("desc").lines().next().unwrap_or_default().to_owned();
                described.insert(r.text("change"), (time, summary));
            }
        }
        let annotated: Vec<BlameLine> = lines
            .iter()
            .map(|r| {
                let change = r.text("lower");
                let (time_ms, summary) = described.get(&change).cloned().unwrap_or_default();
                BlameLine { commit: change, author: r.text("user"), time_ms, summary, origin_path: None }
            })
            .collect();
        let Some(text) = text else { return Ok(annotated) };
        // Lines of the buffer that differ from the annotated revision are not submitted yet.
        let base: String = lines.iter().map(|r| r.text("data")).collect();
        let base = decode(base.as_bytes(), encoding);
        let total = text.split_inclusive('\n').count();
        let pending = BlameLine {
            commit: "0".repeat(40),
            author: "Not Committed Yet".into(),
            time_ms: 0.0,
            summary: String::new(),
            origin_path: None,
        };
        let mut out = Vec::with_capacity(total);
        let (mut old, mut new) = (0usize, 0usize);
        for hunk in diff_hunks(&base, text) {
            let unchanged = (hunk.start as usize).saturating_sub(new);
            out.extend(annotated.iter().skip(old).take(unchanged).cloned());
            out.extend(std::iter::repeat_n(pending.clone(), hunk.lines as usize));
            old = hunk.old_start as usize + hunk.old_lines as usize;
            new = hunk.start as usize + hunk.lines as usize;
        }
        out.extend(annotated.iter().skip(old).take(total.saturating_sub(new)).cloned());
        out.resize(total, pending);
        Ok(out)
    }

    fn block_history(
        &self,
        _path: &Path,
        _text: Option<&str>,
        _lines: (u32, u32),
        _encoding: TextEncoding,
        _cancel: &CancellationToken,
    ) -> IdeResult<BlockHistory> {
        Err(unsupported("History for Selection"))
    }

    fn log(&self, query: &LogQuery, cancel: &CancellationToken) -> IdeResult<Vec<Commit>> {
        let mut paths: Vec<PathBuf> = query.paths.iter().map(|p| p.0.clone()).collect();
        paths.extend(query.path.iter().map(|p| p.0.clone()));
        let scope = if paths.is_empty() { vec![self.everything()] } else { self.file_args(&paths) };
        let mut authors: Vec<String> = query.authors.clone();
        authors.extend(query.author.clone());
        let needle = query.text.as_deref().filter(|t| !t.is_empty());
        let filtered = needle.is_some() || authors.len() > 1 || query.since_ms.is_some() || query.until_ms.is_some();
        let wanted = query.skip.saturating_add(query.limit.max(1));
        let fetch = if filtered { LOG_SCAN } else { wanted };
        let mut argv = args(["changes", "-l", "-s", "submitted", "-m", &fetch.to_string()]);
        if let [author] = authors.as_slice() {
            argv.extend(args(["-u", author]));
        }
        argv.extend(scope);
        let out = self.tagged(&argv)?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let matches = |r: &crate::cli::Record| {
            let time_ms = r.get("time").and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0) * 1000.0;
            let text_ok = needle.is_none_or(|n| {
                let desc = r.text("desc");
                if query.text_match_case { desc.contains(n) } else { desc.to_lowercase().contains(&n.to_lowercase()) }
            });
            let user = r.text("user");
            let author_ok = authors.len() <= 1
                || authors.iter().any(|a| if query.authors_exact { *a == user } else { user.contains(a.as_str()) });
            text_ok
                && author_ok
                && query.since_ms.is_none_or(|since| time_ms >= since)
                && query.until_ms.is_none_or(|until| time_ms < until)
        };
        let records: Vec<&crate::cli::Record> = out.records.iter().filter(|r| matches(r)).collect();
        Ok(records
            .iter()
            .enumerate()
            .skip(query.skip as usize)
            .take(query.limit.max(1) as usize)
            .map(|(i, r)| Self::commit_of(r, records.get(i + 1).and_then(|older| older.get("change"))))
            .collect())
    }

    fn commit_files(&self, commit: &str) -> IdeResult<Vec<ChangedFile>> {
        self.changed_files(commit)
    }

    fn commits_changes(&self, commits: &[String]) -> IdeResult<Vec<RevisionChange>> {
        let mut numbers: Vec<u64> = commits.iter().filter_map(|c| c.parse().ok()).collect();
        numbers.sort_unstable();
        // Oldest first, so a file touched by several changes spans the first before and the last after.
        let mut spans: Vec<(String, RevisionChange)> = Vec::new();
        for number in numbers {
            let files = self.change_files(&number.to_string())?;
            let rel = self.rel_paths(&files.iter().map(|(f, _, _)| f.clone()).collect::<Vec<_>>())?;
            for (depot, action, _) in files {
                let kind = action_kind(&action);
                let before = (kind != ChangeKind::Added).then(|| (number - 1).to_string());
                let after = (kind != ChangeKind::Deleted).then(|| number.to_string());
                match spans.iter_mut().find(|(d, _)| *d == depot) {
                    Some((_, span)) => {
                        span.after = after;
                        span.kind = match (span.before.is_some(), span.after.is_some()) {
                            (false, _) => ChangeKind::Added,
                            (true, false) => ChangeKind::Deleted,
                            (true, true) => ChangeKind::Modified,
                        };
                    }
                    None => spans.push((
                        depot.clone(),
                        RevisionChange { path: rel[&depot].clone(), kind, old_path: None, before, after, link: None },
                    )),
                }
            }
        }
        let mut changes: Vec<RevisionChange> = spans.into_iter().map(|(_, change)| change).collect();
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(changes)
    }

    fn diff_revisions(&self, from: &str, to: &str) -> IdeResult<Vec<ChangedFile>> {
        let side = |rev: &str| format!("{}{}", self.everything(), crate::workspace::revision_suffix(Some(rev)));
        let (left, right) = (side(from), side(to));
        let out = match self.tagged(&args(["diff2", "-q", &left, &right])) {
            Ok(out) => out,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut depot: Vec<(String, ChangeKind)> = Vec::new();
        for r in &out.records {
            let (kind, file) = match r.get("status") {
                Some("left only") => (ChangeKind::Deleted, r.get("depotFile")),
                Some("right only") => (ChangeKind::Added, r.get("depotFile2").or(r.get("depotFile"))),
                Some("identical") => continue,
                _ => (ChangeKind::Modified, r.get("depotFile2").or(r.get("depotFile"))),
            };
            if let Some(file) = file {
                depot.push((unescape(file), kind));
            }
        }
        let rel = self.rel_paths(&depot.iter().map(|(f, _)| f.clone()).collect::<Vec<_>>())?;
        let mut files: Vec<ChangedFile> = depot
            .into_iter()
            .map(|(file, kind)| ChangedFile { path: rel[&file].clone(), kind, old_path: None, link: None })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    fn diff_with_worktree(&self, rev: &str) -> IdeResult<Vec<ChangedFile>> {
        // What the synced revisions changed since `rev`, then what is opened on top of them.
        let mut files = self.diff_revisions(rev, "#have")?;
        for opened in self.opened(&[])?.into_iter().filter(|f| f.action != "move/delete" || f.moved_from.is_none()) {
            let kind = match opened.kind() {
                ChangeKind::Renamed => ChangeKind::Added,
                ChangeKind::Conflicted => ChangeKind::Modified,
                kind => kind,
            };
            match files.iter_mut().find(|f| f.path == opened.rel_path) {
                Some(existing) if kind == ChangeKind::Deleted => existing.kind = ChangeKind::Deleted,
                Some(_) => {}
                None => files.push(ChangedFile { path: opened.rel_path, kind, old_path: None, link: None }),
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    fn numstat_with_worktree(&self, rev: &str) -> IdeResult<Vec<(String, u32, u32)>> {
        let encoding = TextEncoding::from(encoding_rs::UTF_8);
        let mut stats = Vec::new();
        for file in self.diff_with_worktree(rev)? {
            let path = self.abs(&file.path);
            let old = self.text_at(&path, Some(rev), encoding)?.unwrap_or_default();
            let new = if path.is_file() { Self::working_text(&path, encoding) } else { String::new() };
            let (mut added, mut removed) = (0, 0);
            for hunk in diff_hunks(&old, &new) {
                added += hunk.lines;
                removed += hunk.old_lines;
            }
            stats.push((file.path, added, removed));
        }
        Ok(stats)
    }

    fn stage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        self.open_for_edit(paths, None).map(|_| ())
    }

    fn unstage(&self, paths: &[PathBuf]) -> IdeResult<()> {
        self.revert(paths, true)
    }

    fn discard(&self, paths: &[PathBuf]) -> IdeResult<()> {
        self.revert(paths, false)
    }

    fn commit(
        &self,
        message: &str,
        options: &CommitOptions,
        _encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<String> {
        if options.amend {
            return Err(unsupported("Amend"));
        }
        let files = self.commit_selection(options)?;
        if files.is_empty() {
            return Err(IdeError::invalid("no opened files to submit"));
        }
        let paths: Vec<PathBuf> = files.iter().map(|f| f.path.0.clone()).collect();
        self.submit_files(&paths, message).map(|change| change.to_string())
    }

    fn pending_changes(
        &self,
        options: &CommitOptions,
        max_bytes: usize,
        encoding: &dyn Fn(&Path) -> IdeResult<TextEncoding>,
    ) -> IdeResult<Vec<PendingChange>> {
        let files = self.commit_selection(options)?;
        let moved: Vec<String> = files.iter().filter_map(|f| f.moved_from.clone()).collect();
        let mut budget = max_bytes;
        let mut changes = Vec::new();
        for file in files.iter().filter(|f| !(f.action == "move/delete" && moved.contains(&f.rel_path))) {
            let path = file.path.0.clone();
            let status = match file.action.as_str() {
                "add" | "branch" | "import" => "added",
                "delete" | "move/delete" => "deleted",
                "move/add" => "renamed",
                _ => "modified",
            };
            let binary = file.file_type.starts_with("binary") || file.file_type.starts_with("ubinary");
            let mut truncated = false;
            let diff = if binary {
                None
            } else {
                let mut patch = self.working_patch(&path, encoding(&path)?)?;
                if patch.len() > budget {
                    let mut cut = budget;
                    while !patch.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    patch.truncate(cut);
                    truncated = true;
                }
                budget -= patch.len();
                Some(patch)
            };
            changes.push(PendingChange {
                old_path: file.moved_from.as_deref().map(|rel| self.abs(rel)),
                path,
                status,
                diff,
                truncated,
            });
        }
        Ok(changes)
    }

    fn files_added(&self, paths: &[PathBuf]) -> IdeResult<()> {
        self.add(paths, None).map(|_| ())
    }

    fn files_deleted(&self, paths: &[PathBuf]) -> IdeResult<()> {
        self.deleted_on_disk(paths)
    }

    fn file_moved(&self, from: &Path, to: &Path) -> IdeResult<()> {
        self.moved_on_disk(from, to)
    }
}
