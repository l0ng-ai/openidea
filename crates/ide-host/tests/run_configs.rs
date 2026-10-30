use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;

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
async fn removed_detections_stay_removed_and_overrides_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    std::fs::write(root.join("package.json"), r#"{"scripts":{"dev":"node app.js","test":"node test.js"}}"#).unwrap();
    let host = host(&root.join("app"));
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
