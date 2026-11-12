//! Immutable commit metadata, persisted by object id. Ref decorations and graph
//! projections are deliberately never cached as commit metadata.

use crate::Commit;
use crate::repo::{gx, to_string};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use ide_core::IdeResult;
use redb::{Database, ReadOnlyTable, ReadableDatabase, TableDefinition};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::SystemTime;

pub(crate) const COMMITS: TableDefinition<&str, &[u8]> = TableDefinition::new("summaries-v2");
const MESSAGES: TableDefinition<&str, &str> = TableDefinition::new("messages-v1");
const MAX_MEMORY_COMMITS: usize = 4096;
const MAX_MEMORY_MESSAGES: usize = 1024;
const MAX_DIRTY_BATCH: usize = 16_384;

pub(crate) struct IndexedRow {
    pub id: ObjectId,
    pub graph_parents: Vec<ObjectId>,
    pub on_current_branch: bool,
    pub history_path: Option<String>,
}

pub(crate) struct IndexedView {
    pub rows: Vec<IndexedRow>,
    pub positions: HashMap<ObjectId, usize>,
}
impl IndexedView {
    pub fn new(rows: Vec<IndexedRow>) -> Self {
        let positions = rows.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
        Self { rows, positions }
    }
}

type NodeEntry = (Vec<ObjectId>, i64);

#[derive(Default)]
pub(crate) struct LogIndex {
    opened: bool,
    db: Option<Arc<Database>>,
    memory: HashMap<ObjectId, Arc<Commit>>,
    messages: HashMap<ObjectId, String>,
    dirty: Vec<Arc<Commit>>,
    dirty_messages: Vec<(String, String)>,
    pub head: Option<(ObjectId, Option<SystemTime>)>,
    pub reachable: HashSet<ObjectId>,
    pub views: HashMap<String, Arc<IndexedView>>,
    pub nodes: HashMap<ObjectId, NodeEntry>,
    pub shallow: HashSet<ObjectId>,
}

impl LogIndex {
    pub fn db(&self) -> Option<&Arc<Database>> {
        self.db.as_ref()
    }

    pub fn has_cached(&self, id: &ObjectId) -> bool {
        self.memory.contains_key(id) || self.nodes.contains_key(id)
    }

    /// Populates `self.nodes` in post-order so a node is inserted only after all of
    /// its ancestors are in `self.nodes` (preserving completeness across cancellations).
    pub fn ensure_nodes(
        &mut self,
        repo: &gix::Repository,
        tips: &[ObjectId],
        shallow: &HashSet<ObjectId>,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<()> {
        if &self.shallow != shallow {
            self.nodes.clear();
            self.shallow = shallow.clone();
        }
        if tips.iter().all(|id| self.nodes.contains_key(id)) {
            return Ok(());
        }
        let cg = repo.commit_graph_if_enabled().ok().flatten();
        let db = self.db.clone();
        let txn = db.as_ref().and_then(|db| db.begin_read().ok());
        let table = txn.as_ref().and_then(|t| t.open_table(COMMITS).ok());
        let mut stack: Vec<(ObjectId, Option<NodeEntry>)> =
            tips.iter().copied().filter(|id| !self.nodes.contains_key(id)).map(|id| (id, None)).collect();
        let mut visiting: HashSet<ObjectId> = HashSet::new();
        while let Some((id, state)) = stack.pop() {
            if cancel.is_cancelled() {
                return Err(ide_core::IdeError::cancelled());
            }
            if let Some(entry) = state {
                visiting.remove(&id);
                self.nodes.insert(id, entry);
                continue;
            }
            if self.nodes.contains_key(&id) || !visiting.insert(id) {
                continue;
            }
            let (parents, time) = if let Some(cg_commit) = cg.as_ref().and_then(|g| g.commit_by_id(id)) {
                let parents = if shallow.contains(&id) {
                    Vec::new()
                } else {
                    let g = cg.as_ref().unwrap();
                    cg_commit
                        .iter_parents()
                        .map(|p| p.map(|pos| g.id_at(pos).to_owned()).map_err(gx))
                        .collect::<IdeResult<Vec<_>>>()?
                };
                (parents, cg_commit.committer_timestamp() as i64)
            } else {
                let record = self.get_with_table(repo, id, table.as_ref())?;
                let parents = if shallow.contains(&id) {
                    Vec::new()
                } else {
                    record
                        .parents
                        .iter()
                        .map(|s| ObjectId::from_hex(s.as_bytes()).map_err(gx))
                        .collect::<IdeResult<Vec<_>>>()?
                };
                (parents, (record.commit_time_ms / 1000.0) as i64)
            };
            stack.push((id, Some((parents.clone(), time))));
            for parent in parents.into_iter().rev() {
                if !self.nodes.contains_key(&parent) && !visiting.contains(&parent) {
                    stack.push((parent, None));
                }
            }
        }
        drop(table);
        drop(txn);
        if self.dirty.len() >= MAX_DIRTY_BATCH {
            self.flush();
        }
        Ok(())
    }

    /// A permanent DAG: refresh discovers only new objects, then joins arbitrary
    /// changed tips against known ancestry. Reachability is recomputed for resets/deleted refs.
    pub fn graph(
        &mut self,
        repo: &gix::Repository,
        tips: &[ObjectId],
        shallow: &HashSet<ObjectId>,
        first_parent: bool,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<Vec<ObjectId>> {
        self.ensure_nodes(repo, tips, shallow, cancel)?;
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        let mut pending = tips.to_vec();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            ids.push(id);
            if let Some((parents, _)) = self.nodes.get(&id) {
                pending.extend(parents.iter().take(if first_parent { 1 } else { usize::MAX }).rev().copied());
            }
        }
        Ok(ids)
    }

    /// Non-symbolic local and remote branches whose tip can reach each commit in `commits`.
    pub fn containing_branches_batch(
        &mut self,
        repo: &gix::Repository,
        commits: &[ObjectId],
        shallow: &HashSet<ObjectId>,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<Vec<Vec<String>>> {
        if commits.is_empty() {
            return Ok(Vec::new());
        }
        let mut branch_tips: Vec<(String, ObjectId)> = Vec::new();
        let mut unique_tips: Vec<ObjectId> = Vec::new();
        let platform = repo.references().map_err(gx)?;
        for reference in platform.all().map_err(gx)? {
            let Ok(mut reference) = reference else { continue };
            if reference.target().try_name().is_some() {
                continue;
            }
            let full = reference.name().as_bstr().to_owned();
            let Some(short) = full.strip_prefix(b"refs/heads/").or_else(|| full.strip_prefix(b"refs/remotes/")) else {
                continue;
            };
            let label = to_string(short.as_bstr());
            let Ok(id) = reference.peel_to_id().map(|id| id.detach()) else { continue };
            if !self.nodes.contains_key(&id) && repo.find_commit(id).is_err() {
                continue;
            }
            if !unique_tips.contains(&id) {
                unique_tips.push(id);
            }
            branch_tips.push((label, id));
        }
        self.ensure_nodes(repo, &unique_tips, shallow, cancel)?;
        let mut out = Vec::with_capacity(commits.len());
        for chunk in commits.chunks(64) {
            let mut reaches: HashMap<ObjectId, u64> = HashMap::new();
            let mut stack: Vec<(ObjectId, bool)> = Vec::new();
            for &tip in &unique_tips {
                if reaches.contains_key(&tip) {
                    continue;
                }
                stack.push((tip, false));
                while let Some((node, expanded)) = stack.pop() {
                    if cancel.is_cancelled() {
                        return Err(ide_core::IdeError::cancelled());
                    }
                    if reaches.contains_key(&node) {
                        continue;
                    }
                    if !expanded {
                        stack.push((node, true));
                        if let Some((parents, _)) = self.nodes.get(&node) {
                            for &p in parents.iter().rev() {
                                if !reaches.contains_key(&p) {
                                    stack.push((p, false));
                                }
                            }
                        }
                    } else {
                        let mut mask = 0u64;
                        for (bit, &target) in chunk.iter().enumerate() {
                            if node == target {
                                mask |= 1u64 << bit;
                            }
                        }
                        if let Some((parents, _)) = self.nodes.get(&node) {
                            for &p in parents {
                                mask |= reaches.get(&p).copied().unwrap_or(0);
                            }
                        }
                        reaches.insert(node, mask);
                    }
                }
            }
            for (bit, &target) in chunk.iter().enumerate() {
                if !self.nodes.contains_key(&target) {
                    out.push(Vec::new());
                    continue;
                }
                let flag = 1u64 << bit;
                let mut names: Vec<String> = branch_tips
                    .iter()
                    .filter(|(_, tip)| (reaches.get(tip).copied().unwrap_or(0) & flag) != 0)
                    .map(|(name, _)| name.clone())
                    .collect();
                names.sort();
                names.dedup();
                out.push(names);
            }
        }
        Ok(out)
    }

    pub fn open(&mut self, dir: &Path) {
        if self.opened {
            return;
        }
        self.opened = true;
        // Several windows can read the same worktree; redb permits one owning
        // handle per file, shared here rather than silently disabling its index.
        static DATABASES: OnceLock<Mutex<HashMap<std::path::PathBuf, Weak<Database>>>> = OnceLock::new();
        let path = dir.join("commits.redb");
        let mut databases = DATABASES.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner());
        self.db = databases.get(&path).and_then(Weak::upgrade).or_else(|| {
            let db = Arc::new(std::fs::create_dir_all(dir).ok().and_then(|_| Database::create(&path).ok())?);
            databases.insert(path, Arc::downgrade(&db));
            Some(db)
        });
    }

    pub fn get(&mut self, repo: &gix::Repository, id: ObjectId) -> IdeResult<Arc<Commit>> {
        self.get_with_table(repo, id, None)
    }

    pub fn get_with_table(
        &mut self,
        repo: &gix::Repository,
        id: ObjectId,
        open_table: Option<&ReadOnlyTable<&str, &[u8]>>,
    ) -> IdeResult<Arc<Commit>> {
        if let Some(commit) = self.memory.get(&id) {
            return Ok(commit.clone());
        }
        let key = id.to_string();
        let cached = if let Some(table) = open_table {
            table
                .get(key.as_str())
                .ok()
                .flatten()
                .and_then(|v| serde_json::from_slice::<Commit>(v.value()).ok())
                .filter(|c| c.id == key)
        } else {
            self.db.as_ref().and_then(|db| {
                let txn = db.begin_read().ok()?;
                let table = txn.open_table(COMMITS).ok()?;
                let value = table.get(key.as_str()).ok()??;
                serde_json::from_slice::<Commit>(value.value()).ok().filter(|c| c.id == key)
            })
        };
        let commit = if let Some(commit) = cached {
            Arc::new(commit)
        } else {
            let commit = repo.find_commit(id).map_err(gx)?;
            let author = commit.author().map_err(gx)?;
            let committer = commit.committer().map_err(gx)?;
            let raw = commit.message_raw_sloppy();
            let summary = raw.split(|b| *b == b'\n').find(|l| !l.trim().is_empty()).unwrap_or_default().trim();
            let summary_text = to_string(summary.as_bstr());
            let record = Arc::new(Commit {
                id: key.clone(),
                short_id: key[..key.len().min(8)].to_string(),
                parents: commit.parent_ids().map(|p| p.to_string()).collect(),
                graph_parents: None,
                graph_dashed: Vec::new(),
                dashed: Vec::new(),
                on_current_branch: None,
                author: to_string(author.name.trim().as_bstr()),
                email: to_string(author.email.trim().as_bstr()),
                committer: to_string(committer.name.trim().as_bstr()),
                committer_email: to_string(committer.email.trim().as_bstr()),
                time_ms: author.time().map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0),
                commit_time_ms: committer.time().map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0),
                summary: summary_text.clone(),
                message: summary_text,
                message_truncated: raw.trim() != summary,
                history_path: None,
                log_position: None,
                log_total: None,
                graph_boundary_parents: Vec::new(),
                refs: Vec::new(),
            });
            if self.db.is_some() {
                self.dirty.push(record.clone());
                if open_table.is_none() && self.dirty.len() >= MAX_DIRTY_BATCH {
                    self.flush();
                }
            }
            record
        };
        // Keep hot pages in memory; older metadata stays in the persistent index.
        if self.memory.len() >= MAX_MEMORY_COMMITS {
            self.memory.clear();
        }
        self.memory.insert(id, commit.clone());
        Ok(commit)
    }

    pub fn message(&mut self, repo: &gix::Repository, id: ObjectId) -> IdeResult<String> {
        if let Some(message) = self.messages.get(&id) {
            return Ok(message.clone());
        }
        let key = id.to_string();
        let cached = self.db.as_ref().and_then(|db| {
            let txn = db.begin_read().ok()?;
            let table = txn.open_table(MESSAGES).ok()?;
            Some(table.get(key.as_str()).ok()??.value().to_string())
        });
        let message = if let Some(message) = cached {
            message
        } else {
            let message = to_string(repo.find_commit(id).map_err(gx)?.message_raw_sloppy()).trim_end().to_string();
            if self.db.is_some() {
                self.dirty_messages.push((key, message.clone()));
            }
            message
        };
        if self.messages.len() >= MAX_MEMORY_MESSAGES {
            self.messages.clear();
        }
        self.messages.insert(id, message.clone());
        Ok(message)
    }

    pub fn flush(&mut self) {
        if !self.dirty.is_empty() || !self.dirty_messages.is_empty() {
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                let Some(db) = &self.db else {
                    return Ok(());
                };
                let txn = db.begin_write()?;
                {
                    let mut table = txn.open_table(COMMITS)?;
                    for commit in &self.dirty {
                        let bytes = serde_json::to_vec(commit.as_ref())?;
                        table.insert(commit.id.as_str(), bytes.as_slice())?;
                    }
                }
                {
                    let mut table = txn.open_table(MESSAGES)?;
                    for (id, message) in &self.dirty_messages {
                        table.insert(id.as_str(), message.as_str())?;
                    }
                }
                txn.commit()?;
                Ok(())
            })();
            if let Err(error) = result {
                tracing::warn!("Git log cache write failed: {error}");
            }
            self.dirty_messages.clear();
            self.dirty.clear();
        }
        if self.memory.len() > MAX_MEMORY_COMMITS {
            self.memory.clear();
        }
    }
}

pub(crate) fn normalize_user(user: &str) -> String {
    user.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

pub(crate) fn matches_user(query: &str, name: &str, email: &str) -> bool {
    let query_name = query.split('<').next().unwrap_or(query).trim();
    let query_email = query.split('<').nth(1).map(|s| s.trim_end_matches('>')).unwrap_or(query);
    let target =
        [normalize_user(name), normalize_user(email), normalize_user(email.split('@').next().unwrap_or(email))];
    [query_name, query_email, query_email.split('@').next().unwrap_or(query_email)]
        .iter()
        .any(|alias| target.contains(&normalize_user(alias)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args([
                "-c",
                "init.defaultBranch=main",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str, msg: &str) -> ObjectId {
        std::fs::write(dir.join(file), msg).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-qm", msg]);
        ObjectId::from_hex(git(dir, &["rev-parse", "HEAD"]).as_bytes()).unwrap()
    }

    #[test]
    fn postorder_ensure_nodes_and_containing_branches_stay_complete_across_partial_state() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        let c0 = commit(dir, "a.txt", "c0");
        let c1 = commit(dir, "a.txt", "c1");
        let c2 = commit(dir, "a.txt", "c2");
        git(dir, &["branch", "feature", &c1.to_string()]);
        let repo = gix::open(dir).unwrap();
        let shallow = HashSet::new();
        let mut index = LogIndex::default();

        // Populate up to c1 first, then ensure c2 reuses c0..c1 and completes up to c2.
        index.ensure_nodes(&repo, &[c1], &shallow, &ide_core::CancellationToken::new()).unwrap();
        assert!(index.nodes.contains_key(&c0) && index.nodes.contains_key(&c1));
        assert!(!index.nodes.contains_key(&c2));

        let cancel = ide_core::CancellationToken::new();
        cancel.cancel();
        assert!(index.ensure_nodes(&repo, &[c2], &shallow, &cancel).is_err());
        assert!(!index.nodes.contains_key(&c2));

        let branches = index
            .containing_branches_batch(&repo, &[c0, c1, c2], &shallow, &ide_core::CancellationToken::new())
            .unwrap();
        assert_eq!(branches[0], vec!["feature".to_string(), "main".to_string()]);
        assert_eq!(branches[1], vec!["feature".to_string(), "main".to_string()]);
        assert_eq!(branches[2], vec!["main".to_string()]);
    }
}
