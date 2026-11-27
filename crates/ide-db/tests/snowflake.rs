//! Against a real Snowflake account, with key-pair authentication:
//!
//! ```sh
//! OPENIDEA_TEST_SNOWFLAKE_ACCOUNT=myorg-myaccount OPENIDEA_TEST_SNOWFLAKE_USER=jane \
//! OPENIDEA_TEST_SNOWFLAKE_KEY_FILE=~/.ssh/rsa_key.p8 \
//! cargo test -p ide-db --test snowflake -- --ignored --nocapture
//! ```
//!
//! Optional: `…_KEY_PASSPHRASE`, `…_WAREHOUSE`, `…_ROLE`, `…_DATABASE`, `…_SCHEMA`.
//! The output holds no credential.

use ide_core::{CancellationToken, error::ErrorKind};
use ide_db::{DataSource, DbDriver, DbOptions, DbSnowflake, DbSnowflakeAuth, Pool};
use std::time::{Duration, Instant};

fn setting(name: &str) -> Option<String> {
    std::env::var(format!("OPENIDEA_TEST_SNOWFLAKE_{name}")).ok().filter(|v| !v.trim().is_empty())
}

fn source() -> DataSource {
    DataSource {
        id: "snowflake".into(),
        name: "snowflake".into(),
        driver: DbDriver::Snowflake,
        host: setting("ACCOUNT").expect("OPENIDEA_TEST_SNOWFLAKE_ACCOUNT"),
        user: setting("USER").expect("OPENIDEA_TEST_SNOWFLAKE_USER"),
        database: setting("DATABASE").unwrap_or_default(),
        options: DbOptions { default_schema: setting("SCHEMA").unwrap_or_default(), ..Default::default() },
        snowflake: Some(DbSnowflake {
            warehouse: setting("WAREHOUSE").unwrap_or_default(),
            role: setting("ROLE").unwrap_or_default(),
            auth: DbSnowflakeAuth::KeyPair,
            private_key_file: setting("KEY_FILE").expect("OPENIDEA_TEST_SNOWFLAKE_KEY_FILE"),
        }),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_SNOWFLAKE_ACCOUNT, _USER and _KEY_FILE"]
async fn key_pair_session_against_a_real_account() {
    let passphrase = setting("KEY_PASSPHRASE");
    let started = Instant::now();
    let pool = match Pool::connect(&source(), passphrase.as_deref(), None).await {
        Ok(pool) => pool,
        Err(error) => panic!("login failed ({:?}): {}", error.kind, error.message),
    };
    println!("[1] logged in with the key pair in {:?}", started.elapsed());
    let cancel = CancellationToken::new();
    let cell = |rows: &[Vec<Option<String>>], i: usize| rows[0][i].clone().unwrap_or_else(|| "<null>".into());

    let version = pool.execute("SELECT 'Snowflake ' || CURRENT_VERSION()", 1, &cancel).await.unwrap();
    println!("[2] {}", cell(&version.rows, 0));

    let context = pool
        .execute("SELECT CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_ROLE()", 1, &cancel)
        .await
        .unwrap();
    println!(
        "[3] context: warehouse={} database={} schema={} role={}",
        cell(&context.rows, 0),
        cell(&context.rows, 1),
        cell(&context.rows, 2),
        cell(&context.rows, 3)
    );
    for (wanted, i) in
        [(setting("WAREHOUSE"), 0), (setting("DATABASE"), 1), (setting("SCHEMA"), 2), (setting("ROLE"), 3)]
    {
        if let Some(wanted) = wanted {
            assert!(cell(&context.rows, i).eq_ignore_ascii_case(&wanted), "context {i} is not {wanted}");
        }
    }

    let types = pool
        .execute(
            "SELECT 12345.67::NUMBER(10,2) AS n, 1.5::FLOAT AS f, 'text' AS t, TRUE AS b, \
             '2023-11-14'::DATE AS d, '01:02:03.5'::TIME(3) AS tm, \
             '2023-11-14 22:13:20.123'::TIMESTAMP_NTZ(3) AS ntz, \
             '2023-11-14 22:13:20 +02:00'::TIMESTAMP_TZ(0) AS tz, \
             '2023-11-14 22:13:20'::TIMESTAMP_LTZ(0) AS ltz, \
             PARSE_JSON('{\"a\":[1,2]}') AS v, TO_BINARY('DEADBEEF', 'HEX') AS bin, NULL AS nothing",
            1,
            &cancel,
        )
        .await
        .unwrap();
    for (column, value) in types.columns.iter().zip(&types.rows[0]) {
        println!("[4] {:8} {:18} {}", column.name, column.type_name, value.as_deref().unwrap_or("<null>"));
    }
    let shown: Vec<Option<&str>> = types.rows[0].iter().map(|v| v.as_deref()).collect();
    assert_eq!(shown[0], Some("12345.67"));
    assert_eq!(shown[2], Some("text"));
    assert_eq!(shown[3], Some("true"));
    assert_eq!(shown[4], Some("2023-11-14"));
    assert_eq!(shown[5], Some("01:02:03.500"));
    assert_eq!(shown[6], Some("2023-11-14 22:13:20.123"));
    assert_eq!(shown[7], Some("2023-11-14 22:13:20 +02:00"));
    assert_eq!(shown[10], Some("0xDEADBEEF"));
    assert_eq!(shown[11], None);
    assert_eq!(types.columns[0].type_name, "NUMBER(10,2)");

    pool.execute("SET openidea_probe = 41", 0, &cancel).await.unwrap();
    let kept = pool.execute("SELECT $openidea_probe + 1", 1, &cancel).await.unwrap();
    assert_eq!(cell(&kept.rows, 0), "42");
    println!("[5] session state is kept between statements");

    let databases = pool.execute("SHOW TERSE DATABASES", 1000, &cancel).await.unwrap();
    println!(
        "[6] SHOW TERSE DATABASES: {} databases, columns {:?}",
        databases.rows.len(),
        databases.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>()
    );

    let missing = pool.execute("SELECT * FROM openidea_no_such_table_x", 1, &cancel).await.unwrap_err();
    println!("[7] error for a missing table ({:?}): {}", missing.kind, missing.message.replace('\n', " | "));
    assert_eq!(missing.kind, ErrorKind::InvalidInput);

    let limited = pool.execute("SELECT SEQ4() FROM TABLE(GENERATOR(ROWCOUNT => 100))", 2, &cancel).await;
    match limited {
        Ok(limited) => {
            assert_eq!(limited.rows.len(), 2);
            assert!(limited.has_more);
            println!("[8] a row limit keeps 2 of 100 rows and reports more");
            let page = pool
                .execute_from(
                    "SELECT SEQ4() AS n, REPEAT('x', 200) FROM TABLE(GENERATOR(ROWCOUNT => 300000)) ORDER BY n",
                    250_000,
                    3,
                    &cancel,
                )
                .await
                .unwrap();
            assert_eq!(
                page.rows.iter().map(|r| r[0].clone().unwrap()).collect::<Vec<_>>(),
                ["250000", "250001", "250002"]
            );
            println!(
                "[9] a page deep in a large result: {:?} total, {:?} to first answer",
                page.elapsed_ms, page.execution_ms
            );

            let stop = CancellationToken::new();
            let waited = Instant::now();
            let statement = pool.execute("CALL SYSTEM$WAIT(120)", 1, &stop);
            let cancelling = async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                stop.cancel();
            };
            let (outcome, ()) = tokio::join!(statement, cancelling);
            let error = outcome.unwrap_err();
            assert_eq!(error.kind, ErrorKind::Cancelled, "{}", error.message);
            assert!(waited.elapsed() < Duration::from_secs(30));
            println!("[10] cancelled a 120 s statement after {:?}: {}", waited.elapsed(), error.message);
            let after = pool.execute("SELECT 1", 1, &cancel).await.unwrap();
            assert_eq!(cell(&after.rows, 0), "1");
            println!("[11] the session works after the cancellation");
        }
        Err(error) => {
            println!("[8] skipped warehouse checks ({:?}): {}", error.kind, error.message.replace('\n', " | "))
        }
    }

    pool.close().await;
    assert!(pool.is_closed());
    println!("[12] session closed");
}

/// The Database tree's metadata calls. Prints counts and column shapes only, never object names.
#[tokio::test]
#[ignore = "requires OPENIDEA_TEST_SNOWFLAKE_ACCOUNT, _USER and _KEY_FILE"]
async fn explorer_metadata_against_a_real_account() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().to_path_buf();
    let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(dir.join("ssh-passwords.json")));
    let db = ide_db::DbManager::new(dir.clone(), dir.join("passwords.json"), dir.join("history.json"), ssh);
    db.save_sources(vec![source()]).await.unwrap();
    db.set_password("snowflake", setting("KEY_PASSPHRASE"), false).await.unwrap();

    let databases = db.databases("snowflake").await.unwrap();
    println!("[m1] databases: {} (current set: {})", databases.names.len(), !databases.current.is_empty());
    assert!(!databases.names.is_empty());
    let database = setting("DATABASE")
        .map(|d| d.to_uppercase())
        .filter(|d| databases.names.contains(d))
        .unwrap_or_else(|| databases.names[0].clone());
    let target = format!("snowflake:{database}");

    let schemas = db.schemas(&target).await.unwrap();
    println!("[m2] schemas in the chosen database: {}", schemas.len());
    assert!(!schemas.iter().any(|s| s == "INFORMATION_SCHEMA"));

    // The first schema that has tables, so the deeper calls have something to read.
    let mut found = None;
    for schema in schemas.iter().take(25) {
        let tables = db.tables(&target, schema).await.unwrap();
        if !tables.is_empty() {
            found = Some((schema.clone(), tables));
            break;
        }
    }
    match found {
        None => println!("[m3] no tables in the first 25 schemas: table checks skipped"),
        Some((schema, tables)) => {
            let views = tables.iter().filter(|t| t.kind != ide_db::DbTableKind::Table).count();
            println!("[m3] tables and views in one schema: {} ({} views)", tables.len(), views);
            let details = db.table_details(&target, &schema, &tables[0].name).await.unwrap();
            let typed = details.columns.iter().filter(|c| !c.data_type.is_empty()).count();
            println!(
                "[m4] first table: {} columns ({} typed, {} primary key, {} nullable), {} foreign keys; first type: {}",
                details.columns.len(),
                typed,
                details.columns.iter().filter(|c| c.primary_key).count(),
                details.columns.iter().filter(|c| c.nullable).count(),
                details.foreign_keys.len(),
                details.columns.first().map_or("", |c| c.data_type.as_str())
            );
            assert!(!details.columns.is_empty());
            assert_eq!(typed, details.columns.len());
            let objects = db.schema_objects(&target, &schema).await.unwrap();
            let mut kinds = std::collections::BTreeMap::new();
            for other in &objects.others {
                *kinds.entry(other.kind.as_str()).or_insert(0) += 1;
            }
            println!(
                "[m5] schema objects: {} routines, {} sequences, others {:?}",
                objects.routines.len(),
                objects.sequences.len(),
                kinds
            );
            let ddl = db.ddl(&target, &schema, &tables[0].name).await.unwrap();
            println!(
                "[m6] DDL of the first table: {} characters, starts with {:?}",
                ddl.len(),
                ddl.split_whitespace().next()
            );
            assert!(ddl.to_lowercase().starts_with("create"));
            let page =
                db.table_page(&target, &schema, &tables[0].name, None, &[], 0, 5, &CancellationToken::new()).await;
            match page {
                Ok(page) => println!(
                    "[m7] table data page: {} rows, {} columns",
                    page.result.rows.len(),
                    page.result.columns.len()
                ),
                Err(error) => {
                    println!("[m7] table data page failed ({:?}): {}", error.kind, error.message.replace('\n', " | "))
                }
            }
        }
    }

    let loading = Instant::now();
    let completion = db.completion(&target).await.unwrap();
    println!("[m8] completion model loaded in {:?}", loading.elapsed());
    println!(
        "[m8] completion model: {} tables ({} with columns), {} columns, default schema set: {}",
        completion.tables.len(),
        completion.tables.iter().filter(|t| !t.columns.is_empty()).count(),
        completion.tables.iter().map(|t| t.columns.len()).sum::<usize>(),
        !completion.default_schema.is_empty()
    );

    let session = db.session_context(&target).await.unwrap();
    println!(
        "[m9] session: warehouse set: {}, role set: {}, {} warehouses, {} roles to pick from",
        !session.warehouse.is_empty(),
        !session.role.is_empty(),
        session.warehouses.len(),
        session.roles.len()
    );
    assert!(!session.role.is_empty());

    let plan = db.explain(&target, "SELECT 1 AS n", &CancellationToken::new(), None).await;
    match plan {
        Ok(plan) => println!(
            "[m10] explain plan: {} operations, first {:?}",
            plan.len(),
            plan.first().map(|n| n.operation.clone())
        ),
        Err(error) => println!("[m10] explain failed ({:?}): {}", error.kind, error.message.replace('\n', " | ")),
    }
    // Introspection as the app runs it: every database through the data source itself.
    let listed = db.databases("snowflake").await.unwrap();
    let (mut read, mut failed, mut schemas, mut tables) = (0, 0, 0, 0);
    let mut first_failure = None;
    for database in &listed.names {
        match db.database_catalog("snowflake", database).await {
            Ok(catalog) => {
                read += 1;
                schemas += catalog.len();
                tables += catalog.iter().map(|s| s.tables.len()).sum::<usize>();
            }
            Err(error) => {
                failed += 1;
                // Names stay out of the output: quoted parts of the message are masked.
                let mut masked = String::new();
                let mut quote = None;
                for c in error.message.replace('\n', " | ").chars() {
                    match quote {
                        Some(q) if c == q => quote = None,
                        Some(_) => continue,
                        None if c == '\'' || c == '"' => quote = Some(c),
                        None => {}
                    }
                    masked.push(c);
                }
                first_failure.get_or_insert(format!("{:?}: {masked}", error.kind));
            }
        }
    }
    println!(
        "[m11] introspection: {} databases listed, {read} read, {failed} failed, {schemas} schemas, {tables} tables and views",
        listed.names.len()
    );
    if let Some(failure) = first_failure {
        println!("[m11] first failure: {failure}");
    }
    assert!(read > 0, "no database could be introspected");
    // The reference's commands that only list things and name no object, against the real server:
    // each is either answered or refused by Snowflake (an edition or privilege it needs), never
    // misread by the client. `USE` goes to what the session already has.
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/snowflake/commands.json")).expect("the fixture parses");
    let mut statements: Vec<(String, String)> = fixture["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .map(|c| {
            (c["command"].as_str().unwrap_or_default().to_owned(), c["sql"].as_str().unwrap_or_default().to_owned())
        })
        .filter(|(_, sql)| sql.starts_with("SHOW ") && !sql.to_lowercase().contains("my_") && !sql.contains("analyst"))
        .collect();
    let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    statements.push(("USE ROLE".into(), format!("USE ROLE {}", quoted(&session.role))));
    if !session.warehouse.is_empty() {
        statements.push(("USE WAREHOUSE".into(), format!("USE WAREHOUSE {}", quoted(&session.warehouse))));
    }
    statements.push(("USE DATABASE".into(), format!("USE DATABASE {}", quoted(&database))));
    statements.push(("USE SECONDARY ROLES".into(), "USE SECONDARY ROLES ALL".into()));
    let (mut answered, mut refused, mut broken) = (0, Vec::new(), Vec::new());
    for (command, sql) in &statements {
        match db.execute(&target, sql, 1, &CancellationToken::new()).await {
            Ok(_) => answered += 1,
            Err(error) if error.kind == ErrorKind::InvalidInput => {
                // Snowflake's own refusal: the command and the error code only.
                let code = error.message.split(['[', ']']).nth(1).unwrap_or("?").to_owned();
                refused.push(format!("{command} [{code}]"));
            }
            Err(error) => broken.push(format!("{command} ({:?})", error.kind)),
        }
    }
    println!(
        "[m12] commands: {} run, {answered} answered, {} refused by Snowflake, {} failed in the client",
        statements.len(),
        refused.len(),
        broken.len()
    );
    if !refused.is_empty() {
        println!("[m12] refused: {}", refused.join(", "));
    }
    assert!(broken.is_empty(), "the client failed on: {}", broken.join(", "));
    assert!(answered > 0);
    db.disconnect_source("snowflake").await;
    println!("[m13] disconnected");
}
