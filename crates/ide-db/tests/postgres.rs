//! The active schema context against a real PostgreSQL server, skipped unless
//! `OPENIDEA_TEST_POSTGRES=host:port:user:password` names a throwaway server.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager};

fn server() -> Option<(String, u16, String, String)> {
    endpoint("OPENIDEA_TEST_POSTGRES")
}

fn endpoint(variable: &str) -> Option<(String, u16, String, String)> {
    let v = std::env::var(variable).ok()?;
    let mut it = v.splitn(4, ':');
    Some((it.next()?.into(), it.next()?.parse().ok()?, it.next()?.into(), it.next().unwrap_or("").into()))
}

/// A disposable PgBouncer transaction pool which rejects default_transaction_read_only at startup
/// (`OPENIDEA_TEST_PGBOUNCER`, same format). PgBouncer 1.24 rejects it; 1.26 tracks it per client,
/// which keeps the startup option in use and fails the fallback assertion below.
#[tokio::test]
async fn transaction_pooler_runs_read_only_work_on_the_assigned_backend() -> IdeResult<()> {
    let Some((host, port, user, password)) = endpoint("OPENIDEA_TEST_PGBOUNCER") else { return Ok(()) };
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.into(), root.join("passwords.json"), root.join("history.json"), ssh);
    let mut source = DataSource {
        id: "ro".into(),
        name: "Pooler".into(),
        driver: DbDriver::Postgres,
        host,
        port: Some(port),
        user,
        read_only: true,
        ..Default::default()
    };
    let normal = DataSource { id: "rw".into(), read_only: false, ..source.clone() };
    source.options.startup_script =
        "SET search_path = pg_catalog, public; SET statement_timeout = '17s'; SELECT 1".into();
    db.save_sources(vec![source.clone(), normal]).await?;
    for id in ["rw", "ro"] {
        db.set_password(id, Some(password.clone()), false).await?;
    }
    let message = db.test(&source, Some(password.clone()), None).await?;
    assert!(message.contains("PostgreSQL") && message.contains("BEGIN READ ONLY"), "{message}");
    let c = CancellationToken::new();
    let table = format!("public.oi_pooler_{}", uuid::Uuid::new_v4().simple());
    let write = format!("INSERT INTO {table} VALUES (1)");
    pooler_modes(&db, &table, &write, &c).await?;
    pooler_rotation(&db, &c).await?;
    pooler_manual(&db, &write, &c).await?;
    pooler_paging(&db, &c).await?;
    pooler_cancellation(&db, &c).await?;
    source.options.time_zone = "Europe/Paris".into();
    source.options.startup_script = "SELECT 'read;only'".into();
    let configured = ide_db::Pool::connect(&source, Some(&password), None).await?;
    assert_eq!(configured.rows("SHOW TimeZone", 1).await?, [[Some("Europe/Paris".into())]]);
    configured.close().await;
    source.options.startup_script = "SELECT 1/0; COMMIT".into();
    let error = db.test(&source, Some(password), None).await.unwrap_err();
    assert!(error.message.contains("COMMIT"), "{}", error.message);
    db.execute("rw", &format!("DROP TABLE {table}"), 1, &c).await?;
    Ok(())
}

async fn pooler_modes(db: &DbManager, table: &str, write: &str, c: &CancellationToken) -> IdeResult<()> {
    let mode = "SHOW transaction_read_only";
    assert_eq!(db.execute("ro", mode, 1, c).await?.rows, [[Some("on".into())]]);
    assert_eq!(db.execute("rw", mode, 1, c).await?.rows, [[Some("off".into())]]);
    db.execute("rw", &format!("CREATE TABLE {table} (n int)"), 1, c).await?;
    assert!(db.execute("ro", write, 1, c).await.unwrap_err().message.contains("25006"));
    assert_eq!(db.pool("ro").await?.rows(mode, 1).await?, [[Some("on".into())]]);
    Ok(())
}

async fn pooler_rotation(db: &DbManager, c: &CancellationToken) -> IdeResult<()> {
    let status = "SELECT pg_backend_pid(), current_setting('transaction_read_only'), current_setting('search_path'), current_setting('statement_timeout')";
    let pool = db.pool("ro").await?;
    let mut client = ide_db::Held::acquire(&pool).await?;
    let first_pid = client.execute(&pool, status, 1, c).await?.rows[0][0].clone();
    let writable = db.pool("rw").await?;
    let mut blockers = Vec::new();
    let mut previous_backend = loop {
        let mut other = ide_db::Held::acquire(&writable).await?;
        other.command("BEGIN").await?;
        let pid = other.execute(&writable, status, 1, c).await?.rows[0][0].clone();
        if pid == first_pid {
            break other;
        }
        blockers.push(other);
        assert!(blockers.len() < 4, "the fixture must offer the original backend");
    };
    for mut other in blockers {
        other.command("ROLLBACK").await?;
    }
    let rerouted = client.execute(&pool, status, 1, c).await?;
    assert_ne!(rerouted.rows[0][0], first_pid);
    assert_eq!(rerouted.rows[0][1..], [Some("on".into()), Some("pg_catalog, public".into()), Some("17s".into())]);
    let ordinary = previous_backend.execute(&writable, status, 1, c).await?;
    assert_ne!(ordinary.rows[0][2].as_deref(), Some("pg_catalog, public"));
    assert_ne!(ordinary.rows[0][3].as_deref(), Some("17s"));
    previous_backend.command("ROLLBACK").await?;
    drop(client);
    Ok(())
}

async fn pooler_manual(db: &DbManager, write: &str, c: &CancellationToken) -> IdeResult<()> {
    let mode = "SHOW transaction_read_only";
    db.set_manual_commit("ro", true).await?;
    for commit in [true, false] {
        assert_eq!(db.execute("ro", mode, 1, c).await?.rows, [[Some("on".into())]]);
        db.finish_transaction("ro", commit).await?;
    }
    db.execute("ro", write, 1, c).await.unwrap_err();
    assert_eq!(db.execute("ro", mode, 1, c).await?.rows, [[Some("on".into())]]);
    let timestamp = "SELECT transaction_timestamp()";
    for batch in [false, true] {
        let before = db.execute("ro", timestamp, 1, c).await?.rows;
        let error = if batch {
            let script = ide_db::split::split("SELECT 1/0; COMMIT", DbDriver::Postgres);
            db.validate_script("ro", &script).await.unwrap_err()
        } else {
            db.execute("ro", "COMMIT", 1, c).await.unwrap_err()
        };
        assert!(error.message.contains("COMMIT"), "{}", error.message);
        assert_ne!(db.execute("ro", timestamp, 1, c).await?.rows, before);
    }
    db.set_manual_commit("ro", false).await?;
    Ok(())
}

async fn pooler_paging(db: &DbManager, c: &CancellationToken) -> IdeResult<()> {
    let query = "SELECT current_setting('transaction_read_only'), pg_backend_pid(), transaction_timestamp(), n FROM generate_series(1, 12) n";
    let first = db.execute_from("ro", query, 0, 2, c, None).await?;
    let page = db.execute_from("ro", query, 2, 2, c, None).await?;
    let next = db.execute_from("ro", query, 4, 2, c, None).await?;
    assert_eq!(page.rows[0][0].as_deref(), Some("on"));
    assert_eq!(page.rows[0][..3], first.rows[0][..3]);
    assert_eq!(next.rows[0][..3], page.rows[0][..3]);
    assert_eq!(next.rows[0][3].as_deref(), Some("5"));
    db.release_result("ro", query, None);
    let expired = db.execute_from("ro", query, 6, 2, c, None).await.unwrap_err();
    assert!(expired.message.contains("Run the query again"), "{}", expired.message);
    let chosen = db.execute_from("ro", "SELECT current_schema()", 0, 1, c, Some("public")).await?;
    assert_eq!(chosen.rows, [[Some("public".into())]]);
    assert_eq!(db.execute("ro", "SELECT current_schema()", 1, c).await?.rows, [[Some("pg_catalog".into())]]);

    Ok(())
}

async fn pooler_cancellation(db: &DbManager, c: &CancellationToken) -> IdeResult<()> {
    let writable = db.pool("rw").await?;
    let mode = "SHOW transaction_read_only";
    let stop = CancellationToken::new();
    let slow = "SELECT pg_sleep(10) AS oi_pooler_cancel";
    let (outcome, observed) = tokio::join!(db.execute("ro", slow, 1, &stop), async {
        for _ in 0..40 {
            let live = writable.rows("SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(10) AS oi_pooler_cancel'", 1).await.unwrap();
            if live[0][0].as_deref() == Some("1") {
                stop.cancel();
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        stop.cancel();
        false
    });
    assert!(observed, "the slow statement reached PostgreSQL before cancellation");
    assert_eq!(outcome.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
    assert_eq!(db.execute("ro", mode, 1, c).await?.rows, [[Some("on".into())]]);
    let active = writable.rows("SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle' AND query = 'SELECT pg_sleep(10) AS oi_pooler_cancel'", 1).await?;
    assert_eq!(active, [[Some("0".into())]]);
    Ok(())
}

async fn manager(tmp: &tempfile::TempDir) -> Option<DbManager> {
    let (host, port, user, password) = server()?;
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: "p".into(),
        name: "postgres".into(),
        driver: DbDriver::Postgres,
        host,
        port: Some(port),
        user,
        ..Default::default()
    }])
    .await
    .unwrap();
    db.set_password("p", Some(password), false).await.unwrap();
    Some(db)
}

async fn create_schemas(db: &DbManager) {
    let c = CancellationToken::new();
    for (schema, tag) in [("oi_a", "from a"), ("oi_b", "from b")] {
        for stmt in [
            format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
            format!("CREATE SCHEMA \"{schema}\""),
            format!("CREATE TABLE \"{schema}\".items (id INT PRIMARY KEY, tag TEXT)"),
            format!("INSERT INTO \"{schema}\".items VALUES (1, '{tag}')"),
        ] {
            db.execute("p", &stmt, 10, &c).await.unwrap();
        }
    }
}

#[tokio::test]
async fn postgres_read_only_is_checked_before_and_after_startup_sql() -> IdeResult<()> {
    use ide_db::{DbProperty, Pool};
    let Some((host, port, user, password)) = server() else { return Ok(()) };
    let mut source =
        DataSource { driver: DbDriver::Postgres, host, port: Some(port), user, read_only: true, ..Default::default() };
    let pool = Pool::connect(&source, Some(&password), None).await?;
    assert_eq!(pool.rows("SHOW transaction_read_only", 1).await?, [[Some("on".into())]]);
    pool.close().await;

    // Exercise the same server response as a pooler that ignored the startup option.
    source.properties.push(DbProperty { name: "default_transaction_read_only".into(), value: "off".into() });
    source.options.startup_script = "SELECT 1/0".into();
    let err = Pool::connect(&source, Some(&password), None).await.err().expect("writable connection");
    assert!(err.message.contains("did not enable the requested default_transaction_read_only"), "{}", err.message);
    source.properties.clear();
    source.options.startup_script = "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE".into();
    let err = Pool::connect(&source, Some(&password), None).await.err().expect("startup script disabled read-only");
    assert!(err.message.contains("did not enable the requested default_transaction_read_only"), "{}", err.message);
    source.options.startup_script = "BEGIN READ WRITE".into();
    let err = Pool::connect(&source, Some(&password), None).await.err().expect("writable startup transaction");
    assert!(err.message.contains("writable transaction"), "{}", err.message);
    source.options.startup_script = "BEGIN READ ONLY".into();
    Pool::connect(&source, Some(&password), None).await?.close().await;
    Ok(())
}

#[tokio::test]
async fn active_schema_context_drives_the_executing_connection() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    create_schemas(&db).await;
    let c = CancellationToken::new();

    // The connection default stays untouched before any console picks a schema.
    let r = db.execute("p", "SHOW search_path", 1, &c).await?;
    assert!(r.rows[0][0].as_deref().unwrap_or("").contains("public"), "{:?}", r.rows);

    // Both schemas hold `items`; the context resolves the unqualified name in its own,
    // on every pooled connection the autocommit statements may land on.
    for _ in 0..6 {
        for (schema, tag) in [("oi_a", "from a"), ("oi_b", "from b")] {
            let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some(schema)).await?;
            assert_eq!(r.rows, vec![vec![Some(tag.into())]], "of {schema}");
            let r = db.execute_from("p", "SHOW search_path", 0, 1, &c, Some("")).await?;
            assert_eq!(r.rows, vec![vec![Some("\"$user\", public".into())]]);
            assert_eq!(db.completion("p").await?.default_schema, "public");
        }
    }

    // A manual-commit console switches schemas on its session connection.
    db.set_manual_commit("p", true).await?;
    let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_a")).await?;
    assert_eq!(r.rows, vec![vec![Some("from a".into())]]);
    let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_b")).await?;
    assert_eq!(r.rows, vec![vec![Some("from b".into())]]);
    db.finish_transaction("p", true).await?;
    for commit in [false, true] {
        db.execute_from("p", "SELECT 1", 0, 1, &c, Some("oi_a")).await?;
        db.finish_transaction("p", commit).await?;
        let r = db.execute("p", "SHOW search_path", 1, &c).await?;
        assert_eq!(r.rows, vec![vec![Some("\"$user\", public".into())]]);
    }
    db.set_manual_commit("p", false).await?;
    db.execute("p", "SET search_path TO oi_b", 1, &c).await?;
    let r = db.execute("p", "SHOW search_path", 1, &c).await?;
    assert_eq!(r.rows, vec![vec![Some("\"$user\", public".into())]]);

    // An unknown schema never resolves the statement's tables (`SET search_path`
    // itself does not validate names; resolution against it does).
    let error = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_missing")).await.unwrap_err();
    assert!(error.message.to_lowercase().contains("does not exist"), "{}", error.message);
    Ok(())
}

#[tokio::test]
async fn a_reused_physical_connection_restores_the_full_default_path() -> IdeResult<()> {
    use ide_db::{DbOptions, Held, Pool};
    let Some((host, port, user, password)) = server() else { return Ok(()) };
    let source = DataSource {
        driver: DbDriver::Postgres,
        host,
        port: Some(port),
        user,
        options: DbOptions { default_schema: "public, pg_catalog".into(), ..Default::default() },
        ..Default::default()
    };
    let pool = Pool::connect(&source, Some(&password), None).await?;
    let c = CancellationToken::new();
    // Occupy the other three slots: every operation below must reuse the fourth.
    let _other = [Held::acquire(&pool).await?, Held::acquire(&pool).await?, Held::acquire(&pool).await?];
    let mut conn = Held::acquire(&pool).await?;
    let backend = conn.execute(&pool, "SELECT pg_backend_pid()", 1, &c).await?.rows;
    for schema in ["pg_catalog", "public", "pg_catalog"] {
        conn.apply_context(Some(schema)).await?;
        let r = conn.execute(&pool, "SELECT current_schema()", 1, &c).await?;
        assert_eq!(r.rows, vec![vec![Some(schema.into())]]);
    }
    conn.apply_context(Some("public")).await?;
    conn.execute(&pool, "SELECT set_config('search_path', 'pg_catalog', false)", 1, &c).await?;
    conn.apply_context(Some("public")).await?;
    assert_eq!(conn.execute(&pool, "SELECT current_schema()", 1, &c).await?.rows, vec![vec![Some("public".into())]]);
    drop(conn);
    assert_eq!(pool.rows("SHOW search_path", 1).await?, vec![vec![Some("public, pg_catalog".into())]]);
    assert_eq!(pool.execute("SELECT pg_backend_pid()", 1, &c).await?.rows, backend);
    let mut conn = Held::acquire(&pool).await?;
    conn.command("BEGIN").await?;
    conn.apply_context(Some("pg_catalog")).await?;
    conn.command("ROLLBACK").await?;
    conn.restore_default().await?;
    assert_eq!(
        conn.execute(&pool, "SHOW search_path", 1, &c).await?.rows,
        vec![vec![Some("public, pg_catalog".into())]]
    );
    Ok(())
}

/// Indexes, foreign keys, routines and completion read the catalog with queries every
/// PostgreSQL-protocol server answers, back to the 9.2 core of openGauss / GaussDB (#3637).
#[tokio::test]
async fn table_details_routines_and_completion_on_older_catalogs() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    for stmt in [
        "DROP SCHEMA IF EXISTS oi_meta CASCADE",
        "CREATE SCHEMA oi_meta",
        "CREATE TABLE oi_meta.orders (region INT, id INT, note TEXT DEFAULT 'x', PRIMARY KEY (region, id))",
        "CREATE TABLE oi_meta.lines (n INT PRIMARY KEY, o_region INT, o_id INT, \
         FOREIGN KEY (o_region, o_id) REFERENCES oi_meta.orders (region, id))",
        "CREATE INDEX lines_order ON oi_meta.lines (o_id, o_region)",
        "COMMENT ON TABLE oi_meta.orders IS 'Customer''s orders'",
        "COMMENT ON COLUMN oi_meta.orders.note IS 'Free text'",
        "CREATE FUNCTION oi_meta.twice(v INT) RETURNS INT AS 'SELECT v * 2' LANGUAGE sql",
    ] {
        db.execute("p", stmt, 10, &c).await?;
    }
    let details = db.table_details("p", "oi_meta", "lines").await?;
    let index = details.indexes.iter().find(|i| i.name == "lines_order").expect("lines_order");
    assert_eq!(index.columns, ["o_id", "o_region"]);
    assert!(!index.unique);
    assert_eq!(details.foreign_keys.len(), 1, "{:?}", details.foreign_keys);
    assert_eq!(details.foreign_keys[0].columns, ["o_region", "o_id"]);
    assert_eq!(details.foreign_keys[0].ref_columns, ["region", "id"]);
    let orders = db.table_details("p", "oi_meta", "orders").await?;
    assert_eq!(orders.comment.as_deref(), Some("Customer's orders"));
    let comments: Vec<_> = orders.columns.iter().map(|c| c.comment.as_deref()).collect();
    assert_eq!(comments, [None, None, Some("Free text")]);
    assert_eq!(details.comment, None);
    let key = orders.indexes.iter().find(|i| i.unique).expect("primary key index");
    assert_eq!(key.columns, ["region", "id"]);

    let objects = db.schema_objects("p", "oi_meta").await?;
    assert!(objects.routines.iter().any(|r| r.name == "twice"), "{:?}", objects.routines);
    let completion = db.completion("p").await?;
    assert!(completion.tables.iter().any(|t| t.schema == "oi_meta" && t.name == "orders"));
    db.execute("p", "DROP SCHEMA oi_meta CASCADE", 10, &c).await?;
    Ok(())
}

/// Opening a table pairs the columns of composite keys in order, also when a foreign key lists
/// them in another order than the key it references; its data page and DDL read the same catalog,
/// and completion tells identity columns apart in one query (#3637).
#[tokio::test]
async fn opening_a_table_reads_multi_column_keys_in_order() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    for stmt in [
        "DROP SCHEMA IF EXISTS oi_keys CASCADE",
        "CREATE SCHEMA oi_keys",
        "CREATE TABLE oi_keys.pairs (a INT, b INT, PRIMARY KEY (b, a))",
        "CREATE TABLE oi_keys.refs (id INT PRIMARY KEY, x INT, y INT, FOREIGN KEY (y, x) REFERENCES oi_keys.pairs (b, a))",
        "CREATE UNIQUE INDEX refs_yx ON oi_keys.refs (y, x)",
        "INSERT INTO oi_keys.pairs VALUES (1, 2)",
        "INSERT INTO oi_keys.refs VALUES (7, 1, 2)",
    ] {
        db.execute("p", stmt, 10, &c).await?;
    }

    let details = db.table_details("p", "oi_keys", "refs").await?;
    let indexes: Vec<_> = details.indexes.iter().map(|i| (i.name.as_str(), i.unique, i.columns.join(","))).collect();
    assert_eq!(indexes, [("refs_pkey", true, "id".into()), ("refs_yx", true, "y,x".into())]);
    let key = |k: &ide_db::ForeignKey| (k.columns.join(","), k.ref_table.clone(), k.ref_columns.join(","));
    assert_eq!(
        details.foreign_keys.iter().map(key).collect::<Vec<_>>(),
        [("y,x".into(), "pairs".into(), "b,a".into())]
    );
    let pairs = db.table_details("p", "oi_keys", "pairs").await?;
    assert_eq!(pairs.indexes[0].columns, ["b", "a"]);

    let page = db.table_page("p", "oi_keys", "refs", None, &[], 0, 10, &c).await?;
    assert_eq!(page.result.rows.len(), 1);
    // Identity columns (PostgreSQL 10+; openGauss has none) are optional in INSERT.
    let identity =
        db.execute("p", "CREATE TABLE oi_keys.ids (n INT GENERATED ALWAYS AS IDENTITY, v INT)", 10, &c).await;
    let completion = db.completion("p").await?;
    if identity.is_ok() {
        let ids = completion.tables.iter().find(|t| t.schema == "oi_keys" && t.name == "ids").expect("ids");
        let defaults: Vec<_> = ids.columns.iter().map(|c| (c.name.as_str(), c.has_default)).collect();
        assert_eq!(defaults, [("n", true), ("v", false)]);
    }
    assert!(
        completion.foreign_keys.iter().any(|k| k.table == "refs" && key(k).2 == "b,a"),
        "{:?}",
        completion.foreign_keys
    );
    // The other catalog reads of the tree and its DDL actions, on the same server.
    assert!(db.schemas("p").await?.iter().any(|s| s == "oi_keys"));
    assert_eq!(db.tables("p", "oi_keys").await?.len(), if identity.is_ok() { 3 } else { 2 });
    db.execute("p", "CREATE SEQUENCE oi_keys.seq", 10, &c).await?;
    let objects = db.schema_objects("p", "oi_keys").await?;
    assert_eq!(objects.sequences.len(), 1);
    assert!(db.ddl("p", "oi_keys", "refs").await?.contains("FOREIGN KEY"));
    db.execute("p", "DROP SCHEMA oi_keys CASCADE", 10, &c).await?;
    Ok(())
}

/// Runs `job` with the newest installed copy of its tool, the way the dialogs do.
#[tokio::test]
async fn drops_a_database_the_ide_holds_connections_to() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    db.execute("p", "DROP DATABASE IF EXISTS oi_drop_me", 0, &c).await?;
    db.execute("p", "CREATE DATABASE oi_drop_me TEMPLATE template0", 0, &c).await?;

    // What the tree and a manual-commit console leave open on the database.
    db.schemas("p:oi_drop_me").await?;
    db.set_manual_commit("p:oi_drop_me", true).await?;
    db.execute("p:oi_drop_me", "SELECT 1", 1, &c).await?;

    db.drop_database("p", "oi_drop_me", "drop database oi_drop_me").await?;
    assert!(!db.is_connected("p:oi_drop_me"));
    assert!(!db.databases("p").await?.names.iter().any(|n| n == "oi_drop_me"));

    let current = db.databases("p").await?.current;
    let refused = db.drop_database("p", &current, &format!("drop database \"{current}\"")).await;
    assert!(refused.is_err());
    Ok(())
}

#[tokio::test]
async fn creates_a_database_from_a_template_the_ide_holds_connections_to() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    db.execute("p", "DROP DATABASE IF EXISTS oi_from_template", 0, &c).await?;
    db.schemas("p:template1").await?;

    db.create_database("p", "template1", "create database oi_from_template").await?;
    assert!(!db.is_connected("p:template1"));
    assert!(db.databases("p").await?.names.iter().any(|n| n == "oi_from_template"));
    db.execute("p", "DROP DATABASE oi_from_template", 0, &c).await?;
    Ok(())
}

async fn run_tool(db: &DbManager, target: &str, job: ide_db::tools::DbToolJob) -> IdeResult<()> {
    let install = ide_db::tools::find_installs(job.tool()).into_iter().next().expect("installed");
    let mut lines = Vec::new();
    let code = db.run_tool(target, install.path.as_ref(), &job, &CancellationToken::new(), |b| lines.extend(b)).await?;
    assert_eq!(code, Some(0), "{} failed: {lines:?}", job.tool().program());
    Ok(())
}

#[tokio::test]
async fn dumps_and_restores_with_the_client_tools() -> IdeResult<()> {
    use ide_db::tools::{
        DbDumpContent, DbDumpFormat, DbDumpStatements, DbPgDumpOptions, DbPgRestoreOptions, DbPsqlOptions, DbTool,
        DbToolJob, find_installs,
    };
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let server = db.server_version("p").await? / 10000;
    let major = |t: DbTool| {
        find_installs(t).first().and_then(|i| i.version.split(' ').nth(2)?.split('.').next()?.parse::<u32>().ok())
    };
    // Other major versions write or refuse what this server needs; the dialogs warn about that instead.
    if [DbTool::PgDump, DbTool::PgRestore, DbTool::Psql].into_iter().any(|t| major(t) != Some(server)) {
        return Ok(());
    }
    create_schemas(&db).await;
    let c = CancellationToken::new();
    db.execute("p", "DROP DATABASE IF EXISTS oi_restore", 1, &c).await?;
    db.execute("p", "CREATE DATABASE oi_restore", 1, &c).await?;
    let file = |name: &str| tmp.path().join(name).to_string_lossy().into_owned();

    let dump = |format, file: String, schema: &str| DbToolJob::PgDump {
        file,
        options: DbPgDumpOptions {
            format,
            statements: DbDumpStatements::Copy,
            content: DbDumpContent::All,
            schemas: vec![schema.into()],
            tables: vec![],
            exclude_tables: vec![],
            clean: false,
            if_exists: false,
            create: false,
            no_owner: false,
            no_privileges: false,
            jobs: 1,
        },
    };
    let archive = file("a.dump");
    run_tool(&db, "p", dump(DbDumpFormat::Custom, archive.clone(), "oi_a")).await?;
    let restore = DbPgRestoreOptions {
        content: DbDumpContent::All,
        schemas: vec![],
        create: false,
        clean: false,
        if_exists: false,
        no_owner: false,
        no_privileges: false,
        single_transaction: false,
        exit_on_error: true,
        jobs: 1,
    };
    run_tool(&db, "p:oi_restore", DbToolJob::PgRestore { file: archive, options: restore }).await?;

    let script = file("b.sql");
    run_tool(&db, "p", dump(DbDumpFormat::Plain, script.clone(), "oi_b")).await?;
    let psql = DbPsqlOptions { single_transaction: true, stop_on_error: true };
    run_tool(&db, "p:oi_restore", DbToolJob::Psql { file: script, options: psql }).await?;

    let r = db.execute("p:oi_restore", "SELECT a.tag || ', ' || b.tag FROM oi_a.items a, oi_b.items b", 1, &c).await?;
    assert_eq!(r.rows[0][0].as_deref(), Some("from a, from b"));
    db.disconnect("p:oi_restore").await;
    db.execute("p", "DROP DATABASE oi_restore", 1, &c).await?;
    Ok(())
}

#[tokio::test]
async fn later_pages_continue_the_result_where_the_previous_page_stopped() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    let query = "SELECT g AS id, repeat('x', 10) AS pad FROM generate_series(1, 1000) g ORDER BY g";
    // Forward, back, and jumping: every page holds its own rows whichever cursor served it.
    for page in [0, 1, 2, 3, 1, 7, 8, 9, 4, 0] {
        let r = db.execute_from("p", query, page * 100, 100, &c, None).await?;
        let ids: Vec<_> = r.rows.iter().map(|row| row[0].clone().unwrap()).collect();
        let want: Vec<_> = (page * 100 + 1..=page * 100 + 100).map(|n| n.to_string()).collect();
        assert_eq!(ids, want, "page {page}");
        assert_eq!(r.has_more, page < 9, "page {page}");
    }
    // A pool of 4 connections: cursors that were left open must not exhaust it.
    for _ in 0..8 {
        db.execute_from("p", query, 100, 100, &c, None).await?;
        db.release_result("p", query, None);
        assert_eq!(db.execute("p", "SELECT 1", 1, &c).await?.rows[0][0].as_deref(), Some("1"));
    }
    Ok(())
}

#[tokio::test]
async fn cancelling_a_later_page_stops_its_statement_on_the_server() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let marker = "oi_cursor_cancel_marker";
    let slow = format!("SELECT g, pg_sleep(0.05) AS {marker} FROM generate_series(1, 100000) g");
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        stop.cancel();
    });
    let started = std::time::Instant::now();
    let e = db.execute_from("p", &slow, 5, 10, &cancel, None).await.unwrap_err();
    assert_eq!(e.kind, ide_core::error::ErrorKind::Cancelled);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let c = CancellationToken::new();
    let active = format!(
        "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%{marker}%' \
         AND query NOT LIKE '%pg_stat_activity%'"
    );
    let mut running = 1;
    for _ in 0..20 {
        running = db.execute("p", &active, 1, &c).await?.rows[0][0].as_deref().unwrap().parse().unwrap();
        if running == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(running, 0, "the cancelled statement still runs on the server");
    Ok(())
}

// The same test executable serves as a foreground TCP forwarder for the managed-route test.
#[test]
fn postgres_tunnel_fixture() {
    use std::io::{Write, copy};
    use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
    let flag = |prefix: &str| std::env::args().find_map(|s| s.strip_prefix(prefix).map(String::from));
    let Some(port) = flag("listen=") else { return };
    if let Some(file) = flag("waiting=") {
        std::fs::write(file, port.as_bytes()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port.parse::<u16>().unwrap())).unwrap();
    let log = flag("start-log=").unwrap();
    let mut file = std::fs::OpenOptions::new().append(true).create(true).open(log).unwrap();
    writeln!(file, "{port}").unwrap();
    let destination = flag("forward=").unwrap();
    for stream in listener.incoming() {
        let mut client = stream.unwrap();
        let dest = destination.clone();
        std::thread::spawn(move || {
            let mut remote = TcpStream::connect(dest).unwrap();
            let mut input = client.try_clone().unwrap();
            let mut output = remote.try_clone().unwrap();
            std::thread::spawn(move || {
                let _ = copy(&mut input, &mut output);
                let _ = output.shutdown(Shutdown::Write);
            });
            let _ = copy(&mut remote, &mut client);
            let _ = client.shutdown(Shutdown::Write);
        });
    }
}

#[tokio::test]
async fn managed_tunnel_shares_the_forwarder_and_closes_it_after_the_last_target() -> IdeResult<()> {
    let Some((host, port, user, password)) = server() else { return Ok(()) };
    let tmp = tempfile::tempdir()?;
    let root = tmp.path();
    let log = root.join("starts");
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-secrets")));
    let db = DbManager::new(root.into(), root.join("passwords.json"), root.join("history.json"), ssh)
        .with_global_sources(root.join("app"))
        .with_local_external_tunnels(true);
    let source = DataSource {
        id: "tunnel".into(),
        name: "Tunnel fixture".into(),
        driver: DbDriver::Postgres,
        host,
        port: Some(port),
        user,
        database: "postgres".into(),
        read_only: true,
        external_tunnel: Some(ide_db::DbExternalTunnel {
            executable: std::env::current_exe()?.to_string_lossy().into_owned(),
            arguments: vec![
                "--exact".into(),
                "postgres_tunnel_fixture".into(),
                "--skip".into(),
                "listen={localPort}".into(),
                "--skip".into(),
                "forward={host}:{port}".into(),
                "--skip".into(),
                format!("start-log={}", log.display()),
            ],
        }),
        ..Default::default()
    };
    db.save_sources(vec![source.clone()]).await?;
    db.set_password("tunnel", Some(password), false).await?;
    assert!(db.pool("tunnel").await.is_err());
    assert!(!log.exists());
    assert!(db.test_external_tunnel(&source, None).await?.contains("PostgreSQL"));
    assert!(db.pool("tunnel").await.is_err(), "Test must not persist launch approval");
    db.approve_external_tunnel(&source).await?;
    let (a, b) = tokio::try_join!(db.pool("tunnel"), db.pool("tunnel:postgres"))?;
    assert_eq!(std::fs::read_to_string(&log)?.lines().count(), 2, "one test helper and one pooled helper");
    assert!(db.is_connected("tunnel") && db.is_connected("tunnel:postgres"));
    drop((a, b));
    db.disconnect("tunnel").await;
    let result = db.execute("tunnel:postgres", "SELECT 1", 1, &CancellationToken::new()).await?;
    assert_eq!(result.rows, vec![vec![Some("1".to_owned())]]);
    db.disconnect_source("tunnel").await;
    let ports: Vec<u16> = std::fs::read_to_string(log)?.lines().map(|p| p.parse().unwrap()).collect();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for port in ports {
            while tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
    })
    .await
    .expect("both helpers must stop");
    Ok(())
}

#[tokio::test]
async fn external_startup_does_not_block_another_source_and_disconnect_cancels_it() -> IdeResult<()> {
    let tmp = tempfile::tempdir()?;
    let dir = tmp.path();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(dir.join("ssh-secrets")));
    let db = DbManager::new(dir.into(), dir.join("passwords.json"), dir.join("history.json"), ssh)
        .with_global_sources(dir.join("app"))
        .with_local_external_tunnels(true);
    let waiting = dir.join("starting");
    let pending = DataSource {
        id: "pending".into(),
        name: "Starting helper".into(),
        driver: DbDriver::Postgres,
        host: "db.example".into(),
        external_tunnel: Some(ide_db::DbExternalTunnel {
            executable: std::env::current_exe()?.to_string_lossy().into_owned(),
            arguments: vec![
                "--exact".into(),
                "postgres_tunnel_fixture".into(),
                "--skip".into(),
                "listen={localPort}".into(),
                "--skip".into(),
                format!("waiting={}", waiting.display()),
            ],
        }),
        ..Default::default()
    };
    let file = dir.join("local.db");
    std::fs::File::create(&file)?;
    let sqlite =
        DataSource { id: "local".into(), name: "SQLite fixture".into(), file: Some(file.into()), ..Default::default() };
    db.approve_external_tunnel(&pending).await?;
    db.save_sources(vec![pending, sqlite]).await?;
    let connect = db.pool("pending");
    let edit = async {
        while !waiting.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        db.pool("local").await?;
        assert!(db.is_connected("local"));
        db.disconnect_source("pending").await;
        Ok::<_, ide_core::IdeError>(())
    };
    let (result, edit) = tokio::time::timeout(std::time::Duration::from_secs(8), async { tokio::join!(connect, edit) })
        .await
        .expect("the pending PostgreSQL helper must not block SQLite or disconnect");
    edit?;
    assert!(matches!(result, Err(error) if error.kind == ide_core::error::ErrorKind::Cancelled));
    Ok(())
}

#[tokio::test]
async fn table_grants_expand_the_acl_per_grantee() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    for stmt in [
        "DROP SCHEMA IF EXISTS oi_grants CASCADE",
        "DROP ROLE IF EXISTS oi_grant_reader",
        "DROP ROLE IF EXISTS oi_grant_writer",
        "CREATE ROLE oi_grant_reader",
        "CREATE ROLE oi_grant_writer",
        "CREATE SCHEMA oi_grants",
        "CREATE TABLE oi_grants.shared (id INT)",
        "CREATE TABLE oi_grants.private (id INT)",
        "GRANT SELECT ON oi_grants.shared TO oi_grant_reader, PUBLIC",
        "GRANT INSERT, UPDATE ON oi_grants.shared TO oi_grant_writer WITH GRANT OPTION",
    ] {
        db.execute("p", stmt, 10, &c).await?;
    }
    let owner = db.execute("p", "SELECT current_user", 1, &c).await?.rows[0][0].clone().unwrap();
    let grants = db.table_grants("p", "oi_grants", "shared").await?;
    let of = |grantee: &str| {
        let mut v: Vec<_> = grants
            .iter()
            .filter(|g| g.grantee == grantee)
            .map(|g| (g.privilege.as_str(), g.grantable, g.grantor.as_deref() == Some(owner.as_str())))
            .collect();
        v.sort();
        v
    };
    assert_eq!(of("oi_grant_reader"), [("SELECT", false, true)], "{grants:?}");
    assert_eq!(of("PUBLIC"), [("SELECT", false, true)], "{grants:?}");
    assert_eq!(of("oi_grant_writer"), [("INSERT", true, true), ("UPDATE", true, true)], "{grants:?}");
    assert!(of(&owner).contains(&("TRUNCATE", false, true)), "{grants:?}");
    // No ACL yet: the owner's implicit privileges.
    let private = db.table_grants("p", "oi_grants", "private").await?;
    assert!(private.iter().all(|g| g.grantee == owner), "{private:?}");
    assert!(private.iter().any(|g| g.privilege == "SELECT"), "{private:?}");
    for stmt in ["DROP SCHEMA oi_grants CASCADE", "DROP ROLE oi_grant_reader", "DROP ROLE oi_grant_writer"] {
        db.execute("p", stmt, 10, &c).await?;
    }
    Ok(())
}

/// Completion reads the default schema in full: 52,000 columns there passed the cap shared with
/// the other schemas, and the tables sorting last lost theirs (#6118).
#[tokio::test]
async fn completion_reads_every_column_of_a_wide_default_schema() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp).await else { return Ok(()) };
    let c = CancellationToken::new();
    let schema = format!("oi_wide_{}", uuid::Uuid::new_v4().simple());
    let mut sources = db.sources()?;
    let mut source = sources[0].clone();
    source.id = "wide".into();
    source.options.startup_script = format!("SET search_path = {schema}");
    sources.push(source);
    let password = server().map(|(.., password)| password);
    db.save_sources(sources).await?;
    db.set_password("wide", password, false).await?;
    db.execute("p", &format!("CREATE SCHEMA {schema}"), 1, &c).await?;
    let fill = format!(
        "DO $$ DECLARE cols text; BEGIN \
         SELECT string_agg('c' || g || ' int', ', ') INTO cols FROM generate_series(1, 200) g; \
         FOR i IN 1..260 LOOP EXECUTE format('CREATE TABLE {schema}.t%s (%s)', lpad(i::text, 3, '0'), cols); \
         END LOOP; END $$"
    );
    let result = async {
        db.execute("p", &fill, 1, &c).await?;
        let completion = db.completion("wide").await?;
        assert_eq!(completion.default_schema, schema);
        let wide: Vec<_> = completion.tables.iter().filter(|t| t.schema == schema).collect();
        assert_eq!(wide.len(), 260);
        assert!(wide.iter().all(|t| t.columns.len() == 200), "a table lost columns");
        Ok(())
    }
    .await;
    db.execute("p", &format!("DROP SCHEMA {schema} CASCADE"), 1, &c).await?;
    result
}
