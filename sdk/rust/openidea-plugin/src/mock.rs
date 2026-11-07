//! A mock IDE for testing plugins with `cargo test` on the host target.
//!
//! [`MockHost::install`] makes the [`crate::host`] functions of the current
//! thread talk to a fresh mock: it records what the plugin did, keeps one
//! editor with a versioned document, and enforces the capabilities you give
//! it like the real host (a missing one returns [`Error::Denied`]).

use crate::host::Invocation;
use crate::types::*;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::marker::PhantomData;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notification {
    pub level: NotificationLevel,
    pub title: String,
    pub body: String,
}

/// A notification with command buttons, recorded by the mock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionNotification {
    pub notification: Notification,
    pub actions: Vec<NotificationAction>,
}

/// A task the plugin began.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MockTask {
    pub title: String,
    /// `(done, total, message)` reports, in order.
    pub reports: Vec<(u32, Option<u32>, Option<String>)>,
    pub cancelled: bool,
    pub ended: bool,
}

type NetHandler = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, Error>>;
type ProcessHandler = Box<dyn Fn(&[String], Option<&str>) -> Result<ProcessOutput, Error>>;

/// A process run the plugin made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRun {
    pub program: String,
    pub args: Vec<String>,
    /// Variables added to the inherited environment.
    pub env: Vec<(String, String)>,
    /// The project root it ran in (`None`: the data directory).
    pub cwd: Option<String>,
}

/// A program a plugin started and keeps running behind a handle.
#[derive(Debug)]
#[allow(dead_code)] // recorded so a test can see what a handle was started with
struct ChildState {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
    /// What `write` put into its stdin.
    stdin: String,
    stdin_closed: bool,
    /// What it printed and the plugin has not read yet.
    stdout: String,
    stderr: String,
    status: Option<i32>,
}

struct Editor {
    path: String,
    language: String,
    text: String,
    version: u64,
    selections: Vec<Range>,
}

#[derive(Default)]
struct State {
    capabilities: Vec<String>,
    root: Option<String>,
    other_projects: Vec<String>,
    symbols: BTreeMap<String, Vec<SymbolInfo>>,
    files: BTreeMap<String, String>,

    /// Files outside every project, for `fs.read` (absolute paths).
    external: BTreeMap<String, String>,
    /// The same, for what `fs::write_bytes` put there.
    external_bytes: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    editor: Option<Editor>,
    selected_paths: Vec<String>,
    notifications: Vec<Notification>,
    action_notifications: Vec<ActionNotification>,
    logs: Vec<(LogLevel, String)>,
    status: BTreeMap<String, StatusItem>,
    context: BTreeMap<String, ContextValue>,
    storage: BTreeMap<String, String>,
    subscriptions: BTreeSet<EventKind>,
    path_subscriptions: BTreeMap<String, Vec<String>>,
    tasks: Vec<MockTask>,
    vcs: Option<RepositoryStatus>,
    remotes: Vec<(String, String)>,
    commit: Option<CommitDraft>,
    fetches: u32,
    fetch_error: Option<Error>,
    clipboard: Option<String>,
    opened_urls: Vec<String>,
    opened_projects: Vec<(String, bool)>,
    answers: VecDeque<Option<Vec<String>>>,
    revealed_views: Vec<String>,
    diagnostics: BTreeMap<String, Vec<Diagnostic>>,
    provider_diagnostics: BTreeMap<String, Vec<Diagnostic>>,
    secrets: BTreeMap<String, String>,
    net: Option<NetHandler>,
    requests: Vec<HttpRequest>,
    processes: BTreeMap<String, ProcessHandler>,
    runs: Vec<ProcessRun>,
    /// The programs `start`ed, by handle id.
    children: BTreeMap<u64, ChildState>,
    next_child: u64,
    refreshed: Vec<String>,
    view_messages: Vec<(String, String)>,
    terminals: Vec<MockTerminal>,
    locations: Vec<(String, u32, u32)>,
    settings: BTreeMap<String, String>,
    locale: Option<String>,
}

/// A terminal the plugin opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockTerminal {
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
}

/// At most 8 programs a plugin may keep running, as the host allows.
const MAX_CHILDREN: usize = 8;

thread_local! {
    static CURRENT: RefCell<Option<Rc<RefCell<State>>>> = const { RefCell::new(None) };
}

/// Handle to the mock installed for this thread. Dropping it uninstalls it.
pub struct MockHost {
    state: Rc<RefCell<State>>,
}

/// Every capability a plugin can hold, except `process:`/`net:`/`fs.read:`.
const ALL: &[&str] = &[
    "project.read",
    "editor.read",
    "editor.write",
    "vcs.read",
    "vcs.write",
    "storage",
    "events",
    "events.input",
    "clipboard",
];

impl MockHost {
    /// Installs a mock granting the usual capabilities, with project `/project`.
    pub fn install() -> Self {
        let state = Rc::new(RefCell::new(State {
            capabilities: ALL.iter().map(|s| (*s).to_owned()).collect(),
            root: Some("/project".into()),
            ..State::default()
        }));
        CURRENT.with(|c| *c.borrow_mut() = Some(state.clone()));
        Self { state }
    }

    /// Project-open requests, in order: (UI path, new window).
    pub fn opened_projects(&self) -> Vec<(String, bool)> {
        self.state.borrow().opened_projects.clone()
    }

    /// Grants exactly these capabilities.
    pub fn with_capabilities(self, caps: &[&str]) -> Self {
        self.state.borrow_mut().capabilities = caps.iter().map(|s| (*s).to_owned()).collect();
        self
    }

    /// The invoking window's project (`None`: no project).
    pub fn set_project_root(&self, root: Option<&str>) {
        self.state.borrow_mut().root = root.map(str::to_owned);
    }

    /// More open projects (for [`crate::host::projects`]).
    pub fn add_project(&self, root: &str) {
        self.state.borrow_mut().other_projects.push(root.to_owned());
    }

    /// Replaces a project's indexed symbols. Filtering in the mock is a
    /// case-insensitive substring; the real index also supports fuzzy matching.
    pub fn set_symbols(&self, root: &str, symbols: Vec<SymbolInfo>) {
        self.state.borrow_mut().symbols.insert(root.into(), symbols);
    }

    /// A project file `read_file` can return (project-relative or absolute path).
    pub fn add_file(&self, path: &str, text: &str) {
        self.state.borrow_mut().files.insert(path.to_owned(), text.to_owned());
    }

    /// A project directory `exists` and `stat` report (project-relative or
    /// absolute path); file paths count as existing too.
    pub fn add_dir(&self, path: &str) {
        self.state.borrow_mut().dirs.insert(path.to_owned());
    }

    /// Sets the paths invocations report as selected.
    pub fn select_paths(&self, paths: &[&str]) {
        self.state.borrow_mut().selected_paths = paths.iter().map(|p| (*p).to_owned()).collect();
    }

    /// A file outside every project, for [`crate::host::fs`]: it is readable
    /// once an `fs.read:<a directory above it>` capability is granted, writable
    /// with `fs.write:`. Directories are inferred from the paths it holds.
    pub fn add_external_file(&self, path: &str, text: &str) {
        self.state.borrow_mut().external.insert(path.to_owned(), text.to_owned());
    }

    /// Focuses an editor on `text` with selections `(line, col, line, col)`.
    pub fn open_editor(&self, path: &str, language: &str, text: &str, selections: &[(u32, u32, u32, u32)]) {
        let selections =
            selections.iter().map(|&(a, b, c, d)| Range::new(Position::new(a, b), Position::new(c, d))).collect();
        self.state.borrow_mut().editor =
            Some(Editor { path: path.into(), language: language.into(), text: text.into(), version: 1, selections });
    }

    pub fn editor_text(&self) -> String {
        self.state.borrow().editor.as_ref().map(|e| e.text.clone()).unwrap_or_default()
    }

    pub fn editor_version(&self) -> u64 {
        self.state.borrow().editor.as_ref().map_or(0, |e| e.version)
    }

    /// The user edits the document (its version moves on).
    pub fn type_in_editor(&self, text: &str) {
        if let Some(e) = self.state.borrow_mut().editor.as_mut() {
            e.text.push_str(text);
            e.version += 1;
        }
    }

    /// The invocation a command from the focused window gets.
    pub fn invocation(&self) -> Invocation<'static> {
        Invocation::__new(MockInvocation(PhantomData))
    }

    pub fn notifications(&self) -> Vec<Notification> {
        self.state.borrow().notifications.clone()
    }

    /// Notifications that carried command buttons, in publication order.
    pub fn notifications_with_actions(&self) -> Vec<ActionNotification> {
        self.state.borrow().action_notifications.clone()
    }

    pub fn logs(&self) -> Vec<(LogLevel, String)> {
        self.state.borrow().logs.clone()
    }

    pub fn status_items(&self) -> BTreeMap<String, StatusItem> {
        self.state.borrow().status.clone()
    }

    pub fn context_keys(&self) -> BTreeMap<String, ContextValue> {
        self.state.borrow().context.clone()
    }

    pub fn storage(&self) -> BTreeMap<String, String> {
        self.state.borrow().storage.clone()
    }

    pub fn path_subscriptions(&self) -> BTreeMap<String, Vec<String>> {
        self.state.borrow().path_subscriptions.clone()
    }

    pub fn subscriptions(&self) -> BTreeSet<EventKind> {
        self.state.borrow().subscriptions.clone()
    }

    pub fn tasks(&self) -> Vec<MockTask> {
        self.state.borrow().tasks.clone()
    }

    /// The user cancels every open task.
    pub fn cancel_tasks(&self) {
        for t in &mut self.state.borrow_mut().tasks {
            t.cancelled = true;
        }
    }

    /// What `vcs-status` returns for every project (`None`: not under git).
    pub fn set_vcs_status(&self, status: Option<RepositoryStatus>) {
        self.state.borrow_mut().vcs = status;
    }

    /// Remotes `vcs-remotes` returns for every project.
    pub fn set_vcs_remotes(&self, remotes: &[(&str, &str)]) {
        self.state.borrow_mut().remotes = remotes.iter().map(|&(n, u)| (n.to_owned(), u.to_owned())).collect();
    }

    /// Last text copied with [`crate::host::copy_to_clipboard`].
    pub fn clipboard(&self) -> Option<String> {
        self.state.borrow().clipboard.clone()
    }

    /// URLs opened with [`crate::host::open_url`], in order.
    pub fn opened_urls(&self) -> Vec<String> {
        self.state.borrow().opened_urls.clone()
    }

    /// The answer the next [`crate::host::pick`], [`crate::host::input`] or
    /// [`crate::host::confirm`] gets: the chosen keys, the text (one element),
    /// anything for OK, or `None` for dismissed. Unscripted prompts are dismissed.
    pub fn answer_next_prompt(&self, answer: Option<&[&str]>) {
        let answer = answer.map(|a| a.iter().map(|&s| s.to_owned()).collect());
        self.state.borrow_mut().answers.push_back(answer);
    }

    /// Views brought forward with [`crate::host::reveal_view`], in order.
    pub fn revealed_views(&self) -> Vec<String> {
        self.state.borrow().revealed_views.clone()
    }

    /// The commit being prepared that [`crate::host::pending_commit`] returns
    /// (`None`: no repository).
    pub fn set_commit_draft(&self, draft: Option<CommitDraft>) {
        self.state.borrow_mut().commit = draft;
    }

    /// The draft as the plugin left it: [`crate::host::set_commit_message`]
    /// replaces the message and moves the revision on.
    pub fn commit_draft(&self) -> Option<CommitDraft> {
        self.state.borrow().commit.clone()
    }

    /// The user edits the draft: its revision moves on, so a later
    /// [`crate::host::set_commit_message`] for the old one is stale.
    pub fn edit_commit_message(&self, message: &str) {
        if let Some(d) = self.state.borrow_mut().commit.as_mut() {
            d.message = message.to_owned();
            d.revision += 1;
        }
    }

    /// Makes `vcs-fetch` fail.
    pub fn fail_fetch(&self, error: Option<Error>) {
        self.state.borrow_mut().fetch_error = error;
    }

    pub fn fetches(&self) -> u32 {
        self.state.borrow().fetches
    }

    /// Diagnostics the plugin published, per path.
    pub fn diagnostics(&self) -> BTreeMap<String, Vec<Diagnostic>> {
        self.state.borrow().diagnostics.clone()
    }

    /// Runs a diagnostics provider against the current mock editor snapshot.
    /// This explicit call replaces the real host's debounce; it needs no capability.
    pub fn refresh_diagnostics(&self, provider: &mut impl crate::diagnostics::DiagnosticsProvider) {
        let document = self.state.borrow().editor.as_ref().map(|e| crate::diagnostics::Document {
            path: e.path.clone(),
            language: e.language.clone(),
            version: e.version,
            text: e.text.clone(),
        });
        if let Some(document) = document {
            let items = provider.diagnostics(&document);
            let mut state = self.state.borrow_mut();
            if items.is_empty() {
                state.provider_diagnostics.remove(&document.path);
            } else {
                state.provider_diagnostics.insert(document.path, items);
            }
        }
    }

    /// Diagnostics returned by the provider, separate from manual publishing.
    pub fn provider_diagnostics(&self) -> BTreeMap<String, Vec<Diagnostic>> {
        self.state.borrow().provider_diagnostics.clone()
    }

    /// Views the plugin asked to refresh, in order.
    pub fn refreshed_views(&self) -> Vec<String> {
        self.state.borrow().refreshed.clone()
    }

    /// `(view, message)` the plugin posted to its views' frames.
    pub fn view_messages(&self) -> Vec<(String, String)> {
        self.state.borrow().view_messages.clone()
    }

    pub fn opened_locations(&self) -> Vec<(String, u32, u32)> {
        self.state.borrow().locations.clone()
    }

    /// Terminals the plugin opened.
    pub fn terminals(&self) -> Vec<MockTerminal> {
        self.state.borrow().terminals.clone()
    }

    /// The value of one of the plugin's settings, as JSON (`true`, `"text"`).
    pub fn set_setting(&self, key: &str, json: &str) {
        self.state.borrow_mut().settings.insert(key.into(), json.into());
    }

    /// The UI language [`crate::host::locale`] reports (`en` by default).
    pub fn set_locale(&self, tag: &str) {
        self.state.borrow_mut().locale = Some(tag.into());
    }

    /// A secret the user stored.
    pub fn set_secret(&self, name: &str, value: &str) {
        self.state.borrow_mut().secrets.insert(name.into(), value.into());
    }

    /// Answers the plugin's HTTP requests (secrets already filled in).
    pub fn on_fetch(&self, handler: impl Fn(&HttpRequest) -> Result<HttpResponse, Error> + 'static) {
        self.state.borrow_mut().net = Some(Box::new(handler));
    }

    /// Requests the plugin made, as sent (secrets filled in).
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.state.borrow().requests.clone()
    }

    /// What running `process:<program>` does: `(args, stdin) → output`.
    pub fn on_process(
        &self,
        program: &str,
        handler: impl Fn(&[String], Option<&str>) -> Result<ProcessOutput, Error> + 'static,
    ) {
        self.state.borrow_mut().processes.insert(program.into(), Box::new(handler));
    }

    pub fn process_runs(&self) -> Vec<ProcessRun> {
        self.state.borrow().runs.clone()
    }

    /// A context as `activate` receives it.
    pub fn context(&self, plugin_id: &str) -> Context {
        Context {
            plugin_id: plugin_id.into(),
            plugin_version: "0.0.0".into(),
            api_version: crate::API_VERSION.into(),
            capabilities: self.state.borrow().capabilities.clone(),
        }
    }
}

impl Drop for MockHost {
    fn drop(&mut self) {
        CURRENT.with(|c| {
            let mut cur = c.borrow_mut();
            if cur.as_ref().is_some_and(|s| Rc::ptr_eq(s, &self.state)) {
                *cur = None;
            }
        });
    }
}

#[doc(hidden)]
#[derive(Clone, Copy)]
pub struct MockInvocation<'a>(PhantomData<&'a ()>);

#[doc(hidden)]
pub struct MockProject {
    root: String,
}

#[doc(hidden)]
pub struct MockEditor;

#[doc(hidden)]
pub struct MockTaskRes {
    index: usize,
}

impl Drop for MockTaskRes {
    fn drop(&mut self) {
        current::with(|s| {
            if let Some(t) = s.tasks.get_mut(self.index) {
                t.ended = true;
            }
        })
    }
}

#[doc(hidden)]
pub mod current {
    //! The host functions, backed by the installed mock.
    use super::*;

    pub type InvocationRef<'a> = MockInvocation<'a>;
    pub type ProjectRes = MockProject;
    pub type EditorRes = MockEditor;
    pub type TaskRes = MockTaskRes;

    pub(super) fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
        CURRENT.with(|c| {
            let cur = c.borrow();
            let state = cur.as_ref().expect("no mock host: call openidea_plugin::mock::MockHost::install() first");
            f(&mut state.borrow_mut())
        })
    }

    fn require(s: &State, cap: &str) -> Result<(), Error> {
        if s.capabilities.iter().any(|c| c == cap) { Ok(()) } else { Err(Error::Denied(cap.to_owned())) }
    }

    /// `fs.read:<base>` (or `fs.write:<base>`) covers `<base>` itself and what is
    /// under it: `/a` covers `/a/b` but not `/ab`.
    const PLUGIN_DIR: &str = "/openidea/plugin-data/mock/files";

    fn require_fs(s: &State, kind: &str, path: &str) -> Result<(), Error> {
        if (path == PLUGIN_DIR || path.starts_with(&format!("{PLUGIN_DIR}/")))
            && !path.split(['/', '\\']).any(|part| part == "..")
        {
            return Ok(());
        }
        let prefix = format!("{kind}:");
        let covered = s.capabilities.iter().any(|c| match c.strip_prefix(&prefix) {
            Some(base) => {
                let base = base.trim_end_matches(['/', '\\']);
                !base.is_empty()
                    && (path == base
                        || matches!(path.strip_prefix(base), Some(rest) if rest.starts_with('/') || rest.starts_with('\\')))
            }
            None => false,
        });
        if covered { Ok(()) } else { Err(Error::Denied(format!("{prefix}{path}"))) }
    }

    /// The paths `fs` takes are absolute; `~/…` is the user's home on the real
    /// host, and the mock resolves nothing, so add it to the mock as it is.
    fn check_absolute(path: &str) -> Result<(), Error> {
        let bytes = path.as_bytes();
        let drive = bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\');
        if path.starts_with('/') || drive {
            Ok(())
        } else {
            Err(Error::Invalid(format!("{path}: use an absolute path (or ~/…)")))
        }
    }

    /// `fs` checks what the real host checks, minus canonicalisation: absolute
    /// path, then a grant covering it.
    fn check_external(s: &State, kind: &str, path: &str) -> Result<(), Error> {
        check_absolute(path)?;
        require_fs(s, kind, path)
    }

    /// The directory `path` lives in: `/a/b` → `/a`, `/a` → `/`, `C:\a` → `C:\`.
    fn parent_dir(path: &str) -> Option<&str> {
        let cut = path.rfind(['/', '\\'])?;
        let root = cut == 0 || (cut == 2 && path.as_bytes()[1] == b':');
        Some(&path[..if root { cut + 1 } else { cut }])
    }

    /// Files the mock holds under `dir`.
    fn has_children(s: &State, dir: &str) -> bool {
        let under =
            |p: &String| matches!(p.strip_prefix(dir), Some(rest) if rest.starts_with('/') || rest.starts_with('\\'));
        s.external.keys().any(under) || s.external_bytes.keys().any(under)
    }

    /// The mock holds no file system, so a directory exists when a grant names
    /// it or a registered file lives under it — plus the root of a volume.
    fn dir_exists(s: &State, dir: &str) -> bool {
        let dir = dir.trim_end_matches(['/', '\\']);
        if dir.is_empty() || dir.ends_with(':') {
            return true;
        }
        let granted = ["fs.read:", "fs.write:"].iter().any(|kind| {
            s.capabilities
                .iter()
                .filter_map(|c| c.strip_prefix(kind))
                .any(|base| base.trim_end_matches(['/', '\\']) == dir)
        });
        dir == PLUGIN_DIR || granted || has_children(s, dir)
    }

    /// What a write has to get past: an `fs.write` grant, a path that is not a
    /// directory, and a parent directory that exists.
    fn check_writable(s: &State, path: &str) -> Result<(), Error> {
        check_external(s, "fs.write", path)?;
        if has_children(s, path) {
            return Err(Error::Invalid(format!("{path}: is a directory")));
        }
        match parent_dir(path) {
            Some(dir) if dir_exists(s, dir) => Ok(()),
            Some(dir) => Err(Error::Invalid(format!("{dir}: no such directory"))),
            None => Err(Error::Invalid(format!("{path}: expected a file path"))),
        }
    }

    pub fn log(level: LogLevel, message: &str) {
        with(|s| s.logs.push((level, message.to_owned())))
    }

    pub fn notify(level: NotificationLevel, title: &str, body: &str) {
        with(|s| s.notifications.push(Notification { level, title: title.into(), body: body.into() }))
    }

    /// The host's checks, except that the commands are declared (the mock has no manifest).
    pub fn notify_with_actions(
        level: NotificationLevel,
        title: &str,
        body: &str,
        actions: &[NotificationAction],
    ) -> Result<(), Error> {
        if actions.len() > 3 {
            return Err(Error::Invalid("a notification has at most 3 actions".into()));
        }
        for a in actions {
            if a.label.trim().is_empty() || a.label.len() > 256 || a.label.chars().any(char::is_control) {
                return Err(Error::Invalid(format!("invalid action label {:?}", a.label)));
            }
            if a.argument.as_ref().is_some_and(|arg| arg.len() > 64 << 10) {
                return Err(Error::Invalid("an action argument is limited to 64 KiB".into()));
            }
        }
        with(|s| {
            let notification = Notification { level, title: title.into(), body: body.into() };
            s.notifications.push(notification.clone());
            s.action_notifications.push(ActionNotification { notification, actions: actions.to_vec() });
        });
        Ok(())
    }

    pub fn set_status_item(id: &str, item: &StatusItem) {
        with(|s| s.status.insert(id.to_owned(), item.clone()));
    }

    pub fn remove_status_item(id: &str) {
        with(|s| s.status.remove(id));
    }

    pub fn set_context(key: &str, value: ContextValue) -> Result<(), Error> {
        with(|s| s.context.insert(key.to_owned(), value));
        Ok(())
    }

    pub fn remove_context(key: &str) {
        with(|s| s.context.remove(key));
    }

    pub fn copy_to_clipboard(text: &str) -> Result<(), Error> {
        with(|s| {
            require(s, "clipboard")?;
            s.clipboard = Some(text.to_owned());
            Ok(())
        })
    }

    pub fn locale() -> String {
        with(|s| s.locale.clone().unwrap_or_else(|| "en".into()))
    }

    pub fn open_url(url: &str) -> Result<(), Error> {
        let trimmed = url.trim();
        if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
            return Err(Error::Invalid(format!("{url:?}: expected an http:// or https:// URL")));
        }
        with(|s| {
            s.opened_urls.push(trimmed.to_owned());
            Ok(())
        })
    }

    pub fn pick_directory(_title: &str, initial: Option<&str>) -> Result<Option<String>, Error> {
        if let Some(path) = initial {
            ui_path(path)?;
        }
        Ok(with(|s| s.answers.pop_front().flatten()).and_then(|a| a.into_iter().next()))
    }

    pub fn open_project(path: &str, new_window: bool) -> Result<(), Error> {
        ui_path(path)?;
        with(|s| s.opened_projects.push((path.to_owned(), new_window)));
        Ok(())
    }

    /// The host's check: an absolute path on the UI machine, whatever its OS.
    fn ui_path(path: &str) -> Result<(), Error> {
        let b = path.as_bytes();
        let absolute = path.starts_with('/')
            || path.starts_with("\\\\")
            || (b.first().is_some_and(u8::is_ascii_alphabetic)
                && b.get(1) == Some(&b':')
                && matches!(b.get(2), Some(b'/' | b'\\')));
        if !absolute || path.len() > 8192 || path.chars().any(char::is_control) {
            return Err(Error::Invalid("expected an absolute UI directory path of at most 8192 bytes".into()));
        }
        Ok(())
    }

    pub fn pick(title: &str, items: &[PickItem]) -> Result<Option<String>, Error> {
        let keys = pick_many(title, items)?;
        match keys {
            Some(keys) if keys.len() > 1 => Err(Error::Invalid("more than one item chosen".into())),
            keys => Ok(keys.and_then(|keys| keys.into_iter().next())),
        }
    }

    pub fn pick_many(_title: &str, items: &[PickItem]) -> Result<Option<Vec<String>>, Error> {
        let answer = with(|s| s.answers.pop_front().flatten());
        let Some(keys) = answer else { return Ok(None) };
        if let Some(unknown) = keys.iter().find(|k| !items.iter().any(|i| &i.key == *k)) {
            return Err(Error::Invalid(format!("{unknown:?} is not one of the items")));
        }
        Ok(Some(keys))
    }

    pub fn input(_prompt: &str, _value: Option<&str>) -> Result<Option<String>, Error> {
        Ok(with(|s| s.answers.pop_front().flatten()).and_then(|a| a.into_iter().next()))
    }

    pub fn input_multiline(_prompt: &str, _value: Option<&str>) -> Result<Option<String>, Error> {
        Ok(with(|s| s.answers.pop_front().flatten()).and_then(|a| a.into_iter().next()))
    }

    pub fn confirm(_title: &str, _body: &str) -> Result<bool, Error> {
        Ok(with(|s| s.answers.pop_front().flatten()).is_some())
    }

    pub fn reveal_view(view: &str) -> Result<(), Error> {
        with(|s| s.revealed_views.push(view.to_owned()));
        Ok(())
    }

    pub fn storage_get(key: &str) -> Result<Option<String>, Error> {
        with(|s| {
            require(s, "storage")?;
            Ok(s.storage.get(key).cloned())
        })
    }

    pub fn storage_set(key: &str, value: &str) -> Result<(), Error> {
        with(|s| {
            require(s, "storage")?;
            s.storage.insert(key.to_owned(), value.to_owned());
            Ok(())
        })
    }

    pub fn storage_delete(key: &str) -> Result<(), Error> {
        with(|s| {
            require(s, "storage")?;
            s.storage.remove(key);
            Ok(())
        })
    }

    pub fn storage_keys(prefix: &str) -> Result<Vec<String>, Error> {
        with(|s| {
            require(s, "storage")?;
            Ok(s.storage.keys().filter(|k| k.starts_with(prefix)).cloned().collect())
        })
    }

    pub fn projects() -> Result<Vec<ProjectRes>, Error> {
        with(|s| {
            require(s, "project.read")?;
            Ok(s.root.iter().chain(&s.other_projects).map(|root| MockProject { root: root.clone() }).collect())
        })
    }

    pub fn project_of(path: &str) -> Option<ProjectRes> {
        let path = path.replace('\\', "/");
        let absolute =
            path.starts_with('/') || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2) == Some(&b'/'));
        if !absolute || path.split('/').any(|part| part == "..") {
            return None;
        }
        with(|s| {
            s.root
                .iter()
                .chain(&s.other_projects)
                .filter(|root| {
                    let root = root.replace('\\', "/");
                    path == root
                        || path.strip_prefix(root.trim_end_matches('/')).is_some_and(|rest| rest.starts_with('/'))
                })
                .max_by_key(|root| root.replace('\\', "/").split('/').count())
                .map(|root| MockProject { root: root.clone() })
        })
    }

    pub fn project_root(p: &ProjectRes) -> Result<String, Error> {
        with(|s| {
            require(s, "project.read")?;
            Ok(p.root.clone())
        })
    }

    /// `path` inside `p`'s root as a project-relative key, or `Invalid` for a
    /// path leaving the root (as the host does).
    fn rel_in_root<'a>(p: &ProjectRes, path: &'a str) -> Result<&'a str, Error> {
        let root = p.root.as_str();
        let rel = path.strip_prefix(root).map(|p| p.trim_start_matches('/')).unwrap_or(path);
        if rel.starts_with('/') || rel.split('/').any(|seg| seg == "..") {
            return Err(Error::Invalid(format!("{path}: access outside the project root is not allowed")));
        }
        Ok(rel)
    }

    fn path_known(s: &State, p: &ProjectRes, path: &str, rel: &str) -> bool {
        let root = p.root.as_str();
        s.files.contains_key(rel)
            || s.files.contains_key(path)
            || s.dirs.contains(rel)
            || s.dirs.contains(path)
            || s.editor.as_ref().is_some_and(|e| e.path == path || e.path == format!("{root}/{rel}"))
    }

    pub fn project_read(p: &ProjectRes, path: &str) -> Result<String, Error> {
        with(|s| {
            require(s, "project.read")?;
            let root = p.root.as_str();
            let rel = rel_in_root(p, path)?;
            let open = s.editor.as_ref().filter(|e| e.path == path || e.path == format!("{root}/{rel}"));
            if let Some(e) = open {
                return Ok(e.text.clone());
            }
            s.files.get(rel).or_else(|| s.files.get(path)).cloned().ok_or_else(|| Error::NotFound(path.into()))
        })
    }

    pub fn project_write(p: &ProjectRes, path: &str, text: &str) -> Result<(), Error> {
        with(|s| {
            require(s, "project.write")?;
            let rel = rel_in_root(p, path)?;
            if s.editor.as_ref().is_some_and(|e| e.path == path || e.path == format!("{}/{rel}", p.root)) {
                return Err(Error::Invalid(format!("{path}: the editor has unsaved changes; save it first")));
            }
            s.files.insert(rel.to_string(), text.to_owned());
            Ok(())
        })
    }

    pub fn project_exists(p: &ProjectRes, path: &str) -> Result<bool, Error> {
        with(|s| {
            require(s, "project.read")?;
            let rel = rel_in_root(p, path)?;
            Ok(rel.is_empty() || path_known(s, p, path, rel))
        })
    }

    pub fn project_symbols(p: &ProjectRes, query: &str, limit: u32) -> Result<Vec<SymbolInfo>, Error> {
        with(|s| {
            require(s, "project.read")?;
            if query.len() > 256 {
                return Err(Error::Invalid("symbol query exceeds 256 UTF-8 bytes".into()));
            }
            if !s.root.iter().chain(&s.other_projects).any(|root| *root == p.root) {
                return Err(Error::NotFound("the project is no longer open".into()));
            }
            let query = query.trim().to_lowercase();
            Ok(s.symbols
                .get(&p.root)
                .into_iter()
                .flatten()
                .filter(|symbol| {
                    !query.is_empty()
                        && symbol.name.to_lowercase().contains(&query)
                        && symbol
                            .location
                            .path
                            .strip_prefix(p.root.trim_end_matches('/'))
                            .is_some_and(|rest| rest.starts_with('/'))
                })
                .take(limit.min(1000) as usize)
                .cloned()
                .collect())
        })
    }

    pub fn project_stat(p: &ProjectRes, path: &str) -> Result<FileStat, Error> {
        with(|s| {
            require(s, "project.read")?;
            let rel = rel_in_root(p, path)?;
            if !path_known(s, p, path, rel) {
                return if rel.is_empty() {
                    Ok(FileStat { kind: FileKind::Directory, size: 0, modified: None })
                } else {
                    Err(Error::NotFound(path.into()))
                };
            }
            let file = s.files.get(rel).or_else(|| s.files.get(path));
            let open = s.editor.as_ref().filter(|e| e.path == path || e.path == format!("{}/{rel}", p.root));
            let kind = if file.is_some() || open.is_some() { FileKind::File } else { FileKind::Directory };
            let size = file.or_else(|| open.map(|e| &e.text)).map_or(0, |t| t.len() as u64);
            Ok(FileStat { kind, size, modified: None })
        })
    }

    pub fn fs_plugin_dir() -> Result<String, Error> {
        Ok(PLUGIN_DIR.to_owned())
    }

    pub fn fs_read_file(path: &str) -> Result<String, Error> {
        with(|s| {
            check_external(s, "fs.read", path)?;
            // Unsaved editor contents win, as on the real host.
            if let Some(e) = s.editor.as_ref().filter(|e| e.path == path) {
                return Ok(e.text.clone());
            }
            if let Some(text) = s.external.get(path) {
                return Ok(text.clone());
            }
            match s.external_bytes.get(path) {
                Some(bytes) => String::from_utf8(bytes.clone())
                    .map_err(|_| Error::Invalid(format!("{path}: not valid UTF-8 text"))),
                None => Err(Error::NotFound(path.into())),
            }
        })
    }

    pub fn fs_read_bytes(path: &str) -> Result<Vec<u8>, Error> {
        with(|s| {
            check_external(s, "fs.read", path)?;
            if let Some(bytes) = s.external_bytes.get(path) {
                return Ok(bytes.clone());
            }
            let text = s.external.get(path).ok_or_else(|| Error::NotFound(path.into()))?;
            Ok(text.clone().into_bytes())
        })
    }

    pub fn fs_stat(path: &str) -> Result<FileStat, Error> {
        with(|s| {
            check_external(s, "fs.read", path)?;
            if let Some(text) = s.external.get(path) {
                return Ok(FileStat { kind: FileKind::File, size: text.len() as u64, modified: None });
            }
            if let Some(bytes) = s.external_bytes.get(path) {
                return Ok(FileStat { kind: FileKind::File, size: bytes.len() as u64, modified: None });
            }
            // A directory is a prefix of the files the mock holds.
            if path == PLUGIN_DIR || has_children(s, path) {
                Ok(FileStat { kind: FileKind::Directory, size: 0, modified: None })
            } else {
                Err(Error::NotFound(path.into()))
            }
        })
    }

    pub fn fs_write_file(path: &str, text: &str) -> Result<(), Error> {
        with(|s| {
            check_writable(s, path)?;
            s.external_bytes.remove(path);
            s.external.insert(path.to_owned(), text.to_owned());
            Ok(())
        })
    }

    pub fn fs_write_bytes(path: &str, bytes: &[u8]) -> Result<(), Error> {
        with(|s| {
            check_writable(s, path)?;
            s.external.remove(path);
            s.external_bytes.insert(path.to_owned(), bytes.to_vec());
            Ok(())
        })
    }

    pub fn fs_read_dir(path: &str) -> Result<Vec<crate::host::fs::DirEntry>, Error> {
        with(|s| {
            check_external(s, "fs.read", path)?;
            if s.external.contains_key(path) || s.external_bytes.contains_key(path) {
                return Err(Error::Invalid(format!("{path}: not a directory")));
            }
            let mut entries: BTreeMap<String, FileKind> = BTreeMap::new();
            for file in s.external.keys().chain(s.external_bytes.keys()) {
                let rest = match file.strip_prefix(path) {
                    Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => &rest[1..],
                    _ => continue,
                };
                match rest.split(['/', '\\']).next() {
                    Some(name) if !name.is_empty() => {
                        let kind = if rest.contains('/') || rest.contains('\\') {
                            FileKind::Directory
                        } else {
                            FileKind::File
                        };
                        entries.insert(name.to_owned(), kind);
                    }
                    _ => {}
                }
            }
            if entries.is_empty() && path != PLUGIN_DIR {
                return Err(Error::NotFound(path.into()));
            }
            Ok(entries.into_iter().map(|(name, kind)| crate::host::fs::DirEntry { name, kind }).collect())
        })
    }

    pub fn invocation_project(_: InvocationRef<'_>) -> Option<ProjectRes> {
        with(|s| s.root.clone().map(|root| MockProject { root }))
    }

    pub fn invocation_editor(_: InvocationRef<'_>) -> Option<EditorRes> {
        with(|s| s.editor.as_ref().map(|_| MockEditor))
    }

    fn editor<R>(f: impl FnOnce(&mut State, &mut Editor) -> R) -> R {
        with(|s| {
            let mut e = s.editor.take().expect("the editor was closed");
            let r = f(s, &mut e);
            s.editor = Some(e);
            r
        })
    }

    pub fn invocation_selected_paths(_: InvocationRef<'_>) -> Vec<String> {
        with(|s| s.selected_paths.clone())
    }

    pub fn editor_path(_: &EditorRes) -> String {
        editor(|_, e| e.path.clone())
    }

    pub fn editor_language(_: &EditorRes) -> String {
        editor(|_, e| e.language.clone())
    }

    pub fn editor_document(_: &EditorRes) -> Result<Document, Error> {
        editor(|s, e| {
            require(s, "editor.read")?;
            Ok(Document { version: e.version, text: e.text.clone() })
        })
    }

    pub fn editor_selections(_: &EditorRes) -> Result<Vec<Range>, Error> {
        editor(|s, e| {
            require(s, "editor.read")?;
            Ok(e.selections.clone())
        })
    }

    pub fn editor_apply(_: &EditorRes, version: u64, edits: &[TextEdit]) -> Result<u64, Error> {
        editor(|s, e| {
            require(s, "editor.write")?;
            if version != e.version {
                return Err(Error::Stale);
            }
            let mut spans = Vec::with_capacity(edits.len());
            for edit in edits {
                let start = crate::text::offset(&e.text, edit.range.start);
                let end = crate::text::offset(&e.text, edit.range.end);
                match (start, end) {
                    (Some(a), Some(b)) if a <= b => spans.push((a, b, edit.text.as_str())),
                    _ => return Err(Error::Invalid("edit outside the document".into())),
                }
            }
            spans.sort_by_key(|(a, b, _)| (*a, *b));
            if spans.windows(2).any(|w| w[0].1 > w[1].0) {
                return Err(Error::Invalid("overlapping edits".into()));
            }
            for (a, b, text) in spans.into_iter().rev() {
                e.text.replace_range(a..b, text);
            }
            if !edits.is_empty() {
                e.version += 1;
            }
            Ok(e.version)
        })
    }

    pub fn vcs_status(_: &ProjectRes) -> Result<Option<RepositoryStatus>, Error> {
        with(|s| {
            require(s, "vcs.read")?;
            Ok(s.vcs.clone())
        })
    }

    pub fn vcs_fetch(_: &ProjectRes) -> Result<(), Error> {
        with(|s| {
            require(s, "vcs.write")?;
            if let Some(e) = s.fetch_error.clone() {
                return Err(e);
            }
            s.fetches += 1;
            Ok(())
        })
    }

    pub fn vcs_remotes(_: &ProjectRes) -> Result<Vec<(String, String)>, Error> {
        with(|s| {
            require(s, "vcs.read")?;
            Ok(s.remotes.clone())
        })
    }

    pub fn pending_commit() -> Result<Option<CommitDraft>, Error> {
        with(|s| {
            require(s, "vcs.read")?;
            Ok(s.commit.clone())
        })
    }

    pub fn set_commit_message(revision: u64, message: &str) -> Result<(), Error> {
        with(|s| {
            require(s, "vcs.write")?;
            let draft = s.commit.as_mut().ok_or_else(|| Error::Invalid("no repository".into()))?;
            if draft.revision != revision {
                return Err(Error::Stale);
            }
            draft.message = message.to_owned();
            draft.revision += 1;
            Ok(())
        })
    }

    pub fn subscribe_paths(kind: &str, globs: &[&str]) -> Result<(), Error> {
        with(|s| {
            require(s, "events")?;
            if !matches!(kind, "file-opened" | "file-saved")
                || globs.len() > 64
                || globs.iter().any(|g| {
                    let relative = g.trim_start_matches("./");
                    relative.is_empty()
                        || g.len() > 1024
                        || relative.starts_with('/')
                        || g.contains('\\')
                        || g.contains(':')
                        || g.chars().any(char::is_control)
                        || g.split('/').any(|p| p == "..")
                })
            {
                return Err(Error::Invalid("invalid event path filter".into()));
            }
            match kind {
                "file-opened" => {
                    s.subscriptions.insert(EventKind::FileOpened);
                }
                "file-saved" => {
                    s.subscriptions.insert(EventKind::FileSaved);
                }
                _ => {}
            }
            s.path_subscriptions.insert(kind.to_owned(), globs.iter().map(|g| (*g).to_owned()).collect());
            Ok(())
        })
    }

    pub fn subscribe(kind: EventKind) -> Result<(), Error> {
        with(|s| {
            let cap = match kind {
                EventKind::ActionPerformed => Some("events.input"),
                EventKind::Scheduled => None,
                _ => Some("events"),
            };
            if let Some(cap) = cap {
                require(s, cap)?;
            }
            s.path_subscriptions.remove(kind.name());
            s.subscriptions.insert(kind);
            Ok(())
        })
    }

    pub fn unsubscribe(kind: EventKind) {
        with(|s| {
            s.path_subscriptions.remove(kind.name());
            s.subscriptions.remove(&kind);
        });
    }

    pub fn project_find(p: &ProjectRes, glob: &str, limit: u32) -> Result<Vec<String>, Error> {
        with(|s| {
            require(s, "project.read")?;
            let root = p.root.trim_end_matches('/');
            let mut out: Vec<String> = s
                .files
                .keys()
                .map(|k| if k.starts_with('/') { k.clone() } else { format!("{root}/{k}") })
                .chain(s.editor.as_ref().map(|e| e.path.clone()))
                .filter(|path| {
                    path.strip_prefix(root).map(|r| r.trim_start_matches('/')).is_some_and(|rel| glob_match(glob, rel))
                })
                .collect();
            out.sort();
            out.dedup();
            out.truncate(limit as usize);
            Ok(out)
        })
    }

    pub fn publish_diagnostics(path: &str, items: &[Diagnostic]) -> Result<(), Error> {
        with(|s| {
            require(s, "project.read")?;
            if items.is_empty() {
                s.diagnostics.remove(path);
            } else {
                s.diagnostics.insert(path.to_owned(), items.to_vec());
            }
            Ok(())
        })
    }

    fn net_host(url: &str) -> Option<String> {
        let rest = url.split_once("://")?.1;
        let host = rest.split(['/', ':', '?']).next()?;
        Some(host.to_ascii_lowercase())
    }

    pub fn fetch(req: &HttpRequest) -> Result<HttpResponse, Error> {
        with(|s| {
            let host = net_host(&req.url).ok_or_else(|| Error::Invalid(format!("{:?} is not a URL", req.url)))?;
            let cap = format!("net:{host}");
            if !s.capabilities.iter().any(|c| *c == cap || c == "net:*") {
                return Err(Error::Denied(cap));
            }
            let mut sent = req.clone();
            for (_, value) in &mut sent.headers {
                while let Some(i) = value.find("{{secret:") {
                    require(s, "secrets")?;
                    let end = value[i..].find("}}").ok_or_else(|| Error::Invalid("unterminated secret".into()))? + i;
                    let name = value[i + 9..end].to_owned();
                    let secret =
                        s.secrets.get(&name).cloned().ok_or_else(|| Error::NotFound(format!("secret {name:?}")))?;
                    value.replace_range(i..end + 2, &secret);
                }
            }
            s.requests.push(sent.clone());
            match &s.net {
                Some(handler) => handler(&sent),
                None => Err(Error::Failed("no network in the mock (MockHost::on_fetch)".into())),
            }
        })
    }

    pub fn secret_is_set(name: &str) -> bool {
        with(|s| s.capabilities.iter().any(|c| c == "secrets") && s.secrets.contains_key(name))
    }

    pub fn refresh_view(view: &str) {
        with(|s| s.refreshed.push(view.into()))
    }

    pub fn post_view_message(view: &str, message: &str) -> Result<(), Error> {
        with(|s| s.view_messages.push((view.into(), message.into())));
        Ok(())
    }

    pub fn open_terminal(title: &str, program: &str, args: &[String]) -> Result<(), Error> {
        with(|s| {
            require(s, &format!("process:{program}"))?;
            s.terminals.push(MockTerminal { title: title.into(), program: program.into(), args: args.to_vec() });
            Ok(())
        })
    }

    pub fn open_location(path: &str, line: u32, column: u32) -> Result<(), Error> {
        with(|s| {
            if require_fs(s, "fs.read", path).is_err() || !path.starts_with(PLUGIN_DIR) {
                require(s, "project.read")?;
            }
            s.locations.push((path.into(), line, column));
            Ok(())
        })
    }

    pub fn setting(key: &str) -> Option<String> {
        with(|s| s.settings.get(key).cloned())
    }

    pub fn run_process(
        program: &str,
        args: &[String],
        cwd: Option<&ProjectRes>,
        stdin: Option<&str>,
    ) -> Result<ProcessOutput, Error> {
        with(|s| {
            require(s, &format!("process:{program}"))?;
            s.runs.push(ProcessRun {
                program: program.into(),
                args: args.to_vec(),
                env: Vec::new(),
                cwd: cwd.map(|p| p.root.clone()),
            });
            match s.processes.get(program) {
                Some(handler) => handler(args, stdin),
                None => Err(Error::NotFound(format!("{program} (MockHost::on_process)"))),
            }
        })
    }

    pub struct ChildRes {
        id: u64,
        owner: Rc<RefCell<State>>,
    }

    impl Drop for ChildRes {
        fn drop(&mut self) {
            self.owner.borrow_mut().children.remove(&self.id);
        }
    }

    fn command_env(cmd: &crate::host::Command) -> Result<(), Error> {
        if cmd.env.len() > 64 {
            return Err(Error::Invalid("at most 64 environment variables".into()));
        }
        let mut names: Vec<&str> = Vec::new();
        for (key, value) in &cmd.env {
            if key.is_empty()
                || key.len() > 256
                || key.contains(['=', '\0'])
                || value.len() > 4096
                || value.contains('\0')
            {
                return Err(Error::Invalid(format!("invalid environment variable {key:?}")));
            }
            if names.iter().any(|name| if cfg!(windows) { name.eq_ignore_ascii_case(key) } else { *name == key }) {
                return Err(Error::Invalid(format!("environment variable {key:?} already exists")));
            }
            names.push(key);
        }
        Ok(())
    }

    /// Runs a [`Command`]: like `run_process`, with its environment in front of
    /// what the program printed (the mock machine has none of its own, so this
    /// is how a test sees the variables arrived).
    pub fn run_command(
        cmd: &crate::host::Command,
        cwd: Option<&ProjectRes>,
        stdin: Option<&str>,
    ) -> Result<ProcessOutput, Error> {
        with(|s| {
            require(s, &format!("process:{}", cmd.program))?;
            command_env(cmd)?;
            s.runs.push(ProcessRun {
                program: cmd.program.clone(),
                args: cmd.args.clone(),
                env: cmd.env.clone(),
                cwd: cwd.map(|p| p.root.clone()),
            });
            let Some(handler) = s.processes.get(&cmd.program) else {
                return Err(Error::NotFound(format!("{} (MockHost::on_process)", cmd.program)));
            };
            let mut out = handler(&cmd.args, stdin)?;
            let env: String = cmd.env.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
            out.stdout.insert_str(0, &env);
            Ok(out)
        })
    }

    /// Starts a [`Command`] and returns its handle (at most 8, as the host allows).
    pub fn start(cmd: &crate::host::Command, cwd: Option<&ProjectRes>) -> Result<ChildRes, Error> {
        with(|s| {
            require(s, &format!("process:{}", cmd.program))?;
            command_env(cmd)?;
            if s.children.len() >= MAX_CHILDREN {
                return Err(Error::Invalid(format!(
                    "{}: too many processes (at most {MAX_CHILDREN} at a time)",
                    cmd.program
                )));
            }
            s.next_child += 1;
            let id = s.next_child;
            let child = ChildState {
                program: cmd.program.clone(),
                args: cmd.args.clone(),
                env: cmd.env.clone(),
                cwd: cwd.map(|p| p.root.clone()),
                stdin: String::new(),
                stdin_closed: false,
                stdout: format!("started: {}\n", cmd.program),
                stderr: String::new(),
                status: None,
            };
            s.children.insert(id, child);
            let owner = CURRENT.with(|c| c.borrow().as_ref().unwrap().clone());
            Ok(ChildRes { id, owner })
        })
    }

    fn child_at(s: &mut State, id: u64) -> Result<&mut ChildState, Error> {
        s.children.get_mut(&id).ok_or_else(|| Error::NotFound(format!("{id} (no such process handle)")))
    }

    /// Up to `max` bytes from the front of `buf`, cut at a character boundary.
    fn take(buf: &mut String, max: u32) -> String {
        let mut cut = (max.max(1) as usize).min(1 << 20).min(buf.len());
        while !buf.is_char_boundary(cut) {
            cut -= 1;
        }
        if cut == 0 && !buf.is_empty() {
            cut = buf.chars().next().unwrap().len_utf8();
        }
        buf.drain(..cut).collect()
    }

    pub fn child_poll(child: &ChildRes, max_bytes: u32) -> Result<crate::host::Chunk, Error> {
        let id = child.id;
        with(|s| {
            let c = child_at(s, id)?;
            Ok(crate::host::Chunk {
                stdout: take(&mut c.stdout, max_bytes),
                stderr: take(&mut c.stderr, max_bytes),
                status: c.status,
            })
        })
    }

    pub fn child_write(child: &ChildRes, text: &str) -> Result<(), Error> {
        let id = child.id;
        with(|s| {
            let c = child_at(s, id)?;
            if c.status.is_some() {
                return Err(Error::Invalid(format!("{id}: the process has ended")));
            }
            if c.stdin_closed {
                return Err(Error::Invalid(format!("{id}: the input is closed")));
            }
            c.stdin.push_str(text);
            c.stdout.push_str(&format!("echo: {text}"));
            Ok(())
        })
    }

    pub fn child_close_stdin(child: &ChildRes) -> Result<(), Error> {
        let id = child.id;
        with(|s| {
            child_at(s, id)?.stdin_closed = true;
            Ok(())
        })
    }

    pub fn child_kill(child: &ChildRes) -> Result<(), Error> {
        let id = child.id;
        with(|s| {
            let c = child_at(s, id)?;
            if c.status.is_none() {
                c.status = Some(-1);
            }
            Ok(())
        })
    }

    pub fn child_wait(child: &ChildRes, timeout_ms: u32) -> Result<crate::host::Chunk, Error> {
        let id = child.id;
        with(|s| {
            let c = child_at(s, id)?;
            if timeout_ms > 0 && c.status.is_none() {
                c.status = Some(0);
            }
            Ok(crate::host::Chunk {
                stdout: std::mem::take(&mut c.stdout),
                stderr: std::mem::take(&mut c.stderr),
                status: c.status,
            })
        })
    }

    pub fn begin_task(title: &str, _cancellable: bool) -> TaskRes {
        with(|s| {
            s.tasks.push(MockTask { title: title.into(), ..MockTask::default() });
            MockTaskRes { index: s.tasks.len() - 1 }
        })
    }

    pub fn task_report(t: &TaskRes, done: u32, total: Option<u32>, message: Option<&str>) {
        with(|s| s.tasks[t.index].reports.push((done, total, message.map(str::to_owned))))
    }

    pub fn task_cancelled(t: &TaskRes) -> bool {
        with(|s| s.tasks[t.index].cancelled)
    }
}

/// `*` within a segment, `**` across segments, `?` one character.
fn glob_match(glob: &str, path: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p {
            [] => s.is_empty(),
            [b'*', b'*', b'/', rest @ ..] => go(rest, s) || (!s.is_empty() && go(p, &s[1..])),
            [b'*', b'*', rest @ ..] => (0..=s.len()).any(|i| go(rest, &s[i..])),
            [b'*', rest @ ..] => (0..=s.len()).take_while(|&i| i == 0 || s[i - 1] != b'/').any(|i| go(rest, &s[i..])),
            [b'?', rest @ ..] => !s.is_empty() && s[0] != b'/' && go(rest, &s[1..]),
            [c, rest @ ..] => s.first() == Some(c) && go(rest, &s[1..]),
        }
    }
    go(glob.as_bytes(), path.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host;

    #[test]
    fn path_subscriptions_replace_pause_and_restore() {
        let mock = MockHost::install();
        host::subscribe_paths("file-opened", &["config/*.yaml"]).unwrap();
        assert_eq!(mock.path_subscriptions()["file-opened"], ["config/*.yaml"]);
        host::subscribe_paths("file-opened", &[]).unwrap();
        assert!(mock.path_subscriptions()["file-opened"].is_empty());
        assert!(host::subscribe_paths("file-opened", &["../secret"]).is_err());
        host::subscribe(EventKind::FileOpened).unwrap();
        assert!(mock.path_subscriptions().is_empty());
        host::subscribe_paths("file-saved", &["**/*.rs"]).unwrap();
        host::unsubscribe(EventKind::FileSaved);
        assert!(mock.path_subscriptions().is_empty());
        let _denied = MockHost::install().with_capabilities(&[]);
        assert!(matches!(host::subscribe_paths("file-opened", &[]), Err(Error::Denied(_))));
    }

    #[test]
    fn project_lookup_uses_deepest_root_without_granting_read_access() {
        let mock = MockHost::install();
        mock.add_project("/project/nested");
        assert_eq!(host::project_of("/project/nested/new.txt").unwrap().root().unwrap(), "/project/nested");
        assert!(host::project_of("/project-other/file").is_none());
        assert!(host::project_of("relative/file").is_none());
        mock.add_project("C:/workspace");
        assert_eq!(host::project_of(r"C:\workspace\file.txt").unwrap().root().unwrap(), "C:/workspace");
        mock.add_project("//server/share");
        assert_eq!(host::project_of(r"\\server\share\file.txt").unwrap().root().unwrap(), "//server/share");
        let _denied = MockHost::install().with_capabilities(&[]);
        assert!(matches!(host::project_of("/project/file").unwrap().root(), Err(Error::Denied(_))));
    }

    #[test]
    fn invocations_carry_selected_paths() {
        let host = MockHost::install();
        assert!(host.invocation().selected_paths().is_empty());
        host.select_paths(&["/p/a", "/p/b"]);
        assert_eq!(host.invocation().selected_paths(), ["/p/a", "/p/b"]);
    }

    #[test]
    fn records_and_enforces() {
        let mock = MockHost::install();
        mock.add_file("src/a.txt", "hello");
        let ctx = mock.invocation();
        let project = ctx.project().unwrap();
        assert_eq!(project.read_file("/project/src/a.txt").unwrap(), "hello");
        assert_eq!(project.read_file("src/a.txt").unwrap(), "hello");
        assert!(matches!(project.read_file("../etc/passwd"), Err(Error::Invalid(_))));
        host::notify(NotificationLevel::Info, "t", "b");
        assert_eq!(mock.notifications()[0].title, "t");
        host::storage::set("k", "v").unwrap();
        assert_eq!(host::storage::get("k").unwrap().as_deref(), Some("v"));
        assert_eq!(host::storage::keys("").unwrap(), ["k"]);
        host::set_status_item("s", &StatusItem { text: "x".into(), tooltip: None, command: None });
        assert_eq!(mock.status_items()["s"].text, "x");
        host::set_context("a", 1.0).unwrap();
        host::set_context("b", "x").unwrap();
        assert_eq!(mock.context_keys()["a"], ContextValue::Number(1.0));
        assert_eq!(mock.context_keys()["b"], ContextValue::Text("x".into()));
        host::remove_context("a");
        host::remove_context("b");
        assert!(mock.context_keys().is_empty());
        mock.set_vcs_remotes(&[("origin", "git@github.com:o/r.git")]);
        assert_eq!(project.vcs_remotes().unwrap(), [("origin".into(), "git@github.com:o/r.git".into())]);
        host::copy_to_clipboard("copied").unwrap();
        assert_eq!(mock.clipboard().as_deref(), Some("copied"));
        host::open_url("https://example.com/a").unwrap();
        assert_eq!(mock.opened_urls(), ["https://example.com/a"]);
        assert!(matches!(host::open_url("file:///etc/passwd"), Err(Error::Invalid(_))));
        let items = [PickItem::new("a", "A"), PickItem::new("b", "B").description("second")];
        assert_eq!(host::pick("Pick", &items).unwrap(), None);
        mock.answer_next_prompt(Some(&["b"]));
        assert_eq!(host::pick("Pick", &items).unwrap().as_deref(), Some("b"));
        mock.answer_next_prompt(Some(&["a", "b"]));
        assert_eq!(host::pick_many("Pick", &items).unwrap(), Some(vec!["a".to_owned(), "b".to_owned()]));
        mock.answer_next_prompt(Some(&["zzz"]));
        assert!(matches!(host::pick_many("Pick", &items), Err(Error::Invalid(_))));
        mock.answer_next_prompt(Some(&["x.txt"]));
        assert_eq!(host::input("Name", Some("a.txt")).unwrap().as_deref(), Some("x.txt"));
        mock.answer_next_prompt(Some(&["a\nb"]));
        assert_eq!(host::input_multiline("Notes", None).unwrap().as_deref(), Some("a\nb"));
        mock.answer_next_prompt(None);
        assert_eq!(host::input_multiline("Notes", None).unwrap(), None);
        mock.answer_next_prompt(Some(&[]));
        assert!(host::confirm("Sure?", "Really").unwrap());
        mock.answer_next_prompt(None);
        assert!(!host::confirm("Sure?", "Really").unwrap());
        host::reveal_view("panel").unwrap();
        assert_eq!(mock.revealed_views(), ["panel"]);
        assert_eq!(host::locale(), "en");
        mock.set_locale("zh-CN");
        assert_eq!(host::locale(), "zh-CN");
        {
            let task = host::begin_task("Work", true);
            task.report(1, Some(2), None);
            mock.cancel_tasks();
            assert!(task.is_cancelled());
        }
        assert!(mock.tasks()[0].ended);
    }

    #[test]
    fn exists_and_stat_report_missing_as_not_found() {
        let mock = MockHost::install();
        mock.add_file("src/a.txt", "hello");
        mock.add_dir("src");
        mock.add_dir(".hidden");
        let project = mock.invocation().project().unwrap();
        assert!(project.exists("src/a.txt").unwrap());
        assert!(project.exists("src").unwrap());
        assert!(project.exists(".hidden").unwrap());
        assert!(project.exists("/project/src/a.txt").unwrap());
        assert!(!project.exists("missing.txt").unwrap());
        assert!(!project.exists("missing/dir").unwrap());
        assert!(matches!(project.exists("../outside"), Err(Error::Invalid(_))));
        assert!(matches!(project.read_file("missing.txt"), Err(Error::NotFound(_))));

        let file = project.stat("src/a.txt").unwrap();
        assert_eq!((file.kind, file.size), (FileKind::File, 5));
        let dir = project.stat("src").unwrap();
        assert_eq!(dir.kind, FileKind::Directory);
        assert!(matches!(project.stat("missing.txt"), Err(Error::NotFound(_))));
        assert!(matches!(project.stat("../outside"), Err(Error::Invalid(_))));

        let read_only = MockHost::install().with_capabilities(&[]);
        let project = read_only.invocation().project().unwrap();
        assert!(matches!(project.exists("x"), Err(Error::Denied(_))));
        assert!(matches!(project.stat("x"), Err(Error::Denied(_))));
    }

    #[test]
    fn indexed_symbols_are_bounded_scoped_and_capability_checked() {
        let mock = MockHost::install();
        let symbol = SymbolInfo {
            name: "OrderController".into(),
            kind: "class".into(),
            container: Some("App".into()),
            location: Location {
                path: "/project/Order.php".into(),
                range: Range::new(Position::new(0, 2), Position::new(0, 17)),
            },
        };
        let mut symbols = vec![symbol.clone(); 1001];
        let mut outside = symbol.clone();
        outside.location.path = "/project-other/Order.php".into();
        symbols.insert(0, outside);
        mock.set_symbols("/project", symbols);
        mock.add_project("/other");
        let project = mock.invocation().project().unwrap();
        assert_eq!(project.symbols("order", u32::MAX).unwrap().len(), 1000);
        assert_eq!(project.symbols("order", 1).unwrap(), [symbol]);
        assert!(project.symbols("", 1).unwrap().is_empty());
        assert!(project.symbols("order", 0).unwrap().is_empty());
        assert!(matches!(project.symbols(&"é".repeat(129), 1), Err(Error::Invalid(_))));
        assert!(host::projects().unwrap()[1].symbols("order", 1).unwrap().is_empty());
        mock.set_symbols("/project", Vec::new());
        assert!(project.symbols("order", 1).unwrap().is_empty());
        mock.set_project_root(None);
        assert!(matches!(project.symbols("order", 1), Err(Error::NotFound(_))));
        let _mock = mock.with_capabilities(&[]);
        assert_eq!(project.symbols("order", 1), Err(Error::Denied("project.read".into())));
    }

    #[test]
    fn versioned_edits() {
        let mock = MockHost::install();
        mock.open_editor("/project/a.txt", "text", "one two", &[(0, 0, 0, 3), (0, 4, 0, 7)]);
        let editor = mock.invocation().editor().unwrap();
        let v = editor.transform_selections(|s| s.to_uppercase()).unwrap();
        assert_eq!((mock.editor_text().as_str(), v), ("ONE TWO", 2));
        assert_eq!(editor.apply_edits(1, &[]), Err(Error::Stale));
        mock.type_in_editor("!");
        assert_eq!(mock.editor_version(), 3);
    }

    #[test]
    fn notification_buttons_are_recorded_and_bounded() {
        let mock = MockHost::install();
        let action = NotificationAction::new("Open", "open").argument("first\nsecond");
        host::notify_with_actions(NotificationLevel::Info, "Done", "", std::slice::from_ref(&action)).unwrap();
        assert_eq!(mock.notifications_with_actions()[0].actions, vec![action.clone()]);
        let too_many: [_; 4] = std::array::from_fn(|_| action.clone());
        assert!(host::notify_with_actions(NotificationLevel::Info, "Done", "", &too_many).is_err());
        assert_eq!(mock.notifications().len(), 1);
    }

    #[test]
    fn files_outside_the_project_need_an_fs_read_grant() {
        let mock = MockHost::install().with_capabilities(&["fs.read:/opt/tool"]);
        mock.add_external_file("/opt/tool/conf/app.yaml", "port: 8080");
        mock.add_external_file("/opt/tool/README", "hi");
        mock.add_external_file("/opt/other/secret", "no");
        assert_eq!(host::fs::read_file("/opt/tool/conf/app.yaml").unwrap(), "port: 8080");
        assert_eq!(host::fs::read_bytes("/opt/tool/README").unwrap(), b"hi");
        assert_eq!(host::fs::stat("/opt/tool/conf").unwrap().kind, FileKind::Directory);
        let names: Vec<_> = host::fs::read_dir("/opt/tool").unwrap().into_iter().map(|e| (e.name, e.kind)).collect();
        assert_eq!(names, [("README".into(), FileKind::File), ("conf".into(), FileKind::Directory)]);
        assert!(matches!(host::fs::read_file("/opt/other/secret"), Err(Error::Denied(_))));
        assert!(matches!(host::fs::read_file("relative"), Err(Error::Invalid(_))));
    }

    #[test]
    fn missing_capabilities_are_denied() {
        let mock = MockHost::install().with_capabilities(&["project.read"]);
        mock.open_editor("/project/a.txt", "text", "x", &[]);
        let editor = mock.invocation().editor().unwrap();
        assert_eq!(editor.apply_edits(1, &[]), Err(Error::Denied("editor.write".into())));
        assert_eq!(host::storage::get("k"), Err(Error::Denied("storage".into())));
        assert_eq!(host::subscribe(EventKind::ActionPerformed), Err(Error::Denied("events.input".into())));
        assert_eq!(mock.invocation().project().unwrap().vcs_remotes(), Err(Error::Denied("vcs.read".into())));
        assert_eq!(host::copy_to_clipboard("x"), Err(Error::Denied("clipboard".into())));
    }

    #[test]
    fn child_resources_return_slots_and_zero_timeout_only_checks() {
        let _mock = MockHost::install().with_capabilities(&["process:git"]);
        let command = host::Command::new("git").env("NEW_KEY", "new");
        for _ in 0..10 {
            let child = host::start(&command, None).unwrap();
            assert_eq!(child.wait(0).unwrap().status, None);
            child.write("中").unwrap();
            assert_eq!(child.poll(0).unwrap().stdout, "e");
            child.kill().unwrap();
            assert_eq!(child.poll(100).unwrap().status, Some(-1));
        }
        let children: Vec<_> = (0..8).map(|_| host::start(&command, None).unwrap()).collect();
        assert!(matches!(host::start(&command, None), Err(Error::Invalid(_))));
        drop(children);
        assert!(host::start(&command, None).is_ok());
        assert!(matches!(host::start(&command.clone().env("NEW_KEY", "override"), None), Err(Error::Invalid(_))));
    }

    #[test]
    fn network_secrets_processes_and_files() {
        let mock = MockHost::install();
        mock.add_file("src/a/UserMapper.xml", "<mapper/>");
        mock.add_file("src/B.java", "class B {}");
        let project = mock.invocation().project().unwrap();
        assert_eq!(project.find_files("**/*Mapper.xml", 10).unwrap(), ["/project/src/a/UserMapper.xml"]);
        assert!(
            matches!(host::fetch(&HttpRequest::get("https://api.x.io/v1")), Err(Error::Denied(c)) if c == "net:api.x.io")
        );

        let mock = MockHost::install().with_capabilities(&["net:api.x.io", "secrets", "project.read", "process:java"]);
        mock.set_secret("key", "s3cr3t");
        mock.on_fetch(|r| Ok(HttpResponse { status: 200, headers: vec![], body: r.headers[0].1.clone().into_bytes() }));
        let r = host::fetch(&HttpRequest::get("https://api.x.io/v1").header("Authorization", "Bearer {{secret:key}}"))
            .unwrap();
        assert_eq!(r.text(), "Bearer s3cr3t");
        assert!(host::secret_is_set("key"));
        mock.on_process("java", |args, _| {
            Ok(ProcessOutput { status: Some(0), stdout: args.join(" "), stderr: String::new() })
        });
        let out = mock.invocation().project().unwrap().run_process("java", &["-version".into()], None).unwrap();
        assert_eq!(out.stdout, "-version");
        assert_eq!(mock.process_runs()[0].cwd.as_deref(), Some("/project"));
        host::publish_diagnostics("/project/a.java", &[Diagnostic::new(Range::default(), Severity::Warning, "m")])
            .unwrap();
        assert_eq!(mock.diagnostics()["/project/a.java"].len(), 1);
    }

    #[test]
    fn private_directory_needs_no_filesystem_grants() {
        let _mock = MockHost::install().with_capabilities(&[]);
        let dir = host::fs::plugin_dir().unwrap();
        assert_eq!(host::fs::stat(&dir).unwrap().kind, FileKind::Directory);
        assert!(host::fs::read_dir(&dir).unwrap().is_empty());
        let file = format!("{dir}/fake.txt");
        host::fs::write_file(&file, "fake text").unwrap();
        assert_eq!(host::fs::read_file(&file).unwrap(), "fake text");
        host::fs::write_bytes(&file, b"fake bytes").unwrap();
        assert_eq!(host::fs::read_bytes(&file).unwrap(), b"fake bytes");
        assert_eq!(host::fs::read_dir(&dir).unwrap()[0].name, "fake.txt");
        for path in [format!("{dir}-other/file"), format!("{dir}/../other/file")] {
            assert!(matches!(host::fs::read_file(&path), Err(Error::Denied(_))));
            assert!(matches!(host::fs::write_file(&path, "x"), Err(Error::Denied(_))));
        }
    }

    #[test]
    fn fs_write_needs_a_grant_of_its_own() {
        // `fs.read` does not let a plugin write.
        let mock = MockHost::install().with_capabilities(&["fs.read:/opt/seeyon"]);
        mock.add_external_file("/opt/seeyon/app.properties", "name=YonBIP\n");
        assert_eq!(
            host::fs::write_file("/opt/seeyon/app.properties", "name=YonBIP2\n"),
            Err(Error::Denied("fs.write:/opt/seeyon/app.properties".into()))
        );
        assert_eq!(host::fs::read_file("/opt/seeyon/app.properties").unwrap(), "name=YonBIP\n");

        // Nor does `fs.write` imply reading.
        let mock = MockHost::install().with_capabilities(&["fs.write:/opt/seeyon"]);
        mock.add_external_file("/opt/seeyon/app.properties", "name=YonBIP\n");
        host::fs::write_file("/opt/seeyon/app.properties", "name=YonBIP2\n").unwrap();
        assert_eq!(
            host::fs::read_file("/opt/seeyon/app.properties"),
            Err(Error::Denied("fs.read:/opt/seeyon/app.properties".into()))
        );

        let mock = MockHost::install().with_capabilities(&["fs.read:/opt/seeyon", "fs.write:/opt/seeyon"]);
        mock.add_external_file("/opt/seeyon/app.properties", "name=YonBIP\n");
        mock.add_external_file("/opt/seeyon/conf/licence.xml", "<licence/>");
        host::fs::write_file("/opt/seeyon/app.properties", "name=YonBIP2\n").unwrap();
        assert_eq!(host::fs::read_file("/opt/seeyon/app.properties").unwrap(), "name=YonBIP2\n");
        assert_eq!(host::fs::read_bytes("/opt/seeyon/app.properties").unwrap(), b"name=YonBIP2\n".to_vec());
        // A file that was not there is created; bytes stay bytes.
        host::fs::write_bytes("/opt/seeyon/blob.bin", &[0xff, 0x00, 0x7f]).unwrap();
        assert_eq!(host::fs::read_bytes("/opt/seeyon/blob.bin").unwrap(), [0xff, 0x00, 0x7f]);
        assert_eq!(host::fs::stat("/opt/seeyon/blob.bin").unwrap().size, 3);
        assert!(matches!(host::fs::read_file("/opt/seeyon/blob.bin"), Err(Error::Invalid(_))));

        // Relative paths are path errors, a directory is not a file, and a
        // missing parent directory is not created.
        assert!(matches!(host::fs::write_file("opt/seeyon/app.properties", "x"), Err(Error::Invalid(_))));
        assert!(matches!(host::fs::write_file("/opt/seeyon/conf", "x"), Err(Error::Invalid(_))));
        assert!(matches!(host::fs::write_bytes("/opt/seeyon/no/dir/x.bin", &[1]), Err(Error::Invalid(_))));
    }
}

#[cfg(test)]
mod project_ui_tests {
    use super::MockHost;
    use crate::host;
    #[test]
    fn folder_choices_and_project_requests_need_no_capability() {
        let mock = MockHost::install().with_capabilities(&[]);
        mock.answer_next_prompt(Some(&["C:/work/repo"]));
        assert_eq!(host::pick_directory("Target", Some("C:/work")).unwrap().as_deref(), Some("C:/work/repo"));
        assert_eq!(host::pick_directory("Target", None).unwrap(), None);
        host::open_project("C:/work/repo", true).unwrap();
        host::open_project("/home/user/repo", false).unwrap();
        assert_eq!(mock.opened_projects(), vec![("C:/work/repo".into(), true), ("/home/user/repo".into(), false)]);
        for path in ["relative", "C:relative", "/bad\npath", ""] {
            assert!(host::open_project(path, false).is_err());
        }
    }
}
