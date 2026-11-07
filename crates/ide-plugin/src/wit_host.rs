//! The host side of the `openidea:plugin@1.0.0` world: bindings, resource
//! types and the implementation of every import. Capabilities are checked
//! here; a missing one returns `error::denied` (the plugin can degrade).

use crate::runtime::{MAX_TITLE, StoreData, clip};
use crate::sandbox;
use crate::types::{
    EditorContext, EventKind, HostError, HttpRequest, NotificationLevel, PickItem, Prompt, StatusItem, net_host,
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
            "openidea:plugin/views": super::bindings::openidea::plugin::views,
            "openidea:plugin/settings": super::bindings::openidea::plugin::settings,
        },
    });
}

use bindings::openidea::plugin::{
    commit, diagnostics, editor, events, invocation, log, net, process, secrets, settings, storage, tasks,
    types as wit, ui, vcs, views, workspace,
};

/// A project handle: its root.
pub struct ProjectRes {
    root: PathBuf,
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
        self.require_interactive()?;
        let client = self.invocation.client.clone();
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

    /// Dialogs belong to commands and events; rendering and providers have no one to ask.
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
        let meta = match std::fs::symlink_metadata(&real) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Err(wit::Error::NotFound(format!("{path}: no such file"))));
            }
            Err(e) => return Ok(Err(wit::Error::Failed(e.to_string()))),
        };
        let kind = if meta.is_file() {
            workspace::FileKind::File
        } else if meta.is_dir() {
            workspace::FileKind::Directory
        } else if meta.is_symlink() {
            workspace::FileKind::Symlink
        } else {
            workspace::FileKind::Other
        };
        let modified =
            meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
        Ok(Ok(workspace::FileStat { kind, size: meta.len(), modified }))
    }

    fn find_files(&mut self, this: Resource<ProjectRes>, glob: String, limit: u32) -> Fallible<Vec<String>> {
        if let Err(e) = self.require(Capability::ProjectRead) {
            return Ok(Err(e));
        }
        let root = self.table.get(&this)?.root.clone();
        Ok(self.host.find_files(&root, &glob, limit.min(MAX_FIND) as usize).map_err(to_wit))
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
        let extended = self.call_started + self.limits.background;
        if extended > self.deadline {
            self.deadline = extended;
            self.timeout = self.limits.background;
        }
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
        let source = self.plugin_id.clone();
        let items = items
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
                source: Some(d.source.map_or_else(|| source.clone(), |s| clip(s, 128))),
                code: d.code.map(|c| clip(c, 128)),
                unnecessary: d.tags.iter().any(|t| t == "unnecessary"),
                deprecated: d.tags.iter().any(|t| t == "deprecated"),
                server: Some(source.clone()),
            })
            .collect();
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

impl process::Host for StoreData {
    fn run(
        &mut self,
        program: String,
        args: Vec<String>,
        cwd: Option<Resource<ProjectRes>>,
        stdin: Option<String>,
    ) -> Fallible<process::Output> {
        if let Err(e) = self.require(Capability::Process(program.clone())) {
            return Ok(Err(e));
        }
        let cwd = match &cwd {
            Some(p) => Some(self.table.get(p)?.root.clone()),
            None => None,
        };
        let token = self.cancel.token();
        let timeout = self.remaining();
        Ok(self
            .host
            .run_process(&program, args, cwd.as_deref(), stdin, &token, timeout)
            .map(|o| process::Output { status: o.status, stdout: o.stdout, stderr: o.stderr })
            .map_err(to_wit))
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

/// Largest message between a plugin and its view's frame.
const MAX_VIEW_MESSAGE: usize = 1 << 20;

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
