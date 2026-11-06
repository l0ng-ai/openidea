//! The background inspection run: debounced after document changes,
//! cancelled by newer ones, published as `IdeEvent::Diagnostics`.
//!
//! One thread per engine waits for the earliest scheduled document whose
//! debounce has passed, inspects it with a fresh cancellation token (a
//! change to the same document during the run cancels it and schedules it
//! again) and publishes the diagnostics unless it was cancelled or the
//! document closed meanwhile. Closing a document clears what was published
//! for it; stopping the engine clears everything.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ide_core::{CancellationToken, DocId, IdeEvent, SharedSink};
use parking_lot::{Condvar, Mutex};

use super::Inspected;
use crate::engine::PhpEngine;
use crate::syntax::DIAGNOSTIC_SOURCE;

/// How long after the last change a document is inspected.
pub(crate) const DEBOUNCE: Duration = Duration::from_millis(120);

#[derive(Default)]
struct Queue {
    /// Documents to inspect, with when.
    pending: HashMap<DocId, Instant>,
    running: Option<(DocId, CancellationToken)>,
    /// The paths diagnostics were published for.
    published: HashMap<DocId, PathBuf>,
    shutdown: bool,
}

/// The state the engine and the inspection thread share.
#[derive(Default)]
pub(crate) struct Runner {
    queue: Mutex<Queue>,
    wake: Condvar,
    idle: Condvar,
    /// The latest result of each open document.
    results: Mutex<HashMap<DocId, Arc<Inspected>>>,
}

impl Runner {
    /// Inspects `doc` after the debounce, cancelling a run of it in progress.
    pub(crate) fn schedule(&self, doc: DocId) {
        let mut q = self.queue.lock();
        if q.shutdown {
            return;
        }
        q.pending.insert(doc, Instant::now() + DEBOUNCE);
        if let Some((running, token)) = &q.running
            && *running == doc
        {
            token.cancel();
        }
        drop(q);
        self.wake.notify_all();
    }

    /// The document closed: nothing more is published for it, and what was
    /// is cleared.
    pub(crate) fn closed(&self, doc: DocId, sink: &SharedSink) {
        let mut q = self.queue.lock();
        q.pending.remove(&doc);
        if let Some((running, token)) = &q.running
            && *running == doc
        {
            token.cancel();
        }
        self.results.lock().remove(&doc);
        if let Some(path) = q.published.remove(&doc) {
            sink.emit(clear(path));
        }
        drop(q);
        self.idle.notify_all();
    }

    pub(crate) fn result(&self, doc: DocId) -> Option<Arc<Inspected>> {
        self.results.lock().get(&doc).cloned()
    }

    pub(crate) fn store(&self, inspected: Arc<Inspected>) {
        self.results.lock().insert(inspected.doc, inspected);
    }

    pub(crate) fn forget_results(&self) {
        self.results.lock().clear();
    }

    /// Blocks until nothing is pending or running. False on timeout.
    pub(crate) fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut q = self.queue.lock();
        while !q.shutdown && (!q.pending.is_empty() || q.running.is_some()) {
            if self.idle.wait_until(&mut q, deadline).timed_out() {
                return q.shutdown || (q.pending.is_empty() && q.running.is_none());
            }
        }
        true
    }

    /// Starts the inspection thread; it ends when the engine is gone or
    /// [`stop`](Self::stop) is called.
    pub(crate) fn start(self: &Arc<Self>, engine: Weak<PhpEngine>, sink: SharedSink) -> Option<JoinHandle<()>> {
        let runner = self.clone();
        let spawned =
            std::thread::Builder::new().name("openidea-php-inspections".into()).spawn(move || runner.run(engine, sink));
        match spawned {
            Ok(handle) => Some(handle),
            Err(e) => {
                tracing::warn!("php inspections: {e}");
                None
            }
        }
    }

    /// Stops the thread (joined unless this is it) and clears what was
    /// published.
    pub(crate) fn stop(&self, thread: Option<JoinHandle<()>>, sink: &SharedSink) {
        {
            let mut q = self.queue.lock();
            q.shutdown = true;
            q.pending.clear();
            if let Some((_, token)) = &q.running {
                token.cancel();
            }
        }
        self.wake.notify_all();
        self.idle.notify_all();
        if let Some(thread) = thread
            && thread.thread().id() != std::thread::current().id()
            && thread.join().is_err()
        {
            tracing::warn!("php inspections thread panicked");
        }
        let published: Vec<PathBuf> = self.queue.lock().published.drain().map(|(_, path)| path).collect();
        for path in published {
            sink.emit(clear(path));
        }
        self.results.lock().clear();
    }

    fn run(&self, engine: Weak<PhpEngine>, sink: SharedSink) {
        while let Some((doc, token)) = self.next() {
            let Some(engine) = engine.upgrade() else { break };
            let inspected = engine.inspect(doc, &token);
            {
                let mut q = self.queue.lock();
                q.running = None;
                if let Some(inspected) = inspected
                    && !token.is_cancelled()
                    && !q.shutdown
                    && engine.is_open(doc)
                {
                    sink.emit(IdeEvent::Diagnostics {
                        path: inspected.path.clone().into(),
                        source: DIAGNOSTIC_SOURCE.into(),
                        items: inspected.diagnostics.clone(),
                    });
                    q.published.insert(doc, inspected.path.clone());
                    self.results.lock().insert(doc, Arc::new(inspected));
                }
            }
            self.idle.notify_all();
            // Dropping the last handle on the engine here shuts it down,
            // which doesn't join this thread.
            drop(engine);
        }
        let mut q = self.queue.lock();
        q.running = None;
        q.pending.clear();
        drop(q);
        self.idle.notify_all();
    }

    /// Waits for the next document whose debounce has passed; `None` once
    /// stopped.
    fn next(&self) -> Option<(DocId, CancellationToken)> {
        let mut q = self.queue.lock();
        loop {
            if q.shutdown {
                return None;
            }
            let earliest = q.pending.iter().min_by_key(|(_, due)| **due).map(|(doc, due)| (*doc, *due));
            match earliest {
                Some((doc, due)) if due <= Instant::now() => {
                    q.pending.remove(&doc);
                    let token = CancellationToken::new();
                    q.running = Some((doc, token.clone()));
                    return Some((doc, token));
                }
                Some((_, due)) => {
                    self.wake.wait_until(&mut q, due);
                }
                None => {
                    self.idle.notify_all();
                    self.wake.wait(&mut q);
                }
            }
        }
    }
}

fn clear(path: PathBuf) -> IdeEvent {
    IdeEvent::Diagnostics { path: path.into(), source: DIAGNOSTIC_SOURCE.into(), items: Vec::new() }
}
