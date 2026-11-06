//! The IDE functions and handles a plugin may use. Gated ones need the
//! capability in `plugin.toml` (`[capabilities] required = [...]`) and the
//! user's grant; without it they return [`Error::Denied`].

use crate::types::*;

#[cfg(target_arch = "wasm32")]
mod imp {
    //! Calls through the `openidea:plugin@1.0.0` world.
    use crate::bindings::openidea::plugin as wit;
    use crate::types::*;

    pub type InvocationRef<'a> = &'a wit::invocation::Invocation;
    pub type ProjectRes = wit::workspace::Project;
    pub type EditorRes = wit::editor::TextEditor;
    pub type TaskRes = wit::tasks::Task;

    pub fn error(e: wit::types::Error) -> Error {
        use wit::types::Error as E;
        match e {
            E::Denied(c) => Error::Denied(c),
            E::Stale => Error::Stale,
            E::NotFound(m) => Error::NotFound(m),
            E::Invalid(m) => Error::Invalid(m),
            E::Cancelled => Error::Cancelled,
            E::Failed(m) => Error::Failed(m),
        }
    }

    fn range_in(r: wit::types::Range) -> Range {
        Range::new(Position::new(r.start.line, r.start.character), Position::new(r.end.line, r.end.character))
    }

    fn range_out(r: Range) -> wit::types::Range {
        wit::types::Range {
            start: wit::types::Position { line: r.start.line, character: r.start.character },
            end: wit::types::Position { line: r.end.line, character: r.end.character },
        }
    }

    pub fn log(level: LogLevel, message: &str) {
        use wit::types::LogLevel as L;
        let level = match level {
            LogLevel::Trace => L::Trace,
            LogLevel::Debug => L::Debug,
            LogLevel::Info => L::Info,
            LogLevel::Warn => L::Warn,
            LogLevel::Error => L::Error,
        };
        wit::log::log(level, message)
    }

    pub fn notify(level: NotificationLevel, title: &str, body: &str) {
        use wit::types::NotificationLevel as N;
        let level = match level {
            NotificationLevel::Info => N::Info,
            NotificationLevel::Warning => N::Warning,
            NotificationLevel::Error => N::Error,
        };
        wit::ui::show_notification(level, title, body)
    }

    pub fn set_status_item(id: &str, item: &StatusItem) {
        let item = wit::ui::StatusItem {
            text: item.text.clone(),
            tooltip: item.tooltip.clone(),
            command: item.command.clone(),
        };
        wit::ui::set_status_item(id, &item)
    }

    pub fn remove_status_item(id: &str) {
        wit::ui::remove_status_item(id)
    }

    pub fn copy_to_clipboard(text: &str) -> Result<(), Error> {
        wit::ui::copy_to_clipboard(text).map_err(error)
    }

    pub fn open_url(url: &str) -> Result<(), Error> {
        wit::ui::open_url(url).map_err(error)
    }

    pub fn storage_get(key: &str) -> Result<Option<String>, Error> {
        wit::storage::get(key).map_err(error)
    }

    pub fn storage_set(key: &str, value: &str) -> Result<(), Error> {
        wit::storage::set(key, value).map_err(error)
    }

    pub fn storage_delete(key: &str) -> Result<(), Error> {
        wit::storage::delete(key).map_err(error)
    }

    pub fn storage_keys(prefix: &str) -> Result<Vec<String>, Error> {
        wit::storage::keys(prefix).map_err(error)
    }

    pub fn projects() -> Result<Vec<ProjectRes>, Error> {
        wit::workspace::projects().map_err(error)
    }

    pub fn project_root(p: &ProjectRes) -> Result<String, Error> {
        p.root().map_err(error)
    }

    pub fn project_read(p: &ProjectRes, path: &str) -> Result<String, Error> {
        p.read_file(path).map_err(error)
    }

    pub fn invocation_project(i: InvocationRef<'_>) -> Option<ProjectRes> {
        i.project()
    }

    pub fn invocation_editor(i: InvocationRef<'_>) -> Option<EditorRes> {
        i.editor()
    }

    pub fn invocation_selected_paths(i: InvocationRef<'_>) -> Vec<String> {
        i.selected_paths()
    }

    pub fn editor_path(e: &EditorRes) -> String {
        e.path()
    }

    pub fn editor_language(e: &EditorRes) -> String {
        e.language()
    }

    pub fn editor_document(e: &EditorRes) -> Result<Document, Error> {
        e.document().map(|d| Document { version: d.version, text: d.text }).map_err(error)
    }

    pub fn editor_selections(e: &EditorRes) -> Result<Vec<Range>, Error> {
        e.selections().map(|s| s.into_iter().map(range_in).collect()).map_err(error)
    }

    pub fn editor_apply(e: &EditorRes, version: u64, edits: &[TextEdit]) -> Result<u64, Error> {
        let edits: Vec<wit::types::TextEdit> =
            edits.iter().map(|t| wit::types::TextEdit { range: range_out(t.range), text: t.text.clone() }).collect();
        e.apply_edits(version, &edits).map_err(error)
    }

    pub fn vcs_status(p: &ProjectRes) -> Result<Option<RepositoryStatus>, Error> {
        wit::vcs::status(p)
            .map(|s| {
                s.map(|s| RepositoryStatus {
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
            .map_err(error)
    }

    pub fn vcs_fetch(p: &ProjectRes) -> Result<(), Error> {
        wit::vcs::fetch(p).map_err(error)
    }

    pub fn vcs_remotes(p: &ProjectRes) -> Result<Vec<(String, String)>, Error> {
        wit::vcs::remotes(p).map_err(error)
    }

    pub fn subscribe(k: EventKind) -> Result<(), Error> {
        wit::events::subscribe(k.name()).map_err(error)
    }

    pub fn unsubscribe(k: EventKind) {
        wit::events::unsubscribe(k.name())
    }

    pub fn begin_task(title: &str, cancellable: bool) -> TaskRes {
        wit::tasks::begin(title, cancellable)
    }

    pub fn task_report(t: &TaskRes, done: u32, total: Option<u32>, message: Option<&str>) {
        t.report(done, total, message)
    }

    pub fn task_cancelled(t: &TaskRes) -> bool {
        t.is_cancelled()
    }

    pub fn project_find(p: &ProjectRes, glob: &str, limit: u32) -> Result<Vec<String>, Error> {
        p.find_files(glob, limit).map_err(error)
    }

    pub fn publish_diagnostics(path: &str, items: &[Diagnostic]) -> Result<(), Error> {
        use wit::diagnostics::{Diagnostic as D, RelatedInformation as R, Severity as S};
        let items: Vec<D> = items
            .iter()
            .map(|d| D {
                range: range_out(d.range),
                severity: match d.severity {
                    Severity::Error => S::Error,
                    Severity::Warning => S::Warning,
                    Severity::Info => S::Info,
                    Severity::Hint => S::Hint,
                },
                message: d.message.clone(),
                code: d.code.clone(),
                source: d.source.clone(),
                tags: [(d.unnecessary, "unnecessary"), (d.deprecated, "deprecated")]
                    .into_iter()
                    .filter(|(on, _)| *on)
                    .map(|(_, tag)| tag.to_owned())
                    .collect(),
                related: d
                    .related
                    .iter()
                    .map(|r| R {
                        location: wit::types::Location {
                            path: r.location.path.clone(),
                            range: range_out(r.location.range),
                        },
                        message: r.message.clone(),
                    })
                    .collect(),
            })
            .collect();
        wit::diagnostics::publish(path, &items).map_err(error)
    }

    pub fn fetch(req: &HttpRequest) -> Result<HttpResponse, Error> {
        let r = wit::net::Request {
            method: req.method.clone(),
            url: req.url.clone(),
            headers: req.headers.iter().map(|(n, v)| wit::net::Header { name: n.clone(), value: v.clone() }).collect(),
            body: req.body.clone(),
            timeout_ms: req.timeout_ms,
        };
        wit::net::fetch(&r)
            .map(|r| HttpResponse {
                status: r.status,
                headers: r.headers.into_iter().map(|h| (h.name, h.value)).collect(),
                body: r.body,
            })
            .map_err(error)
    }

    pub fn secret_is_set(name: &str) -> bool {
        wit::secrets::is_set(name)
    }

    pub fn refresh_view(view: &str) {
        wit::views::refresh(view)
    }

    pub fn post_view_message(view: &str, message: &str) -> Result<(), Error> {
        wit::views::post_message(view, message).map_err(error)
    }

    pub fn open_terminal(title: &str, program: &str, args: &[String]) -> Result<(), Error> {
        wit::views::open_terminal(title, program, args).map_err(error)
    }

    pub fn open_location(path: &str, line: u32, column: u32) -> Result<(), Error> {
        wit::views::open_location(path, line, column).map_err(error)
    }

    pub fn setting(key: &str) -> Option<String> {
        wit::settings::get(key)
    }

    pub fn run_process(
        program: &str,
        args: &[String],
        cwd: Option<&ProjectRes>,
        stdin: Option<&str>,
    ) -> Result<ProcessOutput, Error> {
        wit::process::run(program, args, cwd, stdin)
            .map(|o| ProcessOutput { status: o.status, stdout: o.stdout, stderr: o.stderr })
            .map_err(error)
    }

    pub fn range_from(r: wit::types::Range) -> Range {
        range_in(r)
    }

    pub fn range_to(r: Range) -> wit::types::Range {
        range_out(r)
    }

    pub fn event(e: wit::events::Event) -> Event {
        use wit::events::Event as E;
        match e {
            E::FileOpened(p) => Event::FileOpened(p),
            E::FileSaved(p) => Event::FileSaved(p),
            E::EditorFocused(p) => Event::EditorFocused(p),
            E::VcsChanged(p) => Event::VcsChanged(p),
            E::Scheduled => Event::Scheduled,
            E::ActionPerformed(a) => Event::ActionPerformed(ActionPerformed {
                action: a.action,
                title: a.title,
                source: ActionSource::parse(&a.source),
                shortcut: a.shortcut,
            }),
            E::Other(x) => Event::Other { kind: x.kind, data: x.data },
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
use crate::mock::current as imp;

/// Where a command or event batch comes from: the window's project and
/// focused editor.
pub struct Invocation<'a> {
    inner: imp::InvocationRef<'a>,
}

impl<'a> Invocation<'a> {
    #[doc(hidden)]
    pub fn __new(inner: imp::InvocationRef<'a>) -> Self {
        Self { inner }
    }

    /// The window's project.
    pub fn project(&self) -> Option<Project> {
        imp::invocation_project(self.inner).map(|inner| Project { inner })
    }

    /// The window's focused editor.
    pub fn editor(&self) -> Option<TextEditor> {
        imp::invocation_editor(self.inner).map(|inner| TextEditor { inner })
    }

    /// The files and folders the command was run on, as absolute paths. Empty when it was not
    /// run on any, or when the menu was for a tab without a file (a virtual document).
    pub fn selected_paths(&self) -> Vec<String> {
        imp::invocation_selected_paths(self.inner)
    }
}

/// A project open in the IDE.
pub struct Project {
    inner: imp::ProjectRes,
}

impl Project {
    /// Absolute path of the root. Needs `project.read`.
    pub fn root(&self) -> Result<String, Error> {
        imp::project_root(&self.inner)
    }

    /// Reads a UTF-8 file inside the project (absolute or root-relative);
    /// unsaved editor contents win. Needs `project.read`.
    pub fn read_file(&self, path: &str) -> Result<String, Error> {
        imp::project_read(&self.inner, path)
    }

    /// The repository containing the project (`None`: not under git). Needs `vcs.read`.
    pub fn vcs_status(&self) -> Result<Option<RepositoryStatus>, Error> {
        imp::vcs_status(&self.inner)
    }

    /// Configured remotes (`(name, fetch_url)`), in order. Needs `vcs.read`.
    pub fn vcs_remotes(&self) -> Result<Vec<(String, String)>, Error> {
        imp::vcs_remotes(&self.inner)
    }

    /// Fetches all remotes. Needs `vcs.write`; long-running, so call it in a [`Task`].
    pub fn vcs_fetch(&self) -> Result<(), Error> {
        imp::vcs_fetch(&self.inner)
    }

    /// Project files whose root-relative path matches `glob` (`**/*Mapper.xml`),
    /// at most `limit`, as absolute paths; ignored files are skipped. Needs `project.read`.
    pub fn find_files(&self, glob: &str, limit: u32) -> Result<Vec<String>, Error> {
        imp::project_find(&self.inner, glob, limit)
    }

    /// Runs the approved `process:<program>` in this project's root.
    pub fn run_process(&self, program: &str, args: &[String], stdin: Option<&str>) -> Result<ProcessOutput, Error> {
        imp::run_process(program, args, Some(&self.inner), stdin)
    }
}

/// Replaces the plugin's diagnostics for `path` (absolute, in an open
/// project); an empty slice clears them. Needs `project.read`.
pub fn publish_diagnostics(path: &str, items: &[Diagnostic]) -> Result<(), Error> {
    imp::publish_diagnostics(path, items)
}

/// HTTP(S) to a host granted with `net:<host>` (plain http only to
/// localhost). `{{secret:<name>}}` in a header is filled in by the IDE (needs
/// `secrets`). `Error::Cancelled` when the call was superseded.
pub fn fetch(request: &HttpRequest) -> Result<HttpResponse, Error> {
    imp::fetch(request)
}

/// Whether the user stored secret `name` (declared under `[[contributes.secrets]]`).
pub fn secret_is_set(name: &str) -> bool {
    imp::secret_is_set(name)
}

/// The content of view (or custom editor) `view` changed: the IDE renders it again.
pub fn refresh_view(view: &str) {
    imp::refresh_view(view)
}

/// Sends `message` to the script of view `view`'s HTML body.
pub fn post_view_message(view: &str, message: &str) -> Result<(), Error> {
    imp::post_view_message(view, message)
}

/// Opens a terminal tab in the invoking window running the approved
/// `process:<program>` in the project root: logs that keep coming,
/// interactive sessions (`kubectl exec -it …`).
pub fn open_terminal(title: &str, program: &str, args: &[String]) -> Result<(), Error> {
    imp::open_terminal(title, program, args)
}

pub fn open_location(path: &str, line: u32, column: u32) -> Result<(), Error> {
    imp::open_location(path, line, column)
}

/// One of the plugin's settings (`[contributes.settings]`) as JSON: the
/// user's value (project over global) or the schema's default.
pub fn setting(key: &str) -> Option<String> {
    imp::setting(key)
}

/// A boolean setting.
pub fn setting_bool(key: &str) -> Option<bool> {
    setting(key).and_then(|v| v.parse().ok())
}

/// A string setting.
pub fn setting_string(key: &str) -> Option<String> {
    let v = setting(key)?;
    let inner = v.strip_prefix('"')?.strip_suffix('"')?;
    Some(crate::text::unescape_json(inner))
}

/// A number setting.
pub fn setting_number(key: &str) -> Option<f64> {
    setting(key).and_then(|v| v.parse().ok())
}

/// Runs the approved `process:<program>` in the plugin's data directory
/// (see [`Project::run_process`] to run it in a project).
pub fn run_process(program: &str, args: &[String], stdin: Option<&str>) -> Result<ProcessOutput, Error> {
    imp::run_process(program, args, None, stdin)
}

/// Projects open in any window. Needs `project.read`.
pub fn projects() -> Result<Vec<Project>, Error> {
    Ok(imp::projects()?.into_iter().map(|inner| Project { inner }).collect())
}

/// A file open in an editor.
pub struct TextEditor {
    inner: imp::EditorRes,
}

impl TextEditor {
    pub fn path(&self) -> String {
        imp::editor_path(&self.inner)
    }

    pub fn language(&self) -> String {
        imp::editor_language(&self.inner)
    }

    /// Current version and text. Needs `editor.read`.
    pub fn document(&self) -> Result<Document, Error> {
        imp::editor_document(&self.inner)
    }

    /// Selections when the command was invoked. Needs `editor.read`.
    pub fn selections(&self) -> Result<Vec<Range>, Error> {
        imp::editor_selections(&self.inner)
    }

    /// Applies `edits` (in `version`'s coordinates, not overlapping) as one
    /// undoable change; [`Error::Stale`] if the document changed meanwhile.
    /// Returns the new version. Needs `editor.write`.
    pub fn apply_edits(&self, version: u64, edits: &[TextEdit]) -> Result<u64, Error> {
        imp::editor_apply(&self.inner, version, edits)
    }

    /// Replaces every selection with `f(selected text)` in one undoable
    /// change, retrying once if the user typed in between. Cursors get
    /// `f("")` inserted. Needs `editor.read` and `editor.write`.
    pub fn transform_selections(&self, mut f: impl FnMut(&str) -> String) -> Result<u64, Error> {
        let selections = self.selections()?;
        let mut last = Error::Stale;
        for _ in 0..2 {
            let doc = self.document()?;
            let mut edits = Vec::with_capacity(selections.len());
            for r in &selections {
                let old = doc.text_in(*r).ok_or_else(|| Error::Invalid("selection outside the document".into()))?;
                let new = f(old);
                if new != old {
                    edits.push(TextEdit { range: *r, text: new });
                }
            }
            match self.apply_edits(doc.version, &edits) {
                Err(Error::Stale) => last = Error::Stale,
                other => return other,
            }
        }
        Err(last)
    }
}

/// Long-running work shown in the status bar; dropping it ends it. While a
/// task is open, the current call may run for up to 60 s instead of 5 s.
pub struct Task {
    inner: imp::TaskRes,
}

impl Task {
    /// `done` of `total` units (`None`: indeterminate), with a short status.
    pub fn report(&self, done: u32, total: Option<u32>, message: Option<&str>) {
        imp::task_report(&self.inner, done, total, message)
    }

    /// The user cancelled it: stop soon and return.
    pub fn is_cancelled(&self) -> bool {
        imp::task_cancelled(&self.inner)
    }
}

/// Starts a task (see [`Task`]).
pub fn begin_task(title: &str, cancellable: bool) -> Task {
    Task { inner: imp::begin_task(title, cancellable) }
}

/// Writes to the IDE log, tagged with the plugin id.
pub fn log(level: LogLevel, message: &str) {
    imp::log(level, message)
}

/// Shows a notification balloon in the window the command or events came
/// from (every window when there is none).
pub fn notify(level: NotificationLevel, title: &str, body: &str) {
    imp::notify(level, title, body)
}

/// Shows or updates the plugin's status bar item `id` (at most 8).
pub fn set_status_item(id: &str, item: &StatusItem) {
    imp::set_status_item(id, item)
}

pub fn remove_status_item(id: &str) {
    imp::remove_status_item(id)
}

/// Copies `text` to the system clipboard. Needs `clipboard`.
pub fn copy_to_clipboard(text: &str) -> Result<(), Error> {
    imp::copy_to_clipboard(text)
}

/// Opens an `http://` or `https://` URL in the user's default browser.
pub fn open_url(url: &str) -> Result<(), Error> {
    imp::open_url(url)
}

/// Delivers `kind` events to [`crate::Plugin::handle_events`] for the rest of
/// the session (also after the instance is reclaimed: an event activates the
/// plugin again). Needs `events` (`events.input` for `ActionPerformed`).
pub fn subscribe(kind: EventKind) -> Result<(), Error> {
    imp::subscribe(kind)
}

pub fn unsubscribe(kind: EventKind) {
    imp::unsubscribe(kind)
}

/// The plugin's persistent key-value store (≤ 1 MiB). Needs `storage`.
pub mod storage {
    use super::imp;
    use crate::types::Error;

    pub fn get(key: &str) -> Result<Option<String>, Error> {
        imp::storage_get(key)
    }

    pub fn set(key: &str, value: &str) -> Result<(), Error> {
        imp::storage_set(key, value)
    }

    pub fn delete(key: &str) -> Result<(), Error> {
        imp::storage_delete(key)
    }

    /// Keys starting with `prefix`, sorted.
    pub fn keys(prefix: &str) -> Result<Vec<String>, Error> {
        imp::storage_keys(prefix)
    }
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub use imp::{event as __event, range_from as __range_from, range_to as __range_to};
