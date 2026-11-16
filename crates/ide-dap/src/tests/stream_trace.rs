//! A stream chain traced while the program runs it, through a session's stream tracer.

use super::*;
use ide_core::CancellationToken;
use ide_jvm_inspect::{
    AbortState, CollectedTerminal, InspectError, InspectFuture, JvmValue, StreamTracer, TraceCollected, TraceId,
    TraceState, VmTarget,
};
use std::collections::VecDeque;
use tokio::sync::Notify;

const TRACE: TraceId = 7;

#[derive(Default)]
struct FakeTracer {
    /// Answers to `wait`, in order. Once they run out, `wait` signals `waiting` and answers only
    /// after more are pushed and `more` is notified.
    waits: Mutex<VecDeque<Result<TraceState, InspectError>>>,
    arm_error: Mutex<Option<InspectError>>,
    stop_error: Mutex<Option<InspectError>>,
    collect_error: Mutex<Option<InspectError>>,
    /// The record count each `collect` was given.
    collect_records: Mutex<Vec<u64>>,
    calls: Mutex<Vec<(&'static str, VmTarget)>>,
    waiting: Notify,
    more: Notify,
}

impl FakeTracer {
    fn scripted(waits: impl IntoIterator<Item = TraceState>) -> Arc<Self> {
        Self::answering(waits.into_iter().map(Ok))
    }

    fn answering(waits: impl IntoIterator<Item = Result<TraceState, InspectError>>) -> Arc<Self> {
        Arc::new(Self { waits: Mutex::new(waits.into_iter().collect()), ..Self::default() })
    }

    fn record(&self, name: &'static str, target: &VmTarget) {
        self.calls.lock().push((name, target.clone()));
    }

    fn names(&self) -> Vec<&'static str> {
        self.calls.lock().iter().map(|(name, _)| *name).collect()
    }

    fn target_of(&self, name: &str) -> VmTarget {
        self.calls.lock().iter().find(|(n, _)| *n == name).map(|(_, t)| t.clone()).unwrap()
    }
}

impl StreamTracer for FakeTracer {
    fn arm<'a>(
        &'a self,
        target: &'a VmTarget,
        _thread_id: i64,
        _plan: &'a Value,
        _budget: u32,
    ) -> InspectFuture<'a, TraceId> {
        self.record("arm", target);
        let error = self.arm_error.lock().clone();
        Box::pin(async move { error.map_or(Ok(TRACE), Err) })
    }

    fn wait<'a>(&'a self, target: &'a VmTarget, _trace: TraceId, _ms: u32) -> InspectFuture<'a, TraceState> {
        self.record("wait", target);
        Box::pin(async move {
            loop {
                if let Some(state) = self.waits.lock().pop_front() {
                    return state;
                }
                self.waiting.notify_one();
                self.more.notified().await;
            }
        })
    }

    fn stop<'a>(&'a self, target: &'a VmTarget, _trace: TraceId) -> InspectFuture<'a, u64> {
        self.record("stop", target);
        let error = self.stop_error.lock().clone();
        Box::pin(async move { error.map_or(Ok(3), Err) })
    }

    fn abort<'a>(&'a self, target: &'a VmTarget, _trace: TraceId) -> InspectFuture<'a, AbortState> {
        self.record("abort", target);
        Box::pin(async { Ok(AbortState::Interrupted) })
    }

    fn collect<'a>(&'a self, target: &'a VmTarget, _trace: TraceId, records: u64) -> InspectFuture<'a, TraceCollected> {
        self.record("collect", target);
        self.collect_records.lock().push(records);
        let error = self.collect_error.lock().clone();
        Box::pin(async move { error.map_or_else(|| Ok(collected()), Err) })
    }

    fn release<'a>(&'a self, target: &'a VmTarget, _trace: TraceId) -> InspectFuture<'a, ()> {
        self.record("release", target);
        Box::pin(async { Ok(()) })
    }
}

fn collected() -> TraceCollected {
    TraceCollected {
        records: vec![(0, JvmValue::Primitive { type_name: "int".into(), text: "1".into() })],
        dropped: 0,
        terminal: CollectedTerminal::Void,
        skipped_breakpoints: 0,
        sequentialized: false,
    }
}

fn running(records: u64) -> TraceState {
    TraceState::Running { records, dropped: 0, elapsed_ms: 5 }
}

fn parked() -> TraceState {
    TraceState::Parked { records: 10, dropped: 0 }
}

/// java-debug keeps the program running after `continue` and stops right after a `stepOut`.
fn java_debug() -> Script {
    Script { continue_reply: Some(json!({"allThreadsContinued": true})), step_out_stops: &[1], ..Script::default() }
}

async fn stopped_java(h: &Harness, tracer: &Arc<FakeTracer>) -> DebugSessionId {
    let id = h.start(java_config("launch")).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    h.manager.set_stream_tracer(id, tracer.clone()).unwrap();
    id
}

async fn trace(h: &Harness, id: DebugSessionId) -> IdeResult<TraceRun> {
    let run = h.manager.stream_trace(id, 1, json!({"steps": []}), CancellationToken::new(), |_| {});
    tokio::time::timeout(Duration::from_secs(10), run).await.expect("the trace did not end")
}

/// A trace in its own task, returned once it waits for the answers its tracer has not got.
async fn hanging_trace(
    h: &Harness,
    id: DebugSessionId,
    tracer: &FakeTracer,
) -> tokio::task::JoinHandle<IdeResult<TraceRun>> {
    hanging_trace_with(h, id, tracer, |_| {}).await
}

async fn hanging_trace_with(
    h: &Harness,
    id: DebugSessionId,
    tracer: &FakeTracer,
    progress: impl Fn(TraceProgress) + Send + Sync + 'static,
) -> tokio::task::JoinHandle<IdeResult<TraceRun>> {
    let manager = h.manager.clone();
    let task = tokio::spawn(async move {
        manager.stream_trace(id, 1, json!({"steps": []}), CancellationToken::new(), progress).await
    });
    tokio::time::timeout(Duration::from_secs(5), tracer.waiting.notified()).await.expect("the trace did not wait");
    task
}

fn phases(seen: &Mutex<Vec<TraceProgress>>) -> Vec<TracePhase> {
    seen.lock().iter().map(|p| p.phase).collect()
}

fn progress(phase: TracePhase, records: u64, elapsed_ms: u64) -> TraceProgress {
    TraceProgress { phase, records, dropped: 0, elapsed_ms }
}

#[tokio::test]
async fn trace_runs_continue_then_step_out() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([running(10), parked()]);
    let id = stopped_java(&h, &tracer).await;
    let start = h.manager.session(id).unwrap().suspended.ticket();

    let run = trace(&h, id).await.unwrap();

    let TraceRun::Done { collected: got, generation, resumed_stops } = run else { panic!("not done: {run:?}") };
    assert_eq!(got, collected());
    assert_eq!(resumed_stops, 0);
    assert!(generation > start, "collected in the stop of the trace ({start}), not after it ({generation})");
    let commands = h.commands();
    let resumed = commands.iter().position(|c| c == "continue").expect("no continue");
    let stepped = commands.iter().position(|c| c == "stepOut").expect("no stepOut");
    assert!(resumed < stepped, "{commands:?}");
    assert_eq!(h.request("continue")["arguments"]["threadId"], 1);
    assert_eq!(h.request("stepOut")["arguments"]["threadId"], 1);
    assert_eq!(tracer.names(), ["arm", "wait", "wait", "collect"]);
    assert_eq!(*tracer.collect_records.lock(), [10], "collect is told how many records the trace parked with");
    assert_eq!(tracer.target_of("arm").generation, start);
    assert_eq!(tracer.target_of("collect").generation, generation);
    assert!(h.manager.session(id).unwrap().suspended.get());
}

#[tokio::test]
async fn trace_reports_progress() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([running(10), parked()]);
    let id = stopped_java(&h, &tracer).await;
    let seen: Arc<Mutex<Vec<TraceProgress>>> = Arc::default();
    let sink = seen.clone();

    let run = h.manager.stream_trace(id, 1, json!({}), CancellationToken::new(), move |p| sink.lock().push(p)).await;

    assert!(matches!(run, Ok(TraceRun::Done { .. })), "{run:?}");
    assert_eq!(
        *seen.lock(),
        [
            progress(TracePhase::Arming, 0, 0),
            progress(TracePhase::Running, 10, 5),
            progress(TracePhase::Collecting, 10, 5),
        ]
    );
}

#[tokio::test]
async fn cancel_stops_recording_once() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([running(10), running(12), parked()]);
    let id = stopped_java(&h, &tracer).await;
    let cancel = CancellationToken::new();
    let on_running = cancel.clone();
    let seen: Arc<Mutex<Vec<TracePhase>>> = Arc::default();
    let sink = seen.clone();

    let run = h
        .manager
        .stream_trace(id, 1, json!({}), cancel, move |p| {
            if p.phase == TracePhase::Running {
                on_running.cancel();
            }
            sink.lock().push(p.phase);
        })
        .await;

    assert!(matches!(run, Ok(TraceRun::Done { .. })), "{run:?}");
    assert_eq!(tracer.names(), ["arm", "wait", "stop", "wait", "wait", "collect"]);
    assert_eq!(
        *seen.lock(),
        [
            TracePhase::Arming,
            TracePhase::Running,
            TracePhase::RecordingStopped,
            TracePhase::RecordingStopped,
            TracePhase::Collecting
        ]
    );
}

#[tokio::test]
async fn second_trace_is_busy() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;
    let first = hanging_trace(&h, id, &tracer).await;

    let second = trace(&h, id).await.unwrap();

    assert_eq!(second, TraceRun::Unavailable { reason: TraceUnavailable::Busy });
    assert_eq!(tracer.names().iter().filter(|n| **n == "arm").count(), 1);
    first.abort();
}

#[tokio::test]
async fn trace_ends_when_session_ends() {
    // The fake adapter lets the program exit on `continue`.
    let h = harness(Script::default());
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;
    let session = h.manager.session(id).unwrap();

    let run = trace(&h, id).await.unwrap();

    assert_eq!(run, TraceRun::Failed { detail: "the debug session ended".into() });
    assert!(session.stream_trace.lock().is_none());
    let next = trace(&h, id).await;
    assert!(!matches!(next, Ok(TraceRun::Unavailable { reason: TraceUnavailable::Busy })), "{next:?}");
}

#[tokio::test]
async fn dropping_the_trace_frees_the_session() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;
    let first = hanging_trace(&h, id, &tracer).await;

    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());

    let session = h.manager.session(id).unwrap();
    assert!(session.stream_trace.lock().is_none());
    // The first trace resumed the thread.
    session.suspended.stopped(Some(1), false);
    let again = hanging_trace(&h, id, &tracer).await;
    assert_eq!(tracer.names().iter().filter(|n| **n == "arm").count(), 2);
    again.abort();
}

#[tokio::test]
async fn arm_errors_map_to_unavailable_or_failed() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;

    *tracer.arm_error.lock() = Some(InspectError::NotAtChainStart("the stop is on line 4".into()));
    assert_eq!(
        trace(&h, id).await.unwrap(),
        TraceRun::Unavailable { reason: TraceUnavailable::NotAtChainStart { detail: "the stop is on line 4".into() } }
    );
    *tracer.arm_error.lock() = Some(InspectError::TimedOut);
    assert_eq!(trace(&h, id).await.unwrap(), TraceRun::Failed { detail: InspectError::TimedOut.to_string() });
    assert!(!h.commands().iter().any(|c| c == "continue"));
}

#[tokio::test]
async fn abort_reaches_the_running_trace() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;
    assert_eq!(h.manager.stream_trace_abort(id).await.unwrap(), None);
    let seen: Arc<Mutex<Vec<TraceProgress>>> = Arc::default();
    let sink = seen.clone();
    let task = hanging_trace_with(&h, id, &tracer, move |p| sink.lock().push(p)).await;

    assert_eq!(h.manager.stream_trace_abort(id).await.unwrap(), Some(AbortState::Interrupted));
    assert_eq!(tracer.target_of("abort"), tracer.target_of("arm"));

    let thrown = "java.lang.RuntimeException: oi-cancel:1";
    tracer.waits.lock().extend([Ok(running(4)), Ok(TraceState::Failed { detail: thrown.into() })]);
    tracer.more.notify_one();
    let run = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();
    assert_eq!(run, TraceRun::Failed { detail: thrown.into() });
    assert_eq!(phases(&seen), [TracePhase::Arming, TracePhase::Aborting]);
    assert_eq!(tracer.names().last(), Some(&"release"));
}

#[tokio::test]
async fn failed_wait_passes_its_detail_through() {
    let h = harness(java_debug());
    let detail = "the program began to exit while the stream ran: stop the debug session";
    let tracer = FakeTracer::scripted([running(1), TraceState::Failed { detail: detail.into() }]);
    let id = stopped_java(&h, &tracer).await;

    assert_eq!(trace(&h, id).await.unwrap(), TraceRun::Failed { detail: detail.into() });
    assert_eq!(tracer.names(), ["arm", "wait", "wait", "release"]);
    assert!(!h.commands().iter().any(|c| c == "stepOut"));
}

#[tokio::test]
async fn a_trace_cancelled_before_its_terminal_says_so() {
    let detail = "cancelled before the terminal ran";
    let tracer = FakeTracer::scripted([TraceState::Cancelled { detail: detail.into() }]);
    let h = harness(java_debug());
    let id = stopped_java(&h, &tracer).await;

    assert_eq!(trace(&h, id).await.unwrap(), TraceRun::Cancelled { detail: detail.into() });
    assert!(!h.commands().iter().any(|c| c == "stepOut"));
}

#[tokio::test]
async fn a_wait_that_errs_releases_the_trace() {
    let h = harness(java_debug());
    let tracer = FakeTracer::answering([Ok(running(1)), Err(InspectError::TimedOut)]);
    let id = stopped_java(&h, &tracer).await;

    assert_eq!(trace(&h, id).await.unwrap(), TraceRun::Failed { detail: InspectError::TimedOut.to_string() });
    assert_eq!(tracer.names(), ["arm", "wait", "wait", "release"]);
    assert_eq!(tracer.target_of("release"), tracer.target_of("arm"));
}

#[tokio::test]
async fn a_refused_step_out_releases_the_trace() {
    let h = harness(Script { refuse_step_out: true, ..java_debug() });
    let tracer = FakeTracer::scripted([parked()]);
    let id = stopped_java(&h, &tracer).await;

    let run = trace(&h, id).await.unwrap();

    assert!(matches!(&run, TraceRun::Failed { detail } if detail.contains("not suspended")), "{run:?}");
    assert_eq!(tracer.names(), ["arm", "wait", "release"]);
}

#[tokio::test]
async fn a_refused_continue_releases_the_trace() {
    let h = harness(Script { refuse_continue: true, ..java_debug() });
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;

    let run = trace(&h, id).await.unwrap();

    assert!(matches!(&run, TraceRun::Failed { .. }), "{run:?}");
    assert_eq!(tracer.names(), ["arm", "release"]);
}

#[tokio::test]
async fn a_failed_collect_releases_the_trace() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([parked()]);
    *tracer.collect_error.lock() = Some(InspectError::Stale);
    let id = stopped_java(&h, &tracer).await;

    assert!(matches!(trace(&h, id).await.unwrap(), TraceRun::Failed { .. }));
    assert_eq!(tracer.names(), ["arm", "wait", "collect", "release"]);
}

fn stops(h: &Harness) -> usize {
    h.events.lock().iter().filter(|e| matches!(e, IdeEvent::Debug { event: DebugEvent::Stopped { .. }, .. })).count()
}

#[tokio::test]
async fn a_stop_of_the_traced_thread_while_the_chain_runs_is_resumed_unseen() {
    // A breakpoint java-debug set meanwhile, hit inside the terminal's invoke before the bundle
    // switched it off: held there, the invoke would never return.
    let h = harness(Script { breakpoints_after_continue: 1, ..java_debug() });
    let tracer = FakeTracer::scripted([]);
    let id = stopped_java(&h, &tracer).await;
    let shown = stops(&h);
    let task = hanging_trace(&h, id, &tracer).await;

    for _ in 0..200 {
        if h.commands().iter().filter(|c| *c == "continue").count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.commands().iter().filter(|c| *c == "continue").count(), 2, "{:?}", h.commands());
    assert_eq!(h.log.lock().iter().rfind(|m| m["command"] == "continue").unwrap()["arguments"]["threadId"], 1);
    tracer.waits.lock().push_back(Ok(parked()));
    tracer.more.notify_one();
    let run = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();

    let TraceRun::Done { resumed_stops, .. } = run else { panic!("not done: {run:?}") };
    assert_eq!(resumed_stops, 1);
    assert_eq!(stops(&h), shown + 1, "only the step-out stop is shown, after the trace parked");
}

#[tokio::test]
async fn a_finished_trace_is_not_released() {
    // Releasing unpins the records, which the result's values still show until the program runs on.
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([parked()]);
    let id = stopped_java(&h, &tracer).await;

    assert!(matches!(trace(&h, id).await.unwrap(), TraceRun::Done { .. }));
    assert!(!tracer.names().contains(&"release"), "{:?}", tracer.names());
}

#[tokio::test]
async fn refused_stop_leaves_the_outcome_to_wait() {
    let h = harness(java_debug());
    let tracer = FakeTracer::scripted([running(10), parked()]);
    *tracer.stop_error.lock() = Some(InspectError::NoTrace);
    let id = stopped_java(&h, &tracer).await;
    let cancel = CancellationToken::new();
    let on_running = cancel.clone();
    let seen: Arc<Mutex<Vec<TraceProgress>>> = Arc::default();
    let sink = seen.clone();

    let run = h
        .manager
        .stream_trace(id, 1, json!({}), cancel, move |p| {
            if p.phase == TracePhase::Running {
                on_running.cancel();
            }
            sink.lock().push(p);
        })
        .await;

    assert!(matches!(run, Ok(TraceRun::Done { .. })), "{run:?}");
    assert_eq!(tracer.names(), ["arm", "wait", "stop", "wait", "collect"]);
    assert_eq!(phases(&seen), [TracePhase::Arming, TracePhase::Running, TracePhase::Collecting]);
}

#[tokio::test]
async fn another_threads_stop_is_not_the_step_out() {
    // Thread 2 stops at a breakpoint 100 ms before the traced thread's step out ends.
    let h = harness(Script { step_out_stops: &[2, 1], ..java_debug() });
    let tracer = FakeTracer::scripted([parked()]);
    let id = stopped_java(&h, &tracer).await;
    let start = h.manager.session(id).unwrap().suspended.ticket();

    let run = trace(&h, id).await.unwrap();

    let TraceRun::Done { generation, .. } = run else { panic!("not done: {run:?}") };
    assert_eq!(
        generation,
        start + 2,
        "collected in thread 2's stop, not in the traced thread's step-out stop after it"
    );
    assert_eq!(tracer.target_of("collect").generation, generation);
}

#[tokio::test]
async fn step_out_without_a_stop_times_out() {
    let h = harness(Script { step_out_stops: &[], ..java_debug() });
    let tracer = FakeTracer::scripted([parked()]);
    let id = stopped_java(&h, &tracer).await;
    tokio::time::pause();

    let run = h.manager.stream_trace(id, 1, json!({}), CancellationToken::new(), |_| {}).await.unwrap();

    assert_eq!(
        run,
        TraceRun::Failed {
            detail: "java-debug reported no stop within 30 s of stepping out of the stream's terminal operation".into()
        }
    );
    assert!(h.commands().iter().any(|c| c == "stepOut"));
    assert_eq!(tracer.names(), ["arm", "wait", "release"]);
}

#[tokio::test]
async fn capability_only_for_java_debug() {
    let h = harness(Script::default());
    let tracer = FakeTracer::scripted([]);
    let java = h.start(java_config("launch")).await.unwrap();
    assert!(!h.manager.capabilities(java).unwrap().stream_trace);
    h.manager.set_stream_tracer(java, tracer.clone()).unwrap();
    assert!(h.manager.capabilities(java).unwrap().stream_trace);

    let other = h.start(config()).await.unwrap();
    h.manager.set_stream_tracer(other, tracer.clone()).unwrap();
    assert!(!h.manager.capabilities(other).unwrap().stream_trace);
}
