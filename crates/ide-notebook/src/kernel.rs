//! Native, app-owned Jupyter kernels. One supervised process per notebook path.
//!
//! Output routing ends at the matching shell reply AND IOPub idle. Readers remain
//! alive and drain later background output, but never attribute it to another run.

pub mod debug;
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

/// A read of the variables running longer is interrupted. Its kernel is kept even if it does
/// not drain; an Interrupt then stops it like a run.
const READ_LIMIT: Duration = Duration::from_secs(5);

pub use transport::remote::{KernelSpec, kernel_specs, normalize_server_url};

/// Where a notebook's kernel runs.
#[derive(Clone, PartialEq, Eq)]
pub enum KernelTarget {
    /// A kernel the IDE starts from this Python interpreter.
    Local(PathBuf),
    /// A kernel started on a Jupyter server.
    Remote(RemoteKernel),
}

/// A kernel spec on a Jupyter server, and the token to reach it.
#[derive(Clone, PartialEq, Eq)]
pub struct RemoteKernel {
    /// The server's base URL, ending in `/` (see [`normalize_server_url`]).
    pub base: String,
    pub token: String,
    pub spec: String,
}

impl std::fmt::Debug for RemoteKernel {
    // Leaves out the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteKernel").field("base", &self.base).field("spec", &self.spec).finish()
    }
}

impl From<&Path> for KernelTarget {
    fn from(python: &Path) -> Self {
        Self::Local(python.to_path_buf())
    }
}

impl From<&PathBuf> for KernelTarget {
    fn from(python: &PathBuf) -> Self {
        Self::Local(python.clone())
    }
}

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
    /// The reply's `user_expressions`, by name.
    #[serde(skip)]
    pub user_expressions: Option<Value>,
}

struct Slot {
    operation: AsyncMutex<Option<transport::Running>>,
    interrupt: Mutex<Option<CancellationToken>>,
    stop: Mutex<Option<CancellationToken>>,
    closed: AtomicBool,
    /// Inspections in flight. One holds `operation`; a run waits for it instead of failing as busy.
    inspecting: AtomicUsize,
    /// Interrupts the inspection holding `operation`.
    inspection: Mutex<Option<CancellationToken>>,
    /// Counts `cancel()` calls, so an inspection sees one that came before its token was set.
    interrupts: AtomicUsize,
    debug: transport::DebugPort,
}

impl Slot {
    fn new() -> Self {
        Self {
            operation: AsyncMutex::new(None),
            interrupt: Mutex::new(None),
            stop: Mutex::new(None),
            closed: AtomicBool::new(false),
            inspecting: AtomicUsize::new(0),
            inspection: Mutex::new(None),
            interrupts: AtomicUsize::new(0),
            debug: transport::DebugPort::default(),
        }
    }

    fn cancel(&self) {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        if let Some(token) = self.interrupt.lock().as_ref() {
            token.cancel();
        }
        // A run waiting behind a stuck inspection is interrupted through it.
        if let Some(token) = self.inspection.lock().as_ref() {
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

struct Inspecting<'a>(&'a Slot);
impl Drop for Inspecting<'_> {
    fn drop(&mut self) {
        self.0.inspecting.fetch_sub(1, Ordering::AcqRel);
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
        target: impl Into<KernelTarget>,
        code: &str,
        cancel: CancellationToken,
        on_output: OutputCallback,
    ) -> IdeResult<ExecutionResult> {
        let target = target.into();
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
        let mut running = match slot.operation.try_lock() {
            Ok(running) => running,
            Err(_) if slot.inspecting.load(Ordering::Acquire) > 0 => slot.operation.lock().await,
            Err(_) => return Err(IdeError::unavailable("notebook kernel is busy")),
        };
        if slot.closed.load(Ordering::Acquire) {
            return Err(IdeError::unavailable("notebook kernel was closed"));
        }
        if running.as_ref().is_some_and(|r| r.target != target || r.is_finished())
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
                target,
                self.on_status.clone(),
                slot.debug.clone(),
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
        let result =
            running.as_ref().expect("initialized kernel").execute(code, None, cancel, interrupt, on_output).await;
        if running.as_ref().is_some_and(transport::Running::is_finished) {
            if let Some(dead) = running.take() {
                dead.shutdown().await;
            }
            slot.stop.lock().take();
        }
        result
    }

    /// Runs `code` silently on the notebook's idle kernel and returns the reply's
    /// `user_expressions`. Never starts a kernel: `None` when none is running.
    pub async fn inspect(
        &self,
        notebook: &Path,
        code: &str,
        expressions: HashMap<String, String>,
    ) -> IdeResult<Option<Value>> {
        let slot = self.slots.lock().get(notebook).cloned();
        let Some(slot) = slot else { return Ok(None) };
        if slot.interrupt.lock().is_some() {
            return Err(IdeError::unavailable("notebook kernel is busy"));
        }
        let interrupts = slot.interrupts.load(Ordering::SeqCst);
        // Counted before locking, so a run arriving meanwhile waits rather than failing.
        slot.inspecting.fetch_add(1, Ordering::AcqRel);
        let _inspecting = Inspecting(&slot);
        let running = slot.operation.try_lock().map_err(|_| IdeError::unavailable("notebook kernel is busy"))?;
        let Some(kernel) = running.as_ref().filter(|r| !r.is_finished() && !slot.closed.load(Ordering::Acquire)) else {
            return Ok(None);
        };
        // Interrupt, restart and close reach it through `inspection` and the stop token.
        let interrupt = CancellationToken::new();
        *slot.inspection.lock() = Some(interrupt.clone());
        if slot.interrupts.load(Ordering::SeqCst) != interrupts {
            interrupt.cancel();
        }
        // Interrupted at the limit, never dropped: the waiting run needs the kernel drained.
        let limit = CancellationToken::new();
        let timer = tokio::spawn({
            let limit = limit.clone();
            async move {
                tokio::time::sleep(READ_LIMIT).await;
                limit.cancel();
            }
        });
        let result = kernel.execute(code, Some(expressions), limit, interrupt, Arc::new(|_| {})).await;
        timer.abort();
        slot.inspection.lock().take();
        Ok(result?.user_expressions)
    }

    /// Whether the notebook has a running kernel.
    pub fn running(&self, notebook: &Path) -> bool {
        self.slots.lock().get(notebook).is_some_and(|slot| slot.debug.attached())
    }

    /// Opens the debugger of the notebook's running kernel. One session at a time; it ends
    /// when the returned value is dropped or the kernel stops.
    pub fn debugger(&self, notebook: &Path) -> IdeResult<KernelDebugger> {
        let slot = self.slots.lock().get(notebook).cloned();
        let slot = slot.ok_or_else(|| IdeError::unavailable("the notebook's kernel is not running"))?;
        let (control, inbox) = slot.debug.open()?;
        Ok(KernelDebugger { control, inbox })
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
        let target = old.target.clone();
        old.shutdown().await;
        let (new, ready) = transport::Running::spawn(
            self.runtime_dir.clone(),
            notebook.to_path_buf(),
            target,
            self.on_status.clone(),
            slot.debug.clone(),
        );
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

/// A debug session on a notebook's kernel, in the Jupyter debugger protocol: DAP requests
/// go out as `debug_request`, DAP responses and events come back.
pub struct KernelDebugger {
    control: tokio::sync::mpsc::Sender<jupyter_protocol::JupyterMessage>,
    inbox: tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl KernelDebugger {
    /// Sends a DAP request.
    pub async fn send(&self, request: Value) -> IdeResult<()> {
        let message: jupyter_protocol::JupyterMessage = jupyter_protocol::DebugRequest { content: request }.into();
        self.control.send(message).await.map_err(|_| IdeError::unavailable("the notebook's kernel stopped"))
    }

    /// The next DAP response or event; `None` once the kernel stopped.
    pub async fn receive(&mut self) -> Option<Value> {
        tokio::select! {
            message = self.inbox.recv() => message,
            () = self.control.closed() => None,
        }
    }
}
