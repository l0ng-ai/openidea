//! Native, app-owned Jupyter kernels. One supervised process per notebook path.
//!
//! Output routing ends at the matching shell reply AND IOPub idle. Readers remain
//! alive and drain later background output, but never attribute it to another run.

mod process;
mod transport;

use ide_core::{CancellationToken, IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex as AsyncMutex;

pub(super) type StatusCallback = Arc<dyn Fn(&Path, KernelState, Option<String>) + Send + Sync>;
pub(super) type OutputCallback = Arc<dyn Fn(KernelOutput) + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KernelOutput {
    pub kind: String,
    #[specta(type = specta_typescript::Unknown)]
    pub content: Value,
    /// Actual Jupyter parent request ID, not a UI request ID.
    pub msg_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KernelState {
    Starting,
    Idle,
    Busy,
    Dead,
}

impl KernelState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Dead => "dead",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub status: String,
    pub execution_count: Option<u32>,
}

struct Slot {
    operation: AsyncMutex<Option<transport::Running>>,
    interrupt: Mutex<Option<CancellationToken>>,
    stop: Mutex<Option<CancellationToken>>,
    closed: AtomicBool,
}

impl Slot {
    fn new() -> Self {
        Self {
            operation: AsyncMutex::new(None),
            interrupt: Mutex::new(None),
            stop: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }

    fn cancel(&self) {
        if let Some(token) = self.interrupt.lock().as_ref() {
            token.cancel();
        }
    }

    fn stop(&self) {
        self.cancel();
        if let Some(token) = self.stop.lock().as_ref() {
            token.cancel();
        }
    }
}

struct ActiveExecution<'a>(&'a Slot);
impl Drop for ActiveExecution<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.0.interrupt.lock().take() {
            token.cancel();
        }
    }
}

pub struct KernelManager {
    runtime_dir: PathBuf,
    on_status: StatusCallback,
    slots: Mutex<HashMap<PathBuf, Arc<Slot>>>,
    closed: AtomicBool,
}

impl KernelManager {
    pub fn new(runtime_dir: PathBuf, on_status: StatusCallback) -> Self {
        Self { runtime_dir, on_status, slots: Mutex::new(HashMap::new()), closed: AtomicBool::new(false) }
    }

    pub async fn execute(
        &self,
        notebook: &Path,
        python: &Path,
        code: &str,
        cancel: CancellationToken,
        on_output: OutputCallback,
    ) -> IdeResult<ExecutionResult> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let slot = {
            let mut slots = self.slots.lock();
            if self.closed.load(Ordering::Acquire) {
                return Err(IdeError::unavailable("notebook kernel manager is shut down"));
            }
            slots.entry(notebook.to_path_buf()).or_insert_with(|| Arc::new(Slot::new())).clone()
        };
        // Register cancellation before taking the operation lock: interrupt can
        // otherwise race the tiny lock-to-token gap and miss a newly admitted run.
        let interrupt = CancellationToken::new();
        {
            let mut active = slot.interrupt.lock();
            if active.is_some() {
                return Err(IdeError::unavailable("notebook kernel is busy"));
            }
            *active = Some(interrupt.clone());
        }
        let _active = ActiveExecution(&slot);
        // A second caller must not sit in a queue and execute stale source later.
        let mut running = slot.operation.try_lock().map_err(|_| IdeError::unavailable("notebook kernel is busy"))?;
        if slot.closed.load(Ordering::Acquire) {
            return Err(IdeError::unavailable("notebook kernel was closed"));
        }
        if running.as_ref().is_some_and(|r| r.python != python || r.is_finished())
            && let Some(old) = running.take()
        {
            old.shutdown().await;
        }
        if cancel.is_cancelled() || interrupt.is_cancelled() || slot.closed.load(Ordering::Acquire) {
            return Err(IdeError::cancelled());
        }
        if running.is_none() {
            let (new, ready) = transport::Running::spawn(
                self.runtime_dir.clone(),
                notebook.to_path_buf(),
                python.to_path_buf(),
                self.on_status.clone(),
            );
            *slot.stop.lock() = Some(new.stop.clone());
            *running = Some(new);
            if slot.closed.load(Ordering::Acquire) {
                slot.stop();
            }
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(IdeError::cancelled()),
                _ = interrupt.cancelled() => Err(IdeError::cancelled()),
                result = ready => result.unwrap_or_else(|_| Err(IdeError::unavailable("kernel startup task ended"))),
            };
            if let Err(error) = result {
                if let Some(failed) = running.take() {
                    failed.shutdown().await;
                }
                slot.stop.lock().take();
                return Err(error);
            }
        }
        let result = running.as_ref().expect("initialized kernel").execute(code, cancel, interrupt, on_output).await;
        if running.as_ref().is_some_and(transport::Running::is_finished) {
            if let Some(dead) = running.take() {
                dead.shutdown().await;
            }
            slot.stop.lock().take();
        }
        result
    }

    /// Cancels the active request, including startup. The execution future drains
    /// reply+idle before returning, or stops the owned process on interrupt timeout.
    pub async fn interrupt(&self, notebook: &Path) -> IdeResult<()> {
        let slot = self.slots.lock().get(notebook).cloned();
        if let Some(slot) = slot {
            slot.cancel();
            // Wait for native interrupt delivery/drain, not just token mutation.
            let _drained = slot.operation.lock().await;
        }
        Ok(())
    }

    pub async fn restart(&self, notebook: &Path) -> IdeResult<()> {
        let slot = self.slots.lock().get(notebook).cloned();
        let Some(slot) = slot else { return Ok(()) };
        slot.stop();
        let mut running = slot.operation.lock().await;
        if slot.closed.load(Ordering::Acquire) {
            return Err(IdeError::unavailable("notebook kernel was closed"));
        }
        let Some(old) = running.take() else { return Ok(()) };
        let python = old.python.clone();
        old.shutdown().await;
        let (new, ready) =
            transport::Running::spawn(self.runtime_dir.clone(), notebook.to_path_buf(), python, self.on_status.clone());
        *slot.stop.lock() = Some(new.stop.clone());
        *running = Some(new);
        if slot.closed.load(Ordering::Acquire) {
            slot.stop();
        }
        let result = ready.await.unwrap_or_else(|_| Err(IdeError::unavailable("kernel restart task ended")));
        if result.is_err() {
            if let Some(failed) = running.take() {
                failed.shutdown().await;
            }
            slot.stop.lock().take();
        }
        result
    }

    pub async fn shutdown_kernel(&self, notebook: &Path) -> IdeResult<()> {
        let slot = {
            let slots = self.slots.lock();
            // Keep a closed tombstone until old readers/process have drained.
            // Reopening this path cannot overlap old-generation status events.
            let slot = slots.get(notebook).cloned();
            if let Some(slot) = &slot {
                slot.closed.store(true, Ordering::Release);
                slot.stop();
            }
            slot
        };
        if let Some(slot) = slot {
            if let Some(running) = slot.operation.lock().await.take() {
                running.shutdown().await;
            }
            slot.stop.lock().take();
            let mut slots = self.slots.lock();
            if slots.get(notebook).is_some_and(|current| Arc::ptr_eq(current, &slot)) {
                slots.remove(notebook);
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let slots = {
            let mut slots = self.slots.lock();
            self.closed.store(true, Ordering::Release);
            slots
                .drain()
                .map(|(_, slot)| {
                    slot.closed.store(true, Ordering::Release);
                    slot.stop();
                    slot
                })
                .collect::<Vec<_>>()
        };
        // All stop tokens are signalled before awaiting any process.
        for slot in slots {
            if let Some(running) = slot.operation.lock().await.take() {
                running.shutdown().await;
            }
        }
    }
}

impl Drop for KernelManager {
    fn drop(&mut self) {
        for slot in self.slots.get_mut().values() {
            slot.closed.store(true, Ordering::Release);
            slot.stop();
        }
    }
}
