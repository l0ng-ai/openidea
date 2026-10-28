//! IPC commands of `ide_host::ops::agent` (the shared implementation).

use crate::state::AppState;
use ide_agent::{
    AgentChange, AgentCommand, AgentEntry, AgentEvent, AgentPrompt, AgentProvider, AgentQueued, AgentTask, NewAgentTask,
};
use ide_core::{IdeResult, IpcPath};
use ide_host::ops::agent;
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
    agent::subscribe(
        &state.host,
        window.label(),
        Arc::new(move |e| {
            let _ = on_event.send(e);
        }),
    )
}

#[tauri::command]
#[specta::specta]
pub fn agent_providers(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<AgentProvider>> {
    agent::providers(&state.host, window.label())
}

/// Slash commands to complete for `provider` in `task`'s directory, or in the project
/// before a task exists (skills and custom commands on disk included).
#[tauri::command]
#[specta::specta]
pub async fn agent_commands(
    window: Window,
    state: State<'_, AppState>,
    provider: String,
    task: Option<String>,
) -> IdeResult<Vec<AgentCommand>> {
    agent::commands(&state.host, window.label(), provider, task).await
}

/// Entries of `task`'s conversation, or of its subagent `subagent`'s.
#[tauri::command]
#[specta::specta]
pub fn agent_entries(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    subagent: Option<String>,
) -> IdeResult<Vec<AgentEntry>> {
    agent::entries(&state.host, window.label(), task, subagent)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_create(window: Window, state: State<'_, AppState>, request: NewAgentTask) -> IdeResult<AgentTask> {
    agent::create(&state.host, window.label(), request).await
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
    agent::prompt(&state.host, window.label(), task, prompt, now).await
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
    agent::unqueue(&state.host, window.label(), task, queued)
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
    agent::send_queued_now(&state.host, window.label(), task, queued)
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
    agent::set_config(&state.host, window.label(), task, option, value).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
#[tauri::command]
#[specta::specta]
pub fn agent_cancel(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    subagent: Option<String>,
) -> IdeResult<()> {
    agent::cancel(&state.host, window.label(), task, subagent)
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
    agent::respond(&state.host, window.label(), task, permission, option)
}

#[tauri::command]
#[specta::specta]
pub fn agent_archive(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<()> {
    agent::archive(&state.host, window.label(), task)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_delete(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    remove_worktree: bool,
) -> IdeResult<()> {
    agent::delete(&state.host, window.label(), task, remove_worktree).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_changes(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<Vec<AgentChange>> {
    agent::changes(&state.host, window.label(), task).await
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
    agent::base_text(&state.host, window.label(), task, path).await
}
