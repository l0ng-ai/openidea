//! Host-owned diagnostics snapshot: every `Diagnostics` event lands here, whoever
//! emitted it and whatever window it was addressed to. Plugins read this instead of
//! the UI-reported Problems reports, so what a plugin sees no longer depends on
//! window lifetime, the invoking window's project, or the report loop's liveness.

use ide_core::{Diagnostic, EventSink, IdeEvent, IpcPath, SharedSink};
use parking_lot::RwLock;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Default)]
pub struct DiagnosticsStore(RwLock<BTreeMap<PathBuf, BTreeMap<String, Vec<Diagnostic>>>>);

impl DiagnosticsStore {
    /// Full replacement for one (file, producer), like the event itself.
    pub fn replace(&self, path: &PathBuf, source: &str, items: Vec<Diagnostic>) {
        let mut map = self.0.write();
        let sources = map.entry(path.clone()).or_default();
        if items.is_empty() {
            sources.remove(source);
            if sources.is_empty() {
                map.remove(path);
            }
        } else {
            sources.insert(source.to_owned(), items);
        }
    }

    /// Every file's diagnostics as one entry per producer.
    pub fn problems(&self) -> Vec<(PathBuf, String, Vec<Diagnostic>)> {
        let map = self.0.read();
        map.iter()
            .flat_map(|(path, sources)| {
                sources.iter().map(move |(source, items)| (path.clone(), source.clone(), items.clone()))
            })
            .collect()
    }

    pub fn file(&self, path: &PathBuf) -> BTreeMap<String, Vec<Diagnostic>> {
        self.0.read().get(path).cloned().unwrap_or_default()
    }

    /// Drops the files under `root` (their project closed; the producers will re-report
    /// on open). Returns the number of files removed.
    pub fn forget_root(&self, root: &PathBuf) -> usize {
        let mut map = self.0.write();
        let before = map.len();
        map.retain(|path, _| !path.starts_with(root));
        before - map.len()
    }
}

/// Records `Diagnostics` events, then delivers them as usual.
pub struct RecordingSink {
    pub inner: SharedSink,
    pub store: Arc<DiagnosticsStore>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: IdeEvent) {
        if let IdeEvent::Diagnostics { path, source, items } = &event {
            self.store.replace(&path.0.clone(), source, items.clone());
        }
        self.inner.emit(event);
    }
}

/// A sink whose diagnostics are recorded; the store outlives every project.
pub type RecordSinkFactory = Box<dyn Fn(&str) -> SharedSink + Send + Sync>;

/// Wraps a sink factory so every sink it creates records diagnostics.
pub fn recording_sink_factory(store: Arc<DiagnosticsStore>, inner: crate::SinkFactory) -> crate::SinkFactory {
    Box::new(move |window| {
        let inner = inner(window);
        Arc::new(RecordingSink { inner, store: store.clone() }) as SharedSink
    })
}

/// One file's problems from one producer, the shape plugins receive.
pub fn file_problems(
    path: &std::path::Path,
    source: String,
    items: Vec<Diagnostic>,
) -> (IpcPath, String, Vec<Diagnostic>) {
    (IpcPath(path.to_path_buf()), source, items)
}
