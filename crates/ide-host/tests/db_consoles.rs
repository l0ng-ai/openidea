mod common;

use ide_host::Host;
use ide_host::ops::db;
use std::sync::Arc;

#[tokio::test]
async fn new_query_consoles_are_numbered_after_the_default_one() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let host = Arc::new(Host::new(common::host_config(base)));
    let root = base.join("data/scratches/consoles/db/pg");
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
async fn old_query_consoles_move_under_scratches_without_overwriting() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let host = Arc::new(Host::new(common::host_config(base)));
    let old = base.join("data/consoles/db/pg");
    let new = base.join("data/scratches/consoles/db/pg");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("console.sql"), "select 1").unwrap();
    std::fs::write(old.join("console_1.sql"), "select 2").unwrap();

    let consoles = db::db_consoles(&host, "pg".into(), false).unwrap();
    assert_eq!(consoles.len(), 2);
    assert!(consoles.iter().all(|path| path.0.starts_with(&new)));
    assert_eq!(std::fs::read_to_string(new.join("console.sql")).unwrap(), "select 1");
    assert!(!old.exists());

    // A conflicting destination keeps both files rather than overwriting either console.
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("console.sql"), "old copy").unwrap();
    db::db_consoles(&host, "pg".into(), false).unwrap();
    assert_eq!(std::fs::read_to_string(new.join("console.sql")).unwrap(), "select 1");
    assert_eq!(std::fs::read_to_string(old.join("console.sql")).unwrap(), "old copy");
}
