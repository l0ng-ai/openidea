//! Agents tool window: coding agent tasks of the project (over ACP). In a remote
//! window they run on the host, next to the project they work on.
use super::Channel;
use crate::Host;
use crate::agent_secrets::{AgentSecrets, Kept};
use ide_agent::registry::{AgentRegistry, RegistryPaths};
use ide_agent::{
    AcpImportOutcome, AgentAcceptOutcome, AgentChange, AgentChanges, AgentChangesView, AgentCliOffer,
    AgentCliUpdateResult, AgentCommand, AgentContextUsage, AgentEntry, AgentEvent, AgentModelCatalog, AgentProbe,
    AgentPrompt, AgentProvider, AgentQueued, AgentSkillMode, AgentSkillPolicy, AgentSkillState, AgentTask,
    CustomAgentInput, ExternalSession, McpExternalSource, McpImportSelection, McpProbeResult, McpScope, McpServer,
    McpServerInput, McpTransport, NewAgentTask, SkillsPolicy,
};
use ide_command::command;
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_tools::InstallEvent;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

/// Streams the project's agent events to `subscriber`, one of the project's windows (a remote
/// host sees them all as one `window`); returns every task.
#[command(trust = always)]
pub fn agent_subscribe(
    host: &Host,
    window: &str,
    on_event: Channel<AgentEvent>,
    subscriber: String,
) -> IdeResult<Vec<AgentTask>> {
    Ok(host.project(window)?.agents.subscribe_as(
        &subscriber,
        std::sync::Arc::new(move |e| {
            let _ = on_event.send(e);
        }),
    ))
}

/// Stops the events of a window that closed.
#[command(trust = always)]
pub fn agent_unsubscribe(host: &Host, window: &str, subscriber: String) -> IdeResult<()> {
    host.project(window)?.agents.unsubscribe(&subscriber);
    Ok(())
}

#[command(trust = trusted)]
pub fn agent_providers(host: &Host, window: &str) -> IdeResult<Vec<AgentProvider>> {
    host.require_trust(window)?;
    let mut providers = host.project(window)?.agents.providers();
    ide_agent::registry::mark_updates(&registry_paths(host), &mut providers);
    Ok(providers)
}

/// Hermes Agent profiles on this machine (`default` first); empty without Hermes.
#[command(trust = trusted)]
pub async fn agent_hermes_profiles(host: &Host, window: &str) -> IdeResult<Vec<ide_agent::hermes::HermesProfile>> {
    host.require_trust(window)?;
    let root = ide_agent::hermes::root(dirs::home_dir().as_deref());
    tokio::task::spawn_blocking(move || root.map(|r| ide_agent::hermes::labeled_profiles(&r)).unwrap_or_default())
        .await
        .map_err(join_err)
}

/// Refreshes the model catalog; force bypasses freshness, not the cooldown.
#[command(trust = trusted)]
pub fn agent_refresh_models(
    host: &Host,
    window: &str,
    provider: String,
    force: bool,
    model: Option<String>,
) -> IdeResult<AgentModelCatalog> {
    // Refreshes the selected agent's model catalog without sending a prompt.
    host.require_trust(window)?;
    host.project(window)?.agents.refresh_models(&provider, force, model.as_deref())
}

/// Overrides built-in agent `id`'s command with `command` (its agent file keeps the
/// built-in's driver and arguments), or returns it to auto-detection with `None`.
#[command(trust = trusted)]
pub fn agent_set_command(host: &Host, window: &str, id: String, command: Option<String>) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_builtin_command(&id, command)
}

/// Environment variables built-in agent `id` starts with (saved in its agent file);
/// an empty map clears them.
#[command(trust = trusted)]
pub fn agent_set_env(
    host: &Host,
    window: &str,
    id: String,
    env: std::collections::BTreeMap<String, String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_builtin_env(&id, env)
}

/// Saves a new custom ACP agent through its agent file.
pub fn save_custom_agent(host: &Host, window: &str, input: CustomAgentInput) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.save_custom_agent(input)
}

/// Removes a custom agent's file (registry installs go through `registry_remove`).
pub fn remove_custom_agent(host: &Host, window: &str, id: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.remove_custom_agent(&id)
}

/// Imports a JetBrains `acp.json` file's `agent_servers` entries as custom agents.
pub fn import_acp_agents(host: &Host, window: &str, text: String) -> IdeResult<Vec<AcpImportOutcome>> {
    host.require_trust(window)?;
    host.project(window)?.agents.import_acp_agents(&text)
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
#[command(trust = always)]
pub async fn agent_registry_list(host: &Host, request: RequestId) -> IdeResult<AgentRegistry> {
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
/// progress through `on_event`. Cancel with `cancel_request(request)`.
#[command(trust = always)]
pub async fn agent_registry_install(
    host: &Host,
    id: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<()> {
    // The agent then shows in `agent_providers`.
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
#[command(trust = always)]
pub async fn agent_registry_remove(host: &Host, id: String) -> IdeResult<()> {
    let paths = registry_paths(host);
    tokio::task::spawn_blocking(move || ide_agent::registry::remove(&paths, &id)).await.map_err(join_err)??;
    for project in host.projects() {
        project.agents.reload_providers();
    }
    Ok(())
}

/// Slash commands to complete for `provider` in `task`'s directory, or in the project
/// before a task exists (skills and custom commands on disk included).
#[command(trust = always)]
pub async fn agent_commands(
    host: &Host,
    window: &str,
    provider: String,
    task: Option<String>,
) -> IdeResult<Vec<AgentCommand>> {
    host.project(window)?.agents.commands(&provider, task.as_deref()).await
}

/// Entries of `task`'s conversation, or of its subagent `subagent`'s.
#[command(trust = always)]
pub fn agent_entries(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
    host.project(window)?.agents.entries(&task, subagent)
}

/// Sessions of the project on this machine that no task holds yet, newest first.
#[command(trust = trusted)]
pub async fn agent_external_sessions(host: &Host, window: &str) -> IdeResult<Vec<ExternalSession>> {
    // Reads transcripts from disk on the blocking pool.
    let agents = host.project(window)?.agents.clone();
    tokio::task::spawn_blocking(move || agents.external_sessions()).await.map_err(join_err)
}

/// Imports an external session as a task: its first turn loads and replays it.
#[command(trust = trusted)]
pub async fn agent_import_session(
    host: &Host,
    window: &str,
    provider: String,
    session_id: String,
) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    let agents = host.project(window)?.agents.clone();
    tokio::task::spawn_blocking(move || agents.import_session(&provider, &session_id)).await.map_err(join_err)?
}

#[command(trust = trusted)]
pub async fn agent_create(host: &Host, window: &str, request: NewAgentTask) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    let mut request = request;
    let project = host.project(window)?;
    let root = project.root.clone();
    let requested = request.project_root.take();
    request.project_root = Some(IpcPath(
        host.blocking(move || validate_project_root(&root, requested.as_ref().map(|p| p.0.as_path()))).await?,
    ));
    project.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
#[command(trust = trusted)]
pub async fn agent_prompt(host: &Host, window: &str, task: String, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.prompt(&task, prompt, now).await
}

/// Runs a `!` line of the composer in the task's folder with the user's shell, without
/// starting a turn; its output goes to the agent with the next message.
#[command(trust = trusted)]
pub async fn agent_shell(
    host: &Host,
    window: &str,
    task: String,
    command: String,
    request: RequestId,
) -> IdeResult<()> {
    host.require_trust(window)?;
    let agents = host.project(window)?.agents.clone();
    let cancel = host.begin_request(request);
    let result = agents.run_shell(&task, &command, cancel).await;
    host.end_request(request);
    result
}

/// Answers a non-blocking question, without cancelling the current turn.
#[command(trust = trusted)]
pub async fn agent_answer_question(
    host: &Host,
    window: &str,
    task: String,
    question: String,
    answer: Option<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.answer_question(&task, &question, answer).await
}

/// Drops a queued message and returns it (to edit it).
#[command(trust = always)]
pub fn agent_unqueue(host: &Host, window: &str, task: String, queued: String) -> IdeResult<AgentQueued> {
    host.project(window)?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
#[command(trust = trusted)]
pub async fn agent_send_queued_now(host: &Host, window: &str, task: String, queued: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.send_queued_now(&task, &queued).await
}

/// Changes a session setting (model, mode, thinking effort…).
#[command(trust = trusted)]
pub async fn agent_set_config(host: &Host, window: &str, task: String, option: String, value: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_config(&task, &option, value).await
}

/// Copies the task's conversation into a new task, up to its first `turns` turns (all when `None`).
#[command(trust = trusted)]
pub async fn agent_fork(host: &Host, window: &str, task: String, turns: Option<u32>) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    host.project(window)?.agents.fork(&task, turns).await
}

/// Drops the task's turns after its first `turns`; returns the message of the first dropped one.
#[command(trust = trusted)]
pub async fn agent_rollback(host: &Host, window: &str, task: String, turns: u32) -> IdeResult<Option<AgentPrompt>> {
    host.require_trust(window)?;
    host.project(window)?.agents.rollback(&task, turns).await
}

/// Checks the selected installation without modifying it.
#[command(trust = trusted)]
pub async fn agent_cli_update_check(
    host: &Host,
    window: &str,
    provider: String,
    request: RequestId,
) -> IdeResult<AgentCliUpdateResult> {
    cli_update(host, window, provider, None, request).await
}

/// Installs the exact version offered if the selected installation still matches.
#[command(trust = trusted)]
pub async fn agent_cli_update(
    host: &Host,
    window: &str,
    provider: String,
    offer: AgentCliOffer,
    request: RequestId,
) -> IdeResult<AgentCliUpdateResult> {
    cli_update(host, window, provider, Some(offer), request).await
}

async fn cli_update(
    host: &Host,
    window: &str,
    provider: String,
    offer: Option<AgentCliOffer>,
    request: RequestId,
) -> IdeResult<AgentCliUpdateResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let installing = offer.as_ref().map(|_| Installing::begin(&provider)).transpose()?;
    let cancel = host.begin_project_request(window, request);
    let result = tokio::task::spawn_blocking(move || {
        let _installing = installing;
        project.agents.cli_update(&provider, offer.as_ref(), &cancel)
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// What the agent reports about itself when it starts (no session: no MCP servers, hooks
/// or sign-in run). Remembered until `refresh`.
#[command(trust = trusted)]
pub async fn agent_probe(host: &Host, window: &str, provider: String, refresh: bool) -> IdeResult<AgentProbe> {
    host.require_trust(window)?;
    host.project(window)?.agents.probe(&provider, refresh).await
}

/// Reads the running session's context categories without sending a prompt.
#[command(trust = trusted)]
pub async fn agent_context_usage(host: &Host, window: &str, task: String) -> IdeResult<AgentContextUsage> {
    host.require_trust(window)?;
    host.project(window)?.agents.context_usage(&task).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
#[command(trust = always)]
pub fn agent_cancel(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<()> {
    host.project(window)?.agents.cancel(&task, subagent)
}

/// Stops one of the task's background tasks.
#[command(trust = always)]
pub async fn agent_stop_background(host: &Host, window: &str, task: String, background: String) -> IdeResult<()> {
    host.project(window)?.agents.stop_background(&task, &background).await
}

/// Answers a permission request; `option: null` cancels it.
#[command(trust = trusted)]
pub fn agent_respond(
    host: &Host,
    window: &str,
    task: String,
    permission: u32,
    option: Option<String>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.respond(&task, permission, option)
}

#[command(trust = always)]
pub fn agent_archive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.archive(&task)
}

#[command(trust = always)]
pub fn agent_unarchive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.unarchive(&task)
}

#[command(trust = trusted)]
pub fn agent_rename(host: &Host, window: &str, task: String, title: String) -> IdeResult<()> {
    host.project(window)?.agents.rename(&task, &title)
}

#[command(trust = trusted)]
pub async fn agent_delete(host: &Host, window: &str, task: String, remove_worktree: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.delete(&task, remove_worktree).await
}

/// The task's changed files as `view` compares them (without: since it started).
#[command(trust = trusted)]
pub async fn agent_changes(
    host: &Host,
    window: &str,
    task: String,
    view: Option<AgentChangesView>,
) -> IdeResult<Vec<AgentChange>> {
    host.require_trust(window)?;
    let agents = &host.project(window)?.agents;
    match view.unwrap_or_default() {
        AgentChangesView::SinceStart => agents.changes(&task).await,
        AgentChangesView::Group => Ok(agents.grouped_changes(&task).await?.uncommitted),
        AgentChangesView::LastTurn => agents.turn_changes(&task).await,
    }
}

/// The task's uncommitted changes and the commits made since it started.
#[command(trust = trusted)]
pub async fn agent_grouped_changes(host: &Host, window: &str, task: String) -> IdeResult<AgentChanges> {
    host.require_trust(window)?;
    host.project(window)?.agents.grouped_changes(&task).await
}

/// Content of `path` as `view` compares it (without: when the task started), the left side of its diff.
#[command(trust = trusted)]
pub async fn agent_base_text(
    host: &Host,
    window: &str,
    task: String,
    path: IpcPath,
    view: Option<AgentChangesView>,
) -> IdeResult<Option<String>> {
    host.require_trust(window)?;
    host.project(window)?.agents.base_text(&task, path.into_path_buf(), view.unwrap_or_default()).await
}

/// Rollback: the task's changed files among `paths` (all without) back as `view` compares them.
#[command(trust = trusted)]
pub async fn agent_rollback_changes(
    host: &Host,
    window: &str,
    task: String,
    paths: Option<Vec<String>>,
    view: Option<AgentChangesView>,
) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.rollback_changes(&task, paths, view.unwrap_or_default()).await
}

/// Accept: copies a worktree task's changed files among `paths` (all without) into the
/// local checkout, uncommitted; files the checkout changed itself are left alone and reported.
#[command(trust = trusted)]
pub async fn agent_accept_changes(
    host: &Host,
    window: &str,
    task: String,
    paths: Option<Vec<String>>,
) -> IdeResult<AgentAcceptOutcome> {
    host.require_trust(window)?;
    host.project(window)?.agents.accept_changes(&task, paths).await
}

type McpServerMap = std::collections::BTreeMap<String, ide_core::settings::AgentMcpServer>;

/// Where the values of the user's MCP servers are kept in [`AgentSecrets`]. A project's own
/// servers keep their values in the project's file, where the project shares them.
const USER_MCP_VALUES: &str = "mcp/user/";

/// Every environment variable and header value of `map`, by its key in [`AgentSecrets`].
fn mcp_values(map: &mut McpServerMap) -> Vec<(String, &mut String)> {
    let part = |s: &str| s.replace('%', "%25").replace('/', "%2F");
    let mut values = Vec::new();
    for (server, cfg) in map.iter_mut() {
        for (kind, entries) in [("env", &mut cfg.env), ("header", &mut cfg.headers)] {
            for (name, value) in entries.iter_mut() {
                values.push((format!("{USER_MCP_VALUES}{}/{kind}/{}", part(server), part(name)), value));
            }
        }
    }
    values
}

fn has_mcp_values(map: &McpServerMap) -> bool {
    map.values().any(|s| s.env.values().chain(s.headers.values()).any(|v| !v.is_empty()))
}

/// Fills in the saved values. A value written in the settings file wins: an empty one stands for the saved one.
fn fill_mcp_values(secrets: &AgentSecrets, map: &mut McpServerMap) {
    for (key, value) in mcp_values(map) {
        if value.is_empty()
            && let Some(saved) = secrets.get(&key)
        {
            *value = saved;
        }
    }
}

/// Saves the values of `map` and empties them in it; values of servers and names no
/// longer in it are forgotten.
fn take_mcp_values(secrets: &AgentSecrets, map: &mut McpServerMap) -> IdeResult<Kept> {
    let mut kept = Kept::Store;
    let mut current = HashSet::new();
    for (key, value) in mcp_values(map) {
        if value.is_empty() {
            secrets.delete(&key);
        } else if secrets.get(&key).as_deref() != Some(value.as_str()) && secrets.set(&key, value)? == Kept::LocalFile {
            kept = Kept::LocalFile;
        }
        value.clear();
        current.insert(key);
    }
    for key in secrets.keys(USER_MCP_VALUES) {
        if !current.contains(&key) {
            secrets.delete(&key);
        }
    }
    Ok(kept)
}

/// Values written into the user settings (by hand, by an older version, by an import) move to [`AgentSecrets`].
pub fn move_user_mcp_values(host: &Host) {
    let mut user = host.global_settings.effective().agents.mcp_servers;
    if !has_mcp_values(&user) {
        return;
    }
    fill_mcp_values(&host.agent_secrets, &mut user);
    if let Err(e) = persist_mcp_map(host, None, McpScope::User, &user) {
        tracing::warn!("MCP servers: could not move values out of the user settings: {}", e.message);
    }
}

fn mcp_maps(host: &Host, window: &str) -> (McpServerMap, McpServerMap, Option<std::sync::Arc<crate::Project>>) {
    move_user_mcp_values(host);
    let mut user = host.global_settings.effective().agents.mcp_servers;
    fill_mcp_values(&host.agent_secrets, &mut user);
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
    let mut map = map.clone();
    let kept = match scope {
        McpScope::User => take_mcp_values(&host.agent_secrets, &mut map)?,
        McpScope::Workspace => Kept::Store,
    };
    let value = if map.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::to_value(&map).map_err(|e| IdeError::invalid(e.to_string()))?
    };
    let event = IdeEvent::SettingsChanged { key: "agents.mcpServers".into() };
    match scope {
        McpScope::User => {
            host.global_settings.set(ide_workspace::settings::SettingsScope::Global, "agents.mcpServers", value)?;
            for p in host.projects() {
                p.settings.reload();
                p.agents.notify_mcp_servers_changed();
                p.sink.emit(event.clone());
                if kept == Kept::LocalFile {
                    host.agent_secrets.notify_kept_locally(&p.sink);
                }
            }
        }
        McpScope::Workspace => {
            let p = project.ok_or_else(|| IdeError::invalid("Open a project to configure workspace MCP servers"))?;
            p.settings.set(ide_workspace::settings::SettingsScope::Project, "agents.mcpServers", value)?;
            p.agents.notify_mcp_servers_changed();
            p.sink.emit(event);
        }
    }
    Ok(())
}

fn update_mcp_maps<F>(host: &Host, window: &str, approve: &[String], f: F) -> IdeResult<Vec<McpServer>>
where
    F: FnOnce(&mut McpServerMap, &mut McpServerMap, Option<&std::path::Path>) -> Result<Vec<String>, String>,
{
    let (mut user, mut workspace, project) = mcp_maps(host, window);
    let prev_user = user.clone();
    let prev_workspace = workspace.clone();
    let project_root = project.as_ref().map(|p| p.root.as_path());
    let extra_approved = f(&mut user, &mut workspace, project_root).map_err(IdeError::invalid)?;
    if let Some(p) = &project {
        for name in approve.iter().chain(extra_approved.iter()) {
            if let Some(server) = workspace.get(name.as_str()) {
                host.mcp_approvals.approve(&p.root, name, server)?;
            }
        }
    }
    if workspace != prev_workspace {
        persist_mcp_map(host, project.as_ref(), McpScope::Workspace, &workspace)?;
    }
    if user != prev_user {
        persist_mcp_map(host, project.as_ref(), McpScope::User, &user)?;
    }
    Ok(listed(host, project.as_ref(), &user, workspace))
}

/// Workspace servers the user hasn't turned on in Settings are listed as off: agents don't start them.
fn listed(
    host: &Host,
    project: Option<&std::sync::Arc<crate::Project>>,
    user: &McpServerMap,
    workspace: McpServerMap,
) -> Vec<McpServer> {
    let raw_workspace = workspace.clone();
    let workspace = match project {
        Some(p) => host.mcp_approvals.apply(&p.root, workspace),
        None => workspace,
    };
    let mut out = ide_agent::mcp::servers_from_settings(user, &workspace);
    if let Some(p) = project {
        for srv in &mut out {
            if srv.scope == McpScope::Workspace
                && let Some(raw) = raw_workspace.get(&srv.name)
            {
                srv.unapproved = !host.mcp_approvals.approved(&p.root, &srv.name, raw);
            }
        }
    }
    out
}

/// The MCP servers agent sessions of the project at `root` get: the user's, values filled in, and
/// the project's the user turned on.
pub(crate) fn session_mcp_servers(
    settings: &ide_workspace::SettingsStore,
    approvals: &crate::trust::McpServerApprovals,
    secrets: &AgentSecrets,
    root: &std::path::Path,
) -> Vec<McpServer> {
    use ide_workspace::settings::SettingsScope;
    let mut user = settings.layer(SettingsScope::Global).agents.mcp_servers;
    fill_mcp_values(secrets, &mut user);
    let raw_workspace = settings.layer(SettingsScope::Project).agents.mcp_servers;
    let workspace = approvals.apply(root, raw_workspace.clone());
    let mut out = ide_agent::mcp::servers_from_settings(&user, &workspace);
    for srv in &mut out {
        if srv.scope == McpScope::Workspace
            && let Some(raw) = raw_workspace.get(&srv.name)
        {
            srv.unapproved = !approvals.approved(root, &srv.name, raw);
        }
    }
    out
}

/// Lists configured and discovered MCP servers across User, Workspace, Plugin, and Built-In scopes.
#[command(trust = always)]
pub fn agent_mcp_list(host: &Host, window: &str) -> IdeResult<Vec<McpServer>> {
    // Configured servers of the User (`settings.toml`) and Workspace (`.openidea/settings.toml`) scopes.
    let (user, workspace, project) = mcp_maps(host, window);
    Ok(listed(host, project.as_ref(), &user, workspace))
}

/// Creates or updates a User or Workspace MCP server and returns the updated list.
#[command(trust = always)]
pub fn agent_mcp_save(host: &Host, window: &str, input: McpServerInput) -> IdeResult<Vec<McpServer>> {
    // A Workspace server saved here is one the user turned on.
    let approve: Vec<String> =
        (input.scope == McpScope::Workspace).then(|| input.name.trim().to_owned()).into_iter().collect();
    update_mcp_maps(host, window, &approve, |user, workspace, project_root| {
        ide_agent::mcp::apply_save(user, workspace, project_root.is_some(), input).map(|()| Vec::new())
    })
}

/// Parses and saves one or more MCP servers from a pasted JSON snippet (`{"mcpServers": {...}}` or
/// single server object).
#[command(trust = always)]
pub fn agent_mcp_save_json(
    host: &Host,
    window: &str,
    scope: McpScope,
    raw_json: String,
    fallback_name: Option<String>,
    agents: Vec<String>,
) -> IdeResult<Vec<McpServer>> {
    // Workspace servers explicitly saved here by the user are approved.
    update_mcp_maps(host, window, &[], |user, workspace, project_root| {
        let saved = ide_agent::mcp::apply_save_json(
            user,
            workspace,
            project_root.is_some(),
            scope,
            &raw_json,
            fallback_name.as_deref(),
            agents,
        )?;
        Ok(if scope == McpScope::Workspace { saved } else { Vec::new() })
    })
}

/// Enables or disables an MCP server and returns the updated list.
#[command(trust = always)]
pub fn agent_mcp_set_enabled(host: &Host, window: &str, id: String, enabled: bool) -> IdeResult<Vec<McpServer>> {
    let approve: Vec<String> = ide_agent::mcp::parse_server_id(&id)
        .filter(|(scope, _)| enabled && *scope == McpScope::Workspace)
        .map(|(_, name)| name.to_owned())
        .into_iter()
        .collect();
    update_mcp_maps(host, window, &approve, |user, workspace, _| {
        ide_agent::mcp::apply_set_enabled(user, workspace, &id, enabled).map(|_| Vec::new())
    })
}

/// Removes a User or Workspace MCP server and returns the updated list.
#[command(trust = always)]
pub fn agent_mcp_remove(host: &Host, window: &str, id: String) -> IdeResult<Vec<McpServer>> {
    update_mcp_maps(host, window, &[], |user, workspace, _| {
        ide_agent::mcp::apply_remove(user, workspace, &id).map(|_| Vec::new())
    })
}

/// Copies MCP servers from `.mcp.json` and `.vscode/mcp.json` into the workspace settings once.
#[command(trust = always)]
pub fn agent_mcp_import(host: &Host, window: &str) -> IdeResult<Vec<McpServer>> {
    // They stay off until the user turns them on.
    update_mcp_maps(host, window, &[], |_, workspace, project_root| {
        let root = project_root.ok_or_else(|| "Open a project to import workspace MCP servers".to_string())?;
        ide_agent::mcp::apply_import(workspace, root);
        Ok(Vec::new())
    })
}

/// Discovers external MCP configuration files on disk (CLI user configs + workspace `.mcp.json`).
#[command(trust = always)]
pub async fn agent_mcp_discover_sources(host: &Host, window: &str) -> IdeResult<Vec<McpExternalSource>> {
    let project_root = host.project(window).ok().filter(|p| !p.light).map(|p| p.root.clone());
    let home = dirs::home_dir();
    tokio::task::spawn_blocking(move || {
        ide_agent::mcp::discover_external_sources(home.as_deref(), project_root.as_deref())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))
}

/// Imports selected servers from discovered external MCP configuration files into User or Workspace scope.
#[command(trust = always)]
pub async fn agent_mcp_import_selected(
    host: &Host,
    window: &str,
    scope: McpScope,
    selections: Vec<McpImportSelection>,
    overwrite: bool,
) -> IdeResult<Vec<McpServer>> {
    // Imported Workspace entries remain unapproved (disabled) until the user explicitly enables them.
    let home = dirs::home_dir();
    update_mcp_maps(host, window, &[], move |user, workspace, project_root| {
        ide_agent::mcp::apply_import_selected(
            user,
            workspace,
            home.as_deref(),
            project_root,
            scope,
            &selections,
            overwrite,
        )?;
        Ok(Vec::new())
    })
}

/// Tests an MCP server by connecting (`initialize`) and listing its tools (`tools/list`).
#[command(trust = trusted)]
pub async fn agent_mcp_test(host: &Host, window: &str, id: String) -> IdeResult<McpProbeResult> {
    host.require_trust(window)?;
    let (user, workspace, project) = mcp_maps(host, window);
    let (scope, name) = ide_agent::mcp::parse_server_id(&id)
        .ok_or_else(|| IdeError::not_found(format!("MCP server `{id}` not found")))?;
    let server = match scope {
        McpScope::User => user.get(name),
        McpScope::Workspace => workspace.get(name),
    }
    .cloned()
    .ok_or_else(|| IdeError::not_found(format!("MCP server `{name}` not found")))?;
    if scope == McpScope::Workspace {
        let p = project.as_ref().ok_or_else(|| IdeError::invalid("Open a project to test workspace MCP servers"))?;
        if !host.mcp_approvals.approved(&p.root, name, &server) {
            return Err(IdeError::invalid("Enable this workspace MCP server first before testing it"));
        }
    }
    let cwd = project.as_ref().map(|p| p.root.clone()).or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir);
    match server.transport {
        McpTransport::Stdio => Ok(ide_agent::mcp::probe_stdio_server(&server, &cwd).await),
        McpTransport::Http | McpTransport::Sse => Ok(probe_http_mcp_server(&server).await),
    }
}

async fn probe_http_mcp_server(server: &ide_core::settings::AgentMcpServer) -> McpProbeResult {
    let started = std::time::Instant::now();
    let elapsed_ms = || u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let Some(url) = server.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) else {
        return McpProbeResult {
            ok: false,
            server_name: None,
            server_version: None,
            protocol_version: None,
            tools: Vec::new(),
            duration_ms: elapsed_ms(),
            error: Some("URL is empty".into()),
        };
    };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json, text/event-stream"),
    );
    for (k, v) in &server.headers {
        if let (Ok(name), Ok(val)) =
            (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v))
        {
            headers.insert(name, val);
        }
    }
    let client =
        match reqwest::Client::builder().default_headers(headers).timeout(std::time::Duration::from_secs(12)).build() {
            Ok(c) => c,
            Err(e) => {
                return McpProbeResult {
                    ok: false,
                    server_name: None,
                    server_version: None,
                    protocol_version: None,
                    tools: Vec::new(),
                    duration_ms: elapsed_ms(),
                    error: Some(format!("HTTP client error: {e}")),
                };
            }
        };

    let post_rpc = |session_id: Option<String>, body: serde_json::Value| {
        let client = client.clone();
        let url = url.to_owned();
        async move {
            let mut req =
                client.post(&url).header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
            if let Some(sid) = session_id.as_deref() {
                req = req.header("Mcp-Session-Id", sid);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("Request to `{url}` failed: {}", ide_http::client::describe(&e.without_url())))?;
            let status = resp.status();
            let next_session =
                resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned).or(session_id);
            let text = resp.text().await.map_err(|e| format!("Failed reading response: {e}"))?;
            if !status.is_success() {
                let detail = text.trim();
                let msg = if detail.is_empty() {
                    format!("HTTP {status}")
                } else {
                    format!("HTTP {status}: {}", detail.chars().take(240).collect::<String>())
                };
                return Err(msg);
            }
            Ok((next_session, parse_mcp_http_response(&text)?))
        }
    };

    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
        }
    });

    let (session_id, init_res) = match post_rpc(None, init_req).await {
        Ok(v) => v,
        Err(err) => {
            return McpProbeResult {
                ok: false,
                server_name: None,
                server_version: None,
                protocol_version: None,
                tools: Vec::new(),
                duration_ms: elapsed_ms(),
                error: Some(err),
            };
        }
    };

    // Best-effort `notifications/initialized` + `tools/list`.
    let mut not_req = client.post(url).header(reqwest::header::CONTENT_TYPE, "application/json").body(
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        })
        .to_string(),
    );
    if let Some(sid) = session_id.as_deref() {
        not_req = not_req.header("Mcp-Session-Id", sid);
    }
    let _ = not_req.send().await;

    let tools_res = post_rpc(
        session_id,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        }),
    )
    .await
    .map(|(_, v)| v)
    .unwrap_or_else(|_| serde_json::json!({}));

    ide_agent::mcp::parse_probe_payloads(&init_res, &tools_res, elapsed_ms())
}

fn parse_mcp_http_response(body: &str) -> Result<serde_json::Value, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(err) = msg.get("error") {
            let em = err.get("message").and_then(serde_json::Value::as_str).unwrap_or("JSON-RPC error");
            return Err(em.to_owned());
        }
        return Ok(msg.get("result").cloned().unwrap_or(msg));
    }
    // Streamable HTTP SSE frames (`data: {...}`).
    for line in trimmed.lines() {
        if let Some(rest) = line.strip_prefix("data:")
            && let Ok(msg) = serde_json::from_str::<serde_json::Value>(rest.trim())
            && (msg.get("result").is_some() || msg.get("error").is_some())
        {
            if let Some(err) = msg.get("error") {
                let em = err.get("message").and_then(serde_json::Value::as_str).unwrap_or("JSON-RPC error");
                return Err(em.to_owned());
            }
            return Ok(msg.get("result").cloned().unwrap_or(msg));
        }
    }
    Err("Unexpected non-JSON MCP response".into())
}

/// Updates per-session MCP server enable/disable overrides on `task`.
#[command(trust = always)]
pub fn agent_set_mcp_overrides(
    host: &Host,
    window: &str,
    task: String,
    overrides: std::collections::BTreeMap<String, bool>,
) -> IdeResult<AgentTask> {
    host.project(window)?.agents.set_mcp_overrides(&task, overrides)
}

/// Updates per-session skill modes on `task`.
#[command(trust = always)]
pub fn agent_set_skill_overrides(
    host: &Host,
    window: &str,
    task: String,
    overrides: std::collections::BTreeMap<String, AgentSkillMode>,
) -> IdeResult<AgentTask> {
    host.project(window)?.agents.set_skill_overrides(&task, overrides)
}

/// Every skill discovered in the project and the user's folders, with the mode a session
/// of this project runs it with (without any session's own overrides).
#[command(trust = always)]
pub async fn agent_skills_list(host: &Host, window: &str) -> IdeResult<Vec<AgentSkillState>> {
    let project = host.project(window)?;
    let (policy, home) = (skills_policy(&project), dirs::home_dir());
    tokio::task::spawn_blocking(move || {
        Ok(ide_agent::skills::resolve(
            ide_agent::skills::discover_skills_in(&policy.workspace_roots, home.as_deref()),
            None,
            &policy.workspace,
            &policy.user,
            policy.workspace_trusted,
        ))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Sets how `name` may run in `scope`, in the settings file of that scope, and returns the
/// updated list. `SKILL.md` files are never touched; the default `auto` removes the entry.
#[command(trust = always)]
pub fn agent_skills_set_mode(
    host: &Host,
    window: &str,
    name: String,
    scope: McpScope,
    mode: AgentSkillMode,
) -> IdeResult<Vec<AgentSkillState>> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(IdeError::invalid("a skill needs a name"));
    }
    let project = host.project(window).ok().filter(|p| !p.light);
    let (mut user, mut workspace) = skills_maps(host, project.as_ref());
    match scope {
        McpScope::User => {
            let changed = if mode == AgentSkillMode::Auto {
                user.remove(&name).is_some()
            } else {
                user.insert(name, AgentSkillPolicy { mode }).map(|p| p.mode) != Some(mode)
            };
            if changed {
                persist_skills_map(host, None, scope, &user)?;
            }
        }
        McpScope::Workspace => {
            let map =
                workspace.as_mut().ok_or_else(|| IdeError::invalid("Open a project to configure workspace skills"))?;
            let changed = if mode == AgentSkillMode::Auto {
                map.remove(&name).is_some()
            } else {
                map.insert(name, AgentSkillPolicy { mode }).map(|p| p.mode) != Some(mode)
            };
            if changed {
                let map = map.clone();
                persist_skills_map(host, project.as_ref(), scope, &map)?;
            }
        }
    }
    match project {
        Some(project) => {
            let policy = skills_policy(&project);
            let home = dirs::home_dir();
            Ok(ide_agent::skills::resolve(
                ide_agent::skills::discover_skills_in(&policy.workspace_roots, home.as_deref()),
                None,
                &policy.workspace,
                &policy.user,
                policy.workspace_trusted,
            ))
        }
        None => Ok(Vec::new()),
    }
}

/// The user's and the workspace's skill policies (`[agents.skills.<name>]`).
fn skills_maps(
    host: &Host,
    project: Option<&std::sync::Arc<crate::Project>>,
) -> (std::collections::BTreeMap<String, AgentSkillPolicy>, Option<std::collections::BTreeMap<String, AgentSkillPolicy>>)
{
    let user = host.global_settings.effective().agents.skills.clone();
    let workspace =
        project.map(|p| p.settings.layer(ide_workspace::settings::SettingsScope::Project).agents.skills.clone());
    (user, workspace)
}

/// Saves `map` into its scope's settings and tells the windows.
fn persist_skills_map(
    host: &Host,
    project: Option<&std::sync::Arc<crate::Project>>,
    scope: McpScope,
    map: &std::collections::BTreeMap<String, AgentSkillPolicy>,
) -> IdeResult<()> {
    let value = if map.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::to_value(map).map_err(|e| IdeError::invalid(e.to_string()))?
    };
    let event = IdeEvent::SettingsChanged { key: "agents.skills".into() };
    match scope {
        McpScope::User => {
            host.global_settings.set(ide_workspace::settings::SettingsScope::Global, "agents.skills", value)?;
            for p in host.projects() {
                p.settings.reload();
                p.agents.notify_mcp_servers_changed();
                p.sink.emit(event.clone());
            }
        }
        McpScope::Workspace => {
            let p = project.ok_or_else(|| IdeError::invalid("Open a project to configure workspace skills"))?;
            p.settings.set(ide_workspace::settings::SettingsScope::Project, "agents.skills", value)?;
            p.agents.notify_mcp_servers_changed();
            p.sink.emit(event);
        }
    }
    Ok(())
}

/// Workspace folders to scan for skills: the project root plus any multi-repo workspace members.
pub(crate) fn workspace_skill_roots(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut roots = vec![root.to_path_buf()];
    if let Ok(Some(ws)) = ide_workspace::workspace::Workspace::load(root) {
        for member in ws.projects {
            if member.exists() && !roots.contains(&member) {
                roots.push(member);
            }
        }
    }
    roots
}

/// The skill policies a session of `project` resolves against.
fn skills_policy(project: &crate::Project) -> SkillsPolicy {
    SkillsPolicy {
        user: project.settings.layer(ide_workspace::settings::SettingsScope::Global).agents.skills.clone(),
        workspace: project.settings.layer(ide_workspace::settings::SettingsScope::Project).agents.skills.clone(),
        workspace_trusted: project.trusted.load(std::sync::atomic::Ordering::Acquire),
        workspace_roots: workspace_skill_roots(&project.root),
    }
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

    #[test]
    fn sessions_get_the_users_servers_and_the_projects_turned_on_ones() {
        ide_ssh::secrets::testing::use_memory_store();
        let tmp = tempfile::tempdir().unwrap();
        let (config, root) = (tmp.path().join("config"), tmp.path().join("project"));
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(root.join(".openidea")).unwrap();
        std::fs::write(config.join("settings.toml"), "[agents.mcpServers.shared]\ncommand = \"user-cmd\"\n").unwrap();
        std::fs::write(
            root.join(".openidea/settings.toml"),
            "[agents.mcpServers.shared]\ncommand = \"project-cmd\"\n\n[agents.mcpServers.extra]\ncommand = \"extra\"\n",
        )
        .unwrap();
        let settings = ide_workspace::SettingsStore::load(&config, Some(&root));
        let approvals = crate::trust::McpServerApprovals::load(&tmp.path().join("data"));
        let secrets = AgentSecrets::new(&tmp.path().join("data"));
        let on = |servers: Vec<McpServer>| -> Vec<(McpScope, String, String)> {
            servers
                .into_iter()
                .filter(|s| s.enabled)
                .map(|s| (s.scope, s.name, s.command.unwrap_or_default()))
                .collect()
        };
        assert_eq!(
            on(session_mcp_servers(&settings, &approvals, &secrets, &root)),
            [(McpScope::User, "shared".to_owned(), "user-cmd".to_owned())]
        );

        // A user server's saved values reach the session; the file keeps only the names.
        std::fs::write(
            config.join("settings.toml"),
            "[agents.mcpServers.keyed]\ncommand = \"k\"\nenv = { TOKEN = \"\" }\n",
        )
        .unwrap();
        secrets.set("mcp/user/keyed/env/TOKEN", "saved-user").unwrap();
        settings.reload();
        let keyed = session_mcp_servers(&settings, &approvals, &secrets, &root);
        let keyed = keyed.iter().find(|s| s.name == "keyed").unwrap();
        assert_eq!(keyed.env[0].value, "saved-user");
        std::fs::write(config.join("settings.toml"), "[agents.mcpServers.shared]\ncommand = \"user-cmd\"\n").unwrap();
        settings.reload();

        let extra = settings.layer(ide_workspace::settings::SettingsScope::Project).agents.mcp_servers["extra"].clone();
        approvals.approve(&root, "extra", &extra).unwrap();
        assert!(on(session_mcp_servers(&settings, &approvals, &secrets, &root)).contains(&(
            McpScope::Workspace,
            "extra".to_owned(),
            "extra".to_owned()
        )));
        // Remembered across restarts, and only for this project.
        let reloaded = crate::trust::McpServerApprovals::load(&tmp.path().join("data"));
        assert!(reloaded.approved(&root, "extra", &extra));
        assert!(!reloaded.approved(&tmp.path().join("other"), "extra", &extra));
    }
}

ide_command::domain!(
    agent:
    agent_accept_changes,
    agent_answer_question,
    agent_archive,
    agent_base_text,
    agent_cancel,
    agent_context_usage,
    agent_changes,
    agent_cli_update,
    agent_cli_update_check,
    agent_commands,
    agent_create,
    agent_delete,
    agent_entries,
    agent_external_sessions,
    agent_fork,
    agent_grouped_changes,
    agent_hermes_profiles,
    agent_import_session,
    agent_mcp_discover_sources,
    agent_mcp_import,
    agent_mcp_import_selected,
    agent_mcp_list,
    agent_mcp_remove,
    agent_mcp_save,
    agent_mcp_save_json,
    agent_mcp_set_enabled,
    agent_mcp_test,
    agent_probe,
    agent_prompt,
    agent_providers,
    agent_refresh_models,
    agent_registry_install,
    agent_registry_list,
    agent_registry_remove,
    agent_rename,
    agent_respond,
    agent_rollback,
    agent_rollback_changes,
    agent_send_queued_now,
    agent_set_command,
    agent_shell,
    agent_set_config,
    agent_set_env,
    agent_set_mcp_overrides,
    agent_set_skill_overrides,
    agent_skills_list,
    agent_skills_set_mode,
    agent_stop_background,
    agent_subscribe,
    agent_unarchive,
    agent_unqueue,
    agent_unsubscribe,
);
