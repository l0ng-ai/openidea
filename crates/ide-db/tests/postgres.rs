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
