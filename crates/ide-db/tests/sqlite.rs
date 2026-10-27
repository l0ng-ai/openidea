//! Introspection, queries and table edits against a real SQLite file.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{CellValue, DataSource, DbDriver, DbManager, DbOptions, DbProperty, DbRowEdit, DbTableKind, SortKey};

async fn setup() -> (tempfile::TempDir, DbManager) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    std::fs::File::create(root.join("app.db")).unwrap();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: "s1".into(),
        name: "app".into(),
        driver: DbDriver::Sqlite,
        file: Some("app.db".into()),
        ..Default::default()
    }])
    .await
    .unwrap();
    let c = CancellationToken::new();
    for stmt in [
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, avatar BLOB)",
        "CREATE UNIQUE INDEX users_name ON users (name)",
        "CREATE VIEW named AS SELECT name FROM users",
        "INSERT INTO users (name, note, avatar) VALUES ('ann', NULL, x'CAFE'), ('bob', 'hi', NULL), ('cy', 'x', NULL)",
    ] {
        db.execute("s1", stmt, 100, &c).await.unwrap();
    }
    (tmp, db)
}

#[tokio::test]
async fn introspects_schemas_tables_columns_and_indexes() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    assert_eq!(db.schemas("s1").await?, vec!["main"]);
    let tables = db.tables("s1", "main").await?;
    let names: Vec<_> = tables.iter().map(|t| (t.name.as_str(), t.kind)).collect();
    assert_eq!(names, vec![("named", DbTableKind::View), ("users", DbTableKind::Table)]);
    let d = db.table_details("s1", "main", "users").await?;
    let cols: Vec<_> = d.columns.iter().map(|c| (c.name.as_str(), c.primary_key, c.nullable)).collect();
    assert_eq!(cols, vec![("id", true, true), ("name", false, false), ("note", false, true), ("avatar", false, true)]);
    assert_eq!(d.indexes.len(), 1);
    assert_eq!(d.indexes[0].name, "users_name");
    assert!(d.indexes[0].unique);
    assert_eq!(d.indexes[0].columns, vec!["name"]);
    let completion = db.completion("s1").await?;
    assert_eq!(completion.default_schema, "main");
    let users = completion.tables.iter().find(|t| t.name == "users").unwrap();
    let cols: Vec<_> = users.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str(), c.primary_key)).collect();
    assert_eq!(
        cols,
        vec![("id", "INTEGER", true), ("name", "TEXT", false), ("note", "TEXT", false), ("avatar", "BLOB", false)]
    );
    assert!(!users.columns[1].nullable);
    // `INTEGER PRIMARY KEY` is the rowid: SQLite assigns it.
    let defaults: Vec<_> = users.columns.iter().map(|c| c.has_default).collect();
    assert_eq!(defaults, vec![true, false, false, false]);
    let named = completion.tables.iter().find(|t| t.name == "named").unwrap();
    assert_eq!(named.kind, DbTableKind::View);
    Ok(())
}

#[tokio::test]
async fn completion_model_has_foreign_keys() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    for stmt in [
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), status TEXT DEFAULT 'new')",
        // Implicit reference to the primary key; composite key.
        "CREATE TABLE notes (user_id INTEGER REFERENCES users, a INT, b INT, \
         FOREIGN KEY (a, b) REFERENCES pairs (x, y))",
        "CREATE TABLE pairs (x INT, y INT, PRIMARY KEY (x, y))",
    ] {
        db.execute("s1", stmt, 1, &c).await?;
    }
    let m = db.completion("s1").await?;
    let orders = m.tables.iter().find(|t| t.name == "orders").unwrap();
    let defaults: Vec<_> = orders.columns.iter().map(|c| (c.name.as_str(), c.has_default)).collect();
    assert_eq!(defaults, vec![("id", true), ("user_id", false), ("status", true)]);
    let pairs = m.tables.iter().find(|t| t.name == "pairs").unwrap();
    assert!(pairs.columns.iter().all(|c| !c.has_default));
    let keys: Vec<_> = m
        .foreign_keys
        .iter()
        .map(|k| (k.table.as_str(), k.columns.join(","), k.ref_table.as_str(), k.ref_columns.join(",")))
        .collect();
    assert_eq!(
        keys,
        vec![
            ("notes", "a,b".into(), "pairs", "x,y".into()),
            ("notes", "user_id".into(), "users", "id".into()),
            ("orders", "user_id".into(), "users", "id".into()),
        ]
    );
    let d = db.table_details("s1", "main", "notes").await?;
    let keys: Vec<_> =
        d.foreign_keys.iter().map(|k| (k.columns.join(","), k.ref_table.as_str(), k.ref_columns.join(","))).collect();
    assert_eq!(keys, vec![("a,b".into(), "pairs", "x,y".into()), ("user_id".into(), "users", "id".into())]);
    Ok(())
}

#[tokio::test]
async fn queries_with_limits_nulls_and_blobs() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    let r = db.execute("s1", "SELECT id, name, note, avatar FROM users ORDER BY id", 2, &c).await?;
    assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "name", "note", "avatar"]);
    assert_eq!(r.rows.len(), 2);
    assert!(r.has_more);
    assert_eq!(r.rows[0], vec![Some("1".into()), Some("ann".into()), None, Some("0xCAFE".into())]);
    assert_eq!(r.affected, None);

    let empty = db.execute("s1", "SELECT name FROM users WHERE id < 0", 10, &c).await?;
    assert!(empty.rows.is_empty());
    assert_eq!(empty.columns.len(), 1, "columns of an empty result come from the prepared statement");

    let upd = db.execute("s1", "UPDATE users SET note = 'n' WHERE id > 1", 10, &c).await?;
    assert_eq!(upd.affected, Some(2.0));

    let err = db.execute("s1", "SELECT nope FROM users", 10, &c).await.unwrap_err();
    assert!(err.message.contains("nope"), "{}", err.message);
    Ok(())
}

#[tokio::test]
async fn pages_sorts_filters_and_edits_in_a_transaction() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    let sort = [SortKey { column: "name".into(), descending: true }];
    let page = db.table_page("s1", "main", "users", Some("id > 0"), &sort, 0, 2, &c).await?;
    assert_eq!(page.result.rows.len(), 2);
    assert!(page.result.has_more);
    assert_eq!(page.result.rows[0][1].as_deref(), Some("cy"));
    let last = db.table_page("s1", "main", "users", None, &sort, 2, 2, &c).await?;
    assert_eq!(last.result.rows.len(), 1);
    assert!(!last.result.has_more);

    let key = |id: &str| vec![CellValue { column: "id".into(), value: Some(id.into()) }];
    let n = db
        .apply_edits(
            "s1",
            "main",
            "users",
            &[
                DbRowEdit::Update {
                    key: key("1"),
                    values: vec![CellValue { column: "note".into(), value: Some("it's".into()) }],
                },
                DbRowEdit::Delete { key: key("2") },
                DbRowEdit::Insert { values: vec![CellValue { column: "name".into(), value: Some("dee".into()) }] },
            ],
        )
        .await?;
    assert_eq!(n, 3);
    let r = db.execute("s1", "SELECT name, note FROM users ORDER BY id", 10, &c).await?;
    let rows: Vec<_> = r.rows.iter().map(|r| (r[0].clone().unwrap(), r[1].clone())).collect();
    assert_eq!(rows, vec![("ann".into(), Some("it's".into())), ("cy".into(), Some("x".into())), ("dee".into(), None)]);

    // A failing edit rolls back the whole batch.
    let err = db
        .apply_edits(
            "s1",
            "main",
            "users",
            &[
                DbRowEdit::Delete { key: key("1") },
                DbRowEdit::Insert { values: vec![CellValue { column: "name".into(), value: Some("cy".into()) }] },
            ],
        )
        .await;
    assert!(err.is_err());
    let count = db.execute("s1", "SELECT count(*) FROM users", 10, &c).await?;
    assert_eq!(count.rows[0][0].as_deref(), Some("3"));
    Ok(())
}

#[tokio::test]
async fn test_connection_and_disconnect() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let source = db.source("s1")?;
    assert!(db.test(&source, None, None).await?.starts_with("SQLite "));
    assert!(db.is_connected("s1"));
    db.disconnect("s1").await;
    assert!(!db.is_connected("s1"));
    let missing = DataSource { file: Some("missing/nope.db".into()), ..source };
    assert!(db.test(&missing, None, None).await.is_err());
    Ok(())
}

async fn count(db: &DbManager) -> String {
    let r = db.execute("s1", "SELECT count(*) FROM users", 1, &CancellationToken::new()).await.unwrap();
    r.rows[0][0].clone().unwrap()
}

#[tokio::test]
async fn manual_commit_keeps_a_transaction_until_commit_or_rollback() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    db.set_manual_commit("s1", true).await;
    db.execute("s1", "INSERT INTO users (name) VALUES ('dee')", 1, &c).await?;
    // The session sees its own change.
    assert_eq!(count(&db).await, "4");
    db.finish_transaction("s1", false).await?;
    assert_eq!(count(&db).await, "3");

    db.execute("s1", "INSERT INTO users (name) VALUES ('eve')", 1, &c).await?;
    db.finish_transaction("s1", true).await?;
    // Leaving manual mode rolls back what is still open.
    db.execute("s1", "DELETE FROM users", 1, &c).await?;
    db.set_manual_commit("s1", false).await;
    assert_eq!(count(&db).await, "4");
    // Disconnecting with an open transaction does not hang.
    db.set_manual_commit("s1", true).await;
    db.execute("s1", "DELETE FROM users", 1, &c).await?;
    db.disconnect("s1").await;
    assert_eq!(count(&db).await, "4");
    Ok(())
}

#[tokio::test]
async fn targets_name_a_database_of_a_data_source() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    assert_eq!(ide_db::split_target("s1"), ("s1", None));
    assert_eq!(ide_db::split_target("s1:app_dev"), ("s1", Some("app_dev")));
    assert_eq!(ide_db::split_target("s1:a:b"), ("s1", Some("a:b")));
    assert_eq!(ide_db::split_target("s1:"), ("s1", None));
    assert_eq!(db.source("s1:other")?.database, "other");
    assert_eq!(db.source("s1:other")?.id, "s1");
    assert!(db.source("nope:other").is_err());
    // Only PostgreSQL lists databases.
    assert!(db.databases("s1").await.is_err());
    db.disconnect_source("s1").await;
    assert!(db.connected().is_empty());
    Ok(())
}

#[tokio::test]
async fn ddl_of_tables_and_views() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    assert_eq!(
        db.ddl("s1", "main", "users").await?,
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, avatar BLOB);\n\n\
         CREATE UNIQUE INDEX users_name ON users (name);\n"
    );
    assert_eq!(db.ddl("s1", "main", "named").await?, "CREATE VIEW named AS SELECT name FROM users;\n");
    assert!(db.ddl("s1", "main", "nope").await.is_err());
    Ok(())
}

#[tokio::test]
async fn explains_queries_without_running_them() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    let plan = db.explain("s1", "SELECT * FROM users WHERE id > 1 ORDER BY note;", &c).await?;
    let ops: Vec<_> = plan.iter().map(|n| n.operation.as_str()).collect();
    assert_eq!(ops, vec!["Index Scan", "Order By"]);
    assert!(plan[0].params.starts_with("table: users;"), "{}", plan[0].params);
    db.explain("s1", "DELETE FROM users", &c).await?;
    assert_eq!(count(&db).await, "3");
    Ok(())
}

#[tokio::test]
async fn records_executed_statements_in_the_query_history() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    db.execute("s1", "SELECT 1", 1, &c).await?;
    assert!(db.execute("s1", "SELECT nope", 1, &c).await.is_err());
    // Recorded off the async threads.
    let mut texts = Vec::new();
    for _ in 0..50 {
        texts = db.history("s1").await?.into_iter().map(|e| e.text).collect::<Vec<_>>();
        if texts.first().map(String::as_str) == Some("SELECT nope") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(texts[..2], ["SELECT nope", "SELECT 1"]);
    db.remove_history("s1", Some(vec!["SELECT 1".into()])).await?;
    assert!(!db.history("s1").await?.iter().any(|e| e.text == "SELECT 1"));
    db.remove_history("s1", None).await?;
    assert!(db.history("s1").await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn lists_triggers_and_their_ddl() -> IdeResult<()> {
    let (_tmp, db) = setup().await;
    let c = CancellationToken::new();
    db.execute("s1", "CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN SELECT 1; END", 1, &c).await?;
    let d = db.table_details("s1", "main", "users").await?;
    let triggers: Vec<_> = d.triggers.iter().map(|t| (t.name.as_str(), t.timing.as_str(), t.events.as_str())).collect();
    assert_eq!(triggers, vec![("users_touch", "after", "update")]);
    let ddl = db.object_ddl("s1", "main", ide_db::DbObjectKind::Trigger, "users_touch").await?;
    assert!(ddl.starts_with("CREATE TRIGGER users_touch"), "{ddl}");
    // SQLite has neither routines nor sequences.
    assert_eq!(db.schema_objects("s1", "main").await?, ide_db::SchemaObjects::default());
    Ok(())
}

#[tokio::test]
async fn applies_driver_properties_and_the_startup_script_on_connect() -> IdeResult<()> {
    let (tmp, db) = setup().await;
    let mut s = db.sources()?.remove(0);
    s.properties = vec![DbProperty { name: "cache_size".into(), value: "-1234".into() }];
    s.options = DbOptions {
        startup_script: "CREATE TEMP TABLE boot (x); INSERT INTO boot VALUES (7);".into(),
        ..Default::default()
    };
    db.save_sources(vec![s.clone()]).await?;
    let c = CancellationToken::new();
    let r = db.execute("s1", "SELECT (SELECT x FROM boot), (SELECT cache_size FROM pragma_cache_size)", 10, &c).await?;
    assert_eq!(r.rows, vec![vec![Some("7".into()), Some("-1234".into())]]);
    // URL only: the file comes from the URL.
    let url = format!("jdbc:sqlite:{}", tmp.path().join("app.db").display());
    db.save_sources(vec![DataSource { url_only: true, url, file: None, ..s }]).await?;
    assert_eq!(db.schemas("s1").await?, vec!["main"]);
    Ok(())
}
