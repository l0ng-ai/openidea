//! Cancellable requests: the UI allocates ids, `cancel_request` cancels.
//!
//! A cancel can arrive before the command that owns the id has begun: the UI shows
//! a task (with Cancel) and then awaits other work first (saving documents, a
//! queue, a branch lookup), or the command waits for something before it gets to
//! `begin`. Such a cancel is remembered for a while so the request starts out
//! cancelled instead of running to the end.

use ide_core::{CancellationToken, RequestId};
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// How long a cancel for a request that has not begun is remembered.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(120);
/// At most this many are remembered (ids of finished requests end up here too).
const EARLY_CANCEL_MAX: usize = 1024;

#[derive(Default)]
pub(crate) struct Requests {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    running: HashMap<RequestId, CancellationToken>,
    /// Cancelled before they began, oldest first.
    early: VecDeque<(RequestId, Instant)>,
}

impl Inner {
    fn prune(&mut self, now: Instant) {
        while self.early.front().is_some_and(|(_, at)| now.duration_since(*at) > EARLY_CANCEL_TTL)
            || self.early.len() > EARLY_CANCEL_MAX
        {
            self.early.pop_front();
        }
    }
}

impl Requests {
    pub(crate) fn begin(&self, id: RequestId) -> CancellationToken {
        let token = CancellationToken::new();
        let mut inner = self.inner.lock();
        inner.prune(Instant::now());
        if let Some(i) = inner.early.iter().position(|(early, _)| *early == id) {
            inner.early.remove(i);
            token.cancel();
            return token;
        }
        if let Some(old) = inner.running.insert(id, token.clone()) {
            old.cancel();
        }
        token
    }

    pub(crate) fn end(&self, id: RequestId) {
        self.inner.lock().running.remove(&id);
    }

    pub(crate) fn cancel(&self, id: RequestId) {
        let mut inner = self.inner.lock();
        match inner.running.remove(&id) {
            Some(token) => token.cancel(),
            None => {
                let now = Instant::now();
                inner.early.push_back((id, now));
                inner.prune(now);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reaches_a_running_request() {
        let r = Requests::default();
        let token = r.begin(RequestId(1));
        assert!(!token.is_cancelled());
        r.cancel(RequestId(1));
        assert!(token.is_cancelled());
    }

    #[test]
    fn a_cancel_before_begin_cancels_the_request_when_it_begins() {
        let r = Requests::default();
        r.cancel(RequestId(7));
        assert!(r.begin(RequestId(7)).is_cancelled());
        // Only once: the id is not cancelled for good.
        assert!(!r.begin(RequestId(7)).is_cancelled());
        assert!(!r.begin(RequestId(8)).is_cancelled());
    }

    #[test]
    fn early_cancels_are_bounded() {
        let r = Requests::default();
        for i in 0..(EARLY_CANCEL_MAX as u32 + 10) {
            r.cancel(RequestId(i));
        }
        assert_eq!(r.inner.lock().early.len(), EARLY_CANCEL_MAX);
        assert!(!r.begin(RequestId(0)).is_cancelled(), "the oldest were dropped");
        assert!(r.begin(RequestId(EARLY_CANCEL_MAX as u32 + 9)).is_cancelled());
    }

    #[test]
    fn a_finished_request_is_not_cancelled_again() {
        let r = Requests::default();
        let token = r.begin(RequestId(3));
        r.end(RequestId(3));
        r.cancel(RequestId(3));
        assert!(!token.is_cancelled());
    }
}
