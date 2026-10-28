//! Agents tool window: coding agent tasks of the project (over ACP). In a remote
//! window they run on the host, next to the project they work on.
use super::Emit;
use crate::Host;
use crate::rpc::Dispatcher;
use ide_agent::{
    AgentChange, AgentCommand, AgentEntry, AgentEvent, AgentPrompt, AgentProvider, AgentQueued, AgentTask, NewAgentTask,
};
use ide_core::{IdeResult, IpcPath};

/// Streams the project's agent events to this window; returns every task.
pub fn subscribe(host: &Host, window: &str, on_event: Emit<AgentEvent>) -> IdeResult<Vec<AgentTask>> {
    Ok(host.project(window)?.agents.subscribe(on_event))
}

pub fn providers(host: &Host, window: &str) -> IdeResult<Vec<AgentProvider>> {
    Ok(host.project(window)?.agents.providers())
}

/// Slash commands to complete for `provider` in `task`'s directory, or in the project
/// before a task exists (skills and custom commands on disk included).
pub async fn commands(
    host: &Host,
    window: &str,
    provider: String,
    task: Option<String>,
) -> IdeResult<Vec<AgentCommand>> {
    host.project(window)?.agents.commands(&provider, task.as_deref()).await
}

/// Entries of `task`'s conversation, or of its subagent `subagent`'s.
pub fn entries(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
    host.project(window)?.agents.entries(&task, subagent)
}

pub async fn create(host: &Host, window: &str, request: NewAgentTask) -> IdeResult<AgentTask> {
    host.project(window)?.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
pub async fn prompt(host: &Host, window: &str, task: String, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
    host.project(window)?.agents.prompt(&task, prompt, now).await
}

/// Drops a queued message and returns it (to edit it).
pub fn unqueue(host: &Host, window: &str, task: String, queued: String) -> IdeResult<AgentQueued> {
    host.project(window)?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
pub fn send_queued_now(host: &Host, window: &str, task: String, queued: String) -> IdeResult<()> {
    host.project(window)?.agents.send_queued_now(&task, &queued)
}

/// Changes a session setting (model, mode, thinking effort…).
pub async fn set_config(host: &Host, window: &str, task: String, option: String, value: String) -> IdeResult<()> {
    host.project(window)?.agents.set_config(&task, &option, value).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
pub fn cancel(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<()> {
    host.project(window)?.agents.cancel(&task, subagent)
}

/// Answers a permission request; `option: None` cancels it.
pub fn respond(host: &Host, window: &str, task: String, permission: u32, option: Option<String>) -> IdeResult<()> {
    host.project(window)?.agents.respond(&task, permission, option)
}

pub fn archive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.archive(&task)
}

pub async fn delete(host: &Host, window: &str, task: String, remove_worktree: bool) -> IdeResult<()> {
    host.project(window)?.agents.delete(&task, remove_worktree).await
}

pub async fn changes(host: &Host, window: &str, task: String) -> IdeResult<Vec<AgentChange>> {
    host.project(window)?.agents.changes(&task).await
}

/// Content of `path` when the task started (left side of its diff).
pub async fn base_text(host: &Host, window: &str, task: String, path: IpcPath) -> IdeResult<Option<String>> {
    host.project(window)?.agents.base_text(&task, path.into_path_buf()).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("agent_subscribe", |c| async move { subscribe(&c.host, &c.window, c.channel("onEvent")?) });
    d.add("agent_providers", |c| async move { providers(&c.host, &c.window) });
    d.add("agent_commands", |c| async move { commands(&c.host, &c.window, c.arg("provider")?, c.arg("task")?).await });
    d.add("agent_entries", |c| async move { entries(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_create", |c| async move { create(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_prompt", |c| async move {
        prompt(&c.host, &c.window, c.arg("task")?, c.arg("prompt")?, c.arg("now")?).await
    });
    d.add("agent_unqueue", |c| async move { unqueue(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) });
    d.add(
        "agent_send_queued_now",
        |c| async move { send_queued_now(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) },
    );
    d.add("agent_set_config", |c| async move {
        set_config(&c.host, &c.window, c.arg("task")?, c.arg("option")?, c.arg("value")?).await
    });
    d.add("agent_cancel", |c| async move { cancel(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_respond", |c| async move {
        respond(&c.host, &c.window, c.arg("task")?, c.arg("permission")?, c.arg("option")?)
    });
    d.add("agent_archive", |c| async move { archive(&c.host, &c.window, c.arg("task")?) });
    d.add(
        "agent_delete",
        |c| async move { delete(&c.host, &c.window, c.arg("task")?, c.arg("removeWorktree")?).await },
    );
    d.add("agent_changes", |c| async move { changes(&c.host, &c.window, c.arg("task")?).await });
    d.add("agent_base_text", |c| async move { base_text(&c.host, &c.window, c.arg("task")?, c.arg("path")?).await });
}
