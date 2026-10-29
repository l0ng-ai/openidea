//! Project-incarnation notebook ownership and whole-batch execution admission.
use crate::ops::Channel;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, SharedSink};
use ide_notebook::kernel::{KernelManager, KernelOutput};
use ide_notebook::{NotebookDocument, NotebookEdit, NotebookSnapshot};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, watch};

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookOutputEvent {
    pub id: String,
    pub path: String,
    pub cell: String,
    pub msg_id: String,
    pub kind: String,
    #[specta(type = specta_typescript::Unknown)]
    pub content: serde_json::Value,
    pub version: u32,
    pub dirty: bool,
    pub changed_cells: Vec<String>,
}

#[derive(Default)]
struct Registry {
    stopped: bool,
    paths: HashMap<PathBuf, String>,
    documents: HashMap<String, Arc<ManagedDocument>>,
}

struct ManagedDocument {
    id: String,
    path: PathBuf,
    state: Mutex<DocumentState>,
    control: AsyncMutex<()>,
}

struct DocumentState {
    document: NotebookDocument,
    generation: u64,
    transitioning: bool,
    closed: bool,
    active: Option<Arc<Batch>>,
    kernel_status: Option<(String, Option<String>)>,
}

struct Batch {
    cancel: CancellationToken,
    done: watch::Sender<bool>,
}

struct BatchGuard {
    document: Arc<ManagedDocument>,
    batch: Arc<Batch>,
}

pub(crate) struct ExecutionAdmission {
    guard: BatchGuard,
    generation: u64,
    plan: Vec<(String, String)>,
}

impl Drop for BatchGuard {
    fn drop(&mut self) {
        let mut state = self.document.state.lock();
        if state.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.batch)) {
            if let Err(error) = state.document.set_execution_active(false) {
                tracing::error!("notebook batch release: {error}");
            }
            state.active = None;
        }
        self.batch.done.send_replace(true);
    }
}

pub struct NotebookService {
    registry: Arc<Mutex<Registry>>,
    kernels: Arc<KernelManager>,
    sink: SharedSink,
}

impl NotebookService {
    pub fn new(runtime_dir: PathBuf, sink: SharedSink) -> Arc<Self> {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let status_registry = registry.clone();
        let status_sink = sink.clone();
        let kernels = KernelManager::new(
            runtime_dir,
            Arc::new(move |path, status, message| {
                let document = {
                    let registry = status_registry.lock();
                    if registry.stopped {
                        return;
                    }
                    registry.paths.get(path).and_then(|id| registry.documents.get(id)).cloned()
                };
                if let Some(document) = document {
                    let deliver = {
                        let mut state = document.state.lock();
                        if state.closed {
                            return;
                        }
                        state.kernel_status = Some((status.as_str().to_owned(), message.clone()));
                        !state.transitioning
                    };
                    if deliver {
                        status_sink.emit(IdeEvent::NotebookKernel {
                            id: document.id.clone(),
                            path: path.to_path_buf().into(),
                            state: status.as_str().to_owned(),
                            message,
                        });
                    }
                }
            }),
        );
        Arc::new(Self { registry, kernels: Arc::new(kernels), sink })
    }

    pub fn open(&self, path: &Path) -> IdeResult<NotebookSnapshot> {
        let path = dunce::canonicalize(path)?;
        // Serialize first load with path insertion: split views share one incarnation.
        let mut registry = self.registry.lock();
        if registry.stopped {
            return Err(IdeError::cancelled());
        }
        if let Some(id) = registry.paths.get(&path) {
            return snapshot(&registry.documents[id]);
        }
        let document = NotebookDocument::load(&path)?;
        let initial = document.snapshot();
        let id = initial.id.clone();
        registry.paths.insert(path.clone(), id.clone());
        registry.documents.insert(
            id.clone(),
            Arc::new(ManagedDocument {
                id,
                path,
                state: Mutex::new(DocumentState {
                    document,
                    generation: 0,
                    transitioning: false,
                    closed: false,
                    active: None,
                    kernel_status: None,
                }),
                control: AsyncMutex::new(()),
            }),
        );
        Ok(initial)
    }

    fn resolve(&self, id: &str) -> IdeResult<Arc<ManagedDocument>> {
        let registry = self.registry.lock();
        if registry.stopped {
            return Err(IdeError::not_found("notebook project has closed"));
        }
        registry.documents.get(id).cloned().ok_or_else(|| IdeError::not_found("notebook incarnation is closed"))
    }

    pub fn get(&self, id: &str) -> IdeResult<NotebookSnapshot> {
        snapshot(self.resolve(id)?.as_ref())
    }

    pub fn edit(&self, id: &str, version: u32, edit: NotebookEdit) -> IdeResult<NotebookSnapshot> {
        let document = self.resolve(id)?;
        let mut state = document.state.lock();
        mutable(&state)?;
        state.document.edit(version, edit)
    }

    pub fn save(&self, id: &str) -> IdeResult<NotebookSnapshot> {
        let document = self.resolve(id)?;
        let mut state = document.state.lock();
        mutable(&state)?;
        state.document.save()
    }

    pub fn undo(&self, id: &str, redo: bool) -> IdeResult<NotebookSnapshot> {
        let document = self.resolve(id)?;
        let mut state = document.state.lock();
        mutable(&state)?;
        if state.active.is_some() {
            return Err(IdeError::unavailable("stop notebook execution before undo or redo"));
        }
        if redo { state.document.redo() } else { state.document.undo() }
    }

    pub async fn interrupt(&self, id: &str) -> IdeResult<()> {
        let document = self.resolve(id)?;
        let batch = document.state.lock().active.clone();
        if let Some(batch) = &batch {
            batch.cancel.cancel();
        }
        // Draining makes prepareClose/save a stable checkpoint, including when
        // Python catches KeyboardInterrupt or cancel races with kernel startup.
        let interrupt = self.kernels.interrupt(&document.path).await;
        self.drain(&document, batch).await?;
        interrupt
    }

    async fn drain(&self, document: &ManagedDocument, batch: Option<Arc<Batch>>) -> IdeResult<()> {
        let Some(batch) = batch else { return Ok(()) };
        let mut done = batch.done.subscribe();
        match tokio::time::timeout(Duration::from_secs(5), done.wait_for(|done| *done)).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(_)) => return Err(IdeError::internal("notebook execution completion channel closed")),
            Err(_) => {}
        }
        // An uncooperative kernel must not outlive a close/reload authorization.
        self.kernels.shutdown_kernel(&document.path).await?;
        tokio::time::timeout(Duration::from_secs(5), done.wait_for(|done| *done))
            .await
            .map_err(|_| IdeError::unavailable("notebook execution did not stop after kernel shutdown"))?
            .map_err(|_| IdeError::internal("notebook execution completion channel closed"))?;
        Ok(())
    }

    pub async fn reload(&self, id: &str, restart: bool) -> IdeResult<NotebookSnapshot> {
        let document = self.resolve(id)?;
        let _control = document.control.lock().await;
        let batch = invalidate(&document)?;
        let result = async {
            let _ = self.kernels.interrupt(&document.path).await;
            self.drain(&document, batch).await?;
            if document.state.lock().closed {
                return Err(IdeError::cancelled());
            }
            if restart {
                self.kernels.restart(&document.path).await?;
                snapshot(&document)
            } else {
                self.kernels.shutdown_kernel(&document.path).await?;
                document.state.lock().document.reload()
            }
        }
        .await;
        let status = {
            let mut state = document.state.lock();
            state.transitioning = false;
            if state.closed { None } else { state.kernel_status.clone() }
        };
        if let Some((state, message)) = status {
            self.sink.emit(IdeEvent::NotebookKernel {
                id: document.id.clone(),
                path: document.path.clone().into(),
                state,
                message,
            });
        }
        result
    }

    /// Frontend disposal may arrive after project replacement has already retired this id.
    pub async fn close(&self, id: &str) -> IdeResult<()> {
        let document = match self.resolve(id) {
            Ok(document) => document,
            Err(error) if error.kind == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let _control = document.control.lock().await;
        if document.state.lock().closed {
            return Ok(());
        }
        let batch = invalidate(&document)?;
        let result = async {
            let _ = self.kernels.interrupt(&document.path).await;
            self.drain(&document, batch).await?;
            self.kernels.shutdown_kernel(&document.path).await
        }
        .await;
        if let Err(error) = result {
            document.state.lock().transitioning = false;
            return Err(error);
        }
        document.state.lock().closed = true;
        let mut registry = self.registry.lock();
        registry.documents.remove(id);
        registry.paths.remove(&document.path);
        Ok(())
    }

    pub(crate) fn admit(
        &self,
        id: &str,
        cells: Vec<String>,
        cancel: CancellationToken,
    ) -> IdeResult<ExecutionAdmission> {
        admit(self.resolve(id)?, cells, cancel)
    }

    pub(crate) async fn execute(
        self: &Arc<Self>,
        admission: ExecutionAdmission,
        python: PathBuf,
        on_output: Channel<NotebookOutputEvent>,
    ) -> IdeResult<NotebookSnapshot> {
        let document = admission.guard.document.clone();
        let service = self.clone();
        // Keep admission and native execution owned if an IPC receiver disappears.
        tokio::spawn(async move {
            let ExecutionAdmission { guard, generation, plan } = admission;
            let result =
                service.run_batch(document.clone(), generation, plan, python, guard.batch.clone(), on_output).await;
            drop(guard);
            match result {
                Ok(()) => snapshot(&document),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| IdeError::internal(error.to_string()))?
    }

    async fn run_batch(
        &self,
        document: Arc<ManagedDocument>,
        generation: u64,
        plan: Vec<(String, String)>,
        python: PathBuf,
        batch: Arc<Batch>,
        on_output: Channel<NotebookOutputEvent>,
    ) -> IdeResult<()> {
        for (cell, source) in plan {
            {
                let mut state = document.state.lock();
                if batch.cancel.is_cancelled() || state.closed || state.generation != generation {
                    return Err(IdeError::cancelled());
                }
                // A user may delete a queued cell while an earlier one executes.
                // Never resurrect it from the captured source or a late output.
                match state.document.begin_execution(&cell) {
                    Ok(()) => {}
                    Err(error) if error.kind == ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                }
            }
            let output_error = Arc::new(Mutex::new(None));
            let callback_document = document.clone();
            let callback_batch = batch.clone();
            let callback_error = output_error.clone();
            let callback_cell = cell.clone();
            let channel = on_output.clone();
            let result = self
                .kernels
                .execute(
                    &document.path,
                    &python,
                    &source,
                    batch.cancel.clone(),
                    Arc::new(move |output: KernelOutput| {
                        let event = match commit_output(
                            &callback_document,
                            &callback_batch,
                            generation,
                            &callback_cell,
                            output,
                        ) {
                            Ok(Some(event)) => event,
                            Ok(None) => return,
                            Err(error) => {
                                *callback_error.lock() = Some(error);
                                callback_batch.cancel.cancel();
                                return;
                            }
                        };
                        let _ = channel.send(event);
                    }),
                )
                .await;
            if let Some(error) = output_error.lock().take() {
                return Err(error);
            }
            let result = result?;
            if batch.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if result.status != "ok" {
                break;
            }
        }
        let state = document.state.lock();
        if state.closed || state.generation != generation || batch.cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(())
    }

    /// Synchronously revoke admission before handing cleanup to an async runtime.
    pub fn stop_admission(&self) {
        let mut registry = self.registry.lock();
        registry.stopped = true;
        for document in registry.documents.values() {
            let mut state = document.state.lock();
            state.closed = true;
            state.generation += 1;
            if let Some(batch) = &state.active {
                batch.cancel.cancel();
            }
        }
    }

    pub async fn shutdown(&self) {
        self.stop_admission();
        self.kernels.shutdown().await;
        let documents: Vec<_> = self.registry.lock().documents.values().cloned().collect();
        for document in documents {
            let batch = document.state.lock().active.clone();
            if let Err(error) = self.drain(&document, batch).await {
                tracing::error!("notebook cleanup: {error}");
            }
        }
        let mut registry = self.registry.lock();
        registry.paths.clear();
        registry.documents.clear();
    }
}

fn mutable(state: &DocumentState) -> IdeResult<()> {
    if state.closed {
        Err(IdeError::not_found("notebook incarnation is closed"))
    } else if state.transitioning {
        Err(IdeError::unavailable("notebook lifecycle operation is in progress"))
    } else {
        Ok(())
    }
}

fn snapshot(document: &ManagedDocument) -> IdeResult<NotebookSnapshot> {
    let state = document.state.lock();
    if state.closed {
        return Err(IdeError::not_found("notebook incarnation is closed"));
    }
    Ok(state.document.snapshot())
}

fn invalidate(document: &ManagedDocument) -> IdeResult<Option<Arc<Batch>>> {
    let mut state = document.state.lock();
    mutable(&state)?;
    state.transitioning = true;
    state.generation += 1;
    if let Some(batch) = &state.active {
        batch.cancel.cancel();
    }
    Ok(state.active.clone())
}

fn execution_plan(snapshot: &NotebookSnapshot, cells: Vec<String>) -> IdeResult<Vec<(String, String)>> {
    let mut selected: HashSet<_> = cells.iter().map(String::as_str).collect();
    if selected.is_empty() || selected.len() != cells.len() {
        return Err(IdeError::invalid("select distinct code cells to execute"));
    }
    let mut plan = Vec::with_capacity(selected.len());
    for cell in &snapshot.cells {
        if selected.remove(cell.id.as_str()) {
            if cell.cell_type != "code" {
                return Err(IdeError::invalid("only code cells can execute"));
            }
            plan.push((cell.id.clone(), cell.source.clone()));
        }
    }
    if !selected.is_empty() {
        return Err(IdeError::not_found("an execution cell no longer exists"));
    }
    Ok(plan)
}

fn admit(
    document: Arc<ManagedDocument>,
    cells: Vec<String>,
    cancel: CancellationToken,
) -> IdeResult<ExecutionAdmission> {
    let (batch, generation, plan) = {
        let mut state = document.state.lock();
        mutable(&state)?;
        if state.active.is_some() {
            return Err(IdeError::unavailable("notebook execution batch is already running"));
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let plan = execution_plan(&state.document.snapshot(), cells)?;
        state.document.set_execution_active(true)?;
        let (done, _) = watch::channel(false);
        let batch = Arc::new(Batch { cancel, done });
        state.active = Some(batch.clone());
        (batch, state.generation, plan)
    };
    Ok(ExecutionAdmission { guard: BatchGuard { document, batch }, generation, plan })
}

/// Commit under the short document lock; the caller delivers only after release.
fn commit_output(
    document: &ManagedDocument,
    batch: &Arc<Batch>,
    generation: u64,
    cell: &str,
    output: KernelOutput,
) -> IdeResult<Option<NotebookOutputEvent>> {
    let mut state = document.state.lock();
    if state.closed
        || state.generation != generation
        || !state.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, batch))
    {
        return Ok(None);
    }
    let changed_cells = match state.document.record_output(cell, &output) {
        Ok(changed) => changed,
        Err(error) if error.kind == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(NotebookOutputEvent {
        id: document.id.clone(),
        path: document.path.to_string_lossy().into_owned(),
        cell: cell.to_owned(),
        msg_id: output.msg_id,
        kind: output.kind,
        content: output.content,
        version: state.document.version(),
        dirty: state.document.is_dirty(),
        changed_cells,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, Arc<NotebookService>, NotebookSnapshot) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.ipynb");
        std::fs::write(&path, serde_json::to_vec(&json!({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"id":"first","cell_type":"code","metadata":{},"source":"x = 1","outputs":[],"execution_count":null},
                {"id":"second","cell_type":"code","metadata":{},"source":"print(x)","outputs":[],"execution_count":null},
                {"id":"prose","cell_type":"markdown","metadata":{},"source":"notes"}
            ]
        })).unwrap()).unwrap();
        let service = NotebookService::new(dir.path().join("kernels"), Arc::new(ide_core::NullSink));
        let snapshot = service.open(&path).unwrap();
        (dir, service, snapshot)
    }

    fn output(kind: &str, content: serde_json::Value) -> KernelOutput {
        KernelOutput { kind: kind.into(), content, msg_id: "actual-parent-request".into() }
    }

    #[tokio::test]
    async fn canonical_split_opens_share_incarnation_but_reopen_and_projects_do_not() {
        let (dir, service, initial) = fixture();
        let alternate = dir.path().join(".").join("session.ipynb");
        assert_eq!(service.open(&alternate).unwrap().id, initial.id);
        let other = NotebookService::new(dir.path().join("other-runtime"), Arc::new(ide_core::NullSink));
        let independent = other.open(&alternate).unwrap();
        assert_ne!(initial.id, independent.id);
        assert_eq!(other.get(&initial.id).unwrap_err().kind, ErrorKind::NotFound);
        service.close(&initial.id).await.unwrap();
        let reopened = service.open(&alternate).unwrap();
        assert_ne!(reopened.id, initial.id);
        assert_eq!(service.get(&initial.id).unwrap_err().kind, ErrorKind::NotFound);
        // A delayed old-incarnation close cannot dispose a new session at that path.
        service.close(&initial.id).await.unwrap();
        assert_eq!(service.get(&reopened.id).unwrap().id, reopened.id);
        service.shutdown().await;
        other.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn failed_close_keeps_the_incarnation_recoverable_until_a_retry_succeeds() {
        let (dir, service, initial) = fixture();
        // A batch that never drains models a kernel that ignores interrupt and shutdown.
        let admission =
            service.admit(&initial.id, vec![initial.cells[0].id.clone()], CancellationToken::new()).unwrap();
        let error = service.close(&initial.id).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Unavailable);
        assert!(admission.guard.batch.cancel.is_cancelled());
        // The backend still owns the incarnation: a reopen shares it instead of
        // starting a second kernel, and the failed close left it usable.
        let reopened = service.open(&dir.path().join("session.ipynb")).unwrap();
        assert_eq!(reopened.id, initial.id);
        assert!(matches!(service.admit(&initial.id, vec![initial.cells[0].id.clone()], CancellationToken::new()),
            Err(error) if error.kind == ErrorKind::Unavailable));
        drop(admission);
        service.close(&initial.id).await.unwrap();
        assert_eq!(service.get(&initial.id).unwrap_err().kind, ErrorKind::NotFound);
        assert_ne!(service.open(&dir.path().join("session.ipynb")).unwrap().id, initial.id);
        service.shutdown().await;
    }

    #[test]
    fn batch_admission_captures_document_order_and_retains_busy_until_drained() {
        let (_dir, service, initial) = fixture();
        let document = service.resolve(&initial.id).unwrap();
        let cells = vec![initial.cells[1].id.clone(), initial.cells[0].id.clone()];
        let admission = admit(document.clone(), cells.clone(), CancellationToken::new()).unwrap();
        assert_eq!(
            admission.plan,
            vec![(initial.cells[0].id.clone(), "x = 1".into()), (initial.cells[1].id.clone(), "print(x)".into()),]
        );
        service
            .edit(
                &initial.id,
                initial.version,
                NotebookEdit::SetSource { cell: initial.cells[1].id.clone(), source: "print('new source')".into() },
            )
            .unwrap();
        assert_eq!(admission.plan[1].1, "print(x)");
        assert_eq!(service.undo(&initial.id, false).unwrap_err().kind, ErrorKind::Unavailable);
        admission.guard.batch.cancel.cancel();
        assert!(matches!(admit(document.clone(), cells.clone(), CancellationToken::new()), Err(error)
            if error.kind == ErrorKind::Unavailable));
        drop(admission);
        let next = admit(document, cells, CancellationToken::new()).unwrap();
        assert_eq!(next.plan[1].1, "print('new source')");
    }

    #[test]
    fn output_commits_revision_and_cross_cell_display_updates_before_delivery() {
        let (_dir, service, initial) = fixture();
        let document = service.resolve(&initial.id).unwrap();
        let cells: Vec<_> = initial.cells[..2].iter().map(|cell| cell.id.clone()).collect();
        let admission = admit(document.clone(), cells.clone(), CancellationToken::new()).unwrap();
        let event = commit_output(
            &document,
            &admission.guard.batch,
            admission.generation,
            &cells[0],
            output(
                "display_data",
                json!({"data":{"text/plain":"before"},"metadata":{},"transient":{"display_id":"shared"}}),
            ),
        )
        .unwrap()
        .unwrap();
        let committed = service.get(&initial.id).unwrap();
        assert_eq!(event.version, committed.version);
        assert!(event.version > initial.version);
        assert!(event.dirty);
        assert_eq!(event.msg_id, "actual-parent-request");
        assert_eq!(committed.cells[0].outputs[0]["data"]["text/plain"], "before");
        let updated = commit_output(
            &document,
            &admission.guard.batch,
            admission.generation,
            &cells[1],
            output(
                "update_display_data",
                json!({"data":{"text/plain":"after"},"metadata":{},"transient":{"display_id":"shared"}}),
            ),
        )
        .unwrap()
        .unwrap();
        assert!(updated.changed_cells.contains(&cells[0]));
        let committed = service.get(&initial.id).unwrap();
        assert_eq!(committed.cells[0].outputs[0]["data"]["text/plain"], "after");
        assert!(committed.cells[0].outputs[0].get("transient").is_none());
        assert_eq!(updated.version, committed.version);
    }

    #[test]
    fn invalidated_or_completed_batches_cannot_commit_and_deleted_cells_stay_deleted() {
        let (_dir, service, initial) = fixture();
        let document = service.resolve(&initial.id).unwrap();
        let cell = initial.cells[0].id.clone();
        let admission = admit(document.clone(), vec![cell.clone()], CancellationToken::new()).unwrap();
        let deleted =
            service.edit(&initial.id, initial.version, NotebookEdit::DeleteCell { cell: cell.clone() }).unwrap();
        assert!(
            commit_output(
                &document,
                &admission.guard.batch,
                admission.generation,
                &cell,
                output("stream", json!({"name":"stdout","text":"late"}))
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(service.get(&initial.id).unwrap().version, deleted.version);
        let other = initial.cells[1].id.clone();
        invalidate(&document).unwrap();
        assert!(admission.guard.batch.cancel.is_cancelled());
        assert!(
            commit_output(
                &document,
                &admission.guard.batch,
                admission.generation,
                &other,
                output("stream", json!({"name":"stdout","text":"old generation"}))
            )
            .unwrap()
            .is_none()
        );
        let batch = admission.guard.batch.clone();
        let generation = document.state.lock().generation;
        drop(admission);
        assert!(
            commit_output(
                &document,
                &batch,
                generation,
                &other,
                output("stream", json!({"name":"stdout","text":"post idle"}))
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(service.get(&initial.id).unwrap().version, deleted.version);
    }

    #[tokio::test]
    async fn reload_preserves_incarnation_and_project_shutdown_revokes_all_admission() {
        let (_dir, service, initial) = fixture();
        let changed = service
            .edit(
                &initial.id,
                initial.version,
                NotebookEdit::SetSource { cell: initial.cells[0].id.clone(), source: "changed".into() },
            )
            .unwrap();
        let reloaded = service.reload(&initial.id, false).await.unwrap();
        assert_eq!(reloaded.id, initial.id);
        assert!(reloaded.version > changed.version);
        assert_eq!(reloaded.cells[0].source, "x = 1");
        assert!(!reloaded.dirty);
        let document = service.resolve(&initial.id).unwrap();
        let admission = admit(document.clone(), vec![initial.cells[0].id.clone()], CancellationToken::new()).unwrap();
        service.stop_admission();
        assert!(admission.guard.batch.cancel.is_cancelled());
        assert_eq!(service.get(&initial.id).unwrap_err().kind, ErrorKind::NotFound);
        assert!(matches!(admit(document, vec![initial.cells[0].id.clone()], CancellationToken::new()), Err(error)
            if error.kind == ErrorKind::NotFound));
        drop(admission);
        service.shutdown().await;
    }

    #[test]
    fn invalid_batch_selection_does_not_claim_admission() {
        let (_dir, service, initial) = fixture();
        let document = service.resolve(&initial.id).unwrap();
        for cells in [
            vec![],
            vec![initial.cells[0].id.clone(), initial.cells[0].id.clone()],
            vec![initial.cells[2].id.clone()],
            vec!["deleted".into()],
        ] {
            assert!(admit(document.clone(), cells, CancellationToken::new()).is_err());
        }
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(admit(document.clone(), vec![initial.cells[0].id.clone()], cancelled), Err(error)
            if error.kind == ErrorKind::Cancelled));
        let valid = admit(document, vec![initial.cells[0].id.clone()], CancellationToken::new()).unwrap();
        assert_eq!(valid.plan[0].1, "x = 1");
    }

    #[tokio::test]
    async fn interrupt_cancels_before_drain_and_does_not_release_a_live_batch() {
        let (_dir, service, initial) = fixture();
        service
            .edit(
                &initial.id,
                initial.version,
                NotebookEdit::SetSource { cell: initial.cells[0].id.clone(), source: "changed source".into() },
            )
            .unwrap();
        let cancel = CancellationToken::new();
        let admission = service.admit(&initial.id, vec![initial.cells[0].id.clone()], cancel.clone()).unwrap();
        let interrupt_service = service.clone();
        let id = initial.id.clone();
        let interrupt = tokio::spawn(async move { interrupt_service.interrupt(&id).await });
        tokio::time::timeout(Duration::from_secs(1), cancel.cancelled()).await.unwrap();
        assert!(!interrupt.is_finished(), "interrupt must wait for owned execution to drain");
        assert!(matches!(service.admit(&initial.id, vec![initial.cells[0].id.clone()], CancellationToken::new()),
            Err(error) if error.kind == ErrorKind::Unavailable));
        let mut done = admission.guard.batch.done.subscribe();
        drop(admission);
        assert!(*done.borrow_and_update());
        tokio::time::timeout(Duration::from_secs(1), interrupt).await.unwrap().unwrap().unwrap();
        let next = service.admit(&initial.id, vec![initial.cells[0].id.clone()], CancellationToken::new()).unwrap();
        assert_eq!(next.plan[0].1, "changed source");
        drop(next);
        let undone = service.undo(&initial.id, false).unwrap();
        assert_eq!(undone.cells[0].source, "x = 1");
        service.close(&initial.id).await.unwrap();
    }
}
