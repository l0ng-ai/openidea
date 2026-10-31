// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/clients/), Apache-2.0.
//! Configurations of MCP clients (Claude Code, Codex, Cursor, ...) for this server:
//! the snippet Settings › Tools › MCP Server shows, Auto-Configure, which writes an
//! `openidea` entry into the client's configuration file, and [`detect`], which finds
//! installed clients and entries that point at a stale port.
//!
//! Network clients get the streamable HTTP endpoint with the bearer token; clients
//! without HTTP support (Claude Desktop) start `openidea mcp-stdio` ([`crate::stdio`]).

mod detect;

pub use detect::detect;

use ide_core::mcp::{McpClientConfig, McpClientKind};
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// The entry name in every client's configuration.
pub const SERVER_NAME: &str = "openidea";
/// The entry name of development builds: their data directory, and so their token,
/// differ from the installed app's (JetBrains appends `dev` when running from sources).
pub const DEV_SERVER_NAME: &str = "openidea-dev";

pub const ALL: [McpClientKind; 11] = [
    McpClientKind::ClaudeCode,
    McpClientKind::ClaudeDesktop,
    McpClientKind::Codex,
    McpClientKind::Cursor,
    McpClientKind::VsCode,
    McpClientKind::Windsurf,
    McpClientKind::Gemini,
    McpClientKind::Junie,
    McpClientKind::Air,
    McpClientKind::GitHubCopilotCli,
    McpClientKind::GitHubCopilotIdePlugin,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

/// Where per-user configuration lives: the home directory and the environment
/// variables clients honour. Explicit so tests can use a temporary home on any OS layout.
#[derive(Clone, Debug)]
pub struct Paths {
    pub os: Os,
    pub home: PathBuf,
    /// `%APPDATA%`.
    pub app_data: Option<PathBuf>,
    /// `%LOCALAPPDATA%`.
    pub local_app_data: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// `$COPILOT_HOME` (GitHub Copilot CLI).
    pub copilot_home: Option<PathBuf>,
    /// `$CODEX_HOME` (where Codex keeps its skills).
    pub codex_home: Option<PathBuf>,
}

impl Paths {
    /// This machine's layout.
    pub fn system(home: PathBuf) -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        Self {
            os: if cfg!(target_os = "macos") {
                Os::Mac
            } else if cfg!(windows) {
                Os::Windows
            } else {
                Os::Linux
            },
            home,
            app_data: var("APPDATA"),
            local_app_data: var("LOCALAPPDATA"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
            copilot_home: var("COPILOT_HOME"),
            codex_home: var("CODEX_HOME"),
        }
    }

    /// `home` laid out as on `os`, with no environment overrides.
    pub fn under(home: &Path, os: Os) -> Self {
        Self {
            os,
            home: home.to_path_buf(),
            app_data: None,
            local_app_data: None,
            xdg_config_home: None,
            copilot_home: None,
            codex_home: None,
        }
    }

    fn app_data(&self) -> PathBuf {
        self.app_data.clone().unwrap_or_else(|| self.home.join("AppData").join("Roaming"))
    }

    fn local_app_data(&self) -> PathBuf {
        self.local_app_data.clone().unwrap_or_else(|| self.home.join("AppData").join("Local"))
    }

    fn xdg_config(&self) -> PathBuf {
        self.xdg_config_home.clone().unwrap_or_else(|| self.home.join(".config"))
    }

    /// The per-OS application data directory of `app` (`Claude`, `Code/User`, ...).
    fn app_dir(&self, app: &str) -> PathBuf {
        match self.os {
            Os::Mac => self.home.join("Library").join("Application Support").join(app),
            Os::Windows => self.app_data().join(app),
            Os::Linux => self.home.join(".config").join(app),
        }
    }
}

/// This server, as clients reach it.
#[derive(Clone, Debug)]
pub struct Server {
    pub port: u16,
    pub token: String,
    /// The entry name ([`SERVER_NAME`] or [`DEV_SERVER_NAME`]).
    pub name: String,
    /// The OpenIDEA executable stdio clients start with `mcp-stdio`.
    pub command: PathBuf,
    /// The token file the stdio bridge reads (the token is not copied into the config).
    pub token_file: PathBuf,
}

impl Server {
    pub fn url(&self) -> String {
        crate::endpoint_url(self.port)
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

/// How a client's configuration file is laid out.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    /// JSON with the servers under `key` (`mcpServers`, `servers`).
    Json { key: &'static str },
    /// Codex's TOML (`[mcp_servers.<name>]`).
    Toml,
}

fn format(kind: McpClientKind) -> Format {
    match kind {
        McpClientKind::Codex => Format::Toml,
        McpClientKind::VsCode | McpClientKind::GitHubCopilotIdePlugin => Format::Json { key: "servers" },
        _ => Format::Json { key: "mcpServers" },
    }
}

/// The JSON entry for this server in `kind`'s configuration.
fn json_entry(kind: McpClientKind, server: &Server) -> Value {
    let url = server.url();
    let headers = json!({ "Authorization": server.authorization() });
    match kind {
        McpClientKind::ClaudeDesktop => json!({
            "command": server.command,
            "args": [crate::stdio::SUBCOMMAND],
            "env": {
                crate::stdio::PORT_ENV: server.port.to_string(),
                crate::stdio::TOKEN_FILE_ENV: server.token_file,
            },
        }),
        McpClientKind::Windsurf => json!({ "serverUrl": url, "type": "http", "headers": headers }),
        McpClientKind::Gemini => json!({ "httpUrl": url, "headers": headers }),
        _ => json!({ "type": "http", "url": url, "headers": headers }),
    }
}

fn codex_snippet(server: &Server) -> String {
    format!(
        "[mcp_servers.{}]\nurl = \"{}\"\nhttp_headers = {{ Authorization = \"{}\" }}\n",
        server.name,
        server.url(),
        server.authorization()
    )
}

/// The client's user-level configuration file.
pub fn config_file(kind: McpClientKind, paths: &Paths) -> PathBuf {
    let home = &paths.home;
    match kind {
        McpClientKind::ClaudeCode => home.join(".claude.json"),
        McpClientKind::ClaudeDesktop => paths.app_dir("Claude").join("claude_desktop_config.json"),
        McpClientKind::Codex => codex_file(paths),
        McpClientKind::Cursor => home.join(".cursor").join("mcp.json"),
        McpClientKind::VsCode => paths.app_dir("Code").join("User").join("mcp.json"),
        McpClientKind::Windsurf => home.join(".codeium").join("windsurf").join("mcp_config.json"),
        McpClientKind::Gemini => home.join(".gemini").join("settings.json"),
        McpClientKind::Junie => home.join(".junie").join("mcp").join("mcp.json"),
        McpClientKind::Air => match paths.os {
            Os::Linux => paths.xdg_config().join("JetBrains").join("Air").join("mcp.json"),
            _ => paths.app_dir("JetBrains").join("Air").join("mcp.json"),
        },
        McpClientKind::GitHubCopilotCli => {
            paths.copilot_home.clone().unwrap_or_else(|| home.join(".copilot")).join("mcp-config.json")
        }
        McpClientKind::GitHubCopilotIdePlugin => match paths.os {
            Os::Windows => paths.local_app_data().join("github-copilot").join("intellij").join("mcp.json"),
            _ => home.join(".config").join("github-copilot").join("intellij").join("mcp.json"),
        },
    }
}

/// Where Codex may keep its configuration, most preferred first.
fn codex_candidates(paths: &Paths) -> Vec<PathBuf> {
    let mut candidates = vec![paths.home.join(".codex").join("config.toml")];
    match paths.os {
        Os::Mac => candidates.push(paths.app_dir("Codex").join("config.toml")),
        Os::Linux => candidates.push(paths.home.join(".config").join("codex").join("config.toml")),
        Os::Windows => candidates.push(paths.app_data().join("Codex").join("config.toml")),
    }
    candidates
}

/// The candidate that exists, else the one whose directory exists, else `~/.codex/config.toml`.
fn codex_file(paths: &Paths) -> PathBuf {
    let candidates = codex_candidates(paths);
    candidates
        .iter()
        .find(|p| p.is_file())
        .or_else(|| candidates.iter().find(|p| p.parent().is_some_and(Path::is_dir)))
        .unwrap_or(&candidates[0])
        .clone()
}

/// The client's configuration file inside project `root`, for clients that have one.
pub fn project_config_file(kind: McpClientKind, root: &Path) -> Option<PathBuf> {
    Some(match kind {
        McpClientKind::ClaudeCode => root.join(".mcp.json"),
        McpClientKind::Codex => root.join(".codex").join("config.toml"),
        McpClientKind::Cursor => root.join(".cursor").join("mcp.json"),
        McpClientKind::VsCode => root.join(".vscode").join("mcp.json"),
        McpClientKind::Gemini => root.join(".gemini").join("settings.json"),
        McpClientKind::Junie => root.join(".junie").join("mcp").join("mcp.json"),
        McpClientKind::Air => root.join(".air").join("mcp.json"),
        McpClientKind::GitHubCopilotCli => {
            let candidates = [root.join(".github").join("mcp.json"), root.join("mcp.json")];
            let found = candidates.iter().find(|p| detect::looks_like_config(McpClientKind::GitHubCopilotCli, p));
            found.unwrap_or(&candidates[0]).clone()
        }
        McpClientKind::ClaudeDesktop | McpClientKind::Windsurf | McpClientKind::GitHubCopilotIdePlugin => {
            return None;
        }
    })
}

/// What the settings page shows for `kind`.
pub fn config(kind: McpClientKind, server: &Server, paths: &Paths) -> McpClientConfig {
    let file = config_file(kind, paths);
    let (snippet, format_name) = match format(kind) {
        _ if kind == McpClientKind::ClaudeCode => (
            // The CLI is the documented way; the JSON goes into ~/.claude.json.
            format!(
                "claude mcp add --scope user --transport http {} {} --header \"Authorization: {}\"",
                server.name,
                server.url(),
                server.authorization()
            ),
            "shell",
        ),
        Format::Json { key } => {
            let mut servers = Map::new();
            servers.insert(server.name.clone(), json_entry(kind, server));
            let mut root = Map::new();
            root.insert(key.into(), Value::Object(servers));
            (serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default(), "json")
        }
        Format::Toml => (codex_snippet(server), "toml"),
    };
    let state = read_state(kind, &file, server);
    McpClientConfig {
        client: kind,
        file: Some(file.into()),
        snippet,
        format: format_name.into(),
        configured: state == State::Current,
        can_write: state != State::Unwritable,
    }
}

#[derive(PartialEq, Eq, Debug)]
enum State {
    /// The server's entry with this URL and token.
    Current,
    /// No entry, or an outdated one.
    Missing,
    /// The file exists but cannot be rewritten safely (comments, invalid).
    Unwritable,
}

fn read_state(kind: McpClientKind, file: &Path, server: &Server) -> State {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return State::Missing,
        Err(_) => return State::Unwritable,
    };
    if text.trim().is_empty() {
        return State::Missing;
    }
    let writable = match format(kind) {
        Format::Json { .. } => serde_json::from_str::<Value>(&text).is_ok_and(|v| v.is_object()),
        Format::Toml => text.parse::<toml_edit::DocumentMut>().is_ok(),
    };
    if !writable {
        return State::Unwritable;
    }
    let servers = detect::parse_servers(kind, &text).unwrap_or_default();
    match servers.iter().find(|(name, _)| *name == server.name) {
        Some((_, entry)) if detect::is_current(kind, entry, server) => State::Current,
        _ => State::Missing,
    }
}

/// Writes (or updates) the server's entry in `kind`'s user configuration file,
/// keeping everything else in it.
pub fn configure(kind: McpClientKind, server: &Server, paths: &Paths) -> IdeResult<PathBuf> {
    let file = config_file(kind, paths);
    configure_file(kind, &file, server)?;
    Ok(file)
}

/// Writes the server's entry into `kind`'s configuration inside project `root`.
pub fn configure_project(kind: McpClientKind, server: &Server, root: &Path) -> IdeResult<PathBuf> {
    let file = project_config_file(kind, root)
        .ok_or_else(|| IdeError::invalid(format!("{kind:?} has no project-level configuration")))?;
    configure_file(kind, &file, server)?;
    Ok(file)
}

fn configure_file(kind: McpClientKind, file: &Path, server: &Server) -> IdeResult<()> {
    let existing = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(IdeError::from(e)),
    };
    let text = match format(kind) {
        Format::Json { key } => {
            let mut root: Value = if existing.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&existing).map_err(|e| {
                    IdeError::invalid(format!("{} is not plain JSON ({e}); add the entry by hand", file.display()))
                })?
            };
            let Some(obj) = root.as_object_mut() else {
                return Err(IdeError::invalid(format!("{} does not hold a JSON object", file.display())));
            };
            let servers = obj.entry(key).or_insert_with(|| json!({}));
            let Some(servers) = servers.as_object_mut() else {
                return Err(IdeError::invalid(format!("`{key}` in {} is not an object", file.display())));
            };
            servers.insert(server.name.clone(), json_entry(kind, server));
            let mut text = serde_json::to_string_pretty(&root).map_err(|e| IdeError::internal(e.to_string()))?;
            text.push('\n');
            text
        }
        Format::Toml => {
            let mut doc: toml_edit::DocumentMut = existing
                .parse()
                .map_err(|e| IdeError::invalid(format!("{} is not valid TOML: {e}", file.display())))?;
            let servers = doc.entry("mcp_servers").or_insert_with(|| {
                let mut t = toml_edit::Table::new();
                t.set_implicit(true);
                toml_edit::Item::Table(t)
            });
            let Some(servers) = servers.as_table_like_mut() else {
                return Err(IdeError::invalid(format!("`mcp_servers` in {} is not a table", file.display())));
            };
            let mut entry = toml_edit::Table::new();
            entry.insert("url", toml_edit::value(server.url()));
            let mut headers = toml_edit::InlineTable::new();
            headers.insert("Authorization", server.authorization().into());
            entry.insert("http_headers", toml_edit::value(headers));
            servers.insert(&server.name, toml_edit::Item::Table(entry));
            let mut text = doc.to_string();
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text
        }
    };
    write_atomically(file, &text)
}

/// Replaces `file` (the target of a symlinked dotfile) through a temporary file that is
/// never readable by others: the text holds the token.
fn write_atomically(file: &Path, text: &str) -> IdeResult<()> {
    let file = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension(format!("openidea-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // The original's mode without group / other access; 0600 for a new file.
        let mode = std::fs::metadata(&file).map(|m| m.permissions().mode() & 0o700).unwrap_or(0o600);
        options.mode(mode | 0o600);
    }
    let written = options.open(&tmp).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
    let replaced = written.and_then(|()| std::fs::rename(&tmp, &file));
    // A client holding the file open blocks the swap on Windows: write it in place (as JetBrains does).
    #[cfg(windows)]
    let replaced = match replaced {
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && file.exists() => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(&file, text)
        }
        r => r,
    };
    if let Err(e) = replaced {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
