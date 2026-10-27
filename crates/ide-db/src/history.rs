//! Query history (IDEA's Browse Query History): the statements each data
//! source ran, newest first. One JSON file in the app's data directory for all
//! projects, keyed by project root, then data source id — never committed.

use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Statements kept per data source.
pub const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbHistoryEntry")]
pub struct HistoryEntry {
    pub text: String,
    /// Milliseconds since the Unix epoch.
    pub time: f64,
}

/// Project root → data source id → entries, newest first.
type Contents = BTreeMap<String, BTreeMap<String, Vec<HistoryEntry>>>;

/// Serialises read-modify-write across the projects sharing the file.
static LOCK: Mutex<()> = Mutex::new(());

pub struct HistoryStore {
    path: PathBuf,
    project: String,
}

impl HistoryStore {
    pub fn new(path: PathBuf, root: &Path) -> Self {
        Self { path, project: root.to_string_lossy().into_owned() }
    }

    pub fn list(&self, source: &str) -> Vec<HistoryEntry> {
        let _g = LOCK.lock();
        self.read().remove(&self.project).and_then(|mut p| p.remove(source)).unwrap_or_default()
    }

    /// Records `text`; running a statement again moves it to the top.
    pub fn add(&self, source: &str, text: &str, time: f64) -> IdeResult<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let _g = LOCK.lock();
        let mut all = self.read();
        let entries = all.entry(self.project.clone()).or_default().entry(source.to_owned()).or_default();
        entries.retain(|e| e.text != text);
        entries.insert(0, HistoryEntry { text: text.to_owned(), time });
        entries.truncate(MAX_ENTRIES);
        self.write(&all)
    }

    /// Removes the entries with these texts (all of them for `None`).
    pub fn remove(&self, source: &str, texts: Option<&[String]>) -> IdeResult<()> {
        let _g = LOCK.lock();
        let mut all = self.read();
        let Some(project) = all.get_mut(&self.project) else { return Ok(()) };
        match texts {
            None => {
                project.remove(source);
            }
            Some(texts) => {
                if let Some(entries) = project.get_mut(source) {
                    entries.retain(|e| !texts.contains(&e.text));
                }
            }
        }
        self.write(&all)
    }

    fn read(&self) -> Contents {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("query history: {}: {e}", self.path.display());
                Contents::new()
            }),
            Err(_) => Contents::new(),
        }
    }

    fn write(&self, all: &Contents) -> IdeResult<()> {
        let err = |e: std::io::Error| IdeError::unavailable(format!("query history: {e}"));
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(all).map_err(|e| IdeError::internal(e.to_string()))?;
        std::fs::write(&tmp, bytes).map_err(err)?;
        std::fs::rename(&tmp, &self.path).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_first_without_duplicates_per_project_and_source() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("h.json");
        let a = HistoryStore::new(file.clone(), Path::new("/p/a"));
        let b = HistoryStore::new(file, Path::new("/p/b"));
        a.add("s1", "select 1", 1.0).unwrap();
        a.add("s1", " select 2 ", 2.0).unwrap();
        a.add("s1", "select 1", 3.0).unwrap();
        a.add("s2", "select 3", 4.0).unwrap();
        b.add("s1", "select 4", 5.0).unwrap();
        let texts = |v: Vec<HistoryEntry>| v.into_iter().map(|e| e.text).collect::<Vec<_>>();
        assert_eq!(texts(a.list("s1")), ["select 1", "select 2"]);
        assert_eq!(texts(a.list("s2")), ["select 3"]);
        assert_eq!(texts(b.list("s1")), ["select 4"]);
        a.remove("s1", Some(&["select 2".to_owned()])).unwrap();
        assert_eq!(texts(a.list("s1")), ["select 1"]);
        a.remove("s1", None).unwrap();
        assert!(a.list("s1").is_empty());
        assert_eq!(texts(b.list("s1")), ["select 4"]);
    }

    #[test]
    fn caps_entries() {
        let dir = tempfile::tempdir().unwrap();
        let h = HistoryStore::new(dir.path().join("h.json"), Path::new("/p"));
        for i in 0..MAX_ENTRIES + 5 {
            h.add("s", &format!("select {i}"), i as f64).unwrap();
        }
        let list = h.list("s");
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].text, format!("select {}", MAX_ENTRIES + 4));
    }
}
