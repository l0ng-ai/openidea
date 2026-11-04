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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EventKind {
    FileOpened,
    FileSaved,
    EditorFocused,
    /// Needs `events.input`.
    ActionPerformed,
    VcsChanged,
    Scheduled,
}

/// How the user started an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionSource {
    Keyboard,
    Menu,
    Toolbar,
    ContextMenu,
    Search,
    Other,
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

/// A workbench event (see [`crate::host::subscribe`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    FileOpened(String),
    FileSaved(String),
    EditorFocused(Option<String>),
    ActionPerformed(ActionPerformed),
    /// A repository (its root) changed.
    VcsChanged(String),
    /// The `on-schedule` period elapsed.
    Scheduled,
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

/// A range in a file.
#[derive(Clone, Debug, PartialEq, Eq)]
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
