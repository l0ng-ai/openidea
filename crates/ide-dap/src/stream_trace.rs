//! A stream chain traced while the program itself runs it. The JDT LS bundle arms the trace with
//! the thread stopped where the chain starts; the program runs on `continue`, and the bundle holds
//! the thread inside the terminal operation once it has run, until a `stepOut` brings java-debug
//! to a stop of its own in which the records are read.

use crate::jvm_memory::vm_target;
use crate::session::Session;
use crate::{DebugManager, StepKind};
use ide_core::event::DebugEvent;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_jvm_inspect::{
    AbortState, InspectError, InspectFuture, StreamTracer, TraceCollected, TraceId, TraceState, VmTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// Records the bundle keeps; later ones are only counted.
const BUDGET: u32 = 50_000;
const WAIT_MS: u32 = 500;
const STOP_POLL: Duration = Duration::from_millis(20);
const STOP_WAIT: Duration = Duration::from_secs(30);
const RESUME_TIMEOUT: Duration = Duration::from_secs(30);
/// The bundle reaches the JVM through java-debug's own session.
const ADAPTER: &str = "java-debug";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TraceProgress {
    pub phase: TracePhase,
    pub records: u64,
    pub dropped: u64,
    /// Since the program started running the chain, as the bundle measures it.
    pub elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TracePhase {
    Arming,
    Running,
    /// The terminal operation runs on, keeping no more records.
    RecordingStopped,
    Aborting,
    /// The terminal operation finished: stepping out of it and reading the records.
    Collecting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TraceRun {
    /// `generation`: the stop the records were read in, the only one their objects are valid in.
    Done {
        collected: TraceCollected,
        generation: u64,
        /// Stops of the traced thread while the program ran the chain, resumed unseen.
        resumed_stops: u32,
    },
    Unavailable {
        reason: TraceUnavailable,
    },
    Failed {
        detail: String,
    },
    /// Stop Recording or Abort Operation came before the terminal operation ran.
    Cancelled {
        detail: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TraceUnavailable {
    /// Not a java-debug session, or no JDT LS bundle behind it.
    NoBackend,
    NotSuspended,
    NotAtChainStart {
        detail: String,
    },
    /// A trace already runs in this session or its JVM.
    Busy,
    /// java-debug has no debug session for the JVM.
    NoSession,
    Unsupported {
        detail: String,
    },
}

/// The session's running trace; `id` is `None` until `arm` answers.
pub(crate) struct ActiveTrace {
    tracer: Arc<dyn StreamTracer>,
    target: VmTarget,
    id: Option<TraceId>,
    aborting: bool,
    thread_id: i64,
    /// From the `continue` that runs the chain until the bundle holds the thread after it.
    running: bool,
    resumed_stops: u32,
}

/// A stop of the traced thread while the program runs the chain is resumed instead of shown, as
/// IntelliJ does (spec G5): the UI keeps Resume locked meanwhile, and a breakpoint java-debug set
/// since the bundle last switched them off, hit inside the terminal's invoke, would hold that
/// invoke forever. java-debug stops a breakpoint's thread alone; a stop of every thread is shown.
/// `true` when the stop was taken.
pub(crate) fn resume_traced_stop(s: &Arc<Session>, thread_id: Option<i64>, all: bool) -> bool {
    let Some(thread_id) = thread_id.filter(|_| !all) else { return false };
    {
        let mut slot = s.stream_trace.lock();
        let Some(active) = slot.as_mut().filter(|a| a.running && a.thread_id == thread_id) else { return false };
        active.resumed_stops += 1;
    }
    let s = s.clone();
    tokio::spawn(async move {
        let sent =
            s.conn.request_timeout("continue", serde_json::json!({ "threadId": thread_id }), RESUME_TIMEOUT).await;
        if let Err(e) = sent {
            tracing::warn!(session = s.id.0, thread_id, "resuming a stop inside a stream trace: {e}");
        }
    });
    true
}

fn set_running(s: &Session, running: bool) {
    if let Some(active) = s.stream_trace.lock().as_mut() {
        active.running = running;
    }
}

/// Frees the session for the next trace however this one ends, a dropped future included.
struct Claim<'s>(&'s Session);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.stream_trace.lock().take();
    }
}

pub(crate) fn set_tracer(s: &Session, tracer: Arc<dyn StreamTracer>) {
    *s.stream_tracer.lock() = Some(tracer);
    s.emit(DebugEvent::Capabilities);
}

fn tracer(s: &Session) -> Option<Arc<dyn StreamTracer>> {
    s.stream_tracer.lock().clone().filter(|_| s.adapter == ADAPTER)
}

pub(crate) fn available(s: &Session) -> bool {
    tracer(s).is_some()
}

pub(crate) async fn run(
    mgr: &DebugManager,
    s: &Session,
    thread_id: i64,
    plan: &Value,
    cancel: &CancellationToken,
    progress: &(impl Fn(TraceProgress) + Send + Sync),
) -> TraceRun {
    let unavailable = |reason| TraceRun::Unavailable { reason };
    let Some(tracer) = tracer(s) else { return unavailable(TraceUnavailable::NoBackend) };
    let target = vm_target(s);
    let _claim = {
        let mut slot = s.stream_trace.lock();
        if slot.is_some() {
            return unavailable(TraceUnavailable::Busy);
        }
        *slot = Some(ActiveTrace {
            tracer: tracer.clone(),
            target: target.clone(),
            id: None,
            aborting: false,
            thread_id,
            running: false,
            resumed_stops: 0,
        });
        Claim(s)
    };
    if !s.suspended.get() {
        return unavailable(TraceUnavailable::NotSuspended);
    }
    let mut trace =
        Trace { mgr, s, tracer: &*tracer, target: &target, thread_id, progress, id: None, last: Counts::default() };
    match trace.drive(plan, cancel).await {
        Ok(run) => run,
        Err(run) => {
            // A stop from now on is the user's to see.
            set_running(s, false);
            trace.release().await;
            run
        }
    }
}

/// `None` when no trace runs or it is still arming. The trace itself goes on to report how the
/// abort ended it.
pub(crate) async fn abort(s: &Session) -> IdeResult<Option<AbortState>> {
    let (tracer, target, id) = {
        let mut slot = s.stream_trace.lock();
        let Some(active) = slot.as_mut() else { return Ok(None) };
        let Some(id) = active.id else { return Ok(None) };
        active.aborting = true;
        (active.tracer.clone(), active.target.clone(), id)
    };
    let result = tokio::select! {
        biased;
        () = s.ended.cancelled() => return Ok(None),
        result = tracer.abort(&target, id) => result,
    };
    match result {
        Ok(state) => Ok(Some(state)),
        Err(InspectError::NoTrace) => Ok(None),
        Err(e) => Err(IdeError::internal(format!("cannot abort the stream trace: {e}"))),
    }
}

#[derive(Default)]
struct Counts {
    records: u64,
    dropped: u64,
    elapsed_ms: u64,
}

struct Trace<'a, P> {
    mgr: &'a DebugManager,
    s: &'a Session,
    tracer: &'a dyn StreamTracer,
    /// The stop the trace was armed in.
    target: &'a VmTarget,
    thread_id: i64,
    progress: &'a P,
    /// Set once `arm` answers.
    id: Option<TraceId>,
    last: Counts,
}

impl<P: Fn(TraceProgress) + Send + Sync> Trace<'_, P> {
    /// `Err` ends the trace early.
    async fn drive(&mut self, plan: &Value, cancel: &CancellationToken) -> Result<TraceRun, TraceRun> {
        let (s, tracer, target) = (self.s, self.tracer, self.target);
        self.report(TracePhase::Arming);
        let id = self
            .until_ended(tracer.arm(target, self.thread_id, plan, BUDGET))
            .await?
            .map_err(|e| if s.ended.is_cancelled() { ended() } else { refused(e) })?;
        self.id = Some(id);
        if let Some(active) = s.stream_trace.lock().as_mut() {
            active.id = Some(id);
        }
        // Before the request: the thread can stop again before its reply arrives.
        set_running(s, true);
        self.dap(self.mgr.resume(s.id, self.thread_id)).await?;
        let mut stopped = false;
        loop {
            if cancel.is_cancelled() && !stopped {
                stopped = true;
                // Refused when the trace parked or failed just before: `wait` reports that.
                match self.until_ended(tracer.stop(target, id)).await? {
                    Ok(records) => {
                        self.last.records = records;
                        self.report(TracePhase::RecordingStopped);
                    }
                    Err(e) => tracing::debug!(session = s.id.0, trace = id, "stream trace stop: {e}"),
                }
            }
            match self.inspect(tracer.wait(target, id, WAIT_MS)).await? {
                TraceState::Running { records, dropped, elapsed_ms } => {
                    self.last = Counts { records, dropped, elapsed_ms };
                    let aborting = s.stream_trace.lock().as_ref().is_some_and(|a| a.aborting);
                    self.report(if aborting {
                        TracePhase::Aborting
                    } else if stopped {
                        TracePhase::RecordingStopped
                    } else {
                        TracePhase::Running
                    });
                }
                TraceState::Parked { records, dropped } => {
                    set_running(s, false);
                    self.last.records = records;
                    self.last.dropped = dropped;
                    break;
                }
                TraceState::Failed { detail } => return Err(TraceRun::Failed { detail }),
                TraceState::Cancelled { detail } => return Err(TraceRun::Cancelled { detail }),
            }
        }
        self.report(TracePhase::Collecting);
        let before = s.suspended.ticket();
        self.dap(self.mgr.step(s.id, self.thread_id, StepKind::Out)).await?;
        // Another thread's stop meanwhile is not this one: the traced thread would still be
        // inside the terminal operation.
        let stop = async {
            loop {
                if let Some(ticket) = s.suspended.stopped_since(self.thread_id, before) {
                    return ticket;
                }
                tokio::time::sleep(STOP_POLL).await;
            }
        };
        let Ok(generation) = self.until_ended(tokio::time::timeout(STOP_WAIT, stop)).await? else {
            // Collecting in the old stop would only be refused as stale.
            return Err(TraceRun::Failed { detail: step_out_timeout() });
        };
        let stopped_in = VmTarget { generation, ..vm_target(s) };
        let collected = self.inspect(tracer.collect(&stopped_in, id, self.last.records)).await?;
        let resumed_stops = s.stream_trace.lock().as_ref().map_or(0, |a| a.resumed_stops);
        Ok(TraceRun::Done { collected, generation, resumed_stops })
    }

    /// After a trace that ended early. Left to the bundle, an armed trace would keep every
    /// breakpoint off and a parked one its thread suspended behind java-debug's back; the bundle
    /// undoes either, or does so once a terminal still running returns. Not after a finished
    /// trace: the records it unpins are the values the result shows.
    async fn release(&self) {
        let Some(id) = self.id else { return };
        if self.s.ended.is_cancelled() {
            return;
        }
        if let Ok(Err(e)) = self.until_ended(self.tracer.release(self.target, id)).await {
            tracing::debug!(session = self.s.id.0, trace = id, "stream trace release: {e}");
        }
    }

    fn report(&self, phase: TracePhase) {
        let Counts { records, dropped, elapsed_ms } = self.last;
        (self.progress)(TraceProgress { phase, records, dropped, elapsed_ms });
    }

    /// A reply may never come once the session ends.
    async fn until_ended<T>(&self, work: impl Future<Output = T>) -> Result<T, TraceRun> {
        tokio::select! {
            biased;
            () = self.s.ended.cancelled() => Err(ended()),
            value = work => Ok(value),
        }
    }

    async fn inspect<T>(&self, work: InspectFuture<'_, T>) -> Result<T, TraceRun> {
        self.until_ended(work).await?.map_err(|e| self.failed(e.to_string()))
    }

    async fn dap(&self, work: impl Future<Output = IdeResult<()>>) -> Result<(), TraceRun> {
        self.until_ended(work).await?.map_err(|e| self.failed(e.message))
    }

    /// A request that failed because the session was ending says so.
    fn failed(&self, detail: String) -> TraceRun {
        if self.s.ended.is_cancelled() { ended() } else { TraceRun::Failed { detail } }
    }
}

fn step_out_timeout() -> String {
    format!(
        "java-debug reported no stop within {} s of stepping out of the stream's terminal operation",
        STOP_WAIT.as_secs()
    )
}

fn ended() -> TraceRun {
    TraceRun::Failed { detail: "the debug session ended".into() }
}

fn refused(e: InspectError) -> TraceRun {
    use TraceUnavailable as U;
    let reason = match e {
        InspectError::NotSuspended => U::NotSuspended,
        InspectError::Busy => U::Busy,
        InspectError::NoSession => U::NoSession,
        InspectError::Unsupported(detail) => U::Unsupported { detail },
        InspectError::NotAtChainStart(detail) => U::NotAtChainStart { detail },
        other => return TraceRun::Failed { detail: other.to_string() },
    };
    TraceRun::Unavailable { reason }
}
