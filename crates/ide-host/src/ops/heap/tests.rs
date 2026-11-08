//! The heap commands through a real `Host` with a trusted project, on `MiniHeap` dumps.

use super::*;
use crate::HostConfig;
use ide_core::error::ErrorKind;
use ide_dap::{JvmMemoryUnavailable, LaunchConfig};
use ide_heap::testing::{MiniHeap, sample, sample_with_two_more_nodes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const WINDOW: &str = "main";

struct Fixture {
    host: Host,
    base: PathBuf,
    root: PathBuf,
    _temp: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        host.open_project(WINDOW, &root).unwrap();
        host.set_project_trust(&root, true, false).await.unwrap();
        Self { host, base, root, _temp: temp }
    }

    fn dump(&self, name: &str, heap: &MiniHeap) -> PathBuf {
        let path = self.base.join(name);
        heap.write_to(&path);
        path
    }

    async fn open_with(&self, path: &Path, request: u32, progress: Channel<HeapProgress>) -> IdeResult<HeapOpenResult> {
        debug_heap_open(&self.host, WINDOW, path.into(), RequestId(request), progress).await
    }

    async fn open(&self, path: &Path) -> HeapSnapshotInfo {
        match self.open_with(path, 1, Channel::new(|_| {})).await.unwrap() {
            HeapOpenResult::Ready { snapshot } => snapshot,
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    /// Opens a second trusted project in `window`.
    async fn open_window(&self, window: &str) {
        let root = self.base.join(window);
        std::fs::create_dir_all(&root).unwrap();
        self.host.open_project(window, &root).unwrap();
        self.host.set_project_trust(&root, true, false).await.unwrap();
    }

    /// The snapshot directories under the registry's root (none when it does not exist yet).
    fn snapshot_dirs(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.host.heap.root()) else { return Vec::new() };
        entries.map(|e| e.unwrap().path()).collect()
    }
}

fn recorder() -> (Channel<HeapProgress>, Arc<Mutex<Vec<HeapProgress>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (Channel::new(move |p| sink.lock().push(p)), seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_and_query_a_dump() {
    let f = Fixture::new().await;
    let path = f.dump("sample.hprof", &sample());
    let info = f.open(&path).await;
    assert_eq!(info.label, "sample.hprof");
    assert_eq!(info.origin, ide_heap::HeapOrigin::File { path: path.clone().into() });
    assert_eq!(f.snapshot_dirs().len(), 1);

    let classes = debug_heap_classes(&f.host, WINDOW, info.id).await.unwrap();
    let node = classes.iter().find(|c| c.name == "Node").unwrap();
    assert_eq!((node.count, node.retained), (3, 104));

    let top = debug_heap_dominators(&f.host, WINDOW, info.id, None, None, 0, 10).await.unwrap();
    assert_eq!(top.rows[0].retained, 72);
    let n3 = top.rows.iter().find(|r| r.class_name == "Node").unwrap();
    let below = debug_heap_dominators(&f.host, WINDOW, info.id, Some(n3.object), None, 0, 10).await.unwrap();
    let long_array = below.rows.first().unwrap();
    assert_eq!(long_array.address, "0x1400");
    let path_to_root = debug_heap_path(&f.host, WINDOW, info.id, long_array.object).await.unwrap().unwrap();
    assert_eq!(path_to_root.steps.len(), 2);

    debug_heap_close(&f.host, WINDOW, info.id).await.unwrap();
    assert!(f.snapshot_dirs().is_empty(), "the index directory goes with the snapshot");
    assert!(path.is_file(), "an opened dump is the user's file");
    let gone = debug_heap_classes(&f.host, WINDOW, info.id).await.unwrap_err();
    assert_eq!(gone.kind, ErrorKind::NotFound);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_reports_progress_in_order() {
    let f = Fixture::new().await;
    let path = f.dump("sample.hprof", &sample());
    let (progress, seen) = recorder();
    assert!(matches!(f.open_with(&path, 1, progress).await.unwrap(), HeapOpenResult::Ready { .. }));
    let phases: Vec<HeapPhase> = seen
        .lock()
        .iter()
        .map(|p| match p {
            HeapProgress::Analyzing { phase, .. } => *phase,
            HeapProgress::Dumping => panic!("an open dumps nothing"),
        })
        .collect();
    assert_eq!(phases.first(), Some(&HeapPhase::Reading));
    assert!(phases.is_sorted_by_key(|&p| p as u8), "phases never go back: {phases:?}");
    assert_eq!(phases.last(), Some(&HeapPhase::Saving));
    let mut distinct = phases.clone();
    distinct.dedup();
    assert_eq!(
        distinct,
        [
            HeapPhase::Reading,
            HeapPhase::Linking,
            HeapPhase::Dominators,
            HeapPhase::Retained,
            HeapPhase::Paths,
            HeapPhase::Saving
        ],
        "every phase is reported at least once however fast it runs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_open_leaves_nothing() {
    let f = Fixture::new().await;
    let path = f.dump("sample.hprof", &sample());
    f.host.cancel_request(RequestId(7));
    assert_eq!(f.open_with(&path, 7, Channel::new(|_| {})).await.unwrap(), HeapOpenResult::Cancelled);
    assert!(f.snapshot_dirs().is_empty());
    assert!(f.host.heap.list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn not_a_dump_is_an_error() {
    let f = Fixture::new().await;
    let path = f.base.join("hello.hprof");
    std::fs::write(&path, "hello").unwrap();
    let err = f.open_with(&path, 1, Channel::new(|_| {})).await.unwrap_err();
    assert!(err.message.contains("not a heap dump"), "{}", err.message);
    assert!(f.snapshot_dirs().is_empty());
    assert!(path.is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dump_without_its_end_record_is_an_error() {
    let f = Fixture::new().await;
    let path = f.base.join("killed.hprof");
    let bytes = sample().bytes();
    // HEAP DUMP END: tag, timestamp and length.
    std::fs::write(&path, &bytes[..bytes.len() - 9]).unwrap();
    let err = f.open_with(&path, 1, Channel::new(|_| {})).await.unwrap_err();
    assert!(err.message.contains("the dump ends early"), "{}", err.message);
    assert!(f.snapshot_dirs().is_empty());
    assert!(f.host.heap.list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compare_two_snapshots() {
    let f = Fixture::new().await;
    let base = f.open(&f.dump("base.hprof", &sample())).await;
    let current = f.open(&f.dump("current.hprof", &sample_with_two_more_nodes())).await;
    assert_ne!(base.id, current.id);
    let diff = debug_heap_compare(&f.host, WINDOW, base.id, current.id).await.unwrap();
    let node = diff.iter().find(|d| d.name == "Node").unwrap();
    assert_eq!((node.base_count, node.count), (3, 5));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_snapshot_is_not_found() {
    let f = Fixture::new().await;
    let missing = HeapSnapshotId(99);
    let not_found = |r: IdeError| assert_eq!(r.kind, ErrorKind::NotFound, "{}", r.message);
    not_found(debug_heap_classes(&f.host, WINDOW, missing).await.unwrap_err());
    not_found(debug_heap_dominators(&f.host, WINDOW, missing, None, None, 0, 10).await.unwrap_err());
    not_found(debug_heap_path(&f.host, WINDOW, missing, HeapObjectRef(0)).await.unwrap_err());
    not_found(debug_heap_save(&f.host, WINDOW, missing, f.base.join("x.hprof").into()).await.unwrap_err());
    not_found(debug_heap_close(&f.host, WINDOW, missing).await.unwrap_err());

    let open = f.open(&f.dump("sample.hprof", &sample())).await;
    not_found(debug_heap_compare(&f.host, WINDOW, open.id, missing).await.unwrap_err());
    // A snapshot belongs to the window that opened it.
    f.open_window("other").await;
    not_found(debug_heap_classes(&f.host, "other", open.id).await.unwrap_err());
    not_found(debug_heap_close(&f.host, "other", open.id).await.unwrap_err());
    assert!(debug_heap_classes(&f.host, WINDOW, open.id).await.is_ok());
}

/// The error of every op that takes a snapshot id, in `window`.
async fn query_errors(f: &Fixture, window: &str, id: HeapSnapshotId) -> Vec<IdeError> {
    let host = &f.host;
    vec![
        debug_heap_classes(host, window, id).await.unwrap_err(),
        debug_heap_dominators(host, window, id, None, None, 0, 10).await.unwrap_err(),
        debug_heap_path(host, window, id, HeapObjectRef(0)).await.unwrap_err(),
        debug_heap_compare(host, window, id, id).await.unwrap_err(),
        debug_heap_save(host, window, id, f.base.join("saved.hprof").into()).await.unwrap_err(),
        debug_heap_close(host, window, id).await.unwrap_err(),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queries_check_trust_before_the_snapshot() {
    let f = Fixture::new().await;
    let open = f.open(&f.dump("sample.hprof", &sample())).await;

    let no_project = f.host.require_trust("nowhere").unwrap_err();
    for err in query_errors(&f, "nowhere", open.id).await {
        assert_eq!((err.kind, &err.message), (no_project.kind, &no_project.message));
    }

    f.host.set_project_trust(&f.root, false, false).await.unwrap();
    let restricted = f.host.require_trust(WINDOW).unwrap_err();
    assert_ne!(restricted.kind, ErrorKind::NotFound);
    // An id that is not open is refused for trust too: the check comes before the lookup.
    for id in [open.id, HeapSnapshotId(99)] {
        for err in query_errors(&f, WINDOW, id).await {
            assert_eq!((err.kind, &err.message), (restricted.kind, &restricted.message));
        }
    }
    assert!(!f.base.join("saved.hprof").exists());
    assert!(f.host.heap.get(open.id).is_some(), "a refused close keeps the snapshot");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_every_snapshot() {
    let f = Fixture::new().await;
    let external = f.dump("sample.hprof", &sample());
    f.open(&external).await;

    // A capture: the dump sits in the snapshot directory.
    let captured = ide_heap::create_snapshot_dir(f.host.heap.root()).unwrap();
    let dump = captured.join("dump.hprof");
    sample_with_two_more_nodes().write_to(&dump);
    let origin = ide_heap::HeapOrigin::Captured {
        session: DebugSessionId(1),
        pid: 42,
        java_version: "21".into(),
        taken_while_suspended: false,
        dump_ms: 1,
    };
    let analyzed = analyze(
        &f.host,
        WINDOW,
        origin,
        dump.clone(),
        captured.clone(),
        AnalyzeOptions::default(),
        false,
        &CancellationToken::new(),
        &Channel::new(|_| {}),
    )
    .await
    .unwrap();
    assert!(matches!(analyzed, Analyzed::Ready(_)));

    // An open still running: shutdown cancels it and waits for it to clean up.
    let running_dir = ide_heap::create_snapshot_dir(f.host.heap.root()).unwrap();
    let cancel = CancellationToken::new();
    let running = Running::begin(&f.host, RequestId(50), &cancel);
    assert_eq!(f.snapshot_dirs().len(), 3);

    let in_flight = async {
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(5), cancel.cancelled()).await;
        assert!(cancelled.is_ok(), "shutdown cancels a running capture or open");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::fs::remove_dir_all(&running_dir).unwrap();
        drop(running);
    };
    tokio::join!(f.host.shutdown(), in_flight);

    assert!(f.snapshot_dirs().is_empty(), "{:?}", f.snapshot_dirs());
    assert!(f.host.heap.list().is_empty());
    assert!(external.is_file(), "an opened dump is the user's file");

    let late = CancellationToken::new();
    let _late = Running::begin(&f.host, RequestId(51), &late);
    assert!(late.is_cancelled(), "nothing starts after shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_does_not_wait_forever_for_a_stuck_capture() {
    let f = Fixture::new().await;
    let stuck_dir = ide_heap::create_snapshot_dir(f.host.heap.root()).unwrap();
    let cancel = CancellationToken::new();
    let _stuck = Running::begin(&f.host, RequestId(60), &cancel);
    let started = std::time::Instant::now();
    shutdown_within(&f.host, std::time::Duration::from_millis(200)).await;
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(cancel.is_cancelled());
    assert!(!stuck_dir.exists(), "its directory is removed once the wait is over");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn save_copies_the_dump_and_replaces_the_target() {
    let f = Fixture::new().await;
    let path = f.dump("sample.hprof", &sample());
    let info = f.open(&path).await;
    let target = f.base.join("saved.hprof");
    std::fs::write(&target, "older").unwrap();
    debug_heap_save(&f.host, WINDOW, info.id, target.clone().into()).await.unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), sample().bytes());

    // Over the dump the snapshot itself maps: the index keeps reading the old file.
    debug_heap_save(&f.host, WINDOW, info.id, path.clone().into()).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), sample().bytes());
    assert!(debug_heap_classes(&f.host, WINDOW, info.id).await.is_ok());
    let leftovers: Vec<_> = std::fs::read_dir(&f.base)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_the_project_closes_its_snapshots() {
    let f = Fixture::new().await;
    let path = f.dump("sample.hprof", &sample());
    let info = f.open(&path).await;
    f.host.close_project(WINDOW);
    assert!(f.host.heap.get(info.id).is_none());
    // The directory is deleted on the blocking pool.
    for _ in 0..200 {
        if f.snapshot_dirs().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(f.snapshot_dirs().is_empty());
    assert!(path.is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_without_jvm_session_is_unavailable() {
    let f = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream).await;
    });
    let config = LaunchConfig {
        name: "Remote".into(),
        adapter: "delve".into(),
        request: "attach".into(),
        program: None,
        args: vec![],
        cwd: Some(f.root.clone().into()),
        env: Default::default(),
        extra_json: Some(json!({"debugServer": format!("127.0.0.1:{port}"), "mode": "remote"}).to_string()),
    };
    let session = crate::ops::debug::debug_start(&f.host, WINDOW, config).await.unwrap();
    let (progress, seen) = recorder();
    let result = debug_heap_capture(&f.host, WINDOW, session, RequestId(3), progress).await.unwrap();
    assert_eq!(
        result,
        HeapCaptureResult::Unavailable {
            reason: JvmHeapUnavailable::Memory { reason: JvmMemoryUnavailable::NoJvmProcess }
        }
    );
    assert_eq!(*seen.lock(), [HeapProgress::Dumping]);
    assert!(f.snapshot_dirs().is_empty());
    f.host.debugger.stop(session).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_of_a_missing_session_deletes_its_directory() {
    let f = Fixture::new().await;
    let missing = DebugSessionId(404);
    assert!(debug_heap_capture(&f.host, WINDOW, missing, RequestId(4), Channel::new(|_| {})).await.is_err());
    assert!(f.snapshot_dirs().is_empty());
}

#[test]
fn progress_is_thinned_but_keeps_every_phase() {
    let (progress, seen) = recorder();
    let report = reporter(&progress, || None);
    for done in 0..50 {
        report(HeapPhase::Reading, done, 50).unwrap();
    }
    report(HeapPhase::Linking, 0, 10).unwrap();
    assert_eq!(
        *seen.lock(),
        [
            HeapProgress::Analyzing { phase: HeapPhase::Reading, done: 0, total: 50 },
            HeapProgress::Analyzing { phase: HeapPhase::Linking, done: 0, total: 10 },
        ]
    );
}

#[test]
fn too_little_disk_for_the_index_stops_at_linking() {
    let (progress, _) = recorder();
    let report = reporter(&progress, || Some(1));
    report(HeapPhase::Reading, 0, 50).unwrap();
    let needed = ide_heap::index_need(1000);
    match report(HeapPhase::Linking, 0, 1000) {
        Err(ide_heap::HeapError::NotEnoughDiskSpace { needed: n, available: 1 }) => assert_eq!(n, needed),
        other => panic!("expected NotEnoughDiskSpace, got {other:?}"),
    }
    let (progress, _) = recorder();
    let report = reporter(&progress, || Some(u64::MAX));
    assert!(report(HeapPhase::Linking, 0, 1000).is_ok());
}

/// Answers every request of a session that never runs a JVM.
async fn fake_adapter(stream: tokio::net::TcpStream) {
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);
    let mut seq = 0;
    loop {
        let mut length = None;
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                return;
            }
            let line = line.trim();
            if line.is_empty() {
                break;
            }
            if let Some(n) = line.strip_prefix("Content-Length:") {
                length = n.trim().parse::<usize>().ok();
            }
        }
        let mut body = vec![0; length.unwrap()];
        r.read_exact(&mut body).await.unwrap();
        let msg: Value = serde_json::from_slice(&body).unwrap();
        if msg["type"] != "request" {
            continue;
        }
        let command = msg["command"].as_str().unwrap_or_default().to_owned();
        let reply = match command.as_str() {
            "initialize" => json!({"supportsConfigurationDoneRequest": true}),
            "threads" => json!({"threads": []}),
            _ => json!({}),
        };
        let mut out = vec![
            json!({"type": "response", "request_seq": msg["seq"], "command": command, "success": true, "body": reply}),
        ];
        if command == "launch" || command == "attach" {
            out.push(json!({"type": "event", "event": "initialized"}));
        }
        for mut message in out {
            seq += 1;
            message["seq"] = seq.into();
            let bytes = serde_json::to_vec(&message).unwrap();
            w.write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
            w.write_all(&bytes).await.unwrap();
        }
        if command == "disconnect" {
            return;
        }
    }
}
