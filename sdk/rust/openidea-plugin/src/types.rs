//! Plain data types of the API (independent of the target).

/// Why a host call failed. A capability that is not granted is `Denied`:
/// degrade gracefully (show what you can) instead of failing the command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Not granted; names the capability (`editor.write`).
    Denied(String),
    /// The document changed since the version the edit was made for.
    Stale,
    NotFound(String),
    Invalid(String),
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(c) => write!(f, "permission denied: {c} is not granted"),
            Self::Stale => f.write_str("the document changed in the meantime"),
            Self::NotFound(m) => write!(f, "not found: {m}"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.to_string()
    }
}

/// A plain message is [`Error::Failed`].
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_owned())
    }
}

/// Log level of [`crate::host::log`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// Severity of [`crate::host::notify`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

/// 0-based line and UTF-16 code unit column (as in the editor and LSP).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

impl Position {
    pub const fn new(line: u32, character: u32) -> Self {
        Self { line, character }
    }
}

/// Half-open range; a cursor is an empty range.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub const fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub range: Range,
    pub text: String,
}

/// A symbol from the host's current in-memory project index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolInfo {
    pub name: String,
    /// Host symbol kind in camelCase (`class`, `method`, `enumMember`, …).
    pub kind: String,
    pub container: Option<String>,
    pub location: Location,
}

/// An editor's document at one version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub version: u64,
    pub text: String,
}

impl Document {
    /// The text of `range` (UTF-16 columns), if it lies inside the document.
    pub fn text_in(&self, range: Range) -> Option<&str> {
        let start = crate::text::offset(&self.text, range.start)?;
        let end = crate::text::offset(&self.text, range.end)?;
        self.text.get(start.min(end)..end.max(start))
    }
}

/// What `activate` receives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub plugin_id: String,
    pub plugin_version: String,
    /// Plugin API version the host implements.
    pub api_version: String,
    /// Capabilities granted to the plugin (`project.read`, …).
    pub capabilities: Vec<String>,
}

impl Context {
    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusItem {
    pub text: String,
    pub tooltip: Option<String>,
    /// One of the plugin's commands, run on click.
    pub command: Option<String>,
}

/// An entry of [`crate::host::pick`] and [`crate::host::pick_many`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickItem {
    /// Returned when the item is chosen.
    pub key: String,
    pub label: String,
    pub description: Option<String>,
}

impl PickItem {
    pub fn new(key: &str, label: &str) -> Self {
        Self { key: key.to_owned(), label: label.to_owned(), description: None }
    }

    pub fn description(mut self, description: &str) -> Self {
        self.description = Some(description.to_owned());
        self
    }
}

/// A context key's value, as `when` clauses compare it ([`crate::host::set_context`]).
#[derive(Clone, Debug, PartialEq)]
pub enum ContextValue {
    Flag(bool),
    /// A finite number.
    Number(f64),
    /// At most 1024 bytes.
    Text(String),
}

impl From<bool> for ContextValue {
    fn from(value: bool) -> Self {
        Self::Flag(value)
    }
}

impl From<f64> for ContextValue {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}

impl From<&str> for ContextValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for ContextValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

/// Kinds of workbench events; later SDKs add more.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum EventKind {
    FileClosed,
    SettingsChanged,
    InputModeChanged,
    RunExited,
    TerminalExited,
    ContentTabAction,
    FileOpened,
    FileSaved,
    FilesChanged,
    EditorFocused,
    /// Needs `events.input`.
    ActionPerformed,
    VcsChanged,
    Scheduled,
}

impl EventKind {
    /// The name the IDE knows it by.
    pub fn name(self) -> &'static str {
        match self {
            Self::FileClosed => "file-closed",
            Self::SettingsChanged => "settings-changed",
            Self::InputModeChanged => "input-mode-changed",
            Self::RunExited => "run-exited",
            Self::TerminalExited => "terminal-exited",
            Self::ContentTabAction => "content-tab-action",
            Self::FileOpened => "file-opened",
            Self::FileSaved => "file-saved",
            Self::FilesChanged => "files-changed",
            Self::EditorFocused => "editor-focused",
            Self::ActionPerformed => "action-performed",
            Self::VcsChanged => "vcs-changed",
            Self::Scheduled => "scheduled",
        }
    }
}

/// How the user started an action; later IDEs may report more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ActionSource {
    Keyboard,
    Menu,
    Toolbar,
    ContextMenu,
    Search,
    /// Anything else, including sources this SDK doesn't know.
    Other,
}

impl ActionSource {
    pub fn parse(name: &str) -> Self {
        match name {
            "keyboard" => Self::Keyboard,
            "menu" => Self::Menu,
            "toolbar" => Self::Toolbar,
            "context-menu" => Self::ContextMenu,
            "search" => Self::Search,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionPerformed {
    /// Action id (`editor.duplicate-line`).
    pub action: String,
    pub title: String,
    pub source: ActionSource,
    /// Its keyboard shortcut, if it has one.
    pub shortcut: Option<String>,
}

/// Debounced changes in an open project, delivered with the `events` capability.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FilesChanged {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

/// A workbench event (see [`crate::host::subscribe`]).
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Event {
    FileOpened(String),
    FileSaved(String),
    FilesChanged(FilesChanged),
    EditorFocused(Option<String>),
    ActionPerformed(ActionPerformed),
    /// A repository (its root) changed.
    VcsChanged(String),
    /// The `on-schedule` period elapsed.
    Scheduled,
    /// A kind this SDK doesn't know: its name and JSON data.
    Other {
        kind: String,
        data: String,
    },
}

/// The repository containing a project.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepositoryStatus {
    pub root: String,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Merge / rebase / cherry-pick in progress.
    pub operation: Option<String>,
    pub changed_files: u32,
}

/// What a path inside a project is, as [`crate::host::Project::stat`] reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    #[default]
    Other,
}

/// Metadata of a path inside a project.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileStat {
    pub kind: FileKind,
    /// Bytes, for a file.
    pub size: u64,
    /// Seconds since the Unix epoch; `None` when the file system does not track it.
    pub modified: Option<u64>,
}

/// A file the commit being prepared changes ([`crate::host::pending_commit`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitChange {
    /// Absolute path of the working tree root of its repository.
    pub repository: String,
    /// Absolute path (after a rename, the new one).
    pub path: String,
    /// The path before a rename or copy.
    pub old_path: Option<String>,
    /// `added`, `modified`, `deleted`, `renamed`, `copied` or `type-changed`.
    pub status: String,
    /// The included changes in `git diff` format against HEAD; `None` for binary content.
    pub diff: Option<String>,
    /// `diff` was cut at the size limit (1 MiB for all the changes).
    pub truncated: bool,
}

/// What Commit would commit right now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitDraft {
    /// Changes with the message, the included changes or Amend; pass it to
    /// [`crate::host::set_commit_message`].
    pub revision: u64,
    pub message: String,
    /// The commit replaces the last one; `changes` are still against HEAD.
    pub amend: bool,
    pub changes: Vec<CommitChange>,
}

/// A range in a file.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Location {
    /// Absolute path.
    pub path: String,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

/// A problem in a file (see [`crate::host::publish_diagnostics`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    /// Rule or check id.
    pub code: Option<String>,
    /// The tool that found it, when not the plugin itself.
    pub source: Option<String>,
    /// Code that does nothing (shown faded).
    pub unnecessary: bool,
    /// Use of something deprecated (struck through).
    pub deprecated: bool,
    /// Other places that explain it.
    pub related: Vec<RelatedInformation>,
}

impl Diagnostic {
    pub fn new(range: Range, severity: Severity, message: impl Into<String>) -> Self {
        Self {
            range,
            severity,
            message: message.into(),
            code: None,
            source: None,
            unnecessary: false,
            deprecated: false,
            related: Vec::new(),
        }
    }

    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

/// Another place that explains a diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelatedInformation {
    pub location: Location,
    pub message: String,
}

/// An HTTP request (see [`crate::host::fetch`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    /// `{{secret:<name>}}` in a value is filled in by the IDE.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: Option<u32>,
}

impl HttpRequest {
    pub fn get(url: &str) -> Self {
        Self { method: "GET".into(), url: url.into(), ..Self::default() }
    }

    pub fn post(url: &str, body: impl Into<Vec<u8>>) -> Self {
        Self { method: "POST".into(), url: url.into(), body: Some(body.into()), ..Self::default() }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// What a process printed (see [`crate::host::run_process`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessOutput {
    /// `None` when killed by a signal.
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_ide_uses() {
        assert_eq!(EventKind::ActionPerformed.name(), "action-performed");
        assert_eq!(ActionSource::parse("context-menu"), ActionSource::ContextMenu);
        assert_eq!(ActionSource::parse("pen"), ActionSource::Other, "a source of a newer IDE");
        let d = Diagnostic::new(Range::default(), Severity::Hint, "m").code("c");
        assert_eq!((d.code.as_deref(), d.unnecessary, d.related.len()), (Some("c"), false, 0));
    }
}

/// A notification button invoking a command declared by this plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationAction {
    pub label: String,
    pub command: String,
    pub argument: Option<String>,
}
impl NotificationAction {
    /// A button labelled `label`, invoking the plugin command `command`.
    pub fn new(label: impl Into<String>, command: impl Into<String>) -> Self {
        Self { label: label.into(), command: command.into(), argument: None }
    }
    /// Passes this text to the command when selected.
    pub fn argument(mut self, argument: impl Into<String>) -> Self {
        self.argument = Some(argument.into());
        self
    }
}

impl Event {
    /// Decodes additive events while preserving unknown or malformed payloads.
    pub fn from_other(kind: String, data: String) -> Self {
        if kind == "files-changed"
            && let Ok(batch) = serde_json::from_str(&data)
        {
            return Self::FilesChanged(batch);
        }
        Self::Other { kind, data }
    }
}

/// An editor in the invoking window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenEditor {
    pub path: String,
    pub language: String,
    pub dirty: bool,
    pub active: bool,
}
/// Find in Files options. Include and exclude are project-relative globs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextQuery {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}
/// A text search match with zero-based UTF-16 coordinates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextMatch {
    pub location: Location,
    pub line: String,
}
/// Bounded text search result.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextSearch {
    pub matches: Vec<TextMatch>,
    pub limit_hit: bool,
}
/// A file's Problems view diagnostics from one source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileProblems {
    pub path: String,
    pub source: String,
    pub diagnostics: Vec<Diagnostic>,
}
/// An editor annotation. Styles are fixed theme-token names; unknown names are ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoration {
    pub range: Range,
    pub style: String,
    pub hover: Option<String>,
    pub after: Option<String>,
}
/// A project-tree annotation. Badge is at most two Unicode characters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileDecoration {
    pub badge: Option<String>,
    pub style: String,
    pub tooltip: Option<String>,
}
/// Repository history metadata. Date is Unix seconds.
#[derive(Clone, Debug, PartialEq, Eq)]
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
/// Attribution for a zero-based document line. Date is Unix seconds.
#[derive(Clone, Debug, PartialEq, Eq)]
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
