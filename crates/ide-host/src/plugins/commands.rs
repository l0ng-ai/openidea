//! Plugin window commands shared by local IPC and remote RPC.

use super::{
    ClipboardAnswer, CommandAnswer, CommitAnswer, DecorationSet, EventKind, PluginContextKey, PluginEditor, PluginHost,
    PluginInfo, PluginStatusItem, WorkbenchEvent,
};
use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_plugin::Invocation;
use ide_workspace::settings::SettingsScope;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Runs a plugin command in the context of this window's project and focused editor.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn plugin_run_command(
    host: &Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    command_id: String,
    arg: Option<String>,
    editor: Option<PluginEditor>,
    paths: Option<Vec<PathBuf>>,
    settings_scope: Option<SettingsScope>,
    command_chain: Option<Vec<String>>,
    request: Option<RequestId>,
) -> IdeResult<Option<String>> {
    let plugins = plugins.clone();
    let invocation = Invocation {
        command_chain: command_chain.unwrap_or_default(),
        client: Some(window.to_owned()),
        workspace_root: host.project(window).ok().map(|p| p.root.clone()),
        editor: editor.map(PluginEditor::context),
        selected_paths: paths.unwrap_or_default(),
        global_settings: matches!(settings_scope, Some(SettingsScope::Global)),
    };
    let cancel = request.map(|id| host.begin_project_read_request(window, id));
    let result = host
        .blocking(move || {
            plugins.run_command_with_cancel(&plugin_id, &command_id, arg.as_deref(), invocation, cancel.as_ref())
        })
        .await;
    if let Some(request) = request {
        host.end_request(request);
    }
    result
}

/// The UI language (BCP 47) that plugin code reads with `ui.locale()`.
#[command(trust = always)]
pub async fn plugin_set_ui_locale(plugins: &Arc<PluginHost>, tag: String) -> IdeResult<()> {
    plugins.set_ui_locale(&tag);
    Ok(())
}

/// Workbench events from this window (only the kinds of `plugin_event_kinds`).
#[command(trust = trusted)]
pub fn plugin_post_events(
    plugins: &Arc<PluginHost>,
    window: &str,
    events: Vec<WorkbenchEvent>,
    editor: Option<PluginEditor>,
) {
    plugins.post_window_events(window, events, editor);
}

/// Kinds of workbench events plugins want (re-fetch on `subscriptionsChanged`).
#[command(trust = trusted, desktop_body = async)]
pub async fn plugin_event_kinds(plugins: &Arc<PluginHost>) -> Vec<EventKind> {
    plugins.event_kinds().into_iter().collect()
}

/// Every plugin status bar item (later changes arrive as `statusItemChanged`).
#[command(trust = trusted)]
pub fn plugin_status_items(plugins: &Arc<PluginHost>, window: &str) -> Vec<PluginStatusItem> {
    plugins.status_snapshot(window)
}

/// Plugin context keys in effect for this window (later changes arrive as `contextChanged`).
#[command(trust = trusted)]
pub fn plugin_context_keys(plugins: &Arc<PluginHost>, window: &str) -> Vec<PluginContextKey> {
    plugins.context_keys(Some(window))
}

/// Cancels a plugin task (`taskStarted` with `cancellable`).
#[command(trust = trusted)]
pub fn plugin_cancel_task(plugins: &Arc<PluginHost>, task_id: String) -> bool {
    plugins.cancel_task(&task_id)
}

/// Reports the user's answer to a plugin's `promptRequested`: the chosen keys
/// (pick), `[text]` (input), anything (confirm: OK), or `None` when dismissed.
#[command(trust = trusted)]
pub fn plugin_answer_prompt(plugins: &Arc<PluginHost>, prompt_id: String, answer: Option<Vec<String>>) -> bool {
    plugins.answer_prompt(&prompt_id, answer)
}

/// A window's answer to a plugin's `commitRequested`; false when the call no
/// longer waits.
#[command(trust = trusted)]
pub fn plugin_answer_commit(plugins: &Arc<PluginHost>, request_id: String, answer: CommitAnswer) -> bool {
    plugins.answer_commit(&request_id, answer)
}

/// The UI reports the focused editor's file (`editor-focused` events), with its
/// caret so plugins can scope line labels without re-reading the document.
#[command(trust = always)]
pub fn plugin_set_active_file(
    plugins: &Arc<PluginHost>,
    window: &str,
    path: Option<String>,
    #[default] editor: Option<PluginEditor>,
) {
    plugins.set_active_file(window, path, editor);
}

/// The invoking window's reply to a plugin command request.
#[command(trust = trusted)]
pub fn plugin_answer_command(
    plugins: &Arc<PluginHost>,
    window: &str,
    request_id: String,
    answer: CommandAnswer,
) -> IdeResult<bool> {
    Ok(plugins.answer_command(window, &request_id, answer))
}

/// This window's clipboard for a plugin's `clipboardRequested`; false when the call no
/// longer waits or asked another window.
#[command(trust = trusted)]
pub fn plugin_answer_clipboard(
    plugins: &Arc<PluginHost>,
    window: &str,
    request_id: String,
    answer: ClipboardAnswer,
) -> IdeResult<bool> {
    Ok(plugins.answer_clipboard(window, &request_id, answer))
}

/// The project root a `scope` setting applies to (`None`: global).
fn scope_root(host: &Host, window: &str, scope: SettingsScope) -> IdeResult<Option<PathBuf>> {
    Ok(match scope {
        SettingsScope::Global => None,
        SettingsScope::Project => Some(host.project(window)?.root.clone()),
    })
}

/// Re-approves a plugin's executable, globally or for this window's project.
#[command(trust = outside_restricted)]
pub async fn plugin_choose_program(
    host: &Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    capability: String,
    scope: SettingsScope,
    path: Option<PathBuf>,
) -> IdeResult<PluginInfo> {
    let plugins = plugins.clone();
    let root = scope_root(host, window, scope)?;
    blocking(move || plugins.choose_program(&plugin_id, &capability, root.as_deref(), path.as_deref())).await
}

/// The currently approved executable in the selected scope, after revalidating its pin.
#[command(trust = outside_restricted)]
pub async fn plugin_program(
    host: &Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    program: String,
    scope: SettingsScope,
) -> IdeResult<ide_core::IpcPath> {
    let plugins = plugins.clone();
    let root = scope_root(host, window, scope)?;
    blocking(move || plugins.program_for_project(&plugin_id, &program, root.as_deref()).map(Into::into)).await
}

/// Project-scoped decoration snapshots; the window filters to its current root.
#[command(trust = trusted)]
pub fn plugin_decoration_sets(plugins: &Arc<PluginHost>) -> BTreeMap<String, Vec<DecorationSet>> {
    plugins.decoration_sets()
}

/// Every plugin's console highlight rules (later changes arrive as `consoleRulesChanged`).
#[command(trust = trusted)]
pub fn plugin_console_rules(plugins: &Arc<PluginHost>) -> BTreeMap<String, Vec<ide_plugin::ConsoleRule>> {
    plugins.console_rules()
}

/// Reports exactly one completion from the operation's launching window.
#[command(trust = trusted)]
pub fn plugin_finish_operation(
    plugins: &Arc<PluginHost>,
    window: &str,
    id: String,
    status: Option<i32>,
    stopped: bool,
) -> IdeResult<bool> {
    Ok(plugins.finish_operation(window, &id, status, stopped))
}

/// Dispatches a wasm content editor action through the owning plugin's event handler.
#[command(trust = trusted)]
pub fn plugin_content_tab_action(
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    action: ide_plugin::ContentTabAction,
) -> IdeResult<()> {
    plugins.content_tab_action(window, &plugin_id, action)
}

/// Selects test-tree paths in an owned plugin test configuration.
#[command(trust = trusted)]
pub async fn plugin_select_tests(
    plugins: &Arc<PluginHost>,
    window: &str,
    config: String,
    tests: Vec<Vec<String>>,
) -> IdeResult<Option<Vec<String>>> {
    let (plugins, client) = (plugins.clone(), window.to_owned());
    blocking(move || plugins.select_tests(&client, &config, tests)).await
}

/// Parses one batch of an owned test configuration's output.
#[command(trust = trusted)]
pub async fn plugin_parse_test_results(
    plugins: &Arc<PluginHost>,
    window: &str,
    config: String,
    chunk: String,
) -> IdeResult<Option<Vec<ide_plugin::PluginTestEvent>>> {
    let (plugins, client) = (plugins.clone(), window.to_owned());
    blocking(move || plugins.parse_test_results(&client, &config, chunk)).await
}

/// Starts only the pinned command recorded for this window's terminal operation.
#[command(trust = trusted)]
pub async fn plugin_terminal_session_spawn(
    host: &Arc<Host>,
    plugins: &Arc<PluginHost>,
    window: &str,
    operation: String,
    cols: u16,
    rows: u16,
    on_output: crate::ops::Channel<String>,
) -> IdeResult<ide_terminal::TerminalInfo> {
    let (plugins, host, window) = (plugins.clone(), host.clone(), window.to_owned());
    blocking(move || {
        plugins.spawn_terminal_session(
            &host,
            &window,
            &operation,
            cols,
            rows,
            Arc::new(move |chunk| {
                let _ = on_output.send(chunk);
            }),
        )
    })
    .await
}

/// Marks a keyed tab closed before ending its process.
#[command(trust = trusted)]
pub fn plugin_terminal_session_close(plugins: &Arc<PluginHost>, window: &str, operation: String) -> IdeResult<()> {
    plugins.close_terminal_session(window, &operation)
}

/// Revalidates a plugin run's executable before debugging, including reruns.
#[command(trust = trusted)]
pub async fn plugin_prepare_debug_run(
    plugins: &Arc<PluginHost>,
    window: &str,
    config: ide_run::RunConfig,
) -> IdeResult<ide_run::RunConfig> {
    let (plugins, client) = (plugins.clone(), window.to_owned());
    blocking(move || plugins.prepare_debug_run(&client, config)).await
}

/// Waits for the process an `attach-child` plugin configuration's debugger attaches to.
#[command(trust = trusted)]
pub async fn plugin_debug_attach_target(
    host: &Arc<Host>,
    plugins: &Arc<PluginHost>,
    window: &str,
    config: String,
    run: ide_core::RunId,
) -> IdeResult<ide_dap::attach::AttachableProcess> {
    let (plugins, host, client) = (plugins.clone(), host.clone(), window.to_owned());
    blocking(move || plugins.debug_attach_target(&host, &client, &config, run)).await
}

ide_command::domain!(
    plugins_commands:
    plugin_answer_clipboard,
    plugin_answer_command,
    plugin_answer_commit,
    plugin_answer_prompt,
    plugin_cancel_task,
    plugin_choose_program,
    plugin_console_rules,
    plugin_content_tab_action,
    plugin_context_keys,
    plugin_debug_attach_target,
    plugin_decoration_sets,
    plugin_event_kinds,
    plugin_finish_operation,
    plugin_parse_test_results,
    plugin_post_events,
    plugin_prepare_debug_run,
    plugin_program,
    plugin_run_command,
    plugin_select_tests,
    plugin_set_active_file,
    plugin_set_ui_locale,
    plugin_status_items,
    plugin_terminal_session_close,
    plugin_terminal_session_spawn,
);
