//! IPC commands of `ide_host::ops::debug` (the shared implementation).

use crate::state::AppState;
use ide_core::{DebugSessionId, IdeResult};
use ide_dap::*;
#[allow(unused_imports)]
pub use ide_host::ops::debug::*;
use std::path::PathBuf;
use tauri::{State, Window};

/// Starts a session owned by this window: its events (and those of child sessions) go here only.
#[tauri::command]
#[specta::specta]
pub async fn debug_start(
    window: Window,
    state: State<'_, AppState>,
    config: LaunchConfig,
) -> IdeResult<DebugSessionId> {
    ide_host::ops::debug::debug_start(&state.host, window.label(), config).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_set_breakpoints(
    state: State<'_, AppState>,
    path: PathBuf,
    breakpoints: Vec<Breakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    ide_host::ops::debug::debug_set_breakpoints(&state.host, "", path, breakpoints).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_threads(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<Vec<ThreadInfo>> {
    ide_host::ops::debug::debug_threads(&state.host, "", session).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_stack_trace(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<Vec<StackFrame>> {
    ide_host::ops::debug::debug_stack_trace(&state.host, "", session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_scopes(state: State<'_, AppState>, session: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Scope>> {
    ide_host::ops::debug::debug_scopes(&state.host, "", session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_variables(
    state: State<'_, AppState>,
    session: DebugSessionId,
    reference: i64,
) -> IdeResult<Vec<Variable>> {
    ide_host::ops::debug::debug_variables(&state.host, "", session, reference).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_evaluate(
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
) -> IdeResult<Variable> {
    ide_host::ops::debug::debug_evaluate(&state.host, "", session, frame_id, expression).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_resume(state: State<'_, AppState>, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    ide_host::ops::debug::debug_resume(&state.host, "", session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_pause(state: State<'_, AppState>, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    ide_host::ops::debug::debug_pause(&state.host, "", session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_step(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
    kind: StepKind,
) -> IdeResult<()> {
    ide_host::ops::debug::debug_step(&state.host, "", session, thread_id, kind).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_run_to(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
    path: PathBuf,
    line: u32,
    force: bool,
) -> IdeResult<()> {
    ide_host::ops::debug::debug_run_to(&state.host, "", session, thread_id, path, line, force).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_stop(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<()> {
    ide_host::ops::debug::debug_stop(&state.host, "", session).await
}

/// Evaluate with an explicit DAP context: `repl`, `watch`, `hover` or `clipboard`.
#[tauri::command]
#[specta::specta]
pub async fn debug_evaluate_in(
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
    context: Option<String>,
) -> IdeResult<Variable> {
    ide_host::ops::debug::debug_evaluate_in(&state.host, "", session, frame_id, expression, context).await
}

/// Last known verification states of a file's breakpoints (refetch on `breakpointsChanged`).
#[tauri::command]
#[specta::specta]
pub fn debug_breakpoint_states(state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<BreakpointState>> {
    ide_host::ops::debug::debug_breakpoint_states(&state.host, "", path)
}

/// This window's live sessions, including adapter-started child sessions.
#[tauri::command]
#[specta::specta]
pub fn debug_sessions(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SessionInfo>> {
    ide_host::ops::debug::debug_sessions(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn debug_exception_filters(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SessionExceptionFilters>> {
    ide_host::ops::debug::debug_exception_filters(&state.host, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn debug_set_exception_breakpoints(
    state: State<'_, AppState>,
    choices: std::collections::BTreeMap<String, bool>,
) -> IdeResult<()> {
    ide_host::ops::debug::debug_set_exception_breakpoints(&state.host, "", choices).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_set_variable(
    state: State<'_, AppState>,
    session: DebugSessionId,
    container: i64,
    name: String,
    evaluate_name: Option<String>,
    frame_id: Option<i64>,
    value: String,
) -> IdeResult<Variable> {
    ide_host::ops::debug::debug_set_variable(&state.host, "", session, container, name, evaluate_name, frame_id, value)
        .await
}

/// Force Step Over: step over with every breakpoint suspended until the step ends.
#[tauri::command]
#[specta::specta]
pub async fn debug_force_step_over(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<()> {
    ide_host::ops::debug::debug_force_step_over(&state.host, "", session, thread_id).await
}

/// Smart Step Into: the calls on the current line of `frame_id`.
#[tauri::command]
#[specta::specta]
pub async fn debug_step_in_targets(
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame_id: i64,
) -> IdeResult<Vec<StepInTarget>> {
    ide_host::ops::debug::debug_step_in_targets(&state.host, "", session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_step_in_target(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
    target_id: i64,
) -> IdeResult<()> {
    ide_host::ops::debug::debug_step_in_target(&state.host, "", session, thread_id, target_id).await
}

/// Reset Frame (Drop Frame).
#[tauri::command]
#[specta::specta]
pub async fn debug_restart_frame(state: State<'_, AppState>, session: DebugSessionId, frame_id: i64) -> IdeResult<()> {
    ide_host::ops::debug::debug_restart_frame(&state.host, "", session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub fn debug_capabilities(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<DebugCapabilities> {
    ide_host::ops::debug::debug_capabilities(&state.host, "", session)
}

/// Method breakpoints (all files); states aligned with `breakpoints`.
#[tauri::command]
#[specta::specta]
pub async fn debug_set_function_breakpoints(
    state: State<'_, AppState>,
    breakpoints: Vec<FunctionBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    ide_host::ops::debug::debug_set_function_breakpoints(&state.host, "", breakpoints).await
}

/// Field watchpoints; states aligned with `breakpoints`.
#[tauri::command]
#[specta::specta]
pub async fn debug_set_data_breakpoints(
    state: State<'_, AppState>,
    breakpoints: Vec<DataBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    ide_host::ops::debug::debug_set_data_breakpoints(&state.host, "", breakpoints).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_data_breakpoint_info(
    state: State<'_, AppState>,
    session: DebugSessionId,
    container: i64,
    name: String,
    frame_id: Option<i64>,
) -> IdeResult<DataBreakpointInfo> {
    ide_host::ops::debug::debug_data_breakpoint_info(&state.host, "", session, container, name, frame_id).await
}

/// Attach to Process: the user's processes a debugger can attach to.
#[tauri::command]
#[specta::specta]
pub async fn debug_attachable_processes(state: State<'_, AppState>) -> IdeResult<Vec<attach::AttachableProcess>> {
    ide_host::ops::debug::debug_attachable_processes(&state.host, "").await
}

/// Remote JVM Debug in listen mode: waits (cancellable through `request`) for the remote
/// JVM to connect to `host:port`; returns the loopback port java-debug attaches to.
#[tauri::command]
#[specta::specta]
pub async fn debug_listen_for_jvm(
    state: State<'_, AppState>,
    request: ide_core::RequestId,
    host: String,
    port: u16,
) -> IdeResult<u16> {
    ide_host::ops::debug::debug_listen_for_jvm(&state.host, "", request, host, port).await
}

/// HotSwap (Reload Changed Classes) in a java-debug session.
#[tauri::command]
#[specta::specta]
pub async fn debug_redefine_classes(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<HotSwapResult> {
    ide_host::ops::debug::debug_redefine_classes(&state.host, "", session).await
}
