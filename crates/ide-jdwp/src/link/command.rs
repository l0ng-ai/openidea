//! The link's own commands, injected while the VM is stopped.

use super::state::{OwnCommand, Turn};
use super::{JdwpLink, Shared, upstream};
use crate::codec::{Header, Reader, Writer};
use crate::ids::{IdSizes, ReplyIds};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, watch};

/// `SuspendCount` checks before a command gives up with [`LinkError::Busy`].
const SUSPEND_CHECKS: usize = 5;
const CHECK_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LinkError {
    #[error("the VM is not suspended")]
    NotSuspended,
    #[error("the VM resumed while the command was waiting")]
    Stale,
    #[error("the JDWP link only forwards")]
    Degraded,
    #[error("the JDWP link is closed")]
    Closed,
    #[error("the JDWP command timed out")]
    TimedOut,
    /// The stopped thread kept running code for the debugger (an invoke, or a suspend count
    /// of 0) through every check.
    #[error("the debugger is running code in the VM")]
    Busy,
    #[error("JDWP error {0}")]
    Jdwp(u16),
    #[error("malformed JDWP reply: {0}")]
    Protocol(String),
}

impl JdwpLink {
    /// Sends one command of the link's own and returns its reply body. Commands run one at a
    /// time, only while the VM is stopped: the stopped thread's `SuspendCount` must be above 0
    /// and no adapter invoke pending, checked up to five times 100 ms apart.
    ///
    /// The ObjectIDs at `ids` in the reply are counted when it arrives, even after the caller
    /// gave up, and released with `DisposeObjects` once the adapter resumes the VM. The command
    /// must be one the JVM answers without running the VM: never an invoke.
    pub async fn command(
        &self,
        set: u8,
        cmd: u8,
        body: Vec<u8>,
        ids: ReplyIds,
        timeout: Duration,
    ) -> Result<Vec<u8>, LinkError> {
        debug_assert!(!upstream::is_invoke((set, cmd)), "the link never invokes");
        let shared = &self.inner.shared;
        // Fail fast without queueing behind a command that is still waiting for its reply.
        shared.update(|core| core.target())?;
        tokio::time::timeout(timeout, inject(shared, (set, cmd), &body, ids)).await.unwrap_or(Err(LinkError::TimedOut))
    }

    pub fn id_sizes(&self) -> Option<IdSizes> {
        self.inner.shared.update(|core| core.sizes)
    }
}

async fn inject(shared: &Shared, command: (u8, u8), body: &[u8], ids: ReplyIds) -> Result<Vec<u8>, LinkError> {
    let turn: Turn = Arc::new(shared.turn.clone().lock_owned().await);
    let (generation, thread) = shared.update(|core| core.target())?;
    let sizes = shared.update(|core| core.sizes).ok_or(LinkError::NotSuspended)?;
    let mut w = Writer::new();
    w.id(thread, sizes.object);
    let thread = w.into_vec();
    for attempt in 0..SUSPEND_CHECKS {
        if attempt > 0 {
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
        // The check itself may go out during an invoke: that is when the count drops to 0.
        let Some(count) = send(shared, &turn, generation, (11, 12), &thread, ReplyIds::None, false).await? else {
            continue;
        };
        if suspend_count(&count)? > 0
            && let Some(reply) = send(shared, &turn, generation, command, body, ids, true).await?
        {
            return Ok(reply);
        }
    }
    Err(LinkError::Busy)
}

fn suspend_count(body: &[u8]) -> Result<i32, LinkError> {
    let mut r = Reader::new(body);
    let count = r.i32().map_err(|e| LinkError::Protocol(e.to_string()))?;
    match r.remaining() {
        0 => Ok(count),
        extra => Err(LinkError::Protocol(format!("{extra} bytes after SuspendCount"))),
    }
}

/// Writes one command and waits for its reply. `Ok(None)`: not sent, because `idle` was asked
/// and an adapter invoke is pending.
async fn send(
    shared: &Shared,
    turn: &Turn,
    generation: u64,
    (set, cmd): (u8, u8),
    body: &[u8],
    ids: ReplyIds,
    idle: bool,
) -> Result<Option<Vec<u8>>, LinkError> {
    let (answer, reply) = oneshot::channel();
    {
        let mut jvm = shared.jvm.lock().await;
        // Under the writer lock: an adapter resume or invoke is either written already, and
        // seen here, or waits until this command is written.
        let id = shared.update(|core| {
            core.still_stopped(generation)?;
            if idle && !core.invokes.is_empty() {
                return Ok(None);
            }
            Ok(Some(core.register_own(OwnCommand::Inject { ids, answer, _turn: turn.clone() })))
        })?;
        let Some(id) = id else {
            return Ok(None);
        };
        let jvm = jvm.as_mut().ok_or(LinkError::Closed)?;
        let written = async {
            jvm.write_all(&Header::command_bytes(id, set, cmd, body.len())).await?;
            jvm.write_all(body).await?;
            jvm.flush().await
        };
        written.await.map_err(|_| LinkError::Closed)?;
    }
    let mut stops = shared.stops.subscribe();
    tokio::select! {
        reply = reply => {
            // The sender only goes away when the link closes.
            let reply = reply.map_err(|_| LinkError::Closed)?;
            shared.update(|core| core.still_stopped(generation))?;
            reply.map(Some)
        }
        () = stop_ended(&mut stops, generation) => {
            Err(shared.update(|core| core.still_stopped(generation)).err().unwrap_or(LinkError::Stale))
        }
    }
}

async fn stop_ended(stops: &mut watch::Receiver<Option<u64>>, generation: u64) {
    // `let _` drops the borrow at once; holding it would block every state update.
    let _ = stops.wait_for(|stop| *stop != Some(generation)).await;
}
