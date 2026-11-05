//! The native PHP engine inside a project: started by Settings › PHP › Engine,
//! indexing in the background until ready, following open documents and
//! file changes, and stopped with the setting or the project.

use ide_core::{ChangeSet, IdeEvent, SharedSink, TextChange};
use ide_host::{Host, HostConfig, ops};
use ide_php::engine::{EngineState, PhpEngine, SERVER_NAME};
use ide_php::names::NameKind;
use ide_workspace::settings::SettingsScope;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(60);

fn host(base: &Path, events: Arc<Mutex<Vec<IdeEvent>>>) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(move |_| {
            let events = events.clone();
            let sink: SharedSink = Arc::new(move |e: IdeEvent| events.lock().push(e));
            sink
        }),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn set_engine(host: &Host, value: &str) {
    ops::project::set_settings(host, "main", SettingsScope::Project, "languages.php.engine", &format!("\"{value}\""))
        .unwrap();
}

/// Polls until `f` is true (settings apply and watcher batches are asynchronous).
async fn until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn has_class(engine: &PhpEngine, fqn: &str) -> bool {
    engine.index().is_some_and(|i| !i.declarations(NameKind::ClassLike, fqn).unwrap().is_empty())
}

fn server_events(events: &Mutex<Vec<IdeEvent>>) -> Vec<String> {
    events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::LanguageServer { name, status, .. } if name == SERVER_NAME => Some(format!("{status:?}")),
            IdeEvent::LanguageServerRemoved { .. } => Some("Removed".into()),
            _ => None,
        })
        .collect()
}

fn last_index_state(events: &Mutex<Vec<IdeEvent>>) -> Option<bool> {
    events.lock().iter().rev().find_map(|e| match e {
        IdeEvent::IndexState { indexing, .. } => Some(*indexing),
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_engine_indexes_a_php_project_until_ready() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/Foo.php"), "<?php\nnamespace App;\n\nclass Foo {}\n");
    write(&root.join("src/Service/Mailer.php"), "<?php\nnamespace App\\Service;\n\ninterface Mailer {}\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());

    // Intelephense is the default: no engine.
    let project = host.open_project("main", &root).unwrap();
    assert!(project.php.engine().is_none());

    // Switching to the native engine starts it; it indexes in the background.
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));
    assert_eq!(engine.status().state, EngineState::Ready);
    assert_eq!(engine.status().files, 2);
    assert!(has_class(&engine, "App\\Foo"));
    assert!(has_class(&engine, "App\\Service\\Mailer"));
    assert!(project.cache_dir.join("php").join(ide_php::index::FILE_NAME).is_file());
    assert_eq!(server_events(&events), ["Starting", "Ready"], "reported like a language server");
    project.index.wait_idle(WAIT);
    until("dumb mode to end", || last_index_state(&events) == Some(false)).await;

    // An open document overrides the file on disk.
    let foo = root.join("src").join("Foo.php");
    let doc = ops::doc::open(&host, "main", foo.clone()).await.unwrap();
    let at = doc.text.find("Foo {").unwrap() as u32;
    let changes = ChangeSet { changes: vec![TextChange { from: at, to: at + 3, insert: "Edited".into() }] };
    ops::doc::edit(&host, "main", doc.id, doc.version, changes).unwrap();
    let classes = |engine: &PhpEngine| -> Vec<String> {
        engine.summary(&foo).unwrap().unwrap().class_likes.into_iter().map(|c| c.fqn).collect()
    };
    assert_eq!(classes(&engine), ["App\\Edited"]);
    assert!(has_class(&engine, "App\\Foo"), "the index keeps the saved file");

    // Watcher batches reach the index.
    write(&root.join("src/Bar.php"), "<?php\nnamespace App;\n\nfinal class Bar {}\n");
    until("the new class to be indexed", || has_class(&engine, "App\\Bar")).await;
    std::fs::remove_file(root.join("src/Service/Mailer.php")).unwrap();
    until("the deleted interface to leave the index", || !has_class(&engine, "App\\Service\\Mailer")).await;

    // Back to Intelephense: the engine stops and leaves the server list.
    set_engine(&host, "intelephense");
    until("the engine to stop", || project.php.engine().is_none()).await;
    assert_eq!(engine.status().state, EngineState::Stopped);
    until("the engine to be removed", || server_events(&events).last().map(String::as_str) == Some("Removed")).await;
    drop(engine);

    // Reopened with the setting on, the engine starts with the project and its
    // persistent index is already complete.
    set_engine(&host, "native");
    until("the engine to start again", || project.php.engine().is_some()).await;
    host.close_project("main");
    assert!(project.php.engine().is_none(), "closing the project stops the engine");
    let project = host.open_project("main", &root).unwrap();
    let engine = project.php.engine().expect("started on open");
    assert!(engine.wait_idle(WAIT));
    assert_eq!(engine.status().state, EngineState::Ready);
    assert!(has_class(&engine, "App\\Bar"));
    assert!(!has_class(&engine, "App\\Service\\Mailer"));
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_engine_stays_inactive_without_php() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("docs");
    write(&root.join("README.md"), "# docs\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));
    assert_eq!(engine.status().state, EngineState::Inactive);
    assert!(server_events(&events).is_empty(), "nothing is reported for a project without PHP");
    assert!(!PathBuf::from(&project.cache_dir).join("php").exists());
    host.close_project("main");
}
