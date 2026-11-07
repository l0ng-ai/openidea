//! Introspection against a real MySQL / MariaDB server, skipped unless
//! `OPENIDEA_TEST_MYSQL=host:port:user:password` names a throwaway server.

use ide_core::{CancellationToken, IdeResult};
use ide_db::{DataSource, DbDriver, DbManager, DbOptions};

const SCHEMAS: [&str; 2] = ["oi_bin_meta", "oi_数据"];

fn server() -> Option<(String, u16, String, String)> {
    let v = std::env::var("OPENIDEA_TEST_MYSQL").ok()?;
    let mut it = v.splitn(4, ':');
    Some((it.next()?.into(), it.next()?.parse().ok()?, it.next()?.into(), it.next().unwrap_or("").into()))
}

async fn manager(tmp: &tempfile::TempDir, startup_script: &str) -> Option<DbManager> {
    let (host, port, user, password) = server()?;
    let root = tmp.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: "m".into(),
        name: "mysql".into(),
        driver: DbDriver::Mysql,
        host,
        port: Some(port),
        user,
        options: DbOptions { startup_script: startup_script.into(), ..Default::default() },
        ..Default::default()
    }])
    .await
    .unwrap();
    db.set_password("m", Some(password), false).await.unwrap();
    Some(db)
}

async fn create_schemas(db: &DbManager) {
    let c = CancellationToken::new();
    for s in SCHEMAS {
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{s}`"),
            format!("CREATE DATABASE `{s}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
            format!(
                "CREATE TABLE `{s}`.`用户` (id INT PRIMARY KEY, name VARCHAR(20) COLLATE utf8mb4_bin, raw VARBINARY(4))"
            ),
            format!("CREATE INDEX `名字` ON `{s}`.`用户` (name)"),
            format!("INSERT INTO `{s}`.`用户` VALUES (1, 'ann', 0xCAFE)"),
        ] {
            db.execute("m", &stmt, 10, &c).await.unwrap();
        }
    }
}

async fn assert_metadata_is_text(db: &DbManager) -> IdeResult<()> {
    let schemas = db.schemas("m").await?;
    for s in SCHEMAS {
        assert!(schemas.iter().any(|n| n == s), "{s} missing from {schemas:?}");
        let tables = db.tables("m", s).await?;
        assert_eq!(tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["用户"], "tables of {s}");
        let d = db.table_details("m", s, "用户").await?;
        let cols: Vec<_> = d.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, ["id", "name", "raw"]);
        assert!(d.indexes.iter().any(|i| i.name == "名字"), "{:?}", d.indexes);
        assert!(db.ddl("m", s, "用户").await?.contains("CREATE TABLE `用户`"));
    }
    let completion = db.completion("m").await?;
    let json = serde_json::to_string(&completion).unwrap();
    assert!(json.contains("oi_数据") && json.contains("用户"), "{json}");
    Ok(())
}

// One test: both phases share the schemas they create.
#[tokio::test]
async fn metadata_names_are_text_whatever_the_column_collation() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    create_schemas(&db).await;
    // MySQL 8 sends `utf8mb3_bin` catalog names flagged BINARY (lower_case_table_names = 0).
    assert_metadata_is_text(&db).await?;
    // `_bin` text is text in the grid; true binary stays hex.
    let r = db.execute("m", "SELECT name, raw FROM `oi_数据`.`用户`", 10, &CancellationToken::new()).await?;
    assert_eq!(r.rows, vec![vec![Some("ann".to_owned()), Some("0xCAFE".to_owned())]]);

    // Every text column arrives with the `binary` collation.
    let tmp = tempfile::tempdir().unwrap();
    let raw = manager(&tmp, "SET character_set_results = binary").await.unwrap();
    assert_metadata_is_text(&raw).await
}

// A console's active schema: the connection that runs each autocommit statement
// is put in it first, so unqualified names resolve there (and not elsewhere).
// Its own schema names: tests of this file share one server but run in parallel.
#[tokio::test]
async fn active_schema_context_drives_the_executing_connection() -> IdeResult<()> {
    const A: &str = "oi_ctx_meta";
    const B: &str = "oi_ctx_data";
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    let c = CancellationToken::new();
    for s in [A, B] {
        for stmt in [
            format!("DROP DATABASE IF EXISTS `{s}`"),
            format!("CREATE DATABASE `{s}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
            format!("CREATE TABLE `{s}`.`用户` (id INT PRIMARY KEY, name VARCHAR(20))"),
            format!("INSERT INTO `{s}`.`用户` VALUES (1, '{s}')"),
        ] {
            db.execute("m", &stmt, 10, &c).await.unwrap();
        }
    }

    // The source connects with no default database; the console's pick decides.
    let r = db.execute_from("m", "SELECT DATABASE()", 0, 1, &c, Some(A)).await?;
    assert_eq!(r.rows, vec![vec![Some(A.into())]]);
    // Both schemas hold `用户`; the context resolves the unqualified name in its own,
    // on every pooled connection the autocommit statements may land on.
    for _ in 0..6 {
        for (schema, name) in [(A, A), (B, B)] {
            let r = db.execute_from("m", "SELECT name FROM 用户", 0, 1, &c, Some(schema)).await?;
            assert_eq!(r.rows, vec![vec![Some(name.into())]], "of {schema}");
            let r = db.execute_from("m", "SELECT DATABASE()", 0, 1, &c, Some("")).await?;
            assert_eq!(r.rows, vec![vec![None]]);
            assert_eq!(db.completion("m").await?.default_schema, "");
        }
    }
    // A statement without a selection returns to the source's absent default.
    let r = db.execute_from("m", "SELECT DATABASE()", 0, 1, &c, None).await?;
    assert_eq!(r.rows, vec![vec![None]]);

    // A manual-commit console switches schemas on its session connection.
    db.set_manual_commit("m", true).await?;
    // Starting a no-database manual session must keep its transaction open.
    db.execute("m", &format!("INSERT INTO `{A}`.`用户` VALUES (2, 'rollback')"), 1, &c).await?;
    db.finish_transaction("m", false).await?;
    assert!(db.execute("m", &format!("SELECT name FROM `{A}`.`用户` WHERE id = 2"), 1, &c).await?.rows.is_empty());
    let r = db.execute_from("m", "SELECT name FROM 用户", 0, 1, &c, Some(A)).await?;
    assert_eq!(r.rows, vec![vec![Some(A.into())]]);
    let r = db.execute_from("m", "SELECT DATABASE()", 0, 1, &c, Some(B)).await?;
    assert_eq!(r.rows, vec![vec![Some(B.into())]]);
    assert!(db.execute("m", "SELECT DATABASE()", 1, &c).await.is_err());
    // The rejected clear keeps the transaction and selection intact.
    assert_eq!(db.execute_from("m", "SELECT DATABASE()", 0, 1, &c, Some(B)).await?.rows, vec![vec![Some(B.into())]]);
    db.finish_transaction("m", true).await?;
    for commit in [false, true] {
        db.execute_from("m", "SELECT 1", 0, 1, &c, Some(A)).await?;
        db.finish_transaction("m", commit).await?;
        let r = db.execute("m", "SELECT DATABASE()", 1, &c).await?;
        assert_eq!(r.rows, vec![vec![None]]);
    }
    db.execute_from("m", "SELECT 1", 0, 1, &c, Some(A)).await?;
    db.set_manual_commit("m", false).await?;
    db.execute("m", &format!("USE `{B}`"), 1, &c).await?;
    let r = db.execute("m", "SELECT DATABASE()", 1, &c).await?;
    assert_eq!(r.rows, vec![vec![None]]);

    // An unknown schema fails the statement instead of running it somewhere else.
    let error = db.execute_from("m", "SELECT 1", 0, 1, &c, Some("oi_missing")).await.unwrap_err();
    assert!(error.message.contains("oi_missing"), "{}", error.message);
    Ok(())
}

#[tokio::test]
async fn a_reused_physical_connection_restores_the_configured_database() -> IdeResult<()> {
    use ide_db::{Held, Pool};
    let Some((host, port, user, password)) = server() else { return Ok(()) };
    let source = DataSource {
        driver: DbDriver::Mysql,
        host,
        port: Some(port),
        user,
        database: "mysql".into(),
        ..Default::default()
    };
    let pool = Pool::connect(&source, Some(&password), None).await?;
    let c = CancellationToken::new();
    let _other = [Held::acquire(&pool).await?, Held::acquire(&pool).await?, Held::acquire(&pool).await?];
    let mut conn = Held::acquire(&pool).await?;
    let backend = conn.execute(&pool, "SELECT CONNECTION_ID()", 1, &c).await?.rows;
    for schema in ["information_schema", "mysql", "information_schema"] {
        conn.apply_context(Some(schema)).await?;
        assert_eq!(conn.execute(&pool, "SELECT DATABASE()", 1, &c).await?.rows, vec![vec![Some(schema.into())]]);
    }
    drop(conn);
    assert_eq!(pool.rows("SELECT DATABASE()", 1).await?, vec![vec![Some("mysql".into())]]);
    assert_eq!(pool.execute("SELECT CONNECTION_ID()", 1, &c).await?.rows, backend);
    Ok(())
}
