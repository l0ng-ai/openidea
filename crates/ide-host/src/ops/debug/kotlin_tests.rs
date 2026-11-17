//! Kotlin's debugger choice through a real `Host` and project: the fallback notice and the
//! refusal of a kotlin-lsp configuration without its debug server.

use super::*;
use crate::HostConfig;
use ide_core::IdeEvent;
use ide_core::event::NotifyLevel;
use ide_lsp::KotlinDebugUnavailable;
use ide_workspace::SettingsScope;
use parking_lot::Mutex;
use std::sync::Arc;

const NOTICE_TITLE: &str = "Debugging Kotlin with kotlin-debug-adapter";

struct Fixture {
    host: Host,
    root: PathBuf,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    _temp: tempfile::TempDir,
}

impl Fixture {
    /// A trusted Gradle project opened with these global settings; kotlin-debug-adapter is a
    /// missing executable, so a session fails right after the debugger is chosen.
    async fn new(settings: &[(&str, serde_json::Value)]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("settings.gradle.kts"), "rootProject.name = \"app\"\n").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(move |_| {
                let events = captured.clone();
                Arc::new(move |event| events.lock().push(event))
            }),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let missing = base.join("missing").join("kotlin-debug-adapter");
        host.global_settings
            .set(SettingsScope::Global, "tools", serde_json::json!({"kotlin-debug-adapter": {"path": missing}}))
            .unwrap();
        for (key, value) in settings {
            host.global_settings.set(SettingsScope::Global, key, value.clone()).unwrap();
        }
        host.open_project("main", &root).unwrap();
        host.set_project_trust(&root, true, false).await.unwrap();
        Self { host, root, events, _temp: temp }
    }

    fn launch(&self, adapter: &str, extra: serde_json::Value) -> LaunchConfig {
        LaunchConfig {
            name: "AppKt".into(),
            adapter: adapter.into(),
            request: "launch".into(),
            program: None,
            args: vec![],
            cwd: Some(self.root.clone().into()),
            env: Default::default(),
            extra_json: Some(extra.to_string()),
        }
    }

    fn kotlin_launch(&self) -> LaunchConfig {
        let extra = serde_json::json!({"mainClass": "com.example.AppKt", "projectRoot": self.root});
        self.launch(ide_dap::kotlin::ADAPTER, extra)
    }

    /// `(level, body)` of each fallback notice.
    fn notices(&self) -> Vec<(NotifyLevel, Option<String>)> {
        self.events
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::Notify { level, title, body } if title == NOTICE_TITLE => Some((*level, body.clone())),
                _ => None,
            })
            .collect()
    }
}

/// Two Debugs, each failing only at kotlin-debug-adapter's missing executable.
async fn debug_twice(f: &Fixture) {
    for _ in 0..2 {
        let error = debug_start(&f.host, "main", f.kotlin_launch()).await.unwrap_err();
        assert!(!error.message.contains("Restricted Mode"), "{}", error.message);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kotlin_lsp_turned_off_gives_one_notice_over_two_debugs() {
    let f = Fixture::new(&[("languageServers", serde_json::json!({"kotlin-lsp": {"enabled": false}}))]).await;
    debug_twice(&f).await;
    let (_, body) = kotlin::fallback_notice(&KotlinDebugUnavailable::NotConfigured);
    assert_eq!(f.notices(), [(NotifyLevel::Info, Some(body))]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_kotlin_lsp_gives_one_notice_over_two_debugs() {
    let missing = serde_json::json!({"kotlin-lsp": {"command": "/nonexistent/kotlin-lsp"}});
    let f = Fixture::new(&[("languageServers", missing)]).await;
    debug_twice(&f).await;
    let (_, body) = kotlin::fallback_notice(&KotlinDebugUnavailable::NotInstalled);
    assert_eq!(f.notices(), [(NotifyLevel::Info, Some(body))]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kotlin_lsp_config_without_its_debug_server_is_refused() {
    let f = Fixture::new(&[]).await;
    let config = f.launch(ide_dap::kotlin_lsp::ADAPTER, serde_json::json!({"mainClass": "com.example.AppKt"}));
    let refused = debug_start(&f.host, "main", config).await.unwrap_err();
    assert_eq!(refused.kind, ide_core::error::ErrorKind::InvalidInput);
    assert!(refused.message.contains("debugServer"), "{}", refused.message);
    assert!(f.notices().is_empty());
}
