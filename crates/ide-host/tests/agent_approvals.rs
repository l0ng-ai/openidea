//! The mode new agent tasks start in.

use ide_core::NullSink;
use ide_host::{Host, HostConfig};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

/// Codex's modes as it reported them last time, in "ask".
fn remember_codex_modes(data: &Path) {
    std::fs::create_dir_all(data.join("agents")).unwrap();
    let modes = json!({ "codex": { "config": [ {
        "id": "mode", "name": "Mode", "description": null, "category": "mode", "current": "ask",
        "values": [ { "value": "read-only", "name": "Read Only", "description": null },
                    { "value": "ask", "name": "Ask", "description": null },
                    { "value": "full-access", "name": "Full Access", "description": null } ],
        "via": "option" } ] } });
    std::fs::write(data.join("agents/models.json"), modes.to_string()).unwrap();
}

fn codex_mode(host: &Host) -> Option<String> {
    let providers = ide_host::ops::agent::providers(host, "main").unwrap();
    let codex = providers.into_iter().find(|p| p.id == "codex").expect("codex is listed");
    codex.config.into_iter().find(|o| o.id == "mode").and_then(|o| o.current)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_tasks_start_asking_for_approval_when_the_user_chose_so() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    let (config, data) = (tmp.path().join("config"), tmp.path().join("data"));
    remember_codex_modes(&data);
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("settings.toml"), "[agents]\nnewTaskApprovals = \"ask\"\n").unwrap();
    // A project's own settings don't choose this.
    std::fs::write(root.join(".openidea/settings.toml"), "[agents]\nnewTaskApprovals = \"bypass\"\n").unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: config.clone(),
        data_dir: data,
        local_data_dir: tmp.path().join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    assert_eq!(codex_mode(&host).as_deref(), Some("ask"));

    // The default keeps starting new tasks without approvals.
    std::fs::remove_file(config.join("settings.toml")).unwrap();
    host.project("main").unwrap().settings.reload();
    assert_eq!(codex_mode(&host).as_deref(), Some("full-access"));
}
