use crate::state::AppState;
use ide_core::{DebugSessionId, IdeResult};
use ide_dap::*;
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
    let label = window.label();
    let owner = SessionOwner::new(AppState::owner_window(label), state.window_sink(label));
    let settings = match state.project(label) {
        Ok(project) => project.settings.effective(),
        Err(_) => state.global_settings.effective(),
    };
    let root = config.cwd.clone().map(PathBuf::from).unwrap_or_default();
    let custom = |command: &str| {
        let path = ide_sdk::apply::setting_path(&root, settings.tool_path(command)?)?;
        Some(path.to_string_lossy().into_owned())
    };
    state.debugger.start_with(config, owner, custom).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_set_breakpoints(
    state: State<'_, AppState>,
    path: PathBuf,
    breakpoints: Vec<Breakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    state.debugger.set_breakpoints(path, breakpoints).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_threads(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<Vec<ThreadInfo>> {
    state.debugger.threads(session).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_stack_trace(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<Vec<StackFrame>> {
    state.debugger.stack_trace(session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_scopes(state: State<'_, AppState>, session: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Scope>> {
    state.debugger.scopes(session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_variables(
    state: State<'_, AppState>,
    session: DebugSessionId,
    reference: i64,
) -> IdeResult<Vec<Variable>> {
    state.debugger.variables(session, reference).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_evaluate(
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
) -> IdeResult<Variable> {
    state.debugger.evaluate(session, frame_id, expression).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_resume(state: State<'_, AppState>, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    state.debugger.resume(session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_pause(state: State<'_, AppState>, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    state.debugger.pause(session, thread_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_step(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
    kind: StepKind,
) -> IdeResult<()> {
    state.debugger.step(session, thread_id, kind).await
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
    state.debugger.run_to(session, thread_id, path, line, force).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_stop(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<()> {
    state.debugger.stop(session).await
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
    state.debugger.evaluate_in(session, frame_id, expression, context).await
}

/// Last known verification states of a file's breakpoints (refetch on `breakpointsChanged`).
#[tauri::command]
#[specta::specta]
pub fn debug_breakpoint_states(state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<BreakpointState>> {
    Ok(state.debugger.breakpoint_states(&path))
}

/// This window's live sessions, including adapter-started child sessions.
#[tauri::command]
#[specta::specta]
pub fn debug_sessions(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SessionInfo>> {
    Ok(state.debugger.sessions(Some(AppState::owner_window(window.label()))))
}

#[tauri::command]
#[specta::specta]
pub fn debug_exception_filters(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<SessionExceptionFilters>> {
    Ok(state.debugger.exception_filters(Some(AppState::owner_window(window.label()))))
}

#[tauri::command]
#[specta::specta]
pub async fn debug_set_exception_breakpoints(
    state: State<'_, AppState>,
    choices: std::collections::BTreeMap<String, bool>,
) -> IdeResult<()> {
    state.debugger.set_exception_breakpoints(choices).await
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
    state.debugger.set_variable(session, container, name, evaluate_name, frame_id, value).await
}

/// Force Step Over: step over with every breakpoint suspended until the step ends.
#[tauri::command]
#[specta::specta]
pub async fn debug_force_step_over(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<()> {
    state.debugger.force_step_over(session, thread_id).await
}

/// Smart Step Into: the calls on the current line of `frame_id`.
#[tauri::command]
#[specta::specta]
pub async fn debug_step_in_targets(
    state: State<'_, AppState>,
    session: DebugSessionId,
    frame_id: i64,
) -> IdeResult<Vec<StepInTarget>> {
    state.debugger.step_in_targets(session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn debug_step_in_target(
    state: State<'_, AppState>,
    session: DebugSessionId,
    thread_id: i64,
    target_id: i64,
) -> IdeResult<()> {
    state.debugger.step_in_target(session, thread_id, target_id).await
}

/// Reset Frame (Drop Frame).
#[tauri::command]
#[specta::specta]
pub async fn debug_restart_frame(state: State<'_, AppState>, session: DebugSessionId, frame_id: i64) -> IdeResult<()> {
    state.debugger.restart_frame(session, frame_id).await
}

#[tauri::command]
#[specta::specta]
pub fn debug_capabilities(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<DebugCapabilities> {
    state.debugger.capabilities(session)
}

/// Method breakpoints (all files); states aligned with `breakpoints`.
#[tauri::command]
#[specta::specta]
pub async fn debug_set_function_breakpoints(
    state: State<'_, AppState>,
    breakpoints: Vec<FunctionBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    state.debugger.set_function_breakpoints(breakpoints).await
}

/// Field watchpoints; states aligned with `breakpoints`.
#[tauri::command]
#[specta::specta]
pub async fn debug_set_data_breakpoints(
    state: State<'_, AppState>,
    breakpoints: Vec<DataBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    state.debugger.set_data_breakpoints(breakpoints).await
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
    state.debugger.data_breakpoint_info(session, container, name, frame_id).await
}

/// Attach to Process: the user's processes a debugger can attach to.
#[tauri::command]
#[specta::specta]
pub async fn debug_attachable_processes() -> IdeResult<Vec<attach::AttachableProcess>> {
    tauri::async_runtime::spawn_blocking(attach::attachable_processes)
        .await
        .map_err(|e| ide_core::IdeError::internal(format!("listing processes failed: {e}")))?
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
    let token = state.begin_request(request);
    let result = jdwp::listen_for_jvm(&host, port, token).await;
    state.end_request(request);
    result
}

/// HotSwap (Reload Changed Classes) in a java-debug session.
#[tauri::command]
#[specta::specta]
pub async fn debug_redefine_classes(state: State<'_, AppState>, session: DebugSessionId) -> IdeResult<HotSwapResult> {
    state.debugger.redefine_classes(session).await
}
