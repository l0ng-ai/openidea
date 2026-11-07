//! Real Wasm provider dispatch and the document-edit path used locally and over RPC.
use ide_core::{CancellationToken, ChangeSet, Diagnostic, IdeEvent, Pos, Range, TextChange};
use ide_host::plugins::{Consent, HostWorkspace, PluginHost, set_editor_providers};
use ide_host::{Host, HostConfig, ops};
use ide_plugin::{Invocation, Limits, ProviderDocument};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ID: &str = "test.diagnostics";
const SOURCE: &str = "plugin-provider:test.diagnostics";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/diagnostics")
}

fn plugins(dir: &Path, limits: Limits) -> Arc<PluginHost> {
    let host = Arc::new(PluginHost::new(dir.join("plugins"), Arc::new(|_: Option<&str>, _| {}), limits).unwrap());
    host.install_from_dir(&fixture(), &Consent::all()).unwrap();
    host
}

fn generous() -> Limits {
    Limits { edit_soft: Duration::from_secs(5), edit_hard: Duration::from_secs(10), ..Limits::default() }
}

fn doc(root: &Path, language: &str, text: &str) -> ProviderDocument {
    ProviderDocument { path: root.join("a.txt"), language: language.into(), version: 42, text: text.into() }
}

#[test]
fn declared_languages_receive_versioned_text_and_utf16_ranges() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), generous());
    let result = host.provide_diagnostics(&doc(tmp.path(), "text", "😀BAD\nBAD"), &CancellationToken::new());
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].0, ID);
    let items = &result[0].1;
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].range, Range::new(Pos::new(0, 2), Pos::new(0, 5)));
    assert_eq!(items[1].range, Range::new(Pos::new(1, 0), Pos::new(1, 3)));
    assert_eq!(items[0].message, "BAD in text at version 42");
    assert_eq!(items[0].code.as_deref(), Some("bad-word"));
    assert_eq!(items[0].server.as_deref(), Some(ID));
    assert!(host.provide_diagnostics(&doc(tmp.path(), "rust", "BAD"), &CancellationToken::new()).is_empty());
}

#[test]
fn provider_diagnostics_have_the_same_bounds_and_tags_as_manual_publish() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), generous());
    let result = host.provide_diagnostics(&doc(tmp.path(), "text", "limits"), &CancellationToken::new());
    let items = &result[0].1;
    assert_eq!(items.len(), 5000);
    assert_eq!(items[0].message.len(), 4096);
    assert_eq!(items[0].source.as_ref().unwrap().len(), 128);
    assert_eq!(items[0].code.as_ref().unwrap().len(), 128);
    assert!(items[0].unnecessary && items[0].deprecated);
}

#[test]
fn the_export_does_not_need_project_read_permission() {
    let tmp = tempfile::tempdir().unwrap();
    let package = tmp.path().join("no-capability");
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::copy(fixture().join("dist/plugin.wasm"), package.join("dist/plugin.wasm")).unwrap();
    let manifest = std::fs::read_to_string(fixture().join("plugin.toml")).unwrap();
    std::fs::write(package.join("plugin.toml"), manifest.replace("[capabilities]\nrequired = [\"project.read\"]", ""))
        .unwrap();
    let host = PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), generous()).unwrap();
    host.install_from_dir(&package, &Consent::default()).unwrap();
    assert_eq!(host.provide_diagnostics(&doc(tmp.path(), "text", "BAD"), &CancellationToken::new()).len(), 1);
    assert!(host.run_command(ID, "publish", Some("/project/a.txt"), Invocation::default()).is_err());
}

#[test]
fn diagnostics_is_an_api_1_3_addition() {
    let tmp = tempfile::tempdir().unwrap();
    let package = tmp.path().join("old");
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::copy(fixture().join("dist/plugin.wasm"), package.join("dist/plugin.wasm")).unwrap();
    let manifest = std::fs::read_to_string(fixture().join("plugin.toml")).unwrap();
    std::fs::write(package.join("plugin.toml"), manifest.replace("^1.3", "^1.0")).unwrap();
    let host = PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), generous()).unwrap();
    assert!(host.install_from_dir(&package, &Consent::all()).unwrap_err().message.contains("new in plugin API 1.3"));
}

#[test]
fn late_and_cancelled_answers_are_dropped_without_disabling_the_plugin() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), Limits { edit_soft: Duration::from_millis(10), ..generous() });
    assert!(host.provide_diagnostics(&doc(tmp.path(), "text", "slow BAD"), &CancellationToken::new()).is_empty());
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(host.provide_diagnostics(&doc(tmp.path(), "text", "BAD"), &cancel).is_empty());
    assert_eq!(host.run_command(ID, "calls", None, Invocation::default()).unwrap().as_deref(), Some("1"));
}

#[test]
fn cancelling_a_queued_provider_does_not_interrupt_another_windows_command() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), generous());
    host.run_command(ID, "calls", None, Invocation::default()).unwrap();
    let waiter = {
        let host = host.clone();
        std::thread::spawn(move || host.run_command(ID, "wait", None, Invocation::default()))
    };
    std::thread::sleep(Duration::from_millis(50));
    let cancel = CancellationToken::new();
    let canceller = {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.cancel();
        })
    };
    assert!(host.provide_diagnostics(&doc(tmp.path(), "text", "BAD"), &cancel).is_empty());
    canceller.join().unwrap();
    assert_eq!(waiter.join().unwrap().unwrap().as_deref(), Some("finished"));
    assert_eq!(host.run_command(ID, "calls", None, Invocation::default()).unwrap().as_deref(), Some("0"));
}

#[test]
fn editor_requests_expire_in_the_queue_without_running_after_a_command() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), Limits { edit_soft: Duration::from_millis(10), ..generous() });
    host.run_command(ID, "calls", None, Invocation::default()).unwrap();
    let waiter = {
        let host = host.clone();
        std::thread::spawn(move || host.run_command(ID, "wait", None, Invocation::default()))
    };
    std::thread::sleep(Duration::from_millis(50));
    assert!(host.provide_diagnostics(&doc(tmp.path(), "text", "BAD"), &CancellationToken::new()).is_empty());
    assert_eq!(waiter.join().unwrap().unwrap().as_deref(), Some("finished"));
    assert_eq!(host.run_command(ID, "calls", None, Invocation::default()).unwrap().as_deref(), Some("0"));
    assert_eq!(host.info_of(ID).unwrap().stats.slow_calls, 1);
}

#[test]
fn typing_on_cancels_a_running_provider_before_its_hard_deadline() {
    let tmp = tempfile::tempdir().unwrap();
    let host = plugins(tmp.path(), Limits { fuel: u64::MAX, ..generous() });
    host.run_command(ID, "calls", None, Invocation::default()).unwrap();
    let cancel = CancellationToken::new();
    let canceller = {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel.cancel();
        })
    };
    let started = Instant::now();
    assert!(host.provide_diagnostics(&doc(tmp.path(), "text", "spin BAD"), &cancel).is_empty());
    assert!(started.elapsed() < Duration::from_secs(2));
    canceller.join().unwrap();
}

// This executable has one edit-path test because editor providers are installed once per process.
type Events = Arc<Mutex<Vec<(String, IdeEvent)>>>;

fn runtime_host(base: &Path, events: Events) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |window| {
            let (events, window) = (events.clone(), window.to_owned());
            Arc::new(move |event: IdeEvent| events.lock().push((window.clone(), event)))
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn latest(events: &Events, window: &str, source: &str) -> Option<Vec<Diagnostic>> {
    events.lock().iter().rev().find_map(|(w, e)| match e {
        IdeEvent::Diagnostics { source: s, items, .. } if w == window && s == source => Some(items.clone()),
        _ => None,
    })
}

async fn wait_for(events: &Events, window: &str, predicate: impl Fn(&[Diagnostic]) -> bool) {
    wait_for_source(events, window, SOURCE, predicate).await;
}

async fn wait_for_source(events: &Events, window: &str, source: &str, predicate: impl Fn(&[Diagnostic]) -> bool) {
    let start = Instant::now();
    loop {
        if latest(events, window, source).is_some_and(|items| predicate(&items)) {
            return;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "missing diagnostics for {window}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn replace(host: &Host, window: &str, info: &ide_workspace::DocumentInfo, text: &str) -> u32 {
    let project = host.project(window).unwrap();
    let snapshot = project.documents.snapshot(info.id).unwrap();
    let len = snapshot.text.encode_utf16().count() as u32;
    ops::doc::edit(
        host,
        window,
        info.id,
        snapshot.version,
        ChangeSet { changes: vec![TextChange { from: 0, to: len, insert: text.into() }] },
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn typing_is_debounced_versioned_and_scoped_to_document_project_and_window_lifetimes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let path = root.join("a.txt");
    std::fs::write(&path, "clean").unwrap();
    let events: Events = Arc::default();
    let host = runtime_host(&root.join("app"), events.clone());
    let plugins = plugins(&root, generous());
    plugins.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(&host)))));
    set_editor_providers(Some(&plugins));
    let left = host.open_light("left", &path).unwrap();
    host.open_light("right", &path).unwrap();
    let a = ops::doc::open(&host, "left", path.clone()).await.unwrap();
    let b = ops::doc::open(&host, "right", path.clone()).await.unwrap();
    let second_tab = ops::doc::open(&host, "right", path.clone()).await.unwrap();
    assert_eq!(b.id, second_tab.id);
    wait_for(&events, "left", |items| items.is_empty()).await;
    wait_for(&events, "right", |items| items.is_empty()).await;

    let calls: u64 = plugins.run_command(ID, "calls", None, Invocation::default()).unwrap().unwrap().parse().unwrap();
    events.lock().clear();
    replace(&host, "left", &a, "BAD");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let version = replace(&host, "left", &a, "😀BAD");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(latest(&events, "left", SOURCE).is_none(), "300ms after the latest edit");
    wait_for(&events, "left", |items| !items.is_empty()).await;
    assert_eq!(
        latest(&events, "left", SOURCE).unwrap()[0].message,
        format!("BAD in {} at version {version}", a.language)
    );
    assert!(latest(&events, "right", SOURCE).is_none(), "other window has its own buffer");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "clean", "no save required");
    let after: u64 = plugins.run_command(ID, "calls", None, Invocation::default()).unwrap().unwrap().parse().unwrap();
    assert_eq!(after, calls + 1, "the edit burst was coalesced");

    plugins.run_command(ID, "publish", path.to_str(), Invocation::default()).unwrap();
    let manual_window = events.lock().iter().find_map(|(window, event)| matches!(event, IdeEvent::Diagnostics { source, items, .. } if source == "plugin:test.diagnostics" && !items.is_empty()).then(|| window.clone())).unwrap();
    assert_eq!(latest(&events, &manual_window, "plugin:test.diagnostics").unwrap()[0].message, "Manual problem");
    replace(&host, "left", &a, "clean again");
    wait_for(&events, "left", |items| items.is_empty()).await;
    assert_eq!(latest(&events, &manual_window, "plugin:test.diagnostics").unwrap()[0].message, "Manual problem");

    events.lock().clear();
    replace(&host, "left", &a, "slow BAD");
    tokio::time::sleep(Duration::from_millis(350)).await;
    replace(&host, "left", &a, "latest clean");
    wait_for(&events, "left", |items| items.is_empty()).await;
    assert!(
        !events.lock().iter().any(|(_, e)| matches!(e, IdeEvent::Diagnostics { items, .. } if !items.is_empty())),
        "superseded in-flight answers never publish"
    );

    replace(&host, "right", &b, "BAD right");
    wait_for(&events, "right", |items| !items.is_empty()).await;
    ops::doc::close(&host, "right", b.id).unwrap();
    assert!(!latest(&events, "right", SOURCE).unwrap().is_empty(), "another pane still owns this document");
    ops::doc::close(&host, "right", second_tab.id).unwrap();
    wait_for(&events, "right", |items| items.is_empty()).await;
    replace(&host, "left", &a, "BAD left");
    wait_for(&events, "left", |items| !items.is_empty()).await;
    plugins.set_enabled(ID, false).unwrap();
    wait_for(&events, "left", |items| items.is_empty()).await;
    plugins.set_enabled(ID, true).unwrap();

    events.lock().clear();
    replace(&host, "left", &a, "slow BAD closing");
    tokio::time::sleep(Duration::from_millis(350)).await;
    host.close_project("left");
    // Keep the old Project alive deliberately: window reuse must still cancel it.
    assert_eq!(left.documents.snapshot(a.id).unwrap().text, "slow BAD closing");
    host.open_light("left", &path).unwrap();
    let reopened = ops::doc::open(&host, "left", path.clone()).await.unwrap();
    wait_for(&events, "left", |items| items.is_empty()).await;
    assert!(!events.lock().iter().any(|(_, e)| matches!(e, IdeEvent::Diagnostics { items, .. } if !items.is_empty())));
    // Project plugins receive only snapshots from the project that owns their declaration.
    let project_package = root.join(ide_host::plugins::DEV_PLUGINS_DIR).join("diagnostics");
    std::fs::create_dir_all(project_package.join("dist")).unwrap();
    std::fs::copy(fixture().join("dist/plugin.wasm"), project_package.join("dist/plugin.wasm")).unwrap();
    let manifest = std::fs::read_to_string(fixture().join("plugin.toml")).unwrap();
    std::fs::write(project_package.join("plugin.toml"), manifest.replace(ID, "project.diagnostics")).unwrap();
    plugins.set_project_policy(Arc::new(|_| true));
    plugins.sync_project(&root);
    plugins.grant("project.diagnostics", &Consent::all()).unwrap();
    replace(&host, "left", &reopened, "BAD in project");
    wait_for(&events, "left", |items| !items.is_empty()).await;
    let project_source = "plugin-provider:project.diagnostics";
    wait_for_source(&events, "left", project_source, |items| !items.is_empty()).await;
    let elsewhere = root.join("other");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let other_path = elsewhere.join("other.txt");
    std::fs::write(&other_path, "BAD outside").unwrap();
    host.open_light("elsewhere", &other_path).unwrap();
    ops::doc::open(&host, "elsewhere", other_path).await.unwrap();
    wait_for(&events, "elsewhere", |items| !items.is_empty()).await;
    assert!(latest(&events, "elsewhere", project_source).is_none());
    plugins.restrict_project(&root);
    assert!(latest(&events, "left", project_source).unwrap().is_empty());
    // A completed answer may still be waiting for a sibling when its plugin crashes.
    let sibling = root.join("slow-sibling");
    std::fs::create_dir_all(sibling.join("dist")).unwrap();
    std::fs::copy(fixture().join("dist/plugin.wasm"), sibling.join("dist/plugin.wasm")).unwrap();
    let manifest = std::fs::read_to_string(fixture().join("plugin.toml")).unwrap();
    std::fs::write(
        sibling.join("plugin.toml"),
        manifest.replace(ID, "test.slow").replace("[\"text\", \"plaintext\"]", "[\"plaintext\"]"),
    )
    .unwrap();
    plugins.install_from_dir(&sibling, &Consent::all()).unwrap();
    plugins.run_command("test.slow", "calls", None, Invocation::default()).unwrap();
    let calls = plugins.run_command(ID, "calls", None, Invocation::default()).unwrap();
    events.lock().clear();
    replace(&host, "left", &reopened, "BAD completed before crash");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let waiter = {
        let plugins = plugins.clone();
        std::thread::spawn(move || plugins.run_command("test.slow", "wait", None, Invocation::default()))
    };
    let started = Instant::now();
    while plugins.run_command(ID, "calls", None, Invocation::default()).unwrap() == calls {
        assert!(started.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        latest(&events, "left", SOURCE).is_none_or(|items| items.is_empty()),
        "the sibling still holds the result: {:?}",
        latest(&events, "left", SOURCE)
    );
    assert!(plugins.provide_diagnostics(&doc(&root, "text", "panic"), &CancellationToken::new()).is_empty());
    waiter.join().unwrap().unwrap();
    wait_for_source(&events, "left", "plugin-provider:test.slow", |items| !items.is_empty()).await;
    assert!(
        latest(&events, "left", SOURCE).is_none_or(|items| items.is_empty()),
        "a crash invalidates completed answers"
    );
    ops::doc::close(&host, "left", reopened.id).unwrap();
    host.shutdown().await;
    set_editor_providers(None);
}
