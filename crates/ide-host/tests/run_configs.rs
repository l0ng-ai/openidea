use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;

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
async fn removed_detections_stay_removed_and_overrides_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    std::fs::write(root.join("package.json"), r#"{"scripts":{"dev":"node app.js","test":"node test.js"}}"#).unwrap();
    let host = host(&root.join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let detected = ops::run::configs(&host, "main").unwrap();
    assert!(detected.len() >= 2);
    assert!(detected.iter().all(|c| c.detected));
    let id = detected[0].id.clone();
    ops::run::save_configs(&host, "main", &[], std::slice::from_ref(&id)).unwrap();
    let remaining = ops::run::configs(&host, "main").unwrap();
    assert!(!remaining.iter().any(|c| c.id == id));
    assert_eq!(remaining.len(), detected.len() - 1);
    // Reopening a project reads suppression from disk.
    host.open_project("again", &root).unwrap();
    assert!(!ops::run::configs(&host, "again").unwrap().iter().any(|c| c.id == id));
    let mut saved = detected[0].clone();
    saved.detected = false;
    ops::run::save_configs(&host, "main", &[saved], &[]).unwrap();
    assert!(ide_run::load_suppressed_config_ids(&root).unwrap().is_empty());
    assert!(!ops::run::configs(&host, "main").unwrap().iter().find(|c| c.id == id).unwrap().detected);
    ops::run::save_configs(&host, "main", &[], &[]).unwrap();
    assert!(ops::run::configs(&host, "main").unwrap().iter().find(|c| c.id == id).unwrap().detected);
    // An override may coexist with suppression (e.g. a shared file added elsewhere).
    ops::run::save_configs(&host, "main", &[], std::slice::from_ref(&id)).unwrap();
    std::fs::write(
        ide_run::user_configs_path(&root),
        format!("[[configurations]]\nid = {id:?}\nname = \"Override\"\ncommand = \"node\"\n"),
    )
    .unwrap();
    assert!(ops::run::configs(&host, "main").unwrap().iter().any(|c| c.id == id && !c.detected));
    ops::run::save_configs(&host, "main", &[], &[]).unwrap();
    assert!(!ops::run::configs(&host, "main").unwrap().iter().any(|c| c.id == id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gradle_defaults_are_not_saved_as_explicit_run_choices() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
    let host = host(&root.join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    ops::project::set_settings(
        &host,
        "main",
        ide_workspace::settings::SettingsScope::Project,
        "languages.java.gradle.jvm",
        "\"/configured-jdk\"",
    )
    .unwrap();
    let configs = ops::run::configs(&host, "main").unwrap();
    let mut gradle = configs.into_iter().find(|c| c.kind == "gradle").unwrap();
    assert!(!gradle.env.contains_key("JAVA_HOME"));
    gradle.detected = false;
    gradle.env.insert("JAVA_HOME".into(), "/explicit-jdk".into());
    ops::run::save_configs(&host, "main", &[gradle.clone()], &[]).unwrap();
    let saved = ops::run::configs(&host, "main").unwrap().into_iter().find(|c| c.id == gradle.id).unwrap();
    assert_eq!(saved.env["JAVA_HOME"], "/explicit-jdk");
    assert_eq!(saved.command, gradle.command);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maven_defaults_are_resolved_at_launch_and_explicit_choices_survive_reload() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    std::fs::write(root.join("pom.xml"), "<project/>").unwrap();
    let home = root.join("maven");
    std::fs::create_dir_all(home.join("bin")).unwrap();
    let launcher = home.join("bin").join(if cfg!(windows) { "mvn.cmd" } else { "mvn" });
    std::fs::write(&launcher, "").unwrap();
    let host = host(&root.join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    for (key, value) in [
        ("languages.java.maven.home", home.to_string_lossy().into_owned()),
        ("languages.java.maven.userSettings", "settings.xml".into()),
    ] {
        ops::project::set_settings(
            &host,
            "main",
            ide_workspace::settings::SettingsScope::Project,
            key,
            &serde_json::to_string(&value).unwrap(),
        )
        .unwrap();
    }
    let mut config = ops::run::configs(&host, "main").unwrap().into_iter().find(|c| c.id == "maven:test").unwrap();
    assert_eq!(config.command, "mvn");
    assert_eq!(config.args, ["test"]);
    assert!(config.env.is_empty());
    config.command = launcher.to_string_lossy().into_owned();
    config.args = vec!["-s".into(), "own-settings.xml".into(), "test".into()];
    config.env.insert("JAVA_HOME".into(), "own-jdk".into());
    config.detected = false;
    ops::run::save_configs(&host, "main", &[config.clone()], &[]).unwrap();
    let saved = ops::run::configs(&host, "main").unwrap().into_iter().find(|c| c.id == config.id).unwrap();
    assert_eq!(saved.command, config.command);
    assert_eq!(saved.args, config.args);
    assert_eq!(saved.env, config.env);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_cmake_before_launch_tasks_resolve_in_the_member() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let member = root.join("native");
    std::fs::create_dir(&member).unwrap();
    std::fs::write(member.join("CMakeLists.txt"), "project(demo)").unwrap();
    let workspace = root.join("workspace");
    ide_workspace::workspace::Workspace::save(&workspace, "Native", vec![member.clone()], true).unwrap();
    let host = host(&root.join("app"));
    host.trust.decide(&workspace, true, false).unwrap();
    host.trust.decide(&member, true, false).unwrap();
    host.open_project("main", &workspace).unwrap();
    let configs = ops::run::configs(&host, "main").unwrap();
    let build = configs.iter().find(|c| c.kind == "cmake" && c.args.first().is_some_and(|a| a == "--build")).unwrap();
    assert_eq!(build.cwd.as_deref(), Some(member.as_path()));
    for task in &build.extras.before_launch {
        assert!(configs.iter().any(|c| c.id == task.target && c.cwd == build.cwd));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gradle_init_scripts_are_written_by_the_host_that_runs_the_build() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    let text = "allprojects { }\n".to_string();
    let path =
        ops::run::run_gradle_init_script(&host, "main", "openidea-gradle-tests".into(), text.clone()).await.unwrap();
    assert!(path.contains("openidea-gradle-tests-"), "{path}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    let again = ops::run::run_gradle_init_script(&host, "main", "openidea-gradle-tests".into(), text).await.unwrap();
    assert_eq!(again, path);
    // A name is not a path.
    let escaped = ops::run::run_gradle_init_script(&host, "main", "../escape".into(), String::new()).await;
    assert!(escaped.is_err(), "{escaped:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn debug_env_files_load_in_order_like_a_run() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    let first = tmp.path().join("first.env");
    let second = tmp.path().join("second.env");
    std::fs::write(&first, "SHARED=one\nONLY_FIRST=1\nREF=${SHARED}-suffix\n").unwrap();
    std::fs::write(&second, "SHARED=two\nONLY_SECOND=2\n").unwrap();
    let vars = ops::run::run_env_files(&host, "main", vec![first, second]).unwrap();
    // Later files win; references resolve against earlier files, then the system environment.
    assert_eq!(vars.get("SHARED").map(String::as_str), Some("two"));
    assert_eq!(vars.get("ONLY_FIRST").map(String::as_str), Some("1"));
    assert_eq!(vars.get("ONLY_SECOND").map(String::as_str), Some("2"));
    assert_eq!(vars.get("REF").map(String::as_str), Some("one-suffix"));
    // An unreadable file is an error, like a run that names a missing `.env`.
    let missing = ops::run::run_env_files(&host, "main", vec![tmp.path().join("nope.env")]);
    assert!(missing.is_err(), "{missing:?}");
}
