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

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Moving a class of `fixtures/php-app` to another PSR-4 folder changes its
/// namespace and every import of it, through the file-move refactoring.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_engine_updates_namespaces_and_imports_when_a_file_moves() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("php-app");
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app"), &root);
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let from = root.join("src/Support/Collection.php");
    let to = root.join("src/Collections/Collection.php");
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    let moves = vec![ide_workspace::FileMove { from: from.clone().into(), to: to.clone().into() }];
    let edits =
        ops::refactor::refactor_file_move_edits(&host, "main", ide_core::RequestId(1), moves.clone()).await.unwrap();
    assert!(edits.errors.is_empty(), "{:?}", edits.errors);
    assert_eq!(edits.servers.first().map(String::as_str), Some(SERVER_NAME));
    ops::refactor::refactor_move_files(&host, "main", moves, edits.edit, "Move".into()).await.unwrap();

    let read = |rel: &str| std::fs::read_to_string(root.join(rel)).unwrap();
    assert!(!from.exists());
    assert!(read("src/Collections/Collection.php").contains(r"namespace App\Collections;"));
    for user in [
        "src/Library.php",
        "src/Contracts/Repository.php",
        "src/Repository/AbstractRepository.php",
        "src/Repository/BookRepository.php",
        "tests/CollectionTest.php",
    ] {
        let text = read(user);
        assert!(text.contains(r"use App\Collections\Collection;"), "{user}:\n{text}");
        assert!(!text.contains(r"App\Support\Collection"), "{user}:\n{text}");
    }
    host.close_project("main");
}

/// Runs Inspect Code over `scope`, returning the diagnostic codes per file
/// (relative path) and the summary.
async fn inspect_code(
    host: &Host,
    scope: ide_search::SearchScope,
) -> (std::collections::BTreeMap<String, Vec<String>>, ops::analysis::InspectSummary, u32) {
    let events: Arc<Mutex<Vec<ops::analysis::InspectEvent>>> = Arc::default();
    let sink = events.clone();
    ops::analysis::inspect_code(
        host,
        "main",
        ide_core::RequestId(7),
        scope,
        ops::Channel::new(move |e| sink.lock().push(e)),
    )
    .await
    .unwrap();
    let mut files = std::collections::BTreeMap::new();
    let (mut summary, mut total) = (None, 0);
    for event in events.lock().drain(..) {
        match event {
            ops::analysis::InspectEvent::Started { total: t } => total = t,
            ops::analysis::InspectEvent::File { file, .. } => {
                let codes = file.diagnostics.into_iter().map(|d| d.code.unwrap_or_else(|| "syntax".into())).collect();
                files.insert(file.rel_path.replace('\\', "/"), codes);
            }
            ops::analysis::InspectEvent::Done { summary: s } => summary = Some(s),
        }
    }
    (files, summary.expect("done"), total)
}

/// Inspect Code sends PHP files to the native engine while it runs (after
/// indexing, with unsaved buffers), and the inspection profile in effect
/// turns its inspections off.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inspect_code_runs_the_native_engine_over_php_files() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/Foo.php"), "<?php\nnamespace App;\n\nclass Foo {}\n");
    write(&root.join("src/Bar.php"), "<?php\nnamespace App;\n\nnew Foo();\nnew Missing();\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    let src = || ide_search::SearchScope::Directory { path: root.join("src").into() };

    // Run right away: Inspect Code waits for the index (no `Missing` before it
    // knows `Foo`).
    let (files, summary, total) = inspect_code(&host, src()).await;
    assert_eq!(total, 2);
    assert_eq!(files["src/Bar.php"], ["PhpUndefinedClass"], "{files:?}");
    assert_eq!(files["src/Foo.php"], Vec::<String>::new());
    assert_eq!((summary.files, summary.problems, summary.skipped, summary.failed), (2, 1, 0, 0));
    assert!(!summary.cancelled);

    // An open file is inspected as edited.
    let bar = root.join("src").join("Bar.php");
    let doc = ops::doc::open(&host, "main", bar.clone()).await.unwrap();
    let at = doc.text.find("new Missing();").unwrap() as u32;
    let changes = ChangeSet { changes: vec![TextChange { from: at, to: at + 14, insert: "$x = ;".into() }] };
    ops::doc::edit(&host, "main", doc.id, doc.version, changes).unwrap();
    let (files, _, _) = inspect_code(&host, src()).await;
    assert_eq!(files["src/Bar.php"].first().map(String::as_str), Some("syntax"), "{files:?}");
    assert!(!files["src/Bar.php"].contains(&"PhpUndefinedClass".to_owned()));
    ops::doc::close(&host, "main", doc.id).unwrap();

    // Turned off in the inspection profile in effect (Default, IDE level).
    ops::project::set_settings(
        &host,
        "main",
        SettingsScope::Global,
        "inspections.default",
        r#"{"lsp:php:PhpUndefinedClass":{"enabled":false}}"#,
    )
    .unwrap();
    until("the inspection to be turned off", || !engine.inspections().ids().contains(&"PhpUndefinedClass")).await;
    let (files, summary, _) = inspect_code(&host, src()).await;
    assert_eq!(files["src/Bar.php"], Vec::<String>::new());
    assert_eq!(summary.problems, 0);
    host.close_project("main");
}
