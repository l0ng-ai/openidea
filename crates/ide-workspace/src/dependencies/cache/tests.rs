use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Source {
    calls: AtomicUsize,
    fail: bool,
}
impl DependencyVersionSource for Source {
    fn id(&self) -> &'static str {
        "test"
    }
    fn fetch(&self, _: &str, _: &CancellationToken) -> IdeResult<Vec<String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        if self.fail { Err(IdeError::unavailable("offline")) } else { Ok(vec!["2.0.0".into()]) }
    }
}
fn source(fail: bool) -> Source {
    Source { calls: AtomicUsize::new(0), fail }
}

#[test]
fn memory_disk_ttl_corruption_and_failed_cache_writes() {
    let dir = tempfile::tempdir().unwrap();
    let s = source(false);
    let cancel = CancellationToken::new();
    let cache = VersionCache::new(dir.path().into());
    for _ in 0..2 {
        assert_eq!(cache.versions(&s, "foo", &cancel).unwrap(), ["2.0.0"]);
    }
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    VersionCache::new(dir.path().into()).versions(&s, "foo", &cancel).unwrap();
    assert_eq!(s.calls.load(Ordering::SeqCst), 1, "disk hit after service restart");
    let mut expired = VersionCache::new(dir.path().into());
    expired.ttl = Duration::ZERO;
    expired.versions(&s, "foo", &cancel).unwrap();
    assert_eq!(s.calls.load(Ordering::SeqCst), 2);
    std::fs::write(dir.path().join("test-foo.json"), b"corrupt").unwrap();
    VersionCache::new(dir.path().into()).versions(&s, "foo", &cancel).unwrap();
    assert_eq!(s.calls.load(Ordering::SeqCst), 3);
    let file = dir.path().join("not-a-directory");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(VersionCache::new(file).versions(&s, "foo", &cancel).unwrap(), ["2.0.0"]);
}

#[test]
fn concurrent_fetches_coalesce_and_failures_are_silent_and_short_cached() {
    let dir = tempfile::tempdir().unwrap();
    let cache = VersionCache::new(dir.path().into());
    let s = source(false);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| assert_eq!(cache.versions(&s, "foo", &CancellationToken::new()).unwrap(), ["2.0.0"]));
        }
    });
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    let s = source(true);
    for _ in 0..2 {
        assert!(cache.versions(&s, "offline", &CancellationToken::new()).unwrap().is_empty());
    }
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    assert!(!dir.path().join("test-offline.json").exists(), "failures aren't persisted");
    let slot = cache.entries.lock().get("test-offline").unwrap().clone();
    slot.lock().as_mut().unwrap().fetched -= 31;
    cache.versions(&s, "offline", &CancellationToken::new()).unwrap();
    assert_eq!(s.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn cancellation_and_invalid_cache_keys_do_not_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let cache = VersionCache::new(dir.path().into());
    let s = source(false);
    let token = CancellationToken::new();
    token.cancel();
    assert!(cache.versions(&s, "foo", &token).is_err());
    assert!(cache.versions(&s, "../foo", &CancellationToken::new()).unwrap().is_empty());
    assert_eq!(s.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn cancelled_waiter_does_not_cancel_the_shared_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let cache = VersionCache::new(dir.path().into());
    let s = source(false);
    let slot = Arc::new(Mutex::new(None));
    cache.entries.lock().insert("test-foo".into(), slot.clone());
    let guard = slot.lock();
    let token = CancellationToken::new();
    std::thread::scope(|scope| {
        let waiter = scope.spawn(|| cache.versions(&s, "foo", &token));
        token.cancel();
        assert!(waiter.join().unwrap().is_err());
    });
    drop(guard);
    assert_eq!(cache.versions(&s, "foo", &CancellationToken::new()).unwrap(), ["2.0.0"]);
}
