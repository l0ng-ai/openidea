//! Agents tool window: coding agent tasks of the project (over ACP). In a remote
//! window they run on the host, next to the project they work on.
use super::{Channel, Emit};
use crate::Host;
use crate::rpc::Dispatcher;
use ide_agent::registry::{AgentRegistry, RegistryPaths};
use ide_agent::{
    AgentChange, AgentCommand, AgentEntry, AgentEvent, AgentProbe, AgentPrompt, AgentProvider, AgentQueued, AgentTask,
    ExternalSession, McpScope, McpServer, McpServerInput, NewAgentTask,
};
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_tools::InstallEvent;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

/// Streams the project's agent events to this window; returns every task.
pub fn subscribe(host: &Host, window: &str, on_event: Emit<AgentEvent>) -> IdeResult<Vec<AgentTask>> {
    Ok(host.project(window)?.agents.subscribe(on_event))
}

pub fn providers(host: &Host, window: &str) -> IdeResult<Vec<AgentProvider>> {
    host.require_trust(window)?;
    let mut providers = host.project(window)?.agents.providers();
    ide_agent::registry::mark_updates(&registry_paths(host), &mut providers);
    Ok(providers)
}

/// Overrides built-in agent `id`'s command with `command` (its agent file keeps the
/// built-in's driver and arguments), or returns it to auto-detection with `None`.
pub fn set_command(host: &Host, window: &str, id: String, command: Option<String>) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_builtin_command(&id, command)
}

/// Environment variables built-in agent `id` starts with; empty clears them.
pub fn set_env(
    host: &Host,
    window: &str,
    id: String,
    env: std::collections::BTreeMap<String, String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_builtin_env(&id, env)
}

/// Where ACP Registry agents are saved (`<config>/agents`, like the user's own) and installed.
pub(crate) fn registry_paths(host: &Host) -> RegistryPaths {
    RegistryPaths::new(&host.config_dir, &host.local_data_dir)
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Agents of the ACP Registry this machine can run, with what is installed; the list
/// saved earlier when the registry is unreachable. Cancel with `cancel_request(request)`.
pub async fn registry_list(host: &Host, _window: &str, request: RequestId) -> IdeResult<AgentRegistry> {
    let paths = registry_paths(host);
    let cancel = host.begin_request(request);
    let result =
        tokio::task::spawn_blocking(move || ide_agent::registry::list(&paths, &cancel)).await.map_err(join_err);
    host.end_request(request);
    let mut registry = result??;
    let installing = installing();
    for agent in &mut registry.agents {
        agent.installing = installing.contains(&agent.id);
    }
    Ok(registry)
}

/// Registry installs in progress, by agent id. An install outlives the Settings page
/// that started it, so a second one of the same agent is refused rather than racing it
/// for the same folder.
static INSTALLING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

fn installing() -> std::sync::MutexGuard<'static, HashSet<String>> {
    INSTALLING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Marks agent `id` as installing until dropped.
struct Installing(String);

impl Installing {
    fn begin(id: &str) -> IdeResult<Self> {
        if !installing().insert(id.to_owned()) {
            return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{id} is already being installed")));
        }
        Ok(Self(id.to_owned()))
    }
}

impl Drop for Installing {
    fn drop(&mut self) {
        installing().remove(&self.0);
    }
}

/// Installs the registry's current version of agent `id` (also to update it), streaming
/// progress through `on_event`; the agent then shows in `agent_providers`. Cancel with
/// `cancel_request(request)`.
pub async fn registry_install(
    host: &Host,
    _window: &str,
    id: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<()> {
    let paths = registry_paths(host);
    let installing = Installing::begin(&id)?;
    let cancel = host.begin_request(request);
    // Also a background task of every project window, so it stays visible and can be
    // stopped there once the Settings page is closed.
    let task = TaskId::next();
    let title = format!("Installing {id}");
    let sinks: Vec<SharedSink> = host.projects().iter().map(|p| p.sink.clone()).collect();
    let report = move |message: Option<String>, fraction: Option<f32>, done: bool| {
        for sink in &sinks {
            sink.emit(IdeEvent::Task {
                id: task,
                title: title.clone(),
                message: message.clone(),
                fraction,
                done,
                cancellable: !done,
            });
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        let _installing = installing;
        let _cancel = ide_core::task::on_cancel(task, {
            let cancel = cancel.clone();
            move || cancel.cancel()
        });
        report(None, None, false);
        let result = ide_agent::registry::install(&paths, &id, &cancel, &|e| {
            match &e {
                InstallEvent::Line { text } => report(Some(text.clone()), None, false),
                InstallEvent::Progress { fraction, message } => {
                    report(Some(message.clone()), fraction.map(|f| f as f32), false)
                }
            }
            let _ = on_event.send(e);
        });
        report(None, Some(1.0), true);
        result
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result??;
    for project in host.projects() {
        project.agents.reload_providers();
    }
    Ok(())
}

/// Removes a registry agent: its agent file and installed files.
pub async fn registry_remove(host: &Host, _window: &str, id: String) -> IdeResult<()> {
    let paths = registry_paths(host);
    tokio::task::spawn_blocking(move || ide_agent::registry::remove(&paths, &id)).await.map_err(join_err)??;
    for project in host.projects() {
        project.agents.reload_providers();
    }
    Ok(())
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

/// Sessions of the project on this machine that no task holds yet, newest first. Reads
/// transcripts from disk on the blocking pool.
pub async fn external_sessions(host: &Host, window: &str) -> IdeResult<Vec<ExternalSession>> {
    let agents = host.project(window)?.agents.clone();
    tokio::task::spawn_blocking(move || agents.external_sessions()).await.map_err(join_err)
}

/// Imports an external session as a task: its first turn loads and replays it.
pub async fn import_session(host: &Host, window: &str, provider: String, session_id: String) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    let agents = host.project(window)?.agents.clone();
    tokio::task::spawn_blocking(move || agents.import_session(&provider, &session_id)).await.map_err(join_err)?
}

pub async fn create(host: &Host, window: &str, mut request: NewAgentTask) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let root = project.root.clone();
    let requested = request.project_root.take();
    request.project_root = Some(IpcPath(
        host.blocking(move || validate_project_root(&root, requested.as_ref().map(|p| p.0.as_path()))).await?,
    ));
    project.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
pub async fn prompt(host: &Host, window: &str, task: String, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.prompt(&task, prompt, now).await
}

/// Drops a queued message and returns it (to edit it).
pub fn unqueue(host: &Host, window: &str, task: String, queued: String) -> IdeResult<AgentQueued> {
    host.project(window)?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
pub fn send_queued_now(host: &Host, window: &str, task: String, queued: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.send_queued_now(&task, &queued)
}

/// Changes a session setting (model, mode, thinking effort…).
pub async fn set_config(host: &Host, window: &str, task: String, option: String, value: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_config(&task, &option, value).await
}

/// Copies the task's conversation into a new task, up to its first `turns` turns (all when `None`).
pub async fn fork(host: &Host, window: &str, task: String, turns: Option<u32>) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    host.project(window)?.agents.fork(&task, turns).await
}

/// Drops the task's turns after its first `turns`; returns the message of the first dropped one.
pub async fn rollback(host: &Host, window: &str, task: String, turns: u32) -> IdeResult<Option<AgentPrompt>> {
    host.require_trust(window)?;
    host.project(window)?.agents.rollback(&task, turns).await
}

/// What the agent reports about itself when it starts, without opening a session.
pub async fn probe(host: &Host, window: &str, provider: String, refresh: bool) -> IdeResult<AgentProbe> {
    host.require_trust(window)?;
    host.project(window)?.agents.probe(&provider, refresh).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
pub fn cancel(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<()> {
    host.project(window)?.agents.cancel(&task, subagent)
}

/// Stops one of the task's background tasks.
pub async fn stop_background(host: &Host, window: &str, task: String, background: String) -> IdeResult<()> {
    host.project(window)?.agents.stop_background(&task, &background).await
}

/// Answers a permission request; `option: None` cancels it.
pub fn respond(host: &Host, window: &str, task: String, permission: u32, option: Option<String>) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.respond(&task, permission, option)
}

pub fn archive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.archive(&task)
}

pub fn unarchive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.unarchive(&task)
}

pub fn rename(host: &Host, window: &str, task: String, title: String) -> IdeResult<()> {
    host.project(window)?.agents.rename(&task, &title)
}

pub async fn delete(host: &Host, window: &str, task: String, remove_worktree: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.delete(&task, remove_worktree).await
}

pub async fn changes(host: &Host, window: &str, task: String) -> IdeResult<Vec<AgentChange>> {
    host.require_trust(window)?;
    host.project(window)?.agents.changes(&task).await
}

/// Content of `path` when the task started (left side of its diff).
pub async fn base_text(host: &Host, window: &str, task: String, path: IpcPath) -> IdeResult<Option<String>> {
    host.require_trust(window)?;
    host.project(window)?.agents.base_text(&task, path.into_path_buf()).await
}

/// Rollback: the task's changed files among `paths` (all without) back as they were when it started.
pub async fn rollback_changes(host: &Host, window: &str, task: String, paths: Option<Vec<String>>) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.rollback_changes(&task, paths).await
}

type McpServerMap = std::collections::BTreeMap<String, ide_core::settings::AgentMcpServer>;

fn mcp_maps(host: &Host, window: &str) -> (McpServerMap, McpServerMap, Option<std::sync::Arc<crate::Project>>) {
    let user = host.global_settings.effective().agents.mcp_servers;
    let project = host.project(window).ok().filter(|p| !p.light);
    let workspace = project
        .as_ref()
        .map(|p| p.settings.layer(ide_workspace::settings::SettingsScope::Project).agents.mcp_servers)
        .unwrap_or_default();
    (user, workspace, project)
}

fn persist_mcp_map(
    host: &Host,
    project: Option<&std::sync::Arc<crate::Project>>,
    scope: McpScope,
    map: &McpServerMap,
) -> IdeResult<()> {
    let value = if map.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::to_value(map).map_err(|e| IdeError::invalid(e.to_string()))?
    };
    let event = IdeEvent::SettingsChanged { key: "agents.mcpServers".into() };
    match scope {
        McpScope::User => {
            host.global_settings.set(ide_workspace::settings::SettingsScope::Global, "agents.mcpServers", value)?;
            for p in host.projects() {
                p.settings.reload();
                p.sink.emit(event.clone());
            }
        }
        McpScope::Workspace => {
            let p = project.ok_or_else(|| IdeError::invalid("Open a project to configure workspace MCP servers"))?;
            p.settings.set(ide_workspace::settings::SettingsScope::Project, "agents.mcpServers", value)?;
            p.sink.emit(event);
        }
    }
    Ok(())
}

fn update_mcp_maps<F>(host: &Host, window: &str, f: F) -> IdeResult<Vec<McpServer>>
where
    F: FnOnce(&mut McpServerMap, &mut McpServerMap, Option<&std::path::Path>) -> Result<(), String>,
{
    let (mut user, mut workspace, project) = mcp_maps(host, window);
    let prev_user = user.clone();
    let prev_workspace = workspace.clone();
    let project_root = project.as_ref().map(|p| p.root.as_path());
    f(&mut user, &mut workspace, project_root).map_err(IdeError::invalid)?;
    if workspace != prev_workspace {
        persist_mcp_map(host, project.as_ref(), McpScope::Workspace, &workspace)?;
    }
    if user != prev_user {
        persist_mcp_map(host, project.as_ref(), McpScope::User, &user)?;
    }
    Ok(ide_agent::mcp::servers_from_settings(&user, &workspace))
}

/// Lists configured MCP servers across User (`settings.toml`) and Workspace (`.openidea/settings.toml`) scopes.
pub fn mcp_list(host: &Host, window: &str) -> IdeResult<Vec<McpServer>> {
    let (user, workspace, _) = mcp_maps(host, window);
    Ok(ide_agent::mcp::servers_from_settings(&user, &workspace))
}

/// Creates or updates a User or Workspace MCP server and returns the updated list.
pub fn mcp_save(host: &Host, window: &str, input: McpServerInput) -> IdeResult<Vec<McpServer>> {
    update_mcp_maps(host, window, |user, workspace, project_root| {
        ide_agent::mcp::apply_save(user, workspace, project_root.is_some(), input)
    })
}

/// Enables or disables an MCP server and returns the updated list.
pub fn mcp_set_enabled(host: &Host, window: &str, id: String, enabled: bool) -> IdeResult<Vec<McpServer>> {
    update_mcp_maps(host, window, |user, workspace, _| {
        ide_agent::mcp::apply_set_enabled(user, workspace, &id, enabled).map(|_| ())
    })
}

/// Removes a User or Workspace MCP server and returns the updated list.
pub fn mcp_remove(host: &Host, window: &str, id: String) -> IdeResult<Vec<McpServer>> {
    update_mcp_maps(host, window, |user, workspace, _| ide_agent::mcp::apply_remove(user, workspace, &id).map(|_| ()))
}

/// Copies MCP servers from `.mcp.json` and `.vscode/mcp.json` into the workspace settings once.
pub fn mcp_import(host: &Host, window: &str) -> IdeResult<Vec<McpServer>> {
    update_mcp_maps(host, window, |_, workspace, project_root| {
        let root = project_root.ok_or_else(|| "Open a project to import workspace MCP servers".to_string())?;
        ide_agent::mcp::apply_import(workspace, root);
        Ok(())
    })
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("agent_subscribe", |c| async move { subscribe(&c.host, &c.window, c.channel("onEvent")?) });
    d.add("agent_providers", |c| async move { providers(&c.host, &c.window) });
    d.add("agent_set_command", |c| async move { set_command(&c.host, &c.window, c.arg("id")?, c.arg("command")?) });
    d.add("agent_set_env", |c| async move { set_env(&c.host, &c.window, c.arg("id")?, c.arg("env")?) });
    d.add("agent_registry_list", |c| async move { registry_list(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_registry_install", |c| async move {
        registry_install(&c.host, &c.window, c.arg("id")?, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("agent_registry_remove", |c| async move { registry_remove(&c.host, &c.window, c.arg("id")?).await });
    d.add("agent_mcp_list", |c| async move { mcp_list(&c.host, &c.window) });
    d.add("agent_mcp_save", |c| async move { mcp_save(&c.host, &c.window, c.arg("input")?) });
    d.add(
        "agent_mcp_set_enabled",
        |c| async move { mcp_set_enabled(&c.host, &c.window, c.arg("id")?, c.arg("enabled")?) },
    );
    d.add("agent_mcp_remove", |c| async move { mcp_remove(&c.host, &c.window, c.arg("id")?) });
    d.add("agent_mcp_import", |c| async move { mcp_import(&c.host, &c.window) });
    d.add("agent_commands", |c| async move { commands(&c.host, &c.window, c.arg("provider")?, c.arg("task")?).await });
    d.add("agent_entries", |c| async move { entries(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_create", |c| async move { create(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_external_sessions", |c| async move { external_sessions(&c.host, &c.window).await });
    d.add("agent_import_session", |c| async move {
        import_session(&c.host, &c.window, c.arg("provider")?, c.arg("sessionId")?).await
    });
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
    d.add("agent_fork", |c| async move { fork(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_rollback", |c| async move { rollback(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_probe", |c| async move { probe(&c.host, &c.window, c.arg("provider")?, c.arg("refresh")?).await });
    d.add("agent_cancel", |c| async move { cancel(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_stop_background", |call| async move {
        stop_background(&call.host, &call.window, call.arg("task")?, call.arg("background")?).await
    });
    d.add("agent_respond", |c| async move {
        respond(&c.host, &c.window, c.arg("task")?, c.arg("permission")?, c.arg("option")?)
    });
    d.add("agent_unarchive", |c| async move { unarchive(&c.host, &c.window, c.arg("task")?) });
    d.add("agent_rename", |c| async move { rename(&c.host, &c.window, c.arg("task")?, c.arg("title")?) });
    d.add("agent_archive", |c| async move { archive(&c.host, &c.window, c.arg("task")?) });
    d.add(
        "agent_delete",
        |c| async move { delete(&c.host, &c.window, c.arg("task")?, c.arg("removeWorktree")?).await },
    );
    d.add("agent_changes", |c| async move { changes(&c.host, &c.window, c.arg("task")?).await });
    d.add("agent_base_text", |c| async move { base_text(&c.host, &c.window, c.arg("task")?, c.arg("path")?).await });
    d.add("agent_rollback_changes", |c| async move {
        rollback_changes(&c.host, &c.window, c.arg("task")?, c.arg("paths")?).await
    });
}

fn validate_project_root(root: &std::path::Path, requested: Option<&std::path::Path>) -> IdeResult<std::path::PathBuf> {
    let Some(requested) = requested else {
        return Ok(root.to_path_buf());
    };
    if !requested.is_absolute() {
        return Err(IdeError::invalid("Choose an absolute project root"));
    }
    let requested = dunce::canonicalize(requested)?;
    let window_root = dunce::canonicalize(root)?;
    if requested == window_root
        || ide_workspace::workspace::Workspace::load(root)?.is_some_and(|w| w.projects.contains(&requested))
    {
        return Ok(requested);
    }
    Err(IdeError::invalid("Agent project must be the window project or a workspace member"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_installs_once_at_a_time() {
        let first = Installing::begin("test-agent").unwrap();
        assert!(installing().contains("test-agent"));
        let again = Installing::begin("test-agent").err().unwrap();
        assert_eq!(again.kind, ErrorKind::AlreadyExists);
        let other = Installing::begin("test-other-agent").unwrap();
        drop(first);
        assert!(!installing().contains("test-agent"));
        drop(Installing::begin("test-agent").unwrap());
        drop(other);
    }

    #[test]
    fn agent_roots_are_exact_window_or_workspace_members() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("workspace");
        let member = tmp.path().join("member");
        let other = tmp.path().join("other");
        for dir in [&root, &member, &other, &member.join("child")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        assert_eq!(validate_project_root(&root, None).unwrap(), root);
        assert_eq!(validate_project_root(&root, Some(&root)).unwrap(), dunce::canonicalize(&root).unwrap());
        assert!(validate_project_root(&root, Some(&member)).is_err());
        ide_workspace::workspace::Workspace::save(&root, "Workspace", vec![member.clone()], true).unwrap();
        assert_eq!(validate_project_root(&root, Some(&member)).unwrap(), dunce::canonicalize(&member).unwrap());
        for rejected in [other, member.join("child"), member.join("../other"), "relative".into()] {
            assert!(validate_project_root(&root, Some(&rejected)).is_err(), "{rejected:?}");
        }
    }
}
