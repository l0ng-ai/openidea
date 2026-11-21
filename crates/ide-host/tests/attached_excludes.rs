//! Each project of a workspace keeps its own excluded folders: they apply below that project only.
use ide_core::{NullSink, RequestId};
use ide_host::{Host, HostConfig, ops};
use ide_workspace::settings::SettingsScope;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

/// Files containing `needle` that Find in Files reports, by path.
async fn found(host: &Host) -> Vec<PathBuf> {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({"pattern": "needle", "isRegex": false, "caseSensitive": false, "wholeWord": false, "include": [], "exclude": [], "scope": {"kind": "project"}, "maxMatches": 100})).unwrap();
    let channel = ops::Channel::new(move |event| {
        if let ops::search::SearchEvent::File { file } = event {
            out.lock().unwrap().push(file.path.0);
        }
    });
    ops::search::search_start(host, "main", RequestId::next(), query, channel).await.unwrap();
    let mut paths = std::mem::take(&mut *hits.lock().unwrap());
    paths.sort();
    paths
}

/// The folders of `dir` the Project view shows as excluded.
async fn excluded(host: &Host, dir: &Path) -> Vec<String> {
    let entries = ops::fs::fs_read_dir(host, "main", dir.to_path_buf()).await.unwrap();
    entries.into_iter().filter(|e| e.excluded).map(|e| e.name).collect()
}

fn indexed(host: &Host, name: &str) -> Vec<PathBuf> {
    let project = host.project("main").unwrap();
    assert!(project.index.wait_idle(Duration::from_secs(20)));
    project.index.files_named(name)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attached_projects_keep_their_own_excluded_folders() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (app, lib) = (base.join("app"), base.join("lib"));
    // Both projects have a `gen` and a `dist` folder.
    for root in [&app, &lib] {
        for dir in ["gen", "dist", "src"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join(format!("{dir}.txt")), "needle\n").unwrap();
        }
    }
    let config = base.join("config");
    // `lib` excluded its `dist` when it was opened on its own.
    ide_workspace::SettingsStore::load(&config, Some(&lib))
        .set(SettingsScope::Project, "projectStructure.excluded", serde_json::json!(["dist"]))
        .unwrap();
    ide_workspace::workspace::Workspace::attach(&app, "app", vec![app.clone(), lib.clone()]).unwrap();

    let host = host(&base);
    host.trust.decide(&app, true, false).unwrap();
    host.trust.decide(&lib, true, false).unwrap();
    host.open_project("main", &app).unwrap();
    ops::project::set_settings(&host, "main", SettingsScope::Project, "projectStructure.excluded", r#"["gen"]"#)
        .unwrap();
    host.project("main").unwrap().refresh_index_scope();

    let expect = |paths: &[&str]| paths.iter().map(|p| base.join(p)).collect::<Vec<_>>();
    // `app` excludes its `gen`, `lib` its `dist`: neither reaches into the other project.
    assert_eq!(
        found(&host).await,
        expect(&["app/dist/dist.txt", "app/src/src.txt", "lib/gen/gen.txt", "lib/src/src.txt"])
    );
    assert_eq!(excluded(&host, &app).await, ["gen"]);
    assert_eq!(excluded(&host, &lib).await, ["dist"]);
    assert_eq!(indexed(&host, "gen.txt"), expect(&["lib/gen/gen.txt"]));
    assert_eq!(indexed(&host, "dist.txt"), expect(&["app/dist/dist.txt"]));

    // `lib` changes its exclusions in its own window: the workspace follows.
    host.open_project("lib", &lib).unwrap();
    ops::project::set_settings(&host, "lib", SettingsScope::Project, "projectStructure.excluded", "[]").unwrap();
    let project = host.project("main").unwrap();
    for _ in 0..100 {
        if project.exclude_globs_in(&lib).iter().all(|g| g != "/dist") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(excluded(&host, &lib).await.is_empty());
    assert_eq!(indexed(&host, "dist.txt"), expect(&["app/dist/dist.txt", "lib/dist/dist.txt"]));
    ops::project::set_settings(&host, "lib", SettingsScope::Project, "projectStructure.excluded", r#"["dist"]"#)
        .unwrap();
    host.shutdown().await;

    // Reopened: each project's exclusions come back from its own settings.
    let host = self::host(&base);
    host.open_project("main", &app).unwrap();
    assert_eq!(
        found(&host).await,
        expect(&["app/dist/dist.txt", "app/src/src.txt", "lib/gen/gen.txt", "lib/src/src.txt"])
    );
    assert_eq!(indexed(&host, "dist.txt"), expect(&["app/dist/dist.txt"]));
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mark_directory_as_excluded_writes_the_attached_projects_settings() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (app, lib, other) = (base.join("app"), base.join("lib"), base.join("other"));
    for dir in [app.join("gen"), lib.join("gen"), other.clone()] {
        std::fs::create_dir_all(dir).unwrap();
    }
    ide_workspace::workspace::Workspace::attach(&app, "app", vec![app.clone(), lib.clone()]).unwrap();
    let host = Arc::new(host(&base));
    host.trust.decide(&app, true, false).unwrap();
    host.open_project("main", &app).unwrap();

    let members = ops::project::project_workspace_members(&host, "main").unwrap();
    assert_eq!(members.iter().map(|m| &m.root.0).collect::<Vec<_>>(), [&lib]);
    assert!(members[0].structure.excluded.is_empty());

    let set = |root: &Path, key: &str, value: &str| {
        ops::project::project_workspace_member_set(&host, "main", root.to_path_buf(), key.into(), value.into())
    };
    set(&lib, "projectStructure.excluded", r#"["gen"]"#).unwrap();
    // Only Project Structure keys of the workspace's attached projects.
    assert!(set(&other, "projectStructure.excluded", r#"["gen"]"#).is_err());
    assert!(set(&lib, "editor.fontSize", "20").is_err());

    let saved = ide_workspace::SettingsStore::load(&base.join("config"), Some(&lib));
    assert_eq!(saved.effective().project_structure.excluded, ["gen"]);
    let project = host.project("main").unwrap();
    for _ in 0..100 {
        if project.exclude_globs_in(&lib).contains(&"/gen".to_owned()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(excluded(&host, &lib).await, ["gen"]);
    assert!(excluded(&host, &app).await.is_empty(), "the open project keeps its own");
    assert!(
        ide_workspace::SettingsStore::load(&base.join("config"), Some(&app))
            .effective()
            .project_structure
            .excluded
            .is_empty()
    );
    host.shutdown().await;
}
