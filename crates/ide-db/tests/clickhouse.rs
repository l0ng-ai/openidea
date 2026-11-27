use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_db::{CellValue, ConsoleId, DataSource, DbDriver, DbManager, DbRowEdit, DbSslMode, SortKey, sql};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

fn check(condition: bool, message: &str) -> IdeResult<()> {
    if condition { Ok(()) } else { Err(IdeError::invalid(message)) }
}

#[tokio::test]
#[ignore = "requires CLICKHOUSE_TEST_HOST, CLICKHOUSE_TEST_USER, and CLICKHOUSE_TEST_PASSWORD"]
async fn clickhouse_cloud_manager_catalogs_and_session_table() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let root = tmp.path().to_path_buf();
    let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    let mut source = DataSource {
        id: "clickhouse".into(),
        name: "clickhouse".into(),
        driver: DbDriver::Clickhouse,
        host: std::env::var("CLICKHOUSE_TEST_HOST").expect("set CLICKHOUSE_TEST_HOST"),
        port: Some(
            std::env::var("CLICKHOUSE_TEST_PORT")
                .map(|value| value.parse().expect("numeric CLICKHOUSE_TEST_PORT"))
                .unwrap_or(8443),
        ),
        user: std::env::var("CLICKHOUSE_TEST_USER").expect("set CLICKHOUSE_TEST_USER"),
        database: "default".into(),
        ssl: DbSslMode::VerifyFull,
        ..Default::default()
    };
    source.introspection.show_system = true;
    let password = std::env::var("CLICKHOUSE_TEST_PASSWORD").expect("set CLICKHOUSE_TEST_PASSWORD");
    check(!db.test(&source, Some(password.clone()), None).await?.is_empty(), "missing server version")?;
    db.save_sources(vec![source]).await?;
    db.set_password("clickhouse", Some(password), false).await?;
    let cancel = CancellationToken::new();
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let name = format!("manager_test_{}_{suffix}", std::process::id());
    let table = sql::quote_ident(DbDriver::Clickhouse, &name);
    db.execute(
        "clickhouse",
        &format!(
            "CREATE TEMPORARY TABLE {table} (id UInt64, label Nullable(String) DEFAULT NULL, \
             category LowCardinality(Nullable(String)) DEFAULT NULL, items Array(Nullable(UInt8)), \
             label_size UInt64 ALIAS length(ifNull(label, ''))) ENGINE = Memory"
        ),
        0,
        &cancel,
    )
    .await?;
    let checked: IdeResult<()> = async {
        db.execute(
            "clickhouse",
            &format!("INSERT INTO {table} (id, label, items) VALUES (1, 'first', [1, NULL]), (1, NULL, [])"),
            0,
            &cancel,
        )
        .await?;
        let schemas = db.schemas("clickhouse").await?;
        check(schemas.iter().any(|schema| schema == "default"), "default database missing")?;
        check(schemas.iter().any(|schema| schema == "system"), "system database missing")?;
        let tables = db.tables("clickhouse", "system").await?;
        check(tables.iter().any(|table| table.name == "one"), "system table listing missing one")?;
        let details = db.table_details("clickhouse", "", &name).await?;
        check(details.columns.len() == 5, "temporary table columns missing")?;
        for (name, data_type, nullable) in [
            ("id", "UInt64", false),
            ("label", "Nullable(String)", true),
            ("category", "LowCardinality(Nullable(String))", true),
            ("items", "Array(Nullable(UInt8))", false),
        ] {
            check(
                details
                    .columns
                    .iter()
                    .any(|column| column.name == name && column.data_type == data_type && column.nullable == nullable),
                "column type or nullability mismatch",
            )?;
        }
        check(
            details.columns.iter().any(|column| column.name == "label" && column.default.as_deref() == Some("NULL")),
            "explicit default expression missing",
        )?;
        check(details.indexes.iter().all(|index| !index.unique), "ClickHouse index reported unique")?;
        check(details.foreign_keys.is_empty() && details.triggers.is_empty(), "unsupported table objects returned")?;
        let sort = [SortKey { column: "id".into(), descending: false }];
        let first = db.table_page("clickhouse", "", &name, None, &sort, 0, 1, &cancel).await?;
        check(first.result.rows.len() == 1 && first.result.has_more, "first page limit failed")?;
        let second = db.table_page("clickhouse", "", &name, None, &sort, 1, 1, &cancel).await?;
        check(second.result.rows.len() == 1 && !second.result.has_more, "page offset failed")?;
        let ddl = db.ddl("clickhouse", "", &name).await?;
        check(ddl.contains(&name) && ddl.contains("Memory"), "temporary table DDL missing")?;
        let completion = db.completion("clickhouse").await?;
        check(completion.default_schema == "default", "completion default database mismatch")?;
        check(completion.foreign_keys.is_empty(), "completion returned unsupported foreign keys")?;
        if let Some(table) = completion.tables.first() {
            let details = db.table_details("clickhouse", &table.schema, &table.name).await?;
            check(
                table.columns.iter().all(|column| {
                    details.columns.iter().any(|field| field.name == column.name && field.data_type == column.data_type)
                }),
                "completion columns differ from catalog",
            )?;
        }
        let plan = db.explain("clickhouse", &format!("SELECT id FROM {table}"), &cancel, None).await?;
        check(!plan.is_empty(), "query plan missing")?;
        let value = r"path\O'Brien";
        let result = db
            .execute("clickhouse", &format!("SELECT {}", sql::quote_literal(DbDriver::Clickhouse, value)), 1, &cancel)
            .await?;
        check(result.rows == vec![vec![Some(value.to_owned())]], "quoted literal changed value")?;
        let edits = [DbRowEdit::Update {
            key: vec![CellValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![CellValue { column: "label".into(), value: Some("changed".into()) }],
        }];
        check(
            db.apply_edits("clickhouse", "", &name, &edits)
                .await
                .err()
                .is_some_and(|error| error.message.contains("table editing is unsupported")),
            "supplied row key authorized table editing",
        )?;
        check(db.set_manual_commit("clickhouse", true).await.is_err(), "manual transactions were accepted")?;
        for commit in [false, true] {
            check(db.finish_transaction("clickhouse", commit).await.is_err(), "transaction control was accepted")?;
        }
        Ok(())
    }
    .await;
    let cleanup = db.execute("clickhouse", &format!("DROP TEMPORARY TABLE {table}"), 0, &cancel).await;
    db.disconnect("clickhouse").await;
    checked?;
    cleanup?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable loopback ClickHouse console fixture"]
async fn clickhouse_named_console_sessions_run_concurrently_and_preserve_state() -> IdeResult<()> {
    use std::time::Duration;

    let port = std::env::var("CLICKHOUSE_CONSOLE_TEST_PORT")
        .expect("set the disposable loopback console fixture's port")
        .parse()
        .expect("numeric console fixture port");
    let password = std::env::var("CLICKHOUSE_CONSOLE_TEST_PASSWORD").expect("set the console fixture password");
    let tmp = tempfile::tempdir()?;
    let root = tmp.path().to_path_buf();
    let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    let source = DataSource {
        id: "clickhouse".into(),
        name: "ClickHouse console fixture".into(),
        driver: DbDriver::Clickhouse,
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "console_fixture".into(),
        database: "default".into(),
        ..Default::default()
    };
    let observer = DataSource { id: "observer".into(), ..source.clone() };
    db.save_sources(vec![source, observer]).await?;
    for id in ["clickhouse", "observer"] {
        db.set_password(id, Some(password.clone()), false).await?;
        db.execute(id, "SELECT 1", 1, &CancellationToken::new()).await?;
    }

    let a = ConsoleId { window: "window-a", path: "/console.sql" };
    let b = ConsoleId { window: "window-a", path: "/console_1.sql" };
    let other_window = ConsoleId { window: "window-b", path: "/console.sql" };
    let idle = CancellationToken::new();
    let run = |console, sql, cancel| db.execute_in_console("clickhouse", sql, 0, 1, cancel, None, Some(console));
    run(b, "SELECT 1", &idle).await?;
    run(a, "SET max_threads = 2", &idle).await?;
    run(a, "CREATE TEMPORARY TABLE console_state (id UInt8)", &idle).await?;
    run(a, "INSERT INTO console_state VALUES (17)", &idle).await?;

    let cancel = CancellationToken::new();
    let long_sql = "SELECT sum(sleepEachRow(1)) FROM numbers(12) SETTINGS max_block_size=1";
    let running = run(a, long_sql, &cancel);
    let other = async {
        let checked = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let observed = db
                    .execute(
                        "observer",
                        "SELECT count() FROM system.processes WHERE startsWith(query, 'SELECT sum(sleepEachRow(1))')",
                        1,
                        &idle,
                    )
                    .await?;
                if observed.rows[0][0].as_deref() == Some("1") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            run(b, "SELECT 2", &idle).await
        })
        .await;
        cancel.cancel();
        checked.map_err(|_| IdeError::invalid("console B did not complete while console A was active"))?
    };
    let (cancelled, other) = tokio::time::timeout(Duration::from_secs(17), async { tokio::join!(running, other) })
        .await
        .expect("console queries and cancellation should drain");
    assert_eq!(other?.rows, vec![vec![Some("2".into())]]);
    assert_eq!(cancelled.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);

    let first = run(a, "SELECT getSetting('max_threads'), id FROM console_state", &idle).await?;
    assert_eq!(first.rows, vec![vec![Some("2".into()), Some("17".into())]]);
    for console in [b, other_window] {
        let second = run(console, "SELECT id FROM console_state", &idle).await;
        assert!(second.is_err_and(|error| error.message.contains("UNKNOWN_TABLE")));
    }
    run(b, "CREATE TEMPORARY TABLE console_state (id UInt8)", &idle).await?;
    db.release_console(a);
    let reopened = run(a, "SELECT id FROM console_state", &idle).await;
    assert!(reopened.is_err_and(|error| error.message.contains("UNKNOWN_TABLE")));
    assert!(run(b, "SELECT id FROM console_state", &idle).await?.rows.is_empty());

    db.disconnect_source("clickhouse").await;
    let reset = run(b, "SELECT id FROM console_state", &idle).await;
    assert!(reset.is_err_and(|error| error.message.contains("UNKNOWN_TABLE")));
    Ok(())
}
