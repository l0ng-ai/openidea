use ide_core::{CancellationToken, IdeResult, error::ErrorKind};
use ide_db::{ConsoleId, DataSource, DbDriver, DbManager, QueryResult};
use std::sync::Arc;
use std::time::Duration;

const TARGET: &str = "fixture";
const A: ConsoleId<'static> = ConsoleId::new("main", "a.sql");
const B: ConsoleId<'static> = ConsoleId::new("main", "b.sql");
const C: ConsoleId<'static> = ConsoleId::new("other", "a.sql");

async fn run(db: &DbManager, console: ConsoleId<'_>, sql: &str, token: &CancellationToken) -> IdeResult<QueryResult> {
    db.execute_in_console(TARGET, sql, 0, 10, token, Some("public"), Some(console)).await
}

#[tokio::test]
#[ignore = "requires a disposable local PostgreSQL fixture with OPENIDEA_PG_CONSOLE_PORT and console_fixture db/user"]
async fn console_transactions_have_independent_commit_stop_and_release() -> IdeResult<()> {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let ssh = Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
    let db = DbManager::new(root.into(), root.join("passwords.json"), root.join("history.json"), ssh);
    db.save_sources(vec![DataSource {
        id: TARGET.into(),
        name: "Local PostgreSQL".into(),
        driver: DbDriver::Postgres,
        host: "127.0.0.1".into(),
        port: Some(std::env::var("OPENIDEA_PG_CONSOLE_PORT").expect("disposable fixture port").parse().unwrap()),
        user: "console_fixture".into(),
        database: "console_fixture".into(),
        ..Default::default()
    }])
    .await?;
    let cancel = CancellationToken::new();
    let observer = db.pool(TARGET).await?;
    db.execute(TARGET, "CREATE TABLE public.console_tx (id int PRIMARY KEY)", 0, &cancel).await?;
    for console in [A, B, C] {
        assert!(db.set_postgres_console_manual(TARGET, console, true).await?);
        assert!(!db.set_postgres_console_manual(TARGET, console, true).await?);
    }
    run(&db, A, "INSERT INTO public.console_tx VALUES (1)", &cancel).await?;
    let status = "SELECT pg_backend_pid(), txid_current(), count(*) FROM public.console_tx";
    let a = run(&db, A, status, &cancel).await?.rows;
    let b = run(&db, B, status, &cancel).await?.rows;
    assert_ne!(a[0][0], b[0][0]);
    assert_ne!(a[0][1], b[0][1]);
    assert_eq!(a[0][2].as_deref(), Some("1"));
    assert_eq!(b[0][2].as_deref(), Some("0"));
    let error = run(&db, C, "SELECT 1", &cancel).await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(error.message.contains("Commit or roll back"));
    let rows = "SELECT id FROM public.console_tx ORDER BY id";
    assert!(observer.rows(rows, 10).await?.is_empty());
    run(&db, B, "INSERT INTO public.console_tx VALUES (2)", &cancel).await?;
    db.finish_postgres_console_transaction(TARGET, B, true).await?;
    assert_eq!(observer.rows(rows, 10).await?, [[Some("2".into())]]);
    db.release_target_console(A, Some("other-target")).await?;
    let retained =
        db.read_console_row(TARGET, rows, 0, &cancel, Some("public"), Some(A.expecting_manual(Some(true)))).await?;
    assert_eq!(retained.rows, [[Some("1".into())]]);
    let a_after_b = run(&db, A, status, &cancel).await?.rows;
    assert_eq!(&a_after_b[0][..2], &a[0][..2]);
    assert_eq!(a_after_b[0][2].as_deref(), Some("2"));
    println!("Separate backend/transaction IDs: A {:?}, B {:?}; observer sees only B's committed row", a[0], b[0]);

    run(&db, B, "INSERT INTO public.console_tx VALUES (3)", &cancel).await?;
    let stop = CancellationToken::new();
    let slow = "SELECT pg_sleep(8) AS scoped_manual_a";
    let mut a_slow = std::pin::pin!(run(&db, A, slow, &stop));
    let active = async {
        loop {
            let rows = observer.rows(
                "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(8) AS scoped_manual_a'",
                1,
            ).await?;
            if !rows.is_empty() {
                return IdeResult::Ok(());
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    };
    tokio::select! {
        result = &mut a_slow => panic!("A ended before observer saw it: {result:?}"),
        observed = tokio::time::timeout(Duration::from_secs(3), active) => observed.expect("A reached PostgreSQL")?,
    }
    let waiting = CancellationToken::new();
    let still_running = async {
        let (waited, ()) = tokio::join!(run(&db, A, "SELECT 1", &waiting), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            waiting.cancel();
        });
        assert_eq!(waited.unwrap_err().kind, ErrorKind::Cancelled);
        let b = run(&db, B, rows, &cancel).await?;
        assert_eq!(b.rows, [[Some("2".into())], [Some("3".into())]]);
        IdeResult::Ok(())
    };
    tokio::select! {
        result = &mut a_slow => panic!("A ended before B finished: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), still_running) => result.expect("B did not wait for A")?,
    }
    stop.cancel();
    let error = tokio::time::timeout(Duration::from_secs(4), &mut a_slow).await.expect("A stopped").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    assert_eq!(observer.rows(rows, 10).await?, [[Some("2".into())]]);
    db.finish_postgres_console_transaction(TARGET, B, true).await?;
    assert_eq!(observer.rows(rows, 10).await?, [[Some("2".into())], [Some("3".into())]]);

    run(&db, A, "INSERT INTO public.console_tx VALUES (4)", &cancel).await?;
    db.release_console(A).await?;
    let stale = run(&db, A.expecting_manual(Some(true)), "INSERT INTO public.console_tx VALUES (5)", &cancel)
        .await
        .unwrap_err();
    assert_eq!(stale.kind, ErrorKind::OutOfSync);
    let stale_commit = db.finish_postgres_console_transaction(TARGET, A, true).await.unwrap_err();
    assert_eq!(stale_commit.kind, ErrorKind::OutOfSync);
    assert_eq!(run(&db, C, rows, &cancel).await?.rows, [[Some("2".into())], [Some("3".into())]]);
    db.finish_postgres_console_transaction(TARGET, C, false).await?;
    db.disconnect(TARGET).await;
    println!(
        "Stop A rolled back only A. B committed afterward, and releasing A rolled back its next transaction and freed a slot."
    );
    Ok(())
}
