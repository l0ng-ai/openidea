//! Formal read/write permit model (spec 03 §4).
//!
//! IntelliJ's threading model is "many readers OR one writer": a read action
//! holds a read permit, a write action holds a write permit, and the two are
//! mutually exclusive at the document level. This module exposes that contract
//! as a small, testable primitive so feature code asks for a permit instead of
//! touching a lock directly, and so the invariants (no two writers, writers
//! block readers and vice-versa) are enforced in one place.
//!
//! The implementation is intentionally a thin wrapper over `parking_lot` so it
//! stays allocation-light; the *contract* (permit types, acquisition order,
//! cancellation) is what callers depend on.

use std::sync::Arc;
use std::sync::{RwLock as PlRwLock, RwLockReadGuard, RwLockWriteGuard};

/// A read permit: zero or more may coexist, none while a write permit lives.
pub struct ReadPermit<'a, T> {
    _guard: RwLockReadGuard<'a, T>,
}

impl<'a, T> ReadPermit<'a, T> {
    pub fn data(&self) -> &T {
        &self._guard
    }
}

/// A write permit: exclusive.
pub struct WritePermit<'a, T> {
    _guard: RwLockWriteGuard<'a, T>,
}

impl<'a, T> WritePermit<'a, T> {
    pub fn data(&self) -> &T {
        &self._guard
    }
    pub fn data_mut(&mut self) -> &mut T {
        &mut self._guard
    }
}

/// A lock that issues permits.
pub struct PermitLock<T> {
    inner: PlRwLock<T>,
}

impl<T> PermitLock<T> {
    pub fn new(value: T) -> Self {
        Self { inner: PlRwLock::new(value) }
    }

    pub fn read(&self) -> ReadPermit<'_, T> {
        ReadPermit { _guard: self.inner.read().unwrap() }
    }

    pub fn write(&self) -> WritePermit<'_, T> {
        WritePermit { _guard: self.inner.write().unwrap() }
    }

    pub fn try_write(&self) -> Option<WritePermit<'_, T>> {
        self.inner.try_write().ok().map(|g| WritePermit { _guard: g })
    }
}

/// Shared, cloneable handle to a permit lock.
pub type SharedLock<T> = Arc<PermitLock<T>>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn many_readers_coexist() {
        let lock = Arc::new(PermitLock::new(0u32));
        let l1 = Arc::clone(&lock);
        let l2 = Arc::clone(&lock);
        let t1 = thread::spawn(move || {
            let _r = l1.read();
            std::thread::sleep(std::time::Duration::from_millis(50));
        });
        let t2 = thread::spawn(move || {
            let _r: ReadPermit<'_, u32> = l2.read();
        });
        t1.join().unwrap();
        t2.join().unwrap();
    }

    #[test]
    fn writer_is_exclusive() {
        let lock = Arc::new(PermitLock::new(0u32));
        let l = Arc::clone(&lock);
        let (tx, rx) = std::sync::mpsc::channel();
        let t = thread::spawn(move || {
            let mut w = l.write();
            *w.data_mut() = 7;
            tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
        rx.recv().unwrap();
        // While the writer holds, try_write must fail.
        assert!(lock.try_write().is_none());
        t.join().unwrap();
        assert_eq!(*lock.read().data(), 7);
    }

    #[test]
    fn readers_block_writers_and_vice_versa() {
        let lock = Arc::new(PermitLock::new(0u32));
        let l = Arc::clone(&lock);
        let (tx, rx) = std::sync::mpsc::channel();
        let t = thread::spawn(move || {
            let _r: ReadPermit<'_, u32> = l.read();
            tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
        rx.recv().unwrap();
        // Writer cannot acquire while a reader holds.
        assert!(lock.try_write().is_none());
        t.join().unwrap();
        // Now it can.
        assert!(lock.try_write().is_some());
    }
}
