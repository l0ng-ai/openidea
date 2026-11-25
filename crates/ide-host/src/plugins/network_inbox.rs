//! Bounded inbox for the proposed background network API.
//!
//! Experimental transport-independent primitive. This module does not expose
//! sockets to plugins. Overflow closes the inbox: silently dropping a document
//! update would make a collaboration session appear healthy while diverging.
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Push {
    /// The caller must schedule one plugin wake-up after releasing this lock.
    Wake,
    Queued,
    /// This message was refused and the caller must schedule a wake-up.
    OverflowWake,
    /// This message was refused; a wake-up is already pending.
    OverflowQueued,
    Closed,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Batch {
    pub messages: Vec<Vec<u8>>,
    pub closed: bool,
    pub more: bool,
}

#[derive(Default)]
struct State {
    messages: VecDeque<Box<[u8]>>,
    bytes: usize,
    closed: bool,
    notified: bool,
}

pub(super) struct Inbox {
    state: Mutex<State>,
    max_messages: usize,
    max_bytes: usize,
    max_frame: usize,
}

impl Inbox {
    pub fn new(max_messages: usize, max_bytes: usize, max_frame: usize) -> Self {
        assert!(max_messages > 0 && max_bytes > 0 && max_frame > 0);
        Self { state: Mutex::new(State::default()), max_messages, max_bytes, max_frame }
    }

    pub fn push(&self, message: Vec<u8>) -> Push {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Push::Closed;
        }
        let overflow = message.len() > self.max_frame
            || state.messages.len() >= self.max_messages
            || message.len() > self.max_bytes.saturating_sub(state.bytes);
        if overflow {
            state.closed = true;
        } else {
            state.bytes += message.len();
            state.messages.push_back(message.into_boxed_slice());
        }
        let wake = !state.notified;
        state.notified = true;
        match (overflow, wake) {
            (false, true) => Push::Wake,
            (false, false) => Push::Queued,
            (true, true) => Push::OverflowWake,
            (true, false) => Push::OverflowQueued,
        }
    }

    /// Returns whether the caller must schedule a wake-up. Idempotent.
    pub fn close(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return false;
        }
        state.closed = true;
        let wake = !state.notified;
        state.notified = true;
        wake
    }

    /// A partial drain retains the notification; the consumer must continue
    /// draining when `more` is true. An empty drain rearms the next wake-up.
    pub fn drain(&self, limit: usize) -> Batch {
        assert!(limit > 0);
        let mut state = self.state.lock().unwrap();
        let count = limit.min(state.messages.len());
        let messages: Vec<Vec<u8>> = state.messages.drain(..count).map(|message| message.into_vec()).collect();
        state.bytes -= messages.iter().map(Vec::len).sum::<usize>();
        let more = !state.messages.is_empty();
        state.notified = more;
        Batch { messages, closed: state.closed, more }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_and_rearms_wakeups() {
        let inbox = Inbox::new(4, 16, 8);
        assert_eq!(inbox.push(vec![1]), Push::Wake);
        assert_eq!(inbox.push(vec![2]), Push::Queued);
        assert!(inbox.drain(1).more);
        assert_eq!(inbox.push(vec![3]), Push::Queued);
        assert_eq!(inbox.drain(4).messages, vec![vec![2], vec![3]]);
        assert_eq!(inbox.push(vec![4]), Push::Wake);
    }

    #[test]
    fn overflow_preserves_accepted_messages_and_reports_close() {
        for (messages, bytes, frame) in [(1, 8, 8), (4, 1, 8), (4, 8, 1)] {
            let inbox = Inbox::new(messages, bytes, frame);
            assert_eq!(inbox.push(vec![1]), Push::Wake);
            assert_eq!(inbox.push(vec![2, 3]), Push::OverflowQueued);
            let batch = inbox.drain(4);
            assert_eq!(batch.messages, vec![vec![1]]);
            assert!(batch.closed);
            assert_eq!(inbox.push(vec![]), Push::Closed);
        }
    }

    #[test]
    fn accepted_frame_does_not_retain_excess_capacity() {
        let inbox = Inbox::new(2, 8, 8);
        let mut frame = Vec::with_capacity(1024 * 1024);
        frame.push(42);
        assert_eq!(inbox.push(frame), Push::Wake);
        let state = inbox.state.lock().unwrap();
        assert_eq!(state.bytes, 1);
        assert_eq!(state.messages[0].len(), 1);
        assert_eq!(std::mem::size_of_val(&*state.messages[0]), 1);
    }

    #[test]
    fn close_during_partial_drain_remains_visible_without_duplicate_wakeup() {
        let inbox = Inbox::new(3, 12, 4);
        assert_eq!(inbox.push(vec![1]), Push::Wake);
        assert_eq!(inbox.push(vec![2]), Push::Queued);
        let first = inbox.drain(1);
        assert_eq!(first.messages, vec![vec![1]]);
        assert!(first.more);
        assert!(!inbox.close());
        let second = inbox.drain(1);
        assert_eq!(second.messages, vec![vec![2]]);
        assert!(second.closed);
        assert!(!second.more);
        assert_eq!(inbox.push(vec![3]), Push::Closed);
    }

    #[test]
    fn draining_releases_byte_budget_for_later_messages() {
        let inbox = Inbox::new(2, 4, 4);
        assert_eq!(inbox.push(vec![1, 2, 3, 4]), Push::Wake);
        assert_eq!(inbox.drain(1).messages, vec![vec![1, 2, 3, 4]]);
        assert_eq!(inbox.push(vec![5, 6, 7, 8]), Push::Wake);
        assert_eq!(inbox.drain(1).messages, vec![vec![5, 6, 7, 8]]);
    }

    #[test]
    fn oversized_first_message_requests_wakeup_and_reports_refusal() {
        let inbox = Inbox::new(2, 8, 1);
        assert_eq!(inbox.push(vec![1, 2]), Push::OverflowWake);
        let batch = inbox.drain(2);
        assert!(batch.closed);
        assert!(batch.messages.is_empty());
    }

    #[test]
    fn close_wakes_once_even_without_messages() {
        let inbox = Inbox::new(4, 16, 8);
        assert!(inbox.close());
        assert!(!inbox.close());
        assert!(inbox.drain(4).closed);
        assert_eq!(inbox.push(vec![1]), Push::Closed);
    }

    #[test]
    fn concurrent_producers_remain_bounded_and_fifo_per_producer() {
        let inbox = std::sync::Arc::new(Inbox::new(400, 800, 2));
        std::thread::scope(|scope| {
            for producer in 0..4u8 {
                let inbox = inbox.clone();
                scope.spawn(move || {
                    for index in 0..100u8 {
                        assert_ne!(inbox.push(vec![producer, index]), Push::Closed);
                    }
                });
            }
        });
        let batch = inbox.drain(400);
        assert_eq!(batch.messages.len(), 400);
        assert!(!batch.closed);
        for producer in 0..4u8 {
            let sequence: Vec<_> = batch.messages.iter().filter(|m| m[0] == producer).map(|m| m[1]).collect();
            assert_eq!(sequence, (0..100u8).collect::<Vec<_>>());
        }
    }
}
