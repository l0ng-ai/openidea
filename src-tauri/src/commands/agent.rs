//! IPC commands of `ide_host::ops::agent` (the shared implementation).

use crate::state::AppState;
use ide_agent::registry::AgentRegistry;
use ide_agent::{
    AgentChange, AgentCommand, AgentEntry, AgentEvent, AgentProbe, AgentPrompt, AgentProvider, AgentQueued, AgentTask,
    NewAgentTask,
};
use ide_core::{IdeResult, IpcPath, RequestId};
use ide_host::ops::agent;
use ide_tools::InstallEvent;
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

/// Agents of the ACP Registry this machine can run, with what is installed; the list
/// saved earlier when the registry is unreachable. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn agent_registry_list(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
) -> IdeResult<AgentRegistry> {
    agent::registry_list(&state.host, window.label(), request).await
}

/// Installs the registry's current version of agent `id` (also to update it), streaming
/// progress through `on_event`. Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn agent_registry_install(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<()> {
    agent::registry_install(&state.host, window.label(), id, request, crate::commands::sender(on_event)).await
}

/// Removes a registry agent: its agent file and installed files.
#[tauri::command]
#[specta::specta]
pub async fn agent_registry_remove(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<()> {
    agent::registry_remove(&state.host, window.label(), id).await
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

/// Copies the task's conversation into a new task, up to its first `turns` turns (all when `None`).
#[tauri::command]
#[specta::specta]
pub async fn agent_fork(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    turns: Option<u32>,
) -> IdeResult<AgentTask> {
    agent::fork(&state.host, window.label(), task, turns).await
}

/// Drops the task's turns after its first `turns`; returns the message of the first dropped one.
#[tauri::command]
#[specta::specta]
pub async fn agent_rollback(
    window: Window,
    state: State<'_, AppState>,
    task: String,
    turns: u32,
) -> IdeResult<Option<AgentPrompt>> {
    agent::rollback(&state.host, window.label(), task, turns).await
}

/// What the agent reports about itself when it starts (no session: no MCP servers, hooks
/// or sign-in run). Remembered until `refresh`.
#[tauri::command]
#[specta::specta]
pub async fn agent_probe(
    window: Window,
    state: State<'_, AppState>,
    provider: String,
    refresh: bool,
) -> IdeResult<AgentProbe> {
    agent::probe(&state.host, window.label(), provider, refresh).await
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
pub fn agent_unarchive(window: Window, state: State<'_, AppState>, task: String) -> IdeResult<()> {
    agent::unarchive(&state.host, window.label(), task)
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
