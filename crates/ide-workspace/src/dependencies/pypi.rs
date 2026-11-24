//! Projects on pypi.org: one project from its JSON API (`/pypi/<name>/json`), and the names
//! of all of them from the Simple index, cached to answer searches (PyPI has no search API).
use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};

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
/// How long downloading the names (about 10 MB) may take.
const NAMES_DOWNLOAD_LIMIT: Duration = Duration::from_secs(180);
/// How long the first download goes on with no search waiting for it: typing cancels one search
/// and starts the next a moment later.
const NAMES_UNWANTED_AFTER: Duration = Duration::from_secs(10);

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

    /// Up to `limit` names containing `query`: the exact name, then names that start with it
    /// and a separator (`flask-…`), then other names that start with it, then the rest;
    /// shorter names first within each.
    pub fn search(&self, query: &str, limit: usize, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
        let query = normalize(query.trim());
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: Vec<(u8, usize, &str)> = Vec::new();
        for (i, (normalized, name)) in self.normalized.lines().zip(self.names.lines()).enumerate() {
            if i % 65_536 == 0 && cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let Some(at) = normalized.find(&query) else { continue };
            let rank = match normalized.as_bytes().get(query.len()) {
                _ if at > 0 => 3,
                None => 0,
                Some(b'-') => 1,
                Some(_) => 2,
            };
            found.push((rank, normalized.len(), name));
        }
        if found.len() > limit {
            found.select_nth_unstable(limit);
            found.truncate(limit);
        }
        found.sort_unstable();
        Ok(found.into_iter().map(|(_, _, name)| name.to_owned()).collect())
    }
}

/// Downloads the Simple index's JSON, giving up when the token is cancelled.
pub type Fetch = Arc<dyn Fn(&CancellationToken) -> IdeResult<String> + Send + Sync>;

struct Names {
    index: Arc<NameIndex>,
    /// When to download again.
    until: SystemTime,
}

#[derive(Default)]
struct Downloads {
    running: bool,
    /// Searches waiting for the names, and since when none has.
    waiting: usize,
    idle_since: Option<Instant>,
}

/// PyPI's project names, kept in `file` and in memory. With no copy, searches wait for one
/// download in the background, each for as long as its own request lives; the download stops
/// once no search has waited for it for a while. A day-old copy keeps answering while it is
/// downloaded again in the background.
pub struct NameCache {
    file: PathBuf,
    names: Mutex<Option<Names>>,
    /// The last download that failed with no copy to fall back on, and when it failed.
    failed: Mutex<Option<(SystemTime, IdeError)>>,
    downloads: Mutex<Downloads>,
    /// How long a download may run, and how long it runs on with no search waiting for it.
    limit: Duration,
    unwanted_after: Duration,
}

impl NameCache {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            file: directory.join("pypi-names.txt"),
            names: Mutex::default(),
            failed: Mutex::default(),
            downloads: Mutex::default(),
            limit: NAMES_DOWNLOAD_LIMIT,
            unwanted_after: NAMES_UNWANTED_AFTER,
        }
    }

    /// The names: from memory or the cache file, downloaded with `fetch` when there is none.
    pub fn index(self: &Arc<Self>, cancel: &CancellationToken, fetch: Fetch) -> IdeResult<Arc<NameIndex>> {
        if let Some((index, stale)) = self.copy() {
            if stale {
                self.start(&fetch, true);
            }
            return Ok(index);
        }
        let _waiting = Waiting::new(self);
        loop {
            if let Some((index, _)) = self.copy() {
                return Ok(index);
            }
            if let Some(error) = self.failure() {
                return Err(error);
            }
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            // A search that comes while the names are downloaded waits for that download.
            self.start(&fetch, false);
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Downloads the names on another thread unless that is already being done. A `refresh` runs
    /// to the end; a first download stops once no search wants it.
    fn start(self: &Arc<Self>, fetch: &Fetch, refresh: bool) {
        let mut downloads = self.downloads.lock();
        if downloads.running {
            return;
        }
        downloads.running = true;
        let (this, fetch) = (self.clone(), fetch.clone());
        std::thread::spawn(move || {
            let token = CancellationToken::new();
            let (done, finished) = std::sync::mpsc::channel::<()>();
            let watchdog = std::thread::spawn({
                let (this, token) = (this.clone(), token.clone());
                move || this.watch(&token, refresh, &finished)
            });
            let downloaded = fetch(&token);
            drop(done);
            let stopped = watchdog.join().unwrap_or(None);
            match (downloaded, stopped) {
                (Ok(json), _) => this
                    .store(parse_simple_index(&json).ok_or_else(|| IdeError::internal("invalid PyPI index response"))),
                // Nobody wants it: the next search starts again.
                (Err(_), Some(Stop::Unwanted)) => {}
                (Err(_), Some(Stop::TimedOut)) => this.store(Err(IdeError::new(
                    ide_core::error::ErrorKind::TimedOut,
                    "downloading the PyPI package names took too long",
                ))),
                (Err(error), None) => this.store(Err(error)),
            }
            this.downloads.lock().running = false;
        });
    }

    /// Cancels `token` when the download takes too long or, unless it is a refresh, when no search
    /// has waited for it for a while; returns when `finished` closes.
    fn watch(&self, token: &CancellationToken, refresh: bool, finished: &Receiver<()>) -> Option<Stop> {
        let started = Instant::now();
        while finished.recv_timeout(Duration::from_millis(20)) == Err(RecvTimeoutError::Timeout) {
            let stop = if started.elapsed() >= self.limit {
                Stop::TimedOut
            } else if let Downloads { waiting: 0, idle_since: Some(since), .. } = *self.downloads.lock()
                && !refresh
                && since.elapsed() >= self.unwanted_after
            {
                Stop::Unwanted
            } else {
                continue;
            };
            token.cancel();
            let _ = finished.recv();
            return Some(stop);
        }
        None
    }

    /// Keeps downloaded names, or the error; a failure keeps the old copy, and is not retried for a
    /// while, counted from when the download gave up.
    fn store(&self, downloaded: IdeResult<String>) {
        let finished = SystemTime::now();
        match downloaded {
            Ok(names) => {
                // The file is replaced whole, so a crash or a full disk never leaves part of it.
                let temporary = self.file.with_extension("tmp");
                let written = self.file.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
                    && std::fs::write(&temporary, &names).is_ok();
                let index = Arc::new(NameIndex::new(names));
                *self.names.lock() = Some(Names { index, until: finished + NAMES_TTL });
                *self.failed.lock() = None;
                // Not fatal: the names are still served from memory.
                if !written || std::fs::rename(&temporary, &self.file).is_err() {
                    let _ = std::fs::remove_file(&temporary);
                }
            }
            Err(error) => match self.names.lock().as_mut() {
                Some(old) => old.until = finished + NAMES_FAILURE_TTL,
                None => *self.failed.lock() = Some((finished, error)),
            },
        }
    }

    /// The last download's error, while it is recent.
    fn failure(&self) -> Option<IdeError> {
        let failed = self.failed.lock();
        let (at, error) = failed.as_ref()?;
        SystemTime::now().duration_since(*at).is_ok_and(|age| age < NAMES_FAILURE_TTL).then(|| error.clone())
    }

    /// The names in memory or, the first time, in the cache file, and whether they are a day old.
    fn copy(&self) -> Option<(Arc<NameIndex>, bool)> {
        let mut names = self.names.lock();
        if names.is_none()
            && let Ok(text) = std::fs::read_to_string(&self.file)
        {
            let written = std::fs::metadata(&self.file).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            *names = Some(Names { index: Arc::new(NameIndex::new(text)), until: written + NAMES_TTL });
        }
        names.as_ref().map(|n| (n.index.clone(), SystemTime::now() >= n.until))
    }
}

enum Stop {
    TimedOut,
    Unwanted,
}

/// A search waiting for the names.
struct Waiting<'a>(&'a NameCache);

impl<'a> Waiting<'a> {
    fn new(cache: &'a NameCache) -> Self {
        cache.downloads.lock().waiting += 1;
        Self(cache)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut downloads = self.0.downloads.lock();
        downloads.waiting -= 1;
        if downloads.waiting == 0 {
            downloads.idle_since = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};

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

    fn search(index: &NameIndex, query: &str, limit: usize) -> Vec<String> {
        index.search(query, limit, &CancellationToken::new()).unwrap()
    }

    #[test]
    fn names_are_searched_as_pypi_normalises_them() {
        let json = r#"{"meta": {"api-version": "1.4"}, "projects": [
            {"name": "Flask"}, {"name": "Flask-SQLAlchemy"}, {"name": "flask_login"}, {"name": "FlaskX"},
            {"name": "pytest-flask"}, {"name": "aioflask"}, {"name": "requests"}, {"name": "zope.interface"}
        ]}"#;
        let index = NameIndex::new(parse_simple_index(json).unwrap());
        // Exact, then `flask-…`, then other `flask…`, then the rest.
        assert_eq!(
            search(&index, "flask", 10),
            ["Flask", "flask_login", "Flask-SQLAlchemy", "FlaskX", "aioflask", "pytest-flask"]
        );
        assert_eq!(search(&index, " Flask_", 10), ["flask_login", "Flask-SQLAlchemy"]);
        assert_eq!(search(&index, "ZOPE-INT", 10), ["zope.interface"]);
        assert_eq!(search(&index, "flask", 2), ["Flask", "flask_login"]);
        assert!(search(&index, "", 10).is_empty());
        assert!(search(&index, "django", 10).is_empty());
        assert_eq!(parse_simple_index(r#"{"projects": "none"}"#), None);
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(index.search("flask", 10, &cancelled).is_err());
    }

    fn fetch_counting(calls: &Arc<AtomicUsize>, result: IdeResult<&'static str>) -> Fetch {
        let calls = calls.clone();
        Arc::new(move |_: &CancellationToken| {
            calls.fetch_add(1, SeqCst);
            result.clone().map(str::to_owned)
        })
    }

    #[test]
    fn names_are_downloaded_once_cached_on_disk_and_kept_when_a_refresh_fails() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let online = fetch_counting(&calls, Ok(r#"{"projects": [{"name": "six"}]}"#));
        let offline = fetch_counting(&calls, Err(IdeError::unavailable("offline")));
        let cache = Arc::new(NameCache::new(dir.path().join("cache")));
        assert_eq!(search(&cache.index(&cancel, online.clone()).unwrap(), "si", 5), ["six"]);
        assert_eq!(search(&cache.index(&cancel, online.clone()).unwrap(), "si", 5), ["six"]);
        assert_eq!(calls.load(SeqCst), 1);
        // Written whole: no temporary file is left next to it.
        assert!(dir.path().join("cache/pypi-names.txt").is_file());
        assert!(!dir.path().join("cache/pypi-names.tmp").exists());

        // A new process reads the file instead of downloading.
        let reopened = Arc::new(NameCache::new(dir.path().join("cache")));
        assert_eq!(search(&reopened.index(&cancel, offline.clone()).unwrap(), "six", 5), ["six"]);
        assert_eq!(calls.load(SeqCst), 1);

        // A day later the old copy answers at once while a refresh runs in the background; when
        // it fails, the copy is kept and the refresh is not retried for a while.
        reopened.names.lock().as_mut().unwrap().until = SystemTime::UNIX_EPOCH;
        assert_eq!(search(&reopened.index(&cancel, offline.clone()).unwrap(), "six", 5), ["six"]);
        while reopened.downloads.lock().running {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(reopened.copy().map(|(_, stale)| stale), Some(false));

        // No copy at all: the error is reported, and remembered for a while.
        let empty = Arc::new(NameCache::new(dir.path().join("empty")));
        assert!(empty.index(&cancel, offline.clone()).is_err());
        assert!(empty.index(&cancel, online.clone()).is_err());
        assert_eq!(calls.load(SeqCst), 3);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(Arc::new(NameCache::new(dir.path().join("other"))).index(&cancelled, online).is_err());
    }

    #[test]
    fn the_failure_cooldown_counts_from_when_the_download_gave_up() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(NameCache::new(dir.path().to_owned()));
        let slow: Fetch = Arc::new(|_: &CancellationToken| {
            std::thread::sleep(Duration::from_millis(50));
            Err(IdeError::unavailable("offline"))
        });
        let before = SystemTime::now();
        assert!(cache.index(&CancellationToken::new(), slow).is_err());
        let (at, _) = cache.failed.lock().clone().unwrap();
        assert!(at.duration_since(before).unwrap() >= Duration::from_millis(50));
    }

    /// A download that takes until it is cancelled or `release` is set, counting its calls.
    fn fetch_held(calls: &Arc<AtomicUsize>, release: &Arc<AtomicBool>) -> Fetch {
        let (calls, release) = (calls.clone(), release.clone());
        Arc::new(move |token: &CancellationToken| {
            calls.fetch_add(1, SeqCst);
            while !release.load(SeqCst) {
                if token.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(r#"{"projects": [{"name": "six"}]}"#.to_owned())
        })
    }

    #[test]
    fn searches_share_the_first_download_and_stop_waiting_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = NameCache::new(dir.path().to_owned());
        cache.unwanted_after = Duration::from_millis(300);
        let cache = Arc::new(cache);
        let (calls, release) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let fetch = fetch_held(&calls, &release);

        // The search that starts the download returns as soon as it is cancelled.
        let first = CancellationToken::new();
        let waiting = std::thread::spawn({
            let (cache, first, fetch) = (cache.clone(), first.clone(), fetch.clone());
            move || cache.index(&first, fetch).map(|_| ())
        });
        while calls.load(SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        let cancelled_at = Instant::now();
        first.cancel();
        assert_eq!(waiting.join().unwrap().unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
        assert!(cancelled_at.elapsed() < Duration::from_millis(250));

        // The next search waits for the same download.
        let second = std::thread::spawn({
            let (cache, fetch) = (cache.clone(), fetch.clone());
            move || search(&cache.index(&CancellationToken::new(), fetch).unwrap(), "six", 5)
        });
        std::thread::sleep(Duration::from_millis(400));
        release.store(true, SeqCst);
        assert_eq!(second.join().unwrap(), ["six"]);
        assert_eq!(calls.load(SeqCst), 1);
    }

    #[test]
    fn a_download_no_search_waits_for_stops_and_one_that_takes_too_long_fails() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = NameCache::new(dir.path().to_owned());
        cache.unwanted_after = Duration::from_millis(50);
        let cache = Arc::new(cache);
        let (calls, release) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let fetch = fetch_held(&calls, &release);
        let cancel = CancellationToken::new();
        let waiting = std::thread::spawn({
            let (cache, cancel, fetch) = (cache.clone(), cancel.clone(), fetch.clone());
            move || cache.index(&cancel, fetch).map(|_| ())
        });
        while calls.load(SeqCst) == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        cancel.cancel();
        assert!(waiting.join().unwrap().is_err());
        while cache.downloads.lock().running {
            std::thread::sleep(Duration::from_millis(5));
        }
        // Not a failure: the next search downloads again.
        assert!(cache.failure().is_none());
        release.store(true, SeqCst);
        assert_eq!(search(&cache.index(&CancellationToken::new(), fetch).unwrap(), "six", 5), ["six"]);
        assert_eq!(calls.load(SeqCst), 2);

        let mut stalled = NameCache::new(dir.path().join("stalled"));
        stalled.limit = Duration::from_millis(50);
        let error = Arc::new(stalled)
            .index(&CancellationToken::new(), fetch_held(&calls, &Arc::new(AtomicBool::new(false))))
            .err()
            .unwrap();
        assert_eq!(error.kind, ide_core::error::ErrorKind::TimedOut);
    }
}
