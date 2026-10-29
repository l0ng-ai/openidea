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
