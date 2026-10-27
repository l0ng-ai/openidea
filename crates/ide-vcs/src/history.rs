//! Commit history (topological walk) and per-commit changed files via gitoxide.

use crate::repo::{gx, resolve, to_string};
use crate::{ChangeKind, ChangedFile, Commit, LogOrder, LogQuery, Repo, RevisionChange};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use ide_core::{IdeError, IdeResult};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Log "Text or hash" filter: the message (substring or regex), or a hash prefix.
enum TextFilter {
    Plain { needle: String, match_case: bool },
    Regex(regex_lite::Regex),
}

impl TextFilter {
    fn new(text: &str, regex: bool, match_case: bool) -> IdeResult<Option<Self>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        if regex {
            let re = regex_lite::RegexBuilder::new(text)
                .case_insensitive(!match_case)
                .multi_line(true)
                .build()
                .map_err(|e| IdeError::invalid(format!("invalid regular expression: {e}")))?;
            return Ok(Some(Self::Regex(re)));
        }
        let needle = if match_case { text.to_string() } else { text.to_lowercase() };
        Ok(Some(Self::Plain { needle, match_case }))
    }

    fn matches(&self, message: &str, id: &ObjectId) -> bool {
        match self {
            Self::Regex(re) => re.is_match(message),
            Self::Plain { needle, match_case } => {
                let hash = needle.len() >= 4 && needle.bytes().all(|b| b.is_ascii_hexdigit());
                if hash && id.to_string().starts_with(&needle.to_ascii_lowercase()) {
                    return true;
                }
                if *match_case {
                    message.contains(needle.as_str())
                } else {
                    message.to_lowercase().contains(needle.as_str())
                }
            }
        }
    }
}

pub(crate) fn log(r: &Repo, q: &LogQuery) -> IdeResult<Vec<Commit>> {
    let repo = r.gix()?;
    let range = q.range.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let revs: Vec<&str> = q.branch.iter().chain(&q.branches).map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
    let tips = if range.is_some() { Vec::new() } else { tips(&repo, &revs)? };
    if tips.is_empty() && range.is_none() {
        return Ok(Vec::new());
    }
    let decorations = decorations(&repo)?;
    let path_filter = match q.path.as_deref() {
        Some(p) => {
            let rel = r.rel_path(p)?;
            if rel.is_empty() { None } else { Some(rel) }
        }
        None => None,
    };
    let authors: Vec<String> =
        q.author.iter().chain(&q.authors).map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
    let text = q.text.as_deref().map(|t| TextFilter::new(t, q.text_regex, q.text_match_case)).transpose()?.flatten();
    let limit = if q.limit == 0 { usize::MAX } else { q.limit as usize };
    let mut to_skip = q.skip as usize;

    let path_walk = path_filter.is_some();
    type Walk<'a> = Box<dyn Iterator<Item = IdeResult<(ObjectId, Vec<ObjectId>)>> + 'a>;
    let walk: Walk<'_> = if let Some(range) = range {
        let ids = range_ids(r, range, path_filter.as_deref())?;
        let repo = &repo;
        Box::new(ids.into_iter().map(move |id| {
            let commit = repo.find_commit(id).map_err(gx)?;
            Ok((id, commit.parent_ids().map(|p| p.detach()).collect()))
        }))
    } else if let Some(rel) = path_filter {
        Box::new(PathWalk::new(&repo, tips, rel, q.first_parent)?)
    } else if repo.is_shallow().unwrap_or(false) {
        // Topological order needs complete history; shallow clones fall back to date order.
        let mut walk = repo.rev_walk(tips).sorting(gix::revision::walk::Sorting::ByCommitTime(Default::default()));
        if q.first_parent {
            walk = walk.first_parent_only();
        }
        let walk = walk.all().map_err(gx)?;
        Box::new(walk.map(|info| info.map(|i| (i.id, i.parent_ids.to_vec())).map_err(gx)))
    } else {
        use gix::traverse::commit::{Parents, topo};
        let graph = repo.commit_graph_if_enabled().ok().flatten();
        let sorting = match q.order {
            LogOrder::Topo => topo::Sorting::TopoOrder,
            LogOrder::Date => topo::Sorting::DateOrder,
        };
        let topo = topo::Builder::from_iters(&repo.objects, tips, None::<Vec<ObjectId>>)
            .sorting(sorting)
            .parents(if q.first_parent { Parents::First } else { Parents::All })
            .with_commit_graph(graph)
            .build()
            .map_err(gx)?;
        Box::new(topo.map(|info| info.map(|i| (i.id, i.parent_ids.to_vec())).map_err(gx)))
    };

    let shape = Shape {
        no_merges: q.no_merges,
        first_parent: q.first_parent,
        since: q.since_ms.map(|ms| (ms / 1000.0).floor() as i64),
        until: q.until_ms.map(|ms| (ms / 1000.0).ceil() as i64),
    };
    // Walks in (roughly) commit time order can stop once they are well past `since`.
    let time_ordered = range.is_none() && (q.order == LogOrder::Date || path_walk);
    let mut older_run = 0usize;

    let mut out = Vec::new();
    for item in walk {
        let (id, mut parents) = item?;
        if q.first_parent {
            parents.truncate(1);
        }
        let commit = repo.find_commit(id).map_err(gx)?;
        let commit_time = commit.time().map(|t| t.seconds).unwrap_or(0);
        if shape.is_active() {
            let merge = commit.parent_ids().nth(1).is_some();
            if shape.since.is_some_and(|s| commit_time < s) {
                older_run += 1;
                if time_ordered && older_run >= OLDER_RUN_LIMIT {
                    break;
                }
                continue;
            }
            older_run = 0;
            if !shape.shows(merge, commit_time) {
                continue;
            }
            parents = shape.rewrite_parents(&repo, &parents)?;
        }
        let sig = commit.author().map_err(gx)?;
        let name = to_string(sig.name.trim().as_bstr());
        let email = to_string(sig.email.trim().as_bstr());
        if !authors.is_empty() {
            let (name, email) = (name.to_lowercase(), email.to_lowercase());
            if !authors.iter().any(|a| name.contains(a.as_str()) || email.contains(a.as_str())) {
                continue;
            }
        }
        let message = to_string(commit.message_raw_sloppy());
        if let Some(filter) = text.as_ref()
            && !filter.matches(&message, &id)
        {
            continue;
        }
        if to_skip > 0 {
            to_skip -= 1;
            continue;
        }
        let time_ms = sig.time().map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0);
        let summary = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        let hex = id.to_string();
        out.push(Commit {
            short_id: hex[..hex.len().min(8)].to_string(),
            id: hex,
            parents: parents.iter().map(ToString::to_string).collect(),
            author: name,
            email,
            time_ms,
            summary,
            message: message.trim_end().to_string(),
            refs: decorations.get(&id).cloned().unwrap_or_default(),
            commit_time_ms: commit_time as f64 * 1000.0,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Consecutive commits older than `since` after which a time-ordered walk stops.
const OLDER_RUN_LIMIT: usize = 64;

/// Which commits the Log graph shows independently of the detail filters (author, text):
/// `--no-merges` and the date range. Hidden commits are skipped and the parents of shown
/// ones rewritten past them, like git's parent rewriting.
struct Shape {
    no_merges: bool,
    first_parent: bool,
    /// Commit time bounds in seconds; `since` inclusive, `until` exclusive.
    since: Option<i64>,
    until: Option<i64>,
}

/// Upper bound of commits visited while rewriting one commit's parents.
const REWRITE_LIMIT: usize = 4096;

impl Shape {
    fn is_active(&self) -> bool {
        self.no_merges || self.since.is_some() || self.until.is_some()
    }

    fn shows(&self, merge: bool, time: i64) -> bool {
        !(self.no_merges && merge) && self.since.is_none_or(|s| time >= s) && self.until.is_none_or(|u| time < u)
    }

    /// `parents` with each hidden one replaced by its nearest shown ancestors; parents
    /// older than `since` are dropped (their history is not shown).
    fn rewrite_parents(&self, repo: &gix::Repository, parents: &[ObjectId]) -> IdeResult<Vec<ObjectId>> {
        let mut out: Vec<ObjectId> = Vec::new();
        let mut seen: HashSet<ObjectId> = HashSet::new();
        let mut stack: Vec<ObjectId> = parents.iter().rev().copied().collect();
        let mut visited = 0usize;
        while let Some(p) = stack.pop() {
            if !seen.insert(p) || !repo.has_object(p) {
                continue;
            }
            visited += 1;
            if visited > REWRITE_LIMIT {
                break;
            }
            let commit = repo.find_commit(p).map_err(gx)?;
            let time = commit.time().map(|t| t.seconds).unwrap_or(0);
            if self.since.is_some_and(|s| time < s) {
                continue;
            }
            let ids: Vec<ObjectId> = commit.parent_ids().map(|i| i.detach()).collect();
            if self.shows(ids.len() > 1, time) {
                if !out.contains(&p) {
                    out.push(p);
                }
                continue;
            }
            let next = if self.first_parent { &ids[..ids.len().min(1)] } else { &ids[..] };
            stack.extend(next.iter().rev());
        }
        Ok(out)
    }
}

/// Commit ids of a revision range (`A..B`, `A...B`, `^A B`…), topologically ordered, via
/// `git rev-list` so every rev syntax git understands (`@{u}`, `HEAD~3`) works.
fn range_ids(r: &Repo, range: &str, path: Option<&str>) -> IdeResult<Vec<ObjectId>> {
    let mut args: Vec<&str> = vec!["rev-list", "--topo-order", "--end-of-options"];
    for part in range.split_whitespace() {
        if part.starts_with('-') {
            return Err(ide_core::IdeError::invalid(format!("invalid revision range '{range}'")));
        }
        args.push(part);
    }
    if let Some(rel) = path {
        args.extend(["--", rel]);
    }
    let out = crate::cli::run(r.root(), &args, None)?;
    out.stdout_str()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| ObjectId::from_hex(l.trim().as_bytes()).map_err(gx))
        .collect()
}

/// Starting points of the walk: the given revisions, or HEAD + all branches.
fn tips(repo: &gix::Repository, revs: &[&str]) -> IdeResult<Vec<ObjectId>> {
    let mut tips = Vec::new();
    if !revs.is_empty() {
        for rev in revs {
            let id = resolve(repo, rev)?;
            let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
            if !tips.contains(&commit.id) {
                tips.push(commit.id);
            }
        }
        return Ok(tips);
    }
    if let Ok(id) = repo.head_id() {
        tips.push(id.detach());
    }
    let platform = repo.references().map_err(gx)?;
    for iter in [platform.local_branches().map_err(gx)?, platform.remote_branches().map_err(gx)?] {
        for reference in iter {
            let Ok(mut reference) = reference else { continue };
            if let Ok(id) = reference.peel_to_id() {
                let id = id.detach();
                if !tips.contains(&id) && repo.find_commit(id).is_ok() {
                    tips.push(id);
                }
            }
        }
    }
    Ok(tips)
}

/// Commit id → decoration labels.
fn decorations(repo: &gix::Repository) -> IdeResult<HashMap<ObjectId, Vec<String>>> {
    let mut map: HashMap<ObjectId, Vec<String>> = HashMap::new();
    if let Ok(id) = repo.head_id() {
        map.entry(id.detach()).or_default().push("HEAD".to_string());
    }
    let platform = repo.references().map_err(gx)?;
    for reference in platform.all().map_err(gx)? {
        let Ok(mut reference) = reference else { continue };
        let full = reference.name().as_bstr().to_owned();
        let label = if let Some(n) = full.strip_prefix(b"refs/heads/") {
            to_string(n.as_bstr())
        } else if let Some(n) = full.strip_prefix(b"refs/remotes/") {
            if n.ends_with(b"/HEAD") {
                continue;
            }
            to_string(n.as_bstr())
        } else if let Some(n) = full.strip_prefix(b"refs/tags/") {
            format!("tag: {}", to_string(n.as_bstr()))
        } else {
            continue;
        };
        let Ok(id) = reference.peel_to_id() else { continue };
        map.entry(id.detach()).or_default().push(label);
    }
    Ok(map)
}

/// Commits touching a path, newest first, with git's default history simplification:
/// a commit is shown when its entry for the path differs from every parent, and at a
/// merge that kept one parent's version only that parent's line of history is followed.
struct PathWalk<'r> {
    repo: &'r gix::Repository,
    rel: String,
    queue: std::collections::BinaryHeap<(i64, u64, ObjectId)>,
    seen: HashSet<ObjectId>,
    memo: HashMap<ObjectId, Option<ObjectId>>,
    seq: u64,
    first_parent: bool,
}

impl<'r> PathWalk<'r> {
    fn new(repo: &'r gix::Repository, tips: Vec<ObjectId>, rel: String, first_parent: bool) -> IdeResult<Self> {
        let mut walk = PathWalk {
            repo,
            rel,
            queue: Default::default(),
            seen: Default::default(),
            memo: Default::default(),
            seq: 0,
            first_parent,
        };
        for tip in tips {
            walk.push(tip)?;
        }
        Ok(walk)
    }

    fn push(&mut self, id: ObjectId) -> IdeResult<()> {
        if !self.seen.insert(id) || !self.repo.has_object(id) {
            return Ok(());
        }
        let time = self.repo.find_commit(id).map_err(gx)?.time().map(|t| t.seconds).unwrap_or(0);
        // Max-heap on time; among equal times, earlier insertion first.
        self.seq += 1;
        self.queue.push((time, u64::MAX - self.seq, id));
        Ok(())
    }

    fn step(&mut self) -> IdeResult<Option<(ObjectId, Vec<ObjectId>)>> {
        while let Some((_, _, id)) = self.queue.pop() {
            let commit = self.repo.find_commit(id).map_err(gx)?;
            let parents: Vec<ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
            // Parents cut off by a shallow boundary are treated as absent.
            let present: Vec<ObjectId> = parents
                .iter()
                .copied()
                .filter(|p| self.repo.has_object(p))
                .take(if self.first_parent { 1 } else { usize::MAX })
                .collect();
            let mine = path_entry(self.repo, id, &self.rel, &mut self.memo)?;
            let mut same_parent = None;
            for p in &present {
                if path_entry(self.repo, *p, &self.rel, &mut self.memo)? == mine {
                    same_parent = Some(*p);
                    break;
                }
            }
            match same_parent {
                Some(p) => self.push(p)?,
                None => {
                    for p in &present {
                        self.push(*p)?;
                    }
                    if !present.is_empty() || mine.is_some() {
                        return Ok(Some((id, parents)));
                    }
                }
            }
        }
        Ok(None)
    }
}

impl Iterator for PathWalk<'_> {
    type Item = IdeResult<(ObjectId, Vec<ObjectId>)>;
    fn next(&mut self) -> Option<Self::Item> {
        self.step().transpose()
    }
}

/// Id of the tree entry at `rel` in `commit` (memoised).
fn path_entry(
    repo: &gix::Repository,
    commit: ObjectId,
    rel: &str,
    memo: &mut HashMap<ObjectId, Option<ObjectId>>,
) -> IdeResult<Option<ObjectId>> {
    if let Some(v) = memo.get(&commit) {
        return Ok(*v);
    }
    let commit_obj = repo.find_commit(commit).map_err(gx)?;
    let tree = commit_obj.tree().map_err(gx)?;
    let id = tree.lookup_entry_by_path(Path::new(rel)).map_err(gx)?.map(|e| e.object_id());
    memo.insert(commit, id);
    Ok(id)
}

pub(crate) fn commit_files(r: &Repo, rev: &str) -> IdeResult<Vec<ChangedFile>> {
    let repo = r.gix()?;
    Ok(first_parent_changes(&repo, rev)?.files)
}

struct CommitChanges {
    id: ObjectId,
    parent: Option<ObjectId>,
    files: Vec<ChangedFile>,
}

/// Files changed by `rev` relative to its first parent (renames detected), sorted by path.
fn first_parent_changes(repo: &gix::Repository, rev: &str) -> IdeResult<CommitChanges> {
    let id = resolve(repo, rev)?;
    let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
    let id = commit.id;
    let parent = commit.parent_ids().next().map(|p| p.detach());
    let new_tree = commit.tree().map_err(gx)?;
    let old_tree = match parent {
        Some(p) => Some(repo.find_commit(p).map_err(gx)?.tree().map_err(gx)?),
        None => None,
    };
    let mut opts = gix::diff::Options::default();
    opts.track_path().track_rewrites(Some(gix::diff::Rewrites::default()));
    let changes = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(opts)).map_err(gx)?;
    let mut out = Vec::new();
    for change in changes {
        use gix::object::tree::diff::ChangeDetached as C;
        let file = match change {
            C::Addition { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Added, old_path: None }
            }
            C::Deletion { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Deleted, old_path: None }
            }
            C::Modification { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Modified, old_path: None }
            }
            C::Rewrite { source_location, location, entry_mode, copy, .. } if !entry_mode.is_tree() => ChangedFile {
                path: to_string(location.as_ref()),
                kind: if copy { ChangeKind::Added } else { ChangeKind::Renamed },
                old_path: Some(to_string(source_location.as_ref())),
            },
            _ => continue,
        };
        out.push(file);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(CommitChanges { id, parent, files: out })
}

/// One file's change accumulated over several commits.
struct Merged {
    /// Commit before the first change and the file's path there; `None` when it was added.
    before: Option<(String, String)>,
    /// Commit of the last change; `None` when it was deleted.
    after: Option<String>,
    path: String,
}

/// Combined changes of `commits` (oldest first), merged like IDEA merges a multi-commit Git
/// Log selection: per file, the state before the first selected commit that touched it ↔
/// after the last one, following renames. Files added and then deleted drop out.
pub(crate) fn commits_changes(r: &Repo, commits: &[String]) -> IdeResult<Vec<RevisionChange>> {
    let repo = r.gix()?;
    let mut merged: Vec<Merged> = Vec::new();
    let mut seen = HashSet::new();
    for rev in commits {
        let c = first_parent_changes(&repo, rev)?;
        if !seen.insert(c.id) {
            continue;
        }
        let id = c.id.to_string();
        for f in c.files {
            let from = match f.kind {
                ChangeKind::Renamed => f.old_path.as_deref().unwrap_or(&f.path),
                _ => &f.path,
            };
            // A live entry at the path this change starts from, else a deleted one being re-added.
            let existing = merged
                .iter()
                .position(|m| m.after.is_some() && m.path == from)
                .or_else(|| merged.iter().position(|m| m.after.is_none() && m.path == f.path));
            let i = existing.unwrap_or_else(|| {
                let before = match (f.kind, c.parent) {
                    (ChangeKind::Added, _) | (_, None) => None,
                    (_, Some(p)) => Some((p.to_string(), from.to_owned())),
                };
                merged.push(Merged { before, after: None, path: f.path.clone() });
                merged.len() - 1
            });
            let entry = &mut merged[i];
            entry.after = (f.kind != ChangeKind::Deleted).then(|| id.clone());
            entry.path = f.path;
        }
    }
    let mut out: Vec<RevisionChange> = merged
        .into_iter()
        .filter_map(|m| {
            let (kind, path, old_path) = match (&m.before, &m.after) {
                (None, None) => return None,
                (None, Some(_)) => (ChangeKind::Added, m.path, None),
                (Some((_, old)), None) => (ChangeKind::Deleted, old.clone(), None),
                (Some((_, old)), Some(_)) if *old != m.path => (ChangeKind::Renamed, m.path, Some(old.clone())),
                (Some(_), Some(_)) => (ChangeKind::Modified, m.path, None),
            };
            Some(RevisionChange { path, kind, old_path, before: m.before.map(|(rev, _)| rev), after: m.after })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}
