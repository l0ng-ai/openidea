//! Java Stream Debugger: stream chains at a stop and real-run traces (`ide_host::ops::stream_trace`).

use crate::state::AppState;
use ide_core::{DebugSessionId, IdeResult, Range, RequestId};
use ide_dap::StackFrame;
use ide_host::ops::stream_trace::{AbortState, StreamChainInfo, StreamTraceResult, TraceProgress};
use tauri::ipc::Channel;
use tauri::{State, Window};

/// The stream chains around `frame`'s line; `top`: it is the thread's top frame.
#[tauri::command]
#[specta::specta]
pub async fn debug_stream_chains(
    window: Window,
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame: StackFrame,
    top: bool,
) -> IdeResult<Vec<StreamChainInfo>> {
    ide_host::ops::stream_trace::debug_stream_chains(&state.host, window.label(), session, frame, top).await
}

/// Traces chain `chain_index` of [`debug_stream_chains`], whose `range` the UI showed, while the
/// program runs it; cancelling `request` stops recording.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn debug_stream_trace(
    window: Window,
    state: State<'_, AppState>,
    session: DebugSessionId,
    request: RequestId,
    thread_id: i64,
    frame: StackFrame,
    chain_index: u32,
    range: Range,
    on_progress: Channel<TraceProgress>,
) -> IdeResult<StreamTraceResult> {
    ide_host::ops::stream_trace::debug_stream_trace(
        &state.host,
        window.label(),
        session,
        request,
        thread_id,
        frame,
        chain_index,
        range,
        crate::commands::sender(on_progress),
    )
    .await
}

/// Ends the running trace's terminal operation; `None` when no trace runs.
#[tauri::command]
#[specta::specta]
pub async fn debug_stream_trace_abort(
    window: Window,
    state: State<'_, AppState>,
    session: DebugSessionId,
) -> IdeResult<Option<AbortState>> {
    ide_host::ops::stream_trace::debug_stream_trace_abort(&state.host, window.label(), session).await
}
