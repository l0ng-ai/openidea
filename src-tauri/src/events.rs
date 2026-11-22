use ide_core::{EventSink, IdeEvent, SharedSink};
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

/// Name of the single backend → UI event. Payload: [`IdeEvent`].
pub const IDE_EVENT: &str = "ide://event";

/// The other windows showing the documents of `source`'s project: its project window and the
/// auxiliary windows with documents. An edit made in one is not echoed by the backend, so they
/// get it as a patch ([`emit_document_edit`]).
pub fn document_edit_peers(app: &AppHandle, source: &str) -> Vec<String> {
    let owner = crate::state::AppState::owner_window(source);
    let mut peers = crate::windows::document_windows(app, owner);
    peers.push(owner.to_owned());
    peers.retain(|label| label != source);
    peers
}

pub fn emit_document_edit(
    app: &AppHandle,
    peers: Vec<String>,
    doc: ide_core::DocId,
    base_version: u32,
    version: u32,
    changes: Vec<ide_core::TextChange>,
) {
    let event = IdeEvent::DocPatched { doc, base_version, version, changes, workspace_edit: false };
    for label in peers {
        if let Err(e) = app.emit_to(label, IDE_EVENT, &event) {
            tracing::warn!("failed to mirror document edit: {e}");
        }
    }
}

/// Forwards events to one window (`Some(label)`, plus its auxiliary windows that show its
/// project's documents) or to all windows.
pub struct TauriSink {
    pub app: AppHandle,
    pub window: Option<String>,
}

const COALESCE_WINDOW: Duration = Duration::from_millis(16);
const MAX_PENDING_DIAGNOSTICS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct DiagnosticKey {
    path: ide_core::IpcPath,
    source: String,
}

#[derive(Default)]
struct PendingDiagnostics {
    order: VecDeque<DiagnosticKey>,
    events: HashMap<DiagnosticKey, IdeEvent>,
    scheduled: bool,
}

fn diagnostic_key(event: &IdeEvent) -> Option<DiagnosticKey> {
    let IdeEvent::Diagnostics { path, source, .. } = event else {
        return None;
    };
    Some(DiagnosticKey { path: path.clone(), source: source.clone() })
}

fn take_pending(state: &mut PendingDiagnostics) -> Vec<IdeEvent> {
    let mut events = Vec::with_capacity(state.events.len());
    for key in state.order.drain(..) {
        if let Some(event) = state.events.remove(&key) {
            events.push(event);
        }
    }
    events
}

/// Collapses repeated full-replacement diagnostics for one `(path, source)` into the
/// latest event in a frame-sized window. Any other event flushes the pending
/// diagnostics first so lifecycle and ordered events cannot overtake them.
pub fn coalescing_sink(sink: SharedSink, runtime: tokio::runtime::Handle) -> SharedSink {
    let pending = Arc::new(Mutex::new(PendingDiagnostics::default()));
    let dispatch = Arc::new(Mutex::new(()));
    Arc::new(move |event| {
        let Some(key) = diagnostic_key(&event) else {
            let _dispatch = dispatch.lock();
            let events = take_pending(&mut pending.lock());
            for pending_event in events {
                sink.emit(pending_event);
            }
            sink.emit(event);
            return;
        };

        loop {
            let schedule = {
                let mut state = pending.lock();
                if !state.events.contains_key(&key) && state.events.len() >= MAX_PENDING_DIAGNOSTICS {
                    None
                } else {
                    if !state.events.contains_key(&key) {
                        state.order.push_back(key.clone());
                    }
                    state.events.insert(key.clone(), event.clone());
                    if state.scheduled {
                        return;
                    }
                    state.scheduled = true;
                    Some(())
                }
            };

            if schedule.is_none() {
                let _dispatch = dispatch.lock();
                let events = take_pending(&mut pending.lock());
                for pending_event in events {
                    sink.emit(pending_event);
                }
                continue;
            }

            let pending = pending.clone();
            let dispatch = dispatch.clone();
            let sink = sink.clone();
            runtime.spawn(async move {
                tokio::time::sleep(COALESCE_WINDOW).await;
                let _dispatch = dispatch.lock();
                let events = {
                    let mut state = pending.lock();
                    state.scheduled = false;
                    take_pending(&mut state)
                };
                for event in events {
                    sink.emit(event);
                }
            });
            return;
        }
    })
}

/// A debug session stopped on a breakpoint: bounce/flash the taskbar icon
/// (IDEA) unless the user is already looking at an OpenIDEA window. The focus
/// check and the request both touch the windowing system, so they run on the
/// main thread; `emit` itself can come from any debug worker thread.
fn flash_taskbar_unless_focused(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if crate::application_focus::application_active(&handle) {
            return;
        }
        for window in handle.webview_windows().values() {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    });
}

impl EventSink for TauriSink {
    fn emit(&self, event: IdeEvent) {
        if matches!(
            &event,
            IdeEvent::Debug { event: ide_core::event::DebugEvent::Stopped { reason, .. }, .. }
            if matches!(reason.as_str(), "breakpoint" | "function breakpoint")
        ) {
            flash_taskbar_unless_focused(&self.app);
        }
        // A confirmation waits for the user: bring the window up. Other requests (an agent's
        // run, opening a file) need nothing from the user and leave the focus where it is.
        if matches!(&event, IdeEvent::McpRequest { request: ide_core::event::McpUiRequest::Confirm { .. }, .. })
            && let Some(label) = self.window.clone()
        {
            let app = self.app.clone();
            let _ = self.app.run_on_main_thread(move || {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
        }
        let result = match &self.window {
            Some(label) => {
                for target in crate::windows::document_windows(&self.app, label)
                    .into_iter()
                    .filter(|_| !matches!(&event, IdeEvent::McpRequest { .. } | IdeEvent::McpRequestClosed { .. }))
                {
                    let _ = self.app.emit_to(target.as_str(), IDE_EVENT, &event);
                }
                self.app.emit_to(label.as_str(), IDE_EVENT, &event)
            }
            None => self.app.emit(IDE_EVENT, &event),
        };
        if let Err(e) = result {
            tracing::warn!("failed to emit ide event: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Diagnostic, IpcPath, Pos, Range, Severity, TaskId};
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use std::time::Instant;

    fn setup() -> (ide_core::SharedSink, Arc<Mutex<Vec<IdeEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let saved = events.clone();
        (coalescing_sink(Arc::new(move |event| saved.lock().push(event)), tokio::runtime::Handle::current()), events)
    }

    fn diagnostics(path: &str, source: &str, message: &str) -> IdeEvent {
        IdeEvent::Diagnostics {
            path: IpcPath::from(path),
            source: source.into(),
            items: vec![Diagnostic {
                range: Range::point(Pos::new(0, 0)),
                severity: Severity::Error,
                message: message.into(),
                source: None,
                code: None,
                unnecessary: false,
                deprecated: false,
                server: None,
            }],
        }
    }

    fn task(message: &str, done: bool) -> IdeEvent {
        IdeEvent::Task {
            id: TaskId(1),
            title: "Indexing".into(),
            message: Some(message.into()),
            fraction: Some(if done { 1.0 } else { 0.5 }),
            done,
            cancellable: !done,
        }
    }

    #[tokio::test]
    async fn coalesces_diagnostics_by_path_and_source() {
        let (sink, events) = setup();
        for index in 0..100 {
            sink.emit(diagnostics("/p/a.rs", "rust-analyzer", &format!("old {index}")));
        }
        sink.emit(diagnostics("/p/a.rs", "eslint", "lint"));
        sink.emit(diagnostics("/p/b.rs", "rust-analyzer", "other"));

        assert!(events.lock().is_empty());
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        tokio::task::yield_now().await;

        {
            let saved_events = events.lock();
            assert_eq!(saved_events.len(), 3);
            assert!(matches!(
                &saved_events[0],
                IdeEvent::Diagnostics { path, source, items }
                    if path == &IpcPath::from("/p/a.rs")
                        && source == "rust-analyzer"
                        && items[0].message == "old 99"
            ));
            assert!(matches!(
                &saved_events[1],
                IdeEvent::Diagnostics { path, source, .. }
                    if path == &IpcPath::from("/p/a.rs") && source == "eslint"
            ));
            assert!(matches!(
                &saved_events[2],
                IdeEvent::Diagnostics { path, source, .. }
                    if path == &IpcPath::from("/p/b.rs") && source == "rust-analyzer"
            ));
        }

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(events.lock().len(), 3);
    }

    #[tokio::test]
    async fn immediate_events_flush_pending_events_first() {
        let (sink, events) = setup();
        sink.emit(diagnostics("/p/a.rs", "rust-analyzer", "before"));
        sink.emit(diagnostics("/p/b.rs", "rust-analyzer", "other"));
        sink.emit(IdeEvent::SettingsChanged { key: "editor.fontSize".into() });

        let events = events.lock();
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[0], IdeEvent::Diagnostics { .. }));
        assert!(matches!(&events[1], IdeEvent::Diagnostics { .. }));
        assert!(matches!(&events[2], IdeEvent::SettingsChanged { .. }));
    }

    #[tokio::test]
    async fn lifecycle_events_remain_immediate() {
        let (sink, events) = setup();
        sink.emit(task("complete", true));
        let events = events.lock();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            IdeEvent::Task { message, done, .. }
                if message.as_deref() == Some("complete") && *done
        ));
    }

    #[tokio::test]
    async fn diagnostic_buffer_cap_flushes_without_dropping() {
        let (sink, events) = setup();
        for index in 0..=MAX_PENDING_DIAGNOSTICS {
            sink.emit(diagnostics(&format!("/p/{index}.rs"), "rust-analyzer", "diagnostic"));
        }
        assert_eq!(events.lock().len(), MAX_PENDING_DIAGNOSTICS);

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(events.lock().len(), MAX_PENDING_DIAGNOSTICS + 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "run for before/after diagnostics transport measurements"]
    async fn diagnostics_coalescing_benchmark() {
        const FILES: usize = 2_000;
        const ROUNDS: usize = 10;
        let burst: Vec<IdeEvent> = (0..ROUNDS)
            .flat_map(|round| {
                (0..FILES).map(move |file| {
                    diagnostics(&format!("/workspace/src/File{file}.rs"), "rust-analyzer", &format!("round-{round}"))
                })
            })
            .collect();

        let raw_events = Arc::new(AtomicUsize::new(0));
        let raw_count = raw_events.clone();
        let raw: SharedSink = Arc::new(move |event| {
            let encoded = serde_json::to_vec(&event).unwrap();
            raw_count.fetch_add(1, Ordering::Relaxed);
            std::hint::black_box(encoded.len());
        });
        let raw_started = Instant::now();
        for event in &burst {
            raw.emit(event.clone());
        }
        let raw_elapsed = raw_started.elapsed();
        assert_eq!(raw_events.load(Ordering::Relaxed), FILES * ROUNDS);

        let coalesced_events = Arc::new(AtomicUsize::new(0));
        let delivered_state = Arc::new(Mutex::new(HashMap::<IpcPath, String>::new()));
        let coalesced_count = coalesced_events.clone();
        let delivered = delivered_state.clone();
        let target: SharedSink = Arc::new(move |event| {
            let encoded = serde_json::to_vec(&event).unwrap();
            coalesced_count.fetch_add(1, Ordering::Relaxed);
            if let IdeEvent::Diagnostics { path, items, .. } = event {
                delivered.lock().insert(path, items[0].message.clone());
            }
            std::hint::black_box(encoded.len());
        });
        let coalesced = coalescing_sink(target, tokio::runtime::Handle::current());
        let coalesced_started = Instant::now();
        for event in &burst {
            coalesced.emit(event.clone());
        }

        let expected_last_round = format!("round-{}", ROUNDS - 1);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let complete = {
                let delivered_state = delivered_state.lock();
                delivered_state.len() == FILES
                    && delivered_state.values().all(|message| message == &expected_last_round)
            };
            if complete {
                break;
            }
            assert!(Instant::now() < deadline, "diagnostics did not settle before benchmark timeout");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let coalesced_elapsed = coalesced_started.elapsed();

        let coalesced_count = coalesced_events.load(Ordering::Relaxed);
        assert!(coalesced_count >= FILES);
        assert!(coalesced_count < FILES * ROUNDS);
        let delivered_state = delivered_state.lock();
        assert_eq!(delivered_state.len(), FILES);
        assert!(delivered_state.values().all(|message| message == &expected_last_round));
        println!(
            "diagnostics transport burst: raw_events={} raw_ms={:.2} coalesced_events={} \
             coalesced_total_ms={:.2} reduction_pct={:.1}",
            FILES * ROUNDS,
            raw_elapsed.as_secs_f64() * 1_000.0,
            coalesced_count,
            coalesced_elapsed.as_secs_f64() * 1_000.0,
            (1.0 - coalesced_count as f64 / (FILES * ROUNDS) as f64) * 100.0,
        );
    }
}
