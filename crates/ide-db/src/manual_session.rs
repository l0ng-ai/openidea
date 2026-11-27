use crate::{ConsoleId, Held, Pool, QueryResult};
use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};

pub(super) type Session = Arc<ManualSession>;
type ConsoleKey = (String, String);

struct Transaction {
    connection: Held,
    _permit: Option<OwnedSemaphorePermit>,
}

impl Transaction {
    async fn acquire(pool: &Pool, capacity: &Arc<Semaphore>) -> IdeResult<Self> {
        let permit = if matches!(pool, Pool::Postgres(_)) {
            Some(capacity.clone().try_acquire_owned().map_err(|_| {
                IdeError::unavailable("PostgreSQL manual transactions are using the available slots. Commit or roll back an open transaction.")
            })?)
        } else {
            None
        };
        Ok(Self { connection: Held::acquire(pool).await?, _permit: permit })
    }
}

#[derive(Default)]
pub(super) struct ManualSession {
    transaction: AsyncMutex<Option<Transaction>>,
    retired: CancellationToken,
}

impl ManualSession {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn execute(
        &self,
        pool: &Pool,
        capacity: &Arc<Semaphore>,
        statement: &str,
        skip: usize,
        max_rows: usize,
        request: &CancellationToken,
        schema: Option<&str>,
    ) -> IdeResult<QueryResult> {
        let cancel = self.retired.child_token();
        let mut held = tokio::select! {
            biased;
            () = request.cancelled() => return Err(IdeError::cancelled()),
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
            held = self.transaction.lock() => held,
        };
        let execute = async {
            if pool.transaction_read_only() {
                // Own the connection while applying the guard so a dropped call cannot return an open transaction.
                let mut tx = match held.take() {
                    Some(tx) => tx,
                    None => {
                        let mut tx = Transaction::acquire(pool, capacity).await?;
                        tx.connection.begin_manual(pool.driver()).await?;
                        tx
                    }
                };
                let result = async {
                    tx.connection.apply_context(schema).await?;
                    tx.connection.execute_from(pool, statement, skip, max_rows, &cancel).await
                }
                .await;
                if result.is_ok() {
                    *held = Some(tx);
                } else if cancel.is_cancelled() || tx.connection.finish_manual(false).await.is_err() {
                    tx.connection.discard().await;
                }
                return result;
            }
            if held.is_none() {
                let mut tx = Transaction::acquire(pool, capacity).await?;
                tx.connection.apply_context(schema).await?;
                tx.connection.begin_manual(pool.driver()).await?;
                *held = Some(tx);
            }
            let conn = &mut held.as_mut().expect("opened above").connection;
            conn.apply_context(schema).await?;
            let result = conn.execute_from(pool, statement, skip, max_rows, &cancel).await;
            if cancel.is_cancelled() {
                held.take().expect("opened above").connection.discard().await;
                return Err(IdeError::cancelled());
            }
            result
        };
        tokio::pin!(execute);
        tokio::select! {
            biased;
            () = request.cancelled() => {
                cancel.cancel();
                execute.await
            }
            result = &mut execute => result,
        }
    }

    pub(super) async fn finish(&self, commit: bool) -> IdeResult<()> {
        let mut held = self.transaction.lock().await;
        if commit && self.retired.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Some(mut tx) = held.take() else { return Ok(()) };
        if let Err(error) = tx.connection.finish_manual(commit).await {
            // Snowflake targets share the same server session, so keep the failed transaction to be ended again.
            if matches!(tx.connection, Held::Snowflake(..)) {
                *held = Some(tx);
            } else {
                tx.connection.discard().await;
            }
            return Err(error);
        }
        if let Err(error) = tx.connection.restore_default().await {
            tx.connection.discard().await;
            return Err(error);
        }
        Ok(())
    }

    pub(super) async fn rollback_and_release(&self) -> IdeResult<()> {
        let transaction = self.transaction.lock().await.take();
        let Some(mut tx) = transaction else { return Ok(()) };
        if let Err(error) = tx.connection.finish_manual(false).await {
            tx.connection.discard().await;
            return Err(error);
        }
        if let Err(error) = tx.connection.restore_default().await {
            tx.connection.discard().await;
            return Err(error);
        }
        Ok(())
    }

    async fn retire(&self) -> IdeResult<()> {
        self.retired.cancel();
        self.rollback_and_release().await
    }
}

pub(super) struct ConsoleTransactions {
    sessions: Mutex<HashMap<ConsoleKey, Session>>,
    closed: CancellationToken,
    /// The four-slot pool also serves ordinary work and one retained result cursor.
    pub(super) capacity: Arc<Semaphore>,
}

impl Default for ConsoleTransactions {
    fn default() -> Self {
        Self { sessions: Mutex::default(), closed: CancellationToken::new(), capacity: Arc::new(Semaphore::new(2)) }
    }
}

fn key(console: ConsoleId<'_>) -> ConsoleKey {
    (console.window.to_owned(), console.path.to_owned())
}

impl ConsoleTransactions {
    pub(super) fn session(&self, console: ConsoleId<'_>) -> Option<Session> {
        self.sessions.lock().get(&key(console)).cloned()
    }

    pub(super) fn enable(&self, console: ConsoleId<'_>) -> IdeResult<bool> {
        let mut sessions = self.sessions.lock();
        if self.closed.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        match sessions.entry(key(console)) {
            std::collections::hash_map::Entry::Occupied(_) => Ok(false),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(Session::default());
                Ok(true)
            }
        }
    }

    pub(super) async fn release(&self, console: ConsoleId<'_>) -> IdeResult<()> {
        let session = self.sessions.lock().remove(&key(console));
        if let Some(session) = session {
            session.retire().await?;
        }
        Ok(())
    }

    pub(super) async fn close(&self) {
        let sessions = {
            let mut sessions = self.sessions.lock();
            self.closed.cancel();
            std::mem::take(&mut *sessions)
        };
        for session in sessions.values() {
            session.retired.cancel();
        }
        for session in sessions.into_values() {
            let _ = session.rollback_and_release().await;
        }
    }
}
