//! Cancelling background tasks the backend reports itself ([`IdeEvent::Task`](crate::IdeEvent)
//! with `cancellable`), such as a language server's work-done progress. Requests the UI
//! starts are cancelled through their `RequestId` instead.

use crate::TaskId;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

type Cancel = Box<dyn FnOnce() + Send>;

static CANCELS: Mutex<Option<HashMap<TaskId, Cancel>>> = Mutex::new(None);

fn cancels() -> MutexGuard<'static, Option<HashMap<TaskId, Cancel>>> {
    CANCELS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Keeps task `id` cancellable with [`cancel`] until dropped (when the task ends).
#[must_use = "the task stops being cancellable when this is dropped"]
pub struct CancelHandle(TaskId);

impl Drop for CancelHandle {
    fn drop(&mut self) {
        if let Some(map) = cancels().as_mut() {
            map.remove(&self.0);
        }
    }
}

/// Makes task `id` cancellable: [`cancel`] runs `f` once, while the handle lives.
pub fn on_cancel(id: TaskId, f: impl FnOnce() + Send + 'static) -> CancelHandle {
    cancels().get_or_insert_with(HashMap::new).insert(id, Box::new(f));
    CancelHandle(id)
}

/// Cancels task `id`; false when it is not cancellable (or already ended / cancelled).
pub fn cancel(id: TaskId) -> bool {
    let f = cancels().as_mut().and_then(|map| map.remove(&id));
    match f {
        Some(f) => {
            f();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cancel_runs_the_callback_once_while_the_handle_lives() {
        let hits = Arc::new(AtomicUsize::new(0));
        let id = TaskId::next();
        let h = hits.clone();
        let handle = on_cancel(id, move || {
            h.fetch_add(1, Ordering::SeqCst);
        });
        assert!(cancel(id));
        assert!(!cancel(id));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        drop(handle);

        let other = TaskId::next();
        let h = hits.clone();
        drop(on_cancel(other, move || {
            h.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(!cancel(other), "an ended task is not cancelled");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
