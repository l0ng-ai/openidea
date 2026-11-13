//! Values of the user's MCP servers' environment variables and HTTP headers live in the
//! credential store; `settings.toml` keeps only their names. A project's own servers keep
//! their values in the project's file, where the project shares them.

use ide_agent::{McpKeyValue, McpScope, McpServer, McpServerInput};
use ide_core::NullSink;
use ide_core::settings::McpTransport;
use ide_host::{Host, HostConfig};
use ide_ssh::secrets::testing::{files_containing, use_memory_store};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const VALUE: &str = "mcp-value-0f3c9a";

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

fn project(tmp: &tempfile::TempDir) -> PathBuf {
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    root
}

fn open(host: &Host, root: &Path) {
    host.trust.decide(root, true, false).unwrap();
    host.open_project("main", root).unwrap();
}

fn header(servers: &[McpServer], id: &str) -> String {
    let server = servers.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("{id} in {servers:?}"));
    server.headers.iter().find(|h| h.name == "Authorization").map(|h| h.value.clone()).unwrap_or_default()
}

fn input(name: &str, scope: McpScope) -> McpServerInput {
    McpServerInput {
        id: None,
        name: name.into(),
        scope,
        transport: McpTransport::Http,
        enabled: true,
        command: None,
        args: vec![],
        env: vec![],
        url: Some("https://mcp.example/v1".into()),
        headers: vec![McpKeyValue { name: "Authorization".into(), value: format!("Bearer {VALUE}") }],
        agents: vec![],
    }
}

const SERVER_WITH_VALUE: &str = r#"
[agents.mcpServers.remote]
transport = "http"
enabled = true
url = "https://mcp.example/v1"
headers = { Authorization = "Bearer mcp-value-0f3c9a" }
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn user_server_values_stay_out_of_the_user_settings() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let root = project(&tmp);
    let host = host(tmp.path());
    open(&host, &root);
    for (name, scope) in [("user-server", McpScope::User), ("repo-server", McpScope::Workspace)] {
        ide_host::ops::agent::mcp_save(&host, "main", input(name, scope)).unwrap();
    }
    host.close_project("main");

    // Only the project's own file holds a value; nothing in the user's config or data does.
    let found = files_containing(tmp.path(), VALUE);
    assert!(found.len() == 1 && found[0].ends_with(Path::new(".openidea/settings.toml")), "{found:?}");

    let host = self::host(tmp.path());
    open(&host, &root);
    let servers = ide_host::ops::agent::mcp_list(&host, "main").unwrap();
    assert_eq!(header(&servers, "user::user-server"), format!("Bearer {VALUE}"));
    assert_eq!(header(&servers, "workspace::repo-server"), format!("Bearer {VALUE}"));
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn values_in_user_settings_move_to_the_credential_store() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let root = project(&tmp);
    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    let saved = SERVER_WITH_VALUE.replace("Authorization =", "X-Saved = \"\", Authorization =");
    std::fs::write(tmp.path().join("config/settings.toml"), saved).unwrap();
    ide_host::agent_secrets::AgentSecrets::new(&tmp.path().join("data"))
        .set("mcp/user/remote/header/X-Saved", "saved-earlier")
        .unwrap();
    let host = host(tmp.path());
    assert_eq!(files_containing(tmp.path(), VALUE), Vec::<PathBuf>::new());
    open(&host, &root);
    let servers = ide_host::ops::agent::mcp_list(&host, "main").unwrap();
    assert_eq!(header(&servers, "user::remote"), format!("Bearer {VALUE}"));
    let remote = servers.iter().find(|s| s.id == "user::remote").unwrap();
    assert!(remote.headers.iter().any(|h| h.name == "X-Saved" && h.value == "saved-earlier"), "{remote:?}");
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_projects_own_values_stay_in_its_file() {
    use_memory_store();
    let tmp = tempfile::tempdir().unwrap();
    let root = project(&tmp);
    let file = root.join(".openidea/settings.toml");
    std::fs::write(&file, SERVER_WITH_VALUE).unwrap();
    let host = host(tmp.path());
    open(&host, &root);
    let servers = ide_host::ops::agent::mcp_list(&host, "main").unwrap();
    assert_eq!(header(&servers, "workspace::remote"), format!("Bearer {VALUE}"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), SERVER_WITH_VALUE, "reading leaves the project file alone");

    // Saving the servers keeps the project's values in the project's file for everyone else.
    let servers = ide_host::ops::agent::mcp_set_enabled(&host, "main", "workspace::remote".into(), false).unwrap();
    assert_eq!(header(&servers, "workspace::remote"), format!("Bearer {VALUE}"));
    assert!(std::fs::read_to_string(&file).unwrap().contains(VALUE));
    assert_eq!(files_containing(&tmp.path().join("data"), VALUE), Vec::<PathBuf>::new());
    host.close_project("main");
}
