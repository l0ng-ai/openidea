use ide_core::{ChangeSet, NullSink, RequestId, TextChange};
use ide_host::{Host, HostConfig, ops};
use ide_workspace::workspace::Workspace;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linked_projects_share_navigation_but_keep_files_repositories_and_run_directories() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let roots = vec![base.join("frontend"), base.join("backend")];
    for (index, root) in roots.iter().enumerate() {
        std::fs::create_dir(root).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(root).status().unwrap().success());
        std::fs::write(root.join("same.txt"), format!("shared needle {index}\n")).unwrap();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"echo test"}}"#).unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "Full stack", vec![roots[0].clone()], true).unwrap();
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
    std::fs::write(root.join("internal-needle.txt"), "needle").unwrap();
    host.trust.decide(&root, true, false).unwrap();
    for member in &roots {
        host.trust.decide(member, true, false).unwrap();
    }
    let project = host.open_project("main", &root).unwrap();
    assert_eq!(ops::project::info(&project).name, "Full stack");
    assert_eq!(ops::project::attach_workspace(&host, "main", &roots[1]).unwrap().as_ref(), root.as_path());
    ops::project::attach_workspace(&host, "main", &roots[1]).unwrap();
    assert_eq!(project.content_roots(), roots);
    assert!(!root.join(".openidea/.gitignore").exists());
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    assert!(project.index.find_files("internal-needle", 100).is_empty());
    assert!(project.index.find_files("workspace.json", 100).is_empty());
    assert_eq!(project.index.find_files("same.txt", 100).len(), 2);
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    let configs = ops::run::configs(&host, "main").unwrap();
    for member in &roots {
        assert!(configs.iter().any(|c| c.cwd.as_ref().is_some_and(|cwd| &**cwd == member)));
    }
    let mut ids = configs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), configs.len());
    let a = ops::doc::open(&host, "main", roots[0].join("same.txt")).await.unwrap();
    let b = ops::doc::open(&host, "main", roots[1].join("same.txt")).await.unwrap();
    assert_ne!(a.id, b.id);
    ops::doc::edit(
        &host,
        "main",
        a.id,
        a.version,
        ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved ".into() }] },
    )
    .unwrap();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({"pattern":"needle", "isRegex":false, "caseSensitive":false,"wholeWord":false,"include":[],"exclude":[],"scope":{"kind":"project"},"maxMatches":100})).unwrap();
    ops::search::start(
        &host,
        "main",
        RequestId::next(),
        query,
        Arc::new(move |event| {
            if let ops::search::SearchEvent::File { file } = event {
                out.lock().unwrap().push(file);
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(hits.lock().unwrap().len(), 2);
    let found = hits.lock().unwrap().iter().map(|f| f.rel_path.clone()).collect::<Vec<_>>();
    assert!(found.contains(&"frontend/same.txt".to_owned()));
    assert!(found.contains(&"backend/same.txt".to_owned()));
    let updated = ops::project::save_workspace(&host, "main", "Frontend", vec![roots[0].clone()]).unwrap();
    assert_eq!(updated.workspace.unwrap().projects, vec![roots[0].clone()]);
    assert_eq!(project.content_roots(), vec![roots[0].clone()]);
    assert!(project.documents.text_of(&roots[0].join("same.txt")).unwrap().starts_with("unsaved"));
    assert!(roots[1].join("same.txt").exists());
    assert!(!roots[1].join(".openidea").exists());
    let invalid = base.join("invalid");
    std::fs::create_dir_all(invalid.join(".openidea")).unwrap();
    std::fs::write(invalid.join(ide_workspace::workspace::FILE), "broken").unwrap();
    assert!(host.open_project("main", &invalid).is_err());
    assert!(Arc::ptr_eq(&host.project("main").unwrap(), &project));
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn python_effective_interpreter_falls_back_to_the_primary_project() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let primary = base.join("primary");
    let venv_python =
        if cfg!(windows) { primary.join(".venv/Scripts/python.exe") } else { primary.join(".venv/bin/python") };
    std::fs::create_dir_all(venv_python.parent().unwrap()).unwrap();
    std::fs::write(primary.join(".venv/pyvenv.cfg"), "home = /usr/bin\n").unwrap();
    std::fs::write(&venv_python, "").unwrap();
    let member = base.join("attached");
    std::fs::create_dir_all(member.join("src")).unwrap();
    // The primary project with an attached folder (the "attach" flow, not a container workspace).
    Workspace::attach(&primary, "Primary", vec![primary.clone(), member.clone()]).unwrap();
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
    host.trust.decide(&primary, true, false).unwrap();
    host.trust.decide(&member, true, false).unwrap();
    host.open_project("main", &primary).unwrap();
    let python = |near: Option<&std::path::Path>| {
        ops::sdk::sdk_python_effective(&host, "main", near.map(|p| p.to_path_buf())).unwrap().map(|p| p.into_path_buf())
    };
    // The primary project's own virtualenv, and the bare member inheriting it.
    assert_eq!(python(Some(&primary)), Some(venv_python.clone()));
    assert_eq!(python(Some(&member.join("src"))), Some(venv_python.clone()));
    // The member's own settings win: an explicit interpreter configured for it
    // (its file is created here — a missing one would be skipped as invalid).
    let configured = member.join("selected").join(if cfg!(windows) { "python.exe" } else { "python" });
    std::fs::create_dir_all(configured.parent().unwrap()).unwrap();
    std::fs::write(&configured, "").unwrap();
    ide_workspace::SettingsStore::load(&base.join("config"), Some(&member))
        .set(
            ide_workspace::SettingsScope::Project,
            "languages.python.interpreter",
            serde_json::to_value(configured.to_string_lossy().into_owned()).unwrap(),
        )
        .unwrap();
    assert_eq!(python(Some(&member.join("src"))), Some(configured));
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn php_language_level_follows_the_member_of_the_file() {
    use ide_sdk::php::{PhpLanguageLevel, PhpLevelSource};
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (api, legacy) = (base.join("api"), base.join("legacy"));
    for (member, composer) in [
        (&api, r#"{"require": {"php": "^7.4"}}"#),
        (&legacy, r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "8.0.5"}}}"#),
    ] {
        std::fs::create_dir(member).unwrap();
        std::fs::write(member.join("composer.json"), composer).unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "PHP", vec![api.clone(), legacy.clone()], true).unwrap();
    std::fs::write(root.join("composer.json"), r#"{"require": {"php": "^8.2"}}"#).unwrap();
    let config_dir = base.join("config");
    ide_workspace::SettingsStore::load(&config_dir, Some(&legacy))
        .set(ide_workspace::SettingsScope::Project, "languages.php.languageLevel", "8.3".into())
        .unwrap();
    let host = Host::new(HostConfig {
        config_dir,
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let found = |version: &str, source| Some(PhpLanguageLevel { version: version.into(), source });
    let level = async |path: std::path::PathBuf| ops::sdk::sdk_php_language_level(&host, "main", path).await.unwrap();

    let level_of_api = level(api.join("src/Invoice.php")).await;
    assert_eq!(level_of_api.effective, found("7.4.0", PhpLevelSource::Require));
    assert_eq!(level_of_api.auto, level_of_api.effective);
    assert_eq!(level_of_api.member.as_deref(), Some(api.as_path()));
    // The member's own settings, not the workspace's.
    let level_of_legacy = level(legacy.join("index.php")).await;
    assert_eq!(level_of_legacy.effective, found("8.3.0", PhpLevelSource::Settings));
    assert_eq!(level_of_legacy.auto, found("8.0.5", PhpLevelSource::Platform));
    // Outside every member: the workspace's own.
    let level_elsewhere = level(base.join("elsewhere.php")).await;
    assert_eq!(level_elsewhere.effective, found("8.2.0", PhpLevelSource::Require));
    assert_eq!(level_elsewhere.member, None);
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn build_tool_availability_follows_workspace_members_and_trust() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let members: Vec<_> = ["first", "second"].into_iter().map(|name| base.join(name)).collect();
    for member in &members {
        std::fs::create_dir(member).unwrap();
        std::fs::write(member.join("pom.xml"), "<project><artifactId>app</artifactId></project>").unwrap();
        std::fs::write(member.join("build.gradle"), "").unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "Build tools", members.clone(), true).unwrap();
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
    for member in &members {
        host.trust.decide(member, true, false).unwrap();
    }
    host.open_project("main", &root).unwrap();
    assert!(ops::build::build_model(&host, "main").await.is_err());
    host.close_project("main");
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let model = ops::build::build_model(&host, "main").await.unwrap();
    assert_eq!(model.maven.unwrap().projects.len(), 2);
    assert_eq!(model.gradle.len(), 2);
    ops::project::save_workspace(&host, "main", "One member", vec![members[1].clone()]).unwrap();
    let model = ops::build::build_model(&host, "main").await.unwrap();
    assert_eq!(model.maven.unwrap().projects[0].dir, ide_core::ipc_path::to_ipc(&members[1]));
    assert_eq!(model.gradle.len(), 1);
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_and_detach_preserve_the_primary_project_session() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let roots = vec![base.join("primary"), base.join("other")];
    for root in &roots {
        std::fs::create_dir(root).unwrap();
        std::fs::write(root.join("same.txt"), "needle").unwrap();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"echo test"}}"#).unwrap();
    }
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
    host.trust.decide(&roots[0], true, false).unwrap();
    let project = host.open_project("main", &roots[0]).unwrap();
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    let configs = ops::run::configs(&host, "main").unwrap();
    assert!(!configs.is_empty());
    let cache = project.build_cache_dir();
    let doc = ops::doc::open(&host, "main", roots[0].join("same.txt")).await.unwrap();
    ops::doc::edit(
        &host,
        "main",
        doc.id,
        doc.version,
        ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved ".into() }] },
    )
    .unwrap();
    assert!(ops::project::attach_workspace(&host, "main", &roots[1]).is_err());
    host.trust.decide(&roots[1], false, false).unwrap();
    assert!(ops::project::attach_workspace(&host, "main", &roots[1]).is_err());
    assert!(!roots[0].join(ide_workspace::workspace::FILE).exists());
    let existing_index = &project.index as *const _;
    host.trust.decide(&roots[1], true, false).unwrap();
    assert_eq!(ops::project::attach_workspace(&host, "main", &roots[1]).unwrap().as_ref(), roots[0]);
    assert!(Arc::ptr_eq(&host.project("main").unwrap(), &project));
    assert_eq!(&host.project("main").unwrap().index as *const _, existing_index);
    assert_eq!(project.root, roots[0]);
    assert_eq!(project.build_cache_dir(), cache);
    assert!(!base.join("data/workspaces").exists());
    assert_eq!(Workspace::load(&roots[0]).unwrap().unwrap().projects, roots);
    assert!(
        std::fs::read_to_string(roots[0].join(".openidea/.gitignore")).unwrap().lines().any(|l| l == "/workspace.json")
    );
    assert_eq!(project.content_roots(), vec![roots[1].clone()]);
    let attached = ops::project::info(&project);
    assert_eq!(attached.name, "primary");
    assert_eq!(attached.display_name, "primary, other");
    ops::project::set_settings(
        &host,
        "main",
        ide_workspace::SettingsScope::Project,
        "general.projectName",
        &serde_json::to_string(&attached.name).unwrap(),
    )
    .unwrap();
    assert_eq!(ops::project::info(&project).display_name, "primary, other");
    let restricted = base.join("restricted");
    std::fs::create_dir(&restricted).unwrap();
    host.trust.decide(&restricted, false, false).unwrap();
    assert!(
        ops::project::save_workspace(&host, "main", "Primary", vec![roots[0].clone(), roots[1].clone(), restricted])
            .is_err()
    );
    let all = ops::run::configs(&host, "main").unwrap();
    assert_eq!(all.len(), configs.len() * 2);
    for config in &configs {
        assert_eq!(all.iter().filter(|c| c.id == config.id).count(), 1);
    }
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    assert_eq!(project.index.find_files("same.txt", 100).len(), 2);
    let hits = Arc::new(Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({"pattern":"needle", "isRegex":false,"caseSensitive":false,"wholeWord":false,"include":[],"exclude":[],"scope":{"kind":"project"},"maxMatches":100})).unwrap();
    ops::search::start(
        &host,
        "main",
        RequestId::next(),
        query,
        Arc::new(move |event| {
            if let ops::search::SearchEvent::File { file } = event {
                out.lock().unwrap().push(file);
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(hits.lock().unwrap().len(), 2);
    assert!(ops::project::save_workspace(&host, "main", "Primary", vec![roots[1].clone()]).is_err());
    let updated = ops::project::save_workspace(&host, "main", "Primary", vec![roots[0].clone()]).unwrap();
    assert!(updated.workspace.is_none());
    assert_eq!(updated.name, "primary");
    assert_eq!(updated.root.as_ref(), roots[0]);
    assert!(!roots[0].join(ide_workspace::workspace::FILE).exists());
    assert!(project.content_roots().is_empty());
    assert_eq!(
        ops::run::configs(&host, "main").unwrap().iter().map(|c| &c.id).collect::<Vec<_>>(),
        configs.iter().map(|c| &c.id).collect::<Vec<_>>()
    );
    assert!(project.documents.text_of(&roots[0].join("same.txt")).unwrap().starts_with("unsaved"));
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    assert_eq!(project.index.find_files("same.txt", 100).len(), 1);
    let nested = roots[0].join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("same.txt"), "needle").unwrap();
    host.trust.decide(&nested, true, false).unwrap();
    Workspace::attach(&nested, "Nested", vec![nested.clone()]).unwrap();
    ops::project::attach_workspace(&host, "main", &nested).unwrap();
    assert!(project.content_roots().is_empty());
    let container = base.join("container");
    Workspace::save(&container, "Container", vec![], true).unwrap();
    host.trust.decide(&container, true, false).unwrap();
    assert!(ops::project::attach_workspace(&host, "main", &container).is_err());
    host.close_project("main");
    let reopened = host.open_project("main", &roots[0]).unwrap();
    assert_eq!(ops::project::info(&reopened).name, "primary");
    assert_eq!(ops::project::info(&reopened).display_name, "primary, nested");
    host.set_project_trust(&nested, false, false).await.unwrap();
    assert!(!reopened.is_trusted());
    host.close_project("main");
}
