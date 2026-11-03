//! Immutable commit metadata, persisted by object id. Ref decorations and graph
//! projections are deliberately never cached as commit metadata.

use crate::Commit;
use crate::repo::{gx, to_string};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use ide_core::IdeResult;
use redb::{Database, MultimapTableDefinition, ReadableDatabase, TableDefinition};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::SystemTime;

const COMMITS: TableDefinition<&str, &[u8]> = TableDefinition::new("summaries-v2");
const MESSAGES: TableDefinition<&str, &str> = TableDefinition::new("messages-v1");
const PATHS: TableDefinition<&str, &[u8]> = TableDefinition::new("paths-v2");
const POSTINGS: MultimapTableDefinition<&str, &str> = MultimapTableDefinition::new("search-v1");
const INDEXED: TableDefinition<&str, bool> = TableDefinition::new("indexed-v1");

pub(crate) struct IndexedView {
    pub commits: Vec<Commit>,
    pub positions: HashMap<String, usize>,
}
impl IndexedView {
    pub fn new(commits: Vec<Commit>) -> Self {
        let positions = commits.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        Self { commits, positions }
    }
}

#[derive(Default)]
pub(crate) struct LogIndex {
    opened: bool,
    db: Option<Arc<Database>>,
    memory: HashMap<ObjectId, Arc<Commit>>,
    dirty: Vec<Arc<Commit>>,
    dirty_messages: Vec<(String, String)>,
    dirty_search: Vec<(String, Vec<String>)>,
    path_memory: HashMap<(ObjectId, String), Option<(ObjectId, u16)>>,
    dirty_paths: Vec<(String, Option<(String, u16)>)>,
    pub head: Option<(ObjectId, Option<SystemTime>)>,
    pub reachable: HashSet<ObjectId>,
    pub views: HashMap<String, Arc<IndexedView>>,
    pub nodes: HashMap<ObjectId, (Vec<ObjectId>, i64)>,
    pub shallow: HashSet<ObjectId>,
}

impl LogIndex {
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
        if &self.shallow != shallow {
            self.nodes.clear();
            self.shallow = shallow.clone();
        }
        let mut pending = tips.to_vec();
        while let Some(id) = pending.pop() {
            if cancel.is_cancelled() {
                return Err(ide_core::IdeError::cancelled());
            }
            if self.nodes.contains_key(&id) {
                continue;
            }
            let record = self.get(repo, id)?;
            let parents: Vec<_> = if shallow.contains(&id) {
                Vec::new()
            } else {
                record.parents.iter().map(|s| ObjectId::from_hex(s.as_bytes()).map_err(gx)).collect::<IdeResult<_>>()?
            };
            pending.extend(parents.iter().copied());
            self.nodes.insert(id, (parents, (record.commit_time_ms / 1000.0) as i64));
        }
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
    pub fn indexed(&self, id: &str) -> bool {
        self.db
            .as_ref()
            .and_then(|db| {
                let txn = db.begin_read().ok()?;
                let table = txn.open_table(INDEXED).ok()?;
                Some(table.get(id).ok()??.value())
            })
            .unwrap_or(false)
    }

    pub fn index_commit(&mut self, id: &str, message: &str, author: &str, email: &str, paths: &[String]) {
        let mut keys: HashSet<String> = Self::grams(message).into_iter().map(|s| format!("m:{s}")).collect();
        for user in [author, email, email.split('@').next().unwrap_or(email)] {
            keys.insert(format!("u:{}", normalize_user(user)));
        }
        for path in paths {
            keys.insert(format!("p:{path}"));
        }
        self.dirty_search.push((id.into(), keys.into_iter().collect()));
    }

    fn grams(text: &str) -> Vec<String> {
        let chars: Vec<_> = text.to_lowercase().chars().collect();
        chars.windows(3).map(|s| s.iter().collect()).collect::<HashSet<_>>().into_iter().collect()
    }

    /// Missing/unindexed commits are always checked directly by the caller.
    pub fn message_candidates(&self, text: &str) -> Option<HashSet<String>> {
        let grams = Self::grams(text);
        if grams.is_empty() {
            return None;
        }
        let db = self.db.as_ref()?;
        let txn = db.begin_read().ok()?;
        let table = txn.open_multimap_table(POSTINGS).ok()?;
        let mut candidates: Option<HashSet<String>> = None;
        for gram in grams {
            let values = table.get(format!("m:{gram}").as_str()).ok()?;
            let ids: HashSet<_> = values.filter_map(Result::ok).map(|s| s.value().to_string()).collect();
            candidates = Some(match candidates {
                Some(old) => old.intersection(&ids).cloned().collect(),
                None => ids,
            });
            if candidates.as_ref().is_some_and(HashSet::is_empty) {
                break;
            }
        }
        Some(candidates.unwrap_or_default())
    }

    pub fn user_candidates(&self, authors: &[String]) -> Option<HashSet<String>> {
        let txn = self.db.as_ref()?.begin_read().ok()?;
        let table = txn.open_multimap_table(POSTINGS).ok()?;
        let mut ids = HashSet::new();
        for author in authors {
            let name = author.split('<').next().unwrap_or(author).trim();
            let email = author.split('<').nth(1).map(|s| s.trim_end_matches('>')).unwrap_or(author);
            for alias in [name, email, email.split('@').next().unwrap_or(email)] {
                for value in table.get(format!("u:{}", normalize_user(alias)).as_str()).ok()?.filter_map(Result::ok) {
                    ids.insert(value.value().to_string());
                }
            }
        }
        Some(ids)
    }

    pub fn path_candidates(&self, paths: &[String]) -> Option<HashSet<String>> {
        let txn = self.db.as_ref()?.begin_read().ok()?;
        let table = txn.open_multimap_table(POSTINGS).ok()?;
        let mut ids = HashSet::new();
        for path in paths {
            for value in table.get(format!("p:{path}").as_str()).ok()?.filter_map(Result::ok) {
                ids.insert(value.value().to_string());
            }
            let prefix = format!("p:{path}/");
            let end = format!("{prefix}{}", char::MAX);
            for row in table.range(prefix.as_str()..end.as_str()).ok()?.filter_map(Result::ok) {
                for value in row.1.filter_map(Result::ok) {
                    ids.insert(value.value().to_string());
                }
            }
        }
        Some(ids)
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
        if let Some(commit) = self.memory.get(&id) {
            return Ok(commit.clone());
        }
        let key = id.to_string();
        let cached = self.db.as_ref().and_then(|db| {
            let txn = db.begin_read().ok()?;
            let table = txn.open_table(COMMITS).ok()?;
            let value = table.get(key.as_str()).ok()??;
            serde_json::from_slice::<Commit>(value.value()).ok().filter(|c| c.id == key)
        });
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
            }
            record
        };
        // Keep hot pages in memory; older metadata stays in the persistent index.
        if self.memory.len() >= 4096 {
            self.flush();
            self.memory.clear();
        }
        self.memory.insert(id, commit.clone());
        Ok(commit)
    }

    pub fn message(&mut self, repo: &gix::Repository, id: ObjectId) -> IdeResult<String> {
        if let Some((_, message)) = self.dirty_messages.iter().find(|(key, _)| key == &id.to_string()) {
            return Ok(message.clone());
        }
        let key = id.to_string();
        let cached = self.db.as_ref().and_then(|db| {
            let txn = db.begin_read().ok()?;
            let table = txn.open_table(MESSAGES).ok()?;
            Some(table.get(key.as_str()).ok()??.value().to_string())
        });
        if let Some(message) = cached {
            return Ok(message);
        }
        let message = to_string(repo.find_commit(id).map_err(gx)?.message_raw_sloppy()).trim_end().to_string();
        if self.db.is_some() {
            self.dirty_messages.push((key, message.clone()));
        }
        Ok(message)
    }

    pub fn flush(&mut self) {
        if self.dirty.is_empty()
            && self.dirty_paths.is_empty()
            && self.dirty_messages.is_empty()
            && self.dirty_search.is_empty()
        {
            return;
        }
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
                let mut table = txn.open_table(PATHS)?;
                for (key, value) in &self.dirty_paths {
                    let bytes = serde_json::to_vec(value)?;
                    table.insert(key.as_str(), bytes.as_slice())?;
                }
            }
            {
                let mut table = txn.open_table(MESSAGES)?;
                for (id, message) in &self.dirty_messages {
                    table.insert(id.as_str(), message.as_str())?;
                }
            }
            {
                let mut postings = txn.open_multimap_table(POSTINGS)?;
                let mut indexed = txn.open_table(INDEXED)?;
                for (id, keys) in &self.dirty_search {
                    for key in keys {
                        postings.insert(key.as_str(), id.as_str())?;
                    }
                    indexed.insert(id.as_str(), true)?;
                }
            }
            txn.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!("Git log cache write failed: {error}");
        }
        self.dirty_messages.clear();
        self.dirty_search.clear();
        self.dirty.clear();
        self.dirty_paths.clear();
    }

    pub fn path_entry(
        &mut self,
        repo: &gix::Repository,
        id: ObjectId,
        path: &str,
    ) -> IdeResult<Option<(ObjectId, u16)>> {
        let memory_key = (id, path.to_string());
        if let Some(value) = self.path_memory.get(&memory_key) {
            return Ok(*value);
        }
        let key = format!("{id}\0{path}");
        let cached = self.db.as_ref().and_then(|db| {
            let txn = db.begin_read().ok()?;
            let table = txn.open_table(PATHS).ok()?;
            let value = table.get(key.as_str()).ok()??;
            serde_json::from_slice::<Option<(String, u16)>>(value.value()).ok()
        });
        let cached = match cached {
            Some(None) => Some(None),
            Some(Some((hex, mode))) => ObjectId::from_hex(hex.as_bytes()).ok().map(|id| Some((id, mode))),
            None => None,
        };
        let value = if let Some(value) = cached {
            value
        } else {
            let tree = repo.find_commit(id).map_err(gx)?.tree().map_err(gx)?;
            let value = tree
                .lookup_entry_by_path(Path::new(path))
                .map_err(gx)?
                .map(|entry| (entry.object_id(), entry.mode().value()));
            if self.db.is_some() {
                self.dirty_paths.push((key, value.map(|(id, mode)| (id.to_string(), mode))));
            }
            value
        };
        if self.path_memory.len() >= 4096 {
            self.flush();
            self.path_memory.clear();
        }
        self.path_memory.insert(memory_key, value);
        Ok(value)
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
