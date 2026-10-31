use super::*;
use ide_core::mcp::{McpDetectedClient, McpTransport};

const PORT: u16 = 64352;
const URL: &str = "http://127.0.0.1:64352/mcp";

fn server(token: &str) -> Server {
    Server {
        port: PORT,
        token: token.into(),
        name: SERVER_NAME.into(),
        command: PathBuf::from("/Applications/OpenIDEA.app/Contents/MacOS/openidea"),
        token_file: PathBuf::from("/data/mcp-token"),
    }
}

fn mac(home: &Path) -> Paths {
    Paths::under(home, Os::Mac)
}

fn write(file: &Path, text: &str) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn read_json(file: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

#[test]
fn config_files_per_os() {
    let home = Path::new("/h");
    let file = |kind, os| config_file(kind, &Paths::under(home, os));
    use McpClientKind::*;
    assert_eq!(
        file(ClaudeDesktop, Os::Mac),
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    );
    assert_eq!(file(ClaudeDesktop, Os::Linux), home.join(".config/Claude/claude_desktop_config.json"));
    assert_eq!(file(ClaudeDesktop, Os::Windows), home.join("AppData/Roaming/Claude/claude_desktop_config.json"));
    assert_eq!(file(VsCode, Os::Mac), home.join("Library/Application Support/Code/User/mcp.json"));
    assert_eq!(file(VsCode, Os::Linux), home.join(".config/Code/User/mcp.json"));
    assert_eq!(file(Air, Os::Mac), home.join("Library/Application Support/JetBrains/Air/mcp.json"));
    assert_eq!(file(Air, Os::Linux), home.join(".config/JetBrains/Air/mcp.json"));
    assert_eq!(file(GitHubCopilotIdePlugin, Os::Mac), home.join(".config/github-copilot/intellij/mcp.json"));
    assert_eq!(file(GitHubCopilotIdePlugin, Os::Windows), home.join("AppData/Local/github-copilot/intellij/mcp.json"));
    assert_eq!(file(GitHubCopilotCli, Os::Linux), home.join(".copilot/mcp-config.json"));
    assert_eq!(file(Junie, Os::Linux), home.join(".junie/mcp/mcp.json"));
    assert_eq!(file(Codex, Os::Linux), home.join(".codex/config.toml"));

    let mut paths = Paths::under(home, Os::Linux);
    paths.xdg_config_home = Some("/xdg".into());
    paths.copilot_home = Some("/copilot".into());
    assert_eq!(config_file(Air, &paths), Path::new("/xdg/JetBrains/Air/mcp.json"));
    assert_eq!(config_file(GitHubCopilotCli, &paths), Path::new("/copilot/mcp-config.json"));
    let mut paths = Paths::under(home, Os::Windows);
    paths.app_data = Some("C:/AppData".into());
    assert_eq!(config_file(VsCode, &paths), Path::new("C:/AppData/Code/User/mcp.json"));
}

#[test]
fn codex_prefers_an_existing_config() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    assert_eq!(config_file(McpClientKind::Codex, &paths), home.path().join(".codex/config.toml"));
    // Only the Application Support directory exists: it is used.
    let alt = home.path().join("Library/Application Support/Codex");
    std::fs::create_dir_all(&alt).unwrap();
    assert_eq!(config_file(McpClientKind::Codex, &paths), alt.join("config.toml"));
    // An existing file wins over an existing directory.
    write(&home.path().join(".codex/config.toml"), "");
    std::fs::remove_dir_all(&alt).unwrap();
    write(&alt.join("config.toml"), "");
    assert_eq!(config_file(McpClientKind::Codex, &paths), home.path().join(".codex/config.toml"));
}

#[test]
fn entry_shapes() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    let s = server("t");
    for kind in ALL {
        configure(kind, &s, &paths).unwrap();
        assert!(config(kind, &s, &paths).configured, "{kind:?}");
    }
    let servers = |kind, key: &str| read_json(&config_file(kind, &paths))[key][SERVER_NAME].clone();
    let http = json!({ "type": "http", "url": URL, "headers": { "Authorization": "Bearer t" } });
    for kind in [McpClientKind::ClaudeCode, McpClientKind::Cursor, McpClientKind::Junie, McpClientKind::Air] {
        assert_eq!(servers(kind, "mcpServers"), http, "{kind:?}");
    }
    assert_eq!(servers(McpClientKind::GitHubCopilotCli, "mcpServers"), http);
    assert_eq!(servers(McpClientKind::VsCode, "servers"), http);
    assert_eq!(servers(McpClientKind::GitHubCopilotIdePlugin, "servers"), http);
    assert_eq!(
        servers(McpClientKind::Windsurf, "mcpServers"),
        json!({ "type": "http", "serverUrl": URL, "headers": { "Authorization": "Bearer t" } })
    );
    assert_eq!(
        servers(McpClientKind::Gemini, "mcpServers"),
        json!({ "httpUrl": URL, "headers": { "Authorization": "Bearer t" } })
    );
    // Claude Desktop starts the stdio bridge; the token stays in its file.
    assert_eq!(
        servers(McpClientKind::ClaudeDesktop, "mcpServers"),
        json!({
            "command": "/Applications/OpenIDEA.app/Contents/MacOS/openidea",
            "args": ["mcp-stdio"],
            "env": { "OPENIDEA_MCP_PORT": "64352", "OPENIDEA_MCP_TOKEN_FILE": "/data/mcp-token" },
        })
    );
    // The bridge does not depend on the token: regenerating it keeps Claude Desktop current.
    assert!(config(McpClientKind::ClaudeDesktop, &server("other"), &paths).configured);
    assert!(!config(McpClientKind::Cursor, &server("other"), &paths).configured);
}

#[test]
fn development_builds_use_their_own_entry() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    configure(McpClientKind::Cursor, &server("release"), &paths).unwrap();
    let dev = Server { name: DEV_SERVER_NAME.into(), token: "dev".into(), ..server("dev") };
    configure(McpClientKind::Cursor, &dev, &paths).unwrap();
    let v = read_json(&config_file(McpClientKind::Cursor, &paths));
    assert_eq!(v["mcpServers"]["openidea"]["headers"]["Authorization"], "Bearer release");
    assert_eq!(v["mcpServers"]["openidea-dev"]["headers"]["Authorization"], "Bearer dev");
}

#[test]
fn writes_json_clients_keeping_other_entries() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    let file = config_file(McpClientKind::Cursor, &paths);
    write(&file, r#"{"mcpServers":{"other":{"command":"x"}},"keep":1}"#);
    assert!(!config(McpClientKind::Cursor, &server("t1"), &paths).configured);
    configure(McpClientKind::Cursor, &server("t1"), &paths).unwrap();
    let v = read_json(&file);
    assert_eq!(v["keep"], 1);
    assert_eq!(v["mcpServers"]["other"]["command"], "x");
    assert_eq!(v["mcpServers"]["openidea"]["url"], URL);
    assert!(config(McpClientKind::Cursor, &server("t1"), &paths).configured);
    // A new token makes the entry outdated.
    assert!(!config(McpClientKind::Cursor, &server("t2"), &paths).configured);
}

#[test]
fn creates_missing_files_and_refuses_jsonc() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    configure(McpClientKind::ClaudeCode, &server("t"), &paths).unwrap();
    assert_eq!(read_json(&home.path().join(".claude.json"))["mcpServers"]["openidea"]["type"], "http");

    let file = config_file(McpClientKind::VsCode, &paths);
    write(&file, "// my servers\n{ \"servers\": {} }");
    let c = config(McpClientKind::VsCode, &server("t"), &paths);
    assert!(!c.can_write && !c.configured);
    assert!(configure(McpClientKind::VsCode, &server("t"), &paths).is_err());
    assert!(std::fs::read_to_string(&file).unwrap().starts_with("// my servers"));
}

#[test]
fn writes_codex_toml_keeping_comments() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    let file = home.path().join(".codex/config.toml");
    write(&file, "# mine\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"y\"\n");
    configure(McpClientKind::Codex, &server("tok"), &paths).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("# mine\nmodel = \"x\""), "{text}");
    assert!(text.contains("[mcp_servers.other]"), "{text}");
    assert!(text.contains("[mcp_servers.openidea]"), "{text}");
    assert!(config(McpClientKind::Codex, &server("tok"), &paths).configured);
    // Re-running replaces rather than duplicates.
    configure(McpClientKind::Codex, &server("tok2"), &paths).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(text.matches("[mcp_servers.openidea]").count(), 1, "{text}");
    assert!(text.contains("Bearer tok2"));
}

#[test]
fn configures_project_files() {
    let project = tempfile::tempdir().unwrap();
    let root = project.path();
    let file = configure_project(McpClientKind::ClaudeCode, &server("t"), root).unwrap();
    assert_eq!(file, root.join(".mcp.json"));
    assert_eq!(read_json(&file)["mcpServers"]["openidea"]["args"], json!(["mcp-stdio"]));
    // Copilot CLI: `.github/mcp.json`, unless the root's mcp.json is the one in use.
    write(&root.join("mcp.json"), r#"{"mcpServers":{}}"#);
    assert_eq!(configure_project(McpClientKind::GitHubCopilotCli, &server("t"), root).unwrap(), root.join("mcp.json"));
    assert!(configure_project(McpClientKind::ClaudeDesktop, &server("t"), root).is_err());
}

#[cfg(unix)]
#[test]
fn written_files_are_private_and_symlinks_kept() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    configure(McpClientKind::Cursor, &server("t"), &paths).unwrap();
    let file = config_file(McpClientKind::Cursor, &paths);
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);

    let real = home.path().join("dotfiles-gemini.json");
    std::fs::write(&real, "{}").unwrap();
    let link = config_file(McpClientKind::Gemini, &paths);
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    configure(McpClientKind::Gemini, &server("t"), &paths).unwrap();
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert!(std::fs::read_to_string(&real).unwrap().contains("openidea"));
}

#[test]
fn snippets_parse() {
    let home = tempfile::tempdir().unwrap();
    for kind in ALL {
        let c = config(kind, &server("t"), &mac(home.path()));
        match c.format.as_str() {
            "json" => {
                serde_json::from_str::<Value>(&c.snippet).unwrap();
            }
            "toml" => {
                c.snippet.parse::<toml_edit::DocumentMut>().unwrap();
            }
            f => panic!("unknown format {f}"),
        }
        assert!(!c.snippet.contains("claude mcp add"), "no command line with the token: {kind:?}");
        let expected = if kind == McpClientKind::ClaudeDesktop { "mcp-stdio" } else { "Bearer t" };
        assert!(c.snippet.contains(expected), "{kind:?}");
    }
}

// Detection, after JetBrains' McpClientTest and McpClientTransportDetectionTest.

fn detected(home: &Path, project: Option<&Path>) -> Vec<McpDetectedClient> {
    detect(&server("t"), &mac(home), project)
}

fn one(found: &[McpDetectedClient], kind: McpClientKind) -> &McpDetectedClient {
    found.iter().find(|c| c.client == kind).unwrap_or_else(|| panic!("{kind:?} not detected"))
}

#[test]
fn detects_installed_clients() {
    let home = tempfile::tempdir().unwrap();
    assert!(detected(home.path(), None).is_empty());
    // Directories the clients create on install.
    for dir in [".cursor", ".codeium/windsurf", ".junie/mcp", ".copilot", "Library/Application Support/Claude"] {
        std::fs::create_dir_all(home.path().join(dir)).unwrap();
    }
    // Claude Code and VS Code: their file.
    write(&home.path().join(".claude.json"), "{}");
    std::fs::create_dir_all(home.path().join("Library/Application Support/Code/User")).unwrap();
    let found = detected(home.path(), None);
    let kinds: Vec<_> = found.iter().map(|c| c.client).collect();
    use McpClientKind::*;
    assert_eq!(kinds, vec![Junie, Cursor, ClaudeDesktop, ClaudeCode, Windsurf, GitHubCopilotCli]);
    let c = one(&found, ClaudeCode);
    assert_eq!((c.configured, c.port_correct, c.current), (None, true, false));
}

#[test]
fn reports_configured_current_and_stale_ports() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    configure(McpClientKind::Cursor, &server("t"), &paths).unwrap();
    configure(McpClientKind::ClaudeDesktop, &server("t"), &paths).unwrap();
    let found = detected(home.path(), None);
    for kind in [McpClientKind::Cursor, McpClientKind::ClaudeDesktop] {
        let c = one(&found, kind);
        assert_eq!((c.configured, c.port_correct, c.current), (Some(true), true, true), "{kind:?}");
    }
    assert_eq!(one(&found, McpClientKind::Cursor).transports, vec![McpTransport::Http]);
    assert_eq!(one(&found, McpClientKind::ClaudeDesktop).transports, vec![McpTransport::Stdio]);

    // The server moved to another port: both entries still point here, at a stale port.
    let moved = Server { port: 64400, ..server("t") };
    let found = detect(&moved, &paths, None);
    for kind in [McpClientKind::Cursor, McpClientKind::ClaudeDesktop] {
        let c = one(&found, kind);
        assert_eq!((c.configured, c.port_correct, c.current), (Some(true), false, false), "{kind:?}");
    }
}

#[test]
fn named_entry_decides_the_port_even_when_far_off() {
    let home = tempfile::tempdir().unwrap();
    write(
        &home.path().join(".cursor/mcp.json"),
        r#"{"mcpServers":{"openidea":{"type":"http","url":"http://localhost:61342/mcp"}}}"#,
    );
    let c = one(&detected(home.path(), None), McpClientKind::Cursor).clone();
    assert_eq!((c.configured, c.port_correct), (Some(true), false));
}

#[test]
fn unnamed_loopback_entries_on_a_nearby_port_count() {
    let check = |url: &str| {
        let home = tempfile::tempdir().unwrap();
        let text = json!({ "mcpServers": { "fallback": { "type": "http", "url": url } } }).to_string();
        write(&home.path().join(".cursor/mcp.json"), &text);
        let c = one(&detected(home.path(), None), McpClientKind::Cursor).clone();
        (c.configured, c.port_correct)
    };
    assert_eq!(check("http://localhost:64357/mcp"), (Some(true), false));
    assert_eq!(check("http://127.0.0.1:64357/mcp"), (Some(true), false));
    assert_eq!(check("http://localhost:69352/mcp"), (Some(true), false));
    // Further than 5000 ports, IPv6 loopback, another host or path: not ours to judge.
    assert_eq!(check("http://localhost:69353/mcp"), (Some(true), true));
    assert_eq!(check("http://[::1]:64357/mcp"), (Some(false), true));
    assert_eq!(check("http://192.168.1.20:64357/mcp"), (Some(false), true));
    assert_eq!(check("http://localhost:64342/sse"), (Some(false), true));
    assert_eq!(check("http://localhost:64352/mcp"), (Some(true), true));
}

#[test]
fn reads_jsonc_and_reports_transports() {
    let home = tempfile::tempdir().unwrap();
    write(
        &home.path().join("Library/Application Support/Code/User/mcp.json"),
        r#"{
          // VS Code allows comments
          "servers": {
            "a": { "command": "java", "args": ["MainKt"] },
            "b": { "type": "sse", "url": "http://localhost:8123/sse" },
            "c": { "type": "http", "url": "http://localhost:64352/mcp", },
          },
        }"#,
    );
    let found = detected(home.path(), None);
    let c = one(&found, McpClientKind::VsCode);
    assert_eq!(c.transports, vec![McpTransport::Stdio, McpTransport::Sse, McpTransport::Http]);
    assert_eq!((c.configured, c.port_correct, c.current), (Some(true), true, false));
}

#[test]
fn detects_codex_toml() {
    let home = tempfile::tempdir().unwrap();
    write(
        &home.path().join(".codex/config.toml"),
        "[mcp_servers.openidea]\nurl = \"http://127.0.0.1:60000/mcp\"\n\n[mcp_servers.x]\ncommand = \"y\"\n",
    );
    let found = detected(home.path(), None);
    let c = one(&found, McpClientKind::Codex);
    assert_eq!((c.configured, c.port_correct), (Some(true), false));
    assert_eq!(c.transports, vec![McpTransport::Stdio, McpTransport::Http]);
}

#[test]
fn detects_project_configurations() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let root = project.path();
    write(&root.join(".mcp.json"), r#"{"mcpServers":{"openidea":{"type":"http","url":"http://localhost:64352/mcp"}}}"#);
    write(&root.join(".vscode/mcp.json"), r#"{"servers":{}}"#);
    // Not a server list.
    write(&root.join(".cursor/mcp.json"), "{}");
    let found = detected(home.path(), Some(root));
    let kinds: Vec<_> = found.iter().map(|c| c.client).collect();
    assert_eq!(kinds, vec![McpClientKind::VsCode, McpClientKind::ClaudeCode]);
    let c = one(&found, McpClientKind::ClaudeCode);
    assert_eq!(c.project.clone().map(|p| p.into_path_buf()), Some(root.to_path_buf()));
    assert_eq!((c.configured, c.port_correct), (Some(true), true));
    assert_eq!(one(&found, McpClientKind::VsCode).configured, None);
}

#[test]
fn project_configurations_hold_the_bridge_not_the_token() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let root = project.path();
    let s = server("secret-token");
    let bridge = |extra: Value| {
        let mut entry = json!({
            "command": "/Applications/OpenIDEA.app/Contents/MacOS/openidea",
            "args": ["mcp-stdio"],
            "env": {
                "OPENIDEA_MCP_PORT": "64352",
                "OPENIDEA_MCP_TOKEN_FILE": "/data/mcp-token",
                "OPENIDEA_MCP_PROJECT_PATH": root.to_string_lossy(),
            },
        });
        entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        entry
    };
    use McpClientKind::*;
    for kind in [ClaudeCode, Codex, Cursor, VsCode, Gemini, Junie, Air, GitHubCopilotCli] {
        let file = configure_project(kind, &s, root).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("secret-token") && !text.contains("Bearer"), "{kind:?}: {text}");
        assert!(text.contains("mcp-stdio") && text.contains("OPENIDEA_MCP_TOKEN_FILE"), "{kind:?}: {text}");
        match kind {
            Codex => {}
            VsCode => assert_eq!(read_json(&file)["servers"][SERVER_NAME], bridge(json!({ "type": "stdio" }))),
            GitHubCopilotCli => assert_eq!(
                read_json(&file)["mcpServers"][SERVER_NAME],
                bridge(json!({ "type": "local", "tools": ["*"] }))
            ),
            _ => assert_eq!(read_json(&file)["mcpServers"][SERVER_NAME], bridge(json!({})), "{kind:?}"),
        }
    }
    // Detection takes the bridge entries for configured and current.
    let found = detect(&s, &mac(home.path()), Some(root));
    for kind in [ClaudeCode, Codex, Cursor, VsCode, Gemini, Junie, Air, GitHubCopilotCli] {
        let c = found.iter().find(|c| c.client == kind && c.project.is_some()).unwrap_or_else(|| panic!("{kind:?}"));
        assert_eq!((c.configured, c.port_correct, c.current), (Some(true), true, true), "{kind:?}");
        assert_eq!(c.transports, vec![McpTransport::Stdio], "{kind:?}");
    }
    // Another project's entry is not this one's.
    let elsewhere = detect(&s, &mac(home.path()), Some(home.path()));
    assert!(elsewhere.iter().all(|c| c.project.is_none() || !c.current));
}

#[test]
fn a_current_entry_in_a_jsonc_file_is_configured() {
    let home = tempfile::tempdir().unwrap();
    let paths = mac(home.path());
    let file = config_file(McpClientKind::VsCode, &paths);
    write(
        &file,
        &format!(
            "// my servers\n{{ \"servers\": {{ \"openidea\": {{ \"type\": \"http\", \"url\": \"{URL}\", \
\"headers\": {{ \"Authorization\": \"Bearer t\" }}, }}, }} }}"
        ),
    );
    let c = config(McpClientKind::VsCode, &server("t"), &paths);
    assert!(c.configured && !c.can_write);
    assert!(!config(McpClientKind::VsCode, &server("other"), &paths).configured);
}
