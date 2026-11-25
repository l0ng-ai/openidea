use std::sync::{Mutex, MutexGuard};

static SERIAL: Mutex<()> = Mutex::new(());

/// Held for a whole test that binds or accepts on a socket or spawns a process. macOS sets
/// close-on-exec on a new socket only after `socket()` returns, so a child spawned meanwhile by
/// another test inherits the listening fd and keeps a dropped listener connectable.
pub fn hold() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
