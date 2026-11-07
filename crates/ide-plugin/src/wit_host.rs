//! The host side of the `openidea:plugin@1.0.0` world: bindings, resource
//! types and the implementation of every import. Capabilities are checked
//! here; a missing one returns `error::denied` (the plugin can degrade).

use crate::runtime::{MAX_TITLE, StoreData, clip};
use crate::sandbox;
use crate::types::{
    EditorContext, EventKind, HostError, HttpRequest, NotificationLevel, PickItem, ProcessChunk, ProcessCommand,
    Prompt, StatusItem, net_host,
};
use ide_core::ipc_path::to_ipc;
use ide_extension::Capability;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use wasmtime::component::Resource;

pub(crate) mod bindings {
    wasmtime::component::bindgen!({
        world: "plugin",
        path: "../../wit",
        imports: { default: trappable },
        with: {
            "openidea:plugin/workspace.project": super::ProjectRes,
            "openidea:plugin/editor.text-editor": super::EditorRes,
            "openidea:plugin/invocation.invocation": super::InvocationRes,
            "openidea:plugin/tasks.task": super::TaskRes,
            "openidea:plugin/process.child": super::ChildRes,
        },
    });
}

/// The optional `syntax-provider` export, bound on its own when present.
pub(crate) mod syntax_bindings {
    wasmtime::component::bindgen!({
        world: "plugin-syntax",
        path: "../../wit",
        imports: { default: trappable },
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/log": super::bindings::openidea::plugin::log,
            "openidea:plugin/ui": super::bindings::openidea::plugin::ui,
            "openidea:plugin/storage": super::bindings::openidea::plugin::storage,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
            "openidea:plugin/vcs": super::bindings::openidea::plugin::vcs,
            "openidea:plugin/commit": super::bindings::openidea::plugin::commit,
            "openidea:plugin/events": super::bindings::openidea::plugin::events,
            "openidea:plugin/tasks": super::bindings::openidea::plugin::tasks,
            "openidea:plugin/diagnostics": super::bindings::openidea::plugin::diagnostics,
            "openidea:plugin/net": super::bindings::openidea::plugin::net,
            "openidea:plugin/secrets": super::bindings::openidea::plugin::secrets,
            "openidea:plugin/process": super::bindings::openidea::plugin::process,
            "openidea:plugin/fs": super::bindings::openidea::plugin::fs,
            "openidea:plugin/views": super::bindings::openidea::plugin::views,
            "openidea:plugin/settings": super::bindings::openidea::plugin::settings,
        },
    });
}

/// The optional `providers` export.
pub(crate) mod providers_bindings {
    wasmtime::component::bindgen!({
        world: "plugin-providers",
        path: "../../wit",
        imports: { default: trappable },
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/log": super::bindings::openidea::plugin::log,
            "openidea:plugin/ui": super::bindings::openidea::plugin::ui,
            "openidea:plugin/storage": super::bindings::openidea::plugin::storage,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
            "openidea:plugin/vcs": super::bindings::openidea::plugin::vcs,
            "openidea:plugin/commit": super::bindings::openidea::plugin::commit,
            "openidea:plugin/events": super::bindings::openidea::plugin::events,
            "openidea:plugin/tasks": super::bindings::openidea::plugin::tasks,
            "openidea:plugin/diagnostics": super::bindings::openidea::plugin::diagnostics,
            "openidea:plugin/net": super::bindings::openidea::plugin::net,
            "openidea:plugin/secrets": super::bindings::openidea::plugin::secrets,
            "openidea:plugin/process": super::bindings::openidea::plugin::process,
            "openidea:plugin/fs": super::bindings::openidea::plugin::fs,
            "openidea:plugin/views": super::bindings::openidea::plugin::views,
            "openidea:plugin/settings": super::bindings::openidea::plugin::settings,
        },
    });
}

/// The optional `view-provider` export.
pub(crate) mod views_bindings {
    wasmtime::component::bindgen!({
        world: "plugin-views",
        path: "../../wit",
        imports: { default: trappable },
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/log": super::bindings::openidea::plugin::log,
            "openidea:plugin/ui": super::bindings::openidea::plugin::ui,
            "openidea:plugin/storage": super::bindings::openidea::plugin::storage,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
            "openidea:plugin/vcs": super::bindings::openidea::plugin::vcs,
            "openidea:plugin/commit": super::bindings::openidea::plugin::commit,
            "openidea:plugin/events": super::bindings::openidea::plugin::events,
            "openidea:plugin/tasks": super::bindings::openidea::plugin::tasks,
            "openidea:plugin/diagnostics": super::bindings::openidea::plugin::diagnostics,
            "openidea:plugin/net": super::bindings::openidea::plugin::net,
            "openidea:plugin/secrets": super::bindings::openidea::plugin::secrets,
            "openidea:plugin/process": super::bindings::openidea::plugin::process,
            "openidea:plugin/fs": super::bindings::openidea::plugin::fs,
            "openidea:plugin/views": super::bindings::openidea::plugin::views,
            "openidea:plugin/settings": super::bindings::openidea::plugin::settings,
        },
    });
}

use bindings::openidea::plugin::{
    commit, diagnostics, editor, events, fs, invocation, log, net, process, secrets, settings, storage, tasks,
    types as wit, ui, vcs, views, workspace,
};

/// A project handle: its root.
pub struct ProjectRes {
    root: PathBuf,
}

/// A program a plugin started behind a handle (`process.start`); dropping the
/// handle ends it if it still runs.
pub struct ChildRes {
    id: u64,
    host: std::sync::Arc<dyn crate::HostApi>,
}

impl Drop for ChildRes {
    fn drop(&mut self) {
        self.host.release_process(self.id);
    }
}

/// The invoking window's focused editor.
pub struct EditorRes {
    ctx: EditorContext,
}

/// The current call's invocation (read from [`StoreData`]).
pub struct InvocationRes;

pub struct TaskRes {
    id: u64,
}

const MAX_EDITS: usize = 10_000;
const MAX_DIAGNOSTICS: usize = 5_000;
const MAX_REQUEST_BODY: usize = 8 << 20;
const MAX_FIND: u32 = 10_000;
const MAX_STATUS_TEXT: usize = 128;
const MAX_PICK_ITEMS: usize = 5000;
const MAX_PICK_KEY: usize = 256;
const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 4096;
const MAX_ENV: usize = 64;
const MAX_ENV_NAME: usize = 256;
const MAX_ENV_VALUE: usize = 4096;
/// Most output one `poll` / `wait` hands out, per stream.
const MAX_CHUNK: usize = 1 << 20;
/// Most text one `write` puts into a process's stdin.
const MAX_STDIN_BYTES: usize = 1 << 20;

type Fallible<T> = wasmtime::Result<Result<T, wit::Error>>;

pub(crate) fn to_wit(e: HostError) -> wit::Error {
    match e {
        HostError::Denied(c) => wit::Error::Denied(c),
        HostError::Stale => wit::Error::Stale,
        HostError::NotFound(m) => wit::Error::NotFound(m),
        HostError::Invalid(m) => wit::Error::Invalid(m),
        HostError::Cancelled => wit::Error::Cancelled,
        HostError::Failed(m) => wit::Error::Failed(m),
    }
}

fn notification_level(level: wit::NotificationLevel) -> NotificationLevel {
    match level {
        wit::NotificationLevel::Info => NotificationLevel::Info,
        wit::NotificationLevel::Warning => NotificationLevel::Warning,
        wit::NotificationLevel::Error => NotificationLevel::Error,
    }
}

/// A guest's `error` as text (`denied: net:example.com`, `stale`, …).
impl From<wit::Error> for crate::runtime::GuestError {
    fn from(e: wit::Error) -> Self {
        let clip = |m: String| clip(m, crate::runtime::MAX_TITLE * 16);
        match e {
            wit::Error::Denied(c) => Self::Denied(clip(c)),
            wit::Error::Stale => Self::Stale,
            wit::Error::NotFound(m) => Self::NotFound(clip(m)),
            wit::Error::Invalid(m) => Self::Invalid(clip(m)),
            wit::Error::Cancelled => Self::Cancelled,
            wit::Error::Failed(m) => Self::Failed(clip(m)),
        }
    }
}

fn pos(p: wit::Position) -> ide_core::Pos {
    ide_core::Pos::new(p.line, p.character)
}

fn range_to_wit(r: &ide_core::Range) -> wit::Range {
    wit::Range {
        start: wit::Position { line: r.start.line, character: r.start.col },
        end: wit::Position { line: r.end.line, character: r.end.col },
    }
}

impl StoreData {
    fn require(&self, cap: Capability) -> Result<(), wit::Error> {
        if self.granted.iter().any(|g| g.covers(&cap)) { Ok(()) } else { Err(wit::Error::Denied(cap.to_string())) }
    }

    /// `path` as the real path an `fs.read:…` grant covers, or what the plugin
    /// should be told instead (`denied` naming the capability to declare).
    fn granted_file(&self, path: &str) -> Result<PathBuf, wit::Error> {
        sandbox::resolve_granted(&self.granted, path).map_err(Into::into)
    }

    /// The same for `fs.write:…`: a file that does not exist yet is resolved
    /// through the directory it would be created in.
    fn writable_file(&self, path: &str) -> Result<PathBuf, wit::Error> {
        sandbox::resolve_writable(&self.granted, path).map_err(Into::into)
    }

    fn client(&self) -> Option<&str> {
        self.invocation.client.as_deref()
    }

    fn push<T: Send + 'static>(&mut self, value: T) -> wasmtime::Result<Resource<T>> {
        Ok(self.table.push(value)?)
    }

    pub(crate) fn new_invocation(&mut self) -> wasmtime::Result<Resource<InvocationRes>> {
        self.push(InvocationRes)
    }

    pub(crate) fn drop_invocation(&mut self, res: Resource<InvocationRes>) {
        let _ = self.table.delete(res);
    }
}

impl wit::Host for StoreData {}

impl log::Host for StoreData {
    fn log(&mut self, level: wit::LogLevel, message: String) -> wasmtime::Result<()> {
        let id = &self.plugin_id;
        let message = clip(message, crate::runtime::MAX_TEXT);
        match level {
            wit::LogLevel::Trace => tracing::trace!(plugin = %id, "{message}"),
            wit::LogLevel::Debug => tracing::debug!(plugin = %id, "{message}"),
            wit::LogLevel::Info => tracing::info!(plugin = %id, "{message}"),
            wit::LogLevel::Warn => tracing::warn!(plugin = %id, "{message}"),
            wit::LogLevel::Error => tracing::error!(plugin = %id, "{message}"),
        }
        Ok(())
    }
}

impl StoreData {
    /// Asks the user and waits; the wait doesn't count against the call's
    /// wall-clock budget.
    fn ask(&mut self, prompt: Prompt) -> Result<Option<Vec<String>>, wit::Error> {
        let client = match (&prompt, &self.action_prompt_client) {
            (
                Prompt::QuickPick { .. } | Prompt::Input { multiline: false, .. } | Prompt::Confirm { .. },
                Some(client),
            ) => Some(client.clone()),
            _ => {
                self.require_interactive()?;
                self.invocation.client.clone()
            }
        };
        let started = Instant::now();
        let answer = self.host.ask(client.as_deref(), prompt, &self.cancel.token());
        let waited = started.elapsed();
        self.deadline += waited;
        self.call_started += waited;
        answer.map_err(to_wit)
    }

    fn pick_prompt(
        &mut self,
        title: String,
        items: Vec<ui::PickItem>,
        multiple: bool,
    ) -> Result<Option<Vec<String>>, wit::Error> {
        if items.len() > MAX_PICK_ITEMS {
            return Err(wit::Error::Invalid(format!("more than {MAX_PICK_ITEMS} items")));
        }
        if items.iter().any(|i| i.key.len() > MAX_PICK_KEY) {
            return Err(wit::Error::Invalid(format!("an item key is longer than {MAX_PICK_KEY} bytes")));
        }
        let items = items
            .into_iter()
            .map(|i| PickItem {
                key: i.key,
                label: clip(i.label, MAX_TITLE),
                description: i.description.map(|d| clip(d, 1024)),
            })
            .collect();
        self.ask(Prompt::QuickPick { title: clip(title, MAX_TITLE), items, multiple })
    }

    /// APIs reserved for commands and events exclude code-action resolution.
    fn require_interactive(&self) -> Result<(), wit::Error> {
        if self.interactive {
            return Ok(());
        }
        Err(wit::Error::Invalid("can only ask the user from a command or event".into()))
    }
}

impl ui::Host for StoreData {
    fn notify(
        &mut self,
        level: wit::NotificationLevel,
        title: String,
        body: String,
        actions: Vec<ui::NotificationAction>,
    ) -> Fallible<()> {
        const MAX_ACTIONS: usize = 3;
        if actions.len() > MAX_ACTIONS {
            return Ok(Err(wit::Error::Invalid(format!("a notification has at most {MAX_ACTIONS} actions"))));
        }
        let mut checked = Vec::with_capacity(actions.len());
        for a in actions {
            if a.label.trim().is_empty() || a.label.len() > 256 || a.label.chars().any(char::is_control) {
                return Ok(Err(wit::Error::Invalid(format!("invalid action label {:?}", a.label))));
            }
            if a.argument.as_ref().is_some_and(|arg| arg.len() > 64 << 10) {
                return Ok(Err(wit::Error::Invalid("an action argument is limited to 64 KiB".into())));
            }
            checked.push(crate::NotificationAction { label: a.label, command: a.command, argument: a.argument });
        }
        let (title, body) = (clip(title, MAX_TITLE), clip(body, 16 << 10));
        Ok(self.host.notify(self.client(), notification_level(level), title, body, checked).map_err(to_wit))
    }

    fn show_notification(
        &mut self,
        level: wit::NotificationLevel,
        title: String,
        body: String,
    ) -> wasmtime::Result<()> {
        let (title, body) = (clip(title, MAX_TITLE), clip(body, 16 << 10));
        // A plain notification has nothing the host could refuse.
        let _ = self.host.notify(self.client(), notification_level(level), title, body, Vec::new());
        Ok(())
    }

    fn set_status_item(&mut self, id: String, item: ui::StatusItem) -> wasmtime::Result<()> {
        let item = StatusItem {
            text: clip(item.text, MAX_STATUS_TEXT),
            tooltip: item.tooltip.map(|t| clip(t, 1024)),
            command: item.command.map(|c| clip(c, 128)),
        };
        self.host.status_item(&clip(id, 64), Some(item));
        Ok(())
    }

    fn remove_status_item(&mut self, id: String) -> wasmtime::Result<()> {
        self.host.status_item(&clip(id, 64), None);
        Ok(())
    }

    fn set_context(&mut self, key: String, value: ui::ContextValue) -> Fallible<()> {
        let valid_key =
            (1..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
        if !valid_key {
            return Ok(Err(wit::Error::Invalid(format!("context key {key:?}: expected 1-64 of A-Za-z0-9_-"))));
        }
        // Kept as JSON text, which the windows parse into their context.
        let json = match value {
            ui::ContextValue::Flag(b) => b.to_string(),
            ui::ContextValue::Number(n) if n.fract() == 0.0 && n.abs() < 9e15 => (n as i64).to_string(),
            ui::ContextValue::Number(n) => match serde_json::Number::from_f64(n) {
                Some(n) => n.to_string(),
                None => return Ok(Err(wit::Error::Invalid("context value: not a finite number".into()))),
            },
            ui::ContextValue::Text(t) if t.len() <= 1024 => serde_json::Value::String(t).to_string(),
            ui::ContextValue::Text(_) => {
                return Ok(Err(wit::Error::Invalid("context value: text longer than 1024 bytes".into())));
            }
        };
        let client = self.invocation.client.clone();
        Ok(self.host.set_context(client.as_deref(), &key, Some(json)).map_err(to_wit))
    }

    fn remove_context(&mut self, key: String) -> wasmtime::Result<()> {
        let client = self.invocation.client.clone();
        // Nothing to remove under an invalid key.
        let _ = self.host.set_context(client.as_deref(), &key, None);
        Ok(())
    }

    fn copy_to_clipboard(&mut self, text: String) -> Fallible<()> {
        if let Err(e) = self.require(Capability::Clipboard) {
            return Ok(Err(e));
        }
        let client = self.invocation.client.clone();
        Ok(self.host.copy_to_clipboard(client.as_deref(), clip(text, crate::runtime::MAX_TEXT)).map_err(to_wit))
    }

    fn open_url(&mut self, url: String) -> Fallible<()> {
        let trimmed = url.trim();
        let valid = (trimmed.starts_with("https://") || trimmed.starts_with("http://")) && trimmed.len() <= 8192;
        if !valid {
            return Ok(Err(wit::Error::Invalid(format!("{url:?}: expected an http:// or https:// URL"))));
        }
        let client = self.invocation.client.clone();
        Ok(self.host.open_url(client.as_deref(), trimmed.to_owned()).map_err(to_wit))
    }

    fn pick(&mut self, title: String, items: Vec<ui::PickItem>) -> Fallible<Option<String>> {
        let answer = self.pick_prompt(title, items, false);
        Ok(answer.map(|keys| keys.and_then(|keys| keys.into_iter().next())))
    }

    fn pick_directory(&mut self, title: String, initial: Option<String>) -> Fallible<Option<String>> {
        if let Some(path) = &initial
            && let Err(error) = validate_ui_path(path)
        {
            return Ok(Err(error));
        }
        let answer = self.ask(Prompt::PickDirectory { title: clip(title, MAX_TITLE), initial });
        Ok(answer.and_then(|answer| {
            let path = answer.and_then(|items| items.into_iter().next());
            if let Some(path) = &path {
                validate_ui_path(path)?;
            }
            Ok(path)
        }))
    }

    fn pick_many(&mut self, title: String, items: Vec<ui::PickItem>) -> Fallible<Option<Vec<String>>> {
        Ok(self.pick_prompt(title, items, true))
    }

    fn input(&mut self, prompt: String, value: Option<String>) -> Fallible<Option<String>> {
        let prompt =
            Prompt::Input { prompt: clip(prompt, MAX_TITLE), value: value.map(|v| clip(v, 4096)), multiline: false };
        Ok(self.ask(prompt).map(|answer| answer.and_then(|text| text.into_iter().next())))
    }

    fn input_multiline(&mut self, prompt: String, value: Option<String>) -> Fallible<Option<String>> {
        let prompt =
            Prompt::Input { prompt: clip(prompt, MAX_TITLE), value: value.map(|v| clip(v, 4096)), multiline: true };
        Ok(self.ask(prompt).map(|answer| answer.and_then(|text| text.into_iter().next())))
    }

    fn confirm(&mut self, title: String, body: String) -> Fallible<bool> {
        let prompt = Prompt::Confirm { title: clip(title, MAX_TITLE), message: clip(body, 16 << 10) };
        Ok(self.ask(prompt).map(|answer| answer.is_some()))
    }

    fn locale(&mut self) -> wasmtime::Result<String> {
        Ok(self.host.locale())
    }
}

impl storage::Host for StoreData {
    fn get(&mut self, key: String) -> Fallible<Option<String>> {
        if let Err(e) = self.require(Capability::Storage) {
            return Ok(Err(e));
        }
        Ok(self.host.storage_get(&key).map_err(to_wit))
    }

    fn set(&mut self, key: String, value: String) -> Fallible<()> {
        if let Err(e) = self.require(Capability::Storage) {
            return Ok(Err(e));
        }
        Ok(self.host.storage_set(&key, Some(value)).map_err(to_wit))
    }

    fn delete(&mut self, key: String) -> Fallible<()> {
        if let Err(e) = self.require(Capability::Storage) {
            return Ok(Err(e));
        }
        Ok(self.host.storage_set(&key, None).map_err(to_wit))
    }

    fn keys(&mut self, prefix: String) -> Fallible<Vec<String>> {
        if let Err(e) = self.require(Capability::Storage) {
            return Ok(Err(e));
        }
        Ok(self.host.storage_keys(&prefix).map_err(to_wit))
    }
}

impl workspace::Host for StoreData {
    fn open_project(&mut self, path: String, new_window: bool) -> Fallible<()> {
        if let Err(error) = self.require_interactive().and_then(|_| validate_ui_path(&path)) {
            return Ok(Err(error));
        }
        let client = self.invocation.client.clone();
        Ok(self.host.open_project(client.as_deref(), path, new_window).map_err(to_wit))
    }

    fn project_of(&mut self, path: String) -> wasmtime::Result<Option<Resource<ProjectRes>>> {
        self.host.project_of(Path::new(&path)).map(|root| self.push(ProjectRes { root })).transpose()
    }

    fn symbols(
        &mut self,
        project: Resource<ProjectRes>,
        query: String,
        limit: u32,
    ) -> Fallible<Vec<workspace::SymbolInfo>> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        if query.len() > 256 {
            return Ok(Err(wit::Error::Invalid("symbol query exceeds 256 UTF-8 bytes".into())));
        }
        let root = &self.table.get(&project)?.root;
        Ok(self
            .host
            .symbols(root, &query, limit.min(1000) as usize, &self.cancel.token(), self.deadline)
            .map(|symbols| {
                symbols
                    .into_iter()
                    .map(|s| workspace::SymbolInfo {
                        name: s.name,
                        kind: s.kind,
                        container: s.container,
                        location: wit::Location {
                            path: to_ipc(&s.location.path),
                            range: range_to_wit(&s.location.range),
                        },
                    })
                    .collect()
            })
            .map_err(to_wit))
    }

    fn projects(&mut self) -> Fallible<Vec<Resource<ProjectRes>>> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let mut out = Vec::new();
        for root in self.host.projects() {
            out.push(self.push(ProjectRes { root })?);
        }
        Ok(Ok(out))
    }
}

impl workspace::HostProject for StoreData {
    fn root(&mut self, this: Resource<ProjectRes>) -> Fallible<String> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        // Paths reach plugins in IPC form (`/` on Windows), as the UI's event paths do, so they compare as text.
        Ok(Ok(to_ipc(&self.table.get(&this)?.root)))
    }

    fn read_file(&mut self, this: Resource<ProjectRes>, path: String) -> Fallible<String> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&this)?.root.clone();
        let real = match sandbox::resolve_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => {
                let e = if e.ends_with("no such file") { wit::Error::NotFound(e) } else { wit::Error::Invalid(e) };
                return Ok(Err(e));
            }
        };
        if let Some(text) = self.host.buffer_text(&real) {
            return Ok(Ok(text));
        }
        Ok(sandbox::read_text(&real).map_err(wit::Error::Failed))
    }

    fn exists(&mut self, this: Resource<ProjectRes>, path: String) -> Fallible<bool> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&this)?.root.clone();
        match sandbox::inside_root(&root, &path) {
            Err(e) => Ok(Err(wit::Error::Invalid(e))),
            Ok(false) => {
                Ok(Err(wit::Error::Invalid(format!("{path}: access outside the project root is not allowed"))))
            }
            Ok(true) => {
                let requested = Path::new(&path);
                let joined = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
                Ok(Ok(joined.exists()))
            }
        }
    }

    fn stat(&mut self, this: Resource<ProjectRes>, path: String) -> Fallible<workspace::FileStat> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&this)?.root.clone();
        let real = match sandbox::resolve_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => {
                let e = if e.ends_with("no such file") { wit::Error::NotFound(e) } else { wit::Error::Invalid(e) };
                return Ok(Err(e));
            }
        };
        Ok(file_stat(&real, &path))
    }

    fn find_files(&mut self, this: Resource<ProjectRes>, glob: String, limit: u32) -> Fallible<Vec<String>> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&this)?.root.clone();
        Ok(self.host.find_files(&root, &glob, limit.min(MAX_FIND) as usize).map_err(to_wit))
    }

    fn write_file(&mut self, this: Resource<ProjectRes>, path: String, text: String) -> Fallible<()> {
        if let Err(e) = self.require(Capability::ProjectWrite) {
            return Ok(Err(e));
        }
        if text.len() > sandbox::MAX_WRITE_BYTES {
            return Ok(Err(too_much_to_write(&path)));
        }
        let root = self.table.get(&this)?.root.clone();
        let real = match sandbox::resolve_new_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(wit::Error::Invalid(e))),
        };
        // The directories it goes in are created, like a new file in the project view.
        if let Some(parent) = real.parent()
            && let Err(e) = std::fs::create_dir_all(parent)
        {
            return Ok(Err(wit::Error::Failed(format!("{path}: {e}"))));
        }
        Ok(self.host.write_text_file(&real, &text).map_err(to_wit))
    }

    fn drop(&mut self, rep: Resource<ProjectRes>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl editor::Host for StoreData {}

impl editor::HostTextEditor for StoreData {
    fn path(&mut self, this: Resource<EditorRes>) -> wasmtime::Result<String> {
        Ok(to_ipc(&self.table.get(&this)?.ctx.path))
    }

    fn language(&mut self, this: Resource<EditorRes>) -> wasmtime::Result<String> {
        Ok(self.table.get(&this)?.ctx.language.clone())
    }

    fn document(&mut self, this: Resource<EditorRes>) -> Fallible<editor::Document> {
        if let Err(e) = self.require(Capability::EditorRead) {
            return Ok(Err(e));
        }
        let path = self.table.get(&this)?.ctx.path.clone();
        Ok(match self.host.document(&path) {
            Some((version, text)) => Ok(editor::Document { version, text }),
            None => Err(wit::Error::NotFound(format!("{} is not open", path.display()))),
        })
    }

    fn selections(&mut self, this: Resource<EditorRes>) -> Fallible<Vec<wit::Range>> {
        if let Err(e) = self.require(Capability::EditorRead) {
            return Ok(Err(e));
        }
        Ok(Ok(self.table.get(&this)?.ctx.selections.iter().map(range_to_wit).collect()))
    }

    fn apply_edits(&mut self, this: Resource<EditorRes>, version: u64, edits: Vec<wit::TextEdit>) -> Fallible<u64> {
        if let Err(e) = self.require(Capability::EditorWrite) {
            return Ok(Err(e));
        }
        if edits.len() > MAX_EDITS {
            return Ok(Err(wit::Error::Invalid(format!("more than {MAX_EDITS} edits"))));
        }
        let total: usize = edits.iter().map(|e| e.text.len()).sum();
        if total > crate::runtime::MAX_TEXT * 8 {
            return Ok(Err(wit::Error::Invalid("edits too large".into())));
        }
        let path = self.table.get(&this)?.ctx.path.clone();
        let edits: Vec<ide_core::TextEdit> = edits
            .into_iter()
            .map(|e| ide_core::TextEdit {
                range: ide_core::Range::new(pos(e.range.start), pos(e.range.end)),
                new_text: e.text,
            })
            .collect();
        let client = self.invocation.client.clone();
        Ok(self.host.apply_edits(client.as_deref(), &path, version, edits).map_err(to_wit))
    }

    fn drop(&mut self, rep: Resource<EditorRes>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl invocation::Host for StoreData {}

impl invocation::HostInvocation for StoreData {
    fn project(&mut self, _this: Resource<InvocationRes>) -> wasmtime::Result<Option<Resource<ProjectRes>>> {
        match self.invocation.workspace_root.clone() {
            Some(root) => Ok(Some(self.push(ProjectRes { root })?)),
            None => Ok(None),
        }
    }

    fn editor(&mut self, _this: Resource<InvocationRes>) -> wasmtime::Result<Option<Resource<EditorRes>>> {
        match self.invocation.editor.clone() {
            Some(ctx) => Ok(Some(self.push(EditorRes { ctx })?)),
            None => Ok(None),
        }
    }

    fn selected_paths(&mut self, _this: Resource<InvocationRes>) -> wasmtime::Result<Vec<String>> {
        Ok(self.invocation.selected_paths.iter().take(MAX_FIND as usize).map(|p| to_ipc(p)).collect())
    }

    fn drop(&mut self, rep: Resource<InvocationRes>) -> wasmtime::Result<()> {
        // Owned by the host for the duration of the call.
        let _ = rep;
        Ok(())
    }
}

impl vcs::Host for StoreData {
    fn status(&mut self, project: Resource<ProjectRes>) -> Fallible<Option<vcs::RepositoryStatus>> {
        if let Err(e) = self.require(Capability::VcsRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&project)?.root.clone();
        Ok(self
            .host
            .vcs_status(&root)
            .map(|s| {
                s.map(|s| vcs::RepositoryStatus {
                    root: s.root,
                    branch: s.branch,
                    commit: s.commit,
                    upstream: s.upstream,
                    ahead: s.ahead,
                    behind: s.behind,
                    operation: s.operation,
                    changed_files: s.changed_files,
                })
            })
            .map_err(to_wit))
    }

    fn fetch(&mut self, project: Resource<ProjectRes>) -> Fallible<()> {
        if let Err(e) = self.require(Capability::VcsWrite) {
            return Ok(Err(e));
        }
        let root = self.table.get(&project)?.root.clone();
        let token = self.cancel.token();
        Ok(self.host.vcs_fetch(&root, &token).map_err(to_wit))
    }

    fn remotes(&mut self, project: Resource<ProjectRes>) -> Fallible<Vec<(String, String)>> {
        if let Err(e) = self.require(Capability::VcsRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&project)?.root.clone();
        Ok(self.host.vcs_remotes(&root).map_err(to_wit))
    }
}

impl commit::Host for StoreData {
    fn pending_commit(&mut self) -> Fallible<Option<commit::CommitDraft>> {
        if let Err(e) = self.require(Capability::VcsRead) {
            return Ok(Err(e));
        }
        if let Err(e) = self.require_interactive() {
            return Ok(Err(e));
        }
        // Waiting for the window (saving, diffing) doesn't count against the call's budget.
        let client = self.invocation.client.clone();
        let started = Instant::now();
        let draft = self.host.pending_commit(client.as_deref(), &self.cancel.token());
        let waited = started.elapsed();
        self.deadline += waited;
        self.call_started += waited;
        Ok(draft.map(|d| d.map(commit_draft_to_wit)).map_err(to_wit))
    }

    fn set_commit_message(&mut self, revision: u64, message: String) -> Fallible<()> {
        if let Err(e) = self.require(Capability::VcsWrite) {
            return Ok(Err(e));
        }
        if let Err(e) = self.require_interactive() {
            return Ok(Err(e));
        }
        if message.len() > MAX_COMMIT_MESSAGE {
            return Ok(Err(wit::Error::Invalid(format!("a commit message is at most {MAX_COMMIT_MESSAGE} bytes"))));
        }
        let client = self.invocation.client.clone();
        Ok(self.host.set_commit_message(client.as_deref(), revision, message).map_err(to_wit))
    }
}

/// Longest commit message a plugin may set.
const MAX_COMMIT_MESSAGE: usize = 64 << 10;

pub(crate) fn commit_draft_to_wit(d: crate::types::CommitDraft) -> commit::CommitDraft {
    commit::CommitDraft {
        revision: d.revision,
        message: d.message,
        amend: d.amend,
        changes: d
            .changes
            .into_iter()
            .map(|c| commit::CommitChange {
                repository: c.repository,
                path: c.path,
                old_path: c.old_path,
                status: c.status,
                diff: c.diff,
                truncated: c.truncated,
            })
            .collect(),
    }
}

impl events::Host for StoreData {
    fn subscribe(&mut self, kind: String) -> Fallible<()> {
        let Some(kind) = EventKind::parse(&kind) else {
            return Ok(Err(wit::Error::Invalid(format!("no event kind {kind:?} in this OpenIDEA"))));
        };
        if let Some(cap) = kind.capability()
            && let Err(e) = self.require(cap)
        {
            return Ok(Err(e));
        }
        self.host.subscribe(kind);
        Ok(Ok(()))
    }

    fn subscribe_paths(&mut self, kind: String, globs: Vec<String>) -> Fallible<()> {
        if let Err(e) = self.require(Capability::Events) {
            return Ok(Err(e));
        }
        Ok(self.host.subscribe_paths(&kind, globs).map_err(to_wit))
    }

    fn unsubscribe(&mut self, kind: String) -> wasmtime::Result<()> {
        self.host.unsubscribe(&kind);
        Ok(())
    }
}

impl tasks::Host for StoreData {
    fn begin(&mut self, title: String, cancellable: bool) -> wasmtime::Result<Resource<TaskRes>> {
        let token = self.cancel.token();
        let id = self.host.task_begin(self.client(), clip(title, crate::runtime::MAX_TITLE), cancellable, token);
        self.open_tasks.push(id);
        // The call may now run for the background budget.
        self.renew_background(self.call_started);
        self.push(TaskRes { id })
    }
}

impl tasks::HostTask for StoreData {
    fn report(
        &mut self,
        this: Resource<TaskRes>,
        done: u32,
        total: Option<u32>,
        message: Option<String>,
    ) -> wasmtime::Result<()> {
        let id = self.table.get(&this)?.id;
        let now = Instant::now();
        // A task that is still reporting is still working: the call gets another
        // background budget, so long work isn't cut off at the first deadline
        // while a task that goes quiet still is.
        self.renew_background(now);
        // At most ~10 updates per second reach the UI.
        if self.last_report.is_none_or(|t| now.duration_since(t).as_millis() >= 100) || total.is_some_and(|t| done >= t)
        {
            self.last_report = Some(now);
            self.host.task_report(id, done, total, message.map(|m| clip(m, 256)));
        }
        Ok(())
    }

    fn is_cancelled(&mut self, this: Resource<TaskRes>) -> wasmtime::Result<bool> {
        let id = self.table.get(&this)?.id;
        // Asking whether to stop is the same sign of life as reporting is.
        self.renew_background(Instant::now());
        Ok(self.cancel.token().is_cancelled() || self.host.task_cancelled(id))
    }

    fn drop(&mut self, rep: Resource<TaskRes>) -> wasmtime::Result<()> {
        let id = self.table.delete(rep)?.id;
        self.open_tasks.retain(|t| *t != id);
        self.host.task_end(id);
        Ok(())
    }
}

impl StoreData {
    /// Lets the running call reach `from` plus the background budget (the
    /// longer of it and what was left), so a task that keeps saying it is alive
    /// isn't cut off at the first deadline.
    fn renew_background(&mut self, from: Instant) {
        let extended = from + self.limits.background;
        if extended > self.deadline {
            self.deadline = extended;
            self.timeout = self.limits.background;
        }
    }

    /// What is left of the running call's wall-clock budget (host operations
    /// can't be interrupted by the epoch callback, so they get this as timeout).
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

impl diagnostics::Host for StoreData {
    fn publish(&mut self, path: String, items: Vec<diagnostics::Diagnostic>) -> Fallible<()> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let items = diagnostics_from_wit(items, &self.plugin_id);
        Ok(self.host.publish_diagnostics(Path::new(&path), items).map_err(to_wit))
    }
}

impl net::Host for StoreData {
    fn fetch(&mut self, req: net::Request) -> Fallible<net::Response> {
        let host = match net_host(&req.url) {
            Ok(h) => h,
            Err(e) => return Ok(Err(wit::Error::Invalid(e))),
        };
        if let Err(e) = self.require(Capability::Net(host)) {
            return Ok(Err(e));
        }
        if req.headers.iter().any(|h| h.value.contains("{{secret:"))
            && let Err(e) = self.require(Capability::Secrets)
        {
            return Ok(Err(e));
        }
        if req.body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BODY) {
            return Ok(Err(wit::Error::Invalid("request body larger than 8 MiB".into())));
        }
        let wanted = Duration::from_millis(u64::from(req.timeout_ms.unwrap_or(30_000)));
        let request = HttpRequest {
            method: req.method,
            url: req.url,
            headers: req.headers.into_iter().map(|h| (h.name, h.value)).collect(),
            body: req.body,
            timeout: wanted.min(self.remaining()),
        };
        let token = self.cancel.token();
        Ok(self
            .host
            .fetch(request, &token)
            .map(|r| net::Response {
                status: r.status,
                headers: r.headers.into_iter().map(|(name, value)| net::Header { name, value }).collect(),
                body: r.body,
            })
            .map_err(to_wit))
    }
}

impl secrets::Host for StoreData {
    fn is_set(&mut self, name: String) -> wasmtime::Result<bool> {
        Ok(self.granted.iter().any(|g| g.covers(&Capability::Secrets)) && self.host.secret_is_set(&name))
    }
}

impl StoreData {
    /// The `command` of `process.run-command` / `process.start`, checked: the
    /// program is the one the user approved, the sizes stay in the limits.
    fn command(&self, cmd: process::Command) -> Result<ProcessCommand, wit::Error> {
        self.require(Capability::Process(cmd.program.clone()))?;
        if cmd.args.len() > MAX_ARGS || cmd.args.iter().any(|a| a.len() > MAX_ARG_BYTES) {
            return Err(wit::Error::Invalid(format!("at most {MAX_ARGS} arguments of at most {MAX_ARG_BYTES} bytes")));
        }
        if cmd.env.len() > MAX_ENV {
            return Err(wit::Error::Invalid(format!("at most {MAX_ENV} environment variables")));
        }
        for (name, value) in &cmd.env {
            if name.is_empty() || name.len() > MAX_ENV_NAME || name.contains(['=', '\0']) {
                return Err(wit::Error::Invalid(format!("{name:?} is not an environment variable name")));
            }
            if value.len() > MAX_ENV_VALUE || value.contains('\0') {
                return Err(wit::Error::Invalid(format!("the value of {name:?} is too long or holds a NUL")));
            }
        }
        Ok(ProcessCommand { program: cmd.program, args: cmd.args, env: cmd.env })
    }

    /// The project a call runs in, when it named one.
    fn cwd_of(&self, cwd: Option<Resource<ProjectRes>>) -> wasmtime::Result<Option<PathBuf>> {
        Ok(match &cwd {
            Some(p) => Some(self.table.get(p)?.root.clone()),
            None => None,
        })
    }
}

fn to_chunk(chunk: ProcessChunk) -> process::Chunk {
    process::Chunk { stdout: chunk.stdout, stderr: chunk.stderr, status: chunk.status }
}

fn to_output(output: crate::types::ProcessOutput) -> process::Output {
    process::Output { status: output.status, stdout: output.stdout, stderr: output.stderr }
}

impl process::Host for StoreData {
    fn run(
        &mut self,
        program: String,
        args: Vec<String>,
        cwd: Option<Resource<ProjectRes>>,
        stdin: Option<String>,
    ) -> Fallible<process::Output> {
        let cmd = match self.command(process::Command { program, args, env: Vec::new() }) {
            Ok(cmd) => cmd,
            Err(e) => return Ok(Err(e)),
        };
        let cwd = self.cwd_of(cwd)?;
        let token = self.cancel.token();
        let timeout = self.remaining();
        Ok(self.host.run_process(cmd, cwd.as_deref(), stdin, &token, timeout).map(to_output).map_err(to_wit))
    }

    fn run_command(
        &mut self,
        cmd: process::Command,
        cwd: Option<Resource<ProjectRes>>,
        stdin: Option<String>,
    ) -> Fallible<process::Output> {
        let cmd = match self.command(cmd) {
            Ok(cmd) => cmd,
            Err(e) => return Ok(Err(e)),
        };
        let cwd = self.cwd_of(cwd)?;
        let token = self.cancel.token();
        let timeout = self.remaining();
        Ok(self.host.run_process(cmd, cwd.as_deref(), stdin, &token, timeout).map(to_output).map_err(to_wit))
    }

    fn start(&mut self, cmd: process::Command, cwd: Option<Resource<ProjectRes>>) -> Fallible<Resource<ChildRes>> {
        let cmd = match self.command(cmd) {
            Ok(cmd) => cmd,
            Err(e) => return Ok(Err(e)),
        };
        let cwd = self.cwd_of(cwd)?;
        let id = match self.host.start_process(cmd, cwd.as_deref(), self.invocation.client.as_deref()) {
            Ok(id) => id,
            Err(e) => return Ok(Err(to_wit(e))),
        };
        self.push(ChildRes { id, host: self.host.clone() }).map(Ok)
    }
}

impl process::HostChild for StoreData {
    fn poll(&mut self, this: Resource<ChildRes>, max_bytes: u32) -> Fallible<process::Chunk> {
        let id = self.table.get(&this)?.id;
        let max = (max_bytes as usize).min(MAX_CHUNK);
        Ok(self.host.poll_process(id, max).map(to_chunk).map_err(to_wit))
    }

    fn wait(&mut self, this: Resource<ChildRes>, timeout_ms: u32) -> Fallible<process::Chunk> {
        let id = self.table.get(&this)?.id;
        let timeout = Duration::from_millis(u64::from(timeout_ms)).min(self.remaining());
        let token = self.cancel.token();
        Ok(self.host.wait_process(id, MAX_CHUNK, timeout, &token).map(to_chunk).map_err(to_wit))
    }

    fn write(&mut self, this: Resource<ChildRes>, text: String) -> Fallible<()> {
        if text.len() > MAX_STDIN_BYTES {
            return Ok(Err(wit::Error::Invalid(format!("at most {MAX_STDIN_BYTES} bytes at a time"))));
        }
        let id = self.table.get(&this)?.id;
        Ok(self.host.write_process(id, &text, &self.cancel.token(), self.remaining()).map_err(to_wit))
    }

    fn close_stdin(&mut self, this: Resource<ChildRes>) -> Fallible<()> {
        let id = self.table.get(&this)?.id;
        Ok(self.host.close_process_stdin(id).map_err(to_wit))
    }

    fn kill(&mut self, this: Resource<ChildRes>) -> Fallible<()> {
        let id = self.table.get(&this)?.id;
        Ok(self.host.kill_process(id).map_err(to_wit))
    }

    fn drop(&mut self, rep: Resource<ChildRes>) -> wasmtime::Result<()> {
        self.table.delete(rep)?;
        Ok(())
    }
}

impl views::Host for StoreData {
    fn refresh(&mut self, view: String) -> wasmtime::Result<()> {
        self.host.refresh_view(&clip(view, 64));
        Ok(())
    }

    fn reveal(&mut self, view: String) -> Fallible<()> {
        if let Err(e) = self.require_interactive() {
            return Ok(Err(e));
        }
        let client = self.invocation.client.clone();
        Ok(self.host.reveal_view(client.as_deref(), &clip(view, 64)).map_err(to_wit))
    }

    fn post_message(&mut self, view: String, message: String) -> Fallible<()> {
        if message.len() > MAX_VIEW_MESSAGE {
            return Ok(Err(wit::Error::Invalid(format!("messages are limited to {MAX_VIEW_MESSAGE} bytes"))));
        }
        Ok(self.host.post_view_message(&clip(view, 64), message).map_err(to_wit))
    }

    fn open_terminal(&mut self, title: String, program: String, args: Vec<String>) -> Fallible<()> {
        if let Err(e) = self.require(Capability::Process(program.clone())) {
            return Ok(Err(e));
        }
        if args.len() > 256 || args.iter().any(|a| a.len() > 4096) {
            return Ok(Err(wit::Error::Invalid("too many or too long arguments".into())));
        }
        let cwd = self.invocation.workspace_root.clone();
        let client = self.invocation.client.clone();
        let title = clip(title, crate::runtime::MAX_TITLE);
        Ok(self.host.open_terminal(client.as_deref(), title, &program, args, cwd.as_deref()).map_err(to_wit))
    }

    fn open_location(&mut self, path: String, line: u32, column: u32) -> Fallible<()> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let Some(root) = self.invocation.workspace_root.clone() else {
            return Ok(Err(wit::Error::Invalid("no project is open in this window".into())));
        };
        let real = match sandbox::resolve_in_root(&root, &path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(wit::Error::Invalid(e))),
        };
        let client = self.invocation.client.clone();
        Ok(self.host.open_location(client.as_deref(), &real, line, column).map_err(to_wit))
    }
}

impl settings::Host for StoreData {
    fn get(&mut self, key: String) -> wasmtime::Result<Option<String>> {
        let root = self.invocation.workspace_root.clone();
        Ok(self.host.setting(root.as_deref(), &clip(key, 128)))
    }
}

impl views_bindings::openidea::plugin::view_types::Host for StoreData {}

fn file_kind(t: std::fs::FileType) -> workspace::FileKind {
    if t.is_file() {
        workspace::FileKind::File
    } else if t.is_dir() {
        workspace::FileKind::Directory
    } else if t.is_symlink() {
        workspace::FileKind::Symlink
    } else {
        workspace::FileKind::Other
    }
}

/// `project.stat` and `fs.stat`: the metadata of `real`, named `shown` in errors.
fn file_stat(real: &Path, shown: &str) -> Result<workspace::FileStat, wit::Error> {
    let meta = std::fs::symlink_metadata(real).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => wit::Error::NotFound(format!("{shown}: no such file")),
        _ => wit::Error::Failed(e.to_string()),
    })?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
    Ok(workspace::FileStat { kind: file_kind(meta.file_type()), size: meta.len(), modified })
}

/// A refused `fs` call as the plugin sees it: `denied` carries the capability
/// string, so the plugin can say exactly what its manifest lacks.
impl From<sandbox::Refusal> for wit::Error {
    fn from(refusal: sandbox::Refusal) -> Self {
        match refusal {
            sandbox::Refusal::Denied(cap) => Self::Denied(cap),
            sandbox::Refusal::Invalid(message) => Self::Invalid(message),
        }
    }
}

/// Files outside the open projects, gated by `fs.read:<path>` and
/// `fs.write:<path>` grants.
impl fs::Host for StoreData {
    fn read_file(&mut self, path: String) -> Fallible<String> {
        let real = match self.granted_file(&path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(e)),
        };
        Ok(self.host.read_text_file(&real, sandbox::MAX_READ_BYTES as usize).map_err(to_wit))
    }

    fn read_bytes(&mut self, path: String) -> Fallible<Vec<u8>> {
        use std::io::Read;
        let real = match self.granted_file(&path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(e)),
        };
        let max = sandbox::MAX_READ_BYTES;
        let read = std::fs::File::open(&real).and_then(|file| {
            let mut bytes = Vec::new();
            // One byte over: a file that grew past the limit is refused, not truncated.
            file.take(max + 1).read_to_end(&mut bytes).map(|_| bytes)
        });
        Ok(match read {
            Ok(bytes) if bytes.len() as u64 > max => {
                Err(wit::Error::Invalid(format!("{path}: larger than {} MiB", max >> 20)))
            }
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(wit::Error::NotFound(format!("{path}: no such file")))
            }
            Err(e) => Err(wit::Error::Failed(format!("{path}: {e}"))),
        })
    }

    fn stat(&mut self, path: String) -> Fallible<workspace::FileStat> {
        Ok(self.granted_file(&path).and_then(|real| file_stat(&real, &path)))
    }

    fn read_dir(&mut self, path: String) -> Fallible<Vec<fs::DirEntry>> {
        let real = match self.granted_file(&path) {
            Ok(real) => real,
            Err(e) => return Ok(Err(e)),
        };
        let read = match std::fs::read_dir(&real) {
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Err(wit::Error::NotFound(format!("{path}: no such directory"))));
            }
            Err(_) if real.is_file() => return Ok(Err(wit::Error::Invalid(format!("{path}: not a directory")))),
            Err(e) => return Ok(Err(wit::Error::Failed(format!("{path}: {e}")))),
        };
        let mut entries: Vec<fs::DirEntry> = read
            .flatten()
            .take(sandbox::MAX_LIST_ENTRIES)
            .map(|e| fs::DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                kind: e.file_type().map_or(workspace::FileKind::Other, file_kind),
            })
            .collect();
        // Sorted, so what a plugin picks doesn't depend on the disk's order.
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Ok(entries))
    }

    fn write_file(&mut self, path: String, text: String) -> Fallible<()> {
        if text.len() > sandbox::MAX_WRITE_BYTES {
            return Ok(Err(too_much_to_write(&path)));
        }
        Ok(self.writable_file(&path).and_then(|real| self.host.write_text_file(&real, &text).map_err(to_wit)))
    }

    fn write_bytes(&mut self, path: String, bytes: Vec<u8>) -> Fallible<()> {
        if bytes.len() > sandbox::MAX_WRITE_BYTES {
            return Ok(Err(too_much_to_write(&path)));
        }
        Ok(self.writable_file(&path).and_then(|real| self.host.write_bytes_file(&real, &bytes).map_err(to_wit)))
    }
}

fn too_much_to_write(path: &str) -> wit::Error {
    wit::Error::Invalid(format!("{path}: more than {} MiB to write", sandbox::MAX_WRITE_BYTES >> 20))
}

/// Largest message between a plugin and its view's frame.
const MAX_VIEW_MESSAGE: usize = 8 << 20;

pub(crate) mod indexing_bindings {
    wasmtime::component::bindgen!({
        world: "indexing", path: "../../wit",
        with: { "openidea:plugin/types": super::bindings::openidea::plugin::types },
    });
}

/// The optional `detail-provider` export.
pub(crate) mod details_bindings {
    wasmtime::component::bindgen!({
        world: "details", path: "../../wit",
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
        },
    });
}

/// The optional `commit-checker` export.
pub(crate) mod commit_checks_bindings {
    wasmtime::component::bindgen!({
        world: "commit-checks", path: "../../wit",
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
            "openidea:plugin/commit": super::bindings::openidea::plugin::commit,
        },
    });
}

pub(crate) mod semantic_bindings {
    wasmtime::component::bindgen!({
        world: "semantic-tokens", path: "../../wit",
        with: { "openidea:plugin/types": super::bindings::openidea::plugin::types },
    });
}

pub(crate) mod hover_bindings {
    wasmtime::component::bindgen!({
        world: "hover", path: "../../wit",
        with: { "openidea:plugin/types": super::bindings::openidea::plugin::types },
    });
}

pub(crate) mod inlay_bindings {
    wasmtime::component::bindgen!({
        world: "inlay-hints", path: "../../wit",
        with: { "openidea:plugin/types": super::bindings::openidea::plugin::types },
    });
}

pub(crate) mod endpoints_bindings {
    wasmtime::component::bindgen!({
        world: "endpoints", path: "../../wit",
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/workspace": super::bindings::openidea::plugin::workspace,
            "openidea:plugin/editor": super::bindings::openidea::plugin::editor,
            "openidea:plugin/invocation": super::bindings::openidea::plugin::invocation,
        },
    });
}

/// The optional `file-actions` export.
pub(crate) mod file_actions_bindings {
    wasmtime::component::bindgen!({
        world: "file-actions-provider", path: "../../wit",
        with: { "openidea:plugin/types": super::bindings::openidea::plugin::types },
    });
}

/// Paths belong to the UI machine, which can have a different OS than the plugin host.
fn validate_ui_path(path: &str) -> Result<(), wit::Error> {
    let b = path.as_bytes();
    let absolute = path.starts_with('/')
        || path.starts_with("\\\\")
        || (b.first().is_some_and(u8::is_ascii_alphabetic)
            && b.get(1) == Some(&b':')
            && matches!(b.get(2), Some(b'/' | b'\\')));
    if !absolute || path.len() > 8192 || path.chars().any(char::is_control) {
        return Err(wit::Error::Invalid("expected an absolute UI directory path of at most 8192 bytes".into()));
    }
    Ok(())
}

#[cfg(test)]
mod project_ui_tests {
    use super::validate_ui_path;
    #[test]
    fn validates_ui_paths_without_using_the_plugin_hosts_os() {
        for path in ["/work/repo", "C:/work/repo", r"C:\work\repo", r"\\server\share\repo"] {
            assert!(validate_ui_path(path).is_ok(), "{path:?}");
        }
        for path in ["repo", "C:repo", "/bad\npath", ""] {
            assert!(validate_ui_path(path).is_err(), "{path:?}");
        }
        assert!(validate_ui_path(&format!("/{}", "x".repeat(8192))).is_err());
    }
}

pub(crate) mod diagnostics_bindings {
    wasmtime::component::bindgen!({
        world: "editor-diagnostics", path: "../../wit",
        with: {
            "openidea:plugin/types": super::bindings::openidea::plugin::types,
            "openidea:plugin/diagnostics": super::bindings::openidea::plugin::diagnostics,
        },
    });
}

pub(crate) fn diagnostics_from_wit(items: Vec<diagnostics::Diagnostic>, source: &str) -> Vec<ide_core::Diagnostic> {
    items
        .into_iter()
        .take(MAX_DIAGNOSTICS)
        .map(|d| ide_core::Diagnostic {
            range: ide_core::Range::new(pos(d.range.start), pos(d.range.end)),
            severity: match d.severity {
                diagnostics::Severity::Error => ide_core::Severity::Error,
                diagnostics::Severity::Warning => ide_core::Severity::Warning,
                diagnostics::Severity::Info => ide_core::Severity::Info,
                diagnostics::Severity::Hint => ide_core::Severity::Hint,
            },
            message: clip(d.message, 4096),
            source: Some(d.source.map_or_else(|| source.to_owned(), |s| clip(s, 128))),
            code: d.code.map(|c| clip(c, 128)),
            unnecessary: d.tags.iter().any(|t| t == "unnecessary"),
            deprecated: d.tags.iter().any(|t| t == "deprecated"),
            server: Some(source.to_owned()),
        })
        .collect()
}
