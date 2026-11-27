//! Pending `window/showMessageRequest` questions, answered from the UI.
//!
//! The LSP handler runs on a blocking-capable thread (`ide-jsonrpc` promises
//! this), so it can wait for the user's choice. Answers arrive through the
//! `lsp_message_request_answer` command and are matched by a process-wide id;
//! a question that timed out is removed so a late click cannot answer it.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;

static NEXT: AtomicU32 = AtomicU32::new(1);
static PENDING: std::sync::LazyLock<Mutex<HashMap<u32, mpsc::Sender<Option<String>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// At most this many questions may wait for an answer: an unruly server must
/// not pile up modal dialogs or hold many blocking threads.
const MAX_PENDING: usize = 8;

/// Registers a question and returns its id plus the answer receiver. `None`
/// means the cap was reached; the caller must fail closed without asking.
pub fn begin() -> Option<(u32, mpsc::Receiver<Option<String>>)> {
    let mut pending = PENDING.lock();
    if pending.len() >= MAX_PENDING {
        return None;
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending.insert(id, tx);
    Some((id, rx))
}

/// Answers question `id` with the chosen action title, or `None` when dismissed.
pub fn answer(id: u32, choice: Option<String>) -> bool {
    let Some(tx) = PENDING.lock().remove(&id) else { return false };
    tx.send(choice).is_ok()
}

/// Forgets a question that ended without an answer (timeout or shutdown).
pub fn close(id: u32) {
    PENDING.lock().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_resolves_only_once() {
        let (id, rx) = begin().unwrap();
        assert!(answer(id, Some("Rename Anyway".into())));
        assert!(!answer(id, Some("late".into())));
        assert_eq!(rx.recv().unwrap(), Some("Rename Anyway".into()));
    }

    #[test]
    fn close_ignores_late_answers() {
        let (id, _rx) = begin().unwrap();
        close(id);
        assert!(!answer(id, None));
    }
}
