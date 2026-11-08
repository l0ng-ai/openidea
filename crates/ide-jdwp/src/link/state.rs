//! The link's state machine, kept under `Shared::core`.

use super::ledger::{DISPOSE_CHUNK, Ledger};
use super::{LinkError, LinkState, OWN_IDS};
use crate::codec::{Header, Reader};
use crate::ids::{IdSizes, ReplyIds, dispose_body, object_ids, stop_of};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{OwnedMutexGuard, oneshot};

/// The right to have an injected command in flight. Each pending command holds a clone, so the
/// next command waits for the previous reply even when its caller stopped waiting.
pub(super) type Turn = Arc<OwnedMutexGuard<()>>;

pub(super) type Answer = oneshot::Sender<Result<Vec<u8>, LinkError>>;

/// A command of the link's own. None of them invokes a method or otherwise waits for the VM to
/// run: the JVM answers each one straight away, which `upstream::forward` relies on when an
/// adapter command reuses a pending id.
pub(super) enum OwnCommand {
    IdSizes,
    /// `VirtualMachine.DisposeObjects`; the reply is dropped.
    Dispose,
    /// `ids`: where the reply carries ObjectIDs the ledger must count.
    Inject {
        ids: ReplyIds,
        answer: Answer,
        _turn: Turn,
    },
}

#[derive(Default)]
pub(super) struct Core {
    pub(super) hold: bool,
    pub(super) connected: bool,
    pub(super) handshaken: bool,
    pub(super) released: bool,
    pub(super) stopped: bool,
    pub(super) thread: Option<u64>,
    pub(super) generation: u64,
    pub(super) degraded: Option<String>,
    pub(super) closed: bool,
    pub(super) sizes: Option<IdSizes>,
    /// Body of the current stop's event when it arrived before `sizes`.
    pub(super) unread_stop: Option<Vec<u8>>,
    /// Ids of adapter invokes the JVM has not answered yet.
    pub(super) invokes: HashSet<u32>,
    /// The link's commands the JVM has not answered yet. An entry leaves only when its reply
    /// arrives or the link closes: a caller that stops waiting leaves it here, so the late
    /// reply is still counted and never taken for the adapter's.
    pub(super) own: HashMap<u32, OwnCommand>,
    /// Adapter commands with an id in [`OWN_IDS`] the JVM has not answered yet, per id.
    pub(super) adapter_reserved: HashMap<u32, u32>,
    pub(super) next_own: u32,
    pub(super) ledger: Ledger,
}

/// Who gets a reply from the JVM.
pub(super) enum Route {
    Own(OwnCommand),
    Adapter,
    /// In [`OWN_IDS`] but nobody is waiting for it.
    Nobody,
}

impl Core {
    pub(super) fn state(&self) -> LinkState {
        if self.closed {
            LinkState::Closed
        } else if let Some(reason) = &self.degraded {
            LinkState::Degraded(reason.clone())
        } else if !self.connected {
            LinkState::Connecting
        } else if !self.handshaken {
            LinkState::Handshaking
        } else if self.stopped {
            LinkState::Suspended { generation: self.generation, thread: self.thread }
        } else if self.hold && !self.released {
            LinkState::Held
        } else {
            LinkState::Ready
        }
    }

    /// Call under the JVM writer lock, so the id is pending before an adapter command with the
    /// same id can be written. `command` must not invoke (see [`OwnCommand`]).
    pub(super) fn register_own(&mut self, command: OwnCommand) -> u32 {
        loop {
            let id = self.next_own;
            self.next_own = if id + 1 >= OWN_IDS.end { OWN_IDS.start } else { id + 1 };
            if !self.own.contains_key(&id) && !self.adapter_reserved.contains_key(&id) {
                self.own.insert(id, command);
                return id;
            }
        }
    }

    /// Two pending commands never share a reserved id (see `upstream::forward`), so a reply's
    /// id alone names its owner.
    pub(super) fn route_reply(&mut self, id: u32) -> Route {
        if let Some(own) = self.own.remove(&id) {
            return Route::Own(own);
        }
        if OWN_IDS.contains(&id) {
            let Some(pending) = self.adapter_reserved.get_mut(&id) else {
                return Route::Nobody;
            };
            *pending -= 1;
            if *pending == 0 {
                self.adapter_reserved.remove(&id);
            }
        }
        self.invokes.remove(&id);
        Route::Adapter
    }

    pub(super) fn own_reply(&mut self, command: OwnCommand, header: &Header, body: Vec<u8>) {
        match command {
            OwnCommand::IdSizes if header.error() == 0 => match IdSizes::parse(&body) {
                Ok(sizes) => {
                    self.sizes = Some(sizes);
                    if let Some(event) = self.unread_stop.take() {
                        self.thread = stop_of(&event, &sizes).and_then(|stop| stop.thread);
                    }
                }
                Err(e) => tracing::warn!("JDWP link: malformed IDSizes reply: {e}"),
            },
            OwnCommand::IdSizes => tracing::warn!("JDWP link: IDSizes failed with error {}", header.error()),
            OwnCommand::Dispose => {}
            OwnCommand::Inject { ids, answer, _turn } => {
                let result = self.count(ids, header, body);
                // The caller may have given up; the ids are counted either way.
                let _ = answer.send(result);
            }
        }
    }

    fn count(&mut self, layout: ReplyIds, header: &Header, body: Vec<u8>) -> Result<Vec<u8>, LinkError> {
        if header.error() != 0 {
            return Err(LinkError::Jdwp(header.error()));
        }
        let sizes = self.sizes.ok_or_else(|| LinkError::Protocol("no id sizes".into()))?;
        match object_ids(layout, &body, &sizes) {
            Ok(ids) => {
                self.ledger.record(&ids);
                Ok(body)
            }
            Err(e) => {
                // Leaking ids is safe; releasing ids the JVM did not hand out aborts it.
                tracing::warn!("JDWP link: reply {:#x} does not match {layout:?}, its ids leak: {e}", header.id);
                Err(LinkError::Protocol(e.to_string()))
            }
        }
    }

    /// Where an injected command would run: the current stop's generation and thread, and the
    /// id sizes to write the thread with.
    pub(super) fn target(&self) -> Result<(u64, u64, IdSizes), LinkError> {
        if self.closed {
            return Err(LinkError::Closed);
        }
        if self.degraded.is_some() {
            return Err(LinkError::Degraded);
        }
        match (self.stopped, self.sizes, self.thread) {
            (true, Some(sizes), Some(thread)) => Ok((self.generation, thread, sizes)),
            _ => Err(LinkError::NotSuspended),
        }
    }

    /// Whether stop `generation` still lets the link write a command of its own.
    pub(super) fn still_stopped(&self, generation: u64) -> Result<(), LinkError> {
        if self.closed {
            Err(LinkError::Closed)
        } else if self.degraded.is_some() {
            Err(LinkError::Degraded)
        } else if self.stopped && self.generation == generation {
            Ok(())
        } else {
            Err(LinkError::Stale)
        }
    }

    /// `DisposeObjects` packets for everything in the ledger, to write right after the
    /// adapter's resume. None while `Degraded`: the link sends nothing then, and leaks.
    pub(super) fn disposals(&mut self) -> Vec<Vec<u8>> {
        let Some(sizes) = self.sizes.filter(|_| !self.closed && self.degraded.is_none()) else {
            return Vec::new();
        };
        let entries = self.ledger.drain();
        entries
            .chunks(DISPOSE_CHUNK)
            .map(|chunk| {
                let body = dispose_body(chunk, &sizes);
                let id = self.register_own(OwnCommand::Dispose);
                let mut packet = Header::command_bytes(id, 1, 14, body.len()).to_vec();
                packet.extend_from_slice(&body);
                packet
            })
            .collect()
    }

    /// Terminal. Pending commands fail and the ledger is dropped unreleased: after
    /// `VirtualMachine.Dispose` the ids are gone anyway.
    pub(super) fn close(&mut self) {
        self.closed = true;
        self.own.clear();
        self.ledger.clear();
    }

    /// A `Composite` event: any event whose policy suspends something starts a new stop.
    pub(super) fn event(&mut self, body: &[u8]) {
        match self.sizes {
            Some(sizes) => {
                if let Some(stop) = stop_of(body, &sizes).filter(|stop| stop.suspend_policy != 0) {
                    self.begin_stop(stop.thread, None);
                }
            }
            None => {
                let mut r = Reader::new(body);
                if r.u8().is_ok_and(|policy| policy != 0) && r.count().is_ok_and(|n| n > 0) {
                    self.begin_stop(None, Some(body.to_vec()));
                }
            }
        }
    }

    fn begin_stop(&mut self, thread: Option<u64>, unread: Option<Vec<u8>>) {
        self.generation += 1;
        self.stopped = true;
        self.thread = thread;
        self.unread_stop = unread;
    }

    pub(super) fn end_stop(&mut self) {
        self.stopped = false;
        self.thread = None;
        self.unread_stop = None;
    }
}
