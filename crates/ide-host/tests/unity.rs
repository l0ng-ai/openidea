use ide_core::{NullSink, RequestId};
use ide_host::{Host, HostConfig, ops};
use std::{sync::Arc, time::Duration};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opens_unity_without_generated_solutions_and_excludes_caches_from_the_index() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("Game");
    for name in ["Assets/Scripts", "Packages", "ProjectSettings", "Library/PackageCache", "Temp", "Logs"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    std::fs::write(root.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.0.62f1\n").unwrap();
    std::fs::write(root.join("Assets/Scripts/Player.cs"), "class Player {}\n").unwrap();
    std::fs::write(root.join("Packages/manifest.json"), "{}\n").unwrap();
    std::fs::write(root.join("Library/PackageCache/Cached.cs"), "class Cached {}\n").unwrap();
    std::fs::write(root.join("Temp/Temporary.cs"), "class Temporary {}\n").unwrap();
    std::fs::write(root.join("Logs/Editor.log"), "log\n").unwrap();
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_project("main", &root).unwrap();
    let info = ops::project::info(&project);
    assert_eq!(info.name, "Game");
    let unity = info.unity.unwrap();
    assert_eq!(unity.editor_version.as_deref(), Some("6000.0.62f1"));
    assert!(unity.projects.is_empty() && unity.solutions.is_empty());
    assert!(project.index.wait_idle(Duration::from_secs(20)));
    assert_eq!(project.index.find_files("Player.cs", 100).len(), 1);
    let listed = project.index.files_matching(&project.root, |rel| rel.ends_with("Player.cs"), 10).unwrap();
    assert_eq!(listed.len(), 1);
    for name in ["Cached.cs", "Temporary.cs", "Editor.log"] {
        assert!(project.index.find_files(name, 100).is_empty(), "indexed generated file {name}");
    }
    let hits = Arc::new(std::sync::Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({
        "pattern": "class", "isRegex": false, "caseSensitive": false, "wholeWord": false,
        "include": [], "exclude": [], "scope": { "kind": "project" }, "maxMatches": 100,
    }))
    .unwrap();
    ops::search::start(
        &host,
        "main",
        RequestId::next(),
        query,
        Arc::new(move |event| {
            if let ops::search::SearchEvent::File { file } = event {
                out.lock().unwrap().push(file.rel_path);
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(*hits.lock().unwrap(), ["Assets/Scripts/Player.cs"]);
    let listing = ops::fs::read_dir(&host, "main", root.clone()).await.unwrap();
    assert!(listing.iter().any(|e| e.name == "Library" && e.excluded));
    assert!(project.exclude_globs().contains(&"/Obj".to_owned()));

    // Project metadata refreshes without reopening when Unity generates its solution.
    std::fs::write(root.join("Game.sln"), "").unwrap();
    std::fs::write(root.join("Assembly-CSharp.csproj"), "").unwrap();
    let unity = ops::project::info(&project).unity.unwrap();
    assert_eq!(unity.solutions, ["Game.sln"]);
    assert_eq!(unity.projects, ["Assembly-CSharp.csproj"]);

    // Desktop commands and remote RPC share these host operations.
    let original = root.join("Assets/Scripts/Player.cs");
    let renamed = root.join("Assets/Scripts/Hero.cs");
    let copied = root.join("Assets/Scripts/HeroCopy.cs");
    let meta = |path: &std::path::Path| -> std::path::PathBuf {
        let mut name = path.as_os_str().to_os_string();
        name.push(".meta");
        name.into()
    };
    let original_metadata = "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n";
    std::fs::write(meta(&original), original_metadata).unwrap();
    ops::fs::rename(&host, "main", original.clone(), renamed.clone()).await.unwrap();
    assert!(!original.exists() && !meta(&original).exists());
    assert_eq!(std::fs::read_to_string(meta(&renamed)).unwrap(), original_metadata);
    ops::fs::copy(&host, "main", renamed.clone(), copied.clone()).await.unwrap();
    assert!(copied.exists());
    assert_ne!(std::fs::read_to_string(meta(&copied)).unwrap(), original_metadata);
    assert_eq!(std::fs::read_to_string(meta(&renamed)).unwrap(), original_metadata);
    host.close_project("main");

    let ordinary = base.join("ConsoleApp");
    std::fs::create_dir(&ordinary).unwrap();
    std::fs::write(ordinary.join("App.csproj"), "").unwrap();
    let project = host.open_project("main", &ordinary).unwrap();
    assert!(ops::project::info(&project).unity.is_none());
    assert!(!project.exclude_globs().contains(&"/Library".to_owned()));
    host.close_project("main");
}
