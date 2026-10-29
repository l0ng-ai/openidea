//! The backend → UI event bus.
//!
//! Feature crates emit through an [`EventSink`]; `src-tauri` implements it by
//! forwarding to the webview as the single `ide://event` Tauri event. High
//! volume streams (terminal bytes, search hits, process output) do *not* use
//! this bus; they use per-request `tauri::ipc::Channel`s.

use crate::{DebugSessionId, Diagnostic, DocId, RunId, ServerId, TaskId, TerminalId, TextChange};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IdeEvent {
    /// Files or directories changed on disk (after debouncing, ignore rules applied).
    FsChanged {
        created: Vec<crate::IpcPath>,
        modified: Vec<crate::IpcPath>,
        removed: Vec<crate::IpcPath>,
    },
    /// The backend changed a document (reload from disk, formatting, refactoring).
    /// The UI applies `changes` on top of `base_version`, yielding `version`.
    DocPatched {
        doc: DocId,
        base_version: u32,
        version: u32,
        changes: Vec<TextChange>,
    },
    /// A document's dirty flag changed (saved / modified externally).
    DocDirty {
        doc: DocId,
        dirty: bool,
    },
    /// An open document's language changed (Settings › File Types, Override File Type).
    DocLanguage {
        doc: DocId,
        language: crate::LanguageId,
    },
    /// Full replacement of diagnostics for one file from one producer.
    Diagnostics {
        path: crate::IpcPath,
        source: String,
        items: Vec<Diagnostic>,
    },
    /// Progress of a background task; `fraction` is `None` when indeterminate.
    Task {
        id: TaskId,
        title: String,
        message: Option<String>,
        fraction: Option<f32>,
        done: bool,
        /// The UI may stop it with `cancel_task(id)` (see [`crate::task`]).
        cancellable: bool,
    },
    /// Project indexing state changed (dumb mode on/off).
    IndexState {
        indexing: bool,
        files: u32,
        symbols: u32,
    },
    /// Git status / branch information should be refreshed.
    VcsChanged {
        root: crate::IpcPath,
    },
    LanguageServer {
        server: ServerId,
        name: String,
        status: ServerStatus,
        message: Option<String>,
    },
    /// A stopped language server left the project's list (disabled in settings, or a
    /// fallback that a preferred server took over from again).
    LanguageServerRemoved {
        server: ServerId,
    },
    /// A language server asked clients to re-request one kind of data for its
    /// open documents (`workspace/inlayHint/refresh`, …), e.g. after indexing.
    LspRefresh {
        server: ServerId,
        kind: LspRefreshKind,
    },
    TerminalExited {
        terminal: TerminalId,
        code: Option<i32>,
    },
    RunExited {
        run: RunId,
        code: Option<i32>,
    },
    Debug {
        session: DebugSessionId,
        event: DebugEvent,
    },
    Notify {
        level: NotifyLevel,
        title: String,
        body: Option<String>,
    },
    /// A setting was written (any window); the windows it concerns (all for a
    /// global value, the project's for a project value) re-read their effective settings.
    SettingsChanged {
        key: String,
    },
    /// The project's source / test / resource / excluded roots changed (build files
    /// changed or folders were marked); the UI re-reads them with `project_roots`.
    ProjectRootsChanged {
        root: crate::IpcPath,
    },
    /// A child process (`ssh`, `git`) asks for a credential; answered with `ssh_askpass_answer`.
    Askpass {
        id: u64,
        prompt: String,
        kind: AskpassKind,
    },
    /// Prompt `id` was answered (in any window) or gave up.
    AskpassDone {
        id: u64,
    },
    /// The kernel of an open notebook changed state (`starting`, `idle`, `busy`,
    /// `dead`); `message` says why it failed to start or died.
    NotebookKernel {
        /// Backend document incarnation; stale queued events cannot target a reopen.
        id: String,
        path: crate::IpcPath,
        state: String,
        message: Option<String>,
    },
}

/// What an askpass prompt asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AskpassKind {
    /// Password or passphrase: hidden input.
    Secret,
    /// User name: visible input.
    Text,
    /// Yes / no (an unknown host key); answered with `yes` or `no`.
    Confirm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ServerStatus {
    Starting,
    Ready,
    Busy,
    Crashed,
    Stopped,
    Missing,
    /// Not started: its configuration can't launch it (e.g. no JDK new enough);
    /// the message says what to change, and a settings change retries.
    Misconfigured,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LspRefreshKind {
    InlayHints,
    SemanticTokens,
    CodeLens,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NotifyLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DebugEvent {
    /// First event of every session (only build output of a root session's
    /// `cargo` step can precede it). `parent` is set for adapter-started child sessions.
    Started {
        name: String,
        adapter: String,
        parent: Option<DebugSessionId>,
    },
    Initialized,
    Stopped {
        thread_id: i64,
        reason: String,
        description: Option<String>,
        all_threads_stopped: bool,
    },
    Continued {
        thread_id: i64,
        all_threads_continued: bool,
    },
    Output {
        category: String,
        output: String,
    },
    Thread {
        thread_id: i64,
        started: bool,
    },
    BreakpointsChanged {
        path: crate::IpcPath,
    },
    Terminated,
    Exited {
        code: i32,
    },
    /// java-debug's `hotcodereplace` event: `change_type` is `BUILD_COMPLETE` (classes
    /// changed and can be reloaded), `STARTING`, `END`, `WARNING` or `ERROR`.
    HotCodeReplace {
        change_type: String,
        message: String,
    },
}

/// Where backend crates publish [`IdeEvent`]s. Cheap to clone via `Arc`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: IdeEvent);
}

impl<F: Fn(IdeEvent) + Send + Sync + 'static> EventSink for F {
    fn emit(&self, event: IdeEvent) {
        self(event)
    }
}

pub type SharedSink = Arc<dyn EventSink>;

/// Discards events; for tests and headless tools.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _: IdeEvent) {}
}
