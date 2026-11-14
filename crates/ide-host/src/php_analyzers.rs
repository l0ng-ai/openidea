//! PHPStan and Psalm on save (Settings › PHP › External Analyzers).
//!
//! When `PhpSettings.analyzers_on_save` is on and the project is trusted,
//! each saved PHP file of the project is analysed by the tools
//! `ide_php::analyzers::detect` finds in `vendor/bin`, run with the PHP
//! interpreter of Settings › PHP on a thread of its own. Their problems are
//! published under the tool's own source (`phpstan`, `psalm`), minus those
//! the native engine already reports for the file
//! (`ide_php::analyzers::remove_duplicates`, against its latest inspection).
//! A newer save of the same file cancels a run in progress; closing the
//! file, turning the setting off and closing the project clear what was
//! published.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ide_core::event::NotifyLevel;
use ide_core::settings::Settings;
use ide_core::{CancellationToken, Diagnostic, IdeEvent, SharedSink};
use ide_php::analyzers::{self, Analyzer};
use ide_workspace::SettingsStore;
use ide_workspace::documents::DocumentObserver;
use parking_lot::Mutex;

use crate::php::PhpEngineSlot;

/// The longest one analyser may run on a file.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
struct State {
    /// The run in progress for each file, with its id.
    running: HashMap<PathBuf, (u64, CancellationToken)>,
    next_run: u64,
    /// Files with diagnostics published, by source.
    published: HashSet<(PathBuf, &'static str)>,
    /// Analysers whose failure was already shown.
    failed: HashSet<&'static str>,
    stopped: bool,
}

pub(crate) struct PhpAnalyzers {
    root: PathBuf,
    settings: Arc<SettingsStore>,
    sink: SharedSink,
    trusted: Arc<AtomicBool>,
    php: Arc<PhpEngineSlot>,
    state: Arc<Mutex<State>>,
}

impl PhpAnalyzers {
    pub(crate) fn new(
        root: &Path,
        settings: Arc<SettingsStore>,
        sink: SharedSink,
        trusted: Arc<AtomicBool>,
        php: Arc<PhpEngineSlot>,
    ) -> Arc<Self> {
        Arc::new(Self { root: root.to_path_buf(), settings, sink, trusted, php, state: Arc::default() })
    }

    /// The settings changed: when the analysers are off, runs stop and what
    /// they published is cleared.
    pub(crate) fn apply(&self, settings: &Settings) {
        if !settings.languages.php.analyzers_on_save {
            self.clear_all();
        }
    }

    /// The project closes.
    pub(crate) fn stop(&self) {
        self.state.lock().stopped = true;
        self.clear_all();
    }

    fn clear_all(&self) {
        let published: Vec<_> = {
            let mut state = self.state.lock();
            for (_, (_, token)) in state.running.drain() {
                token.cancel();
            }
            state.published.drain().collect()
        };
        for (path, source) in published {
            self.sink.emit(clear(path, source));
        }
    }

    fn clear_file(&self, path: &Path) {
        let published: Vec<_> = {
            let mut state = self.state.lock();
            if let Some((_, token)) = state.running.remove(path) {
                token.cancel();
            }
            let gone: Vec<_> = state.published.iter().filter(|(p, _)| p == path).cloned().collect();
            for entry in &gone {
                state.published.remove(entry);
            }
            gone
        };
        for (path, source) in published {
            self.sink.emit(clear(path, source));
        }
    }

    /// Whether a saved file is one the analysers look at: a PHP file of the
    /// project, not a Blade view and not a dependency.
    fn analysed(&self, path: &Path) -> bool {
        let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        name.ends_with(".php")
            && !name.ends_with(".blade.php")
            && path.strip_prefix(&self.root).is_ok_and(|rel| !rel.starts_with("vendor"))
    }

    /// Analyses the saved `path` (whose text is `text`) in the background.
    fn saved_file(&self, path: &Path, text: &str) {
        if !self.analysed(path) {
            return;
        }
        let settings = self.settings.effective();
        if !settings.languages.php.analyzers_on_save || !self.trusted.load(Ordering::Acquire) {
            self.clear_file(path);
            return;
        }
        let tools = analyzers::detect(&self.root);
        if tools.is_empty() {
            return;
        }
        let token = CancellationToken::new();
        let id = {
            let mut state = self.state.lock();
            if state.stopped {
                return;
            }
            state.next_run += 1;
            let id = state.next_run;
            if let Some((_, previous)) = state.running.insert(path.to_path_buf(), (id, token.clone())) {
                previous.cancel();
            }
            id
        };
        let job = Job {
            root: self.root.clone(),
            path: path.to_path_buf(),
            text: text.to_owned(),
            interpreter: interpreter(&settings),
            tools,
            id,
            token,
            sink: self.sink.clone(),
            php: self.php.clone(),
            state: self.state.clone(),
        };
        let spawned = std::thread::Builder::new().name("openidea-php-analyzers".into()).spawn(move || job.run());
        if let Err(e) = spawned {
            tracing::warn!("php analysers: {e}");
        }
    }
}

impl DocumentObserver for PhpAnalyzers {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, text: &str) {
        self.saved_file(path, text);
    }

    fn closed(&self, _doc: ide_core::DocId, path: &Path) {
        self.clear_file(path);
    }
}

/// Settings › PHP › CLI Interpreter, else `php` on `PATH`.
fn interpreter(settings: &Settings) -> PathBuf {
    let configured = settings.languages.php.interpreter.trim();
    PathBuf::from(if configured.is_empty() { "php" } else { configured })
}

fn clear(path: PathBuf, source: &str) -> IdeEvent {
    IdeEvent::Diagnostics { path: path.into(), source: source.into(), items: Vec::new() }
}

/// One save's run of every installed analyser.
struct Job {
    root: PathBuf,
    path: PathBuf,
    text: String,
    interpreter: PathBuf,
    tools: Vec<Analyzer>,
    id: u64,
    token: CancellationToken,
    sink: SharedSink,
    php: Arc<PhpEngineSlot>,
    state: Arc<Mutex<State>>,
}

impl Job {
    fn run(self) {
        for tool in &self.tools {
            if self.token.is_cancelled() {
                break;
            }
            let found = execute(&self.interpreter, *tool, &self.root, &self.path, &self.token, TIMEOUT)
                .and_then(|out| tool.parse(&out, &self.path, &self.root, &self.text));
            if self.token.is_cancelled() {
                break;
            }
            match found {
                Ok(mut items) => {
                    remove_engine_duplicates(&self.php, &self.path, &mut items);
                    let mut state = self.state.lock();
                    if state.stopped || !self.current(&state) {
                        break;
                    }
                    state.failed.remove(tool.source());
                    state.published.insert((self.path.clone(), tool.source()));
                    // Emitted under the lock, so a clear can't overtake it.
                    self.sink.emit(IdeEvent::Diagnostics {
                        path: self.path.clone().into(),
                        source: tool.source().into(),
                        items,
                    });
                }
                Err(error) => {
                    tracing::warn!("{} on {}: {error}", tool.source(), self.path.display());
                    let first = self.state.lock().failed.insert(tool.source());
                    if first {
                        self.sink.emit(IdeEvent::Notify {
                            level: NotifyLevel::Warning,
                            title: format!("{} could not analyse the file", tool.source()),
                            body: Some(error),
                        });
                    }
                }
            }
        }
        let mut state = self.state.lock();
        if self.current(&state) {
            state.running.remove(&self.path);
        }
    }

    fn current(&self, state: &State) -> bool {
        !self.token.is_cancelled() && state.running.get(&self.path).is_some_and(|(id, _)| *id == self.id)
    }
}

/// Drops what the engine's latest inspection of the open file reports too.
fn remove_engine_duplicates(php: &PhpEngineSlot, path: &Path, items: &mut Vec<Diagnostic>) {
    let Some(engine) = php.engine() else { return };
    let Some(document) = engine.open_document(path) else { return };
    if let Some(inspected) = engine.inspected(document.doc) {
        analyzers::remove_duplicates(items, &inspected.diagnostics);
    }
}

/// Runs `php vendor/bin/<tool> <args> <file>` in `root` and returns its
/// stdout. Killed (with what it started) when `cancel` fires or after
/// `timeout`.
fn execute(
    interpreter: &Path,
    tool: Analyzer,
    root: &Path,
    file: &Path,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new(interpreter);
    ide_core::process::prepare(&mut cmd);
    ide_core::process::own_group(&mut cmd);
    cmd.arg(tool.script(root))
        .args(tool.args(file))
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", interpreter.display()))?;
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = reader(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = reader(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    loop {
        if cancel.is_cancelled() {
            ide_core::process::kill_tree(&mut child);
            return Err("cancelled".into());
        }
        if started.elapsed() > timeout {
            ide_core::process::kill_tree(&mut child);
            return Err(format!("{} timed out after {} s", tool.source(), timeout.as_secs()));
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                ide_core::process::kill_tree(&mut child);
                return Err(e.to_string());
            }
        }
    }
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if out.trim().is_empty() && !err.trim().is_empty() {
        // Nothing to parse: the reason is on stderr (no PHP, a broken config).
        return Err(err.trim().chars().take(2000).collect());
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
