use ide_core::NullSink;
use ide_host::ops::db;
use ide_host::{Host, HostConfig};
use std::sync::Arc;

#[tokio::test]
async fn new_query_consoles_are_numbered_after_the_default_one() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let names = |paths: Vec<ide_core::IpcPath>| -> Vec<String> {
        paths.iter().map(|p| p.0.file_name().unwrap().to_string_lossy().into_owned()).collect()
    };
    assert!(db::consoles(&host, "pg", false).unwrap().is_empty());
    // The first new console is the default one, then console_1, console_2…
    assert_eq!(names(db::consoles(&host, "pg", true).unwrap()), ["console.sql"]);
    assert_eq!(names(db::consoles(&host, "pg", true).unwrap()), ["console.sql", "console_1.sql"]);
    let all = db::consoles(&host, "pg", true).unwrap();
    assert_eq!(names(all.clone()), ["console.sql", "console_1.sql", "console_2.sql"]);
    // Numbers sort numerically, and the default console path is the first one.
    std::fs::write(all[0].0.with_file_name("console_10.sql"), "").unwrap();
    assert_eq!(names(db::consoles(&host, "pg", false).unwrap())[3], "console_10.sql");
    assert_eq!(db::console_path(&host, "pg").unwrap().0, all[0].0);
    // Each database of a source has its own consoles.
    assert!(db::consoles(&host, "pg:other", false).unwrap().is_empty());
    assert!(db::consoles(&host, "../x", true).is_err());
}
