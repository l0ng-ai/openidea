//! External MCP servers in Settings › Agents, as the host stores and lists them.

use ide_agent::{McpScope, McpServer, McpServerInput};
use ide_core::NullSink;
use ide_core::settings::McpTransport;
use ide_host::ops::agent::{mcp_import, mcp_list, mcp_save, mcp_set_enabled};
use ide_host::{Host, HostConfig};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn open(base: &Path) -> (Arc<Host>, PathBuf) {
    let root = dunce::canonicalize(base).unwrap().join("project");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    (host, root)
}

fn enabled(list: &[McpServer], id: &str) -> bool {
    list.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("{id} not listed: {list:?}")).enabled
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_servers_from_the_project_file_stay_off_until_the_user_turns_them_on() {
    let tmp = tempfile::tempdir().unwrap();
    let (host, root) = open(tmp.path());
    let settings_file = root.join(".openidea/settings.toml");
    std::fs::write(&settings_file, "[agents.mcpServers.helper]\ncommand = \"node\"\nargs = [\"helper.js\"]\n").unwrap();
    host.project("main").unwrap().settings.reload();

    assert!(!enabled(&mcp_list(&host, "main").unwrap(), "workspace::helper"));
    assert!(enabled(&mcp_set_enabled(&host, "main", "workspace::helper".into(), true).unwrap(), "workspace::helper"));
    assert!(enabled(&mcp_list(&host, "main").unwrap(), "workspace::helper"));

    // A changed definition is off again until turned back on.
    std::fs::write(&settings_file, "[agents.mcpServers.helper]\ncommand = \"node\"\nargs = [\"other.js\"]\n").unwrap();
    host.project("main").unwrap().settings.reload();
    assert!(!enabled(&mcp_list(&host, "main").unwrap(), "workspace::helper"));

    // What the user adds in Settings is on.
    let saved = mcp_save(
        &host,
        "main",
        McpServerInput {
            id: None,
            name: "mine".into(),
            scope: McpScope::Workspace,
            transport: McpTransport::Stdio,
            enabled: true,
            command: Some("uvx".into()),
            args: vec!["mcp-server-git".into()],
            env: vec![],
            url: None,
            headers: vec![],
            agents: vec![],
        },
    )
    .unwrap();
    assert!(enabled(&saved, "workspace::mine"));

    // Imported servers come from the project's own files: off until turned on.
    std::fs::write(root.join(".mcp.json"), r#"{"mcpServers":{"imported":{"command":"uvx","args":["x"]}}}"#).unwrap();
    let imported = mcp_import(&host, "main").unwrap();
    assert!(!enabled(&imported, "workspace::imported"));
    assert!(enabled(&imported, "workspace::mine"));
}
