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
    /// The project root it ran in (`None`: the data directory).
    pub cwd: Option<String>,
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
    files: BTreeMap<String, String>,
    editor: Option<Editor>,
    selected_paths: Vec<String>,
    notifications: Vec<Notification>,
    logs: Vec<(LogLevel, String)>,
    status: BTreeMap<String, StatusItem>,
    context: BTreeMap<String, ContextValue>,
    storage: BTreeMap<String, String>,
    subscriptions: BTreeSet<EventKind>,
    tasks: Vec<MockTask>,
    vcs: Option<RepositoryStatus>,
    remotes: Vec<(String, String)>,
    fetches: u32,
    fetch_error: Option<Error>,
    clipboard: Option<String>,
    opened_urls: Vec<String>,
    answers: VecDeque<Option<Vec<String>>>,
    revealed_views: Vec<String>,
    diagnostics: BTreeMap<String, Vec<Diagnostic>>,
    secrets: BTreeMap<String, String>,
    net: Option<NetHandler>,
    requests: Vec<HttpRequest>,
    processes: BTreeMap<String, ProcessHandler>,
    runs: Vec<ProcessRun>,
    refreshed: Vec<String>,
    view_messages: Vec<(String, String)>,
    terminals: Vec<MockTerminal>,
    locations: Vec<(String, u32, u32)>,
    settings: BTreeMap<String, String>,
}

/// A terminal the plugin opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockTerminal {
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
}

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

    /// A project file `read_file` can return (project-relative or absolute path).
    pub fn add_file(&self, path: &str, text: &str) {
        self.state.borrow_mut().files.insert(path.to_owned(), text.to_owned());
    }

    /// Sets the paths invocations report as selected.
    pub fn select_paths(&self, paths: &[&str]) {
        self.state.borrow_mut().selected_paths = paths.iter().map(|p| (*p).to_owned()).collect();
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

    pub fn log(level: LogLevel, message: &str) {
        with(|s| s.logs.push((level, message.to_owned())))
    }

    pub fn notify(level: NotificationLevel, title: &str, body: &str) {
        with(|s| s.notifications.push(Notification { level, title: title.into(), body: body.into() }))
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

    pub fn project_root(p: &ProjectRes) -> Result<String, Error> {
        with(|s| {
            require(s, "project.read")?;
            Ok(p.root.clone())
        })
    }

    pub fn project_read(p: &ProjectRes, path: &str) -> Result<String, Error> {
        with(|s| {
            require(s, "project.read")?;
            let root = p.root.as_str();
            let rel = path.strip_prefix(root).map(|p| p.trim_start_matches('/')).unwrap_or(path);
            if rel.starts_with('/') || rel.split('/').any(|seg| seg == "..") {
                return Err(Error::Invalid(format!("{path}: access outside the project root is not allowed")));
            }
            let open = s.editor.as_ref().filter(|e| e.path == path || e.path == format!("{root}/{rel}"));
            if let Some(e) = open {
                return Ok(e.text.clone());
            }
            s.files.get(rel).or_else(|| s.files.get(path)).cloned().ok_or_else(|| Error::NotFound(path.into()))
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
            s.subscriptions.insert(kind);
            Ok(())
        })
    }

    pub fn unsubscribe(kind: EventKind) {
        with(|s| s.subscriptions.remove(&kind));
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
            require(s, "project.read")?;
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
            s.runs.push(ProcessRun { program: program.into(), args: args.to_vec(), cwd: cwd.map(|p| p.root.clone()) });
            match s.processes.get(program) {
                Some(handler) => handler(args, stdin),
                None => Err(Error::NotFound(format!("{program} (MockHost::on_process)"))),
            }
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
        mock.answer_next_prompt(Some(&[]));
        assert!(host::confirm("Sure?", "Really").unwrap());
        mock.answer_next_prompt(None);
        assert!(!host::confirm("Sure?", "Really").unwrap());
        host::reveal_view("panel").unwrap();
        assert_eq!(mock.revealed_views(), ["panel"]);
        {
            let task = host::begin_task("Work", true);
            task.report(1, Some(2), None);
            mock.cancel_tasks();
            assert!(task.is_cancelled());
        }
        assert!(mock.tasks()[0].ended);
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
}
