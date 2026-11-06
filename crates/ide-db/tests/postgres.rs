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
    for (schema, tag) in [("oi_a", "from a"), ("oi_b", "from b")] {
        for _ in 0..6 {
            let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some(schema)).await?;
            assert_eq!(r.rows, vec![vec![Some(tag.into())]], "of {schema}");
        }
    }

    // A manual-commit console switches schemas on its session connection.
    db.set_manual_commit("p", true).await?;
    let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_a")).await?;
    assert_eq!(r.rows, vec![vec![Some("from a".into())]]);
    let r = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_b")).await?;
    assert_eq!(r.rows, vec![vec![Some("from b".into())]]);
    db.finish_transaction("p", true).await?;
    db.set_manual_commit("p", false).await?;

    // An unknown schema never resolves the statement's tables (`SET search_path`
    // itself does not validate names; resolution against it does).
    let error = db.execute_from("p", "SELECT tag FROM items", 0, 1, &c, Some("oi_missing")).await.unwrap_err();
    assert!(error.message.to_lowercase().contains("does not exist"), "{}", error.message);
    Ok(())
}
