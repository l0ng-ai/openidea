use ide_core::event::DebugEvent;
use ide_core::{DebugSessionId, IdeEvent, SharedSink};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const WINDOW: Duration = Duration::from_millis(50);
const MAX_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct Pending {
    sessions: HashMap<DebugSessionId, (String, String)>,
    scheduled: bool,
}

fn flush(pending: &mut Pending, sink: &SharedSink, session: DebugSessionId) {
    if let Some((category, output)) = pending.sessions.remove(&session) {
        sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category, output } });
    }
}

/// All debug output sources (including build output and child sessions) share this
/// bounded batch before reaching desktop or remote IPC. Control events flush
/// their session first, so a stop or exit cannot overtake preceding output.
pub(super) fn coalescing_sink(sink: SharedSink) -> (SharedSink, impl Fn()) {
    let pending = Arc::new(Mutex::new(Pending::default()));
    let flush_pending = {
        let pending = pending.clone();
        let sink = sink.clone();
        move || {
            let mut state = pending.lock();
            for (session, (category, output)) in state.sessions.drain() {
                sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category, output } });
            }
        }
    };
    let runtime = tokio::runtime::Handle::current();
    let output: SharedSink = Arc::new(move |event| {
        let mut state = pending.lock();
        match event {
            IdeEvent::Debug { session, event: DebugEvent::Output { category, output } } => {
                if output.is_empty() {
                    return;
                }
                if state.sessions.get(&session).is_some_and(|(c, _)| *c != category) {
                    flush(&mut state, &sink, session);
                }
                let mut rest = output.as_str();
                while !rest.is_empty() {
                    let (_, text) = state.sessions.entry(session).or_insert_with(|| (category.clone(), String::new()));
                    let mut end = rest.len().min(MAX_BYTES - text.len());
                    while !rest.is_char_boundary(end) {
                        end -= 1;
                    }
                    text.push_str(&rest[..end]);
                    rest = &rest[end..];
                    if text.len() == MAX_BYTES || !rest.is_empty() {
                        flush(&mut state, &sink, session);
                    }
                }
                if !state.scheduled && !state.sessions.is_empty() {
                    state.scheduled = true;
                    let pending = pending.clone();
                    let sink = sink.clone();
                    runtime.spawn(async move {
                        tokio::time::sleep(WINDOW).await;
                        let mut state = pending.lock();
                        for (session, (category, output)) in state.sessions.drain() {
                            sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category, output } });
                        }
                        state.scheduled = false;
                    });
                }
            }
            IdeEvent::Debug { session, event } => {
                flush(&mut state, &sink, session);
                sink.emit(IdeEvent::Debug { session, event });
            }
            event => sink.emit(event),
        }
    });
    (output, flush_pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (SharedSink, Arc<Mutex<Vec<IdeEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let saved = events.clone();
        (coalescing_sink(Arc::new(move |event| saved.lock().push(event))).0, events)
    }

    fn output(sink: &SharedSink, session: u32, category: &str, output: &str) {
        sink.emit(IdeEvent::Debug {
            session: DebugSessionId(session),
            event: DebugEvent::Output { category: category.into(), output: output.into() },
        });
    }

    #[tokio::test(start_paused = true)]
    async fn explicit_start_completion_flush_does_not_duplicate_output() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let saved = events.clone();
        let (sink, flush) = coalescing_sink(Arc::new(move |event| saved.lock().push(event)));
        output(&sink, 1, "console", "build failed\n");
        flush();
        assert_eq!(events.lock().len(), 1);
        tokio::task::yield_now().await;
        tokio::time::advance(WINDOW).await;
        tokio::task::yield_now().await;
        assert_eq!(events.lock().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn batches_per_session_and_flushes_idle_output() {
        let (sink, events) = setup();
        for _ in 0..500 {
            output(&sink, 1, "stdout", "line\n");
        }
        output(&sink, 2, "stdout", "other\n");
        assert!(events.lock().is_empty());
        tokio::task::yield_now().await;
        tokio::time::advance(WINDOW).await;
        tokio::task::yield_now().await;
        let events = events.lock();
        assert_eq!(events.len(), 2);
        assert!(events.iter().any(|event| matches!(event,
            IdeEvent::Debug { session: DebugSessionId(1), event: DebugEvent::Output { output, .. } }
            if output == &"line\n".repeat(500))));
    }

    #[tokio::test]
    async fn categories_and_control_events_keep_order() {
        let (sink, events) = setup();
        output(&sink, 1, "stdout", "out");
        output(&sink, 1, "stderr", "err");
        sink.emit(IdeEvent::Debug { session: DebugSessionId(1), event: DebugEvent::Terminated });
        let events = events.lock();
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[0], IdeEvent::Debug { event: DebugEvent::Output { category, output }, .. }
            if category == "stdout" && output == "out"));
        assert!(matches!(&events[1], IdeEvent::Debug { event: DebugEvent::Output { category, output }, .. }
            if category == "stderr" && output == "err"));
        assert!(matches!(&events[2], IdeEvent::Debug { event: DebugEvent::Terminated, .. }));
    }

    #[tokio::test(start_paused = true)]
    async fn terminating_one_session_preserves_other_pending_output() {
        let (sink, events) = setup();
        output(&sink, 1, "stdout", "first");
        output(&sink, 2, "stdout", "second");
        sink.emit(IdeEvent::Debug { session: DebugSessionId(1), event: DebugEvent::Terminated });
        assert_eq!(events.lock().len(), 2);
        tokio::task::yield_now().await;
        tokio::time::advance(WINDOW).await;
        tokio::task::yield_now().await;
        let events = events.lock();
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[2],
            IdeEvent::Debug { session: DebugSessionId(2), event: DebugEvent::Output { output, .. } }
            if output == "second"));
    }

    #[tokio::test]
    async fn large_unicode_events_are_bounded_without_loss() {
        let (sink, events) = setup();
        let text = "日志\n".repeat(100_000);
        output(&sink, 1, "stdout", &text);
        sink.emit(IdeEvent::Debug { session: DebugSessionId(1), event: DebugEvent::Terminated });
        let mut combined = String::new();
        for event in events.lock().iter() {
            if let IdeEvent::Debug { event: DebugEvent::Output { output, .. }, .. } = event {
                assert!(output.len() <= MAX_BYTES);
                combined.push_str(output);
            }
        }
        assert_eq!(combined, text);
    }
}
