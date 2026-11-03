//! One thread per active plugin owning its [`Runtime`].
//!
//! Callers queue jobs and wait on a reply channel instead of holding a lock
//! across the call, so an edit-path caller can stop waiting at its soft
//! deadline while the call runs on (and is interrupted at the hard deadline
//! by the store's epoch callback), and the call can be cancelled from any
//! thread. A trap poisons the instance: the actor drops it and ends; the
//! host's supervisor decides when to start a new one.
//!
//! wasmtime's async API would let one thread drive every instance, but needs
//! async host bindings throughout; with a plugin's instance only ever entered
//! by one job at a time a parked thread per active plugin costs little, and
//! idle reclaim ends it.

use crate::runtime::{CallCancel, CallError, Runtime};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

type Job = Box<dyn FnOnce(&mut Option<Runtime>) + Send>;

/// Why an [`Actor::call`] produced no result.
#[derive(Debug)]
pub enum ActorError {
    /// The plugin's own outcome: an error it returned, or a trap (the actor has ended).
    Call(CallError),
    /// The caller's wait ran out; the result, if any, is dropped.
    SoftTimeout,
    /// The actor ended (an earlier call trapped, or it was stopped) before running the call.
    Stopped,
    /// The caller cancelled the call (`call_cancellable`).
    Cancelled,
}

/// A call queued with [`Actor::submit`].
pub struct Pending<R> {
    result: mpsc::Receiver<Result<R, CallError>>,
    give_up: Option<Instant>,
    alive: Arc<AtomicBool>,
}

impl<R> Pending<R> {
    /// Waits for the outcome, until the call's soft deadline if it has one.
    pub fn wait(self) -> Result<R, ActorError> {
        let outcome = match self.give_up {
            Some(t) => match self.result.recv_timeout(t.saturating_duration_since(Instant::now())) {
                Ok(r) => r,
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(ActorError::SoftTimeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // Skipped as too late, or the actor ended.
                    let alive = self.alive.load(Ordering::Acquire);
                    return Err(if alive { ActorError::SoftTimeout } else { ActorError::Stopped });
                }
            },
            None => self.result.recv().map_err(|_| ActorError::Stopped)?,
        };
        outcome.map_err(ActorError::Call)
    }
}

pub struct Actor {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    cancel: Arc<CallCancel>,
    alive: Arc<AtomicBool>,
    /// The trap that ended the actor, until someone takes it to report it.
    crash: Arc<Mutex<Option<String>>>,
    busy: Arc<AtomicBool>,
    /// Milliseconds since `epoch` at the last call's end.
    last_used: Arc<AtomicU64>,
    epoch: Instant,
}

impl Actor {
    /// Moves an activated runtime onto its own thread.
    pub fn spawn(name: &str, runtime: Runtime) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let cancel = runtime.cancel_handle();
        let alive = Arc::new(AtomicBool::new(true));
        let busy = Arc::new(AtomicBool::new(false));
        let last_used = Arc::new(AtomicU64::new(0));
        let epoch = Instant::now();
        let thread = {
            let (alive, busy, last_used) = (alive.clone(), busy.clone(), last_used.clone());
            std::thread::Builder::new().name(format!("plugin:{name}")).spawn(move || {
                let mut slot = Some(runtime);
                while let Ok(job) = rx.recv() {
                    busy.store(true, Ordering::Release);
                    job(&mut slot);
                    last_used.store(epoch.elapsed().as_millis() as u64, Ordering::Release);
                    busy.store(false, Ordering::Release);
                    if slot.is_none() {
                        break;
                    }
                }
                alive.store(false, Ordering::Release);
                // Queued jobs are dropped with `rx`: their callers see `Stopped`.
                drop(rx);
                if let Some(mut rt) = slot {
                    rt.deactivate();
                }
            })?
        };
        Ok(Self {
            tx: Mutex::new(Some(tx)),
            thread: Mutex::new(Some(thread)),
            cancel,
            alive,
            crash: Arc::default(),
            busy,
            last_used,
            epoch,
        })
    }

    /// Runs `f` on the plugin's thread. With `wait`, gives up after that long
    /// (counting the time queued behind other calls) and the call, if it has
    /// not started yet, is skipped. Without, waits for the outcome: the
    /// runtime's own deadline bounds it.
    pub fn call<R: Send + 'static>(
        &self,
        wait: Option<Duration>,
        f: impl FnOnce(&mut Runtime) -> Result<R, CallError> + Send + 'static,
    ) -> Result<R, ActorError> {
        self.submit(wait, f)?.wait()
    }

    /// Queues `f` like [`call`](Self::call) and returns at once, so a caller
    /// can start calls on several plugins and then wait for all of them: the
    /// wait is the slowest one's, not the sum.
    pub fn submit<R: Send + 'static>(
        &self,
        wait: Option<Duration>,
        f: impl FnOnce(&mut Runtime) -> Result<R, CallError> + Send + 'static,
    ) -> Result<Pending<R>, ActorError> {
        let give_up = wait.map(|w| Instant::now() + w);
        let (reply, result) = mpsc::sync_channel(1);
        let (crash, alive) = (self.crash.clone(), self.alive.clone());
        let job: Job = Box::new(move |slot| {
            if give_up.is_some_and(|t| Instant::now() >= t) {
                return;
            }
            let Some(rt) = slot.as_mut() else { return };
            let outcome = f(rt);
            if let Err(CallError::Trap(e)) = &outcome {
                *crash.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
                // Before the reply: the caller sees the actor dead.
                alive.store(false, Ordering::Release);
                *slot = None;
            }
            let _ = reply.send(outcome);
        });
        {
            let tx = self.tx.lock().unwrap_or_else(|e| e.into_inner());
            let Some(tx) = tx.as_ref() else { return Err(ActorError::Stopped) };
            tx.send(job).map_err(|_| ActorError::Stopped)?;
        }
        Ok(Pending { result, give_up, alive: self.alive.clone() })
    }

    /// Like [`call`](Self::call) without a soft deadline, but `cancel` (the
    /// caller's request was superseded) cancels the call cooperatively, and
    /// interrupts it if it has not returned `grace` later. Returns
    /// [`ActorError::Cancelled`] then.
    pub fn call_cancellable<R: Send + 'static>(
        &self,
        cancel: &ide_core::CancellationToken,
        grace: Duration,
        f: impl FnOnce(&mut Runtime) -> Result<R, CallError> + Send + 'static,
    ) -> Result<R, ActorError> {
        let (reply, result) = mpsc::sync_channel(1);
        let (crash, alive) = (self.crash.clone(), self.alive.clone());
        let skip = cancel.clone();
        let job: Job = Box::new(move |slot| {
            if skip.is_cancelled() {
                return;
            }
            let Some(rt) = slot.as_mut() else { return };
            let outcome = f(rt);
            if let Err(CallError::Trap(e)) = &outcome {
                *crash.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
                alive.store(false, Ordering::Release);
                *slot = None;
            }
            let _ = reply.send(outcome);
        });
        {
            let tx = self.tx.lock().unwrap_or_else(|e| e.into_inner());
            let Some(tx) = tx.as_ref() else { return Err(ActorError::Stopped) };
            tx.send(job).map_err(|_| ActorError::Stopped)?;
        }
        let mut cancelled_at: Option<Instant> = None;
        loop {
            match result.recv_timeout(Duration::from_millis(5)) {
                Ok(outcome) if cancelled_at.is_some() => {
                    drop(outcome);
                    return Err(ActorError::Cancelled);
                }
                Ok(outcome) => return outcome.map_err(ActorError::Call),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(if cancel.is_cancelled() { ActorError::Cancelled } else { ActorError::Stopped });
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if !cancel.is_cancelled() {
                continue;
            }
            match cancelled_at {
                None => {
                    cancelled_at = Some(Instant::now());
                    if self.is_busy() {
                        self.cancel.cancel_soft();
                    }
                }
                Some(at) if at.elapsed() >= grace => {
                    // Did not return in time: interrupt it (the instance is rebuilt).
                    self.cancel();
                    return Err(ActorError::Cancelled);
                }
                Some(_) => {}
            }
        }
    }

    /// Queues `f` without waiting; `done` gets the outcome on the actor's
    /// thread (`Stopped` if the actor ended before running it).
    pub fn post<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Runtime) -> Result<R, CallError> + Send + 'static,
        done: impl FnOnce(Result<R, ActorError>) + Send + 'static,
    ) {
        let (crash, alive) = (self.crash.clone(), self.alive.clone());
        let job: Job = Box::new(move |slot| {
            let Some(rt) = slot.as_mut() else { return done(Err(ActorError::Stopped)) };
            let outcome = f(rt);
            if let Err(CallError::Trap(e)) = &outcome {
                *crash.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone());
                alive.store(false, Ordering::Release);
                *slot = None;
            }
            done(outcome.map_err(ActorError::Call));
        });
        let tx = self.tx.lock().unwrap_or_else(|e| e.into_inner());
        // A job that can't be queued is dropped, and with it `done` (unrun):
        // the caller sees the actor dead on its next look.
        if let Some(tx) = tx.as_ref() {
            let _ = tx.send(job);
        }
    }

    /// Cooperatively cancels the running call (see [`call_cancellable`](Self::call_cancellable)).
    pub fn cancel_soft(&self) {
        if self.is_busy() {
            self.cancel.cancel_soft();
        }
    }

    /// Interrupts the running call (it fails as a trap: the instance is dropped).
    pub fn cancel(&self) {
        if self.busy.load(Ordering::Acquire) {
            self.cancel.cancel();
        }
    }

    /// The trap that ended this actor; `Some` only for the first caller, which
    /// reports it (also when the caller that saw it had stopped waiting).
    pub fn take_crash(&self) -> Option<String> {
        self.crash.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// The runtime is still usable (no call trapped, not stopped).
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// Time since the last call ended (or since start).
    pub fn idle_for(&self) -> Duration {
        let last = Duration::from_millis(self.last_used.load(Ordering::Acquire));
        self.epoch.elapsed().saturating_sub(last)
    }

    /// Deactivates the plugin and ends the thread after the queued calls.
    /// With `join`, waits for that (bounded by the runtime's deadlines).
    pub fn stop(&self, join: bool) {
        self.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        if join {
            let thread = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(t) = thread
                && t.thread().id() != std::thread::current().id()
            {
                let _ = t.join();
            }
        }
    }
}

impl Drop for Actor {
    fn drop(&mut self) {
        self.stop(false);
    }
}
