//! The active schema context against a real PostgreSQL server, skipped unless
//! `OPENIDEA_TEST_POSTGRES=host:port:user:password` names a throwaway server.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager};

fn server() -> Option<(String, u16, String, String)> {
    let v = std::env::var("OPENIDEA_TEST_POSTGRES").ok()?;
    let mut it = v.splitn(4, ':');
    Some((it.next()?.into(), it.next()?.parse().ok()?, it.next()?.into(), it.next().unwrap_or("").into()))
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
