//! `check_files`: fresh diagnostics from the language servers right after an edit, and why a
//! file could not be checked (no server for it, not installed, crashed, misconfigured…).

use super::editors::problem;
use crate::mcp::run::timeout;
use crate::mcp::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{IdeError, IdeResult, Severity};
use ide_lsp::DocumentCheck;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: usize = 30_000;
const MAX_FILES: usize = 20;

pub fn check_files() -> Tool {
    Tool::new(
        "check_files",
        &format!(
            "Checks files with the language servers now and returns their problems: call it after changing files \
(with any tool, inside or outside the IDE). Each file is synced from disk and saved to its servers, so checks that \
run on save (rust-analyzer's cargo check) run too; then the call waits until every server answered for the current \
text and finished the work it started, up to `timeout` milliseconds (default {DEFAULT_TIMEOUT_MS}) for all files. \
Unlike get_file_problems, this is a fresh analysis, before the inspection profile's filtering.

Per file, `status` says what the problems are worth:
- checked: every server answered; `problems` is complete (empty means no problems).
- incomplete: some server was still analysing when the wait ended, or could not check; call again or raise `timeout`.
- serverUnavailable: no server could check. `servers` gives each one's `status` (missing: not installed; \
misconfigured; crashed; starting: did not finish starting) and `message`; tell the user, since the IDE has to be \
fixed (Settings › Languages & Frameworks › Language Servers), and check another way meanwhile (a build or a compiler).
- noLanguageServer: no language server is configured for this kind of file.
- untrusted: language servers don't run in an untrusted project.
- failed: the file could not be opened (`error`).
`unsavedInEditor` is true when the file has unsaved changes in the IDE: the problems are for the editor's text, not \
the file on disk. Lines and UTF-16 columns are 1-based."
        ),
        |call| async move {
            let raw = call.str_list("filePaths")?;
            if raw.is_empty() {
                return Err(IdeError::invalid("filePaths must name at least one file"));
            }
            if raw.len() > MAX_FILES {
                return Err(IdeError::invalid(format!("at most {MAX_FILES} files at a time")));
            }
            let errors_only = call.flag("errorsOnly", true)?;
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS)?;
            let mut paths = Vec::new();
            for p in raw {
                paths.push(call.resolve_readable(&p).await?);
            }
            let checks = paths.into_iter().map(|path| check_one(&call, path, limit, errors_only));
            let files = futures::future::join_all(checks).await;
            Output::json(json!({ "files": files }))
        },
    )
    .param(Param::required("filePaths", ParamType::StringList, "Files to check, relative to the project root"))
    .param(Param::optional(
        "errorsOnly",
        ParamType::Boolean,
        "Whether to return only errors (default) or warnings and hints too",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Milliseconds to wait for the servers at most"))
}

async fn check_one(call: &Call, path: PathBuf, limit: Duration, errors_only: bool) -> Value {
    let mut out = json!({ "filePath": call.display(&path) });
    if !call.project().is_trusted() {
        out["status"] = "untrusted".into();
        return out;
    }
    match check(call, &path, limit).await {
        Ok((check, dirty, text)) => {
            let servers: Vec<Value> = check
                .servers
                .iter()
                .map(|s| {
                    let mut v = json!({ "name": s.name, "status": s.status, "checked": s.checked });
                    if let Some(m) = &s.message {
                        v["message"] = m.clone().into();
                    }
                    if s.incomplete {
                        v["incomplete"] = true.into();
                    }
                    if let Some(e) = &s.error {
                        v["error"] = e.clone().into();
                    }
                    v
                })
                .collect();
            out["status"] = file_status(&check).into();
            out["problems"] = check
                .diagnostics
                .into_iter()
                .filter(|d| !errors_only || d.severity == Severity::Error)
                .map(|d| problem(d, &text))
                .collect::<Vec<_>>()
                .into();
            out["servers"] = servers.into();
            if dirty {
                out["unsavedInEditor"] = true.into();
            }
        }
        Err(e) => {
            out["status"] = "failed".into();
            out["error"] = e.message.into();
        }
    }
    out
}

fn file_status(check: &DocumentCheck) -> &'static str {
    if check.servers.is_empty() {
        "noLanguageServer"
    } else if !check.servers.iter().any(|s| s.checked) {
        "serverUnavailable"
    } else if check.servers.iter().all(|s| s.checked && !s.incomplete) {
        "checked"
    } else {
        "incomplete"
    }
}

/// The check of `path`, whether it has unsaved changes in the IDE, and its text.
async fn check(call: &Call, path: &std::path::Path, limit: Duration) -> IdeResult<(DocumentCheck, bool, String)> {
    let project = call.project().clone();
    let docs = project.documents.clone();
    let p = path.to_owned();
    let at = Instant::now();
    // Synced now: the file watcher's reload of a change made outside the IDE may not have run.
    let (doc, changed, dirty) = call
        .host()
        .blocking(move || {
            let before = docs.by_path(&p).and_then(|d| docs.version(d).ok().map(|v| (d, v)));
            docs.on_disk_changed(std::slice::from_ref(&p));
            let doc = docs.open(&p)?.id;
            let changed = before.is_none_or(|(d, v)| d != doc || docs.version(d).is_ok_and(|now| now != v));
            Ok((doc, changed, docs.is_dirty(doc).unwrap_or(false)))
        })
        .await?;
    let result = project.lsp.check_document(doc, changed.then_some(at), limit, &call.cancel).await;
    let text = project.documents.text_snapshot(doc).map(|t| t.text).unwrap_or_default();
    let docs = project.documents.clone();
    let _ = call
        .host()
        .blocking(move || {
            docs.close(doc);
            Ok(())
        })
        .await;
    Ok((result?, dirty, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::event::ServerStatus;
    use ide_lsp::CheckedServer;

    fn server(status: ServerStatus, checked: bool, incomplete: bool) -> CheckedServer {
        CheckedServer { name: "s".into(), status, message: None, checked, incomplete, error: None }
    }

    #[test]
    fn statuses_say_whether_the_problems_are_complete() {
        let check = |servers| file_status(&DocumentCheck { diagnostics: Vec::new(), servers });
        assert_eq!(check(vec![]), "noLanguageServer");
        assert_eq!(check(vec![server(ServerStatus::Missing, false, false)]), "serverUnavailable");
        assert_eq!(check(vec![server(ServerStatus::Ready, true, false)]), "checked");
        assert_eq!(check(vec![server(ServerStatus::Busy, true, true)]), "incomplete");
        assert_eq!(
            check(vec![server(ServerStatus::Ready, true, false), server(ServerStatus::Crashed, false, false)]),
            "incomplete"
        );
    }
}
