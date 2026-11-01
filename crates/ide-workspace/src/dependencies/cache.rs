use super::DependencyVersionSource;
use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(3600);
const FAILURE_TTL: Duration = Duration::from_secs(30);
const MAX_DISK_BYTES: u64 = 2 * 1024 * 1024;
type Slot = Arc<Mutex<Option<Cached>>>;

#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    fetched: u64,
    versions: Vec<String>,
    #[serde(skip)]
    failed: bool,
}

/// Same-package lookups share one lock and fetch. Different packages don't block
/// each other; waiting callers can cancel independently of the active fetch.
pub struct VersionCache {
    directory: PathBuf,
    entries: Mutex<HashMap<String, Slot>>,
    ttl: Duration,
}

impl VersionCache {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory, entries: Mutex::default(), ttl: TTL }
    }

    pub fn versions(
        &self,
        source: &dyn DependencyVersionSource,
        package: &str,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<String>> {
        let safe = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b));
        if !safe(source.id()) || !safe(package) || package.len() > 64 {
            return Ok(Vec::new());
        }
        let key = format!("{}-{}", source.id(), package.to_ascii_lowercase());
        let slot = self.entries.lock().entry(key.clone()).or_default().clone();
        let mut cached = loop {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if let Some(guard) = slot.try_lock_for(Duration::from_millis(50)) {
                break guard;
            }
        };
        let checked_at = now();
        let fresh = |c: &Cached| {
            c.fetched <= checked_at && checked_at - c.fetched < if c.failed { FAILURE_TTL } else { self.ttl }.as_secs()
        };
        if let Some(entry) = cached.as_ref().filter(|c| fresh(c)) {
            return Ok(entry.versions.clone());
        }
        let path = self.directory.join(format!("{key}.json"));
        let disk = std::fs::metadata(&path)
            .ok()
            .filter(|m| m.len() <= MAX_DISK_BYTES)
            .and_then(|_| std::fs::read(&path).ok())
            .and_then(|bytes| serde_json::from_slice::<Cached>(&bytes).ok())
            .filter(fresh);
        if let Some(entry) = disk {
            let versions = entry.versions.clone();
            *cached = Some(entry);
            return Ok(versions);
        }
        let result = source.fetch(package, cancel);
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let failed = result.is_err();
        let versions = result.unwrap_or_default();
        let entry = Cached { fetched: now(), versions: versions.clone(), failed };
        if !failed
            && let Ok(bytes) = serde_json::to_vec(&entry)
            && std::fs::create_dir_all(&self.directory).is_ok()
        {
            let temporary = path.with_extension("tmp");
            if std::fs::write(&temporary, bytes).is_ok() {
                let _ = std::fs::rename(&temporary, &path);
                let _ = std::fs::remove_file(&temporary);
            }
        }
        *cached = Some(entry);
        Ok(versions)
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests;
