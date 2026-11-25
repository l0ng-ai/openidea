//! Result paging that reads on from where the previous page stopped.
//!
//! A statement has no way to start at row N: its server sends the rows before it, and a
//! page that re-runs the query reads and drops all of them. The page after another one
//! continues the same stream instead, so paging forward costs one page per click.
//!
//! A cursor keeps its statement's stream, and so its connection, open, which holds
//! server resources (locks, a snapshot) for as long as it lives. That is bounded:
//! one cursor per target, a few overall, each closed after [`IDLE`] without a page, when
//! its tab is closed or its target disconnects, and before a statement that is not a
//! query runs on its target. A page that finds no cursor at its position (jumping
//! to another page, going back, a closed cursor) starts a new one.

use super::{Cells, Fetched, Held, Pool, Reader, drain, looks_like_query, statement_columns};
use ide_core::{CancellationToken, IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use sqlx::{Executor, SqlSafeStr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// How long a cursor waits for its next page.
const IDLE: Duration = Duration::from_secs(30);
/// Cursors kept at once, over all targets (each holds a connection).
const MAX_CURSORS: usize = 4;

/// What a cursor reads the pages of: one statement of one target, in a schema context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Key {
    target: String,
    statement: String,
    schema: Option<String>,
}

impl Key {
    pub(crate) fn new(target: &str, statement: &str, schema: Option<&str>) -> Self {
        Self {
            target: target.to_owned(),
            statement: statement.to_owned(),
            schema: schema.filter(|s| !s.is_empty()).map(str::to_owned),
        }
    }
}

/// A request for the next rows of a cursor's statement.
struct Read {
    skip: usize,
    max: usize,
    cancel: CancellationToken,
    reply: oneshot::Sender<IdeResult<Fetched>>,
}

/// A live cursor: where its stream stands, and the channel to the task that owns it.
struct Slot {
    id: u64,
    key: Key,
    /// The number of rows read from the start of the statement (skipped or returned).
    next: usize,
    /// A page is being read from it: it stays registered meanwhile, so a release finds it.
    busy: bool,
    reads: mpsc::Sender<Read>,
}

/// Reads `max` rows after the first `skip` of a cursor's stream through `reads`; `None` when the cursor is gone.
async fn read(
    reads: &mpsc::Sender<Read>,
    skip: usize,
    max: usize,
    cancel: &CancellationToken,
) -> Option<IdeResult<Fetched>> {
    let (reply, answer) = oneshot::channel();
    reads.send(Read { skip, max, cancel: cancel.clone(), reply }).await.ok()?;
    answer.await.ok()
}

#[derive(Default)]
struct Registry {
    /// Oldest first.
    slots: Vec<Slot>,
    issued: u64,
}

#[derive(Default)]
pub(crate) struct Cursors {
    registry: Mutex<Registry>,
}

impl Cursors {
    /// The page at `skip` read from the cursor of `key` that stands there; `None` when
    /// there is none (the caller starts one) or it failed (a lost connection: the caller
    /// runs the statement again and reports whatever that returns).
    pub(crate) async fn resume(
        &self,
        key: &Key,
        skip: usize,
        max: usize,
        cancel: &CancellationToken,
        protected: bool,
    ) -> Option<IdeResult<Fetched>> {
        let (id, reads) = {
            let mut registry = self.registry.lock();
            let slot = registry
                .slots
                .iter_mut()
                .find(|s| s.key == *key && s.next == skip && !s.busy && !s.reads.is_closed())?;
            slot.busy = true;
            (slot.id, slot.reads.clone())
        };
        match read(&reads, 0, max, cancel).await {
            Some(Ok(fetched)) => {
                self.finish(id, &fetched);
                Some(Ok(fetched))
            }
            Some(Err(e)) if protected || e.kind == ErrorKind::Cancelled => {
                self.close(id);
                Some(Err(e))
            }
            _ => {
                self.close(id);
                None
            }
        }
    }

    /// Runs the statement of `key` on `held`, returns the page at `skip` and keeps the
    /// statement's stream for the page after it. `held` is taken out of `pool` (its
    /// context applied); `pool` stops the statement on the server when `cancel` fires.
    pub(crate) async fn start(
        &self,
        held: Held,
        pool: Arc<Pool>,
        key: Key,
        skip: usize,
        max: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<Fetched> {
        let (reads, requests) = mpsc::channel(1);
        tokio::spawn(serve(held, pool, key.statement.clone(), requests));
        let id = self.register(key, skip, reads.clone());
        let fetched = match read(&reads, skip, max, cancel).await {
            Some(Ok(fetched)) => fetched,
            other => {
                self.close(id);
                return other.unwrap_or_else(|| Err(IdeError::internal("the statement stopped before it answered")));
            }
        };
        self.finish(id, &fetched);
        Ok(fetched)
    }

    /// Registers a cursor that is reading its first page. A target keeps one cursor (its
    /// connection pool is small), and all together are bounded.
    fn register(&self, key: Key, next: usize, reads: mpsc::Sender<Read>) -> u64 {
        let mut registry = self.registry.lock();
        registry.issued += 1;
        let id = registry.issued;
        registry.slots.retain(|s| s.key.target != key.target && !s.reads.is_closed());
        registry.slots.push(Slot { id, key, next, busy: true, reads });
        if registry.slots.len() > MAX_CURSORS {
            registry.slots.remove(0);
        }
        id
    }

    /// Ready for the page after `fetched`, which cursor `id` just read, when more rows are waiting in its
    /// stream; closed otherwise. A cursor released meanwhile is gone from the registry: the caller's
    /// handle on its channel is the last, so the statement stops.
    fn finish(&self, id: u64, fetched: &Fetched) {
        let mut registry = self.registry.lock();
        let Some(at) = registry.slots.iter().position(|s| s.id == id) else { return };
        if fetched.3 {
            let slot = &mut registry.slots[at];
            slot.next += fetched.1.len();
            slot.busy = false;
        } else {
            registry.slots.remove(at);
        }
    }

    fn close(&self, id: u64) {
        self.registry.lock().slots.retain(|s| s.id != id);
    }

    /// Closes the cursor of one statement of `target` (its result tab was closed), also when it is reading a page.
    pub(crate) fn release(&self, key: &Key) {
        self.registry.lock().slots.retain(|s| s.key != *key);
    }

    /// Closes the cursors of `target`: it disconnects, or a statement that changes
    /// data or schema is about to run there.
    pub(crate) fn release_target(&self, target: &str) {
        self.registry.lock().slots.retain(|s| s.key.target != target);
    }
}

/// Owns `held` and the stream of `sql` on it, answering reads until the stream ends,
/// nobody asks for [`IDLE`], or it is released (its channel closes).
async fn serve(mut held: Held, pool: Arc<Pool>, sql: String, mut reads: mpsc::Receiver<Read>) {
    let Some(first) = reads.recv().await else { return held.discard().await };
    let prepare = async {
        let owned = held.begin_read_only().await?;
        held.check_protected_statement(&sql).await?;
        Ok(owned)
    }
    .await;
    let owned = match prepare {
        Ok(owned) => owned,
        Err(error) => {
            let _ = first.reply.send(Err(error));
            return;
        }
    };
    // `$id`: the query naming the server process, `$kill`: how another connection stops it.
    // Evaluates to whether the connection can go back to its pool (the stream was read to
    // its end); otherwise it is closed rather than left to be drained.
    macro_rules! serve {
        ($conn:expr, $id:expr, $kill:expr) => {{
            let backend = match $id {
                Some(q) => backend_id!(&mut **$conn, q),
                None => None,
            };
            let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone())).fetch_many(&mut **$conn);
            let mut reader = Reader::default();
            let mut request = Some(first);
            let mut last = None;
            let mut reusable = false;
            while let Some(Read { skip, max, cancel, reply }) = request.take() {
                let read = tokio::select! {
                    r = drain(&mut stream, &mut reader, skip, max, Cells::Display, |done| done.rows_affected()) => r,
                    () = cancel.cancelled() => Err(IdeError::cancelled()),
                };
                if cancel.is_cancelled() {
                    if let Some(b) = backend {
                        pool.cancel_query($kill(b)).await;
                    }
                    let _ = reply.send(Err(IdeError::cancelled()));
                    break;
                }
                match read {
                    Ok(fetched) if fetched.3 => {
                        if reply.send(Ok(fetched)).is_err() {
                            break;
                        }
                        request = tokio::time::timeout(IDLE, reads.recv()).await.unwrap_or(None);
                    }
                    Ok(fetched) => {
                        last = Some((reply, fetched));
                        reusable = true;
                        break;
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                        reusable = !owned;
                        break;
                    }
                }
            }
            drop(stream);
            if let Some((_, fetched)) = &mut last {
                if fetched.0.is_empty() && looks_like_query(&sql) {
                    fetched.0 = (&mut **$conn)
                        .prepare(sqlx::AssertSqlSafe(sql.clone()).into_sql_str())
                        .await
                        .map(|s| statement_columns(&s))
                        .unwrap_or_default();
                }
            }
            (reusable, last)
        }};
    }
    let (reusable, last) = match &mut held {
        Held::Sqlite(c) => serve!(c, None::<&str>, |_: String| String::new()),
        Held::Postgres(c) => {
            serve!(&mut ***c, Some("SELECT pg_backend_pid()"), |b: String| format!("SELECT pg_cancel_backend({b})"))
        }
        Held::Mysql(c) => serve!(&mut ***c, Some("SELECT CONNECTION_ID()"), |b: String| format!("KILL QUERY {b}")),
        _ => unreachable!("only the sqlx drivers keep cursors"),
    };
    if let Some((reply, fetched)) = last {
        let _ = reply.send(held.finish_read_only(owned, Ok(fetched)).await);
    } else if !reusable {
        held.discard().await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::ROWS_PULLED;
    use crate::{DataSource, DbDriver, DbManager};
    use ide_core::{CancellationToken, error::ErrorKind};

    const PAGE: usize = 100;
    const ROWS: usize = 1000;

    /// A SQLite data source `s1` with a table `t` of `ROWS` rows (`id` 1..=ROWS).
    async fn manager() -> (tempfile::TempDir, DbManager) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::File::create(root.join("app.db")).unwrap();
        let ssh = std::sync::Arc::new(ide_ssh::SshManager::new(root.join("ssh-passwords.json")));
        let db = DbManager::new(root.clone(), root.join("passwords.json"), root.join("history.json"), ssh);
        db.save_sources(vec![DataSource {
            id: "s1".into(),
            name: "app".into(),
            driver: DbDriver::Sqlite,
            file: Some("app.db".into()),
            ..Default::default()
        }])
        .await
        .unwrap();
        let cancel = CancellationToken::new();
        db.execute("s1", "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", 0, &cancel).await.unwrap();
        db.execute(
            "s1",
            &format!(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {ROWS}) \
                 INSERT INTO t SELECT i, 'row ' || i FROM n"
            ),
            0,
            &cancel,
        )
        .await
        .unwrap();
        (tmp, db)
    }

    const QUERY: &str = "SELECT id, name FROM t ORDER BY id";

    /// The ids of page `page` of `QUERY`, and whether more rows follow.
    async fn page(db: &DbManager, statement: &str, page: usize) -> (Vec<i64>, bool) {
        let r = db.execute_from("s1", statement, page * PAGE, PAGE, &CancellationToken::new(), None).await.unwrap();
        (r.rows.iter().map(|row| row[0].as_deref().unwrap().parse().unwrap()).collect(), r.has_more)
    }

    fn ids(page: usize) -> Vec<i64> {
        ((page * PAGE + 1) as i64..=((page + 1) * PAGE) as i64).collect()
    }

    fn pulled() -> u64 {
        ROWS_PULLED.with(std::cell::Cell::get)
    }

    #[tokio::test]
    async fn paging_forward_reads_each_row_once() {
        let (_tmp, db) = manager().await;
        let before = pulled();
        for p in 0..ROWS / PAGE {
            let (rows, has_more) = page(&db, QUERY, p).await;
            assert_eq!(rows, ids(p), "page {p}");
            assert_eq!(has_more, p + 1 < ROWS / PAGE, "page {p} has_more");
        }
        // Running the query again for every page reads 1+2+…+10 pages (5500 rows); one pass reads ~1000.
        assert!(pulled() - before < 2 * ROWS as u64, "read {} rows", pulled() - before);
    }

    #[tokio::test]
    async fn jumping_and_going_back_return_the_right_pages() {
        let (_tmp, db) = manager().await;
        for p in [5, 6, 2, 3, 9, 0, 1, 7, 7, 8] {
            assert_eq!(page(&db, QUERY, p).await.0, ids(p), "page {p}");
        }
    }

    #[tokio::test]
    async fn reading_a_row_leaves_the_cursor_of_the_pages_alone() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 1).await;
        let row = db.read_row("s1", QUERY, 350, &CancellationToken::new(), None).await.unwrap();
        assert_eq!(row.rows, [[Some("351".to_owned()), Some("row 351".to_owned())]]);
        assert_eq!(db.cursors.registry.lock().slots.len(), 1);
        // The next page still continues the cursor: it reads one page, not 200 rows again.
        let before = pulled();
        assert_eq!(page(&db, QUERY, 2).await.0, ids(2));
        assert!(pulled() - before <= PAGE as u64 + 1, "read {} rows", pulled() - before);
    }

    #[tokio::test]
    async fn pages_past_the_end_are_empty() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 8).await;
        let r = db.execute_from("s1", QUERY, 2 * ROWS, PAGE, &CancellationToken::new(), None).await.unwrap();
        assert!(r.rows.is_empty() && !r.has_more);
        // The columns of an empty page still come from the statement.
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
    }

    #[tokio::test]
    async fn another_statement_does_not_continue_a_cursor() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 1).await;
        let other = "SELECT id, name FROM t ORDER BY id DESC";
        let r = db.execute_from("s1", other, 2 * PAGE, PAGE, &CancellationToken::new(), None).await.unwrap();
        let first: i64 = r.rows[0][0].as_deref().unwrap().parse().unwrap();
        assert_eq!(first, (ROWS - 2 * PAGE) as i64);
    }

    #[tokio::test]
    async fn a_statement_that_changes_data_closes_the_cursor() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 1).await;
        assert_eq!(db.cursors.registry.lock().slots.len(), 1);
        db.execute("s1", "DELETE FROM t WHERE id = 150", 0, &CancellationToken::new()).await.unwrap();
        assert_eq!(db.cursors.registry.lock().slots.len(), 0);
        // The next page shows the change: row 150 is gone, so page 2 starts at 202.
        assert_eq!(page(&db, QUERY, 2).await.0[0], 202);
    }

    #[tokio::test]
    async fn releasing_and_abandoning_cursors_gives_their_connections_back() {
        let (_tmp, db) = manager().await;
        // The pool has 4 connections: a leak would starve `execute` after a few rounds.
        for _ in 0..8 {
            page(&db, QUERY, 1).await;
            db.release_result("s1", QUERY, None);
            assert_eq!(db.cursors.registry.lock().slots.len(), 0);
            assert_eq!(page(&db, "SELECT count(*) FROM t", 0).await.0, [ROWS as i64]);
        }
        // Finishing a result also frees its connection.
        for _ in 0..8 {
            for p in 1..ROWS / PAGE {
                page(&db, QUERY, p).await;
            }
        }
        assert_eq!(db.cursors.registry.lock().slots.len(), 0);
    }

    #[tokio::test]
    async fn a_cancelled_page_closes_its_cursor() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 1).await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let e = db.execute_from("s1", QUERY, 2 * PAGE, PAGE, &cancel, None).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Cancelled);
        assert_eq!(db.cursors.registry.lock().slots.len(), 0);
        assert_eq!(page(&db, QUERY, 2).await.0, ids(2));
    }

    /// A closed result tab releases its cursor even when a page is being read from it: the
    /// cursor is not put back afterwards and its statement stops.
    #[tokio::test]
    async fn releasing_a_cursor_in_the_middle_of_a_page_read_closes_it() {
        use super::{Cursors, Key, Read};
        use std::sync::Arc;
        use tokio::sync::{Notify, mpsc};

        let cursors = Arc::new(Cursors::default());
        let key = Key::new("s1", QUERY, None);
        let (reads, mut requests) = mpsc::channel::<Read>(1);
        cursors.register(key.clone(), 0, reads.clone());
        let page = || (Vec::new(), vec![vec![Some("1".to_owned())]], None, true, None);
        cursors.finish(1, &page());
        drop(reads);

        let in_read = Arc::new(Notify::new());
        let (release, announced) = (Arc::new(Notify::new()), in_read.clone());
        let server = tokio::spawn({
            let release = release.clone();
            async move {
                let read = requests.recv().await.unwrap();
                announced.notify_one();
                release.notified().await;
                let _ = read.reply.send(Ok(page()));
                // The channel closes once nobody holds a handle on it.
                requests.recv().await.is_none()
            }
        });
        let resumed = tokio::spawn({
            let (cursors, key) = (cursors.clone(), key.clone());
            async move { cursors.resume(&key, 1, 1, &CancellationToken::new(), false).await.is_some() }
        });
        in_read.notified().await;
        cursors.release(&key);
        release.notify_one();
        assert!(resumed.await.unwrap(), "the page that was being read is still returned");
        assert!(cursors.registry.lock().slots.is_empty(), "the released cursor is not put back");
        assert!(server.await.unwrap(), "the statement's task sees its channel close");
    }

    #[tokio::test]
    async fn a_target_keeps_one_cursor_and_all_are_bounded() {
        let (_tmp, db) = manager().await;
        page(&db, QUERY, 1).await;
        page(&db, "SELECT id, name FROM t WHERE id > 0 ORDER BY id", 1).await;
        assert_eq!(db.cursors.registry.lock().slots.len(), 1);
        // The first statement's cursor is gone: its next page is read again, and still right.
        assert_eq!(page(&db, QUERY, 2).await.0, ids(2));
    }
}
