//! Types shared by the runtime and the host.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

/// The focused editor of the window a command came from.
#[derive(Clone, Debug, Default)]
pub struct EditorContext {
    pub path: PathBuf,
    pub language: String,
    /// Selections when the command was invoked (cursors are empty ranges).
    pub selections: Vec<ide_core::Range>,
}

/// Where a command or event batch comes from: the window and its project.
#[derive(Clone, Debug, Default)]
pub struct Invocation {
    /// Plugin instances waiting on this command chain; never re-enter one.
    pub command_chain: Vec<String>,
    pub client: Option<String>,
    pub workspace_root: Option<PathBuf>,
    /// Settings actions can read the global layer while retaining their project context.
    pub global_settings: bool,
    pub editor: Option<EditorContext>,
    /// Files and folders the command was run on.
    pub selected_paths: Vec<PathBuf>,
}

/// A failed host call, as the plugin sees it (WIT `types.error`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostError {
    /// Not granted; names the capability.
    Denied(String),
    /// The document changed since the version an edit was made for.
    Stale,
    NotFound(String),
    Invalid(String),
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(c) => write!(f, "permission denied: {c} is not granted"),
            Self::Stale => f.write_str("the document changed"),
            Self::NotFound(m) => write!(f, "not found: {m}"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

/// A plugin's status bar item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusItem {
    pub text: String,
    pub tooltip: Option<String>,
    /// One of the plugin's commands, run on click.
    pub command: Option<String>,
}

/// An entry of a plugin's `pick` or `pick-many`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickItem {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
}

/// What a plugin asks the user (`ui.pick`, `ui.pick-many`, `ui.input`,
/// `ui.input-multiline`, `ui.confirm`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Prompt {
    #[serde(rename_all = "camelCase")]
    QuickPick { title: String, items: Vec<PickItem>, multiple: bool },
    #[serde(rename_all = "camelCase")]
    Input { prompt: String, value: Option<String>, multiline: bool },
    #[serde(rename_all = "camelCase")]
    Confirm { title: String, message: String },
    #[serde(rename_all = "camelCase")]
    PickDirectory { title: String, initial: Option<String> },
    /// The host's own question under `net:ask` (never plugin-initiated): the
    /// plugin reached an HTTPS host its manifest does not list.
    #[serde(rename_all = "camelCase")]
    NetPermission { host: String, session_only: bool },
}

/// Kinds of workbench events a plugin can subscribe to (`on-event:<kind>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    FileClosed,
    SettingsChanged,
    InputModeChanged,
    RunExited,
    TerminalExited,
    ContentTabAction,
    ExtensionsChanged,
    FileOpened,
    FileSaved,
    FilesChanged,
    EditorFocused,
    ActionPerformed,
    VcsChanged,
    Scheduled,
}

impl EventKind {
    pub const ALL: [Self; 14] = [
        Self::FileClosed,
        Self::SettingsChanged,
        Self::InputModeChanged,
        Self::RunExited,
        Self::TerminalExited,
        Self::ContentTabAction,
        Self::ExtensionsChanged,
        Self::FileOpened,
        Self::FileSaved,
        Self::FilesChanged,
        Self::EditorFocused,
        Self::ActionPerformed,
        Self::VcsChanged,
        Self::Scheduled,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::FileClosed => "file-closed",
            Self::SettingsChanged => "settings-changed",
            Self::InputModeChanged => "input-mode-changed",
            Self::RunExited => "run-exited",
            Self::TerminalExited => "terminal-exited",
            Self::ContentTabAction => "content-tab-action",
            Self::ExtensionsChanged => "extensions-changed",
            Self::FileOpened => "file-opened",
            Self::FileSaved => "file-saved",
            Self::FilesChanged => "files-changed",
            Self::EditorFocused => "editor-focused",
            Self::ActionPerformed => "action-performed",
            Self::VcsChanged => "vcs-changed",
            Self::Scheduled => "scheduled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.name() == s)
    }

    /// The capability a subscription needs (`None`: `scheduled`, which the
    /// manifest declares).
    pub fn capability(self) -> Option<ide_extension::Capability> {
        match self {
            Self::ActionPerformed | Self::InputModeChanged => Some(ide_extension::Capability::InputEvents),
            Self::Scheduled
            | Self::RunExited
            | Self::TerminalExited
            | Self::ContentTabAction
            | Self::ExtensionsChanged => None,
            _ => Some(ide_extension::Capability::Events),
        }
    }
}

/// How the user started an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ActionSource {
    Keyboard,
    Menu,
    Toolbar,
    ContextMenu,
    Search,
    Other,
}

impl ActionSource {
    /// As plugins see it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Keyboard => "keyboard",
            Self::Menu => "menu",
            Self::Toolbar => "toolbar",
            Self::ContextMenu => "context-menu",
            Self::Search => "search",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActionPerformed {
    pub action: String,
    pub title: String,
    pub source: ActionSource,
    pub shortcut: Option<String>,
}

/// Debounced worktree changes. Paths use the same absolute form as `file-saved`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FilesChanged {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

/// The focused editor's input mode and optional visual sub-mode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InputMode {
    pub path: String,
    pub mode: String,
    pub sub: Option<String>,
}

/// A workbench event delivered to plugins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum WorkbenchEvent {
    RunExited(crate::RunExited),
    TerminalExited(crate::TerminalExited),
    ContentTabAction(crate::ContentTabAction),
    FileClosed(String),
    SettingsChanged(Vec<String>),
    /// Ids of extension points the receiving plugin declares whose contributions changed.
    ExtensionsChanged(Vec<String>),
    InputModeChanged(InputMode),
    FileOpened(String),
    FileSaved(String),
    FilesChanged(FilesChanged),
    EditorFocused(Option<String>),
    ActionPerformed(ActionPerformed),
    VcsChanged(String),
    Scheduled,
}

impl WorkbenchEvent {
    pub fn kind(&self) -> EventKind {
        match self {
            Self::RunExited(_) => EventKind::RunExited,
            Self::TerminalExited(_) => EventKind::TerminalExited,
            Self::ContentTabAction(_) => EventKind::ContentTabAction,
            Self::FileClosed(_) => EventKind::FileClosed,
            Self::SettingsChanged(_) => EventKind::SettingsChanged,
            Self::ExtensionsChanged(_) => EventKind::ExtensionsChanged,
            Self::InputModeChanged(_) => EventKind::InputModeChanged,
            Self::FileOpened(_) => EventKind::FileOpened,
            Self::FileSaved(_) => EventKind::FileSaved,
            Self::FilesChanged(_) => EventKind::FilesChanged,
            Self::EditorFocused(_) => EventKind::EditorFocused,
            Self::ActionPerformed(_) => EventKind::ActionPerformed,
            Self::VcsChanged(_) => EventKind::VcsChanged,
            Self::Scheduled => EventKind::Scheduled,
        }
    }
}

/// State of the repository containing a project (WIT `vcs.repository-status`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepositoryStatus {
    pub root: String,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub operation: Option<String>,
    pub changed_files: u32,
}

/// A file a pending commit changes (WIT `commit.commit-change`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitChange {
    pub repository: String,
    pub path: String,
    pub old_path: Option<String>,
    /// `added`, `modified`, `deleted`, `renamed`, `copied` or `type-changed`.
    pub status: String,
    /// `git diff` of the included changes; `None` for binary content.
    pub diff: Option<String>,
    pub truncated: bool,
}

/// What Commit would commit (WIT `commit.commit-draft`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDraft {
    pub revision: u64,
    pub message: String,
    pub amend: bool,
    pub changes: Vec<CommitChange>,
}

/// A problem a plugin's before-commit check reported (WIT `commit-checker.commit-problem`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitProblem {
    pub message: String,
    /// Absolute path of the file it is in, if any (IPC form).
    pub path: Option<String>,
    pub range: Option<ide_core::Range>,
}

/// Resource limits and supervision policy for plugin code.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Wasm fuel (≈ instructions) per host → plugin call.
    pub fuel: u64,
    /// Wall-clock limit of commands, events, activation and deactivation.
    pub timeout: Duration,
    /// Wall-clock limit of a call that began a task (`tasks.begin`).
    pub background: Duration,
    /// Edit-path calls (syntax): the caller stops waiting after this and the
    /// result is dropped; the plugin keeps its instance.
    pub edit_soft: Duration,
    /// Edit-path calls still running after this are interrupted (the instance
    /// is rebuilt on next use).
    pub edit_hard: Duration,
    /// Linear memory cap per plugin.
    pub memory_bytes: usize,
    /// Wait before restarting after a crash; doubles with each consecutive crash.
    pub restart_backoff: Duration,
    /// Consecutive crashes after which the plugin is stopped for the session.
    pub max_failures: u32,
    /// Instances unused for this long are reclaimed (`None`: kept).
    pub idle_timeout: Option<Duration>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fuel: 5_000_000_000,
            timeout: Duration::from_secs(5),
            background: Duration::from_secs(60),
            edit_soft: Duration::from_millis(50),
            edit_hard: Duration::from_millis(500),
            memory_bytes: 256 << 20,
            restart_backoff: Duration::from_secs(1),
            max_failures: 3,
            idle_timeout: Some(Duration::from_secs(300)),
        }
    }
}

impl Limits {
    /// Delay before the restart that follows the `failures`-th consecutive crash.
    pub fn backoff(&self, failures: u32) -> Duration {
        let factor = 1u32 << failures.saturating_sub(1).min(6);
        (self.restart_backoff * factor).min(Duration::from_secs(60).max(self.restart_backoff))
    }
}

/// A highlighted range from a plugin's `syntax-provider` (UTF-8 byte offsets).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxToken {
    pub start: u32,
    pub end: u32,
    pub kind: String,
}

/// A structure-view symbol from a plugin's `syntax-provider` (UTF-8 byte offsets).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: String,
    pub start: u32,
    pub end: u32,
    pub name_start: u32,
    pub name_end: u32,
    /// Index of the enclosing symbol in the same list.
    pub parent: Option<u32>,
}

/// A foldable line range from a plugin's `syntax-provider`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxFold {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: String,
}

/// An HTTP request from a plugin (WIT `net.request`); headers may hold
/// `{{secret:<name>}}` placeholders for the host to fill in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    /// Grants checked again before following a redirect.
    pub grants: Vec<ide_extension::Capability>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// What a one-off process printed (WIT `process.output`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// What to run: the approved file of `process:<program>`, its arguments and
/// the environment to add to the inherited one (WIT `process.command`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessCommand {
    /// The invoking project whose executable override applies, independent of cwd.
    pub approval_root: Option<PathBuf>,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// What a kept-running program printed since the last read, and its exit
/// status once it ended (WIT `process.chunk`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessChunk {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
}

/// Where `net:` requests may go: the URL's host when it is `https`, or
/// `http` to the loopback interface.
pub fn net_host(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme {:?}", parsed.scheme()));
    }
    match parsed.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if host.is_empty() || host.contains('*') {
                return Err("URL must name one exact host".into());
            }
            Ok(host)
        }
        Some(url::Host::Ipv4(host)) => Ok(host.to_string()),
        Some(url::Host::Ipv6(host)) => Ok(host.to_string()),
        None => Err("URL has no host".into()),
    }
}

/// The grant required by a URL; loopback HTTP retains the original `net:` rule.
pub fn net_capability(url: &str) -> Result<ide_extension::Capability, String> {
    let host = net_host(url)?;
    if url::Url::parse(url).is_ok_and(|u| u.scheme() == "http")
        && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1")
    {
        Ok(ide_extension::Capability::NetHttp(host))
    } else {
        Ok(ide_extension::Capability::Net(host))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_restart_backoff_doubles_up_to_a_minute() {
        let limits = Limits { restart_backoff: Duration::from_millis(150), ..Limits::default() };
        let waits: Vec<u128> = (1..=4).map(|n| limits.backoff(n).as_millis()).collect();
        assert_eq!(waits, [150, 300, 600, 1200]);
        assert_eq!(limits.backoff(30), Duration::from_millis(150 * 64), "the factor stops growing");
        let long = Limits { restart_backoff: Duration::from_secs(10), ..Limits::default() };
        assert_eq!(long.backoff(5), Duration::from_secs(60));
    }

    use super::*;

    #[test]
    fn net_hosts() {
        assert_eq!(net_host("https://API.example.com:8443/v1?x").unwrap(), "api.example.com");
        assert_eq!(net_host("http://localhost:11434/api").unwrap(), "localhost");
        assert_eq!(net_host("https://user:pw@h.io/").unwrap(), "h.io");
        assert_eq!(
            net_capability("http://example.com/").unwrap(),
            ide_extension::Capability::NetHttp("example.com".into())
        );
        for (url, host) in [
            ("https://EXAMPLE.com.:8443/", "example.com"),
            ("https://bücher.example/", "xn--bcher-kva.example"),
            ("https://xn--bcher-kva.example/", "xn--bcher-kva.example"),
            ("https://127.1/", "127.0.0.1"),
            ("https://[0:0:0:0:0:0:0:1]:8443/", "::1"),
            ("https://sub.example.com/", "sub.example.com"),
        ] {
            assert_eq!(net_host(url).unwrap(), host);
        }
        assert_ne!(net_host("https://аpi.example/").unwrap(), net_host("https://api.example/").unwrap());
        assert!(net_host("file:///etc/passwd").is_err());
        assert!(net_host("example.com").is_err());
        assert!(net_host("https://*.example.com/").is_err());
        assert!(net_host("https://./").is_err());
    }
}

/// The document a provider request is about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderDocument {
    pub path: PathBuf,
    pub language: String,
    pub version: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename = "PluginLocation")]
pub struct Location {
    pub path: PathBuf,
    pub range: ide_core::Range,
}

/// A symbol in the current project index. Ranges use UTF-16 columns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub location: Location,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletionItem {
    pub label: String,
    pub detail: Option<String>,
    /// WIT `completion-kind` name (`method`, `keyword`, …).
    pub kind: Option<String>,
    pub insert_text: String,
    /// `insert_text` has tab stops and placeholders.
    pub snippet: bool,
    pub replace: Option<ide_core::Range>,
    pub sort_text: Option<String>,
    pub filter_text: Option<String>,
    pub documentation: Option<String>,
    /// Applied with the item elsewhere in the document (an import).
    pub additional_edits: Vec<ide_core::TextEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineSuggestion {
    pub insert_text: String,
    pub replace: Option<ide_core::Range>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub preferred: bool,
    pub edits: Vec<(PathBuf, Vec<ide_core::TextEdit>)>,
    /// Applied before `edits`, in one workspace edit with them.
    pub operations: Vec<FileOperation>,
    /// Opened once the action is applied.
    pub open: Option<PathBuf>,
    /// The plugin's reference: the edits come from `resolve_code_action`.
    pub data: Option<String>,
    /// Listed by the `file-actions` export, which also resolves it.
    pub file_action: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOperation {
    Create { path: PathBuf, text: String, overwrite: bool },
    Rename { from: PathBuf, to: PathBuf },
    Delete { path: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineMarker {
    pub line: u32,
    pub icon: Option<String>,
    pub tooltip: String,
    pub target: Option<Location>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticToken {
    pub range: ide_core::Range,
    pub kind: String,
    pub modifiers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginHover {
    pub markdown: String,
    pub range: Option<ide_core::Range>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginInlayHint {
    pub position: ide_core::Pos,
    pub label: String,
    pub kind: String,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

// ---- declarative views (wit/views.wit) ---------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewButton {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewTreeItem {
    pub key: String,
    pub parent: Option<String>,
    pub label: String,
    pub icon: Option<String>,
    pub detail: Option<String>,
    pub expandable: bool,
    pub expanded: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewListItem {
    pub key: String,
    pub label: String,
    pub icon: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum FieldValue {
    Label(String),
    ReadonlyText { text: String, multiline: bool },
    Text(String),
    Multiline(String),
    Checkbox(bool),
    Choice { options: Vec<String>, selected: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewField {
    pub key: String,
    pub label: String,
    pub value: FieldValue,
}

/// A sortable table's order: the column and the direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableSort {
    pub column: u32,
    pub descending: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewTable {
    pub columns: Vec<String>,
    pub total_rows: u32,
    pub first_row: u32,
    pub rows: Vec<Vec<String>>,
    pub editable: bool,
    /// The plugin opted its headers in to click-to-sort (a `table` body through `other`).
    pub sortable: bool,
    /// The sort the plugin orders by (none: no arrow yet).
    pub sort: Option<TableSort>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ViewBody {
    Message(String),
    Tree(Vec<ViewTreeItem>),
    List(Vec<ViewListItem>),
    Form(Vec<ViewField>),
    Table(ViewTable),
    Html(String),
}

/// What a view or custom editor shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub toolbar: Vec<ViewButton>,
    pub body: ViewBody,
    pub status: Option<String>,
}

/// A tab of the Services pane of a plugin's node (`detail-provider.detail`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTab {
    pub id: String,
    pub label: String,
    pub body: ServicePane,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ServicePane {
    Message(String),
    /// Read-only text that can be selected and copied.
    Text(String),
    /// A program the IDE runs (with the plugin's `process:` grant), followed in a log.
    Log(ServiceLog),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLog {
    pub program: String,
    pub args: Vec<String>,
    pub toggles: Vec<ServiceLogToggle>,
}

/// A switch above the log; when on, `args` are appended and the program restarts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLogToggle {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
}

/// The table rows the UI shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub first_row: u32,
    pub rows: u32,
}

/// A user action in a view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ViewEvent {
    Button { id: String },
    Activate { key: String },
    Select { key: String },
    Expand { key: String },
    Collapse { key: String },
    Field { key: String, value: String },
    Cell { row: u32, column: u32, value: String },
    InsertRow { before: u32 },
    DeleteRows { rows: Vec<u32> },
    Message { text: String },
    // A sortable table's header click: the column and the direction (leaves
    // as an `other` view-event, kind `sort`). See `TableSort`.
    Sort { column: u32, descending: bool },
    TableSelect { row: u32 },
    TableActivate { row: u32 },
}

/// A plugin's HTTP route declaration in a project.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub method: Option<String>,
    pub path: String,
    pub framework: String,
    pub handler: Option<String>,
    pub location: Location,
}

/// A notification button that runs one of the publishing plugin's commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub label: String,
    pub command: String,
    pub argument: Option<String>,
}

/// An open editor reported by its window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenEditor {
    pub path: String,
    pub language: String,
    pub dirty: bool,
    pub active: bool,
}
/// Find in Files options.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}
/// A search hit, using UTF-16 coordinates.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TextMatch {
    pub location: Location,
    pub line: String,
}
/// Bounded search results.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextSearch {
    pub matches: Vec<TextMatch>,
    pub limit_hit: bool,
}
/// A file's problems from one producer.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FileProblems {
    pub path: String,
    pub source: String,
    pub diagnostics: Vec<ide_core::Diagnostic>,
}
/// An editor decoration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct Decoration {
    pub range: ide_core::Range,
    pub style: String,
    pub hover: Option<String>,
    pub after: Option<String>,
}
/// A tree decoration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct FileDecoration {
    pub badge: Option<String>,
    pub style: String,
    pub tooltip: Option<String>,
}
/// Commit metadata, date in Unix seconds.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub author_email: String,
    pub date: i64,
    pub subject: String,
    pub body: String,
    pub parents: Vec<String>,
}
/// One zero-based line's attribution, date in Unix seconds.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct BlameLine {
    pub line: u32,
    pub commit: String,
    pub author: String,
    pub date: i64,
    pub summary: String,
}

/// Non-secret settings of a plugin-owned project database source (API 1.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataSource {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub url: Option<String>,
    pub options: Vec<(String, String)>,
}
