//! Configurations of MCP clients (Claude Code, Codex, Cursor, ...) for this server:
//! the snippet Settings › Tools › MCP Server shows, and Auto-Configure, which writes
//! an `openidea` entry into the client's user-level configuration file.

use ide_core::mcp::{McpClientConfig, McpClientKind};
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// The entry name in every client's configuration.
pub const SERVER_NAME: &str = "openidea";

pub const ALL: [McpClientKind; 6] = [
    McpClientKind::ClaudeCode,
    McpClientKind::Codex,
    McpClientKind::Cursor,
    McpClientKind::VsCode,
    McpClientKind::Windsurf,
    McpClientKind::Gemini,
];

/// Where a JSON client keeps its servers and how one entry looks.
struct JsonShape {
    /// The object holding the servers (`mcpServers`, `servers`).
    key: &'static str,
    entry: fn(&str, &str) -> Value,
}

fn bearer(token: &str) -> Value {
    json!({ "Authorization": format!("Bearer {token}") })
}

fn json_shape(kind: McpClientKind) -> Option<JsonShape> {
    Some(match kind {
        McpClientKind::ClaudeCode => JsonShape {
            key: "mcpServers",
            entry: |url, token| json!({ "type": "http", "url": url, "headers": bearer(token) }),
        },
        McpClientKind::Cursor => {
            JsonShape { key: "mcpServers", entry: |url, token| json!({ "url": url, "headers": bearer(token) }) }
        }
        McpClientKind::VsCode => JsonShape {
            key: "servers",
            entry: |url, token| json!({ "type": "http", "url": url, "headers": bearer(token) }),
        },
        McpClientKind::Windsurf => {
            JsonShape { key: "mcpServers", entry: |url, token| json!({ "serverUrl": url, "headers": bearer(token) }) }
        }
        McpClientKind::Gemini => {
            JsonShape { key: "mcpServers", entry: |url, token| json!({ "httpUrl": url, "headers": bearer(token) }) }
        }
        McpClientKind::Codex => return None,
    })
}

/// The client's user-level configuration file under `home`.
pub fn config_file(kind: McpClientKind, home: &Path) -> PathBuf {
    match kind {
        McpClientKind::ClaudeCode => home.join(".claude.json"),
        McpClientKind::Codex => home.join(".codex").join("config.toml"),
        McpClientKind::Cursor => home.join(".cursor").join("mcp.json"),
        McpClientKind::VsCode => vscode_user_dir(home).join("mcp.json"),
        McpClientKind::Windsurf => home.join(".codeium").join("windsurf").join("mcp_config.json"),
        McpClientKind::Gemini => home.join(".gemini").join("settings.json"),
    }
}

fn vscode_user_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Code/User")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming")).join("Code/User")
    } else {
        home.join(".config/Code/User")
    }
}

fn codex_snippet(url: &str, token: &str) -> String {
    format!("[mcp_servers.{SERVER_NAME}]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"Bearer {token}\" }}\n")
}

/// What the settings page shows for `kind`.
pub fn config(kind: McpClientKind, url: &str, token: &str, home: &Path) -> McpClientConfig {
    let file = config_file(kind, home);
    let (snippet, format) = match json_shape(kind) {
        Some(shape) => {
            let mut servers = Map::new();
            servers.insert(SERVER_NAME.into(), (shape.entry)(url, token));
            let mut root = Map::new();
            root.insert(shape.key.into(), Value::Object(servers));
            (serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default(), "json")
        }
        None => (codex_snippet(url, token), "toml"),
    };
    let snippet = match kind {
        // The CLI is the documented way; the JSON goes into ~/.claude.json.
        McpClientKind::ClaudeCode => format!(
            "claude mcp add --scope user --transport http {SERVER_NAME} {url} --header \"Authorization: Bearer {token}\""
        ),
        _ => snippet,
    };
    let format = if kind == McpClientKind::ClaudeCode { "shell" } else { format };
    let state = read_state(kind, &file, url, token);
    McpClientConfig {
        client: kind,
        file: Some(file.into()),
        snippet,
        format: format.into(),
        configured: state == State::Current,
        can_write: state != State::Unwritable,
    }
}

#[derive(PartialEq, Eq, Debug)]
enum State {
    /// An `openidea` entry with this URL and token.
    Current,
    /// No entry, or an outdated one.
    Missing,
    /// The file exists but cannot be rewritten safely (comments, invalid).
    Unwritable,
}

fn read_state(kind: McpClientKind, file: &Path, url: &str, token: &str) -> State {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return State::Missing,
        Err(_) => return State::Unwritable,
    };
    match json_shape(kind) {
        Some(shape) => {
            if text.trim().is_empty() {
                return State::Missing;
            }
            let Ok(root) = serde_json::from_str::<Value>(&text) else { return State::Unwritable };
            if !root.is_object() {
                return State::Unwritable;
            }
            match root.get(shape.key).and_then(|s| s.get(SERVER_NAME)) {
                Some(entry) if *entry == (shape.entry)(url, token) => State::Current,
                _ => State::Missing,
            }
        }
        None => {
            let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else { return State::Unwritable };
            let entry = doc.get("mcp_servers").and_then(|s| s.get(SERVER_NAME));
            let url_ok = entry.and_then(|e| e.get("url")).and_then(|u| u.as_str()) == Some(url);
            let auth = format!("Bearer {token}");
            let token_ok =
                entry.and_then(|e| e.get("http_headers")).and_then(|h| h.get("Authorization")).and_then(|a| a.as_str())
                    == Some(auth.as_str());
            if url_ok && token_ok { State::Current } else { State::Missing }
        }
    }
}

/// Writes (or updates) the `openidea` entry in `kind`'s configuration file,
/// keeping everything else in it.
pub fn configure(kind: McpClientKind, url: &str, token: &str, home: &Path) -> IdeResult<PathBuf> {
    let file = config_file(kind, home);
    let existing = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(IdeError::from(e)),
    };
    let text = match json_shape(kind) {
        Some(shape) => {
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
            let servers = obj.entry(shape.key).or_insert_with(|| json!({}));
            let Some(servers) = servers.as_object_mut() else {
                return Err(IdeError::invalid(format!("`{}` in {} is not an object", shape.key, file.display())));
            };
            servers.insert(SERVER_NAME.into(), (shape.entry)(url, token));
            let mut text = serde_json::to_string_pretty(&root).map_err(|e| IdeError::internal(e.to_string()))?;
            text.push('\n');
            text
        }
        None => {
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
            entry.insert("url", toml_edit::value(url));
            let mut headers = toml_edit::InlineTable::new();
            headers.insert("Authorization", format!("Bearer {token}").into());
            entry.insert("http_headers", toml_edit::value(headers));
            servers.insert(SERVER_NAME, toml_edit::Item::Table(entry));
            doc.to_string()
        }
    };
    write_atomically(&file, &text)?;
    Ok(file)
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
    if let Err(e) = written.and_then(|()| std::fs::rename(&tmp, &file)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:64352/mcp";

    #[test]
    fn writes_json_clients_keeping_other_entries() {
        let home = tempfile::tempdir().unwrap();
        let file = config_file(McpClientKind::Cursor, home.path());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"mcpServers":{"other":{"command":"x"}},"keep":1}"#).unwrap();
        assert!(!config(McpClientKind::Cursor, URL, "t1", home.path()).configured);
        configure(McpClientKind::Cursor, URL, "t1", home.path()).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["keep"], 1);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["openidea"]["url"], URL);
        assert_eq!(v["mcpServers"]["openidea"]["headers"]["Authorization"], "Bearer t1");
        assert!(config(McpClientKind::Cursor, URL, "t1", home.path()).configured);
        // A new token makes the entry outdated.
        assert!(!config(McpClientKind::Cursor, URL, "t2", home.path()).configured);
    }

    #[test]
    fn creates_missing_files_and_refuses_jsonc() {
        let home = tempfile::tempdir().unwrap();
        configure(McpClientKind::ClaudeCode, URL, "t", home.path()).unwrap();
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(home.path().join(".claude.json")).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["openidea"]["type"], "http");

        let file = config_file(McpClientKind::VsCode, home.path());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "// my servers\n{ \"servers\": {} }").unwrap();
        let c = config(McpClientKind::VsCode, URL, "t", home.path());
        assert!(!c.can_write && !c.configured);
        assert!(configure(McpClientKind::VsCode, URL, "t", home.path()).is_err());
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("// my servers"));
    }

    #[test]
    fn writes_codex_toml_keeping_comments() {
        let home = tempfile::tempdir().unwrap();
        let file = config_file(McpClientKind::Codex, home.path());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "# mine\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"y\"\n").unwrap();
        configure(McpClientKind::Codex, URL, "tok", home.path()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("# mine\nmodel = \"x\""), "{text}");
        assert!(text.contains("[mcp_servers.other]"), "{text}");
        assert!(text.contains("[mcp_servers.openidea]"), "{text}");
        assert!(config(McpClientKind::Codex, URL, "tok", home.path()).configured);
        // Re-running replaces rather than duplicates.
        configure(McpClientKind::Codex, URL, "tok2", home.path()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches("[mcp_servers.openidea]").count(), 1, "{text}");
        assert!(text.contains("Bearer tok2"));
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_private_and_symlinks_kept() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        configure(McpClientKind::Cursor, URL, "t", home.path()).unwrap();
        let file = config_file(McpClientKind::Cursor, home.path());
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o077, 0);

        let real = home.path().join("dotfiles-gemini.json");
        std::fs::write(&real, "{}").unwrap();
        let link = config_file(McpClientKind::Gemini, home.path());
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        configure(McpClientKind::Gemini, URL, "t", home.path()).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(std::fs::read_to_string(&real).unwrap().contains("openidea"));
    }

    #[test]
    fn snippets_parse() {
        let home = tempfile::tempdir().unwrap();
        for kind in ALL {
            let c = config(kind, URL, "t", home.path());
            match c.format.as_str() {
                "json" => {
                    serde_json::from_str::<Value>(&c.snippet).unwrap();
                }
                "toml" => {
                    c.snippet.parse::<toml_edit::DocumentMut>().unwrap();
                }
                "shell" => assert!(c.snippet.starts_with("claude mcp add")),
                f => panic!("unknown format {f}"),
            }
            assert!(c.snippet.contains("Bearer t"));
        }
    }
}
