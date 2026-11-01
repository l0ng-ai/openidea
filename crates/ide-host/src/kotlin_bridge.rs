//! Saved Kotlin -> isolated Maven output -> marked JDT libraries.

use ide_build::kotlin_bridge::{self, Outcome, ProjectLibraries};
use ide_core::event::NotifyLevel;
use ide_core::{CancellationToken, Diagnostic, IdeEvent, Pos, Range, Severity, SharedSink};
use ide_lsp::LspManager;
use ide_workspace::SettingsStore;
use ide_workspace::documents::DocumentObserver;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

const DELAY: Duration = Duration::from_millis(750);
const SOURCE: &str = "kotlin-bridge";
const COMMAND: &str = "openidea.kotlin.replace";

#[derive(Default)]
struct Revision {
    generation: u64,
    cancel: CancellationToken,
}

impl Revision {
    fn change(&mut self) {
        self.cancel.cancel();
        self.generation += 1;
        self.cancel = CancellationToken::new();
    }
    fn current(&self, generation: u64) -> bool {
        self.generation == generation && !self.cancel.is_cancelled()
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct MavenOptions {
    offline: bool,
    profiles: Vec<String>,
}

pub(crate) struct KotlinBridge {
    root: PathBuf,
    cache: PathBuf,
    bundle: Option<PathBuf>,
    settings: Arc<SettingsStore>,
    lsp: Arc<LspManager>,
    sink: SharedSink,
    trusted: Arc<AtomicBool>,
    lifetime: CancellationToken,
    revision: Mutex<Revision>,
    changed: Notify,
    options: Mutex<MavenOptions>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl KotlinBridge {
    pub(crate) fn new(
        root: PathBuf,
        cache: PathBuf,
        data: &Path,
        settings: Arc<SettingsStore>,
        lsp: Arc<LspManager>,
        sink: SharedSink,
        trusted: Arc<AtomicBool>,
    ) -> Arc<Self> {
        let options = std::fs::read(cache.join("kotlin-bridge-options.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Arc::new(Self {
            root,
            cache,
            bundle: ide_sdk::java::kotlin_bridge_bundle(data),
            settings,
            lsp,
            sink,
            trusted,
            lifetime: CancellationToken::new(),
            revision: Mutex::new(Revision::default()),
            changed: Notify::new(),
            options: Mutex::new(options),
            worker: Mutex::new(None),
        })
    }

    pub(crate) fn start(self: &Arc<Self>, runtime: &tokio::runtime::Handle) {
        let bridge = self.clone();
        *self.worker.lock() = Some(runtime.spawn(async move { bridge.run().await }));
        self.schedule();
    }

    pub(crate) fn configure_maven(&self, offline: bool, profiles: Vec<String>) {
        let options = MavenOptions { offline, profiles };
        if let Ok(bytes) = serde_json::to_vec(&options) {
            let _ = std::fs::create_dir_all(&self.cache);
            let _ = std::fs::write(self.cache.join("kotlin-bridge-options.json"), bytes);
        }
        *self.options.lock() = options;
        self.schedule();
    }

    pub(crate) async fn shutdown(&self) {
        self.stop();
        let worker = self.worker.lock().take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
    }

    pub(crate) fn schedule(&self) {
        if self.lifetime.is_cancelled() {
            return;
        }
        self.revision.lock().change();
        self.changed.notify_one();
    }

    pub(crate) fn files_changed<'a>(&self, mut paths: impl Iterator<Item = &'a PathBuf>) {
        let settings = self.settings.effective();
        if paths.any(|path| relevant_change(&self.root, path, &settings)) {
            self.schedule();
        }
    }

    pub(crate) fn stop(&self) {
        self.lifetime.cancel();
        self.revision.lock().cancel.cancel();
    }

    async fn replace(&self, projects: &[ProjectLibraries], cancel: &CancellationToken) -> ide_core::IdeResult<()> {
        let snapshot = serde_json::to_value(projects).map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
        let response = self.lsp.jdtls_command_cancellable(&self.root, COMMAND, vec![snapshot], cancel).await?;
        if response.as_u64().is_none() {
            return Err(ide_core::IdeError::unavailable(
                "Kotlin bridge command did not acknowledge its library snapshot",
            ));
        }
        Ok(())
    }

    async fn run(self: Arc<Self>) {
        let mut diagnostics = BTreeSet::new();
        let mut last_failure = String::new();
        let mut initialized = false;
        // Also retain directories from unacknowledged replacements: JDT may have applied them.
        let mut published = Vec::new();
        loop {
            tokio::select! {
                _ = self.lifetime.cancelled() => return,
                _ = self.changed.notified() => {},
            }
            let (generation, cancel) = {
                let state = self.revision.lock();
                (state.generation, state.cancel.clone())
            };
            if !self.trusted.load(Ordering::Acquire) {
                continue;
            }
            if !debounce(&cancel, &self.lifetime).await {
                continue;
            }
            let root = self.root.clone();
            let cache = self.cache.clone();
            let settings = self.settings.effective();
            let has_sources = tokio::task::spawn_blocking(move || {
                let model = crate::ops::build::load(&root, &cache, &settings);
                let enabled =
                    model.maven.as_ref().is_some_and(|m| !m.projects.is_empty()) && kotlin_bridge::has_kotlin(&root);
                (model, enabled)
            })
            .await;
            let Ok((mut model, enabled)) = has_sources else { continue };
            if !self.revision.lock().current(generation) {
                continue;
            }
            if !enabled {
                if self.cache.join("kotlin-bridge").exists()
                    && let Err(error) = self.replace(&[], &cancel).await
                {
                    if !cancel.is_cancelled() {
                        tracing::warn!("Kotlin library withdrawal: {error}");
                    }
                    continue;
                }
                for old in published.drain(..) {
                    remove_directory(old).await;
                }
                self.clear_diagnostics(&mut diagnostics);
                last_failure.clear();
                continue;
            }
            if let Some(maven) = &mut model.maven {
                let options = self.options.lock();
                for module in &mut maven.projects {
                    if options.offline {
                        module.options.push("-o".into());
                    }
                    if !options.profiles.is_empty() {
                        module.options.push(format!("-P{}", options.profiles.join(",")));
                    }
                }
            }
            let Some(bundle) = self.bundle.clone() else {
                self.failure("Kotlin bridge bundle is unavailable".into(), &mut diagnostics, &mut last_failure);
                continue;
            };
            // Clear entries persisted by an earlier incarnation only before our first build.
            if !initialized {
                if let Err(error) = self.replace(&[], &cancel).await {
                    if !cancel.is_cancelled() {
                        self.failure(error.message, &mut diagnostics, &mut last_failure);
                    }
                    continue;
                }
                initialized = true;
            }
            let directory = self.cache.join(format!("kotlin-bridge/{}", uuid::Uuid::new_v4()));
            let staging = directory.clone();
            let root = self.root.clone();
            let token = cancel.clone();
            let result =
                tokio::task::spawn_blocking(move || kotlin_bridge::build(&root, &model, &bundle, &staging, &token))
                    .await;
            if !self.revision.lock().current(generation) || self.lifetime.is_cancelled() {
                remove_directory(directory).await;
                continue;
            }
            match result {
                Ok(Ok(Outcome { success: true, projects, .. })) => {
                    match self.replace(&projects, &cancel).await {
                        Ok(()) => {
                            for old in published.drain(..) {
                                remove_directory(old).await;
                            }
                            published.push(directory);
                            self.clear_diagnostics(&mut diagnostics);
                            last_failure.clear();
                        }
                        Err(error) => {
                            // Keep both snapshots until an acknowledged replacement.
                            published.push(directory);
                            if !cancel.is_cancelled() {
                                self.failure(error.message, &mut diagnostics, &mut last_failure);
                            }
                        }
                    }
                }
                other => {
                    let text = match other {
                        Ok(Ok(outcome)) => outcome
                            .messages
                            .iter()
                            .filter(|m| m.severity == Severity::Error)
                            .map(|m| m.text.as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        Ok(Err(error)) => error.message,
                        Err(error) => error.to_string(),
                    };
                    self.failure(text, &mut diagnostics, &mut last_failure);
                    remove_directory(directory).await;
                }
            }
        }
    }

    fn clear_diagnostics(&self, paths: &mut BTreeSet<PathBuf>) {
        for path in std::mem::take(paths) {
            self.sink.emit(IdeEvent::Diagnostics { path: path.into(), source: SOURCE.into(), items: Vec::new() });
        }
    }

    fn failure(&self, text: String, paths: &mut BTreeSet<PathBuf>, previous: &mut String) {
        let text = if text.is_empty() { "Kotlin compilation failed".to_owned() } else { text };
        let text = format!("{text}\nJava temporarily uses the last successfully compiled Kotlin API.");
        self.clear_diagnostics(paths);
        let path = self.root.join("pom.xml");
        paths.insert(path.clone());
        self.sink.emit(IdeEvent::Diagnostics {
            path: path.into(),
            source: SOURCE.into(),
            items: vec![Diagnostic {
                range: Range { start: Pos { line: 0, col: 0 }, end: Pos { line: 0, col: 0 } },
                severity: Severity::Error,
                message: text.clone(),
                source: Some(SOURCE.into()),
                server: Some(SOURCE.into()),
                code: None,
                unnecessary: false,
                deprecated: false,
            }],
        });
        if previous != &text {
            self.sink.emit(IdeEvent::Notify {
                level: NotifyLevel::Error,
                title: "Kotlin editor compilation failed".into(),
                body: Some(text.clone()),
            });
            *previous = text;
        }
    }
}

fn relevant_change(root: &Path, path: &Path, settings: &ide_core::settings::Settings) -> bool {
    let input = path.extension().is_some_and(|e| e == "kt")
        || path.file_name().is_some_and(|n| n == "pom.xml" || n == "mvnw" || n == "mvnw.cmd")
        || path.components().any(|c| c.as_os_str() == ".mvn");
    let Ok(relative) = path.strip_prefix(root) else {
        // Content roots outside the project only contribute Kotlin sources.
        return path.extension().is_some_and(|e| e == "kt");
    };
    // Build outputs and generated sources (e.g. KSP's `.kt` under target/) never trigger,
    // so a build cannot schedule itself.
    if relative.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("target" | "build" | "out" | "bin" | ".git" | "node_modules" | ".openidea")
        )
    }) || ide_vfs::ExcludeMatcher::new(&settings.exclude_globs()).is_excluded(relative)
    {
        return false;
    }
    if input {
        return true;
    }
    if path.extension().is_some() {
        return false;
    }
    // Works for deleted directories too; the module POM remains on disk.
    path.ancestors().take_while(|ancestor| ancestor.starts_with(root)).any(|ancestor| {
        ancestor.file_name().is_some_and(|name| name == "src")
            && ancestor.parent().is_some_and(|module| module.join("pom.xml").is_file())
    })
}

async fn debounce(cancel: &CancellationToken, lifetime: &CancellationToken) -> bool {
    tokio::select! {
        _ = lifetime.cancelled() => false,
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(DELAY) => true,
    }
}

async fn remove_directory(path: PathBuf) {
    let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(path)).await;
}

impl DocumentObserver for KotlinBridge {
    fn saved(&self, _doc: ide_core::DocId, path: &Path, _text: &str) {
        self.files_changed(std::iter::once(&path.to_path_buf()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_package_directory_does_not_trigger() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pom.xml"), "").unwrap();
        assert!(!relevant_change(dir.path(), &dir.path().join("target/classes/probe"), &Default::default()));
        let generated = dir.path().join("target/generated-sources/ksp/main/kotlin/Gen.kt");
        assert!(!relevant_change(dir.path(), &generated, &Default::default()));
        assert!(relevant_change(dir.path(), &dir.path().join("src/main/kotlin/A.kt"), &Default::default()));
    }

    #[test]
    fn deleted_source_package_triggers_unless_excluded() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("module")).unwrap();
        std::fs::write(dir.path().join("module/pom.xml"), "").unwrap();
        let path = dir.path().join("module/src/main/kotlin/pkg");
        let mut settings = ide_core::settings::Settings::default();
        assert!(relevant_change(dir.path(), &path, &settings));
        settings.project_structure.excluded.push("module/src/main/kotlin".into());
        assert!(!relevant_change(dir.path(), &path, &settings));
        assert!(!relevant_change(dir.path(), &dir.path().join("module/src/build/pkg"), &Default::default()));
    }

    #[test]
    fn extensionless_root_file_does_not_trigger() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pom.xml"), "").unwrap();
        assert!(!relevant_change(dir.path(), &dir.path().join("LICENSE"), &Default::default()));
    }

    #[tokio::test(start_paused = true)]
    async fn burst_saves_cancel_the_pending_debounce() {
        let mut state = Revision::default();
        state.change();
        let token = state.cancel.clone();
        let lifetime = CancellationToken::new();
        let pending_lifetime = lifetime.clone();
        let waiting = tokio::spawn(async move { debounce(&token, &pending_lifetime).await });
        tokio::task::yield_now().await;
        tokio::time::advance(DELAY - Duration::from_millis(1)).await;
        assert!(!waiting.is_finished());
        for _ in 0..20 {
            state.change();
        }
        assert!(!waiting.await.unwrap());
        let current = state.generation;
        assert!(debounce(&state.cancel, &lifetime).await);
        assert!(state.current(current));
        lifetime.cancel();
        assert!(!debounce(&state.cancel, &lifetime).await);
    }

    #[test]
    fn superseded_and_cancelled_builds_cannot_publish() {
        let mut state = Revision::default();
        state.change();
        let first = state.generation;
        let token = state.cancel.clone();
        state.change();
        assert!(token.is_cancelled());
        assert!(!state.current(first));
        assert!(state.current(state.generation));
        state.cancel.cancel();
        assert!(!state.current(state.generation));
    }
}
