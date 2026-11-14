use super::*;
use ide_core::LanguageId;
use ide_workspace::{Documents, SettingsScope};
use serde_json::json;

type Events = Arc<Mutex<Vec<IdeEvent>>>;

/// A stand-in for the PHP interpreter: prints `report.json` from its own folder,
/// or sleeps when `slow`.
fn fake_interpreter(dir: &Path, slow: bool) -> PathBuf {
    if cfg!(windows) {
        let path = dir.join(if slow { "slow.cmd" } else { "fake.cmd" });
        let body = if slow { "@ping -n 30 127.0.0.1 >nul\r\n" } else { "@type \"%~dp0report.json\"\r\n" };
        std::fs::write(&path, body).unwrap();
        path
    } else {
        let path = dir.join(if slow { "slow.sh" } else { "fake.sh" });
        let body = if slow { "#!/bin/sh\nsleep 30\n" } else { "#!/bin/sh\ncat \"$(dirname \"$0\")/report.json\"\n" };
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
    settings: Arc<SettingsStore>,
    trusted: Arc<AtomicBool>,
    events: Events,
    analyzers: Arc<PhpAnalyzers>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(dir.path()).unwrap();
    let root = base.join("app");
    let tools = base.join("tools");
    std::fs::create_dir_all(root.join("vendor/bin")).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(&tools).unwrap();
    std::fs::write(root.join("vendor/bin/phpstan"), "#!/usr/bin/env php\n<?php\n").unwrap();
    let file = root.join("src/A.php");
    std::fs::write(&file, "<?php\n\n$a = $missing;\n").unwrap();
    let path = serde_json::to_string(&file.to_string_lossy()).unwrap();
    let report = format!(
        r#"{{"totals":{{"errors":0,"file_errors":2}},"files":{{{path}:{{"errors":2,"messages":[{{"message":"Undefined variable: $missing","line":3,"identifier":"variable.undefined"}},{{"message":"Something else.","line":1}}]}}}},"errors":[]}}"#
    );
    std::fs::write(tools.join("report.json"), report).unwrap();
    let interpreter = fake_interpreter(&tools, false);

    let settings = Arc::new(SettingsStore::load(&base.join("config"), Some(&root)));
    settings.set(SettingsScope::Project, "languages.php.analyzersOnSave", json!(true)).unwrap();
    settings.set(SettingsScope::Project, "languages.php.interpreter", json!(interpreter.to_string_lossy())).unwrap();
    let events: Events = Arc::default();
    let sink: SharedSink = {
        let events = events.clone();
        Arc::new(move |event: IdeEvent| events.lock().push(event))
    };
    let documents = Arc::new(Documents::new(sink.clone(), Box::new(|_, _| LanguageId::new("php"))));
    let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink.clone(), documents));
    let trusted = Arc::new(AtomicBool::new(true));
    let analyzers = PhpAnalyzers::new(&root, settings.clone(), sink, trusted.clone(), php);
    Fixture { _dir: dir, root, file, settings, trusted, events, analyzers }
}

/// The diagnostics events published for `source`, waiting up to 20 s for `count` of them.
fn published(events: &Events, source: &str, count: usize) -> Vec<Vec<Diagnostic>> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let found: Vec<Vec<Diagnostic>> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Diagnostics { source: s, items, .. } if s == source => Some(items.clone()),
                _ => None,
            })
            .collect();
        if found.len() >= count || Instant::now() > deadline {
            return found;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn idle(analyzers: &PhpAnalyzers) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !analyzers.state.lock().running.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_save_publishes_the_report_under_the_tools_source() {
    let f = fixture();
    f.analyzers.saved_file(&f.file, "<?php\n\n$a = $missing;\n");
    let found = published(&f.events, "phpstan", 1);
    assert_eq!(found.len(), 1, "{:?}", f.events.lock());
    let items = &found[0];
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].message, "Something else.");
    assert_eq!(items[1].message, "Undefined variable: $missing");
    assert_eq!(items[1].range.start, ide_core::Pos { line: 2, col: 0 });
    assert_eq!(items[1].source.as_deref(), Some("phpstan"));
    idle(&f.analyzers);

    // Closing the file clears it.
    f.analyzers.closed(ide_core::DocId(1), &f.file);
    let found = published(&f.events, "phpstan", 2);
    assert_eq!(found.len(), 2);
    assert!(found[1].is_empty());
}

#[test]
fn turning_the_setting_off_clears_and_stops_running() {
    let f = fixture();
    f.analyzers.saved_file(&f.file, "<?php\n");
    assert_eq!(published(&f.events, "phpstan", 1).len(), 1);
    idle(&f.analyzers);
    let settings = f.settings.set(SettingsScope::Project, "languages.php.analyzersOnSave", json!(false)).unwrap();
    f.analyzers.apply(&settings);
    let found = published(&f.events, "phpstan", 2);
    assert!(found[1].is_empty());
    // Saving now runs nothing.
    f.analyzers.saved_file(&f.file, "<?php\n");
    assert!(f.analyzers.state.lock().running.is_empty());
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(published(&f.events, "phpstan", 0).len(), 2);
}

#[test]
fn untrusted_projects_vendor_files_and_views_are_not_analysed() {
    let f = fixture();
    f.trusted.store(false, Ordering::Release);
    f.analyzers.saved_file(&f.file, "<?php\n");
    f.trusted.store(true, Ordering::Release);
    f.analyzers.saved_file(&f.root.join("vendor/x/B.php"), "<?php\n");
    f.analyzers.saved_file(&f.root.join("resources/views/a.blade.php"), "<p></p>\n");
    f.analyzers.saved_file(&f.root.join("README.md"), "# x\n");
    assert!(f.analyzers.state.lock().running.is_empty());
    std::thread::sleep(Duration::from_millis(200));
    assert!(published(&f.events, "phpstan", 0).is_empty());
}

#[test]
fn a_stopped_project_runs_nothing() {
    let f = fixture();
    f.analyzers.stop();
    f.analyzers.saved_file(&f.file, "<?php\n");
    assert!(f.analyzers.state.lock().running.is_empty());
}

#[test]
fn a_cancelled_run_is_killed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let slow = fake_interpreter(&root, true);
    let token = CancellationToken::new();
    let cancel = token.clone();
    let started = Instant::now();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        cancel.cancel();
    });
    let result = execute(&slow, Analyzer::PhpStan, &root, &root.join("A.php"), &token, TIMEOUT);
    canceller.join().unwrap();
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(started.elapsed() < Duration::from_secs(15));

    let result = execute(
        &slow,
        Analyzer::PhpStan,
        &root,
        &root.join("A.php"),
        &CancellationToken::new(),
        Duration::from_millis(200),
    );
    assert!(result.unwrap_err().contains("timed out"));
}

#[test]
fn a_missing_interpreter_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-php");
    let result =
        execute(&missing, Analyzer::Psalm, dir.path(), &dir.path().join("A.php"), &CancellationToken::new(), TIMEOUT);
    assert!(result.unwrap_err().starts_with("cannot start"));
}
