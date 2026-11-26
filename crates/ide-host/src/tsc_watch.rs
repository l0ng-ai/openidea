//! Problems › TypeScript project errors (`languages.typescript.watchProblems`): the project's own
//! `tsc --watch` per root `tsconfig.json` -> `tsc` diagnostics. Files open in an editor keep only
//! the language server's errors, so the watcher's are held back for them until they close.

use ide_core::{CancellationToken, Diagnostic, IdeEvent, SharedSink};
use ide_workspace::SettingsStore;
use ide_workspace::documents::{DocumentInfo, DocumentObserver};
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const SOURCE: &str = "tsc";

pub(crate) struct TscWatch {
    root: PathBuf,
    settings: Arc<SettingsStore>,
    sink: SharedSink,
    trusted: Arc<AtomicBool>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The running watchers, cancelled to stop them.
    running: Option<CancellationToken>,
    /// The project closed: nothing starts again.
    closed: bool,
    /// The last compilation's diagnostics of each root configuration.
    results: BTreeMap<PathBuf, BTreeMap<PathBuf, Vec<Diagnostic>>>,
    /// Files open in an editor.
    open: HashSet<PathBuf>,
    /// What the UI was last sent.
    shown: BTreeMap<PathBuf, Vec<Diagnostic>>,
}

impl State {
    /// Every root's diagnostics of the files not open, a problem two roots report listed once.
    fn wanted(&self) -> BTreeMap<PathBuf, Vec<Diagnostic>> {
        let mut out: BTreeMap<PathBuf, Vec<Diagnostic>> = BTreeMap::new();
        for files in self.results.values() {
            for (path, items) in files.iter().filter(|(p, _)| !self.open.contains(*p)) {
                let list = out.entry(path.clone()).or_default();
                for d in items {
                    if !list.iter().any(|o| o.range == d.range && o.message == d.message) {
                        list.push(d.clone());
                    }
                }
            }
        }
        out
    }

    /// The files whose diagnostics change, with their new list (empty clears them).
    fn refresh(&mut self) -> Vec<(PathBuf, Vec<Diagnostic>)> {
        let wanted = self.wanted();
        let mut changes: Vec<(PathBuf, Vec<Diagnostic>)> =
            self.shown.keys().filter(|p| !wanted.contains_key(*p)).map(|p| (p.clone(), Vec::new())).collect();
        changes.extend(
            wanted.iter().filter(|(p, items)| self.shown.get(*p) != Some(items)).map(|(p, i)| (p.clone(), i.clone())),
        );
        self.shown = wanted;
        changes
    }
}

impl TscWatch {
    pub(crate) fn new(
        root: PathBuf,
        settings: Arc<SettingsStore>,
        sink: SharedSink,
        trusted: Arc<AtomicBool>,
    ) -> Arc<Self> {
        Arc::new(Self { root, settings, sink, trusted, state: Mutex::new(State::default()) })
    }

    /// Starts the watchers when the option is on in a trusted project, else stops them and
    /// clears their errors. Called on open, on a settings change and on a trust change.
    pub(crate) fn apply(self: &Arc<Self>, runtime: &tokio::runtime::Handle) {
        let wanted =
            self.trusted.load(Ordering::Acquire) && self.settings.effective().languages.typescript.watch_problems;
        if !wanted {
            return self.halt(false);
        }
        let mut state = self.state.lock();
        if !state.closed && state.running.is_none() {
            let cancel = CancellationToken::new();
            state.running = Some(cancel.clone());
            let this = self.clone();
            runtime.spawn_blocking(move || this.start(&cancel));
        }
    }

    /// The project closed.
    pub(crate) fn stop(&self) {
        self.halt(true);
    }

    fn halt(&self, closed: bool) {
        let mut state = self.state.lock();
        state.closed |= closed;
        if let Some(cancel) = state.running.take() {
            cancel.cancel();
            state.results.clear();
            self.publish(&mut state);
        }
    }

    /// One thread per root configuration, each running its `tsc --watch` until `cancel`.
    fn start(self: &Arc<Self>, cancel: &CancellationToken) {
        for config in ide_build::compile::tsc_watch_roots(&self.root) {
            if cancel.is_cancelled() {
                return;
            }
            let (this, cancel) = (self.clone(), cancel.clone());
            std::thread::spawn(move || this.watch(&config, &cancel));
        }
    }

    fn watch(&self, config: &Path, cancel: &CancellationToken) {
        let result = ide_build::compile::tsc_watch(&self.root, config, cancel, |messages| {
            tracing::debug!(config = %config.display(), messages = messages.len(), "tsc --watch compiled");
            let files = ide_build::compile::diagnostics_from(&messages, SOURCE);
            self.compiled(config, files, cancel);
        });
        match result {
            Ok(()) => tracing::debug!(config = %config.display(), "tsc --watch ended"),
            Err(e) => tracing::debug!(config = %config.display(), %e, "tsc --watch did not run"),
        }
        // Without a watcher its errors would go stale.
        self.compiled(config, BTreeMap::new(), cancel);
    }

    fn compiled(&self, config: &Path, files: BTreeMap<PathBuf, Vec<Diagnostic>>, cancel: &CancellationToken) {
        let mut state = self.state.lock();
        // Under the lock: `apply` cancels and clears under it, so a stopped watcher adds nothing.
        if cancel.is_cancelled() {
            return;
        }
        if files.is_empty() {
            state.results.remove(config);
        } else {
            state.results.insert(config.to_path_buf(), files);
        }
        self.publish(&mut state);
    }

    /// Sends the changes, under the lock so they reach the UI in the order decided here.
    fn publish(&self, state: &mut State) {
        for (path, items) in state.refresh() {
            self.sink.emit(IdeEvent::Diagnostics { path: path.into(), source: SOURCE.into(), items });
        }
    }

    fn set_open(&self, path: &Path, open: bool) {
        let mut state = self.state.lock();
        let changed = if open { state.open.insert(path.to_path_buf()) } else { state.open.remove(path) };
        if changed {
            self.publish(&mut state);
        }
    }
}

impl DocumentObserver for TscWatch {
    fn opened(&self, info: &DocumentInfo) {
        self.set_open(&info.path.0, true);
    }

    fn closed(&self, _doc: ide_core::DocId, path: &Path) {
        self.set_open(path, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Pos, Range, Severity};

    fn diag(line: u32, message: &str) -> Diagnostic {
        Diagnostic {
            range: Range::new(Pos::new(line, 0), Pos::new(line, 1)),
            severity: Severity::Error,
            message: message.into(),
            source: Some(SOURCE.into()),
            code: None,
            unnecessary: false,
            deprecated: false,
            server: Some(SOURCE.into()),
        }
    }

    fn files(entries: &[(&str, Vec<Diagnostic>)]) -> BTreeMap<PathBuf, Vec<Diagnostic>> {
        entries.iter().map(|(p, d)| (PathBuf::from(p), d.clone())).collect()
    }

    #[test]
    fn open_files_keep_only_the_language_servers_errors() {
        let mut state = State::default();
        let b = diag(0, "Type 'string' is not assignable to type 'number'.");
        state
            .results
            .insert("/p/tsconfig.json".into(), files(&[("/p/b.ts", vec![b.clone()]), ("/p/c.ts", vec![diag(1, "c")])]));
        // The same problem from a second root is listed once.
        state.results.insert("/p/src/tsconfig.json".into(), files(&[("/p/b.ts", vec![b.clone()])]));
        assert_eq!(state.refresh(), [("/p/b.ts".into(), vec![b.clone()]), ("/p/c.ts".into(), vec![diag(1, "c")])]);
        assert!(state.refresh().is_empty(), "nothing changed, nothing sent");

        state.open.insert("/p/b.ts".into());
        assert_eq!(state.refresh(), [("/p/b.ts".into(), vec![])]);
        state.open.remove(Path::new("/p/b.ts"));
        assert_eq!(state.refresh(), [("/p/b.ts".into(), vec![b])]);

        // Fixed: the next compilation reports nothing for the files.
        state.results.clear();
        assert_eq!(state.refresh(), [("/p/b.ts".into(), vec![]), ("/p/c.ts".into(), vec![])]);
    }
}
