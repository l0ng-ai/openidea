use ide_core::{CancellationToken, IdeResult};
use ide_db::{ConsoleId, DataSource, DbDriver, DbJdbcDriver, DbManager, DbProperty, SortKey};
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
        vendor: None,
        jars: vec![jar.display().to_string()],
        class_name: "test.Driver".into(),
        url_template: "jdbc:test:".into(),
    })?;
    let reopened = manager(tmp.path());
    assert_eq!(reopened.jdbc_drivers()?[0].class_name, "test.Driver");
    assert_eq!(reopened.jdbc_drivers()?[0].vendor, None);
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
async fn named_jdbc_sources_persist_the_type_and_reject_a_profile_for_another_type() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let jar = tmp.path().join("fixture.jar");
    std::fs::write(&jar, [])?;
    let db = manager(tmp.path());
    db.save_jdbc_driver(DbJdbcDriver {
        id: "fixture".into(),
        name: "Test".into(),
        vendor: Some("tidb".into()),
        jars: vec![jar.display().to_string()],
        class_name: "test.Driver".into(),
        url_template: String::new(),
    })?;
    let source = DataSource {
        id: "local".into(),
        name: "local".into(),
        driver: DbDriver::Jdbc,
        vendor: "mariadb".into(),
        jdbc_driver: "fixture".into(),
        url: "jdbc:test:".into(),
        ..Default::default()
    };
    db.save_sources(vec![source]).await?;
    let reopened = manager(tmp.path());
    let source = reopened.source("local")?;
    assert_eq!(reopened.jdbc_drivers()?[0].vendor.as_deref(), Some("tidb"));
    assert_eq!(source.driver, DbDriver::Jdbc);
    assert_eq!(source.vendor, "mariadb");
    let err = reopened.test(&source, None, None).await.unwrap_err();
    assert!(err.message.contains("not associated with this data source type"));
    Ok(())
}

fn register_duckdb(db: &DbManager, vendor: Option<&str>) -> IdeResult<()> {
    let jar = std::env::var("DUCKDB_JDBC_JAR").expect("DUCKDB_JDBC_JAR");
    assert_eq!(ide_db::jdbc_driver_classes(std::slice::from_ref(&jar))?, ["org.duckdb.DuckDBDriver"]);
    db.save_jdbc_driver(DbJdbcDriver {
        id: "duck".into(),
        name: "DuckDB".into(),
        vendor: vendor.map(str::to_owned),
        jars: vec![jar],
        class_name: "org.duckdb.DuckDBDriver".into(),
        url_template: "jdbc:duckdb:".into(),
    })
}

#[tokio::test]
#[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
async fn duckdb_custom_driver_through_database_manager() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    register_duckdb(&db, None)?;
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
#[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
async fn duckdb_named_file_enforces_read_only_at_open() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    register_duckdb(&db, Some("duckdb"))?;
    let file = tmp.path().join("example.duckdb");
    let mut source = DataSource {
        id: "test".into(),
        name: "DuckDB".into(),
        driver: DbDriver::Jdbc,
        vendor: "duckdb".into(),
        global: true,
        jdbc_driver: "duck".into(),
        url: format!("jdbc:duckdb:{}", file.display()),
        file: Some(file.clone().into()),
        read_only: true,
        ..Default::default()
    };
    let cancel = CancellationToken::new();
    let err = db.test(&source, None, None).await.unwrap_err();
    assert!(err.message.contains("existing database file"), "{}", err.message);
    assert!(!file.exists());

    source.read_only = false;
    db.save_sources(vec![source.clone()]).await?;
    db.execute("test", "create table items (id int)", 1, &cancel).await?;
    db.execute("test", "insert into items values (1)", 1, &cancel).await?;
    db.disconnect("test").await;

    source.read_only = true;
    let reopened = manager(tmp.path());
    assert!(reopened.test(&source, None, None).await?.to_lowercase().contains("duckdb"));
    let mut conflicting = source.clone();
    for options in ["; access_mode = READ_WRITE", "; duckdb.read_only = false"] {
        conflicting.url = format!("{}{options}", source.url);
        let err = reopened.test(&conflicting, None, None).await.unwrap_err();
        assert!(err.message.contains("conflicts with Read-only"), "{}", err.message);
    }
    conflicting.url = source.url.clone();
    conflicting.properties.push(DbProperty { name: "ACCESS_MODE".into(), value: "READ_WRITE".into() });
    let err = reopened.test(&conflicting, None, None).await.unwrap_err();
    assert!(err.message.contains("conflicts with Read-only"), "{}", err.message);

    reopened.save_sources(vec![source.clone()]).await?;
    assert_eq!(reopened.source("test")?.vendor, "duckdb");
    assert_eq!(reopened.execute("test", "select id from items", 1, &cancel).await?.rows, [vec![Some("1".into())]]);
    for console in [None, Some(ConsoleId::new("window", "/reader.sql"))] {
        for query in ["insert into items values (2)", "create table added (id int)"] {
            let err = reopened.execute_in_console("test", query, 0, 1, &cancel, None, console).await.unwrap_err();
            assert!(err.message.to_lowercase().contains("read-only"), "{}", err.message);
        }
    }
    assert!(!reopened.tables("test", "main").await?.iter().any(|table| table.name == "added"));
    reopened.disconnect("test").await;

    source.read_only = false;
    reopened.save_sources(vec![source]).await?;
    reopened.execute("test", "insert into items values (2)", 1, &cancel).await?;
    assert_eq!(
        reopened.execute("test", "select count(*) from items", 1, &cancel).await?.rows,
        [vec![Some("2".into())]]
    );
    reopened.disconnect("test").await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
async fn duckdb_named_memory_lives_until_disconnect() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    register_duckdb(&db, Some("duckdb"))?;
    let mut source = DataSource {
        id: "test".into(),
        name: "DuckDB (memory)".into(),
        driver: DbDriver::Jdbc,
        vendor: "duckdb".into(),
        global: true,
        jdbc_driver: "duck".into(),
        url: "jdbc:duckdb:".into(),
        ..Default::default()
    };
    let cancel = CancellationToken::new();
    db.save_sources(vec![source.clone()]).await?;
    db.execute("test", "create table session_items as select 42 as id", 1, &cancel).await?;
    assert_eq!(db.execute("test", "select id from session_items", 1, &cancel).await?.rows, [vec![Some("42".into())]]);
    db.disconnect("test").await;
    assert!(!db.tables("test", "main").await?.iter().any(|table| table.name == "session_items"));
    db.disconnect("test").await;

    source.read_only = true;
    for url in ["jdbc:duckdb:", "jdbc:duckdb::memory:"] {
        source.url = url.into();
        let err = db.test(&source, None, None).await.unwrap_err();
        assert!(err.message.contains("existing database file"), "{}", err.message);
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires DUCKDB_JDBC_JAR and a local Java 17+ runtime"]
async fn duckdb_consoles_share_catalog_but_isolate_transactions_and_temporary_tables() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    register_duckdb(&db, Some("duckdb"))?;
    db.save_sources(vec![DataSource {
        id: "test".into(),
        name: "DuckDB in memory".into(),
        driver: DbDriver::Jdbc,
        vendor: "duckdb".into(),
        global: true,
        jdbc_driver: "duck".into(),
        url: "jdbc:duckdb:".into(),
        ..Default::default()
    }])
    .await?;
    let cancel = CancellationToken::new();
    let a = ConsoleId::new("first", "/console.sql");
    let b = ConsoleId::new("second", "/console.sql");
    let run = |console, sql: &'static str| db.execute_in_console("test", sql, 0, 10, &cancel, None, Some(console));

    db.execute("test", "CREATE TABLE durable (id INTEGER)", 1, &cancel).await?;
    run(a, "CREATE TEMP TABLE local_only AS SELECT 7 AS id").await?;
    assert!(run(b, "SELECT id FROM local_only").await.is_err(), "B must not see A's temporary table");
    run(b, "CREATE TEMP TABLE local_only AS SELECT 9 AS id").await?;
    assert_eq!(run(a, "SELECT id FROM local_only").await?.rows, [vec![Some("7".into())]]);

    run(a, "BEGIN TRANSACTION").await?;
    run(a, "INSERT INTO durable VALUES (1)").await?;
    assert_eq!(run(a, "SELECT id FROM durable").await?.rows, [vec![Some("1".into())]]);
    assert!(run(b, "SELECT id FROM durable").await?.rows.is_empty());
    db.release_target_console(a, Some("test")).await?;
    assert_eq!(run(b, "SELECT id FROM local_only").await?.rows, [vec![Some("9".into())]]);
    assert!(run(a, "SELECT id FROM local_only").await.is_err(), "a reopened console starts a fresh session");
    assert!(run(a, "SELECT id FROM durable").await?.rows.is_empty(), "closing A rolls back its transaction");
    db.disconnect("test").await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires SQLITE_JDBC_CLASSPATH, H2_JDBC_JAR and a local Java 17+ runtime"]
async fn anonymous_jdbc_databases_stay_shared_across_consoles() -> IdeResult<()> {
    let sqlite = std::env::split_paths(&std::env::var_os("SQLITE_JDBC_CLASSPATH").expect("SQLITE_JDBC_CLASSPATH"))
        .map(|p| p.display().to_string())
        .collect();
    let h2 = vec![std::env::var("H2_JDBC_JAR").expect("H2_JDBC_JAR")];
    for (class_name, jars, url) in
        [("org.sqlite.JDBC", sqlite, "jdbc:sqlite::memory:"), ("org.h2.Driver", h2, "jdbc:h2:mem:;DB_CLOSE_DELAY=-1")]
    {
        let tmp = tempfile::tempdir()?;
        let db = manager(tmp.path());
        db.save_jdbc_driver(DbJdbcDriver {
            id: "private".into(),
            class_name: class_name.into(),
            name: class_name.into(),
            vendor: None,
            jars,
            url_template: String::new(),
        })?;
        db.save_sources(vec![DataSource {
            id: "test".into(),
            name: "Anonymous memory".into(),
            driver: DbDriver::Jdbc,
            global: true,
            jdbc_driver: "private".into(),
            url: url.into(),
            ..Default::default()
        }])
        .await?;
        let cancel = CancellationToken::new();
        let a = ConsoleId::new("window", "/a.sql");
        let b = ConsoleId::new("window", "/b.sql");
        let run = |console, sql: &'static str| db.execute_in_console("test", sql, 0, 1, &cancel, None, Some(console));
        db.execute("test", "CREATE TABLE preserved (id INTEGER)", 1, &cancel).await?;
        run(a, "INSERT INTO preserved VALUES (1)").await?;
        db.release_target_console(a, Some("test")).await?;
        assert_eq!(run(b, "SELECT id FROM preserved").await?.rows, [vec![Some("1".into())]]);
        db.disconnect("test").await;
    }
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
        vendor: Some("clickhouse".into()),
        jars,
        class_name: "com.clickhouse.jdbc.ClickHouseDriver".into(),
        url_template: "jdbc:clickhouse://".into(),
    })?;
    let source = DataSource {
        id: "test".into(),
        name: "ClickHouse JDBC".into(),
        driver: DbDriver::Jdbc,
        vendor: "clickhouse".into(),
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
        vendor: None,
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
async fn unresponsive_console_cancellation_keeps_other_jdbc_connections() -> IdeResult<()> {
    use std::time::Duration;
    let tmp = tempfile::tempdir()?;
    let db = manager(tmp.path());
    let started = tmp.path().join("started");
    db.save_jdbc_driver(DbJdbcDriver {
        id: "fixture".into(),
        name: "Fixture".into(),
        vendor: None,
        jars: vec![std::env::var("JDBC_FIXTURE_JAR").unwrap()],
        class_name: "ai.openidea.jdbc.SelfTest$Fixture".into(),
        url_template: String::new(),
    })?;
    db.save_sources(vec![DataSource {
        id: "test".into(),
        name: "Fixture".into(),
        driver: DbDriver::Jdbc,
        global: true,
        jdbc_driver: "fixture".into(),
        url: format!("jdbc:fixture:{}", started.display()),
        ..Default::default()
    }])
    .await?;
    let a = ConsoleId::new("window", "/a.sql");
    let b = ConsoleId::new("window", "/b.sql");
    let stop = CancellationToken::new();
    let normal = CancellationToken::new();
    let (ran_a, sibling) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(db.execute_in_console("test", "ignore cancel", 0, 1, &stop, None, Some(a)), async {
            while !started.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let sibling = tokio::time::timeout(Duration::from_secs(2), async {
                let b = db.execute_in_console("test", "from B", 0, 1, &normal, None, Some(b)).await?;
                let service = db.execute("test", "service", 1, &normal).await?;
                Ok::<_, ide_core::IdeError>((b.affected, service.affected))
            })
            .await;
            stop.cancel();
            sibling
        })
    })
    .await
    .expect("cancellation must remain bounded");
    assert_eq!(sibling.expect("B and service can finish while A is executing")?, (Some(1.0), Some(1.0)));
    assert!(ran_a.unwrap_err().message.contains("Cancellation timed out"));
    assert_eq!(db.connected(), ["test"]);
    assert_eq!(db.execute_in_console("test", "still B", 0, 1, &normal, None, Some(b)).await?.affected, Some(1.0));
    assert_eq!(db.execute_in_console("test", "new session A", 0, 1, &normal, None, Some(a)).await?.affected, Some(1.0));
    assert!(db.execute("test", "drop", 1, &normal).await.unwrap_err().message.contains("connection reset"));
    assert!(db.is_connected("test"), "a lost service connection must not retire the console sessions");
    assert_eq!(
        db.execute_in_console("test", "B after service failure", 0, 1, &normal, None, Some(b)).await?.affected,
        Some(1.0)
    );
    db.release_target_console(a, Some("test")).await?;
    db.release_target_console(b, Some("test")).await?;
    assert!(!db.is_connected("test"), "the failed service pool can be re-established after the last console");
    assert_eq!(db.execute("test", "new service session", 1, &normal).await?.affected, Some(1.0));
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
        vendor: None,
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
