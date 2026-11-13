//! The IDE functions and handles a plugin may use. Gated ones need the
//! capability in `plugin.toml` (`[capabilities] required = [...]`) and the
//! user's grant; without it they return [`Error::Denied`].

use crate::types::*;

#[cfg(target_arch = "wasm32")]
mod imp {
    //! Calls through the `openidea:plugin@1.0.0` world.
    use super::{WebSocketBatch, WebSocketRequest};
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

    pub fn notify_with_actions(
        level: NotificationLevel,
        title: &str,
        body: &str,
        actions: &[NotificationAction],
    ) -> Result<(), Error> {
        let level = match level {
            NotificationLevel::Info => wit::types::NotificationLevel::Info,
            NotificationLevel::Warning => wit::types::NotificationLevel::Warning,
            NotificationLevel::Error => wit::types::NotificationLevel::Error,
        };
        let actions: Vec<_> = actions
            .iter()
            .map(|a| wit::ui::NotificationAction {
                label: a.label.clone(),
                command: a.command.clone(),
                argument: a.argument.clone(),
            })
            .collect();
        wit::ui::notify(level, title, body, &actions).map_err(error)
    }

    pub fn notify_project(
        p: &ProjectRes,
        level: NotificationLevel,
        title: &str,
        body: &str,
        actions: &[NotificationAction],
    ) -> Result<(), Error> {
        let level = match level {
            NotificationLevel::Info => wit::types::NotificationLevel::Info,
            NotificationLevel::Warning => wit::types::NotificationLevel::Warning,
            NotificationLevel::Error => wit::types::NotificationLevel::Error,
        };
        let actions: Vec<_> = actions
            .iter()
            .map(|a| wit::ui::NotificationAction {
                label: a.label.clone(),
                command: a.command.clone(),
                argument: a.argument.clone(),
            })
            .collect();
        wit::ui::notify_project(p, level, title, body, &actions).map_err(error)
    }

    pub fn set_status_item(id: &str, item: &StatusItem) {
        let item = wit::ui::StatusItem {
            text: item.text.clone(),
            tooltip: item.tooltip.clone(),
            command: item.command.clone(),
        };
        wit::ui::set_status_item(id, &item)
    }

    pub fn set_window_status_item(id: &str, item: &StatusItem) -> Result<(), Error> {
        wit::ui::set_window_status_item(
            id,
            &wit::ui::StatusItem {
                text: item.text.clone(),
                tooltip: item.tooltip.clone(),
                command: item.command.clone(),
            },
        )
        .map_err(error)
    }
    pub fn remove_window_status_item(id: &str) -> Result<(), Error> {
        wit::ui::remove_window_status_item(id).map_err(error)
    }
    pub fn execute_command(id: &str, arg: Option<&str>) -> Result<Option<String>, Error> {
        wit::command_runner::execute(id, arg).map_err(error)
    }
    pub type ConnectionRes = wit::ipc::Connection;
    pub fn ipc_connect(name: &str) -> Result<ConnectionRes, Error> {
        wit::ipc::connect(name).map_err(error)
    }
    pub fn ipc_write(c: &ConnectionRes, bytes: &[u8]) -> Result<(), Error> {
        c.write(bytes).map_err(error)
    }
    pub fn ipc_read(c: &ConnectionRes, max: u32, timeout: u32) -> Result<Vec<u8>, Error> {
        c.read(max, timeout).map_err(error)
    }
    pub fn ipc_close(c: &ConnectionRes) -> Result<(), Error> {
        c.close().map_err(error)
    }

    pub fn remove_status_item(id: &str) {
        wit::ui::remove_status_item(id)
    }

    pub fn set_context(key: &str, value: ContextValue) -> Result<(), Error> {
        let value = match value {
            ContextValue::Flag(b) => wit::ui::ContextValue::Flag(b),
            ContextValue::Number(n) => wit::ui::ContextValue::Number(n),
            ContextValue::Text(t) => wit::ui::ContextValue::Text(t),
        };
        wit::ui::set_context(key, &value).map_err(error)
    }

    pub fn remove_context(key: &str) {
        wit::ui::remove_context(key)
    }

    pub fn copy_to_clipboard(text: &str) -> Result<(), Error> {
        wit::ui::copy_to_clipboard(text).map_err(error)
    }

    pub fn open_url(url: &str) -> Result<(), Error> {
        wit::ui::open_url(url).map_err(error)
    }

    fn pick_items(items: &[PickItem]) -> Vec<wit::ui::PickItem> {
        items
            .iter()
            .map(|i| wit::ui::PickItem {
                key: i.key.clone(),
                label: i.label.clone(),
                description: i.description.clone(),
            })
            .collect()
    }

    pub fn pick(title: &str, items: &[PickItem]) -> Result<Option<String>, Error> {
        wit::ui::pick(title, &pick_items(items)).map_err(error)
    }

    pub fn pick_directory(title: &str, initial: Option<&str>) -> Result<Option<String>, Error> {
        wit::ui::pick_directory(title, initial).map_err(error)
    }
    pub fn open_project(path: &str, new_window: bool) -> Result<(), Error> {
        wit::workspace::open_project(path, new_window).map_err(error)
    }

    pub fn pick_many(title: &str, items: &[PickItem]) -> Result<Option<Vec<String>>, Error> {
        wit::ui::pick_many(title, &pick_items(items)).map_err(error)
    }

    pub fn input(prompt: &str, value: Option<&str>) -> Result<Option<String>, Error> {
        wit::ui::input(prompt, value).map_err(error)
    }

    pub fn input_multiline(prompt: &str, value: Option<&str>) -> Result<Option<String>, Error> {
        wit::ui::input_multiline(prompt, value).map_err(error)
    }

    pub fn confirm(title: &str, body: &str) -> Result<bool, Error> {
        wit::ui::confirm(title, body).map_err(error)
    }

    pub fn reveal_view(view: &str) -> Result<(), Error> {
        wit::views::reveal(view).map_err(error)
    }

    pub fn locale() -> String {
        wit::ui::locale()
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

    pub fn project_of(path: &str) -> Option<ProjectRes> {
        wit::workspace::project_of(path)
    }

    pub fn project_root(p: &ProjectRes) -> Result<String, Error> {
        p.root().map_err(error)
    }

    pub fn project_read(p: &ProjectRes, path: &str) -> Result<String, Error> {
        p.read_file(path).map_err(error)
    }

    pub fn project_read_bytes(p: &ProjectRes, path: &str) -> Result<Vec<u8>, Error> {
        p.read_bytes(path).map_err(error)
    }

    pub fn project_write(p: &ProjectRes, path: &str, text: &str) -> Result<(), Error> {
        p.write_file(path, text).map_err(error)
    }

    pub fn project_document(p: &ProjectRes, path: &str) -> Result<Document, Error> {
        wit::editor::document_at(p, path).map(|d| Document { version: d.version, text: d.text }).map_err(error)
    }

    pub fn project_apply_document_edits(
        p: &ProjectRes,
        path: &str,
        version: u64,
        edits: &[TextEdit],
    ) -> Result<u64, Error> {
        let edits: Vec<wit::types::TextEdit> = edits
            .iter()
            .map(|edit| wit::types::TextEdit { range: range_out(edit.range), text: edit.text.clone() })
            .collect();
        wit::editor::apply_edits_at(p, path, version, &edits).map_err(error)
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

    pub fn open_editors() -> Result<Vec<OpenEditor>, Error> {
        wit::editor::open_editors()
            .map(|v| {
                v.into_iter()
                    .map(|e| OpenEditor { path: e.path, language: e.language, dirty: e.dirty, active: e.active })
                    .collect()
            })
            .map_err(error)
    }
    pub fn editor_open(path: &str, selection: Option<Range>) -> Result<(), Error> {
        wit::editor::open(path, selection.map(range_out)).map_err(error)
    }
    pub fn editor_set_selections(e: &EditorRes, ranges: &[Range]) -> Result<(), Error> {
        e.set_selections(&ranges.iter().copied().map(range_out).collect::<Vec<_>>()).map_err(error)
    }
    pub fn editor_reveal(e: &EditorRes, range: Range) -> Result<(), Error> {
        e.reveal(range_out(range)).map_err(error)
    }
    pub fn project_search_text(p: &ProjectRes, q: &TextQuery, limit: u32) -> Result<TextSearch, Error> {
        let q = wit::workspace::TextQuery {
            pattern: q.pattern.clone(),
            regex: q.regex,
            case_sensitive: q.case_sensitive,
            whole_word: q.whole_word,
            include: q.include.clone(),
            exclude: q.exclude.clone(),
        };
        p.search_text(&q, limit)
            .map(|s| TextSearch {
                limit_hit: s.limit_hit,
                matches: s
                    .matches
                    .into_iter()
                    .map(|m| TextMatch {
                        location: Location { path: m.location.path, range: range_in(m.location.range) },
                        line: m.line,
                    })
                    .collect(),
            })
            .map_err(error)
    }
    fn diagnostic_in(d: wit::diagnostics::Diagnostic) -> Diagnostic {
        Diagnostic {
            range: range_in(d.range),
            severity: match d.severity {
                wit::diagnostics::Severity::Error => Severity::Error,
                wit::diagnostics::Severity::Warning => Severity::Warning,
                wit::diagnostics::Severity::Info => Severity::Info,
                wit::diagnostics::Severity::Hint => Severity::Hint,
            },
            message: d.message,
            code: d.code,
            source: d.source,
            unnecessary: d.tags.iter().any(|s| s == "unnecessary"),
            deprecated: d.tags.iter().any(|s| s == "deprecated"),
            related: d
                .related
                .into_iter()
                .map(|r| RelatedInformation {
                    location: Location { path: r.location.path, range: range_in(r.location.range) },
                    message: r.message,
                })
                .collect(),
        }
    }
    pub fn problems(path: Option<&str>) -> Result<Vec<FileProblems>, Error> {
        wit::diagnostics::problems(path)
            .map(|v| {
                v.into_iter()
                    .map(|f| FileProblems {
                        path: f.path,
                        source: f.source,
                        diagnostics: f.diagnostics.into_iter().map(diagnostic_in).collect(),
                    })
                    .collect()
            })
            .map_err(error)
    }
    pub fn set_decorations(path: &str, set: &str, items: &[Decoration]) -> Result<(), Error> {
        let items = items
            .iter()
            .map(|d| wit::decorations::Decoration {
                range: range_out(d.range),
                style: d.style.clone(),
                hover: d.hover.clone(),
                after: d.after.clone(),
            })
            .collect::<Vec<_>>();
        wit::decorations::set(path, set, &items).map_err(error)
    }
    pub fn clear_decorations(set: &str) -> Result<(), Error> {
        wit::decorations::clear(set).map_err(error)
    }
    pub fn set_file_decoration(path: &str, set: &str, item: &FileDecoration) -> Result<(), Error> {
        wit::decorations::set_file(
            path,
            set,
            &wit::decorations::FileDecoration {
                badge: item.badge.clone(),
                style: item.style.clone(),
                tooltip: item.tooltip.clone(),
            },
        )
        .map_err(error)
    }
    pub fn clear_file_decorations(set: &str) -> Result<(), Error> {
        wit::decorations::clear_file(set).map_err(error)
    }
    pub fn set_file_note(path: &str, set: &str, note: &str, tooltip: Option<&str>) -> Result<(), Error> {
        wit::decorations::set_file_note(path, set, note, tooltip).map_err(error)
    }
    pub fn vcs_log(p: &ProjectRes, path: Option<&str>, limit: u32) -> Result<Vec<CommitInfo>, Error> {
        wit::vcs::log(p, path, limit)
            .map(|v| {
                v.into_iter()
                    .map(|c| CommitInfo {
                        id: c.id,
                        short_id: c.short_id,
                        author: c.author,
                        author_email: c.author_email,
                        date: c.date,
                        subject: c.subject,
                        body: c.body,
                        parents: c.parents,
                    })
                    .collect()
            })
            .map_err(error)
    }
    pub fn vcs_blame(p: &ProjectRes, path: &str) -> Result<Vec<BlameLine>, Error> {
        wit::vcs::blame(p, path)
            .map(|v| {
                v.into_iter()
                    .map(|c| BlameLine {
                        line: c.line,
                        commit: c.commit,
                        author: c.author,
                        date: c.date,
                        summary: c.summary,
                    })
                    .collect()
            })
            .map_err(error)
    }
    pub fn vcs_diff(p: &ProjectRes, path: Option<&str>, against: Option<&str>) -> Result<Option<String>, Error> {
        wit::vcs::diff(p, path, against).map_err(error)
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

    pub fn pending_commit() -> Result<Option<CommitDraft>, Error> {
        wit::commit::pending_commit().map(|d| d.map(__draft_in)).map_err(error)
    }

    pub fn set_commit_message(revision: u64, message: &str) -> Result<(), Error> {
        wit::commit::set_commit_message(revision, message).map_err(error)
    }

    #[doc(hidden)]
    pub fn __draft_in(d: wit::commit::CommitDraft) -> CommitDraft {
        CommitDraft {
            revision: d.revision,
            message: d.message,
            amend: d.amend,
            changes: d
                .changes
                .into_iter()
                .map(|c| CommitChange {
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

    pub fn subscribe_paths(kind: &str, globs: &[&str]) -> Result<(), Error> {
        wit::events::subscribe_paths(kind, &globs.iter().map(|g| (*g).to_owned()).collect::<Vec<_>>()).map_err(error)
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

    pub fn project_symbols(p: &ProjectRes, query: &str, limit: u32) -> Result<Vec<SymbolInfo>, Error> {
        p.symbols(query, limit)
            .map(|symbols| {
                symbols
                    .into_iter()
                    .map(|s| SymbolInfo {
                        name: s.name,
                        kind: s.kind,
                        container: s.container,
                        location: Location { path: s.location.path, range: range_from(s.location.range) },
                    })
                    .collect()
            })
            .map_err(error)
    }

    pub fn project_find(p: &ProjectRes, glob: &str, limit: u32) -> Result<Vec<String>, Error> {
        p.find_files(glob, limit).map_err(error)
    }

    pub fn project_exists(p: &ProjectRes, path: &str) -> Result<bool, Error> {
        p.exists(path).map_err(error)
    }

    pub fn project_stat(p: &ProjectRes, path: &str) -> Result<FileStat, Error> {
        p.stat(path).map(file_stat).map_err(error)
    }

    fn file_kind(kind: wit::workspace::FileKind) -> FileKind {
        use wit::workspace::FileKind as K;
        match kind {
            K::File => FileKind::File,
            K::Directory => FileKind::Directory,
            K::Symlink => FileKind::Symlink,
            K::Other => FileKind::Other,
        }
    }

    fn file_stat(s: wit::workspace::FileStat) -> FileStat {
        FileStat { kind: file_kind(s.kind), size: s.size, modified: s.modified }
    }

    pub fn fs_read_file(path: &str) -> Result<String, Error> {
        wit::fs::read_file(path).map_err(error)
    }

    pub fn fs_read_bytes(path: &str) -> Result<Vec<u8>, Error> {
        wit::fs::read_bytes(path).map_err(error)
    }

    pub fn fs_stat(path: &str) -> Result<FileStat, Error> {
        wit::fs::stat(path).map(file_stat).map_err(error)
    }

    pub fn fs_read_dir(path: &str) -> Result<Vec<super::fs::DirEntry>, Error> {
        let entries = wit::fs::read_dir(path).map_err(error)?;
        Ok(entries.into_iter().map(|e| super::fs::DirEntry { name: e.name, kind: file_kind(e.kind) }).collect())
    }

    pub fn fs_plugin_dir() -> Result<String, Error> {
        wit::fs::plugin_dir().map_err(error)
    }

    pub fn fs_write_file(path: &str, text: &str) -> Result<(), Error> {
        wit::fs::write_file(path, text).map_err(error)
    }

    pub fn fs_write_bytes(path: &str, bytes: &[u8]) -> Result<(), Error> {
        wit::fs::write_bytes(path, bytes).map_err(error)
    }

    pub fn diagnostic_to(d: &Diagnostic) -> wit::diagnostics::Diagnostic {
        use wit::diagnostics::{Diagnostic as D, RelatedInformation as R, Severity as S};
        D {
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
        }
    }

    pub fn publish_diagnostics(path: &str, items: &[Diagnostic]) -> Result<(), Error> {
        let items: Vec<_> = items.iter().map(diagnostic_to).collect();
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

    pub type WebSocketRes = wit::net::Websocket;

    pub fn websocket_connect(project: &ProjectRes, req: &WebSocketRequest) -> Result<WebSocketRes, Error> {
        let request = wit::net::WebsocketRequest {
            url: req.url.clone(),
            headers: req
                .headers
                .iter()
                .map(|(name, value)| wit::net::Header { name: name.clone(), value: value.clone() })
                .collect(),
            subprotocol: req.subprotocol.clone(),
        };
        wit::net::websocket_connect(project, &request).map_err(error)
    }

    pub fn websocket_id(connection: &WebSocketRes) -> u64 {
        connection.id()
    }

    pub fn websocket_send(connection: &WebSocketRes, bytes: &[u8]) -> Result<(), Error> {
        connection.send(bytes).map_err(error)
    }

    pub fn websocket_drain(connection: &WebSocketRes, limit: u32) -> Result<WebSocketBatch, Error> {
        connection
            .drain(limit)
            .map(|batch| WebSocketBatch { messages: batch.messages, closed: batch.closed })
            .map_err(error)
    }

    pub fn websocket_close(connection: &WebSocketRes) -> Result<(), Error> {
        connection.close().map_err(error)
    }

    pub fn secret_set(name: &str, value: &str) -> Result<(), Error> {
        wit::secrets::set(name, value).map_err(error)
    }
    pub fn secret_delete(name: &str) -> Result<(), Error> {
        wit::secrets::delete(name).map_err(error)
    }
    pub type LoopbackRes = wit::auth::Loopback;
    pub fn begin_loopback(path: &str) -> Result<LoopbackRes, Error> {
        wit::auth::begin_loopback(path).map_err(error)
    }
    pub fn loopback_uri(l: &LoopbackRes) -> String {
        l.redirect_uri()
    }
    pub fn loopback_wait(l: &LoopbackRes, timeout_ms: u32) -> Result<Option<String>, Error> {
        l.wait(timeout_ms).map_err(error)
    }
    pub fn output_append(channel: &str, text: &str) -> Result<(), Error> {
        wit::output::append(channel, text).map_err(error)
    }
    pub fn output_clear(channel: &str) -> Result<(), Error> {
        wit::output::clear(channel).map_err(error)
    }
    pub fn output_reveal(channel: &str) -> Result<(), Error> {
        wit::output::reveal(channel).map_err(error)
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

    fn content_action_to(v: &crate::ContentAction) -> wit::views::ContentAction {
        wit::views::ContentAction {
            id: v.id.clone(),
            label: v.label.clone(),
            icon: v.icon.clone(),
            primary: v.primary,
            save: v.save,
        }
    }

    fn content_tab_to(v: &crate::ContentTab) -> wit::views::ContentTab {
        wit::views::ContentTab {
            key: v.key.clone(),
            title: v.title.clone(),
            file_name: v.file_name.clone(),
            language: v.language.clone(),
            content: v.content.clone(),
            read_only: v.read_only,
            actions: v.actions.iter().map(content_action_to).collect(),
        }
    }

    fn content_diff_to(v: &crate::ContentDiff) -> wit::views::ContentDiff {
        wit::views::ContentDiff {
            left: v.left.clone(),
            right: v.right.clone(),
            left_label: v.left_label.clone(),
            right_label: v.right_label.clone(),
            title: v.title.clone(),
        }
    }

    fn content_tab_reply_to(v: &crate::ContentTabReply) -> wit::views::ContentTabReply {
        wit::views::ContentTabReply {
            content: v.content.clone(),
            saved: v.saved,
            read_only: v.read_only,
            status: v.status.clone(),
            error: v.error.clone(),
            diff: v.diff.as_ref().map(content_diff_to),
        }
    }

    pub fn database_upsert(project: &ProjectRes, source: &PluginDataSource) -> Result<(), Error> {
        wit::database::upsert_source(
            project,
            &wit::database::DataSource {
                id: source.id.clone(),
                name: source.name.clone(),
                driver: source.driver.clone(),
                host: source.host.clone(),
                port: source.port,
                database: source.database.clone(),
                user: source.user.clone(),
                url: source.url.clone(),
                options: source.options.clone(),
            },
        )
        .map_err(error)
    }
    pub fn database_remove(project: &ProjectRes, id: &str) -> Result<(), Error> {
        wit::database::remove_source(project, id).map_err(error)
    }
    pub fn database_sources(project: &ProjectRes) -> Result<Vec<String>, Error> {
        wit::database::sources(project).map_err(error)
    }
    pub fn database_credential(project: &ProjectRes, id: &str, password: &str) -> Result<(), Error> {
        wit::database::set_credential(project, id, password).map_err(error)
    }
    pub fn database_connect(project: &ProjectRes, id: &str) -> Result<(), Error> {
        wit::database::connect(project, id).map_err(error)
    }
    pub fn mcp_stdio_command() -> Option<Vec<String>> {
        wit::mcp::stdio_command()
    }

    pub fn register_run_target(project: &ProjectRes, target: &crate::PluginRunTarget) -> Result<(), Error> {
        wit::run_targets::register(
            project,
            &wit::run_targets::RunTarget {
                id: target.id.clone(),
                name: target.name.clone(),
                program: target.program.clone(),
                args: target.args.clone(),
                workdir_args: target.workdir_args.clone(),
                container_root: target.container_root.clone(),
                commands: target.commands.clone(),
            },
        )
        .map_err(error)
    }
    pub fn register_run_target_with_overrides(
        project: &ProjectRes,
        target: &crate::PluginRunTargetWithOverrides,
    ) -> Result<(), Error> {
        wit::run_targets::register_with_overrides(
            project,
            &wit::run_targets::RunTargetWithOverrides {
                id: target.id.clone(),
                name: target.name.clone(),
                program: target.program.clone(),
                args: target.args.clone(),
                workdir_args: target.workdir_args.clone(),
                container_root: target.container_root.clone(),
                commands: target
                    .commands
                    .iter()
                    .map(|c| wit::run_targets::CommandOverride {
                        name: c.name.clone(),
                        args: c.args.clone(),
                        workdir_args: c.workdir_args.clone(),
                    })
                    .collect(),
            },
        )
        .map_err(error)
    }
    pub fn unregister_run_target(project: &ProjectRes, id: &str) {
        wit::run_targets::unregister(project, id);
    }
    pub fn start_run(config: &str, args: &[String], debug: bool) -> Result<String, Error> {
        wit::run::start(config, args, debug).map_err(error)
    }
    pub fn open_terminal_session(key: &str, title: &str, cmd: &super::Command) -> Result<String, Error> {
        wit::views::open_terminal_session(
            key,
            title,
            &wit::process::Command { program: cmd.program.clone(), args: cmd.args.clone(), env: cmd.env.clone() },
        )
        .map_err(error)
    }
    pub fn write_terminal(key: &str, text: &str) -> Result<(), Error> {
        wit::views::write_terminal(key, text).map_err(error)
    }
    pub fn open_content_tab(tab: &crate::ContentTab) -> Result<(), Error> {
        wit::views::open_content_tab(&content_tab_to(tab)).map_err(error)
    }
    pub fn reply_content_tab(request: &str, reply: &crate::ContentTabReply) -> Result<(), Error> {
        wit::views::reply_content_tab(request, &content_tab_reply_to(reply)).map_err(error)
    }
    pub fn open_diff(diff: &crate::ContentDiff, file_name: Option<&str>) -> Result<(), Error> {
        wit::views::open_diff(&content_diff_to(diff), file_name).map_err(error)
    }

    pub fn open_terminal(title: &str, program: &str, args: &[String]) -> Result<(), Error> {
        wit::views::open_terminal(title, program, args).map_err(error)
    }

    pub fn open_log_tab(key: &str, title: &str, log: &crate::details::ProcessLog) -> Result<(), Error> {
        use wit::detail_types::{LogToggle, ProcessLog};
        let toggles =
            log.toggles.iter().map(|t| LogToggle { id: t.id.clone(), label: t.label.clone(), args: t.args.clone() });
        let log = ProcessLog { program: log.program.clone(), args: log.args.clone(), toggles: toggles.collect() };
        wit::views::open_log_tab(key, title, &log).map_err(error)
    }

    pub fn open_location(path: &str, line: u32, column: u32) -> Result<(), Error> {
        wit::views::open_location(path, line, column).map_err(error)
    }

    pub fn setting(key: &str) -> Option<String> {
        wit::settings::get(key)
    }

    pub fn extension_contributions(point: &str) -> Result<Vec<crate::Contribution>, Error> {
        let list = wit::extensions::contributions(point).map_err(error)?;
        Ok(list.into_iter().map(|c| crate::Contribution { plugin: c.plugin, data: c.data }).collect())
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

    pub type ChildRes = wit::process::Child;

    pub fn run_command(
        cmd: &crate::host::Command,
        cwd: Option<&ProjectRes>,
        stdin: Option<&str>,
    ) -> Result<ProcessOutput, Error> {
        let c = wit::process::Command { program: cmd.program.clone(), args: cmd.args.clone(), env: cmd.env.clone() };
        wit::process::run_command(&c, cwd, stdin)
            .map(|o| ProcessOutput { status: o.status, stdout: o.stdout, stderr: o.stderr })
            .map_err(error)
    }

    pub fn start(cmd: &crate::host::Command, cwd: Option<&ProjectRes>) -> Result<ChildRes, Error> {
        let c = wit::process::Command { program: cmd.program.clone(), args: cmd.args.clone(), env: cmd.env.clone() };
        wit::process::start(&c, cwd).map_err(error)
    }

    pub fn child_poll(child: &ChildRes, max: u32) -> Result<crate::host::Chunk, Error> {
        child.poll(max).map(chunk_in).map_err(error)
    }

    pub fn child_write(child: &ChildRes, text: &str) -> Result<(), Error> {
        child.write(text).map_err(error)
    }

    pub fn child_close_stdin(child: &ChildRes) -> Result<(), Error> {
        child.close_stdin().map_err(error)
    }

    pub fn child_kill(child: &ChildRes) -> Result<(), Error> {
        child.kill().map_err(error)
    }

    pub fn child_wait(child: &ChildRes, timeout_ms: u32) -> Result<crate::host::Chunk, Error> {
        child.wait(timeout_ms).map(chunk_in).map_err(error)
    }

    fn chunk_in(c: wit::process::Chunk) -> crate::host::Chunk {
        crate::host::Chunk { stdout: c.stdout, stderr: c.stderr, status: c.status }
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
            E::Other(x) => Event::from_other(x.kind, x.data),
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
    /// Creates/replaces only this plugin's source. Requires database.sources and trust.
    pub fn upsert_data_source(&self, source: &PluginDataSource) -> Result<(), Error> {
        imp::database_upsert(&self.inner, source)
    }
    /// Removes an owned source and its credentials; other ids are not-found.
    pub fn remove_data_source(&self, id: &str) -> Result<(), Error> {
        imp::database_remove(&self.inner, id)
    }
    /// Lists only this plugin's private source ids.
    pub fn data_sources(&self) -> Result<Vec<String>, Error> {
        imp::database_sources(&self.inner)
    }
    /// Writes directly to the Database secure store, without a read API.
    pub fn set_data_source_credential(&self, id: &str, password: &str) -> Result<(), Error> {
        imp::database_credential(&self.inner, id, password)
    }
    /// Normal Database connection/introspection in this project's invoking command/event window.
    pub fn connect_data_source(&self, id: &str) -> Result<(), Error> {
        imp::database_connect(&self.inner, id)
    }

    /// Find in Files with unsaved text, project excludes, cancellation and a 10,000 match cap.
    /// Requires project.read; locations use zero-based lines and UTF-16 columns.
    pub fn search_text(&self, query: &TextQuery, limit: u32) -> Result<TextSearch, Error> {
        imp::project_search_text(&self.inner, query, limit)
    }
    /// Trusted project history, newest first, at most 1000 commits. Requires vcs.read.
    pub fn vcs_log(&self, path: Option<&str>, limit: u32) -> Result<Vec<CommitInfo>, Error> {
        imp::vcs_log(&self.inner, path, limit)
    }
    /// Trusted project attribution including unsaved text. Requires vcs.read.
    pub fn vcs_blame(&self, path: &str) -> Result<Vec<BlameLine>, Error> {
        imp::vcs_blame(&self.inner, path)
    }
    /// Disk working tree versus HEAD or a revision, failing above 4 MiB. Requires vcs.read and trust.
    pub fn vcs_diff(&self, path: Option<&str>, against: Option<&str>) -> Result<Option<String>, Error> {
        imp::vcs_diff(&self.inner, path, against)
    }

    /// [`notify_with_actions`] in a window of this project only (API 1.5), also from
    /// scheduled or background work: the most recently focused one when it is open in
    /// several, and its buttons run there. Once the project has closed this is
    /// [`Error::NotFound`] and nothing is shown. Needs no capability.
    pub fn notify(
        &self,
        level: NotificationLevel,
        title: &str,
        body: &str,
        actions: &[NotificationAction],
    ) -> Result<(), Error> {
        imp::notify_project(&self.inner, level, title, body, actions)
    }

    /// Absolute path of the root. Needs `project.read`.
    pub fn root(&self) -> Result<String, Error> {
        imp::project_root(&self.inner)
    }

    /// Reads a UTF-8 file inside the project (absolute or root-relative);
    /// unsaved editor contents win. A missing path is `Error::NotFound`.
    /// Needs `project.read`.
    pub fn read_file(&self, path: &str) -> Result<String, Error> {
        imp::project_read(&self.inner, path)
    }

    /// Reads the bytes of a file inside the project (absolute or
    /// root-relative) — images, archives, fonts — at most 16 MiB, the file on
    /// disk. Paths leaving the root are rejected; a missing path is
    /// `Error::NotFound`. Needs `project.read`.
    pub fn read_bytes(&self, path: &str) -> Result<Vec<u8>, Error> {
        imp::project_read_bytes(&self.inner, path)
    }

    /// Versioned text of an explicitly named open document. This works from
    /// background events and requires `project.read` plus `editor.read`.
    pub fn document(&self, path: &str) -> Result<Document, Error> {
        imp::project_document(&self.inner, path)
    }

    /// Applies versioned edits to an explicitly named open document. Returns
    /// [`Error::Stale`] without writing when its version changed.
    pub fn apply_document_edits(&self, path: &str, version: u64, edits: &[TextEdit]) -> Result<u64, Error> {
        imp::project_apply_document_edits(&self.inner, path, version, edits)
    }

    /// Replaces the text of a file inside the project (absolute or
    /// root-relative), or creates it with the directories it needs, at most
    /// 16 MiB: in one step, keeping the file's encoding and BOM (a new file is
    /// UTF-8). An editor holding unsaved changes for the file makes it
    /// [`Error::Invalid`]. Needs `project.write`.
    pub fn write_file(&self, path: &str, text: &str) -> Result<(), Error> {
        imp::project_write(&self.inner, path, text)
    }

    /// Whether `path` names an existing file or directory inside the project
    /// — including hidden and ignored ones — without reading any content.
    /// Needs `project.read`.
    pub fn exists(&self, path: &str) -> Result<bool, Error> {
        imp::project_exists(&self.inner, path)
    }

    /// Metadata of an existing path inside the project; a missing path is
    /// `Error::NotFound`. Needs `project.read`.
    pub fn stat(&self, path: &str) -> Result<FileStat, Error> {
        imp::project_stat(&self.inner, path)
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

    /// Fuzzy search of this project's current in-memory index. Needs `project.read`.
    /// Never waits for LSP or reads file contents. Only paths inside this project's
    /// root are returned, including when the index has external content roots.
    /// Search honours the current call's cancellation and deadline. Empty queries return no symbols;
    /// queries over 256 UTF-8 bytes are invalid and limits are capped at 1000.
    /// Results may be incomplete during indexing or lag unsaved edits. A closed
    /// project returns `Error::NotFound`. Locations use UTF-16 columns.
    pub fn symbols(&self, query: &str, limit: u32) -> Result<Vec<SymbolInfo>, Error> {
        imp::project_symbols(&self.inner, query, limit)
    }

    /// Runs the approved `process:<program>` in this project's root.
    pub fn run_process(&self, program: &str, args: &[String], stdin: Option<&str>) -> Result<ProcessOutput, Error> {
        imp::run_process(program, args, Some(&self.inner), stdin)
    }
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub use imp::__draft_in;

/// The commit being prepared in the window the command or event came from:
/// the included files and changed blocks only, as Commit would commit them
/// (unsaved editors of those files are saved first). `None` when the window's
/// project has no repository. Only from a command or event of a window, in a
/// trusted project. Needs `vcs.read`.
pub fn pending_commit() -> Result<Option<CommitDraft>, Error> {
    imp::pending_commit()
}

/// Replaces the commit message of that window, only while its draft is still
/// at `revision` ([`CommitDraft::revision`]); [`Error::Stale`] when the user
/// changed the message or the included changes meanwhile, and nothing changes.
/// Needs `vcs.write`.
pub fn set_commit_message(revision: u64, message: &str) -> Result<(), Error> {
    imp::set_commit_message(revision, message)
}

/// Replaces the plugin's diagnostics for `path` (absolute, in an open
/// project); an empty slice clears them. Needs `project.read`.
pub fn publish_diagnostics(path: &str, items: &[Diagnostic]) -> Result<(), Error> {
    imp::publish_diagnostics(path, items)
}

/// HTTPS with `net:<host>`; unencrypted HTTP with `net.http:<host>`
/// (loopback HTTP retains `net:<host>`). `{{secret:<name>}}` in a header is filled in by the IDE (needs
/// `secrets`). `Error::Cancelled` when the call was superseded.
pub fn fetch(request: &HttpRequest) -> Result<HttpResponse, Error> {
    imp::fetch(request)
}

/// A host-owned background WebSocket. Dropping it closes the connection.
pub struct WebSocket {
    inner: imp::WebSocketRes,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WebSocketRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub subprotocol: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WebSocketBatch {
    pub messages: Vec<Vec<u8>>,
    pub closed: bool,
}

impl WebSocket {
    pub fn connect(project: &Project, request: &WebSocketRequest) -> Result<Self, Error> {
        imp::websocket_connect(&project.inner, request).map(|inner| Self { inner })
    }
    pub fn id(&self) -> u64 {
        imp::websocket_id(&self.inner)
    }
    pub fn send(&self, bytes: &[u8]) -> Result<(), Error> {
        imp::websocket_send(&self.inner, bytes)
    }
    pub fn drain(&self, limit: u32) -> Result<WebSocketBatch, Error> {
        imp::websocket_drain(&self.inner, limit)
    }
    pub fn close(&self) -> Result<(), Error> {
        imp::websocket_close(&self.inner)
    }
}

impl Drop for WebSocket {
    fn drop(&mut self) {
        // The WIT resource also closes on its own drop. Calling close here
        // keeps the native mock faithful to that lifecycle; host close is
        // intentionally idempotent.
        let _ = imp::websocket_close(&self.inner);
    }
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

/// Opens (or focuses) the read-only log tab `key` in the invoking window,
/// following `log`'s program (the approved `process:<program>`) in the project
/// root, with its toggles above the output. Only from a command or event of a
/// window; `title` at most 256 characters, `key` 128, at most 32 toggles.
pub fn open_log_tab(key: &str, title: &str, log: &crate::details::ProcessLog) -> Result<(), Error> {
    imp::open_log_tab(key, title, log)
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

/// A program with its arguments and the environment added to the inherited one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Command {
    pub program: String,
    pub args: Vec<String>,
    /// Variables added to the inherited environment: at most 64, names at most
    /// 256 bytes, values at most 4 KiB, no NUL or '=' in names, no NUL in values.
    /// Existing names in the prepared child environment (including login-shell
    /// PATH) fail with an error naming the key. Windows names compare without
    /// case. Variables are never replaced or removed.
    pub env: Vec<(String, String)>,
}

impl Command {
    /// Selects the program approved by a `process:<program>` grant.
    pub fn new(program: &str) -> Self {
        Self { program: program.to_owned(), args: Vec::new(), env: Vec::new() }
    }

    /// Appends one argument.
    pub fn arg(mut self, arg: &str) -> Self {
        self.args.push(arg.to_owned());
        self
    }

    /// Appends arguments in order.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_owned()));
        self
    }

    /// Adds a variable; an inherited or duplicate name is an error at spawn.
    pub fn env(mut self, name: &str, value: &str) -> Self {
        self.env.push((name.to_owned(), value.to_owned()));
        self
    }
}

/// What a kept-running program printed since the last read, and its exit status
/// once it ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Chunk {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
}

/// A program kept running behind a handle ([`start`]). Dropping it ends the
/// program, as the host does when the plugin instance goes away.
pub struct Child {
    inner: imp::ChildRes,
}

impl Child {
    /// What it printed since the last read, up to 1 MiB per stream, or one
    /// whole character when `max_bytes` is smaller;
    /// `status` is `Some` once it ended.
    pub fn poll(&self, max_bytes: u32) -> Result<Chunk, Error> {
        imp::child_poll(&self.inner, max_bytes)
    }

    /// Writes `text` to its stdin.
    pub fn write(&self, text: &str) -> Result<(), Error> {
        imp::child_write(&self.inner, text)
    }

    /// Closes its stdin, so a program reading it sees the end.
    pub fn close_stdin(&self) -> Result<(), Error> {
        imp::child_close_stdin(&self.inner)
    }

    /// Ends it; `status` becomes known right away (-1 when a signal ended it).
    pub fn kill(&self) -> Result<(), Error> {
        imp::child_kill(&self.inner)
    }

    /// Waits up to `timeout_ms` for it to end (0 only checks), then reads it.
    pub fn wait(&self, timeout_ms: u32) -> Result<Chunk, Error> {
        imp::child_wait(&self.inner, timeout_ms)
    }
}

/// Runs a [`Command`] to its end (API 1.3). Its environment only adds new
/// variables; an existing key fails with an error naming it.
pub fn run_command(cmd: &Command, project: Option<&Project>, stdin: Option<&str>) -> Result<ProcessOutput, Error> {
    imp::run_command(cmd, project.map(|p| &p.inner), stdin)
}

/// Starts a [`Command`] and keeps it running behind a [`Child`] (at most 8 per
/// plugin instance, API 1.3). Closing the invoking window ends its processes.
pub fn start(cmd: &Command, project: Option<&Project>) -> Result<Child, Error> {
    imp::start(cmd, project.map(|p| &p.inner)).map(|inner| Child { inner })
}

/// Projects open in any window. Needs `project.read`.
pub fn projects() -> Result<Vec<Project>, Error> {
    Ok(imp::projects()?.into_iter().map(|inner| Project { inner }).collect())
}

/// The deepest open project containing an absolute document path, including in providers.
/// Obtaining the handle needs no capability; reading it still needs `project.read`.
pub fn project_of(path: &str) -> Option<Project> {
    imp::project_of(path).map(|inner| Project { inner })
}

/// A file open in an editor.
pub struct TextEditor {
    inner: imp::EditorRes,
}

impl TextEditor {
    /// Changes this window's selections. Commands/events only; no capability needed.
    pub fn set_selections(&self, ranges: &[Range]) -> Result<(), Error> {
        imp::editor_set_selections(&self.inner, ranges)
    }
    /// Scrolls a range into view in this window. Commands/events only; no capability needed.
    pub fn reveal(&self, range: Range) -> Result<(), Error> {
        imp::editor_reveal(&self.inner, range)
    }

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

/// Sets the plugin's context key that `when` clauses test as `plugin.<id>.<key>`, in
/// the window the current command or event came from (every window when there is
/// none): `set_context("connected", true)`. A window's value takes precedence over
/// the global one. The key is 1-64 of `A-Za-z0-9_-`; at most 100 keys.
pub fn set_context(key: &str, value: impl Into<ContextValue>) -> Result<(), Error> {
    imp::set_context(key, value.into())
}

/// Removes the key [`set_context`] set in the same scope.
pub fn remove_context(key: &str) {
    imp::remove_context(key)
}

/// Copies `text` to the system clipboard. Needs `clipboard`.
pub fn copy_to_clipboard(text: &str) -> Result<(), Error> {
    imp::copy_to_clipboard(text)
}

/// Opens an `http://` or `https://` URL in the user's default browser.
pub fn open_url(url: &str) -> Result<(), Error> {
    imp::open_url(url)
}

/// Shows a list and waits for the chosen key, or `None` when dismissed.
/// Works in a command/event of a window, or while resolving a selected code
/// or file action in its editor's window; [`Error::Invalid`] otherwise.
/// Needs no capability. Waiting doesn't count against the call's budget,
/// but the plugin handles nothing else meanwhile.
pub fn pick(title: &str, items: &[PickItem]) -> Result<Option<String>, Error> {
    imp::pick(title, items)
}

/// Like [`pick`], with any number of items chosen.
pub fn pick_many(title: &str, items: &[PickItem]) -> Result<Option<Vec<String>>, Error> {
    imp::pick_many(title, items)
}

/// Asks for a line of text, pre-filled with `value`; `None` when dismissed.
/// Same rules as [`pick`].
pub fn input(prompt: &str, value: Option<&str>) -> Result<Option<String>, Error> {
    imp::input(prompt, value)
}

/// Asks for text over several lines, pre-filled with `value`; `None` when
/// dismissed. Only from a command or event of a window; the dialog confirms
/// on Cmd/Ctrl+Enter.
pub fn input_multiline(prompt: &str, value: Option<&str>) -> Result<Option<String>, Error> {
    imp::input_multiline(prompt, value)
}

/// Asks for confirmation: `true` on OK, `false` on Cancel or Escape.
/// Same rules as [`pick`].
pub fn confirm(title: &str, body: &str) -> Result<bool, Error> {
    imp::confirm(title, body)
}

/// Brings one of the plugin's declared views to the front in the window the
/// current command or event came from.
pub fn reveal_view(view: &str) -> Result<(), Error> {
    imp::reveal_view(view)
}

/// The IDE's UI language as a BCP 47 tag (`en`, `fr`, `zh-CN`, …), for the
/// text the plugin builds itself (notifications, error messages, HTML). The
/// strings of the manifest and of views are translated by the IDE from the
/// package's `locales/<tag>.json`. Read it when the text is made: it follows
/// a change of language.
pub fn locale() -> String {
    imp::locale()
}

/// Subscribe to project-relative path globs for file-opened, file-saved or files-changed.
/// Replaces the previous filter. Empty globs pause delivery; `subscribe` restores all paths.
/// Requires `events`. Register during activation before the events you want to observe.
pub fn subscribe_paths(kind: &str, globs: &[&str]) -> Result<(), Error> {
    imp::subscribe_paths(kind, globs)
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

/// Files outside the open projects, for a program the plugin integrates with
/// or a tool installed elsewhere. Outside [`fs::plugin_dir`], paths need an
/// `fs.read:<path>` (reading) or `fs.write:<path>` (writing) grant covering it;
/// without one a
/// call returns [`Error::Denied`] naming the capability the manifest has to
/// declare. Paths are absolute, or start with `~/` for the user's home. A file
/// inside a project is [`Project::read_file`] / [`Project::write_file`].
pub mod fs {
    use super::imp;
    use crate::types::{Error, FileKind, FileStat};

    /// The plugin's private persistent directory (0700, owner-only ACL on
    /// Windows), removed on uninstall. Files created here are owner-only and
    /// need no `fs.*` grants. Suitable for editor content and large caches;
    /// retained across idle reclaim, reload, and application restarts.
    pub fn plugin_dir() -> Result<String, Error> {
        imp::fs_plugin_dir()
    }

    /// An entry of a directory ([`read_dir`]).
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct DirEntry {
        /// The entry's name, without its directory.
        pub name: String,
        pub kind: FileKind,
    }

    /// A text file, decoded as the editor decodes it (BOM and encoding
    /// detection), at most 16 MiB; unsaved editor contents win.
    pub fn read_file(path: &str) -> Result<String, Error> {
        imp::fs_read_file(path)
    }

    /// The bytes of a file (images, class files, archives), at most 16 MiB.
    pub fn read_bytes(path: &str) -> Result<Vec<u8>, Error> {
        imp::fs_read_bytes(path)
    }

    /// Metadata of an existing path; a missing path is [`Error::NotFound`].
    pub fn stat(path: &str) -> Result<FileStat, Error> {
        imp::fs_stat(path)
    }

    /// The entries directly under a directory, sorted by name, at most 4096;
    /// a file is [`Error::Invalid`].
    pub fn read_dir(path: &str) -> Result<Vec<DirEntry>, Error> {
        imp::fs_read_dir(path)
    }

    /// Replaces the text of a file, or creates it, at most 16 MiB: in one step,
    /// keeping the file's encoding and BOM (a new file is UTF-8). Needs an
    /// `fs.write:<path>` grant, which doesn't imply reading.
    ///
    /// [`Error::Invalid`] when the text can't be written in the file's
    /// encoding, the directory is missing, the path is a directory, or an
    /// editor holds unsaved changes for the file (save them first).
    pub fn write_file(path: &str, text: &str) -> Result<(), Error> {
        imp::fs_write_file(path, text)
    }

    /// Replaces the bytes of a file, or creates it, at most 16 MiB, in one
    /// step; fails like [`write_file`].
    pub fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), Error> {
        imp::fs_write_bytes(path, bytes)
    }
}

/// The plugin's persistent key-value store (≤ 64 MiB of UTF-8 keys and values).
/// Needs `storage`; rejected writes preserve the stored data.
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

/// Chooses a directory on the UI machine. `None` when dismissed; no capability.
/// Only from a command or event of a window; waiting is excluded from the budget.
pub fn pick_directory(title: &str, initial: Option<&str>) -> Result<Option<String>, Error> {
    imp::pick_directory(title, initial)
}

/// Requests the normal File > Open flow, including project trust, in the
/// invoking window (`false`) or a new window (`true`). No capability.
/// Only commands/events of a window can request this; errors opening the
/// project are shown by that window. `path` belongs to the UI machine.
pub fn open_project(path: &str, new_window: bool) -> Result<(), Error> {
    imp::open_project(path, new_window)
}

/// [`notify`] with up to three buttons; each runs one of this plugin's
/// declared commands in the balloon's window and dismisses the balloon. An
/// invalid action or an undeclared command is an error and nothing is shown.
pub fn notify_with_actions(
    level: NotificationLevel,
    title: &str,
    body: &str,
    actions: &[NotificationAction],
) -> Result<(), Error> {
    imp::notify_with_actions(level, title, body, actions)
}

#[cfg(target_arch = "wasm32")]
#[doc(hidden)]
pub fn __diagnostic_to(d: &Diagnostic) -> crate::bindings::openidea::plugin::diagnostics::Diagnostic {
    imp::diagnostic_to(d)
}

/// Overrides an item in the invoking window, until removed or the window/plugin closes.
pub fn set_window_status_item(id: &str, item: &StatusItem) -> Result<(), Error> {
    imp::set_window_status_item(id, item)
}
/// Removes this window's status override, exposing the global item.
pub fn remove_window_status_item(id: &str) -> Result<(), Error> {
    imp::remove_window_status_item(id)
}

/// An approved byte stream on the project machine (the server in remote projects).
pub struct Connection {
    inner: imp::ConnectionRes,
}
impl Connection {
    /// Writes at most 1 MiB.
    pub fn write(&self, bytes: &[u8]) -> Result<(), Error> {
        imp::ipc_write(&self.inner, bytes)
    }
    /// Reads up to 1 MiB; empty on timeout or EOF.
    pub fn read(&self, max_bytes: u32, timeout_ms: u32) -> Result<Vec<u8>, Error> {
        imp::ipc_read(&self.inner, max_bytes, timeout_ms)
    }
    /// Closes this stream. Dropping it also closes it.
    pub fn close(&self) -> Result<(), Error> {
        imp::ipc_close(&self.inner)
    }
}
/// Connects to a granted absolute socket path or Windows named pipe (API 1.4).
pub fn ipc_connect(name: &str) -> Result<Connection, Error> {
    imp::ipc_connect(name).map(|inner| Connection { inner })
}

/// Executes a stable action or plugin command in the invoking window (API 1.4).
/// Requires high-risk `ide.commands`, except for this plugin's declared commands.
/// IDE actions return `None`; plugin commands return their result. Waiting instances
/// cannot re-enter themselves; command nesting is bounded.
pub fn execute_command(id: &str, arg: Option<&str>) -> Result<Option<String>, Error> {
    imp::execute_command(id, arg)
}

/// Stores a declared secret in the desktop keychain; requires `secrets`.
pub fn secret_set(name: &str, value: &str) -> Result<(), Error> {
    imp::secret_set(name, value)
}
/// Deletes a declared secret; requires `secrets`.
pub fn secret_delete(name: &str) -> Result<(), Error> {
    imp::secret_delete(name)
}
/// A one-shot browser redirect on the desktop, including for remote projects.
pub struct Loopback {
    inner: imp::LoopbackRes,
}
impl Loopback {
    /// The authorization flow's loopback redirect URI.
    pub fn redirect_uri(&self) -> String {
        imp::loopback_uri(&self.inner)
    }
    /// Awaits the raw query string; `None` on timeout. Waiting excludes the call budget.
    pub fn wait(&self, timeout_ms: u32) -> Result<Option<String>, Error> {
        imp::loopback_wait(&self.inner, timeout_ms)
    }
}
/// Begins an OAuth redirect listener in the invoking window (no capability).
pub fn begin_loopback(path: &str) -> Result<Loopback, Error> {
    imp::begin_loopback(path).map(|inner| Loopback { inner })
}

/// Appends to a plugin-owned Output tab's 1 MiB ring buffer.
pub fn output_append(channel: &str, text: &str) -> Result<(), Error> {
    imp::output_append(channel, text)
}
/// Clears a plugin-owned output channel.
pub fn output_clear(channel: &str) -> Result<(), Error> {
    imp::output_clear(channel)
}
/// Reveals a read-only Output tab in the invoking window.
pub fn output_reveal(channel: &str) -> Result<(), Error> {
    imp::output_reveal(channel)
}

/// The invoking window's open editors. Requires editor.read; commands/events only.
pub fn open_editors() -> Result<Vec<OpenEditor>, Error> {
    imp::open_editors()
}
/// Opens a project file (project.read) or plugin-dir file, optionally selecting a range.
/// Only available in commands/events of a window.
pub fn open_editor(path: &str, selection: Option<Range>) -> Result<(), Error> {
    imp::editor_open(path, selection)
}
/// The invoking window's project Problems view. Requires project.read. Empty for remote projects.
pub fn problems(path: Option<&str>) -> Result<Vec<FileProblems>, Error> {
    imp::problems(path)
}
/// Replace a file's editor decorations. Requires project.read; 10,000 items/file, 50 sets.
pub fn set_decorations(path: &str, set: &str, items: &[Decoration]) -> Result<(), Error> {
    imp::set_decorations(path, set, items)
}
/// Clear this plugin's editor decoration set in all projects. Requires project.read.
pub fn clear_decorations(set: &str) -> Result<(), Error> {
    imp::clear_decorations(set)
}
/// Set a project-tree badge/style. Requires project.read. Badge is at most two characters.
pub fn set_file_decoration(path: &str, set: &str, item: &FileDecoration) -> Result<(), Error> {
    imp::set_file_decoration(path, set, item)
}
/// Clear this plugin's tree decoration set in all projects. Requires project.read.
pub fn clear_file_decorations(set: &str) -> Result<(), Error> {
    imp::clear_file_decorations(set)
}
/// Set a note shown after a file's name in the project tree, replacing this tree set's
/// annotation for the file (API 1.7). One line of at most 200 characters. Requires project.read.
pub fn set_file_note(path: &str, set: &str, note: &str, tooltip: Option<&str>) -> Result<(), Error> {
    imp::set_file_note(path, set, note, tooltip)
}

/// Starts an owned run configuration in the invoking window. Its id receives run-exited.
pub fn start_run(config: &str, args: &[String], debug: bool) -> Result<String, Error> {
    imp::start_run(config, args, debug)
}
/// Opens/reuses a keyed, approved terminal with append-only environment variables.
pub fn open_terminal_session(key: &str, title: &str, cmd: &Command) -> Result<String, Error> {
    imp::open_terminal_session(key, title, cmd)
}
/// Writes to this plugin's running keyed terminal in the invoking window.
pub fn write_terminal(key: &str, text: &str) -> Result<(), Error> {
    imp::write_terminal(key, text)
}
/// Opens a content editor through the existing content-tab protocol.
pub fn open_content_tab(tab: &crate::ContentTab) -> Result<(), Error> {
    imp::open_content_tab(tab)
}
/// Replies to a content-tab-action event in its originating window.
pub fn reply_content_tab(request: &str, reply: &crate::ContentTabReply) -> Result<(), Error> {
    imp::reply_content_tab(request, reply)
}
/// API 1.7: opens two texts in the invoking window's diff viewer; `file_name` picks the
/// syntax highlighting.
pub fn open_diff(diff: &crate::ContentDiff, file_name: Option<&str>) -> Result<(), Error> {
    imp::open_diff(diff, file_name)
}

/// Registers/replaces a read-only project target. Requires the program's process grant.
pub fn register_run_target(project: &Project, target: &crate::PluginRunTarget) -> Result<(), Error> {
    imp::register_run_target(&project.inner, target)
}
/// Registers a target with per-command working-directory control (API 1.5).
/// Requires the same process grant and project trust as register_run_target.
pub fn register_run_target_with_overrides(
    project: &Project,
    target: &crate::PluginRunTargetWithOverrides,
) -> Result<(), Error> {
    imp::register_run_target_with_overrides(&project.inner, target)
}
/// Withdraws a target owned by this plugin.
pub fn unregister_run_target(project: &Project, id: &str) {
    imp::unregister_run_target(&project.inner, id);
}

/// Stdio bridge argv for the invoking project, none while the built-in MCP server is off.
pub fn mcp_stdio_command() -> Option<Vec<String>> {
    imp::mcp_stdio_command()
}

/// What other plugins contributed to `point`, an extension point this plugin
/// declares in `[[extension-points]]`, in the order those plugins started.
/// `Error::Denied` for another plugin's point, `Error::NotFound` while no
/// running plugin declares it. Contributions change when plugins are enabled,
/// disabled, updated or reloaded: subscribe to `EventKind::ExtensionsChanged`
/// to refresh what was derived from them. Needs `engines.openidea = "^1.4"`.
pub fn extension_contributions(point: &str) -> Result<Vec<crate::Contribution>, Error> {
    imp::extension_contributions(point)
}
