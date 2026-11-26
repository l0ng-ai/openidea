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
/// How deep below the project the walk looks for `tsconfig.json` (`apps/web/tsconfig.json` is 3).
const MAX_DEPTH: usize = 4;
/// Folders whose configurations are not the project's own: test inputs and samples, often
/// broken on purpose.
const SKIPPED: [&str; 6] = ["node_modules", "fixtures", "__fixtures__", "testdata", "examples", "example"];

/// The `tsconfig.json` files of the project, without the ones in ignored (`.gitignore`), hidden,
/// excluded (`excludes`) or [`SKIPPED`] folders.
fn configs(root: &Path, excludes: &[String]) -> Vec<PathBuf> {
    let excludes = ide_vfs::ExcludeMatcher::new(excludes);
    let base = root.to_path_buf();
    let mut walk = ignore::WalkBuilder::new(root);
    walk.max_depth(Some(MAX_DEPTH)).require_git(ide_core::ignored::inside_git_repo(root)).follow_links(false);
    walk.filter_entry(move |entry| {
        let skipped = entry.file_type().is_some_and(|t| t.is_dir())
            && entry.file_name().to_str().is_some_and(|name| SKIPPED.contains(&name));
        !skipped && entry.path().strip_prefix(&base).is_ok_and(|rel| !excludes.is_match(rel))
    });
    let mut found: Vec<PathBuf> = walk
        .build()
        .flatten()
        .filter(|e| e.file_name() == "tsconfig.json" && e.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .collect();
    found.sort();
    found
}

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
        let excludes = self.settings.effective().exclude_globs();
        for config in ide_build::compile::tsc_watch_roots(configs(&self.root, &excludes)) {
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
            let mut files = ide_build::compile::diagnostics_from(&messages, SOURCE);
            // Messages about the scratch configurations or files outside the project.
            files.retain(|path, _| path.starts_with(&self.root));
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

    #[test]
    fn configs_skip_ignored_excluded_and_sample_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for dir in
            ["", "apps/web", "test/fixtures/broken", "examples/demo", "generated", "vendor/lib", ".cache", "a/b/c/d"]
        {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("tsconfig.json"), "{}").unwrap();
        }
        std::fs::write(root.join(".gitignore"), "/vendor/\n").unwrap();
        let found = configs(root, &["generated".into()]);
        assert_eq!(found, [root.join("apps/web/tsconfig.json"), root.join("tsconfig.json")]);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_option_starts_and_stops_the_projects_tsc() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("p");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        std::fs::write(root.join("tsconfig.json"), "{}").unwrap();
        std::fs::write(root.join("src/b.ts"), "export const b: number = a;\n").unwrap();
        // Records its process, prints one compilation and keeps watching, like `tsc --watch`.
        let tsc = root.join("node_modules/.bin/tsc");
        std::fs::write(
            &tsc,
            "#!/bin/sh\necho $$ >> pids.txt\n\
             echo 'src/b.ts(1,26): error TS2322: Type string is not assignable to type number.'\n\
             echo '1:00:00 PM - Found 1 error. Watching for file changes.'\nexec sleep 60\n",
        )
        .unwrap();
        std::fs::set_permissions(&tsc, std::fs::Permissions::from_mode(0o755)).unwrap();

        let settings = Arc::new(SettingsStore::load(&tmp.path().join("config"), Some(&root)));
        let events: Arc<Mutex<Vec<(PathBuf, usize)>>> = Arc::default();
        let sink: SharedSink = Arc::new({
            let events = events.clone();
            move |e: IdeEvent| {
                if let IdeEvent::Diagnostics { path, source, items } = e {
                    assert_eq!(source, SOURCE);
                    events.lock().push((path.0, items.len()));
                }
            }
        });
        let trusted = Arc::new(AtomicBool::new(true));
        let watch = TscWatch::new(root.clone(), settings.clone(), sink, trusted.clone());
        let runtime = tokio::runtime::Handle::current();
        let b = root.join("src/b.ts");
        let pids = || -> Vec<u32> {
            std::fs::read_to_string(root.join("pids.txt"))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| l.parse().ok())
                .collect()
        };
        let until = |what: &str, ok: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !ok() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        let last = || events.lock().iter().rev().find(|(p, _)| *p == b).map(|(_, n)| *n);
        let set = |on: bool| {
            settings
                .set(ide_workspace::settings::SettingsScope::Project, "languages.typescript.watchProblems", on.into())
                .unwrap();
            watch.apply(&runtime);
        };

        // Off by default: nothing runs.
        watch.apply(&runtime);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(pids().is_empty() && events.lock().is_empty());

        set(true);
        until("the error of b.ts", &|| last() == Some(1));
        let first = pids()[0];
        // Applying again (another setting changed) keeps the one watcher.
        watch.apply(&runtime);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(pids(), [first]);

        set(false);
        assert_eq!(last(), Some(0), "turning it off clears its errors at once");
        until("tsc to stop", &|| !ide_core::process::process_alive(first));

        // Restricted Mode stops it too, and trusting the project starts it again.
        set(true);
        until("a second tsc", &|| pids().len() == 2 && last() == Some(1));
        trusted.store(false, Ordering::Release);
        watch.apply(&runtime);
        assert_eq!(last(), Some(0));
        until("tsc to stop", &|| !ide_core::process::process_alive(pids()[1]));
        trusted.store(true, Ordering::Release);
        watch.apply(&runtime);
        until("a third tsc", &|| pids().len() == 3 && last() == Some(1));

        // Closing the project stops it for good.
        watch.stop();
        assert_eq!(last(), Some(0));
        until("tsc to stop", &|| !ide_core::process::process_alive(pids()[2]));
        watch.apply(&runtime);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(pids().len(), 3, "nothing starts after the project closed");
    }
}
