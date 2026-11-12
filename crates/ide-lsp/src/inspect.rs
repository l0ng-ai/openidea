//! Batch diagnostics for Inspect Code: every file of a scope is opened (through
//! the host, so the document layer stays authoritative), its diagnostics are
//! collected and the file is closed again.
//!
//! Servers that advertise `diagnosticProvider` are asked directly
//! (`textDocument/diagnostic`). The others are waited on: the first
//! `publishDiagnostics` for the file after it was opened, then a short quiet
//! period so follow-up publishes (syntax first, semantics later) are caught.

use crate::convert;
use crate::server::Server;
use crate::{LspManager, Target};
use futures::StreamExt;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, Diagnostic, DocId, IdeError, IdeResult};
use lsp_types as lsp;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long Inspect Code waits for a server that is still starting (jdtls,
/// rust-analyzer on a large workspace).
const INSPECT_START_WAIT: Duration = Duration::from_secs(60);
/// Quiet period after a publish before a checked file counts as done (follow-up publishes:
/// syntax first, semantics later).
const CHECK_SETTLE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug)]
pub struct InspectOptions {
    /// Files inspected at the same time.
    pub concurrency: usize,
    /// Longest wait for a file's diagnostics once its servers are ready.
    pub timeout: Duration,
    /// Quiet period after a publish before the file counts as done.
    pub settle: Duration,
}

impl Default for InspectOptions {
    fn default() -> Self {
        Self { concurrency: 4, timeout: Duration::from_secs(8), settle: Duration::from_millis(400) }
    }
}

/// Opens and closes documents for [`LspManager::inspect_files`]. `open` must
/// go through the document layer (whose observer calls `did_open`), taking
/// another reference when the file is already open.
pub trait InspectHost: Send + Sync + 'static {
    /// Returns the document and whether it was open before.
    fn open(&self, path: &Path) -> IdeResult<(DocId, bool)>;
    fn close(&self, doc: DocId);
}

/// One language server's part in a [`DocumentCheck`].
#[derive(Clone, Debug)]
pub struct CheckedServer {
    pub name: String,
    /// Its state when the check ended: not `Ready`/`Busy` means it could not check.
    pub status: ide_core::event::ServerStatus,
    /// Why it isn't running (not installed, misconfigured, crashed), as the status bar says.
    pub message: Option<String>,
    /// Its diagnostics are in the result.
    pub checked: bool,
    /// It was still analysing (or had not published for this change) when the wait ended.
    pub incomplete: bool,
    /// Asking it failed.
    pub error: Option<String>,
}

/// Fresh diagnostics of a document, with every language server that serves it.
#[derive(Clone, Debug, Default)]
pub struct DocumentCheck {
    pub diagnostics: Vec<Diagnostic>,
    pub servers: Vec<CheckedServer>,
}

/// What became of one file.
#[derive(Clone, Debug)]
pub enum FileInspection {
    Inspected(Vec<Diagnostic>),
    /// No language server serves the file (none configured, missing, or never ready).
    NoServer,
    Failed(String),
}

impl LspManager {
    /// Whether an installed language server that can run here is configured
    /// for `path` (by file name). Missing servers are not started, so a batch
    /// run doesn't prompt to install every language it meets.
    pub fn serves_path(&self, path: &Path) -> bool {
        let lang = self.languages.detect(path, None);
        let arduino = if lang.as_str() == "arduino" {
            Some(self.servers_for(&lang, path))
        } else {
            self.arduino_servers(&lang, path)
        };
        if let Some(servers) = arduino {
            return servers.iter().any(|server| {
                let cfg = self.configured(server);
                cfg.launch_error.is_none() && self.launcher.available(&cfg, &server.root)
            });
        }
        self.language_servers(&lang).iter().any(|ls| {
            if ls.require_root_marker
                && crate::launch::marked_root(&self.project_root, path, &ls.root_markers).is_none()
            {
                return false;
            }
            let mut cfg = ls.clone();
            if let Some(hook) = self.config_hook.read().clone() {
                hook(&mut cfg, &self.project_root);
            }
            cfg.launch_error.is_none() && self.launcher.available(&cfg, &self.project_root)
        })
    }

    /// Inspects `files` with up to `opts.concurrency` in flight, reporting each
    /// through `on_file` as it completes. Stops early when cancelled.
    pub async fn inspect_files(
        &self,
        host: Arc<dyn InspectHost>,
        files: Vec<PathBuf>,
        opts: InspectOptions,
        cancel: CancellationToken,
        on_file: &(dyn Fn(PathBuf, FileInspection) + Send + Sync),
    ) {
        let tasks = files.into_iter().map(|path| {
            let host = host.clone();
            let cancel = cancel.clone();
            async move {
                if cancel.is_cancelled() {
                    return None;
                }
                let outcome = self.inspect_one(host, &path, opts, &cancel).await;
                (!cancel.is_cancelled()).then_some((path, outcome))
            }
        });
        let mut stream = futures::stream::iter(tasks).buffer_unordered(opts.concurrency.max(1));
        while let Some(done) = stream.next().await {
            if let Some((path, outcome)) = done {
                on_file(path, outcome);
            }
        }
    }

    async fn inspect_one(
        &self,
        host: Arc<dyn InspectHost>,
        path: &Path,
        opts: InspectOptions,
        cancel: &CancellationToken,
    ) -> FileInspection {
        let since = Instant::now();
        let opened = {
            let host = host.clone();
            let path = path.to_owned();
            tokio::task::spawn_blocking(move || host.open(&path)).await
        };
        let (doc, was_open) = match opened {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return FileInspection::Failed(e.message),
            Err(e) => return FileInspection::Failed(e.to_string()),
        };
        // Diagnostics of a document that was already open are current.
        let result = self.document_diagnostics(doc, (!was_open).then_some(since), opts, cancel).await;
        tokio::task::spawn_blocking(move || host.close(doc)).await.ok();
        match result {
            Ok(Some(items)) => FileInspection::Inspected(items),
            Ok(None) => FileInspection::NoServer,
            Err(e) => FileInspection::Failed(e.message),
        }
    }

    /// Diagnostics of the open document `doc` from all its servers; `None`
    /// when no server for it became ready. With `since`, push-only servers
    /// must publish after that instant (the document was just opened).
    pub async fn document_diagnostics(
        &self,
        doc: DocId,
        since: Option<Instant>,
        opts: InspectOptions,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<Vec<Diagnostic>>> {
        let snap = self.snapshot(doc)?;
        let ready = tokio::select! {
            r = futures::future::join_all(snap.servers.iter().map(|s| s.wait_ready(INSPECT_START_WAIT))) => r,
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        let targets: Vec<Target> = snap
            .servers
            .iter()
            .zip(ready)
            .filter_map(|(s, run)| Some(Target { server: s.clone(), run: run? }))
            .filter(|t| t.caps().restriction.diagnostics())
            .collect();
        if targets.is_empty() {
            return Ok(None);
        }
        let per_server = targets.iter().map(|t| async {
            let raw = if t.caps().has("diagnosticProvider") {
                self.pull_diagnostics(t, &snap.uri, cancel, opts.timeout).await
            } else {
                wait_for_publish(&t.server, &snap.path, since, opts, cancel).await
            };
            raw.map(|items| {
                let conv = self.conv(t.enc());
                items.into_iter().map(|d| convert::diagnostic(&conv, &snap.path, d, &t.server.name)).collect::<Vec<_>>()
            })
        });
        let mut out = Vec::new();
        let mut error = None;
        for r in futures::future::join_all(per_server).await {
            match r {
                Ok(items) => out.extend(items),
                Err(e) => error = Some(e),
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        match error {
            Some(e) if out.is_empty() && targets.len() == 1 => Err(e),
            _ => Ok(Some(out)),
        }
    }

    /// Fresh diagnostics of the open document `doc`, whose text the caller just synced
    /// (`changed`: at that instant, so diagnostics published before it are stale). Tells the
    /// servers the document was saved, since checks that run on save (rust-analyzer's
    /// `cargo check`) don't run for a change made outside the IDE, then waits for each server
    /// to be ready, to answer for this text and to finish the background work it started, up
    /// to `timeout`. Every server serving the document is reported, so a caller can tell "no
    /// problems" from "nothing could check".
    pub async fn check_document(
        &self,
        doc: DocId,
        changed: Option<Instant>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> IdeResult<DocumentCheck> {
        let snap = self.snapshot(doc)?;
        let deadline = tokio::time::Instant::now() + timeout;
        let left = || deadline.saturating_duration_since(tokio::time::Instant::now());
        let ready = tokio::select! {
            r = futures::future::join_all(snap.servers.iter().map(|s| s.wait_ready(left()))) => r,
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        // Once the servers have the document: a save sent while one starts would not reach it.
        self.did_save(doc, snap.text.as_str());
        let per_server = snap.servers.iter().zip(ready).map(|(server, run)| async {
            let mut report = CheckedServer {
                name: server.name.clone(),
                status: server.status(),
                message: server.status_message(),
                checked: false,
                incomplete: false,
                error: None,
            };
            let Some(run) = run else { return Some((report, Vec::new())) };
            let t = Target { server: server.clone(), run };
            if !t.caps().restriction.diagnostics() {
                return None;
            }
            let pull = t.caps().has("diagnosticProvider");
            let mut since = changed;
            let raw = loop {
                // A pull asks for this text; a push server is waited on to publish for it.
                let raw = if pull {
                    server.wait_idle(left(), cancel).await;
                    self.pull_diagnostics(&t, &snap.uri, cancel, left()).await
                } else {
                    let opts = InspectOptions { concurrency: 1, timeout: left(), settle: CHECK_SETTLE };
                    wait_for_publish(server, &snap.path, since, opts, cancel).await
                };
                // The save may have started work (a `cargo check`) that publishes when it ends.
                if raw.is_err() || pull || !server.is_busy() || left().is_zero() {
                    break raw;
                }
                if !server.wait_idle(left(), cancel).await {
                    break raw.map(|_| server.diagnostics_for(&snap.path));
                }
                // Idle: its last publish is final once quiet.
                since = None;
            };
            report.status = server.status();
            match raw {
                Ok(items) => {
                    report.checked = true;
                    let fresh =
                        pull || changed.is_none_or(|c| server.last_published(&snap.path).is_some_and(|p| p >= c));
                    report.incomplete = !fresh || server.is_busy();
                    let conv = self.conv(t.enc());
                    let items = items
                        .into_iter()
                        .map(|d| convert::diagnostic(&conv, &snap.path, d, &t.server.name))
                        .collect::<Vec<_>>();
                    Some((report, items))
                }
                Err(e) => {
                    report.error = Some(e.message);
                    Some((report, Vec::new()))
                }
            }
        });
        let results = tokio::select! {
            r = futures::future::join_all(per_server) => r,
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        let mut out = DocumentCheck::default();
        for (report, items) in results.into_iter().flatten() {
            out.servers.push(report);
            out.diagnostics.extend(items);
        }
        Ok(out)
    }

    async fn pull_diagnostics(
        &self,
        t: &Target,
        uri: &lsp::Uri,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> IdeResult<Vec<lsp::Diagnostic>> {
        let params = json!({ "textDocument": { "uri": uri } });
        let report: Value = self.call(t, "textDocument/diagnostic", params, Some(cancel), timeout).await?;
        let items = report.get("items").cloned().unwrap_or(Value::Array(Vec::new()));
        serde_json::from_value(items).map_err(|e| {
            IdeError::new(ErrorKind::Protocol, format!("{}: bad textDocument/diagnostic report: {e}", t.server.name))
        })
    }
}

/// Waits until `server` published diagnostics for `path` (after `since`, if
/// given) and no further publish arrived for `opts.settle`, or `opts.timeout`
/// passed; returns the server's current diagnostics for the file.
async fn wait_for_publish(
    server: &Server,
    path: &Path,
    since: Option<Instant>,
    opts: InspectOptions,
    cancel: &CancellationToken,
) -> IdeResult<Vec<lsp::Diagnostic>> {
    let deadline = tokio::time::Instant::now() + opts.timeout;
    loop {
        // Registered before checking, so a publish in between is not missed.
        let notified = server.published_notify.notified();
        let fresh = server.last_published(path).filter(|t| since.is_none_or(|s| *t >= s));
        let wake = match fresh {
            Some(at) => {
                let quiet_until = tokio::time::Instant::from_std(at + opts.settle);
                if quiet_until <= tokio::time::Instant::now() {
                    break;
                }
                quiet_until.min(deadline)
            }
            None => deadline,
        };
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::select! {
            () = notified => {}
            () = tokio::time::sleep_until(wake) => {}
            () = cancel.cancelled() => return Err(IdeError::cancelled()),
        }
    }
    Ok(server.diagnostics_for(path))
}
