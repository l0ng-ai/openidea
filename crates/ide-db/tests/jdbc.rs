use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbJdbcDriver, DbManager, SortKey};
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
    reopened.save_sources(vec![readonly]).await?;
    let err = reopened.apply_edits("local", "main", "sample", &[]).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::PermissionDenied);
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
#[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
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
        url: "jdbc:duckdb:local.duckdb".into(),
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
    let completion = db.completion("test").await?;
    assert_eq!(completion.default_schema, "main");
    let items = completion.tables.iter().find(|t| t.schema == "main" && t.name == "items").expect("items");
    assert_eq!(items.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "label"]);
    db.execute("test", "create temporary table session_marker as select 42 as id", 1, &c).await?;
    let stop = CancellationToken::new();
    let (cancelled, ()) =
        tokio::join!(db.execute("test", "select sum(sin(i)) from range(1000000000) t(i)", 1, &stop), async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            stop.cancel();
        },);
    assert_eq!(cancelled.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
    let marker = db.execute("test", "select id from session_marker", 1, &c).await?;
    assert_eq!(marker.rows, [vec![Some("42".into())]]);
    let sort = [SortKey { column: "id".into(), descending: false }];
    let first = db.table_page("test", "main", "items", None, &sort, 0, 1, &c).await?.result;
    assert_eq!(first.rows, result.rows);
    assert!(first.has_more);
    let last = db.table_page("test", "main", "items", None, &sort, 1, 1, &c).await?.result;
    assert_eq!(last.rows, vec![vec![Some("2".into()), Some("row".into())]]);
    assert!(!last.has_more);
    let past = db.table_page("test", "main", "items", None, &sort, 2, 1, &c).await?.result;
    assert!(past.rows.is_empty() && !past.has_more);
    db.disconnect("test").await;
    let reopened = manager(tmp.path());
    assert_eq!(reopened.execute("test", "select count(*) from items", 1, &c).await?.rows, [vec![Some("2".into())]]);
    reopened.disconnect("test").await;
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
        read_only: true,
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
    let c = CancellationToken::new();
    let page = db.table_page("test", "system", "one", None, &[], 0, 1, &c).await?.result;
    assert_eq!(page.rows.len(), 1);
    assert!(!page.has_more);
    let past = db.table_page("test", "system", "one", None, &[], 1, 1, &c).await?.result;
    assert!(past.rows.is_empty() && !past.has_more);
    db.disconnect("test").await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires JDBC_FIXTURE_JAR (java/jdbc-bridge/build.py --test --out fixture.jar) and Java 17+"]
async fn unresponsive_driver_closes_before_reconnect() -> IdeResult<()> {
    use std::time::Duration;
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    let started = tmp.path().join("started");
    db.save_jdbc_driver(DbJdbcDriver {
        id: "fixture".into(),
        name: "Fixture".into(),
        jars: vec![std::env::var("JDBC_FIXTURE_JAR").unwrap()],
        class_name: "ai.openidea.jdbc.SelfTest$Fixture".into(),
        url_template: String::new(),
    })?;
    let source = DataSource {
        id: "test".into(),
        name: "Fixture".into(),
        driver: DbDriver::Jdbc,
        global: true,
        read_only: true,
        jdbc_driver: "fixture".into(),
        url: format!("jdbc:fixture:{}", started.display()),
        ..Default::default()
    };
    db.test(&source, None, None).await?;
    db.save_sources(vec![source]).await?;
    let normal = CancellationToken::new();
    assert!(db.execute("test", "write", 1, &normal).await.unwrap_err().message.contains("read-only"));
    let stop = CancellationToken::new();
    let (result, ()) = tokio::time::timeout(Duration::from_secs(12), async {
        tokio::join!(db.execute("test", "ignore cancel", 1, &stop), async {
            while !started.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            stop.cancel();
        })
    })
    .await
    .expect("driver cancellation must be bounded");
    assert_eq!(
        result.unwrap_err().message,
        "Cancellation timed out and the JDBC session was closed. Check the statement's status on the server before running it again. The next query will try to reconnect."
    );
    assert!(db.connected().is_empty());
    assert_eq!(db.execute("test", "after cancellation", 1, &normal).await?.affected, Some(1.0));
    assert_eq!(db.connected(), ["test"]);
    db.disconnect("test").await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires JDBC_FIXTURE_JAR (java/jdbc-bridge/build.py --test --out fixture.jar) and Java 17+"]
async fn a_lost_session_reconnects_on_the_next_statement() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    db.save_jdbc_driver(DbJdbcDriver {
        id: "fixture".into(),
        name: "Fixture".into(),
        jars: vec![std::env::var("JDBC_FIXTURE_JAR").unwrap()],
        class_name: "ai.openidea.jdbc.SelfTest$Fixture".into(),
        url_template: String::new(),
    })?;
    let source = DataSource {
        id: "test".into(),
        name: "Fixture".into(),
        driver: DbDriver::Jdbc,
        global: true,
        jdbc_driver: "fixture".into(),
        url: "jdbc:fixture:".into(),
        ..Default::default()
    };
    db.save_sources(vec![source]).await?;
    let cancel = CancellationToken::new();
    db.execute("test", "first", 1, &cancel).await?;
    // The fixture's session reports itself invalid after "drop", like a connection a proxy reset.
    assert!(db.execute("test", "drop", 1, &cancel).await.unwrap_err().message.contains("connection reset"));
    assert!(!db.is_connected("test"), "a lost session is no longer listed as connected");
    assert_eq!(db.execute("test", "after reconnect", 1, &cancel).await?.affected, Some(1.0));
    assert!(db.is_connected("test"));
    db.disconnect("test").await;
    Ok(())
}
