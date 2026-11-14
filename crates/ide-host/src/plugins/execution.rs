//! Window-owned plugin operations. Instance reclamation does not end them.
use super::api::{PluginApi, PromptEntry, Waiter};
use super::{CommandAnswer, EventQueue, PluginEvent, PluginHost, WindowRequest};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_plugin::{ContentTab, ContentTabReply, HostError, WorkbenchEvent};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(super) struct Operation {
    pub plugin: String,
    pub client: String,
    pub kind: OperationKind,
    pub root: Option<std::path::PathBuf>,
    pub started: bool,
    pub closed: bool,
    pub run: Option<ide_core::RunId>,
    pub terminal: Option<(std::sync::Weak<crate::Host>, ide_core::TerminalId)>,
}

pub(super) enum OperationKind {
    Run { config: String, configuration: String, program: String },
    Terminal { key: String, command: ide_plugin::ProcessCommand },
}

pub(super) fn label(value: &str, max: usize) -> Result<(), HostError> {
    if value.is_empty() || value.encode_utf16().count() > max || value.chars().any(char::is_control) {
        return Err(HostError::Invalid(format!("expected 1-{max} characters without controls")));
    }
    Ok(())
}
fn body(value: &str) -> Result<(), HostError> {
    if value.encode_utf16().count() > 1 << 20 || value.contains('\0') {
        return Err(HostError::Invalid("content too large or contains NUL".into()));
    }
    Ok(())
}
pub(super) fn validate_tab(tab: &ContentTab) -> Result<(), HostError> {
    label(&tab.key, 128)?;
    label(&tab.title, 256)?;
    body(&tab.content)?;
    if let Some(name) = &tab.file_name {
        label(name, 256)?;
        if name.contains(['/', '\\']) {
            return Err(HostError::Invalid("file-name cannot contain separators".into()));
        }
    }
    if let Some(language) = &tab.language {
        label(language, 64)?;
    }
    if tab.actions.len() > 16 || tab.actions.iter().filter(|a| a.save).count() > 1 {
        return Err(HostError::Invalid("at most 16 actions and one Save action".into()));
    }
    let mut ids = std::collections::BTreeSet::new();
    for action in &tab.actions {
        label(&action.id, 64)?;
        label(&action.label, 128)?;
        if !ids.insert(&action.id) {
            return Err(HostError::Invalid("duplicate action id".into()));
        }
        if let Some(icon) = &action.icon {
            label(icon, 128)?;
        }
    }
    Ok(())
}
pub(super) fn validate_reply(reply: &ContentTabReply) -> Result<(), HostError> {
    if let Some(content) = &reply.content {
        body(content)?;
    }
    if reply.status.as_ref().is_some_and(|s| s.len() > 512) || reply.error.as_ref().is_some_and(|s| s.len() > 1024) {
        return Err(HostError::Invalid("content status or error too long".into()));
    }
    if let Some(diff) = &reply.diff {
        validate_diff(diff)?;
    }
    Ok(())
}

pub(super) fn validate_diff(diff: &ide_plugin::ContentDiff) -> Result<(), HostError> {
    body(&diff.left)?;
    body(&diff.right)?;
    for value in [&diff.left_label, &diff.right_label].into_iter().flatten() {
        label(value, 128)?;
    }
    if let Some(title) = &diff.title {
        label(title, 256)?;
    }
    Ok(())
}

impl PluginApi {
    pub(super) fn new_operation(&self, client: &str, kind: OperationKind) -> Result<String, HostError> {
        let closed = self.shared.closed_clients.lock();
        let blocked = self.shared.prompts_blocked.lock();
        if closed.contains(client) || blocked.contains(self.pkg.id()) {
            return Err(HostError::Cancelled);
        }
        let mut operations = self.shared.operations.lock();
        if operations.values().filter(|o| o.plugin == self.pkg.id()).count() >= 32 {
            return Err(HostError::Invalid("at most 32 active operations".into()));
        }
        let id = format!("plugin-op-{}", self.shared.next_prompt.fetch_add(1, Ordering::Relaxed));
        operations.insert(
            id.clone(),
            Operation {
                plugin: self.pkg.id().into(),
                client: client.into(),
                kind,
                root: self.shared.project_of(client),
                started: false,
                closed: false,
                terminal: None,
                run: None,
            },
        );
        Ok(id)
    }
    pub(super) fn window_request(
        &self,
        client: &str,
        request: WindowRequest,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<Option<String>, HostError> {
        let id = self.shared.next_prompt.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        {
            let closed = self.shared.closed_clients.lock();
            let blocked = self.shared.prompts_blocked.lock();
            if closed.contains(client) || blocked.contains(self.pkg.id()) {
                return Err(HostError::Cancelled);
            }
            self.shared.prompts.lock().insert(
                id,
                PromptEntry { plugin: self.pkg.id().into(), client: client.into(), answer: Waiter::Command(tx) },
            );
        }
        self.shared.sink.emit(
            Some(client),
            PluginEvent::WindowRequest { plugin_id: self.pkg.id().into(), request_id: id.to_string(), request },
        );
        let deadline = Instant::now() + timeout;
        loop {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(CommandAnswer::Value(value)) => return Ok(value),
                Ok(CommandAnswer::NotFound) => return Err(HostError::NotFound("window service unavailable".into())),
                Ok(CommandAnswer::Failed(error)) => return Err(HostError::Failed(error)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    if !cancel.is_cancelled() && Instant::now() < deadline => {}
                Err(_) => {
                    self.shared.prompts.lock().remove(&id);
                    return Err(HostError::Cancelled);
                }
            }
        }
    }
}

impl PluginHost {
    /// The launcher alone may finish its operation; duplicate and foreign reports are ignored.
    pub fn finish_operation(&self, client: &str, id: &str, status: Option<i32>, stopped: bool) -> bool {
        let operation = {
            let mut operations = self.shared.operations.lock();
            if !operations.get(id).is_some_and(|op| op.client == client) {
                return false;
            }
            operations.remove(id).unwrap()
        };
        let event = match operation.kind {
            OperationKind::Run { config, .. } => {
                WorkbenchEvent::RunExited(ide_plugin::RunExited { id: id.into(), config, status, killed: stopped })
            }
            OperationKind::Terminal { key, .. } => WorkbenchEvent::TerminalExited(ide_plugin::TerminalExited {
                id: id.into(),
                key,
                status,
                closed: stopped,
            }),
        };
        self.post_owned_event(&operation.plugin, client, event);
        true
    }
    /// Content actions bypass subscriptions, just like completions of owned operations.
    pub fn content_tab_action(
        &self,
        client: &str,
        plugin: &str,
        action: ide_plugin::ContentTabAction,
    ) -> IdeResult<()> {
        let tabs = self.shared.content_tabs.lock();
        let tab = tabs
            .get(&(plugin.into(), client.into(), action.key.clone()))
            .ok_or_else(|| IdeError::not_found("unknown content tab"))?;
        if !tab.actions.iter().any(|a| a.id == action.action) {
            return Err(IdeError::invalid("unknown content action"));
        }
        body(&action.content).map_err(|e| IdeError::invalid(e.to_string()))?;
        label(&action.request_id, 128).map_err(|e| IdeError::invalid(e.to_string()))?;
        drop(tabs);
        let mut pending = self.shared.content_requests.lock();
        pending.retain(|_, (_, created)| created.elapsed() < Duration::from_secs(15));
        if pending.keys().filter(|(p, w, _)| p == plugin && w == client).count() >= 32 {
            return Err(IdeError::invalid("too many pending content actions"));
        }
        pending.insert((plugin.into(), client.into(), action.request_id.clone()), (action.key.clone(), Instant::now()));
        drop(pending);
        self.post_owned_event(plugin, client, WorkbenchEvent::ContentTabAction(action));
        Ok(())
    }
    fn post_owned_event(&self, plugin: &str, client: &str, event: WorkbenchEvent) {
        if self.shared.client_closed(client) {
            return;
        }
        self.queues
            .lock()
            .entry((plugin.into(), Some(client.into())))
            .or_insert_with(|| EventQueue { since: Instant::now(), events: Vec::new(), files_source: None })
            .events
            .push(event);
    }
}

/// Dynamic configurations opt in with marker files, just like static detectors.
pub(super) fn configurations_declaration(
    pkg: &ide_extension::Package,
    value: toml::Value,
) -> Result<ide_extension::UiDecl, String> {
    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(deny_unknown_fields)]
    struct Decl {
        files: Vec<String>,
    }
    pkg.manifest.needs_api("contributes.runConfigurations", 4)?;
    let decl: Decl = ide_extension::decode("runConfigurations", value)?;
    if pkg.manifest.wasm.is_none() || decl.files.is_empty() || decl.files.len() > 16 {
        return Err("runConfigurations needs code and 1-16 marker files".into());
    }
    for file in &decl.files {
        ide_extension::check_relative(std::path::Path::new(file), "files")?;
    }
    Ok(ide_extension::UiDecl::new(
        serde_json::to_string(&decl.files).unwrap(),
        "Run configurations",
        serde_json::to_value(decl).unwrap(),
    ))
}

impl PluginHost {
    /// Refreshes configuration exports on the same listing path as static detectors.
    pub fn refresh_run_configurations(&self, root: &std::path::Path) {
        if !self.shared.workspace().is_some_and(|w| w.trusted(root)) {
            return;
        }
        let owners: std::collections::BTreeSet<_> = self
            .ui
            .items("runConfigurations", None)
            .into_iter()
            .filter(|d| {
                d.decl["files"]
                    .as_array()
                    .is_some_and(|files| files.iter().filter_map(|f| f.as_str()).any(|f| root.join(f).is_file()))
            })
            .map(|d| d.plugin_id)
            .collect();
        self.shared.run_configurations.write().retain(|(p, r), _| r != root || owners.contains(p));
        for plugin in owners {
            let project = root.to_path_buf();
            let invocation = ide_plugin::Invocation { workspace_root: Some(project.clone()), ..Default::default() };
            let result = self.code_call(&plugin, invocation, "run-configurations", |rt, ctx| {
                rt.run_configurations(
                    ctx.workspace_root.unwrap().to_string_lossy().into_owned(),
                    Duration::from_secs(2),
                )
            });
            let Ok(items) = result else { continue };
            if let Err(error) = validate_configurations(root, &items) {
                tracing::warn!(%plugin, %error, "invalid run configurations");
                continue;
            }
            self.shared.run_configurations.write().insert((plugin, project), items);
        }
    }
    /// Resolves only an owned plugin test configuration in the client's trusted project.
    fn test_configuration(
        &self,
        client: &str,
        config: &str,
    ) -> IdeResult<Option<(std::path::PathBuf, String, String)>> {
        let root = self.shared.project_of(client).ok_or_else(|| IdeError::not_found("no project"))?;
        if !self.shared.workspace().is_some_and(|w| w.trusted(&root)) {
            return Err(IdeError::invalid("project is not trusted"));
        }
        let Some(rest) = config.strip_prefix(ide_run::EXTERNAL_PREFIX) else { return Ok(None) };
        let Some((owner, id)) = rest.split_once(':') else { return Ok(None) };
        let configuration = self
            .shared
            .workspace()
            .ok_or_else(IdeError::cancelled)?
            .run_configuration(client, owner, id)
            .map_err(|e| IdeError::invalid(e.to_string()))?;
        if !configuration.is_test || configuration.extras.params.get("framework").map(String::as_str) != Some("plugin")
        {
            return Ok(None);
        }
        Ok(Some((root, owner.to_owned(), id.to_owned())))
    }

    /// Derives replacement argv for a user action, under the command budget.
    pub fn select_tests(&self, client: &str, config: &str, tests: Vec<Vec<String>>) -> IdeResult<Option<Vec<String>>> {
        if tests.is_empty()
            || tests.len() > 10000
            || tests.iter().any(|p| p.is_empty() || p.len() > 128)
            || serde_json::to_vec(&tests).is_ok_and(|b| b.len() > 4 << 20)
        {
            return Ok(None);
        }
        let Some((root, owner, id)) = self.test_configuration(client, config)? else { return Ok(None) };
        let plugin = self.get(&owner)?;
        let (actor, activated) = self.ensure_active(&plugin, None)?;
        if activated {
            self.changed();
        }
        let invocation = ide_plugin::Invocation { workspace_root: Some(root), ..Default::default() };
        // A user action, not the edit path: allow the command budget (a cold instance may be compiling).
        let timeout = self.limits.timeout;
        let started = Instant::now();
        let result = actor.call(Some(timeout), move |rt| rt.select_tests(id, tests, invocation, timeout));
        let args = self.finish_provider_call(&plugin, &actor, started, result).flatten();
        Ok(args.filter(|args| args.len() <= 10000 && args.iter().map(String::len).sum::<usize>() <= 4 << 20))
    }

    /// Parses a bounded batch under the editor-provider soft/hard budgets.
    pub fn parse_test_results(
        &self,
        client: &str,
        config: &str,
        chunk: String,
    ) -> IdeResult<Option<Vec<ide_plugin::PluginTestEvent>>> {
        if chunk.len() > 64 << 10 {
            return Err(IdeError::invalid("test output batch too large"));
        }
        let Some((root, owner, id)) = self.test_configuration(client, config)? else { return Ok(None) };
        let plugin = self.get(&owner)?;
        let (actor, activated) = self.ensure_active(&plugin, None)?;
        if activated {
            self.changed();
        }
        let invocation = ide_plugin::Invocation { workspace_root: Some(root.clone()), ..Default::default() };
        let (id, hard) = (id.to_owned(), self.limits.edit_hard);
        let started = Instant::now();
        let result =
            actor.call(Some(self.limits.edit_soft), move |rt| rt.parse_test_results(id, chunk, invocation, hard));
        let mut events = self.finish_provider_call(&plugin, &actor, started, result);
        if let Some(events) = &mut events {
            if serde_json::to_vec(&*events).is_ok_and(|b| b.len() > 4 << 20) {
                return Ok(None);
            }
            for event in events {
                let location = match event {
                    ide_plugin::PluginTestEvent::SuiteStarted(v) | ide_plugin::PluginTestEvent::TestStarted(v) => {
                        v.location.as_mut()
                    }
                    ide_plugin::PluginTestEvent::Failed(v) => v.location.as_mut(),
                    _ => None,
                };
                if let Some(location) = location {
                    let Ok(path) = ide_plugin::resolve_new_in_root(&root, &location.path.to_string_lossy()) else {
                        return Ok(None);
                    };
                    if location.range.end < location.range.start {
                        return Ok(None);
                    }
                    location.path = path;
                }
            }
        }
        Ok(events)
    }
}

fn validate_configurations(
    root: &std::path::Path,
    items: &[ide_plugin::PluginRunConfiguration],
) -> Result<(), HostError> {
    let mut ids = std::collections::BTreeSet::new();
    if items.len() > 1000 || serde_json::to_vec(items).is_ok_and(|b| b.len() > 4 << 20) {
        return Err(HostError::Invalid("too many run configurations".into()));
    }
    for c in items {
        ide_extension::validate_item_id(&c.id, "run configuration id").map_err(HostError::Invalid)?;
        label(&c.name, 128)?;
        if !ids.insert(&c.id)
            || c.program.is_empty()
            || c.program.len() > 256
            || c.program.contains(char::is_whitespace)
            || c.args.len() > 256
            || c.args.iter().any(|a| a.len() > 4096 || a.contains('\0'))
        {
            return Err(HostError::Invalid("invalid run configuration".into()));
        }
        if let Some(cwd) = &c.cwd {
            ide_plugin::resolve_new_in_root(root, cwd).map_err(HostError::Invalid)?;
        }
    }
    Ok(())
}

impl PluginHost {
    /// Resolves and rechecks the pin immediately before starting a keyed terminal's PTY.
    pub fn spawn_terminal_session(
        self: &std::sync::Arc<Self>,
        host: &std::sync::Arc<crate::Host>,
        client: &str,
        operation: &str,
        cols: u16,
        rows: u16,
        output: crate::ops::Emit<String>,
    ) -> IdeResult<ide_terminal::TerminalInfo> {
        let (plugin, command) = {
            let mut operations = self.shared.operations.lock();
            let op = operations
                .get_mut(operation)
                .filter(|op| op.client == client)
                .ok_or_else(|| IdeError::not_found("unknown terminal operation"))?;
            if op.started || op.closed || op.root != self.shared.project_of(client) {
                return Err(IdeError::invalid("terminal operation already started or project changed"));
            }
            let OperationKind::Terminal { command, .. } = &op.kind else {
                return Err(IdeError::invalid("not a terminal operation"));
            };
            op.started = true;
            (op.plugin.clone(), command.clone())
        };
        let options = super::web::WebPtyCommand {
            program: command.program,
            args: command.args,
            env: command.env.into_iter().collect(),
            cols,
            rows,
        };
        let weak = Arc::downgrade(self);
        let (id, window) = (operation.to_owned(), client.to_owned());
        let completion = Arc::new(move |status| {
            if let Some(plugins) = weak.upgrade() {
                let closed = plugins.shared.operations.lock().get(&id).is_some_and(|op| op.closed);
                plugins.finish_operation(&window, &id, status, closed);
            }
        });
        let result = self.spawn_plugin_pty(host, &plugin, client, output, Some(completion), || {
            self.pty_options(&plugin, client, options)
        });
        if let Ok(info) = &result {
            let mut operations = self.shared.operations.lock();
            if let Some(op) = operations.get_mut(operation) {
                op.terminal = Some((Arc::downgrade(host), info.id));
                if op.closed {
                    let _ = host.terminals.kill(info.id);
                }
            }
        }
        if result.is_err()
            && let Some(op) = self.shared.operations.lock().get_mut(operation)
        {
            op.started = false;
        }
        result
    }
}

impl PluginHost {
    /// Closing a tab marks the operation before killing its PTY. The real exit emits the event.
    pub fn close_terminal_session(&self, client: &str, id: &str) -> IdeResult<()> {
        let terminal = {
            let mut operations = self.shared.operations.lock();
            let Some(op) = operations
                .get_mut(id)
                .filter(|op| op.client == client && matches!(op.kind, OperationKind::Terminal { .. }))
            else {
                return Ok(());
            };
            op.closed = true;
            op.terminal.clone()
        };
        if let Some((host, id)) = terminal
            && let Some(host) = host.upgrade()
        {
            host.terminals.kill(id)?;
        }
        Ok(())
    }
}

impl PluginHost {
    /// Rechecks the owned configuration's program before Debug and every IDE rerun.
    pub fn prepare_debug_run(&self, client: &str, mut config: ide_run::RunConfig) -> IdeResult<ide_run::RunConfig> {
        let Some((plugin, id)) = config.id.strip_prefix(ide_run::EXTERNAL_PREFIX).and_then(|s| s.split_once(':'))
        else {
            return Err(IdeError::invalid("not a plugin configuration"));
        };
        let workspace = self.shared.workspace().ok_or_else(IdeError::cancelled)?;
        let owned = workspace.run_configuration(client, plugin, id).map_err(|e| IdeError::invalid(e.to_string()))?;
        if owned.debug_adapter.is_none() {
            return Err(IdeError::invalid("this configuration has no debugger"));
        }
        if config.extras.target.is_none() {
            config.extras.target = owned.extras.target.clone();
        }
        if config.extras.target.as_ref().is_some_and(|t| !t.is_empty()) {
            return Err(IdeError::invalid("debugging this target is not supported"));
        }
        config.command = self
            .program_for_project(plugin, &owned.command, self.shared.project_of(client).as_deref())?
            .to_string_lossy()
            .into_owned();
        config.debug_adapter = owned.debug_adapter;
        Ok(config)
    }
}

/// Internal launch metadata; it is ignored after the original operation finishes.
pub(super) const RUN_OPERATION: &str = "plugin.operation";
impl PluginHost {
    pub(crate) fn run_operation_sink(
        self: &Arc<Self>,
        client: &str,
        config: &mut ide_run::RunConfig,
        previous: Arc<dyn ide_core::EventSink>,
    ) -> IdeResult<Arc<dyn ide_core::EventSink>> {
        let Some(id) = config.extras.params.get(RUN_OPERATION).cloned() else { return Ok(previous) };
        let origin = self.shared.operations.lock().get(&id).and_then(|op| {
            if op.client != client {
                return None;
            }
            let OperationKind::Run { configuration, program, .. } = &op.kind else { return None };
            (configuration == &config.id).then(|| (op.plugin.clone(), op.root.clone(), program.clone()))
        });
        let Some((plugin, root, program)) = origin else { return Ok(previous) };
        let binary = self.program_for_project(&plugin, &program, root.as_deref())?;
        config.command = if config.extras.target.as_ref().is_some_and(|t| !t.is_empty()) {
            program
        } else {
            binary.to_string_lossy().into_owned()
        };
        config.detected = false;
        let (weak, client) = (Arc::downgrade(self), client.to_owned());
        Ok(Arc::new(move |event: ide_core::IdeEvent| {
            if let ide_core::IdeEvent::RunExited { code, .. } = &event
                && let Some(plugins) = weak.upgrade()
            {
                let stopped = plugins.shared.operations.lock().get(&id).is_some_and(|op| op.closed);
                plugins.finish_operation(&client, &id, *code, stopped);
            }
            previous.emit(event);
        }))
    }
    pub(crate) fn run_operation_started(&self, client: &str, operation: &str, run: ide_core::RunId) {
        if let Some(op) = self
            .shared
            .operations
            .lock()
            .get_mut(operation)
            .filter(|op| op.client == client && matches!(op.kind, OperationKind::Run { .. }))
        {
            op.run = Some(run);
        }
    }
    pub(crate) fn run_operation_stopped(&self, run: ide_core::RunId) {
        for op in self.shared.operations.lock().values_mut().filter(|op| op.run == Some(run)) {
            op.closed = true;
        }
    }
}
