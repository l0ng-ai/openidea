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
    pub client: Option<String>,
    pub workspace_root: Option<PathBuf>,
    pub editor: Option<EditorContext>,
    /// Files and folders the command was run on.
    pub selected_paths: Vec<PathBuf>,
}

/// A failed host call, as the plugin sees it (WIT `types.error`).
#[derive(Clone, Debug, PartialEq, Eq)]
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
}

/// Kinds of workbench events a plugin can subscribe to (`on-event:<kind>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    FileOpened,
    FileSaved,
    EditorFocused,
    ActionPerformed,
    VcsChanged,
    Scheduled,
}

impl EventKind {
    pub const ALL: [Self; 6] = [
        Self::FileOpened,
        Self::FileSaved,
        Self::EditorFocused,
        Self::ActionPerformed,
        Self::VcsChanged,
        Self::Scheduled,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::FileOpened => "file-opened",
            Self::FileSaved => "file-saved",
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
            Self::ActionPerformed => Some(ide_extension::Capability::InputEvents),
            Self::Scheduled => None,
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

/// A workbench event delivered to plugins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum WorkbenchEvent {
    FileOpened(String),
    FileSaved(String),
    EditorFocused(Option<String>),
    ActionPerformed(ActionPerformed),
    VcsChanged(String),
    Scheduled,
}

impl WorkbenchEvent {
    pub fn kind(&self) -> EventKind {
        match self {
            Self::FileOpened(_) => EventKind::FileOpened,
            Self::FileSaved(_) => EventKind::FileSaved,
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

/// Where `net:` requests may go: the URL's host when it is `https`, or
/// `http` to the loopback interface.
pub fn net_host(url: &str) -> Result<String, String> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| format!("{url:?} is not an absolute URL"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default().to_owned()
    } else {
        authority.split(':').next().unwrap_or_default().to_ascii_lowercase()
    };
    if host.is_empty() {
        return Err(format!("{url:?} has no host"));
    }
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => Ok(host),
        "http" if loopback => Ok(host),
        "http" => Err(format!("{url:?}: plain http is only allowed to localhost")),
        other => Err(format!("{url:?}: unsupported scheme {other:?}")),
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
        assert!(net_host("http://example.com/").is_err());
        assert!(net_host("file:///etc/passwd").is_err());
        assert!(net_host("example.com").is_err());
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub path: PathBuf,
    pub range: ide_core::Range,
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
    /// The plugin's reference: the edits come from `resolve_code_action`.
    pub data: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewTable {
    pub columns: Vec<String>,
    pub total_rows: u32,
    pub first_row: u32,
    pub rows: Vec<Vec<String>>,
    pub editable: bool,
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
}
