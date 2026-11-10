use super::*;
use ide_workspace::dependencies::VersionCache;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

fn source(dir: &Path, script: &str) -> GoModules {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let go = bin.join("go");
    std::fs::write(&go, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&go, std::fs::Permissions::from_mode(0o755)).unwrap();
    GoModules {
        root: dir.to_owned(),
        env: BTreeMap::from([
            ("PATH".into(), bin.to_string_lossy().into_owned()),
            ("PROJECT_ROOT".into(), dir.to_string_lossy().into_owned()),
            ("GOPROXY".into(), "https://user:secret@proxy.example".into()),
            ("GOPRIVATE".into(), "private.example/token".into()),
            ("GOWORK".into(), "broken.work".into()),
            ("GOFLAGS".into(), "-mod=vendor".into()),
        ]),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn go_query_is_isolated_and_persists_only_hashed_configuration_and_versions() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(
        dir.path(),
        r#"set -eu
[ "$PWD" != "$PROJECT_ROOT" ]
[ "$GOPROXY" = 'https://user:secret@proxy.example' ]
[ "$GOPRIVATE" = 'private.example/token' ]
[ "$GOWORK" = off ]
[ "$GOFLAGS" = '' ]
[ "$GO111MODULE" = on ]
[ "$GIT_TERMINAL_PROMPT" = 0 ]
[ "$1 $2 $3 $4" = 'list -m -versions -f' ]
[ "$5" = '{{range .Versions}}{{println .}}{{end}}' ]
[ "$6 $7" = '-- example.com/Org/Lib/v2' ]
printf 'v2.9.0\nv2.10.0\n'"#,
    );
    let key = source.cache_key("example.com/Org/Lib/v2").unwrap();
    assert_ne!(key, source.cache_key("example.com/org/lib/v2").unwrap());
    let mut other = GoModules { root: source.root.join("member"), env: source.env.clone() };
    assert_ne!(key, other.cache_key("example.com/Org/Lib/v2").unwrap());
    other.root = source.root.clone();
    other.env.insert("GOPROXY".into(), "https://other.example".into());
    assert_ne!(key, other.cache_key("example.com/Org/Lib/v2").unwrap());
    let cache_dir = dir.path().join("cache");
    let disk = cache_dir.clone();
    let versions = tokio::task::spawn_blocking(move || {
        VersionCache::new(cache_dir).versions(&source, "example.com/Org/Lib/v2", &CancellationToken::new())
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(versions, ["v2.10.0", "v2.9.0"]);
    let entries: Vec<_> = std::fs::read_dir(disk).unwrap().map(Result::unwrap).collect();
    assert_eq!(entries.len(), 1, "the hashed key passes the cache filename filter");
    assert_eq!(entries[0].file_name().to_str().unwrap(), format!("{key}.json"));
    let cached = std::fs::read_to_string(entries[0].path()).unwrap();
    for sensitive in ["secret", "proxy.example", "private.example", "token", "PROJECT_ROOT"] {
        assert!(!cached.contains(sensitive), "configuration must not be persisted: {sensitive}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_go_queries_are_silent_and_not_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let source = source(dir.path(), "echo 'private module or offline proxy' >&2\nexit 1");
    let cache_dir = dir.path().join("cache");
    let disk = cache_dir.clone();
    let versions = tokio::task::spawn_blocking(move || {
        VersionCache::new(cache_dir).versions(&source, "private.example/module", &CancellationToken::new())
    })
    .await
    .unwrap()
    .unwrap();
    assert!(versions.is_empty());
    assert!(!disk.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_go_queries_obey_the_deadline_and_parent_cancellation() {
    for cancel_parent in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let source = source(dir.path(), "exec /bin/sleep 60");
        let cancel = CancellationToken::new();
        let query = cancel.clone();
        let started = Instant::now();
        let work = tokio::task::spawn_blocking(move || {
            VersionCache::new(source.root.join("cache")).versions(&source, "example.com/stalled", &query)
        });
        if cancel_parent {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel.cancel();
            assert!(work.await.unwrap().is_err());
            assert!(started.elapsed() < Duration::from_secs(3));
        } else {
            assert!(work.await.unwrap().unwrap().is_empty());
            assert!(started.elapsed() >= Duration::from_secs(10));
            assert!(started.elapsed() < Duration::from_secs(15));
            assert!(!cancel.is_cancelled(), "a query deadline must not cancel its caller");
        }
    }
}
