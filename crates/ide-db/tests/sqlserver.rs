//! Live SQL Server checks, skipped unless OPENIDEA_TEST_SQLSERVER=host:port:user:password
//! names a throwaway server.

use ide_core::CancellationToken;
use ide_db::{DataSource, DbDriver, DbSslMode, Held, Pool};
use std::time::Duration;

#[tokio::test]
async fn sqlserver_values_paging_transactions_and_cancellation() {
    let Ok(server) = std::env::var("OPENIDEA_TEST_SQLSERVER") else { return };
    let mut parts = server.splitn(4, ':');
    let source = DataSource {
        driver: DbDriver::SqlServer,
        host: parts.next().unwrap().into(),
        port: Some(parts.next().unwrap().parse().unwrap()),
        user: parts.next().unwrap().into(),
        database: "tempdb".into(),
        ssl: DbSslMode::Disable,
        ..Default::default()
    };
    let pool = Pool::connect(&source, parts.next(), None).await.unwrap();
    let cancel = CancellationToken::new();
    let mut held = Held::acquire(&pool).await.unwrap();
    let table = format!("tempdb.dbo.oi_pr276_values_{}", std::process::id());
    held.command(&format!("CREATE TABLE {table} (id int PRIMARY KEY, d decimal(38, 7), dt datetime2(7), guid uniqueidentifier, m money, tiny tinyint, x xml)")).await.unwrap();
    held.command(&format!("INSERT INTO {table} VALUES (1, 12345678901234567890.1234567, '2024-02-29T12:34:56.1234567', 'abcdef01-2345-6789-abcd-ef0123456789', 12.3400, 255, '<a/>'), (2, NULL, NULL, NULL, NULL, NULL, NULL)")).await.unwrap();
    let r = held.execute(&pool, &format!("SELECT * FROM {table} ORDER BY id"), 1, &cancel).await.unwrap();
    assert!(r.has_more);
    assert_eq!(
        r.rows[0],
        [
            "1",
            "12345678901234567890.1234567",
            "2024-02-29 12:34:56.1234567",
            "abcdef01-2345-6789-abcd-ef0123456789",
            "12.3400",
            "255",
            "<a/>"
        ]
        .map(|s| Some(s.to_owned()))
    );
    let r = held.execute(&pool, &format!("SELECT * FROM {table} WHERE id = 2"), 5, &cancel).await.unwrap();
    assert!(!r.has_more);
    assert!(r.rows[0][1..].iter().all(Option::is_none));
    let r = held.execute(&pool, &format!("SELECT * FROM {table} WHERE id = 3"), 5, &cancel).await.unwrap();
    assert_eq!(r.columns.len(), 7);
    assert!(r.rows.is_empty());
    let r = held.execute(&pool,
        "SELECT CAST('2024-02-29T00:15:00.1234567+05:30' AS datetimeoffset(7)), CAST('2024-02-29' AS date), CAST('12:34:56.1234567' AS time(7)), CAST('2024-02-29T12:34:56.007' AS datetime), CAST('2024-02-29T12:34:00' AS smalldatetime), CAST(-12.3400 AS smallmoney)",
        1, &cancel).await.unwrap();
    assert_eq!(
        r.rows[0],
        [
            "2024-02-29 00:15:00.1234567+05:30",
            "2024-02-29",
            "12:34:56.1234567",
            "2024-02-29 12:34:56.007",
            "2024-02-29 12:34:00",
            "-12.3400"
        ]
        .map(|s| Some(s.to_owned()))
    );
    held.command(&format!("DROP TABLE {table}")).await.unwrap();
    drop(held);

    // A unique permanent table lets transaction calls acquire any pooled connection.
    let table = format!("tempdb.dbo.oi_pr276_{}", std::process::id());
    pool.execute(&format!("CREATE TABLE {table} (id int PRIMARY KEY, v int)"), 1, &cancel).await.unwrap();
    pool.transaction(&[(format!("INSERT INTO {table} VALUES (1, 10)"), true)]).await.unwrap();
    for failing in [format!("INSERT INTO {table} VALUES (1, 20)"), format!("UPDATE {table} SET v = 30 WHERE id = 999")]
    {
        assert!(
            pool.transaction(&[(format!("UPDATE {table} SET v = 99 WHERE id = 1"), true), (failing, true)])
                .await
                .is_err()
        );
        assert_eq!(pool.rows(&format!("SELECT v FROM {table}"), 1).await.unwrap()[0][0].as_deref(), Some("10"));
        assert_eq!(pool.rows("SELECT @@TRANCOUNT", 1).await.unwrap()[0][0].as_deref(), Some("0"));
    }
    assert_eq!(pool.transaction(&[(format!("UPDATE {table} SET v = 11 WHERE id = 1"), true)]).await.unwrap(), 1);
    pool.execute(&format!("DROP TABLE {table}"), 1, &cancel).await.unwrap();

    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.cancel();
    });
    assert!(
        tokio::time::timeout(Duration::from_secs(2), pool.execute("WAITFOR DELAY '00:00:10'; SELECT 1", 1, &cancel))
            .await
            .unwrap()
            .is_err()
    );
    task.await.unwrap();
    assert_eq!(pool.rows("SELECT 1", 1).await.unwrap()[0][0].as_deref(), Some("1"));
}
