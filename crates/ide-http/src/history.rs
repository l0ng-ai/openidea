//! Response history: every exchange is saved under the project's data folder
//! (IDEA keeps them in `.idea/httpRequests`), newest first, capped.

use crate::exec::{HttpResponse, PreparedRequest};
use ide_core::{IdeError, IdeResult, IpcPath};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

pub const MAX_ENTRIES: usize = 100;
const INDEX: &str = "index.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "HttpHistoryEntry")]
pub struct HistoryEntry {
    pub id: String,
    /// Unix epoch, ms.
    pub time_ms: f64,
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    /// `None` when the request failed.
    pub status: Option<u16>,
    pub total_ms: Option<f64>,
    /// The `.http` file the request came from.
    pub file: Option<IpcPath>,
    pub error: Option<String>,
}

/// One request with its outcome.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpExchange {
    pub entry: HistoryEntry,
    pub request: PreparedRequest,
    pub response: Option<HttpResponse>,
}

pub struct History {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl History {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, lock: Mutex::new(()) }
    }

    fn read_index(&self) -> Vec<HistoryEntry> {
        std::fs::read_to_string(self.dir.join(INDEX))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn file(&self, id: &str) -> IdeResult<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(IdeError::invalid("invalid history id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    pub fn list(&self) -> Vec<HistoryEntry> {
        let _g = self.lock.lock();
        self.read_index()
    }

    pub fn get(&self, id: &str) -> IdeResult<HttpExchange> {
        let text = std::fs::read_to_string(self.file(id)?)?;
        serde_json::from_str(&text).map_err(|e| IdeError::internal(format!("corrupt history entry: {e}")))
    }

    /// Saves `exchange`, dropping the oldest entries beyond [`MAX_ENTRIES`].
    pub fn add(&self, exchange: &HttpExchange) -> IdeResult<()> {
        let _g = self.lock.lock();
        create_private_dir(&self.dir)?;
        let json = serde_json::to_string(exchange).map_err(|e| IdeError::internal(e.to_string()))?;
        write_private(&self.file(&exchange.entry.id)?, json.as_bytes())?;
        let mut index = self.read_index();
        index.insert(0, exchange.entry.clone());
        for old in index.drain(MAX_ENTRIES.min(index.len())..) {
            if let Ok(p) = self.file(&old.id) {
                let _ = std::fs::remove_file(p);
            }
        }
        self.write_index(&index)
    }

    fn write_index(&self, index: &[HistoryEntry]) -> IdeResult<()> {
        let json = serde_json::to_string_pretty(index).map_err(|e| IdeError::internal(e.to_string()))?;
        write_private(&self.dir.join(INDEX), json.as_bytes())?;
        Ok(())
    }

    pub fn clear(&self) -> IdeResult<()> {
        let _g = self.lock.lock();
        for e in self.read_index() {
            if let Ok(p) = self.file(&e.id) {
                let _ = std::fs::remove_file(p);
            }
        }
        if self.dir.exists() {
            self.write_index(&[])?;
        }
        Ok(())
    }
}

/// History holds resolved `Authorization` headers and bodies: keep it owner-only.
fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(id: &str) -> HttpExchange {
        HttpExchange {
            entry: HistoryEntry {
                id: id.into(),
                time_ms: 1.0,
                name: None,
                method: "GET".into(),
                url: "http://x".into(),
                status: Some(200),
                total_ms: Some(3.0),
                file: None,
                error: None,
            },
            request: PreparedRequest {
                name: None,
                method: "GET".into(),
                url: "http://x".into(),
                headers: vec![],
                body: None,
            },
            response: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn history_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("h");
        History::new(dir.clone()).add(&exchange("a")).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("a.json")), 0o600);
        assert_eq!(mode(&dir.join(INDEX)), 0o600);
    }

    #[test]
    fn stores_newest_first_and_caps() {
        let tmp = tempfile::tempdir().unwrap();
        let h = History::new(tmp.path().join("h"));
        for i in 0..MAX_ENTRIES + 3 {
            h.add(&exchange(&format!("e{i}"))).unwrap();
        }
        let list = h.list();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].id, format!("e{}", MAX_ENTRIES + 2));
        assert!(h.get("e0").is_err());
        assert_eq!(h.get("e5").unwrap().entry.id, "e5");
        assert!(h.get("../x").is_err());
        h.clear().unwrap();
        assert!(h.list().is_empty());
    }
}
