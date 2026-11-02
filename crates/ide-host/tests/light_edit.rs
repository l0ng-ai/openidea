//! LightEdit: a window editing loose files without a project.

use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::Duration;

fn host(base: &std::path::Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn light_windows_stay_restricted_when_folder_trust_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("loose");
    let other = tmp.path().join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(root.join("one.py"), "print(1)\n").unwrap();
    std::fs::write(other.join("two.js"), "const value = 1;\n").unwrap();
    let host = host(&tmp.path().join("app"));
    host.global_settings
        .set(ide_workspace::SettingsScope::Global, "languages.prettier.prefer", serde_json::json!(true))
        .unwrap();
    let light = host.open_light("main", &root.join("one.py")).unwrap();
    assert!(!light.is_trusted());
    assert!(light.require_trust().is_err());

    host.set_project_trust(&root, true, false).await.unwrap();
    assert!(!light.is_trusted());
    let trusted_folder = host.open_light("second", &root.join("one.py")).unwrap();
    assert!(!trusted_folder.is_trusted());
    let again = host.open_light("main", &other.join("two.js")).unwrap();
    assert!(Arc::ptr_eq(&light, &again));
    assert!(!again.is_trusted());
    host.set_project_trust(&root, true, true).await.unwrap();
    assert!(!light.is_trusted());
    assert!(!trusted_folder.is_trusted());
    for command in ["sdk_detect", "sdk_locate_tools", "notebook_execute", "notebook_restart", "run_start"] {
        assert!(host.authorize_command("main", command).is_err(), "{command}");
    }

    let doc = ops::doc::open(&host, "main", other.join("two.js")).await.unwrap();
    let error = ops::lsp::lsp_format(
        &host,
        "main",
        doc.id,
        None,
        ide_lsp::types::FormatOptions { tab_size: 2, insert_spaces: true, on_save: false },
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::Unavailable);
    assert!(error.message.contains("Restricted Mode"));

    host.set_project_trust(&root, false, false).await.unwrap();
    assert!(!light.is_trusted());
    assert!(!trusted_folder.is_trusted());
    host.set_project_trust(&root, true, false).await.unwrap();
    let project = host.open_project("main", &root).unwrap();
    assert!(!project.light);
    assert!(project.is_trusted());
    assert!(project.require_trust().is_ok());
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn light_notebooks_open_without_interpreter_detection_or_execution() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("loose");
    let bin = root.join(".venv").join(if cfg!(windows) { "Scripts" } else { "bin" });
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(root.join(".venv/pyvenv.cfg"), "home = python\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let python = bin.join("python");
        std::fs::write(&python, "#!/bin/sh\nprintf probed > \"$0.probed\"\nprintf 'Python 3.12.0\\n'\n").unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let file = root.join("analysis.ipynb");
    std::fs::write(
        &file,
        r#"{"cells":[{"id":"cell","cell_type":"code","source":["print(1)"],"metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#,
    )
    .unwrap();
    let host = host(&tmp.path().join("app"));
    host.open_light("main", &file).unwrap();
    let notebook = ops::notebook::open(&host, "main", file.to_string_lossy().into()).await.unwrap();
    assert!(ops::notebook::save(&host, "main", notebook.id.clone()).await.is_ok());
    let error = ops::sdk::sdk_detect(&host, "main", ide_sdk::SdkKind::Python).await.unwrap_err();
    assert!(error.message.contains("Restricted Mode"));
    assert!(ops::sdk::sdk_python_effective(&host, "main").is_err());
    assert!(ops::sdk::sdk_locate_tools(&host, "main", vec!["prettier".into()], Some(root)).await.is_err());
    let error = ops::notebook::restart(&host, "main", notebook.id.clone()).await.unwrap_err();
    assert!(error.message.contains("Restricted Mode"));
    let error = ops::notebook::execute(
        &host,
        "main",
        notebook.id,
        vec![notebook.cells[0].id.clone()],
        None,
        ide_core::RequestId(849),
        ops::Channel::new(|_| {}),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("Restricted Mode"));
    assert!(!bin.join("python.probed").exists());
    host.shutdown().await;
}
