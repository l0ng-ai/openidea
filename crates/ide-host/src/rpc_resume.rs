//! Remote session resume: tokens, epochs and idempotent replay (spec 17).
//!
//! A thin client loses its SSH channel; the server keeps the project alive for
//! a while. On reconnect the client presents a [`ResumeToken`] naming the
//! session and the generation (epoch) it last saw. The server bumps a
//! [`GenerationClock`] for that session: patches minted for an older epoch are
//! rejected at the publish boundary, so replaying an edit never applies twice.
//!
//! This module is pure protocol logic — no sockets, no filesystem — so the
//! reconnect/replay invariants are testable without a live remote host.

use ide_core::generation::{Generation, GenerationClock, StaleReason};
use ide_core::DocId;
use std::collections::{HashMap, HashSet, VecDeque};

/// What a client presents on reconnect.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeToken {
    pub session_id: String,
    /// Last generation the client fully applied.
    pub epoch: u64,
}

/// The server-side view of one resumable session.
pub struct SessionState {
    clock: GenerationClock,
    /// Idempotency keys the server has already applied for this session.
    applied: HashSet<u64>,
}

impl SessionState {
    pub fn new(session_id: &str) -> Self {
        // A DocId is just a stable numeric identity; the token's string id is
        // kept separately so no real document is implied.
        let _ = session_id;
        Self { clock: GenerationClock::new(DocId::next()), applied: HashSet::new() }
    }

    pub fn epoch(&self) -> u64 {
        self.clock.current()
    }

    /// A reconnect: everything minted for the previous epoch becomes stale.
    pub fn resume(&self, token: &ResumeToken) -> Result<Generation, ResumeError> {
        if token.epoch > self.epoch() {
            return Err(ResumeError::FutureEpoch { presented: token.epoch, current: self.epoch() });
        }
        self.clock.bump();
        Ok(self.clock.mint())
    }

    /// Applies one replayed edit exactly once. Returns `false` for a duplicate
    /// key, `true` when it is applied. A `generation` from an older epoch is
    /// rejected before the key is even recorded.
    pub fn apply_once(&mut self, generation: &Generation, key: u64) -> Result<bool, ResumeError> {
        if !generation.is_current() {
            return Err(ResumeError::StaleEpoch(StaleReason::Superseded));
        }
        if generation.is_cancelled() {
            return Err(ResumeError::StaleEpoch(StaleReason::Cancelled));
        }
        Ok(self.applied.insert(key))
    }

    pub fn applied_count(&self) -> usize {
        self.applied.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResumeError {
    /// The client claims an epoch the server has not reached.
    FutureEpoch { presented: u64, current: u64 },
    /// The patch belongs to an epoch that a reconnect already superseded.
    StaleEpoch(StaleReason),
}

impl std::fmt::Display for ResumeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FutureEpoch { presented, current } => {
                write!(f, "resume epoch {presented} is ahead of server epoch {current}")
            }
            Self::StaleEpoch(reason) => write!(f, "patch from a superseded session ({reason:?})"),
        }
    }
}

/// Client-side replay buffer: inputs collected while offline, replayed in order
/// on reconnect. Bounded so a long outage cannot grow memory without limit.
pub struct OfflineBuffer<T> {
    pending: VecDeque<(u64, T)>,
    next_key: u64,
    capacity: usize,
}

impl<T> OfflineBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        Self { pending: VecDeque::new(), next_key: 1, capacity: capacity.max(1) }
    }

    /// Records one offline input and returns its idempotency key. When the
    /// buffer is full, the oldest input is dropped (its key is never reused).
    pub fn push(&mut self, value: T) -> u64 {
        let key = self.next_key;
        self.next_key += 1;
        if self.pending.len() == self.capacity {
            self.pending.pop_front();
        }
        self.pending.push_back((key, value));
        key
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Everything to replay, in insertion order. Drains the buffer.
    pub fn drain(&mut self) -> Vec<(u64, T)> {
        self.pending.drain(..).collect()
    }
}

/// Tracks many sessions at once (one server, several thin clients).
#[derive(Default)]
pub struct ResumeRegistry {
    sessions: HashMap<String, SessionState>,
}

impl ResumeRegistry {
    pub fn resume(&mut self, token: &ResumeToken) -> Result<(Generation, u64), ResumeError> {
        let state = self
            .sessions
            .entry(token.session_id.clone())
            .or_insert_with(|| SessionState::new(&token.session_id));
        let generation = state.resume(token)?;
        Ok((generation, state.epoch()))
    }

    pub fn apply_once(&mut self, session_id: &str, generation: &Generation, key: u64) -> Result<bool, ResumeError> {
        let state = self
            .sessions
            .get_mut(session_id)
            .ok_or(ResumeError::StaleEpoch(StaleReason::Superseded))?;
        state.apply_once(generation, key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(epoch: u64) -> ResumeToken {
        ResumeToken { session_id: "thin-client-1".into(), epoch }
    }

    #[test]
    fn reconnect_bumps_the_epoch_and_invalidates_old_patches() {
        let mut sessions = ResumeRegistry::default();
        let (first, epoch1) = sessions.resume(&token(0)).unwrap();
        assert_eq!(epoch1, 1);
        assert!(sessions.apply_once("thin-client-1", &first, 1).unwrap());
        assert!(!sessions.apply_once("thin-client-1", &first, 1).unwrap(), "duplicate key is a no-op");

        let (second, epoch2) = sessions.resume(&token(1)).unwrap();
        assert_eq!(epoch2, 2);
        assert!(matches!(
            sessions.apply_once("thin-client-1", &first, 2),
            Err(ResumeError::StaleEpoch(StaleReason::Superseded))
        ));
        assert!(sessions.apply_once("thin-client-1", &second, 2).unwrap());
    }

    #[test]
    fn replaying_the_same_offline_buffer_never_applies_an_edit_twice() {
        let mut sessions = ResumeRegistry::default();
        let (generation, epoch) = sessions.resume(&token(0)).unwrap();
        let mut offline = OfflineBuffer::new(8);
        let keys: Vec<u64> = (0..3).map(|i| offline.push(format!("edit-{i}"))).collect();
        assert_eq!(offline.len(), 3);

        let batch = offline.drain();
        assert!(offline.is_empty(), "drain empties the buffer");
        for (key, _edit) in &batch {
            assert!(sessions.apply_once("thin-client-1", &generation, *key).unwrap(), "first apply");
        }
        // A duplicated replay (same keys, e.g. after an ack timeout) is idempotent.
        for (key, _edit) in &batch {
            assert!(!sessions.apply_once("thin-client-1", &generation, *key).unwrap(), "replay is a no-op");
        }
        assert_eq!(keys.len(), 3);
        let state = sessions.sessions.get("thin-client-1").unwrap();
        assert_eq!(state.applied_count(), 3);
        assert_eq!(epoch, 1);
    }

    #[test]
    fn a_future_epoch_is_rejected_instead_of_rewinding_the_server() {
        let mut sessions = ResumeRegistry::default();
        let result = sessions.resume(&token(9));
        assert!(
            matches!(result, Err(ResumeError::FutureEpoch { presented: 9, current: 0 })),
            "a future epoch must be rejected"
        );
    }

    #[test]
    fn an_offline_buffer_is_bounded_and_never_reuses_a_key() {
        let mut buffer = OfflineBuffer::new(2);
        let a = buffer.push("a");
        let _b = buffer.push("b");
        let c = buffer.push("c"); // evicts a
        assert_eq!(buffer.len(), 2);
        assert_ne!(a, c);
        let batch = buffer.drain();
        assert_eq!(batch.iter().map(|(k, _)| *k).collect::<Vec<_>>(), vec![a + 1, c]);
        assert_eq!(buffer.drain().len(), 0);
    }

    #[test]
    fn a_cancelled_session_publishes_nothing() {
        let mut sessions = ResumeRegistry::default();
        let (generation, _) = sessions.resume(&token(0)).unwrap();
        generation.cancel();
        assert!(matches!(
            sessions.apply_once("thin-client-1", &generation, 1),
            Err(ResumeError::StaleEpoch(StaleReason::Cancelled))
        ));
    }
}
