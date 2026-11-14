//! Separate project windows share discovery and its backend-enforced cooldown.
#![cfg(unix)]

use ide_agent::AgentEvent;
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn windows_share_model_discovery_and_manual_refresh_cooldown() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    let config = tmp.path().join("config");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(config.join("agents")).unwrap();
    let script = tmp.path().join("catalog.sh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
printf 'launch\n' >> "${0%/*}/launches"
while IFS= read -r line; do
    case "$line" in
        *'"id":'*) rest=${line#*\"id\":}; id=${rest%%,*}; id=${id%%\}*} ;;
        *) continue ;;
    esac
    case "$line" in
        *'"method":"initialize"'*)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{}}}\n' "$id" ;;
        *'"method":"session/new"'*)
            while [ ! -f "${0%/*}/release" ]; do sleep 0.01; done
            printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"catalog","configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"new-model","options":[{"value":"new-model","name":"New model"}]}]}}\n' "$id" ;;
    esac
done
"#,
    )
    .unwrap();
    std::fs::write(
        config.join("agents/catalog-test.toml"),
        format!(
            "name = \"Catalog test\"\ncommand = \"/bin/sh\"\nargs = [{}]\n",
            serde_json::to_string(&script).unwrap()
        ),
    )
    .unwrap();
    let host = Host::new(HostConfig {
        config_dir: config,
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("first", &root).unwrap();
    host.open_project("second", &root).unwrap();
    let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
    for window in ["first", "second"] {
        let send = send.clone();
        host.project(window).unwrap().agents.subscribe(Arc::new(move |event| {
            if let AgentEvent::ModelCatalog { catalog } = event {
                let _ = send.send((window, catalog));
            }
        }));
    }
    for _ in 0..20 {
        for window in ["first", "second"] {
            let state = ops::agent::refresh_models(&host, window, "catalog-test".into(), true).unwrap();
            assert!(state.refreshing);
        }
    }
    std::fs::write(tmp.path().join("release"), "").unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        let mut windows = std::collections::HashSet::new();
        while windows.len() < 2 {
            let (window, catalog) = events.recv().await.expect("catalog event stream closed");
            if !catalog.refreshing && catalog.refreshed_at_ms.is_some() {
                assert!(catalog.error.is_none(), "{:?}", catalog.error);
                windows.insert(window);
            }
        }
    })
    .await;
    assert!(completed.is_ok(), "both windows must receive the completed catalog");
    for _ in 0..20 {
        for window in ["first", "second"] {
            let catalog = ops::agent::refresh_models(&host, window, "catalog-test".into(), true).unwrap();
            assert!(!catalog.refreshing);
            assert!(catalog.retry_at_ms.is_some());
            let models = catalog.config.iter().find(|o| o.category.as_deref() == Some("model")).unwrap();
            assert_eq!(models.values[0].value, "new-model");
        }
    }
    assert_eq!(std::fs::read_to_string(tmp.path().join("launches")).unwrap(), "launch\n");
}
