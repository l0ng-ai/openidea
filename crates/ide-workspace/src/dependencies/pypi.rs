//! Projects on pypi.org: one project from its JSON API (`/pypi/<name>/json`), and the names
//! of all of them from the Simple index, cached to answer searches (PyPI has no search API).
use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PypiPackage {
    /// The name as PyPI spells it.
    pub name: String,
    pub summary: String,
    /// The newest release that is not a pre-release; empty when every release is yanked.
    pub latest: String,
    /// Releases with files to install, most recently uploaded first; yanked ones left out.
    pub versions: Vec<String>,
}

/// The JSON API URL of a project; `None` unless `name` is a valid distribution name (PEP 508).
pub fn project_url(name: &str) -> Option<String> {
    let edge = |b: Option<&u8>| b.is_some_and(u8::is_ascii_alphanumeric);
    let bytes = name.as_bytes();
    (name.len() <= 128
        && edge(bytes.first())
        && edge(bytes.last())
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(b)))
    .then(|| format!("https://pypi.org/pypi/{name}/json"))
}

pub fn parse_project(json: &str) -> Option<PypiPackage> {
    #[derive(Deserialize)]
    struct Project {
        info: Info,
        #[serde(default)]
        releases: std::collections::BTreeMap<String, Vec<File>>,
    }
    #[derive(Deserialize)]
    struct Info {
        name: String,
        summary: Option<String>,
        version: String,
        #[serde(default)]
        yanked: bool,
    }
    #[derive(Deserialize)]
    struct File {
        #[serde(default)]
        yanked: bool,
        #[serde(default)]
        upload_time_iso_8601: String,
    }
    let project: Project = serde_json::from_str(json).ok()?;
    // ponytail: ordered by upload time, not PEP 440, so a backport released after a newer
    // major sorts above it. Parse the versions if that order turns out to matter.
    let mut releases: Vec<(String, String)> = project
        .releases
        .into_iter()
        .filter(|(_, files)| files.iter().any(|f| !f.yanked))
        .map(|(version, files)| (files.into_iter().map(|f| f.upload_time_iso_8601).min().unwrap_or_default(), version))
        .collect();
    releases.sort_unstable_by(|a, b| b.cmp(a));
    let info = project.info;
    Some(PypiPackage {
        name: info.name,
        summary: info.summary.unwrap_or_default(),
        latest: if info.yanked { String::new() } else { info.version },
        versions: releases.into_iter().map(|(_, version)| version).collect(),
    })
}

/// The Simple index; with [`SIMPLE_INDEX_ACCEPT`] it answers in JSON (PEP 691).
pub const SIMPLE_INDEX_URL: &str = "https://pypi.org/simple/";
pub const SIMPLE_INDEX_ACCEPT: &str = "application/vnd.pypi.simple.v1+json";

const NAMES_TTL: Duration = Duration::from_secs(24 * 3600);
const NAMES_FAILURE_TTL: Duration = Duration::from_secs(60);

/// How PyPI compares names (PEP 503): case and runs of `-`, `_`, `.` don't matter.
pub fn normalize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

/// The project names of a Simple index response, one per line.
pub fn parse_simple_index(json: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Index<'a> {
        #[serde(borrow)]
        projects: Vec<Project<'a>>,
    }
    #[derive(Deserialize)]
    struct Project<'a> {
        #[serde(borrow)]
        name: Cow<'a, str>,
    }
    let index: Index = serde_json::from_str(json).ok()?;
    let mut names = String::with_capacity(index.projects.len() * 16);
    for project in index.projects.iter().filter(|p| !p.name.is_empty() && !p.name.contains(['\n', '\r'])) {
        names.push_str(&project.name);
        names.push('\n');
    }
    Some(names)
}

/// Every project name on PyPI, searchable.
pub struct NameIndex {
    /// One name per line, as PyPI spells it.
    names: String,
    /// The same lines, [`normalize`]d.
    normalized: String,
}

impl NameIndex {
    pub fn new(names: String) -> Self {
        let mut normalized = String::with_capacity(names.len());
        for name in names.lines() {
            normalized.push_str(&normalize(name));
            normalized.push('\n');
        }
        Self { names, normalized }
    }

    /// Up to `limit` names containing `query`: the exact name, then names starting with it,
    /// then the rest; shorter names first within each.
    pub fn search(&self, query: &str, limit: usize) -> Vec<String> {
        let query = normalize(query.trim());
        if query.is_empty() {
            return Vec::new();
        }
        let mut found: Vec<(u8, usize, &str)> = self
            .normalized
            .lines()
            .zip(self.names.lines())
            .filter_map(|(normalized, name)| {
                let at = normalized.find(&query)?;
                let rank = if normalized.len() == query.len() { 0 } else { 1 + u8::from(at > 0) };
                Some((rank, normalized.len(), name))
            })
            .collect();
        if found.len() > limit {
            found.select_nth_unstable(limit);
            found.truncate(limit);
        }
        found.sort_unstable();
        found.into_iter().map(|(_, _, name)| name.to_owned()).collect()
    }
}

struct Names {
    index: Arc<NameIndex>,
    /// When to download again.
    until: SystemTime,
}

/// PyPI's project names, kept in `file` and in memory. One caller downloads at a time; the
/// others wait for it, each for as long as its own request lives.
pub struct NameCache {
    file: PathBuf,
    names: Mutex<Option<Names>>,
    /// The last download that failed with no copy to fall back on.
    failed: Mutex<Option<(SystemTime, IdeError)>>,
    refresh: Mutex<()>,
}

impl NameCache {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            file: directory.join("pypi-names.txt"),
            names: Mutex::default(),
            failed: Mutex::default(),
            refresh: Mutex::default(),
        }
    }

    /// The names: from memory or the cache file, downloaded with `fetch` (the Simple index's
    /// JSON) when there is no copy or it is a day old. A failed refresh keeps the old copy.
    pub fn index(
        &self,
        cancel: &CancellationToken,
        fetch: &dyn Fn() -> IdeResult<String>,
    ) -> IdeResult<Arc<NameIndex>> {
        let _refreshing = loop {
            if let Some(index) = self.fresh() {
                return Ok(index);
            }
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if let Some(guard) = self.refresh.try_lock_for(Duration::from_millis(50)) {
                break guard;
            }
        };
        // Another caller may have finished the download while this one waited.
        if let Some(index) = self.fresh() {
            return Ok(index);
        }
        let now = SystemTime::now();
        if let Some((at, error)) = &*self.failed.lock()
            && now.duration_since(*at).is_ok_and(|age| age < NAMES_FAILURE_TTL)
        {
            return Err(error.clone());
        }
        let downloaded = fetch().and_then(|json| {
            parse_simple_index(&json).ok_or_else(|| IdeError::internal("invalid PyPI index response"))
        });
        match downloaded {
            Ok(names) => {
                if let Some(parent) = self.file.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                // Not fatal: the names are still served from memory.
                let _ = std::fs::write(&self.file, &names);
                let index = Arc::new(NameIndex::new(names));
                *self.names.lock() = Some(Names { index: index.clone(), until: now + NAMES_TTL });
                *self.failed.lock() = None;
                Ok(index)
            }
            Err(error) => {
                let mut names = self.names.lock();
                match names.as_mut() {
                    Some(old) => {
                        old.until = now + NAMES_FAILURE_TTL;
                        Ok(old.index.clone())
                    }
                    None => {
                        *self.failed.lock() = Some((now, error.clone()));
                        Err(error)
                    }
                }
            }
        }
    }

    /// The names when they need no download; reads the cache file the first time.
    fn fresh(&self) -> Option<Arc<NameIndex>> {
        let mut names = self.names.lock();
        if names.is_none()
            && let Ok(text) = std::fs::read_to_string(&self.file)
        {
            let written = std::fs::metadata(&self.file).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            *names = Some(Names { index: Arc::new(NameIndex::new(text)), until: written + NAMES_TTL });
        }
        names.as_ref().filter(|n| SystemTime::now() < n.until).map(|n| n.index.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_distribution_names_get_a_url() {
        assert_eq!(project_url("typing_extensions").as_deref(), Some("https://pypi.org/pypi/typing_extensions/json"));
        assert!(project_url("zope.interface").is_some());
        for bad in ["", "-pip", "pip-", "a/b", "../x", "a b", "requests==2.0", "naïve", "a?b", &"a".repeat(129)] {
            assert_eq!(project_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn releases_are_listed_newest_first_without_yanked_or_empty_ones() {
        let json = r#"{
            "info": {"name": "Demo", "summary": null, "version": "2.0", "yanked": false},
            "releases": {
                "1.0": [{"yanked": false, "upload_time_iso_8601": "2020-01-01T00:00:00.000000Z"}],
                "1.1": [{"yanked": true, "upload_time_iso_8601": "2020-06-01T00:00:00.000000Z"}],
                "2.0": [{"yanked": false, "upload_time_iso_8601": "2021-01-01T00:00:00.000000Z"},
                        {"yanked": false, "upload_time_iso_8601": "2021-01-02T00:00:00.000000Z"}],
                "2.1rc1": [{"yanked": false, "upload_time_iso_8601": "2021-03-01T00:00:00.000000Z"}],
                "0.1": []
            }
        }"#;
        let project = parse_project(json).unwrap();
        assert_eq!(project.name, "Demo");
        assert_eq!(project.summary, "");
        assert_eq!(project.latest, "2.0");
        assert_eq!(project.versions, ["2.1rc1", "2.0", "1.0"]);
        assert_eq!(parse_project(r#"{"message": "Not Found"}"#), None);
    }

    #[test]
    fn names_are_searched_as_pypi_normalises_them() {
        let json = r#"{"meta": {"api-version": "1.4"}, "projects": [
            {"name": "Flask"}, {"name": "Flask-SQLAlchemy"}, {"name": "flask_login"},
            {"name": "pytest-flask"}, {"name": "aioflask"}, {"name": "requests"}, {"name": "zope.interface"}
        ]}"#;
        let index = NameIndex::new(parse_simple_index(json).unwrap());
        assert_eq!(index.search("flask", 10), ["Flask", "flask_login", "Flask-SQLAlchemy", "aioflask", "pytest-flask"]);
        assert_eq!(index.search(" Flask_", 10), ["flask_login", "Flask-SQLAlchemy"]);
        assert_eq!(index.search("ZOPE-INT", 10), ["zope.interface"]);
        assert_eq!(index.search("flask", 2), ["Flask", "flask_login"]);
        assert!(index.search("", 10).is_empty());
        assert!(index.search("django", 10).is_empty());
        assert_eq!(parse_simple_index(r#"{"projects": "none"}"#), None);
    }

    #[test]
    fn names_are_downloaded_once_cached_on_disk_and_kept_when_a_refresh_fails() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let fetch = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(r#"{"projects": [{"name": "six"}]}"#.to_owned())
        };
        let cache = NameCache::new(dir.path().join("cache"));
        assert_eq!(cache.index(&cancel, &fetch).unwrap().search("si", 5), ["six"]);
        assert_eq!(cache.index(&cancel, &fetch).unwrap().search("si", 5), ["six"]);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        // A new process reads the file instead of downloading.
        let offline = || -> IdeResult<String> { Err(IdeError::unavailable("offline")) };
        let reopened = NameCache::new(dir.path().join("cache"));
        assert_eq!(reopened.index(&cancel, &offline).unwrap().search("six", 5), ["six"]);

        // A day later the refresh fails: the old copy keeps answering, without retrying at once.
        reopened.names.lock().as_mut().unwrap().until = SystemTime::UNIX_EPOCH;
        assert_eq!(reopened.index(&cancel, &offline).unwrap().search("six", 5), ["six"]);
        assert!(reopened.fresh().is_some());

        // No copy at all: the error is reported, and remembered for a while.
        let empty = NameCache::new(dir.path().join("empty"));
        assert!(empty.index(&cancel, &offline).is_err());
        assert!(empty.index(&cancel, &fetch).is_err());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(NameCache::new(dir.path().join("other")).index(&cancelled, &fetch).is_err());
    }
}
