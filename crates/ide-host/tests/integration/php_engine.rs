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

    // The native engine is the default: it starts with the project and indexes in the background.
    let project = host.open_project("main", &root).unwrap();
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

    // Switching to the Intelephense fallback: the engine stops and leaves the server list.
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
    let mut progress = Vec::new();
    for event in events.lock().drain(..) {
        match event {
            ops::analysis::InspectEvent::Started { total: t } => total = t,
            ops::analysis::InspectEvent::File { file, done } => {
                progress.push(done);
                let codes = file.diagnostics.into_iter().map(|d| d.code.unwrap_or_else(|| "syntax".into())).collect();
                files.insert(file.rel_path.replace('\\', "/"), codes);
            }
            ops::analysis::InspectEvent::Done { summary: s } => summary = Some(s),
        }
    }
    // The files are inspected in parallel (phase 9.4): each reports its
    // progress once, counting up to the total.
    progress.sort_unstable();
    assert_eq!(progress, (1..=progress.len() as u32).collect::<Vec<_>>(), "progress");
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

/// Change Signature through the dispatch: the native engine offers the
/// action with the current signature as `data` and no edit; resolved with
/// the new signature filled in (as the editor's dialog does), it changes the
/// declaration and the calls in other files.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn change_signature_is_resolved_by_the_native_engine() {
    use ide_php::refactor::{CHANGE_SIGNATURE, ChangeSignature, SignatureParameter};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    let util =
        "<?php\nnamespace App;\n\nfunction total(int $qty, float $price): float\n{\n    return $qty * $price;\n}\n";
    write(&root.join("src/util.php"), util);
    write(&root.join("src/Cart.php"), "<?php\nnamespace App;\n\necho total(2, 1.5);\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    assert!(project.php.engine().unwrap().wait_idle(WAIT));

    let doc = ops::doc::open(&host, "main", root.join("src/util.php")).await.unwrap();
    let at = ide_core::Pos::new(3, 10);
    let range = ide_core::Range::new(at, at);
    let query =
        ops::lsp::lsp_code_action_query(&host, "main", ide_core::RequestId(3), doc.id, range, vec!["refactor".into()])
            .await
            .unwrap();
    assert!(query.advertised_kinds.unwrap().contains(&CHANGE_SIGNATURE.to_owned()));
    let mut action = query
        .actions
        .into_iter()
        .find(|a| a.kind.as_deref() == Some(CHANGE_SIGNATURE))
        .expect("Change signature is offered");
    assert_eq!(action.title, r"Change signature of 'App\total'");
    assert!(action.edit.is_none());
    let Some(serde_json::Value::String(json)) = &action.data else { panic!("data: {:?}", action.data) };
    let mut data: ChangeSignature = serde_json::from_str(json).unwrap();
    assert_eq!(data.signature.parameters.len(), 2);

    // Without the new signature there is nothing to do.
    let unresolved = ops::lsp::lsp_resolve_code_action(&host, "main", doc.id, action.clone()).await;
    assert!(unresolved.unwrap_err().message.contains("new signature"));

    let mut change = data.signature.clone();
    change.parameters.swap(0, 1);
    change.parameters.push(SignatureParameter {
        name: "discount".into(),
        ty: "float".into(),
        default_value: "0.0".into(),
        ..SignatureParameter::default()
    });
    data.change = Some(change);
    action.data = Some(serde_json::Value::String(serde_json::to_string(&data).unwrap()));
    let resolved = ops::lsp::lsp_resolve_code_action(&host, "main", doc.id, action.clone()).await.unwrap();
    assert_eq!(resolved.edit.expect("an edit").files.len(), 2);

    ops::lsp::lsp_apply_code_action(&host, "main", doc.id, action).await.unwrap();
    let text = project.documents.snapshot(doc.id).unwrap().text;
    assert!(text.contains("function total(float $price, int $qty, float $discount = 0.0): float"), "{text}");
    let cart = std::fs::read_to_string(root.join("src/Cart.php")).unwrap();
    assert!(cart.contains("echo total(1.5, 2);"), "{cart}");
    host.close_project("main");
}

/// Rename through the dispatch: the native engine's edit renames the calls,
/// and the dynamic uses it leaves alone come back as possible usages.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_returns_the_possible_usages_of_the_native_engine() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/util.php"), "<?php\nnamespace App;\n\nfunction total(int $qty): int { return $qty; }\n");
    let cart = "<?php\nnamespace App;\n\necho total(2);\necho call_user_func('App\\total', 3);\n";
    write(&root.join("src/Cart.php"), cart);
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    assert!(project.php.engine().unwrap().wait_idle(WAIT));

    let doc = ops::doc::open(&host, "main", root.join("src/util.php")).await.unwrap();
    let renamed =
        ops::lsp::lsp_rename(&host, "main", ide_core::RequestId(4), doc.id, ide_core::Pos::new(3, 11), "sum".into())
            .await
            .unwrap();
    assert_eq!(renamed.edit.files.len(), 2, "{:?}", renamed.edit);
    let possible: Vec<(PathBuf, u32, u32)> = renamed
        .possible_usages
        .iter()
        .map(|location| (PathBuf::from(location.path.clone()), location.range.start.line, location.range.start.col))
        .collect();
    assert_eq!(possible, [(root.join("src/Cart.php"), 4, 21)]);
    host.close_project("main");
}

/// Pull Members Up through the hierarchy dispatch: the native engine lists
/// the class's members and destinations, and computes the edit moving the
/// chosen ones into the parent class in another file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_members_up_is_answered_by_the_native_engine() {
    use ide_lsp::types::{HierarchyChoice, HierarchyRefactoring};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("zoo");
    write(&root.join("composer.json"), r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#);
    write(&root.join("src/Animal.php"), "<?php\nnamespace App;\n\nclass Animal\n{\n}\n");
    let dog = "<?php\nnamespace App;\n\nclass Dog extends Animal\n{\n    public function bark(): string\n    {\n        return 'woof';\n    }\n}\n";
    write(&root.join("src/Dog.php"), dog);
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    assert!(project.php.engine().unwrap().wait_idle(WAIT));

    let doc = ops::doc::open(&host, "main", root.join("src/Dog.php")).await.unwrap();
    let at = ide_core::Pos::new(5, 21);
    let kind = HierarchyRefactoring::PullUp;
    let info = ops::lsp::lsp_hierarchy_members(&host, "main", ide_core::RequestId(4), doc.id, at, kind).await.unwrap();
    assert_eq!(info.class_name, "Dog");
    assert_eq!(info.targets.len(), 1);
    assert_eq!(info.targets[0].qualified_name, r"App\Animal");
    assert_eq!(info.members.len(), 1);
    assert!(info.members[0].selected);

    let choices = vec![HierarchyChoice { id: info.members[0].id.clone(), make_abstract: false }];
    let target = Some(info.targets[0].id.clone());
    let refactored =
        ops::lsp::lsp_hierarchy_refactor(&host, "main", ide_core::RequestId(5), doc.id, at, kind, target, choices)
            .await
            .unwrap();
    assert!(refactored.problems.is_empty());
    let edit = refactored.edit.expect("an edit");
    assert_eq!(edit.files.len(), 2);
    ops::lsp::apply_workspace_edit(&host, "main", edit).await.unwrap();
    let text = project.documents.snapshot(doc.id).unwrap().text;
    assert!(!text.contains("bark"), "{text}");
    let animal = std::fs::read_to_string(root.join("src/Animal.php")).unwrap();
    assert!(animal.contains("public function bark(): string"), "{animal}");
    host.close_project("main");
}

/// Laravel's "Create translation key…": the code action on a translation key
/// (PHP and Blade) carries the request of the client's dialog, and the
/// command writes the texts the dialog asked for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_create_translation_key_action_and_command() {
    use ide_core::{FileEdit, Pos, Range};
    use ide_host::ops::laravel::{TranslationText, php_laravel_create_translation};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("blog");
    write(&root.join("composer.json"), r#"{"require": {"laravel/framework": "^11.0"}}"#);
    write(&root.join("lang/en/messages.php"), "<?php\n\nreturn [\n    'welcome' => 'Welcome',\n];\n");
    write(&root.join("lang/fr/messages.php"), "<?php\n\nreturn [\n    'welcome' => 'Bienvenue',\n];\n");
    write(&root.join("app/Probe.php"), "<?php\n__('messages.saved');\n");
    write(&root.join("resources/views/page.blade.php"), "<p>@lang('messages.saved')</p>\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let action_at = |path: PathBuf, pos: Pos, only: Vec<String>| {
        let host = host.clone();
        async move {
            let doc = ops::doc::open(&host, "main", path).await.unwrap();
            // Without the action, a template has no server answering code actions (an error).
            let actions = ops::lsp::lsp_code_actions(&host, "main", doc.id, Range::new(pos, pos), only).await;
            actions
                .unwrap_or_default()
                .into_iter()
                .find(|a| a.title.starts_with("Create translation key 'messages.saved'…"))
        }
    };
    for (path, pos) in
        [(root.join("app/Probe.php"), Pos::new(1, 8)), (root.join("resources/views/page.blade.php"), Pos::new(0, 14))]
    {
        let action = action_at(path.clone(), pos, Vec::new()).await.unwrap_or_else(|| panic!("{path:?}"));
        assert_eq!(action.kind.as_deref(), Some("refactor.rewrite"));
        assert!(action.edit.is_none(), "the dialog asks for the texts first");
        let command = action.command.expect("the client command");
        assert_eq!(command.command, "laravel.createTranslation");
        let [serde_json::Value::String(json)] = command.arguments.as_slice() else { panic!("{:?}", command.arguments) };
        let request: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(request["key"], "messages.saved");
        assert_eq!(request["locales"][0], serde_json::json!({"locale": "en", "text": "Saved", "exists": false}));
        assert_eq!(request["locales"][1]["locale"], "fr");
        // Not among the quick-fixes.
        assert!(action_at(path, pos, vec!["quickfix".into()]).await.is_none());
    }

    let edit = php_laravel_create_translation(
        &host,
        "main",
        "messages.saved".into(),
        vec![TranslationText { locale: "fr".into(), text: "Enregistré".into() }],
    )
    .await
    .unwrap();
    let [FileEdit::Edit { path, edits, .. }] = edit.files.as_slice() else { panic!("{edit:?}") };
    assert_eq!(PathBuf::from(path.clone()), root.join("lang/fr/messages.php"));
    assert_eq!(edits[0].new_text, "\n    'saved' => 'Enregistré',");
    let err = php_laravel_create_translation(&host, "main", "unknown::x.y".into(), Vec::new()).await.unwrap_err();
    assert!(err.message.contains("can't be added"), "{err:?}");
    host.close_project("main");
}

/// Settings › PHP › Laravel › Database: the chosen data source's schema reaches the engine
/// when the setting changes, when the Database tool changes the schema, and on demand.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_live_database_schema() {
    use ide_db::split::SqlStatement;
    use ide_db::{DataSource, DbDriver};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("blog");
    write(&root.join("composer.json"), r#"{"require": {"laravel/framework": "^11.0"}}"#);
    write(&root.join("app/Probe.php"), "<?php\n");
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let source = DataSource {
        id: "mem".into(),
        name: "app".into(),
        driver: DbDriver::Sqlite,
        file: Some(":memory:".into()),
        ..Default::default()
    };
    ops::db::save_sources(&host, "main", vec![source]).await.unwrap();
    let run = |sql: &str| {
        let host = host.clone();
        let statement = SqlStatement { from: 0, to: sql.len() as u32, text: sql.to_owned() };
        async move { ops::db::execute(&host, "main", ide_core::RequestId(90), "mem", vec![statement], 10).await.unwrap() }
    };
    let outcome = run("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, rating REAL)").await;
    assert_eq!(outcome[0].error, None);
    let columns = |engine: &PhpEngine| -> Vec<(String, String)> {
        let schema = engine.live_schema();
        let Some(schema) = schema else { return Vec::new() };
        schema
            .tables
            .iter()
            .filter(|table| table.name == "posts")
            .flat_map(|table| table.columns.iter().map(|c| (c.name.clone(), c.data_type.clone())))
            .collect()
    };
    assert!(columns(&engine).is_empty());

    // Choosing the data source reads its schema.
    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.php.laravel.database", "\"mem\"")
        .unwrap();
    until("the live schema", || columns(&engine).len() == 3).await;
    assert_eq!(engine.live_schema().unwrap().source, "app");
    assert_eq!(project.php.live_schema_source(), "mem");
    let facts = engine.resolver().laravel();
    let rating = facts
        .columns("posts")
        .into_iter()
        .find(|(_, column)| column.name == "rating")
        .map(|(t, c)| (c.ty.0.clone(), t.database.clone()));
    assert_eq!(rating, Some(("float".to_owned(), Some("app".to_owned()))));

    // A DDL statement in the Database tool reads it again; queries don't.
    run("ALTER TABLE posts ADD COLUMN views INTEGER").await;
    until("the changed schema", || columns(&engine).iter().any(|(name, _)| name == "views")).await;

    // On demand.
    run("CREATE TABLE audits (id INTEGER PRIMARY KEY)").await;
    let status = ops::laravel::php_laravel_refresh_schema(&host, "main").await.unwrap();
    assert_eq!(status, Some(ops::laravel::LaravelSchemaStatus { source: "app".into(), tables: 2 }));

    // No data source: the migrations alone.
    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.php.laravel.database", "\"\"")
        .unwrap();
    until("the live schema to go", || engine.live_schema().is_none()).await;
    assert_eq!(ops::laravel::php_laravel_refresh_schema(&host, "main").await.unwrap(), None);
    host.close_project("main");
}

/// Laravel's Eloquent model view: the lens on a model class runs the client
/// command with the class, the view command answers what the panel shows, and
/// the Add Columns command makes a migration and fills `$fillable`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_model_view_lens_and_commands() {
    use ide_core::FileEdit;
    use ide_host::ops::laravel::{LaravelNewColumn, php_laravel_add_columns, php_laravel_model_view};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("blog");
    write(
        &root.join("composer.json"),
        r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#,
    );
    write(
        &root.join("vendor/laravel/framework/src/Model.php"),
        "<?php\nnamespace Illuminate\\Database\\Eloquent;\n\nabstract class Model\n{\n    protected $fillable = [];\n}\n",
    );
    write(
        &root.join("app/Models/Post.php"),
        "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Post extends Model\n{\n    protected $fillable = ['title'];\n\n    public function scopePublished($query)\n    {\n        return $query;\n    }\n}\n",
    );
    write(
        &root.join("database/migrations/2024_01_01_000000_create_posts_table.php"),
        "<?php\n\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class {\n    public function up(): void\n    {\n        Schema::create('posts', function ($table) {\n            $table->id();\n            $table->string('title');\n        });\n    }\n};\n",
    );
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let doc = ops::doc::open(&host, "main", root.join("app/Models/Post.php")).await.unwrap();
    let lenses = ops::lsp::lsp_code_lens(&host, "main", doc.id).await.unwrap();
    let lens = lenses
        .iter()
        .find(|lens| lens.command.as_ref().is_some_and(|c| c.command == "laravel.modelView"))
        .unwrap_or_else(|| panic!("{lenses:?}"));
    let command = lens.command.as_ref().unwrap();
    assert_eq!(command.title, "posts · 2 columns · 0 relations");
    assert_eq!(command.arguments, [serde_json::Value::String("App\\Models\\Post".into())]);
    assert_eq!(lens.range.start.line, 5);

    let view = php_laravel_model_view(&host, "main", "App\\Models\\Post".into()).await.unwrap();
    assert_eq!((view.table.as_str(), view.primary_key.as_str()), ("posts", "id"));
    let columns: Vec<(&str, &str, bool)> =
        view.columns.iter().map(|c| (c.name.as_str(), c.source.as_str(), c.fillable)).collect();
    assert_eq!(columns, [("id", "migration", false), ("title", "migration", true)]);
    assert_eq!(view.scopes[0].name, "published");
    assert_eq!(view.related[0].kind, "migration");
    let err = php_laravel_model_view(&host, "main", "App\\Nope".into()).await.unwrap_err();
    assert!(err.message.contains("not an Eloquent model"), "{err:?}");

    let column = |name: &str| LaravelNewColumn { name: name.into(), ty: "string".into(), nullable: true };
    let edit = php_laravel_add_columns(
        &host,
        "main",
        "App\\Models\\Post".into(),
        vec![column("subtitle")],
        true,
        "2024_06_01_120000".into(),
    )
    .await
    .unwrap();
    let migration = root.join("database/migrations/2024_06_01_120000_add_subtitle_to_posts_table.php");
    assert!(
        edit.files.iter().any(|f| matches!(f, FileEdit::Create { path, .. } if path.clone() == migration)),
        "{edit:?}"
    );
    let fillable = edit.files.iter().find_map(|f| match f {
        FileEdit::Edit { path, edits, .. } if path.clone() == root.join("app/Models/Post.php") => {
            Some(edits[0].new_text.clone())
        }
        _ => None,
    });
    assert_eq!(fillable.as_deref(), Some(", 'subtitle'"));
    let err =
        php_laravel_add_columns(&host, "main", "App\\Models\\Post".into(), vec![column("title")], true, "x".into())
            .await
            .unwrap_err();
    assert!(err.message.contains("already"), "{err:?}");
    host.close_project("main");
}

/// The Laravel generators: the generation context lists the modules and models, and
/// the New Model command renders the model and its companions from the templates
/// (edited ones replacing the defaults), following the code generation settings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_generators_context_and_new_model() {
    use ide_core::FileEdit;
    use ide_host::ops::laravel::{
        LaravelNewClass, LaravelNewModel, LaravelNewModelField, LaravelTemplate, php_laravel_generate_class,
        php_laravel_generation_context, php_laravel_new_model,
    };
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(
        &root.join("composer.json"),
        r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/", "Database\\Factories\\": "database/factories/"}}}"#,
    );
    write(
        &root.join("vendor/laravel/framework/src/Model.php"),
        "<?php\nnamespace Illuminate\\Database\\Eloquent;\n\nabstract class Model\n{\n}\n",
    );
    write(
        &root.join("app/Models/User.php"),
        "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass User extends Model\n{\n}\n",
    );
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let context = php_laravel_generation_context(&host, "main").await.unwrap().expect("a Laravel project");
    assert_eq!(context.namespace, "App\\");
    assert_eq!(context.models, ["App\\Models\\User"]);
    assert_eq!(context.generators[0].id, "model");

    // Settings › PHP › Laravel › Code generation reach the engine.
    ops::project::set_settings(
        &host,
        "main",
        SettingsScope::Project,
        "languages.php.laravel.generation.controllerSuffix",
        "\"Endpoint\"",
    )
    .unwrap();
    until("the settings to reach the engine", || engine.laravel_settings().generation.controller_suffix == "Endpoint")
        .await;

    let spec = LaravelNewModel {
        name: "Product".into(),
        module: None,
        fields: vec![LaravelNewModelField {
            name: "price".into(),
            ty: "decimal".into(),
            nullable: false,
            unique: false,
            index: false,
            default: String::new(),
        }],
        relations: Vec::new(),
        indexes: Vec::new(),
        timestamps: true,
        soft_deletes: false,
        migration: true,
        factory: true,
        seeder: false,
        controller: "plain".into(),
        form_requests: false,
        resource: false,
        policy: false,
    };
    let templates = vec![LaravelTemplate { name: "Laravel Controller".into(), body: "<?php // $CLASS$\n".into() }];
    let edit = php_laravel_new_model(&host, "main", spec.clone(), templates, "2024_06_01_120000".into()).await.unwrap();
    let created: Vec<String> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            FileEdit::Create { path, .. } => {
                Some(path.to_string_lossy().replace('\\', "/").rsplit("shop/").next().unwrap().to_owned())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        created,
        [
            "app/Models/Product.php",
            "database/migrations/2024_06_01_120000_create_products_table.php",
            "database/factories/ProductFactory.php",
            "app/Http/Controllers/ProductEndpoint.php",
        ]
    );
    let controller = edit.files.iter().find_map(|f| match f {
        FileEdit::Edit { path, edits, .. } if path.to_string_lossy().ends_with("ProductEndpoint.php") => {
            Some(edits[0].new_text.clone())
        }
        _ => None,
    });
    assert_eq!(controller.as_deref(), Some("<?php // ProductEndpoint\n"));

    let err =
        php_laravel_new_model(&host, "main", LaravelNewModel { name: "User".into(), ..spec }, Vec::new(), "x".into())
            .await
            .unwrap_err();
    assert!(err.message.contains("exists already"), "{err:?}");

    // The other generators: a job with an edited template.
    let listed = context.generators.iter().find(|g| g.id == "job").expect("the job generator");
    assert_eq!(listed.options, ["queued"]);
    let job = LaravelNewClass {
        generator: "job".into(),
        name: "SendReceipt".into(),
        module: None,
        model: String::new(),
        related: String::new(),
        table: String::new(),
        create: false,
        event: String::new(),
        queued: true,
        api: false,
        backing: String::new(),
        status: 0,
        inputs: Vec::new(),
    };
    let templates = vec![LaravelTemplate { name: "Laravel Job".into(), body: "<?php // $CLASS$\n".into() }];
    let edit =
        php_laravel_generate_class(&host, "main", job.clone(), templates, "2024_06_01_120000".into()).await.unwrap();
    let texts: Vec<(String, String)> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            FileEdit::Edit { path, edits, .. } => Some((
                path.to_string_lossy().replace('\\', "/").rsplit("shop/").next().unwrap().to_owned(),
                edits[0].new_text.clone(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(texts, [("app/Jobs/SendReceipt.php".to_owned(), "<?php // SendReceipt\n".to_owned())]);
    let unknown = LaravelNewClass { generator: "nope".into(), ..job };
    let err = php_laravel_generate_class(&host, "main", unknown, Vec::new(), "x".into()).await.unwrap_err();
    assert!(err.message.contains("no generator"), "{err:?}");
    host.close_project("main");
}

/// The Artisan command table the "Run Artisan command…" dialog, the Artisan run
/// configuration and the run gutter read: a command class with its signature and
/// location, a closure command of `routes/console.php` and Laravel's own commands.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_artisan_commands() {
    use ide_host::ops::laravel::php_laravel_artisan_commands;
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("shop");
    write(
        &root.join("composer.json"),
        r#"{"require": {"laravel/framework": "^11.0"}, "autoload": {"psr-4": {"App\\": "app/"}}}"#,
    );
    write(
        &root.join("vendor/laravel/framework/src/Command.php"),
        "<?php\nnamespace Illuminate\\Console;\n\nclass Command\n{\n    protected $signature;\n    protected $description;\n}\n",
    );
    write(
        &root.join("app/Console/Commands/SendInvoices.php"),
        "<?php\nnamespace App\\Console\\Commands;\n\nuse Illuminate\\Console\\Command;\n\nclass SendInvoices extends Command\n{\n    protected $signature = 'invoices:send {month? : The month} {--Q|queue= : The queue}';\n    protected $description = 'Send the invoices';\n}\n",
    );
    write(
        &root.join("routes/console.php"),
        "<?php\n\nArtisan::command('greet {name}', function ($name) {})->purpose('Greet someone');\n",
    );
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(WAIT));

    let commands = php_laravel_artisan_commands(&host, "main").await.unwrap().expect("a Laravel project");
    let send = commands.iter().find(|command| command.name == "invoices:send").unwrap();
    assert_eq!(send.description, "Send the invoices");
    assert_eq!(send.source, "class");
    assert_eq!(send.class.as_deref(), Some("App\\Console\\Commands\\SendInvoices"));
    assert_eq!(send.synopsis, "invoices:send [--queue=QUEUE] [<month>]");
    assert_eq!(send.options[0].shortcut.as_deref(), Some("Q"));
    assert!(send.options[0].accepts_value);
    assert_eq!(send.location.as_ref().unwrap().range.start.line, 7);
    assert_eq!(send.class_line, Some(5));
    let greet = commands.iter().find(|command| command.name == "greet").unwrap();
    assert_eq!((greet.source.as_str(), greet.description.as_str()), ("closure", "Greet someone"));
    assert!(commands.iter().any(|command| command.name == "migrate" && command.source == "framework"));
}

/// Inspect Code over `fixtures/laravel-app` (with `fixtures/laravel-stubs` as
/// its `vendor/`): the Laravel inspections run over its PHP files and Blade
/// templates and find nothing but the deliberate problem; a new file's
/// undefined config key and unclosed section are found, and the inspection
/// profile turns the Laravel inspections off.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inspect_code_over_the_laravel_fixture_app() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("laravel-app");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    copy_dir(&fixtures.join("laravel-app"), &root);
    copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(Duration::from_secs(120)));
    assert!(engine.laravel().is_some(), "a Laravel project");
    let laravel = ["PhpUndefinedView", "PhpUndefinedConfigKey", "PhpUndefinedTranslation", "PhpUnknownAbility"];
    for id in laravel {
        assert!(engine.inspections().ids().contains(&id), "{id} runs");
    }
    let app = || ide_search::SearchScope::Project;
    let own = |files: &std::collections::BTreeMap<String, Vec<String>>| -> Vec<(String, Vec<String>)> {
        files
            .iter()
            .filter(|(path, codes)| !path.starts_with("vendor/") && !codes.is_empty())
            .map(|(path, codes)| (path.clone(), codes.clone()))
            .collect()
    };

    let (files, summary, _) = inspect_code(&host, app()).await;
    assert_eq!(
        own(&files),
        [("app/Http/Controllers/PostController.php".to_owned(), vec!["PhpUndefinedMethod".to_owned()])],
        "no false positives"
    );
    for inspected in ["routes/web.php", "config/blog.php", "resources/views/layouts/app.blade.php"] {
        assert!(files.contains_key(inspected), "{inspected} is inspected: {:?}", files.keys());
    }
    assert_eq!(summary.failed, 0);

    // Real problems are found, in PHP files and Blade templates.
    write(
        &root.join("app/Support/Probe.php"),
        "<?php\n\nnamespace App\\Support;\n\nfunction probe()\n{\n    return config('blog.nope');\n}\n",
    );
    write(
        &root.join("resources/views/probe.blade.php"),
        "@extends('layouts.app')\n@section('content')\n<p>{{ __('messages.nope') }}</p>\n",
    );
    let (files, _, _) = inspect_code(&host, app()).await;
    assert_eq!(files["app/Support/Probe.php"], ["PhpUndefinedConfigKey"], "{files:?}");
    assert_eq!(files["resources/views/probe.blade.php"], ["BladeUnclosedSection", "PhpUndefinedTranslation"]);

    // Turned off in the profile: the Laravel inspections stop, in templates too.
    ops::project::set_settings(
        &host,
        "main",
        SettingsScope::Global,
        "inspections.default",
        r#"{"lsp:php:PhpUndefinedConfigKey":{"enabled":false},"lsp:php:PhpUndefinedTranslation":{"enabled":false}}"#,
    )
    .unwrap();
    until("the inspections to be turned off", || !engine.inspections().ids().contains(&"PhpUndefinedTranslation"))
        .await;
    let (files, _, _) = inspect_code(&host, app()).await;
    assert_eq!(files["app/Support/Probe.php"], Vec::<String>::new());
    assert_eq!(files["resources/views/probe.blade.php"], ["BladeUnclosedSection"]);

    // Laravel support turned off in Settings › PHP › Laravel.
    ops::project::set_settings(
        &host,
        "main",
        SettingsScope::Project,
        "languages.php.laravel.detection",
        "\"disabled\"",
    )
    .unwrap();
    until("Laravel support to be turned off", || engine.laravel().is_none()).await;
    host.close_project("main");
}

/// `PhpUndefinedController` on the fixture app's route file: Alt+Enter on a
/// plain action naming no class lists "Create invokable controller", and
/// applying it creates the controller and rewrites the route, and returns
/// the new `__invoke`'s body for the editor to open.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn laravel_create_controller_quick_fix() {
    use ide_core::{Pos, Range};
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("laravel-app");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    copy_dir(&fixtures.join("laravel-app"), &root);
    copy_dir(&fixtures.join("laravel-stubs"), &root.join("vendor"));
    let web = root.join("routes/web.php");
    let mut text = std::fs::read_to_string(&web).unwrap().replace("\r\n", "\n");
    text.push_str("\nRoute::get('123', 'dream')->name('dream.come.true');\n");
    write(&web, &text);
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let host = host(&base.join("app"), events.clone());
    let project = host.open_project("main", &root).unwrap();
    set_engine(&host, "native");
    until("the engine to start", || project.php.engine().is_some()).await;
    let engine = project.php.engine().unwrap();
    assert!(engine.wait_idle(Duration::from_secs(120)));
    assert!(engine.inspections().ids().contains(&"PhpUndefinedController"));

    let doc = ops::doc::open(&host, "main", web.clone()).await.unwrap();
    let line = text.lines().position(|line| line.contains("'dream'")).unwrap() as u32;
    let pos = Pos::new(line, 21);
    let actions =
        ops::lsp::lsp_code_actions(&host, "main", doc.id, Range::new(pos, pos), vec!["quickfix".into()]).await.unwrap();
    let titles: Vec<&str> = actions.iter().map(|action| action.title.as_str()).collect();
    let create = actions
        .iter()
        .find(|action| action.title == "Create invokable controller 'DreamController'")
        .unwrap_or_else(|| panic!("{titles:?}"));
    assert!(create.edit.is_some(), "an edit");
    let controller = root.join("app/Http/Controllers/DreamController.php");
    let applied =
        ops::lsp::lsp_execute_code_action(&host, "main", ide_core::RequestId(9), doc.id, create.clone(), vec![])
            .await
            .unwrap();
    assert!(applied.created.is_empty(), "{applied:?}");
    let open = applied.open.expect("the location to open");
    assert_eq!(PathBuf::from(open.path), controller);
    let created = std::fs::read_to_string(&controller).unwrap();
    assert!(created.contains("class DreamController extends Controller"), "{created}");
    assert!(created.contains("public function __invoke(Request $request)"), "{created}");
    let lines: Vec<&str> = created.lines().collect();
    let at = open.range.start;
    assert_eq!(lines[at.line as usize - 2].trim(), "public function __invoke(Request $request)", "{created}");
    assert_eq!(&lines[at.line as usize][at.col as usize..open.range.end.col as usize], "//", "{created}");
    let routes = project.documents.snapshot(doc.id).unwrap().text;
    assert!(routes.contains("Route::get('123', DreamController::class)"), "{routes}");
    host.close_project("main");
}
