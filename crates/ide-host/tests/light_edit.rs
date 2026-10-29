//! LightEdit: a window editing loose files without a project.

use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::Duration;

fn host(base: &std::path::Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_loose_files_without_project_services() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_root = dunce::canonicalize(tmp.path()).unwrap();
    let (a_dir, b_dir) = (tmp_root.join("a"), tmp_root.join("b"));
    std::fs::create_dir_all(a_dir.join(".git")).unwrap();
    std::fs::create_dir_all(&b_dir).unwrap();
    std::fs::write(a_dir.join("one.py"), "print(1)\n").unwrap();
    std::fs::write(b_dir.join("two.rs"), "fn main() {}\n").unwrap();
    let host = host(&tmp_root.join("app"));

    let light = host.open_light("main", &a_dir.join("one.py")).unwrap();
    assert!(light.light);
    assert_eq!(light.root, a_dir);
    assert!(host.open_light("main", &b_dir).is_err(), "a folder is not opened for LightEdit");

    let doc = ops::doc::open(&host, "main", a_dir.join("one.py")).await.unwrap();
    assert!(doc.text.starts_with("print"));
    let changes = ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "#\n".into() }] };
    let version = ops::doc::edit(&host, "main", doc.id, doc.version, changes).unwrap();
    assert!(version > doc.version);
    ops::doc::save(&host, "main", doc.id).await.unwrap();
    assert_eq!(std::fs::read_to_string(a_dir.join("one.py")).unwrap(), "#\nprint(1)\n");

    // More files join the same session, wherever they are.
    let again = host.open_light("main", &b_dir.join("two.rs")).unwrap();
    assert!(Arc::ptr_eq(&light, &again));
    ops::doc::open(&host, "main", b_dir.join("two.rs")).await.unwrap();

    assert!(light.index.wait_idle(Duration::from_secs(10)));
    assert_eq!(light.index.status().files, 0, "nothing is indexed");
    assert!(light.lsp.servers().is_empty(), "no language servers");
    assert!(light.repos().is_empty(), "no repositories");

    // Opening the folder as a project replaces the LightEdit session.
    let project = host.open_project("main", &a_dir).unwrap();
    assert!(!project.light);
    assert!(!Arc::ptr_eq(&project, &light));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn light_windows_ignore_project_scoped_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = dunce::canonicalize(tmp.path()).unwrap().join("loose");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("notes.txt"), "x\n").unwrap();
    let host = host(&tmp.path().join("app"));
    host.open_light("main", &dir.join("notes.txt")).unwrap();
    let applied = ops::project::set_settings(
        &host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "general.projectName",
        "\"loose\"",
    )
    .unwrap();
    assert!(!applied.project_scope);
    assert!(!dir.join(".openidea").exists(), "no project settings next to the file");
}
