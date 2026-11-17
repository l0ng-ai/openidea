//! Kotlin debugging: kotlin-lsp's debugger when the project's kotlin-lsp can serve it, else
//! kotlin-debug-adapter with a notice saying why.

use crate::Host;
use ide_core::event::NotifyLevel;
use ide_core::task::CancelHandle;
use ide_core::{CancellationToken, IdeEvent, IdeResult, SharedSink, TaskId};
use ide_dap::LaunchConfig;
use ide_lsp::{KotlinDebugServer, KotlinDebugUnavailable};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

pub(super) const KOTLIN_IMPORT_WAIT: Duration = Duration::from_secs(120);
/// A ready kotlin-lsp answers well within this; only a longer wait shows a task.
const TASK_DELAY: Duration = Duration::from_millis(500);

// Catalogued as written (`{detail}` replaced at runtime): the text catalog test counts these
// literals as the use of its entries.
const TASK_TITLE: &str = "Waiting for kotlin-lsp to import the project";
const NOTICE_TITLE: &str = "Debugging Kotlin with kotlin-debug-adapter";
const NOT_CONFIGURED: &str = "kotlin-lsp is not the Kotlin language server of this project.";
const NOT_INSTALLED: &str = "kotlin-lsp is not installed.";
const NOT_STARTED: &str = "kotlin-lsp did not start: {detail}";
const STILL_IMPORTING: &str =
    "kotlin-lsp is still importing the project. Debug again once the import has finished to use its debugger.";
const IMPORT_FAILED: &str = "kotlin-lsp could not import the project.";
const FAILED: &str = "kotlin-lsp could not start its debugger: {detail}";

/// `config` for kotlin-lsp's debug server on `port`; the rest of the launch stays as it is.
pub(super) fn use_kotlin_lsp(mut config: LaunchConfig, port: u16) -> IdeResult<LaunchConfig> {
    let mut extra = extra_object(&config)?;
    extra.insert("debugServer".into(), port.into());
    config.adapter = ide_dap::kotlin_lsp::ADAPTER.into();
    config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    Ok(config)
}

/// The dedupe key of `reason` and the notice body (English, translated by the UI's catalog).
pub(super) fn fallback_notice(reason: &KotlinDebugUnavailable) -> (&'static str, String) {
    match reason {
        KotlinDebugUnavailable::NotConfigured => ("notConfigured", NOT_CONFIGURED.into()),
        KotlinDebugUnavailable::NotInstalled => ("notInstalled", NOT_INSTALLED.into()),
        KotlinDebugUnavailable::NotStarted(detail) => ("notStarted", NOT_STARTED.replace("{detail}", detail)),
        KotlinDebugUnavailable::StillImporting => ("stillImporting", STILL_IMPORTING.into()),
        KotlinDebugUnavailable::ImportFailed => ("importFailed", IMPORT_FAILED.into()),
        KotlinDebugUnavailable::Failed(detail) => ("failed", FAILED.replace("{detail}", detail)),
    }
}

/// A kotlin-debug-adapter launch becomes a kotlin-lsp one when the project's kotlin-lsp has
/// imported the module and started its debug server; otherwise it stays on
/// kotlin-debug-adapter and the window is told why (once per reason).
pub(super) async fn choose_kotlin_debugger(host: &Host, window: &str, config: LaunchConfig) -> IdeResult<LaunchConfig> {
    if config.adapter == ide_dap::kotlin_lsp::ADAPTER {
        require_debug_server(&config)?;
        return Ok(config);
    }
    if config.adapter != ide_dap::kotlin::ADAPTER {
        return Ok(config);
    }
    let Ok(project) = host.project(window) else {
        tracing::info!(
            "debugging Kotlin with kotlin-debug-adapter: {}",
            fallback_notice(&KotlinDebugUnavailable::NotConfigured).1
        );
        return Ok(config);
    };
    let path = debug_path(&config).unwrap_or_else(|| project.root.clone());
    let lsp = project.lsp.clone();
    let chosen = wait_for_debug_server(&project.sink, |cancel| async move {
        lsp.kotlin_debug_server(&path, KOTLIN_IMPORT_WAIT, &cancel).await
    })
    .await;
    match chosen {
        Ok(server) => use_kotlin_lsp(config, server.port),
        Err(reason) => {
            report_fallback(&project.kotlin_debug_notices, &project.sink, &reason);
            Ok(config)
        }
    }
}

/// kotlin-lsp is only reached through the port its language server opened; without one
/// ide-dap would try to spawn a `kotlin-lsp` adapter that does not exist.
fn require_debug_server(config: &LaunchConfig) -> IdeResult<()> {
    match extra_object(config)?.get("debugServer") {
        None | Some(serde_json::Value::Null) => Err(ide_core::IdeError::invalid(
            "A kotlin-lsp debug configuration needs \"debugServer\": the port of kotlin-lsp's debug server. \
             Use kotlin-debug-adapter to let the IDE start it.",
        )),
        Some(_) => Ok(()),
    }
}

fn extra_object(config: &LaunchConfig) -> IdeResult<serde_json::Map<String, serde_json::Value>> {
    match config.extra_json.as_deref().map(serde_json::from_str).transpose() {
        Ok(None) => Ok(serde_json::Map::new()),
        Ok(Some(serde_json::Value::Object(extra))) => Ok(extra),
        Ok(Some(other)) => Err(ide_core::IdeError::invalid(format!("launch arguments are not an object: {other}"))),
        Err(e) => Err(ide_core::IdeError::invalid(e.to_string())),
    }
}

/// The module to debug: the launch's `projectRoot`, else its working directory.
fn debug_path(config: &LaunchConfig) -> Option<PathBuf> {
    let extra: Option<serde_json::Value> = config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok());
    extra
        .as_ref()
        .and_then(|e| e.get("projectRoot")?.as_str())
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .or_else(|| config.cwd.as_deref().map(PathBuf::from))
}

/// Runs `debug_server` with a token the user can cancel; a wait longer than [`TASK_DELAY`]
/// shows as a cancellable task, which ends however the wait does (also when dropped).
async fn wait_for_debug_server<F, Fut>(
    sink: &SharedSink,
    debug_server: F,
) -> Result<KotlinDebugServer, KotlinDebugUnavailable>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: Future<Output = Result<KotlinDebugServer, KotlinDebugUnavailable>>,
{
    let cancel = CancellationToken::new();
    let id = TaskId::next();
    let handle = ide_core::task::on_cancel(id, {
        let cancel = cancel.clone();
        move || cancel.cancel()
    });
    let wait = debug_server(cancel);
    tokio::pin!(wait);
    if let Ok(answer) = tokio::time::timeout(TASK_DELAY, &mut wait).await {
        return answer;
    }
    let _task = WaitTask::start(sink.clone(), id, handle);
    wait.await
}

/// The visible import wait; dropping it ends the task.
struct WaitTask {
    sink: SharedSink,
    id: TaskId,
    _cancel: CancelHandle,
}

impl WaitTask {
    fn start(sink: SharedSink, id: TaskId, cancel: CancelHandle) -> Self {
        let task = Self { sink, id, _cancel: cancel };
        task.emit(false);
        task
    }

    fn emit(&self, done: bool) {
        self.sink.emit(IdeEvent::Task {
            id: self.id,
            title: TASK_TITLE.into(),
            message: None,
            fraction: None,
            done,
            cancellable: !done,
        });
    }
}

impl Drop for WaitTask {
    fn drop(&mut self) {
        self.emit(true);
    }
}

/// Logs every fallback; notifies the window once per reason.
fn report_fallback(notices: &Mutex<HashSet<&'static str>>, sink: &SharedSink, reason: &KotlinDebugUnavailable) {
    let (key, body) = fallback_notice(reason);
    tracing::info!("debugging Kotlin with kotlin-debug-adapter: {body}");
    if notices.lock().insert(key) {
        sink.emit(IdeEvent::Notify { level: NotifyLevel::Info, title: NOTICE_TITLE.into(), body: Some(body) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Arc;

    fn launch(adapter: &str, extra: serde_json::Value) -> LaunchConfig {
        LaunchConfig {
            name: "AppKt".into(),
            adapter: adapter.into(),
            request: "launch".into(),
            program: None,
            args: vec![],
            cwd: Some("/cwd".into()),
            env: Default::default(),
            extra_json: Some(extra.to_string()),
        }
    }

    fn extra(config: &LaunchConfig) -> serde_json::Value {
        serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap()
    }

    fn reasons() -> Vec<KotlinDebugUnavailable> {
        vec![
            KotlinDebugUnavailable::NotConfigured,
            KotlinDebugUnavailable::NotInstalled,
            KotlinDebugUnavailable::NotStarted("needs JDK 21".into()),
            KotlinDebugUnavailable::StillImporting,
            KotlinDebugUnavailable::ImportFailed,
            KotlinDebugUnavailable::Failed("boom".into()),
        ]
    }

    fn recording_sink() -> (SharedSink, Arc<Mutex<Vec<IdeEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        (Arc::new(move |event| recorded.lock().push(event)), events)
    }

    /// `(done, cancellable)` of each task event, with the task id.
    fn tasks(events: &Mutex<Vec<IdeEvent>>) -> Vec<(ide_core::TaskId, String, bool, bool)> {
        events
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Task { id, title, done, cancellable, .. } => Some((*id, title.clone(), *done, *cancellable)),
                _ => None,
            })
            .collect()
    }

    fn server() -> KotlinDebugServer {
        KotlinDebugServer { port: 4711, root: PathBuf::from("/p") }
    }

    #[test]
    fn kotlin_lsp_takes_the_debug_server_port() {
        let config = launch(ide_dap::kotlin::ADAPTER, serde_json::json!({"mainClass": "a.AppKt", "projectRoot": "/p"}));
        let c = use_kotlin_lsp(config, 4711).unwrap();
        assert_eq!(c.adapter, ide_dap::kotlin_lsp::ADAPTER);
        let args = extra(&c);
        assert_eq!(args["debugServer"], 4711);
        assert_eq!(args["mainClass"], "a.AppKt");
        assert_eq!(args["projectRoot"], "/p");
        assert!(args.get("__adapterJavaHome").is_none());
        assert_eq!(
            (c.name.as_str(), c.request.as_str(), c.cwd.as_deref()),
            ("AppKt", "launch", Some(Path::new("/cwd")))
        );
        let mut bare = launch(ide_dap::kotlin::ADAPTER, serde_json::json!({}));
        bare.extra_json = None;
        assert_eq!(extra(&use_kotlin_lsp(bare, 4711).unwrap())["debugServer"], 4711);
    }

    #[test]
    fn every_fallback_reason_has_a_catalogued_text() {
        let catalogs: [(&str, serde_json::Value); 2] = [
            ("en", serde_json::from_str(include_str!("../../../../../src/platform/locales/text/en.json")).unwrap()),
            ("zh", serde_json::from_str(include_str!("../../../../../src/platform/locales/text/zh.json")).unwrap()),
        ];
        let templates = [NOT_CONFIGURED, NOT_INSTALLED, NOT_STARTED, STILL_IMPORTING, IMPORT_FAILED, FAILED];
        for reason in reasons() {
            let (_, body) = fallback_notice(&reason);
            let detail = match &reason {
                KotlinDebugUnavailable::NotStarted(d) | KotlinDebugUnavailable::Failed(d) => d.as_str(),
                _ => "",
            };
            assert!(
                templates.iter().any(|t| t.replace("{detail}", detail) == body),
                "{reason:?}: {body:?} is not built from a catalogued template"
            );
        }
        for text in templates.iter().chain([&NOTICE_TITLE, &TASK_TITLE]) {
            for (locale, catalog) in &catalogs {
                let translated = catalog[*text].as_str().unwrap_or_else(|| panic!("{locale}.json lacks {text:?}"));
                if *locale == "zh" {
                    assert_ne!(translated, *text, "zh.json leaves {text:?} untranslated");
                }
            }
        }
    }

    #[test]
    fn fallback_reasons_have_distinct_keys() {
        let keys: HashSet<_> = reasons().iter().map(|r| fallback_notice(r).0).collect();
        assert_eq!(keys.len(), reasons().len());
        // The detail does not make another reason.
        assert_eq!(
            fallback_notice(&KotlinDebugUnavailable::Failed("a".into())).0,
            fallback_notice(&KotlinDebugUnavailable::Failed("b".into())).0
        );
    }

    #[test]
    fn a_kotlin_lsp_config_without_a_debug_server_is_refused() {
        let refused = require_debug_server(&launch(ide_dap::kotlin_lsp::ADAPTER, serde_json::json!({}))).unwrap_err();
        assert_eq!(refused.kind, ide_core::error::ErrorKind::InvalidInput);
        assert!(refused.message.contains("debugServer"), "{}", refused.message);
        let mut bare = launch(ide_dap::kotlin_lsp::ADAPTER, serde_json::json!({}));
        bare.extra_json = None;
        assert!(require_debug_server(&bare).is_err());
        assert!(
            require_debug_server(&launch(ide_dap::kotlin_lsp::ADAPTER, serde_json::json!({"debugServer": null})))
                .is_err()
        );
        for port in [serde_json::json!(4711), serde_json::json!("10.0.0.5:4711")] {
            require_debug_server(&launch(ide_dap::kotlin_lsp::ADAPTER, serde_json::json!({"debugServer": port})))
                .unwrap();
        }
    }

    #[test]
    fn the_module_is_the_project_root_else_the_working_directory() {
        let with_root = launch(ide_dap::kotlin::ADAPTER, serde_json::json!({"projectRoot": "/p/app"}));
        assert_eq!(debug_path(&with_root), Some(PathBuf::from("/p/app")));
        assert_eq!(debug_path(&launch(ide_dap::kotlin::ADAPTER, serde_json::json!({}))), Some(PathBuf::from("/cwd")));
        let mut neither = launch(ide_dap::kotlin::ADAPTER, serde_json::json!({}));
        neither.cwd = None;
        assert_eq!(debug_path(&neither), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_quick_answer_shows_no_task() {
        let (sink, events) = recording_sink();
        assert_eq!(wait_for_debug_server(&sink, |_| async { Ok(server()) }).await, Ok(server()));
        assert!(events.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_longer_wait_shows_a_task_that_ends_on_every_outcome() {
        for outcome in [Ok(server()), Err(KotlinDebugUnavailable::ImportFailed)] {
            let (sink, events) = recording_sink();
            let answer = outcome.clone();
            let result = wait_for_debug_server(&sink, |_| async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                answer
            })
            .await;
            assert_eq!(result, outcome);
            let tasks = tasks(&events);
            assert_eq!(tasks.len(), 2, "{tasks:?}");
            assert_eq!(tasks[0].0, tasks[1].0);
            assert_eq!(tasks[0].1, TASK_TITLE);
            assert_eq!((tasks[0].2, tasks[0].3), (false, true));
            assert_eq!((tasks[1].2, tasks[1].3), (true, false));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_the_task_stops_the_wait() {
        let (sink, events) = recording_sink();
        let wait = tokio::spawn(async move {
            wait_for_debug_server(&sink, |cancel| async move {
                cancel.cancelled().await;
                Err(KotlinDebugUnavailable::StillImporting)
            })
            .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        let id = tasks(&events)[0].0;
        assert!(ide_core::task::cancel(id));
        assert_eq!(wait.await.unwrap(), Err(KotlinDebugUnavailable::StillImporting));
        assert_eq!(tasks(&events).last().map(|t| t.2), Some(true));
        assert!(!ide_core::task::cancel(id), "an ended wait is no longer cancellable");
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_wait_ends_its_task() {
        let (sink, events) = recording_sink();
        let wait = tokio::spawn(async move {
            wait_for_debug_server(&sink, |_| std::future::pending::<Result<KotlinDebugServer, _>>()).await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        wait.abort();
        let _ = wait.await;
        assert_eq!(tasks(&events).iter().map(|t| t.2).collect::<Vec<_>>(), [false, true]);
    }

    #[test]
    fn the_notice_shows_once_per_reason() {
        let (sink, events) = recording_sink();
        let notices = Mutex::new(HashSet::new());
        for reason in [
            KotlinDebugUnavailable::StillImporting,
            KotlinDebugUnavailable::StillImporting,
            KotlinDebugUnavailable::NotStarted("needs JDK 21".into()),
            KotlinDebugUnavailable::NotStarted("crashed".into()),
        ] {
            report_fallback(&notices, &sink, &reason);
        }
        let notes: Vec<_> = events
            .lock()
            .iter()
            .map(|e| match e {
                IdeEvent::Notify { level, title, body } => (*level, title.clone(), body.clone()),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            notes,
            [
                (NotifyLevel::Info, NOTICE_TITLE.to_string(), Some(STILL_IMPORTING.to_string())),
                (
                    NotifyLevel::Info,
                    NOTICE_TITLE.to_string(),
                    Some("kotlin-lsp did not start: needs JDK 21".to_string())
                ),
            ]
        );
    }
}
