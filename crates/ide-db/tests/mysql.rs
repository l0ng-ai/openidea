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
                "CREATE TABLE `{s}`.`用户` (id INT PRIMARY KEY, name VARCHAR(20) COLLATE utf8mb4_bin COMMENT '名字', \
                 raw VARBINARY(4)) COMMENT = '用户表'"
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
        assert_eq!(d.comment.as_deref(), Some("用户表"));
        let comments: Vec<_> = d.columns.iter().map(|c| c.comment.as_deref()).collect();
        assert_eq!(comments, [None, Some("名字"), None]);
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

/// Forwards to the test server, adding `CLIENT_DEPRECATE_EOF` to the capabilities its greeting
/// advertises, like proxies that set the flag but leave a 5.x server sending legacy EOF packets.
async fn deprecate_eof_proxy(host: String, port: u16) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let mut server = tokio::net::TcpStream::connect((host.as_str(), port)).await.unwrap();
            tokio::spawn(async move {
                let mut header = [0u8; 4];
                server.read_exact(&mut header).await.unwrap();
                let len = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
                let mut greeting = vec![0u8; len];
                server.read_exact(&mut greeting).await.unwrap();
                // protocol version, NUL-terminated server version, connection id, 8 bytes of
                // auth data, filler, lower capabilities, charset, status, upper capabilities.
                let version_end = 1 + greeting[1..].iter().position(|&b| b == 0).unwrap();
                let upper = version_end + 1 + 4 + 8 + 1 + 2 + 1 + 2;
                greeting[upper + 1] |= 0x01; // bit 24 of the capability flags
                client.write_all(&header).await.unwrap();
                client.write_all(&greeting).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
            });
        }
    });
    local
}

#[tokio::test]
async fn servers_that_advertise_deprecate_eof_but_send_legacy_eof_packets() -> IdeResult<()> {
    use ide_db::Pool;
    let Some((host, port, user, password)) = server() else { return Ok(()) };
    let source = DataSource {
        driver: DbDriver::Mysql,
        host: "127.0.0.1".into(),
        port: Some(deprecate_eof_proxy(host, port).await),
        user,
        ..Default::default()
    };
    let pool = Pool::connect(&source, Some(&password), None).await?;
    assert_eq!(pool.rows("SELECT 1 + 1", 1).await?, vec![vec![Some("2".into())]]);
    let c = CancellationToken::new();
    let r = pool.execute("SELECT 'a' UNION ALL SELECT 'b'", 10, &c).await?;
    assert_eq!(r.rows, vec![vec![Some("a".into())], vec![Some("b".into())]]);
    Ok(())
}

/// `mysqldump` into a file and `mysql` reading it back, with the data source's password.
#[tokio::test]
async fn dumps_and_restores_with_the_client_tools() -> IdeResult<()> {
    use ide_db::tools::{DbMysqlOptions, DbMysqldumpOptions, DbTool, DbToolJob, find_installs};
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    let (Some(dump), Some(client)) =
        (find_installs(DbTool::Mysqldump).into_iter().next(), find_installs(DbTool::Mysql).into_iter().next())
    else {
        return Ok(());
    };
    let c = CancellationToken::new();
    for stmt in [
        "DROP DATABASE IF EXISTS oi_dump_src",
        "DROP DATABASE IF EXISTS oi_dump_dst",
        "CREATE DATABASE oi_dump_src",
        "CREATE DATABASE oi_dump_dst",
        "CREATE TABLE oi_dump_src.items (id INT PRIMARY KEY, tag VARCHAR(20))",
        "INSERT INTO oi_dump_src.items VALUES (1, 'dumped')",
    ] {
        db.execute("m", stmt, 1, &c).await?;
    }
    let file = tmp.path().join("src.sql").to_string_lossy().into_owned();
    let run = |executable: String, job: DbToolJob| {
        let db = &db;
        async move {
            let mut lines = Vec::new();
            let code =
                db.run_tool("m", executable.as_ref(), &job, &CancellationToken::new(), |b| lines.extend(b)).await?;
            assert_eq!(code, Some(0), "{} failed: {lines:?}", job.tool().program());
            IdeResult::Ok(())
        }
    };
    let masking = ide_db::tools::options_of(dump.path.as_ref())?.iter().any(|o| o == "masking-policies");
    let options = DbMysqldumpOptions {
        databases: vec!["oi_dump_src".into()],
        tables: vec![],
        add_drop_table: true,
        disable_keys: true,
        add_locks: true,
        add_drop_trigger: false,
        no_data: false,
        complete_insert: false,
        create_options: true,
        routines: false,
        events: false,
        single_transaction: true,
        lock_all_tables: false,
        masking_policies: masking.then_some(false),
    };
    run(dump.path.clone(), DbToolJob::Mysqldump { file: file.clone(), options: options.clone() }).await?;
    assert!(!ide_db::tools::dump_info(file.as_ref())?.creates_database, "one database: restored into a chosen one");
    let both = tmp.path().join("both.sql").to_string_lossy().into_owned();
    let two = DbMysqldumpOptions { databases: vec!["oi_dump_src".into(), "oi_dump_dst".into()], ..options };
    run(dump.path, DbToolJob::Mysqldump { file: both.clone(), options: two }).await?;
    assert!(ide_db::tools::dump_info(both.as_ref())?.creates_database, "several databases: created by the dump");
    let restore = DbMysqlOptions { database: "oi_dump_dst".into(), force: false };
    run(client.path, DbToolJob::Mysql { file, options: restore }).await?;

    let r = db.execute("m", "SELECT tag FROM oi_dump_dst.items", 1, &c).await?;
    assert_eq!(r.rows[0][0].as_deref(), Some("dumped"));
    for stmt in ["DROP DATABASE oi_dump_src", "DROP DATABASE oi_dump_dst"] {
        db.execute("m", stmt, 1, &c).await?;
    }
    Ok(())
}

#[tokio::test]
async fn later_pages_continue_the_result_where_the_previous_page_stopped() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    let c = CancellationToken::new();
    let query = "WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 1000) \
                 SELECT id, REPEAT('x', 10) AS pad FROM n ORDER BY id";
    // Forward, back, and jumping: every page holds its own rows whichever cursor served it.
    for page in [0, 1, 2, 3, 1, 7, 8, 9, 4, 0] {
        let r = db.execute_from("m", query, page * 100, 100, &c, None).await?;
        let ids: Vec<_> = r.rows.iter().map(|row| row[0].clone().unwrap()).collect();
        let want: Vec<_> = (page * 100 + 1..=page * 100 + 100).map(|n| n.to_string()).collect();
        assert_eq!(ids, want, "page {page}");
        assert_eq!(r.has_more, page < 9, "page {page}");
    }
    // A pool of 4 connections: cursors that were left open must not exhaust it.
    for _ in 0..8 {
        db.execute_from("m", query, 100, 100, &c, None).await?;
        db.release_result("m", query, None);
        assert_eq!(db.execute("m", "SELECT 1", 1, &c).await?.rows[0][0].as_deref(), Some("1"));
    }
    Ok(())
}

#[tokio::test]
async fn table_grants_list_table_privileges() -> IdeResult<()> {
    let tmp = tempfile::tempdir().unwrap();
    let Some(db) = manager(&tmp, "").await else { return Ok(()) };
    let c = CancellationToken::new();
    for stmt in [
        "DROP DATABASE IF EXISTS oi_grants",
        "DROP USER IF EXISTS 'oi_grant_reader'@'%', 'oi_grant_writer'@'%'",
        "CREATE USER 'oi_grant_reader'@'%', 'oi_grant_writer'@'%'",
        "CREATE DATABASE oi_grants",
        "CREATE TABLE oi_grants.shared (id INT)",
        "CREATE TABLE oi_grants.private (id INT)",
        "GRANT SELECT ON oi_grants.shared TO 'oi_grant_reader'@'%'",
        "GRANT INSERT, UPDATE ON oi_grants.shared TO 'oi_grant_writer'@'%' WITH GRANT OPTION",
    ] {
        db.execute("m", stmt, 10, &c).await?;
    }
    let grants = db.table_grants("m", "oi_grants", "shared").await?;
    let mut rows: Vec<_> =
        grants.iter().map(|g| (g.grantee.as_str(), g.privilege.as_str(), g.grantable, g.grantor.clone())).collect();
    rows.sort();
    assert_eq!(
        rows,
        [
            ("'oi_grant_reader'@'%'", "SELECT", false, None),
            ("'oi_grant_writer'@'%'", "INSERT", true, None),
            ("'oi_grant_writer'@'%'", "UPDATE", true, None),
        ]
    );
    assert!(db.table_grants("m", "oi_grants", "private").await?.is_empty());
    for stmt in ["DROP DATABASE oi_grants", "DROP USER 'oi_grant_reader'@'%', 'oi_grant_writer'@'%'"] {
        db.execute("m", stmt, 10, &c).await?;
    }
    Ok(())
}
