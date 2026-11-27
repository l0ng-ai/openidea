mod common;

use ide_host::Host;
use ide_host::ops::db;
use std::sync::Arc;

#[tokio::test]
async fn new_query_consoles_are_numbered_after_the_default_one() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let host = Arc::new(Host::new(common::host_config(base)));
    let root = base.join("data/consoles/db/pg");
    let names = |paths: Vec<ide_core::IpcPath>| -> Vec<String> {
        paths.iter().map(|p| p.0.file_name().unwrap().to_string_lossy().into_owned()).collect()
    };
    assert!(db::db_consoles(&host, "pg".into(), false).unwrap().is_empty());
    // The first new console is the default one, then console_1, console_2…
    let first = db::db_consoles(&host, "pg".into(), true).unwrap();
    assert_eq!(names(first.clone()), ["console.sql"]);
    assert_eq!(first[0].0, root.join("console.sql"));
    assert_eq!(names(db::db_consoles(&host, "pg".into(), true).unwrap()), ["console.sql", "console_1.sql"]);
    let all = db::db_consoles(&host, "pg".into(), true).unwrap();
    assert_eq!(names(all.clone()), ["console.sql", "console_1.sql", "console_2.sql"]);
    // Numbers sort numerically, and the default console path is the first one.
    std::fs::write(all[0].0.with_file_name("console_10.sql"), "").unwrap();
    assert_eq!(names(db::db_consoles(&host, "pg".into(), false).unwrap())[3], "console_10.sql");
    assert_eq!(db::db_console_path(&host, "pg".into()).unwrap().0, all[0].0);
    // Each database of a source has its own consoles.
    assert!(db::db_consoles(&host, "pg:other".into(), false).unwrap().is_empty());
    assert!(db::db_consoles(&host, "../x".into(), true).is_err());
}

#[tokio::test]
async fn consoles_root_is_the_directory_listed_in_the_project_view() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let host = Arc::new(Host::new(common::host_config(base)));
    let root = db::db_consoles_dir(&host).unwrap();
    assert_eq!(root.0, base.join("data/consoles/db"));
    assert!(root.0.is_dir());
}
