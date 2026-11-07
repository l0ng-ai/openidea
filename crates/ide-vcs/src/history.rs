//! Commit history (topological walk) and per-commit changed files via gitoxide.

use crate::repo::{gx, resolve, to_string};
use crate::{ChangeKind, ChangedFile, Commit, LogOrder, LogQuery, Repo, RevisionChange};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::{HashMap, HashSet};

/// Log "Text or hash" filter: the message (substring or regex), or a hash prefix.
enum TextFilter {
    /// Commits `git log --grep` selected, or whose id starts with `hash`.
    Selected {
        ids: HashSet<ObjectId>,
        hash: Option<String>,
    },
    /// Case-insensitive non-ASCII text: git folds case only for ASCII under the C locale.
    Folded(String),
    Regex(regex_lite::Regex),
}

impl TextFilter {
    fn new(
        r: &Repo,
        scopes: &[String],
        q: &LogQuery,
        text: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<Self>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        if q.text_regex {
            let re = regex_lite::RegexBuilder::new(text)
                .case_insensitive(!q.text_match_case)
                .multi_line(true)
                .build()
                .map_err(|e| IdeError::invalid(format!("invalid regular expression: {e}")))?;
            return Ok(Some(Self::Regex(re)));
        }
        if !q.text_match_case && !text.is_ascii() {
            return Ok(Some(Self::Folded(text.to_lowercase())));
        }
        let mut filter = vec!["--fixed-strings".to_string(), format!("--grep={text}")];
        if !q.text_match_case {
            filter.push("--regexp-ignore-case".into());
        }
        let ids = git_select(r, scopes, &filter, &[], q.first_parent, cancel)?;
        let hash = (text.len() >= 4 && text.bytes().all(|b| b.is_ascii_hexdigit())).then(|| text.to_ascii_lowercase());
        Ok(Some(Self::Selected { ids, hash }))
    }

    fn matches(&self, repo: &gix::Repository, index: &mut crate::log_index::LogIndex, id: ObjectId) -> IdeResult<bool> {
        Ok(match self {
            Self::Regex(re) => re.is_match(&index.message(repo, id)?),
            Self::Folded(needle) => index.message(repo, id)?.to_lowercase().contains(needle.as_str()),
            Self::Selected { ids, hash } => {
                ids.contains(&id) || hash.as_ref().is_some_and(|h| id.to_string().starts_with(h.as_str()))
            }
        })
    }
}

/// Commits git selects from each scope with `filter`. Path limiting uses git's history
/// simplification and, when the repository has them, changed-path Bloom filters.
fn git_select(
    r: &Repo,
    scopes: &[String],
    filter: &[String],
    paths: &[String],
    first_parent: bool,
    cancel: &CancellationToken,
) -> IdeResult<HashSet<ObjectId>> {
    let mut ids = HashSet::new();
    for scope in scopes {
        let mut args =
            vec!["log".to_string(), "--format=%H".into(), "--no-show-signature".into(), "--no-follow".into()];
        if first_parent {
            args.push("--first-parent".into());
        }
        args.extend(filter.iter().cloned());
        let revs: Vec<String> = scope.split_whitespace().map(str::to_string).collect();
        // Past this many bytes of paths the command line risks Windows' ~32K limit.
        let long_paths = paths.iter().map(|p| p.len() + 12).sum::<usize>() > 8 * 1024;
        let long_revs = revs.iter().map(|p| p.len() + 12).sum::<usize>() > 8 * 1024;
        let stdin = if long_revs {
            Some(stdin_args(&revs, &[], paths))
        } else if long_paths {
            Some(paths_stdin(paths))
        } else {
            None
        };
        if stdin.is_some() {
            args.push("--stdin".into());
        }
        args.push("--end-of-options".into());
        if !long_revs {
            args.extend(revs);
        }
        if !long_paths && !long_revs {
            args.push("--".into());
            args.extend(paths.iter().map(|p| format!(":(literal){p}")));
        }
        let output = run_log(r, args, stdin.as_deref(), cancel)?;
        for line in output.stdout_str().lines() {
            ids.insert(ObjectId::from_hex(line.as_bytes()).map_err(gx)?);
        }
    }
    Ok(ids)
}

/// Stdin for `git log --stdin` that limits the walk to `paths`, however many there are.
fn paths_stdin(paths: &[String]) -> String {
    let mut text = String::from("--\n");
    for p in paths {
        text.push_str(&format!(":(literal){p}\n"));
    }
    text
}

/// Stdin for `git log --stdin` carrying `revs` and `exclusions` followed by the `paths`,
/// however many of them there are; everything after `--` limits the walk.
fn stdin_args(revs: &[String], excluded: &[String], paths: &[String]) -> String {
    let mut text = revs.iter().chain(excluded).map(|rev| format!("{rev}\n")).collect::<String>();
    text.push_str("--\n");
    for p in paths {
        text.push_str(":(literal)");
        text.push_str(p);
        text.push('\n');
    }
    text
}

fn run_log(
    r: &Repo,
    args: Vec<String>,
    stdin: Option<&str>,
    cancel: &CancellationToken,
) -> IdeResult<crate::cli::Output> {
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    match stdin {
        Some(text) => crate::cli::run_cancellable_stdin(r.root(), &argv, text.as_bytes(), cancel),
        None => crate::cli::run_cancellable(r.root(), &argv, cancel),
    }
}

/// The commits of a file's history and the path it had in each. The commits that changed
/// the path, merges included (`--full-history --simplify-merges`); where it appears, a
/// rename from any parent continues the history under the old path from that parent.
/// Unlike `--follow`, this sees renames done in merges and history merged in from other
/// branches.
fn file_history(
    r: &Repo,
    scopes: &[String],
    rel: &str,
    first_parent: bool,
    cancel: &CancellationToken,
) -> IdeResult<(HashSet<ObjectId>, HashMap<ObjectId, String>)> {
    let mut ids = HashSet::new();
    let mut paths = HashMap::new();
    let mut starts: std::collections::VecDeque<(Vec<String>, String)> =
        scopes.iter().map(|s| (s.split_whitespace().map(str::to_string).collect(), rel.to_string())).collect();
    let mut started = HashSet::new();
    while let Some((revs, path)) = starts.pop_front() {
        if !started.insert((revs.clone(), path.clone())) {
            continue;
        }
        let mut opts: Vec<String> =
            ["log", "--format=%x00%H", "--name-status", "-z", "--full-history", "--simplify-merges", "--no-follow"]
                .map(String::from)
                .into();
        if first_parent {
            opts.push("--first-parent".into());
        }
        let pathspec = ["--".to_string(), format!(":(literal){path}")];
        // `excluded` can name a revision per created file, so it goes through stdin.
        let run = |excluded: &[String]| -> IdeResult<Vec<(ObjectId, Option<char>)>> {
            let mut args = opts.clone();
            let long = revs.iter().chain(excluded).map(|p| p.len() + 12).sum::<usize>()
                + pathspec.iter().map(|p| p.len() + 12).sum::<usize>()
                > 8 * 1024;
            let stdin = long
                .then(|| stdin_args(&revs, excluded, std::slice::from_ref(&path)))
                .or_else(|| (!excluded.is_empty()).then(|| excluded.join("\n") + "\n"));
            if stdin.is_some() {
                args.push("--stdin".into());
            }
            args.push("--end-of-options".into());
            if !long {
                args.extend(revs.iter().cloned());
                args.extend(pathspec.iter().cloned());
            }
            Ok(parse_name_status_log(&run_log(r, args, stdin.as_deref(), cancel)?.stdout_str()))
        };
        let records = run(&[])?;
        // Where the file appears its history ends: what is behind that is another file of
        // the same name (a rename continues the history below). The commits of the history
        // are those not behind a creation; the statuses come from the full listing (with
        // its parents excluded a merge shows no changes).
        let created: Vec<ObjectId> = records.iter().filter(|(_, s)| *s == Some('A')).map(|(id, _)| *id).collect();
        let kept: Option<HashSet<ObjectId>> = if created.is_empty() {
            None
        } else {
            let excluded: Vec<String> = created.iter().map(|id| format!("^{id}^@")).collect();
            Some(run(&excluded)?.into_iter().map(|(id, _)| id).collect())
        };
        let mut created = Vec::new();
        for (id, first_status) in records {
            if kept.as_ref().is_some_and(|k| !k.contains(&id)) || !ids.insert(id) {
                continue;
            }
            paths.insert(id, path.clone());
            if first_status == Some('A') {
                created.push(id);
            }
        }
        for commit in created {
            let line = crate::cli::run_cancellable(
                r.root(),
                &["rev-list", "--parents", "-n", "1", "--end-of-options", &commit.to_string()],
                cancel,
            )?
            .stdout_str();
            let parents: Vec<&str> =
                line.split_whitespace().skip(1).take(if first_parent { 1 } else { usize::MAX }).collect();
            for parent in parents {
                if let Some(old) = renamed_from(r, parent, &commit.to_string(), &path, cancel)? {
                    starts.push_back((vec![parent.to_string()], old));
                }
            }
        }
    }
    Ok((ids, paths))
}

/// `git log --format=%x00%H --name-status -z`: each commit with the status letter of its
/// first change (none for a merge listed without changes).
fn parse_name_status_log(text: &str) -> Vec<(ObjectId, Option<char>)> {
    let mut out: Vec<(ObjectId, Option<char>)> = Vec::new();
    let mut tokens = text.split('\0');
    while let Some(token) = tokens.next() {
        let token = token.trim_start_matches('\n');
        if let Ok(id) = ObjectId::from_hex(token.as_bytes()) {
            out.push((id, None));
            continue;
        }
        let Some(status) = token.chars().next().filter(|c| c.is_ascii_uppercase()) else { continue };
        if !token[1..].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let paths = if matches!(status, 'R' | 'C') { 2 } else { 1 };
        for _ in 0..paths {
            tokens.next();
        }
        if let Some(last) = out.last_mut() {
            last.1.get_or_insert(status);
        }
    }
    out
}

/// The path `path` had in `parent` when `commit` renamed it.
fn renamed_from(
    r: &Repo,
    parent: &str,
    commit: &str,
    path: &str,
    cancel: &CancellationToken,
) -> IdeResult<Option<String>> {
    let args = ["diff", "-M", "--name-status", "-z", "--diff-filter=R", "--no-ext-diff", parent, commit, "--"];
    let text = crate::cli::run_cancellable(r.root(), &args, cancel)?.stdout_str();
    let mut tokens = text.split('\0');
    while let Some(status) = tokens.next() {
        if !status.starts_with('R') {
            continue;
        }
        let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else { break };
        if new == path {
            return Ok(Some(old.to_string()));
        }
    }
    Ok(None)
}

pub(crate) fn log(r: &Repo, q: &LogQuery, cancel: &CancellationToken) -> IdeResult<Vec<Commit>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let mut index = r.log_index.lock().unwrap_or_else(|p| p.into_inner());
    let result = if q.summary_only {
        let mut all = q.clone();
        all.skip = 0;
        all.limit = 0;
        all.seek = None;
        all.retain_until = None;
        all.request = None;
        all.stop_at = None;
        let refs = r.log_refs()?;
        let shallow = r
            .gix()?
            .shallow_commits()
            .map_err(gx)?
            .map(|ids| ids.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        let key = format!("{}:{refs:?}:{shallow:?}", serde_json::to_string(&all).map_err(gx)?);
        let cached = index.views.get(&key).cloned();
        let view = if let Some(cached) = cached {
            cached
        } else {
            // Immutable metadata is reused across roots, filters, merges and ref changes.
            all.request = q.request;
            let commits =
                std::sync::Arc::new(crate::log_index::IndexedView::new(log_indexed(r, &all, cancel, &mut index)?));
            if index.views.len() >= 4 {
                index.views.clear();
            }
            index.views.insert(key, commits.clone());
            commits
        };
        let start = q
            .seek
            .as_ref()
            .and_then(|id| view.positions.get(id).copied())
            .map(|i| i.saturating_sub(if q.limit == 0 { 50 } else { 50.min(q.limit as usize / 2) }))
            .unwrap_or(q.skip as usize);
        let retain = q.retain_until.as_ref().and_then(|id| view.positions.get(id).copied()).map(|i| i + 1).unwrap_or(0);
        let limit = if q.limit == 0 { usize::MAX } else { (q.limit as usize).max(retain.saturating_sub(start)) };
        let mut result = Vec::new();
        for (i, c) in view.commits.iter().enumerate().skip(start).take(limit) {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let mut c = c.clone();
            c.log_position = Some(i as u32);
            c.log_total = Some(view.commits.len() as u32);
            let stop = q.stop_at.as_ref() == Some(&c.id);
            result.push(c);
            if stop {
                break;
            }
        }
        Ok(result)
    } else {
        log_indexed(r, q, cancel, &mut index)
    };
    index.flush();
    result
}

fn log_indexed(
    r: &Repo,
    q: &LogQuery,
    cancel: &CancellationToken,
    index: &mut crate::log_index::LogIndex,
) -> IdeResult<Vec<Commit>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let repo = r.gix()?;
    let shallow: HashSet<ObjectId> =
        repo.shallow_commits().map_err(gx)?.map(|ids| ids.iter().copied().collect()).unwrap_or_default();
    let range = q.range.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let revs: Vec<&str> = q.branch.iter().chain(&q.branches).map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
    let ranges: Vec<_> = q.ranges.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let tips =
        if range.is_some() || (!ranges.is_empty() && revs.is_empty()) { Vec::new() } else { tips(&repo, &revs)? };
    if tips.is_empty() && range.is_none() && ranges.is_empty() {
        return Ok(Vec::new());
    }
    let decorations = decorations(&repo)?;
    let paths: Vec<String> = q
        .path
        .iter()
        .chain(&q.paths)
        .map(|p| r.rel_path(p))
        .collect::<IdeResult<Vec<_>>>()?
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    let range_ids = if let Some(range) = range {
        Some(range_ids(r, range, q.order, q.first_parent, cancel)?)
    } else if !ranges.is_empty() {
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for range in &ranges {
            for id in range_ids(r, range, q.order, q.first_parent, cancel)? {
                if seen.insert(id) {
                    ids.push(id);
                }
            }
        }
        if !tips.is_empty() {
            for id in range_ids(
                r,
                &tips.iter().map(ToString::to_string).collect::<Vec<_>>().join(" "),
                q.order,
                q.first_parent,
                cancel,
            )? {
                if seen.insert(id) {
                    ids.push(id);
                }
            }
        }
        Some(sort_subset(&repo, ids, q.order, q.first_parent, &shallow, cancel, &index.nodes)?)
    } else {
        None
    };
    let scopes = if let Some(range) = range {
        vec![range.to_string()]
    } else {
        let mut scopes = ranges.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        if !tips.is_empty() {
            scopes.push(tips.iter().map(ToString::to_string).collect::<Vec<_>>().join(" "));
        }
        scopes
    };
    let mut history_paths = HashMap::new();
    let path_ids = if paths.is_empty() {
        None
    } else if q.follow && paths.len() == 1 && !r.root().join(&paths[0]).is_dir() {
        // Following renames is for a file: a directory gains files all the time, and each
        // creation would cut its history short.
        let (ids, at) = file_history(r, &scopes, &paths[0], q.first_parent, cancel)?;
        history_paths = at;
        Some(ids)
    } else {
        Some(git_select(r, &scopes, &[], &paths, q.first_parent, cancel)?)
    };
    let authors: Vec<_> =
        q.author.iter().chain(&q.authors).map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
    let mut visibility = Visibility {
        speed_refs: &decorations,
        query: q,
        path_ids,
        range_ids: range_ids.as_ref().map(|ids| ids.iter().copied().collect()),
        authors,
        text: q.text.as_deref().map(|t| TextFilter::new(r, &scopes, q, t, cancel)).transpose()?.flatten(),
        matches: HashMap::new(),
        projected: HashMap::new(),
        cancel,
        index,
        shallow: shallow.clone(),
    };
    type Walk<'a> = Box<dyn Iterator<Item = IdeResult<ObjectId>> + 'a>;
    let walk: Walk<'_> = if let Some(ids) = range_ids {
        Box::new(ids.into_iter().map(Ok))
    } else if q.summary_only {
        let ids = visibility.index.graph(&repo, &tips, &shallow, q.first_parent, cancel)?;
        Box::new(
            sort_subset(&repo, ids, q.order, q.first_parent, &shallow, cancel, &visibility.index.nodes)?
                .into_iter()
                .map(Ok),
        )
    } else if repo.is_shallow().unwrap_or(false) || q.request.is_some() {
        // The process can be interrupted even during indegree preparation. Git also
        // respects shallow boundaries while retaining a topological order.
        let mut args = vec![
            "rev-list".to_string(),
            match q.order {
                LogOrder::Topo | LogOrder::Standard => "--topo-order",
                LogOrder::Date => "--date-order",
            }
            .into(),
        ];
        if q.first_parent {
            args.push("--first-parent".into());
        }
        if q.limit > 0
            && q.order != LogOrder::Standard
            && paths.is_empty()
            && q.authors.is_empty()
            && q.author.is_none()
            && q.text.as_deref().is_none_or(|text| text.trim().is_empty())
            && !q.no_merges
            && q.since_ms.is_none()
            && q.until_ms.is_none()
        {
            args.push(format!("--max-count={}", u64::from(q.skip) + u64::from(q.limit)));
        }
        args.push("--end-of-options".into());
        args.extend(tips.iter().map(ToString::to_string));
        let result =
            crate::cli::run_cancellable(r.root(), &args.iter().map(String::as_str).collect::<Vec<_>>(), cancel)?;
        let ids = result
            .stdout_str()
            .lines()
            .map(|line| ObjectId::from_hex(line.as_bytes()).map_err(gx))
            .collect::<IdeResult<Vec<_>>>()?;
        if repo.is_shallow().unwrap_or(false) {
            // A separately bounded walk provides the domain; pagination must never
            // turn a shallow boundary into a connection through a locally present object.
            let mut boundary_args = vec!["rev-list", "--end-of-options"];
            let ids_as_text: Vec<_> = tips.iter().map(ToString::to_string).collect();
            boundary_args.extend(ids_as_text.iter().map(String::as_str));
            let boundaries = crate::cli::run_cancellable(r.root(), &boundary_args, cancel)?;
            visibility.range_ids = Some(
                boundaries
                    .stdout_str()
                    .lines()
                    .map(|id| ObjectId::from_hex(id.as_bytes()).map_err(gx))
                    .collect::<IdeResult<HashSet<_>>>()?,
            );
        }
        Box::new(ids.into_iter().map(Ok))
    } else {
        use gix::traverse::commit::{Parents, topo};
        let graph = repo.commit_graph_if_enabled().ok().flatten();
        let sorting = match q.order {
            LogOrder::Topo | LogOrder::Standard => topo::Sorting::TopoOrder,
            LogOrder::Date => topo::Sorting::DateOrder,
        };
        let topo = topo::Builder::from_iters(&repo.objects, tips, None::<Vec<ObjectId>>)
            .sorting(sorting)
            .parents(if q.first_parent { Parents::First } else { Parents::All })
            .with_commit_graph(graph)
            .build()
            .map_err(gx)?;
        Box::new(topo.map(|info| info.map(|i| i.id).map_err(gx)))
    };
    let walk: Walk<'_> = if q.order == LogOrder::Standard {
        let ids = walk.collect::<IdeResult<Vec<_>>>()?;
        Box::new(
            sort_subset(&repo, ids, q.order, q.first_parent, &shallow, cancel, &visibility.index.nodes)?
                .into_iter()
                .map(Ok),
        )
    } else {
        walk
    };
    let head = repo.head_id().ok().map(|id| id.detach());
    let shallow_stamp =
        repo.shallow_file().ok().and_then(|path| std::fs::metadata(path).ok()).and_then(|m| m.modified().ok());
    let stamp = head.map(|id| (id, shallow_stamp));
    if visibility.index.head != stamp {
        let mut additions = Vec::new();
        let mut cursor = head;
        let old_head = visibility.index.head;
        if let (Some((old, old_shallow)), Some(_)) = (old_head, head)
            && old_shallow == shallow_stamp
        {
            while let Some(id) = cursor {
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                if id == old {
                    break;
                }
                let record = visibility.index.get(&repo, id)?;
                if record.parents.len() != 1 {
                    cursor = None;
                    break;
                }
                additions.push(id);
                cursor = Some(ObjectId::from_hex(record.parents[0].as_bytes()).map_err(gx)?);
            }
        } else {
            cursor = None;
        }
        if cursor.is_some() && cursor == old_head.map(|(id, _)| id) {
            visibility.index.reachable.extend(additions);
            visibility.index.head = stamp;
        } else {
            let mut reachable = HashSet::new();
            if let Some(head) = head {
                for item in repo.rev_walk([head]).all().map_err(gx)? {
                    if cancel.is_cancelled() {
                        return Err(IdeError::cancelled());
                    }
                    reachable.insert(item.map_err(gx)?.id);
                }
            }
            visibility.index.reachable = reachable;
            visibility.index.head = stamp;
        }
    }
    let mut out = Vec::new();
    let mut skip = q.skip as usize;
    let limit = if q.limit == 0 { usize::MAX } else { q.limit as usize };
    for item in walk {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let id = item?;
        if !visibility.shows(&repo, id)? {
            continue;
        }
        if skip > 0 {
            skip -= 1;
            continue;
        }
        let record = visibility.index.get(&repo, id)?;
        let parents = record
            .parents
            .iter()
            .map(|p| ObjectId::from_hex(p.as_bytes()).map_err(gx))
            .collect::<IdeResult<Vec<_>>>()?;
        let shown_parents = if shallow.contains(&id) { Vec::new() } else { visibility.parents(&repo, &parents)? };
        let mut commit = (*record).clone();
        commit.graph_dashed = shown_parents.iter().map(|p| !parents.contains(p)).collect();
        commit.dashed = if commit.graph_dashed.iter().any(|d| *d) { commit.graph_dashed.clone() } else { Vec::new() };
        commit.graph_parents = Some(shown_parents.iter().map(ToString::to_string).collect());
        if shallow.contains(&id) {
            commit.graph_boundary_parents = commit.parents.clone();
        }
        commit.on_current_branch = Some(visibility.index.reachable.contains(&id));
        commit.refs = decorations.get(&id).cloned().unwrap_or_default();
        commit.history_path = history_paths.get(&id).cloned();
        if !q.summary_only {
            commit.message = visibility.index.message(&repo, id)?;
            commit.message_truncated = false;
        }
        out.push(commit);
        if out.len() >= limit || q.stop_at.as_deref() == Some(id.to_string().as_str()) {
            break;
        }
    }
    Ok(out)
}

/// A ready-node stack gives incoming merge parents priority, while child counts
/// prevent an ancestor shared with another branch from moving ahead of its children.
fn sort_subset(
    repo: &gix::Repository,
    ids: Vec<ObjectId>,
    order: LogOrder,
    first_parent: bool,
    shallow: &HashSet<ObjectId>,
    cancel: &CancellationToken,
    nodes: &HashMap<ObjectId, (Vec<ObjectId>, i64)>,
) -> IdeResult<Vec<ObjectId>> {
    let positions: HashMap<_, _> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut parents = Vec::with_capacity(ids.len());
    let mut children = vec![0usize; ids.len()];
    let mut times = Vec::with_capacity(ids.len());
    for id in &ids {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let (all_parents, time) = if let Some(record) = nodes.get(id) {
            record.clone()
        } else {
            let commit = repo.find_commit(*id).map_err(gx)?;
            (commit.parent_ids().map(|p| p.detach()).collect(), commit.time().map(|t| t.seconds).unwrap_or(0))
        };
        times.push(time);
        let mut ordered = Vec::new();
        let mut pending: Vec<_> = all_parents
            .into_iter()
            .take(if shallow.contains(id) {
                0
            } else if first_parent {
                1
            } else {
                usize::MAX
            })
            .collect();
        let mut visited = HashSet::new();
        while let Some(parent) = pending.pop() {
            if !visited.insert(parent) {
                continue;
            }
            if let Some(position) = positions.get(&parent) {
                if !ordered.contains(position) {
                    ordered.push(*position);
                }
            } else if !shallow.contains(&parent) && repo.has_object(parent) {
                pending.extend(
                    repo.find_commit(parent)
                        .map_err(gx)?
                        .parent_ids()
                        .take(if first_parent { 1 } else { usize::MAX })
                        .map(|p| p.detach()),
                );
            }
        }
        ordered.reverse();
        for p in &ordered {
            children[*p] += 1;
        }
        parents.push(ordered);
    }
    if order == LogOrder::Standard {
        let refs = decorations(repo)?;
        let mut remote_names = HashSet::new();
        for reference in repo.references().map_err(gx)?.remote_branches().map_err(gx)?.flatten() {
            if let Some(name) = reference.name().as_bstr().strip_prefix(b"refs/remotes/") {
                remote_names.insert(to_string(name.as_bstr()));
            }
        }
        let priority = |i: usize| {
            let labels = refs.get(&ids[i]);
            let best = labels
                .into_iter()
                .flatten()
                .map(|name| {
                    (
                        if name == "HEAD" {
                            0
                        } else if name == "main" || name == "master" {
                            1
                        } else if name.starts_with("tag: ") {
                            4
                        } else if remote_names.contains(name) {
                            3
                        } else {
                            2
                        },
                        name.clone(),
                    )
                })
                .min()
                .unwrap_or((5, ids[i].to_string()));
            (best, i)
        };
        let mut heads: Vec<_> = (0..ids.len()).filter(|i| children[*i] == 0 || refs.contains_key(&ids[*i])).collect();
        heads.sort_by_key(|i| priority(*i));
        let sorted = crate::bek::sort(&parents, &times, &heads);
        return Ok(sorted.into_iter().map(|i| ids[i]).collect());
    }
    let mut ready: std::collections::BTreeSet<_> =
        children.iter().enumerate().filter_map(|(i, count)| (*count == 0).then_some(i)).collect();
    let mut stack = Vec::new();
    let mut dates = std::collections::BinaryHeap::new();
    if order == LogOrder::Date {
        for &i in &ready {
            dates.push((times[i], std::cmp::Reverse(i)));
        }
    }
    let mut emitted = HashSet::new();
    let mut out = Vec::with_capacity(ids.len());
    while let Some(next) =
        if order == LogOrder::Date { dates.pop().map(|(_, i)| i.0) } else { stack.pop().or_else(|| ready.pop_first()) }
    {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if !emitted.insert(next) {
            continue;
        }
        ready.remove(&next);
        out.push(ids[next]);
        let ordered: Vec<_> =
            if order == LogOrder::Topo { parents[next].iter().rev().copied().collect() } else { parents[next].clone() };
        for parent in ordered {
            children[parent] -= 1;
            if children[parent] == 0 {
                ready.insert(parent);
                stack.push(parent);
                if order == LogOrder::Date {
                    dates.push((times[parent], std::cmp::Reverse(parent)));
                }
            }
        }
    }
    Ok(out)
}

/// Visibility and graph projection share exactly the same predicates. Revision parents
/// remain immutable; only graph parents skip hidden commits. Memoisation avoids walking
/// the same hidden ancestry for each visible child, without a truncation limit.
struct Visibility<'a> {
    speed_refs: &'a HashMap<ObjectId, Vec<String>>,
    query: &'a LogQuery,
    path_ids: Option<HashSet<ObjectId>>,
    range_ids: Option<HashSet<ObjectId>>,
    authors: Vec<String>,
    text: Option<TextFilter>,
    matches: HashMap<ObjectId, bool>,
    projected: HashMap<ObjectId, Vec<ObjectId>>,
    cancel: &'a CancellationToken,
    index: &'a mut crate::log_index::LogIndex,
    shallow: HashSet<ObjectId>,
}

impl Visibility<'_> {
    fn shows(&mut self, repo: &gix::Repository, id: ObjectId) -> IdeResult<bool> {
        if self.cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if let Some(shown) = self.matches.get(&id) {
            return Ok(*shown);
        }
        let shown = if !repo.has_object(id)
            || self.path_ids.as_ref().is_some_and(|ids| !ids.contains(&id))
            || self.range_ids.as_ref().is_some_and(|ids| !ids.contains(&id))
        {
            false
        } else {
            let commit = self.index.get(repo, id)?;
            let time = commit.commit_time_ms;
            let name = commit.author.to_lowercase();
            let email = commit.email.to_lowercase();
            !(self.query.no_merges && commit.parents.len() > 1)
                && self.query.since_ms.is_none_or(|s| time >= s)
                && self.query.until_ms.is_none_or(|u| time < u)
                && self.query.speed_search.as_ref().is_none_or(|query| {
                    let mut columns =
                        vec![commit.summary.clone(), self.speed_refs.get(&id).cloned().unwrap_or_default().join(" ")];
                    if self.query.search_fields.iter().any(|f| f == "author") {
                        columns.push(commit.author.clone());
                    }
                    if self.query.search_fields.iter().any(|f| f == "hash") {
                        columns.push(commit.short_id.clone());
                    }
                    query.to_lowercase().split_whitespace().all(|word| {
                        columns.iter().any(|column| {
                            let mut chars = word.chars().peekable();
                            for c in column.to_lowercase().chars() {
                                if chars.peek() == Some(&c) {
                                    chars.next();
                                }
                            }
                            chars.peek().is_none()
                        })
                    })
                })
                && (self.authors.is_empty()
                    || self.authors.iter().any(|a| {
                        if self.query.authors_exact {
                            crate::log_index::matches_user(a, &name, &email)
                        } else {
                            name.contains(a.as_str()) || email.contains(a.as_str())
                        }
                    }))
                && match &self.text {
                    Some(text) => text.matches(repo, self.index, id)?,
                    None => true,
                }
        };
        self.matches.insert(id, shown);
        Ok(shown)
    }

    fn parents(&mut self, repo: &gix::Repository, parents: &[ObjectId]) -> IdeResult<Vec<ObjectId>> {
        let parents = if self.query.first_parent { &parents[..parents.len().min(1)] } else { parents };
        let mut out = Vec::new();
        for parent in parents {
            // Iterative postorder: a long hidden chain must not consume the call stack.
            let mut stack = vec![(*parent, false)];
            while let Some((id, expanded)) = stack.pop() {
                if self.projected.contains_key(&id) {
                    continue;
                }
                if self.shows(repo, id)? {
                    self.projected.insert(id, vec![id]);
                } else if !repo.has_object(id) {
                    self.projected.insert(id, Vec::new());
                } else {
                    let commit = self.index.get(repo, id)?;
                    let ancestors = commit
                        .parents
                        .iter()
                        .take(if self.shallow.contains(&id) {
                            0
                        } else if self.query.first_parent {
                            1
                        } else {
                            usize::MAX
                        })
                        .map(|p| ObjectId::from_hex(p.as_bytes()).map_err(gx))
                        .collect::<IdeResult<Vec<_>>>()?;
                    if !expanded {
                        stack.push((id, true));
                        stack.extend(ancestors.iter().rev().map(|p| (*p, false)));
                    } else {
                        let mut nearest = Vec::new();
                        for p in ancestors {
                            for ancestor in self.projected.get(&p).into_iter().flatten() {
                                if !nearest.contains(ancestor) {
                                    nearest.push(*ancestor);
                                }
                            }
                        }
                        self.projected.insert(id, nearest);
                    }
                }
            }
            for ancestor in &self.projected[parent] {
                if !out.contains(ancestor) {
                    out.push(*ancestor);
                }
            }
        }
        Ok(out)
    }
}

/// Commit ids of a revision range (`A..B`, `A...B`, `^A B`…), topologically ordered, via
/// `git rev-list` so every rev syntax git understands (`@{u}`, `HEAD~3`) works.
fn range_ids(
    r: &Repo,
    range: &str,
    order: LogOrder,
    first_parent: bool,
    cancel: &CancellationToken,
) -> IdeResult<Vec<ObjectId>> {
    let mut args: Vec<&str> = vec!["rev-list", if order == LogOrder::Date { "--date-order" } else { "--topo-order" }];
    if first_parent {
        args.push("--first-parent");
    }
    args.push("--end-of-options");
    for part in range.split_whitespace() {
        if part.starts_with('-') {
            return Err(ide_core::IdeError::invalid(format!("invalid revision range '{range}'")));
        }
        args.push(part);
    }
    let out = crate::cli::run_cancellable(r.root(), &args, cancel)?;
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
        let refs = decorations(repo)?;
        let branches: Vec<_> = refs
            .iter()
            .flat_map(|(id, names)| {
                names
                    .iter()
                    .filter(|name| *name != "HEAD" && !name.starts_with("tag: "))
                    .map(move |name| (name.as_str(), *id))
            })
            .collect();
        let mut excludes = Vec::new();
        let includes: Vec<_> = revs.iter().filter(|rev| !rev.starts_with('-')).collect();
        for rev in revs.iter().filter_map(|rev| rev.strip_prefix('-')) {
            let re = if branches.iter().any(|(name, _)| *name == rev) {
                None
            } else {
                Some(
                    regex_lite::Regex::new(&format!("^(?:{rev})$"))
                        .map_err(|e| IdeError::invalid(format!("invalid branch pattern: {e}")))?,
                )
            };
            excludes.push((rev, re));
        }
        if includes.is_empty() {
            for (name, id) in &branches {
                if !excludes.iter().any(|(exact, re)| name == exact || re.as_ref().is_some_and(|re| re.is_match(name)))
                    && !tips.contains(id)
                {
                    tips.push(*id);
                }
            }
        }
        for rev in includes {
            if excludes.iter().any(|(exact, re)| *rev == *exact || re.as_ref().is_some_and(|re| re.is_match(rev))) {
                continue;
            }
            match resolve(repo, rev) {
                Ok(id) => {
                    let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
                    if !tips.contains(&commit.id) {
                        tips.push(commit.id);
                    }
                }
                Err(error) => {
                    let re = regex_lite::Regex::new(&format!("^(?:{rev})$")).map_err(|_| error.clone())?;
                    let matches: Vec<_> = branches
                        .iter()
                        .filter(|(name, _)| {
                            re.is_match(name)
                                && !excludes
                                    .iter()
                                    .any(|(exact, re)| name == exact || re.as_ref().is_some_and(|re| re.is_match(name)))
                        })
                        .collect();
                    if matches.is_empty() && !rev.chars().any(|c| ".*+?[]()|^$".contains(c)) {
                        return Err(error);
                    }
                    for (_, id) in matches {
                        if !tips.contains(id) {
                            tips.push(*id);
                        }
                    }
                }
            }
        }
        return Ok(tips);
    }
    if let Ok(id) = repo.head_id() {
        tips.push(id.detach());
    }
    let platform = repo.references().map_err(gx)?;
    for iter in
        [platform.local_branches().map_err(gx)?, platform.remote_branches().map_err(gx)?, platform.tags().map_err(gx)?]
    {
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
pub(crate) fn decorations(repo: &gix::Repository) -> IdeResult<HashMap<ObjectId, Vec<String>>> {
    let mut map: HashMap<ObjectId, Vec<String>> = HashMap::new();
    if let Ok(id) = repo.head_id() {
        map.entry(id.detach()).or_default().push("HEAD".to_string());
    }
    let platform = repo.references().map_err(gx)?;
    for reference in platform.all().map_err(gx)? {
        let Ok(mut reference) = reference else { continue };
        if reference.target().try_name().is_some() {
            continue;
        }
        let full = reference.name().as_bstr().to_owned();
        let label = if let Some(n) = full.strip_prefix(b"refs/heads/").or_else(|| full.strip_prefix(b"refs/remotes/")) {
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
