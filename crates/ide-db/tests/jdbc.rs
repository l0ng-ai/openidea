use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbJdbcDriver, DbManager};
use std::{path::Path, sync::Arc};

fn manager(dir: &Path) -> DbManager {
    let ssh = Arc::new(ide_ssh::SshManager::new(dir.join("ssh.json")));
    DbManager::new(dir.join("project"), dir.join("passwords.json"), dir.join("history.json"), ssh)
        .with_global_sources(dir.join("global"))
}

#[tokio::test]
async fn jdbc_profiles_persist_and_project_files_cannot_start_drivers() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let jar = tmp.path().join("fixture.jar");
    std::fs::write(&jar, [])?;
    let db = manager(tmp.path());
    db.save_jdbc_driver(DbJdbcDriver {
        id: "fixture".into(),
        name: "Test".into(),
        jars: vec![jar.display().to_string()],
        class_name: "test.Driver".into(),
        url_template: "jdbc:test:".into(),
    })?;
    let reopened = manager(tmp.path());
    assert_eq!(reopened.jdbc_drivers()?[0].class_name, "test.Driver");
    let source = DataSource {
        id: "local".into(),
        name: "local".into(),
        driver: DbDriver::Jdbc,
        jdbc_driver: "fixture".into(),
        url: "jdbc:test:".into(),
        ..Default::default()
    };
    reopened.save_sources(vec![source.clone()]).await?;
    let denied = reopened.pool("local").await.err().expect("project JDBC requires explicit approval");
    assert!(denied.message.contains("Review this project"));
    let readonly = DataSource { read_only: true, ..source.clone() };
    let err = reopened.test(&readonly, None, None).await.unwrap_err();
    assert!(err.message.contains("cannot enforce read-only"));
    reopened.approve_jdbc_source(&readonly)?;
    reopened.save_sources(vec![readonly]).await?;
    assert!(reopened.pool("local").await.err().unwrap().message.contains("cannot enforce read-only"));
    reopened.approve_jdbc_source(&source)?;
    let mut changed = source.clone();
    changed.url.push_str("changed");
    reopened.save_sources(vec![changed]).await?;
    assert!(reopened.pool("local").await.err().unwrap().message.contains("Review this project"));
    let mut global = source;
    global.global = true;
    reopened.save_sources(vec![global]).await?;
    assert!(reopened.remove_jdbc_driver("fixture").is_err());
    reopened.save_sources(vec![]).await?;
    reopened.remove_jdbc_driver("fixture")?;
    assert!(manager(tmp.path()).jdbc_drivers()?.is_empty());
    Ok(())
}

#[tokio::test]
#[ignore = "requires DUCKDB_JDBC_JAR and a local JDK 17+"]
async fn duckdb_custom_driver_through_database_manager() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    let jar = std::env::var("DUCKDB_JDBC_JAR").expect("DUCKDB_JDBC_JAR");
    assert_eq!(ide_db::jdbc_driver_classes(std::slice::from_ref(&jar))?, ["org.duckdb.DuckDBDriver"]);
    db.save_jdbc_driver(DbJdbcDriver {
        id: "duck".into(),
        name: "DuckDB".into(),
        jars: vec![jar],
        class_name: "org.duckdb.DuckDBDriver".into(),
        url_template: "jdbc:duckdb:".into(),
    })?;
    let source = DataSource {
        id: "test".into(),
        name: "DuckDB".into(),
        driver: DbDriver::Jdbc,
        global: true,
        jdbc_driver: "duck".into(),
        url: "jdbc:duckdb:".into(),
        ..Default::default()
    };
    assert!(db.test(&source, None, None).await?.to_lowercase().contains("duckdb"));
    db.save_sources(vec![source]).await?;
    let db = manager(tmp.path());
    let c = CancellationToken::new();
    db.execute("test", "create table items(id int primary key, label varchar)", 1, &c).await?;
    db.execute("test", "insert into items values (1, NULL), (2, 'row')", 1, &c).await?;
    assert!(db.schemas("test").await?.iter().any(|v| v == "main"));
    assert!(db.tables("test", "main").await?.iter().any(|v| v.name == "items"));
    let details = db.table_details("test", "main", "items").await?;
    assert_eq!(details.columns.len(), 2);
    let result = db.execute("test", "select id, label from items order by id", 1, &c).await?;
    assert!(result.has_more);
    assert_eq!(result.rows, vec![vec![Some("1".into()), None]]);
    assert_eq!(result.columns[1].name, "label");
    assert_eq!(db.completion("test").await?.default_schema, "main");
    db.disconnect("test").await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires CLICKHOUSE_JDBC_CLASSPATH and a loopback ClickHouse fixture on CLICKHOUSE_JDBC_TEST_PORT"]
async fn clickhouse_vendor_driver_reads_catalog_and_results() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    let jars: Vec<String> =
        std::env::split_paths(&std::env::var_os("CLICKHOUSE_JDBC_CLASSPATH").expect("CLICKHOUSE_JDBC_CLASSPATH"))
            .map(|p| p.display().to_string())
            .collect();
    let classes = ide_db::jdbc_driver_classes(&jars)?;
    assert_eq!(classes.first().map(String::as_str), Some("com.clickhouse.jdbc.ClickHouseDriver"));
    let port: u16 = std::env::var("CLICKHOUSE_JDBC_TEST_PORT").unwrap().parse().unwrap();
    db.save_jdbc_driver(DbJdbcDriver {
        id: "clickhouse".into(),
        name: "ClickHouse JDBC".into(),
        jars,
        class_name: "com.clickhouse.jdbc.ClickHouseDriver".into(),
        url_template: "jdbc:clickhouse://".into(),
    })?;
    let source = DataSource {
        id: "test".into(),
        name: "ClickHouse JDBC".into(),
        driver: DbDriver::Jdbc,
        jdbc_driver: "clickhouse".into(),
        url: format!("jdbc:clickhouse://127.0.0.1:{port}/default"),
        user: "fixture".into(),
        ..Default::default()
    };
    let password = "local-fixture";
    assert!(db.test(&source, Some(password.into()), None).await?.contains("ClickHouse"));
    db.approve_jdbc_source(&source)?;
    db.save_sources(vec![source]).await?;
    db.set_password("test", Some(password.into()), false).await?;
    assert!(db.schemas("test").await?.iter().any(|v| v == "system"));
    assert!(db.tables("test", "system").await?.iter().any(|v| v.name == "one"));
    let cols = db.table_details("test", "system", "one").await?.columns;
    assert!(cols.iter().any(|col| col.name == "dummy"));
    let r = db.execute("test", "SELECT number FROM numbers(3) ORDER BY number", 2, &CancellationToken::new()).await?;
    assert_eq!(r.rows.len(), 2);
    assert!(r.has_more);
    db.disconnect("test").await;
    Ok(())
}
