//! The link's own commands, injected while the VM is stopped.

use super::state::{Core, OwnCommand, Turn};
use super::{JdwpLink, JvmWriter, Shared, upstream};
use crate::codec::{Header, Reader, Writer};
use crate::ids::{IdSizes, ReplyIds};
use std::io;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, oneshot, watch};

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
    /// and no adapter invoke pending, checked up to five times 100 ms apart. It runs in the stop
    /// current at the call: once that stop ends, also while the command waits for an earlier
    /// one, it fails with [`LinkError::Stale`].
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
        let target = shared.update(|core| core.target())?;
        let injected = inject(shared, target, (set, cmd), &body, ids);
        tokio::time::timeout(timeout, injected).await.unwrap_or(Err(LinkError::TimedOut))
    }

    pub fn id_sizes(&self) -> Option<IdSizes> {
        self.inner.shared.update(|core| core.sizes)
    }
}

async fn inject(
    shared: &Shared,
    (generation, thread, sizes): (u64, u64, IdSizes),
    command: (u8, u8),
    body: &[u8],
    ids: ReplyIds,
) -> Result<Vec<u8>, LinkError> {
    // The turn may stay taken past the end of the stop: an earlier command holds it until its
    // reply arrives.
    let mut stops = shared.stops.subscribe();
    let turn: Turn = tokio::select! {
        turn = shared.turn.clone().lock_owned() => Arc::new(turn),
        () = stop_ended(&mut stops, generation) => return Err(ended(shared, generation)),
    };
    shared.update(|core| core.still_stopped(generation))?;
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
        let writer = jvm.as_mut().ok_or(LinkError::Closed)?;
        // What a cancelled packet left unwritten goes first.
        if let Err(e) = writer.finish().await {
            return Err(broken(shared, &mut jvm, &e));
        }
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
        let mut packet = Header::command_bytes(id, set, cmd, body.len()).to_vec();
        packet.extend_from_slice(body);
        writer.queue(packet);
        // A caller that gives up from here on leaves the rest of the packet to the relay; the
        // entry stays until the reply.
        let mut cancelled = WakeRelay(Some(&shared.unfinished));
        let written = writer.finish().await;
        cancelled.0 = None;
        if let Err(e) = written {
            return Err(broken(shared, &mut jvm, &e));
        }
    }
    let mut stops = shared.stops.subscribe();
    tokio::select! {
        reply = reply => {
            // The sender only goes away when the link closes.
            let reply = reply.map_err(|_| LinkError::Closed)?;
            shared.update(|core| core.still_stopped(generation))?;
            reply.map(Some)
        }
        () = stop_ended(&mut stops, generation) => Err(ended(shared, generation)),
    }
}

/// Wakes the relay when dropped while set.
struct WakeRelay<'a>(Option<&'a Notify>);

impl Drop for WakeRelay<'_> {
    fn drop(&mut self) {
        if let Some(relay) = self.0 {
            relay.notify_one();
        }
    }
}

/// A failed write may have left part of a packet with the JVM, so nothing else may follow it.
fn broken(shared: &Shared, jvm: &mut Option<JvmWriter>, e: &io::Error) -> LinkError {
    tracing::debug!("JDWP link: writing a command of its own failed: {e}");
    shared.update(Core::close);
    *jvm = None;
    // The relay ends once it finds the writer gone.
    shared.unfinished.notify_one();
    LinkError::Closed
}

/// Why stop `generation` no longer lets a command run.
fn ended(shared: &Shared, generation: u64) -> LinkError {
    shared.update(|core| core.still_stopped(generation)).err().unwrap_or(LinkError::Stale)
}

async fn stop_ended(stops: &mut watch::Receiver<Option<u64>>, generation: u64) {
    // `let _` drops the borrow at once; holding it would block every state update.
    let _ = stops.wait_for(|stop| *stop != Some(generation)).await;
}
