use crate::state::AppState;
use ide_agent::{
    AgentChange, AgentEntry, AgentEvent, AgentPrompt, AgentProvider, AgentQueued, AgentTask, NewAgentTask,
};
use ide_core::{IdeResult, IpcPath};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{State, Window};

/// Streams the project's agent events to this window; returns every task.
#[tauri::command]
#[specta::specta]
pub fn agent_subscribe(
    window: Window,
    state: State<'_, AppState>,
    on_event: Channel<AgentEvent>,
) -> IdeResult<Vec<AgentTask>> {
    let project = state.project(window.label())?;
    Ok(project.agents.subscribe(Arc::new(move |e| {
        let _ = on_event.send(e);
    })))
}

#[tauri::command]
#[specta::specta]
pub fn agent_providers(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<AgentProvider>> {
    Ok(state.project(window.label())?.agents.providers())
}

#[tauri::command]
#[specta::specta]
pub fn agent_entries(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<Vec<AgentEntry>> {
    state.project(window.label())?.agents.entries(&task)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_create(window: Window, state: State<'_, AppState>, request: NewAgentTask) -> IdeResult<AgentTask> {
    let project = state.project(window.label())?;
    project.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    prompt: AgentPrompt,
    now: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    project.agents.prompt(&task, prompt, now).await
}

/// Drops a queued message and returns it (to edit it).
#[tauri::command]
#[specta::specta]
pub fn agent_unqueue(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    queued: String,
) -> IdeResult<AgentQueued> {
    state.project(window.label())?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
#[tauri::command]
#[specta::specta]
pub fn agent_send_queued_now(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    queued: String,
) -> IdeResult<()> {
    state.project(window.label())?.agents.send_queued_now(&task, &queued)
}

/// Changes a session setting (model, mode, thinking effort…).
#[tauri::command]
#[specta::specta]
pub async fn agent_set_config(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    option: String,
    value: String,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    project.agents.set_config(&task, &option, value).await
}

#[tauri::command]
#[specta::specta]
pub fn agent_cancel(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<()> {
    state.project(window.label())?.agents.cancel(&task)
}

/// Answers a permission request; `option: null` cancels it.
#[tauri::command]
#[specta::specta]
pub fn agent_respond(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    permission: u32,
    option: Option<String>,
) -> IdeResult<()> {
    state.project(window.label())?.agents.respond(&task, permission, option)
}

#[tauri::command]
#[specta::specta]
pub fn agent_archive(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<()> {
    state.project(window.label())?.agents.archive(&task)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_delete(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    remove_worktree: bool,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    project.agents.delete(&task, remove_worktree).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_changes(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<Vec<AgentChange>> {
    let project = state.project(window.label())?;
    project.agents.changes(&task).await
}

/// Content of `path` when the task started (left side of its diff).
#[tauri::command]
#[specta::specta]
pub async fn agent_base_text(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    path: IpcPath,
) -> IdeResult<Option<String>> {
    let project = state.project(window.label())?;
    project.agents.base_text(&task, path.into_path_buf()).await
}
