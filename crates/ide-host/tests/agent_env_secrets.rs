//! Values of agents' environment variables live in the credential store; agent files keep only their names.

use ide_core::NullSink;
use ide_host::{Host, HostConfig};
use ide_ssh::secrets::testing::{files_containing, use_memory_store};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const VALUE: &str = "agent-env-value-5b2d81";

fn host(dir: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: dir.join("config"),
        data_dir: dir.join("data"),
        local_data_dir: dir.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn open(host: &Host, tmp: &tempfile::TempDir) {
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
}

fn env_of(host: &Host, id: &str) -> BTreeMap<String, String> {
    let providers = ide_host::ops::agent::providers(host, "main").unwrap();
    providers.into_iter().find(|p| p.id == id).unwrap_or_else(|| panic!("{id}")).env
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_environment_values_stay_out_of_agent_files() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    open(&host, &tmp);
    let env = BTreeMap::from([("ANTHROPIC_API_KEY".to_owned(), VALUE.to_owned())]);
    ide_host::ops::agent::set_env(&host, "main", "claude".into(), env.clone()).unwrap();
    ide_host::ops::agent::save_custom_agent(
        &host,
        "main",
        ide_agent::CustomAgentInput {
            id: "mine".into(),
            name: "Mine".into(),
            command: "/opt/mine".into(),
            args: vec![],
            env: env.clone(),
        },
    )
    .unwrap();
    host.close_project("main");
    assert_eq!(files_containing(tmp.path(), VALUE), Vec::<PathBuf>::new());

    let host = self::host(tmp.path());
    open(&host, &tmp);
    assert_eq!(env_of(&host, "claude"), env);
    assert_eq!(env_of(&host, "mine"), env);
    ide_host::ops::agent::remove_custom_agent(&host, "main", "mine".into()).unwrap();
    ide_host::ops::agent::set_env(&host, "main", "claude".into(), BTreeMap::new()).unwrap();
    assert_eq!(host.agent_secrets.keys("agent/"), Vec::<String>::new());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn values_in_agent_files_move_to_the_credential_store() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("config/agents")).unwrap();
    std::fs::write(
        tmp.path().join("config/agents/mine.toml"),
        format!("command = \"/opt/mine\"\n[env]\nTOKEN = \"{VALUE}\"\n"),
    )
    .unwrap();
    let host = host(tmp.path());
    open(&host, &tmp);
    assert_eq!(files_containing(tmp.path(), VALUE), Vec::<PathBuf>::new());
    assert_eq!(env_of(&host, "mine"), BTreeMap::from([("TOKEN".to_owned(), VALUE.to_owned())]));
    host.close_project("main");
}
