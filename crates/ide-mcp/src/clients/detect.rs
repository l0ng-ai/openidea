// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpClientDetector.kt), Apache-2.0.
//! Finds the MCP clients installed on this machine (and configured in a project) and
//! tells whether their entries reach this server: [`detect`].
//!
//! An entry "points here" when it is a URL on `localhost` / `127.0.0.1` with the
//! `/mcp` path, or a `mcp-stdio` command with `OPENIDEA_MCP_PORT`. Its port is checked
//! separately, so a client configured for an older port is reported, not ignored.

use super::{Format, Paths, Server, config_file, format, project_config_file};
use crate::stdio::{PORT_ENV, SUBCOMMAND, TOKEN_FILE_ENV};
use ide_core::mcp::{McpClientKind, McpDetectedClient, McpTransport};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

/// Entries this far from the expected port, on loopback, are taken for an older
/// configuration of this server (JetBrains' promotion tolerance).
const PORT_TOLERANCE: i64 = 5000;
const ENDPOINT_PATHS: [&str; 2] = ["/mcp", "/mcp/"];

/// One server entry of a client's configuration, whatever its layout.
#[derive(Debug, Default)]
pub(super) struct Entry {
    command: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    /// `url`, `serverUrl` (Windsurf) or `httpUrl` (Gemini).
    url: Option<String>,
    /// `type`: `http`, `sse`, `stdio`.
    kind: Option<String>,
    authorization: Option<String>,
}

impl Entry {
    fn from_json(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let strings = |k: &str| -> HashMap<String, String> {
            v.get(k)
                .and_then(Value::as_object)
                .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
                .unwrap_or_default()
        };
        Entry {
            command: s("command"),
            args: v
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
            env: strings("env"),
            url: s("url").or_else(|| s("serverUrl")).or_else(|| s("httpUrl")),
            kind: s("type"),
            authorization: strings("headers").remove("Authorization"),
        }
    }

    fn from_toml(t: &toml::Table) -> Self {
        let s = |k: &str| t.get(k).and_then(toml::Value::as_str).map(str::to_owned);
        let strings = |k: &str| -> HashMap<String, String> {
            t.get(k)
                .and_then(toml::Value::as_table)
                .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
                .unwrap_or_default()
        };
        let command = s("command");
        Entry {
            kind: Some(if command.is_some() { "stdio" } else { "http" }.into()),
            command,
            args: t
                .get("args")
                .and_then(toml::Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
            env: strings("env"),
            url: s("url").or_else(|| s("serverUrl")),
            authorization: strings("http_headers").remove("Authorization"),
        }
    }

    /// The port of an `openidea mcp-stdio` bridge: `None` for another command or a URL,
    /// `Some(None)` when its port is missing or invalid.
    fn stdio_port(&self) -> Option<Option<i64>> {
        if self.command.is_none() || !self.args.iter().any(|a| a == SUBCOMMAND) {
            return None;
        }
        Some(self.env.get(PORT_ENV).and_then(|p| p.trim().parse().ok()))
    }
}

/// The server entries of a configuration file's text, in file order.
pub(super) fn parse_servers(kind: McpClientKind, text: &str) -> Option<Vec<(String, Entry)>> {
    match format(kind) {
        Format::Toml => {
            let doc: toml::Table = text.parse().ok()?;
            let servers = doc.get("mcp_servers")?.as_table()?;
            Some(
                servers
                    .iter()
                    .filter(|(name, _)| !name.trim().is_empty())
                    .filter_map(|(name, v)| Some((name.trim().to_owned(), Entry::from_toml(v.as_table()?))))
                    .collect(),
            )
        }
        Format::Json { key } => {
            // Clients accept comments and trailing commas (VS Code); reading does too.
            let root: Value = serde_json::from_str(text).or_else(|_| serde_json::from_str(&strip_jsonc(text))).ok()?;
            // VS Code reads `servers` only; the others either key.
            let servers = match kind {
                McpClientKind::VsCode => root.get(key),
                _ => root.get(key).or_else(|| root.get("servers")).or_else(|| root.get("mcpServers")),
            };
            let servers = servers?.as_object()?;
            Some(servers.iter().map(|(name, v)| (name.clone(), Entry::from_json(v))).collect())
        }
    }
}

/// Whether `entry` is this server's current configuration for `kind`.
pub(super) fn is_current(kind: McpClientKind, entry: &Entry, server: &Server) -> bool {
    if kind == McpClientKind::ClaudeDesktop {
        let command = entry.command.as_deref().map(Path::new);
        return entry.stdio_port() == Some(Some(i64::from(server.port)))
            && command == Some(server.command.as_path())
            && entry.env.get(TOKEN_FILE_ENV).map(Path::new) == Some(server.token_file.as_path());
    }
    entry.url.as_deref() == Some(server.url().as_str())
        && entry.authorization.as_deref() == Some(server.authorization().as_str())
}

/// A JSON file of `kind`'s layout that lists servers (JetBrains' `looksLikeMcpJson`).
pub(super) fn looks_like_config(kind: McpClientKind, file: &Path) -> bool {
    let key = match format(kind) {
        Format::Json { key } => key,
        Format::Toml => "mcp_servers",
    };
    file.is_file() && std::fs::read_to_string(file).is_ok_and(|t| t.contains(key))
}

struct Url<'a> {
    host: &'a str,
    port: i64,
    path: &'a str,
}

fn parse_url(url: &str) -> Option<Url<'_>> {
    let rest = url.trim().split_once("://")?.1;
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let authority = authority.rsplit('@').next()?;
    let path = path.split(['?', '#']).next().unwrap_or("");
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, rest) = v6.split_once(']')?;
        (host, rest.strip_prefix(':'))
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return None;
    }
    // Like java.net.URI: no port means 80, whatever the scheme.
    let port = match port {
        Some(p) => p.parse().ok()?,
        None => 80,
    };
    Some(Url { host, port, path })
}

fn is_loopback(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1"
}

fn url_points_here(url: &str) -> Option<i64> {
    let u = parse_url(url)?;
    (ENDPOINT_PATHS.contains(&u.path) && is_loopback(u.host)).then_some(u.port)
}

/// The port of an entry pointing at OpenIDEA (any port); `Some(None)` for a bridge without a valid port.
fn port_here(entry: &Entry) -> Option<Option<i64>> {
    match &entry.url {
        Some(url) => url_points_here(url).map(Some),
        None => entry.stdio_port(),
    }
}

fn similar(port: i64, expected: i64) -> bool {
    (port - expected).abs() <= PORT_TOLERANCE
}

/// The entries that look like this server's: the named entry if there is one,
/// else loopback entries on a nearby port.
fn candidates<'a>(servers: &'a [(String, Entry)], name: &str, expected: i64) -> Vec<&'a Entry> {
    if let Some((_, entry)) = servers.iter().find(|(n, _)| n == name) {
        return vec![entry];
    }
    servers.iter().map(|(_, e)| e).filter(|e| matches!(port_here(e), Some(Some(p)) if similar(p, expected))).collect()
}

/// JetBrains' `isPortCorrect`: no candidate, or one on the expected port. An entry that
/// is neither a URL nor the bridge says nothing about the port.
fn port_correct(servers: &[(String, Entry)], name: &str, expected: i64) -> bool {
    let found = candidates(servers, name, expected);
    found.is_empty()
        || found.iter().any(|e| match (&e.url, e.stdio_port()) {
            (Some(url), _) => url_points_here(url) == Some(expected),
            (None, Some(port)) => port == Some(expected),
            (None, None) => true,
        })
}

fn transports(servers: &[(String, Entry)]) -> Vec<McpTransport> {
    let mut found = BTreeSet::new();
    for (_, e) in servers {
        if e.command.is_some() {
            found.insert(McpTransport::Stdio);
        }
        match e.kind.as_deref() {
            Some("sse") => {
                found.insert(McpTransport::Sse);
            }
            Some("http") => {
                found.insert(McpTransport::Http);
            }
            _ => {}
        }
    }
    found.into_iter().collect()
}

fn report(kind: McpClientKind, file: &Path, project: Option<&Path>, server: &Server) -> McpDetectedClient {
    let servers = std::fs::read_to_string(file).ok().and_then(|t| parse_servers(kind, &t)).unwrap_or_default();
    let expected = i64::from(server.port);
    McpDetectedClient {
        client: kind,
        project: project.map(|p| p.to_path_buf().into()),
        file: file.to_path_buf().into(),
        configured: (!servers.is_empty()).then(|| servers.iter().any(|(_, e)| port_here(e).is_some())),
        port_correct: port_correct(&servers, &server.name, expected),
        current: servers.iter().any(|(n, e)| *n == server.name && is_current(kind, e, server)),
        transports: transports(&servers),
    }
}

/// Whether `kind` looks installed: its configuration file, or the directory it goes into.
fn installed(kind: McpClientKind, file: &Path) -> bool {
    let parent_exists = || file.parent().is_some_and(Path::is_dir);
    match kind {
        McpClientKind::VsCode | McpClientKind::ClaudeCode => file.is_file(),
        McpClientKind::GitHubCopilotCli => parent_exists(),
        McpClientKind::Codex => file.is_file() || parent_exists(),
        _ => parent_exists(),
    }
}

/// The clients installed for this user and, with `project`, configured in that project,
/// with whether each one's configuration reaches `server`.
pub fn detect(server: &Server, paths: &Paths, project: Option<&Path>) -> Vec<McpDetectedClient> {
    // JetBrains' order, then ours.
    const GLOBAL: [McpClientKind; 11] = [
        McpClientKind::Junie,
        McpClientKind::VsCode,
        McpClientKind::Cursor,
        McpClientKind::ClaudeDesktop,
        McpClientKind::ClaudeCode,
        McpClientKind::Windsurf,
        McpClientKind::Codex,
        McpClientKind::Air,
        McpClientKind::GitHubCopilotCli,
        McpClientKind::GitHubCopilotIdePlugin,
        McpClientKind::Gemini,
    ];
    const PROJECT: [McpClientKind; 8] = [
        McpClientKind::VsCode,
        McpClientKind::Cursor,
        McpClientKind::Junie,
        McpClientKind::ClaudeCode,
        McpClientKind::Codex,
        McpClientKind::Air,
        McpClientKind::GitHubCopilotCli,
        McpClientKind::Gemini,
    ];
    let mut found = Vec::new();
    for kind in GLOBAL {
        let file = config_file(kind, paths);
        if installed(kind, &file) {
            found.push(report(kind, &file, None, server));
        }
    }
    if let Some(root) = project {
        for kind in PROJECT {
            let Some(file) = project_config_file(kind, root) else { continue };
            let present = match kind {
                // A `.codex` directory: Codex reads the project's config.toml.
                McpClientKind::Codex => file.parent().is_some_and(Path::is_dir),
                _ => looks_like_config(kind, &file),
            };
            if present {
                found.push(report(kind, &file, Some(root), server));
            }
        }
    }
    found
}

/// `text` without `//` and `/* */` comments and trailing commas, strings untouched.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
                out.push(' ');
            }
            '}' | ']' => {
                let trimmed = out.trim_end_matches(char::is_whitespace);
                if trimmed.ends_with(',') {
                    out.truncate(trimmed.len() - 1);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls_like_java_uri() {
        let u = parse_url("http://localhost:64347/mcp").unwrap();
        assert_eq!((u.host, u.port, u.path), ("localhost", 64347, "/mcp"));
        let u = parse_url("http://[::1]:5/mcp?x").unwrap();
        assert_eq!((u.host, u.port, u.path), ("::1", 5, "/mcp"));
        assert_eq!(parse_url("http://127.0.0.1/mcp").unwrap().port, 80);
        // Out of range for a socket, still a port to compare.
        assert_eq!(parse_url("http://localhost:71342/mcp").unwrap().port, 71342);
        assert!(parse_url("localhost:5/mcp").is_none());
    }

    #[test]
    fn strips_jsonc() {
        let text = "// head\n{ \"a\": \"x // not a comment\", /* c */ \"b\": [1, 2,],\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(v["a"], "x // not a comment");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
    }
}
