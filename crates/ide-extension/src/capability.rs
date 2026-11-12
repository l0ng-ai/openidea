//! What a plugin may do beyond pure computation, and how risky each grant is.
//!
//! Capabilities are written as strings in the manifest (`project.read`,
//! `net:crates.io`, `process:cargo`) and stored the same way in the grant
//! ledger. The 0.1 permission names (`project-read`, …) parse as their 0.2
//! equivalents.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::Type;
use std::fmt;
use std::str::FromStr;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    /// Read files inside the project root; the project root itself.
    ProjectRead,
    /// The focused editor's file, selection and text.
    EditorRead,
    /// Edit the focused editor (versioned edits).
    EditorWrite,
    /// Create and replace files inside the project root.
    ProjectWrite,
    /// Run arbitrary IDE actions and other plugins' commands.
    IdeCommands,
    /// Manage only its own project database sources and write their credentials.
    DatabaseSources,
    VcsRead,
    VcsWrite,
    /// The plugin's own key-value store and data directory.
    Storage,
    /// The plugin's own secrets (kept in the client's OS keychain).
    Secrets,
    /// Workbench events (files, focus, VCS), not keystrokes.
    Events,
    /// Keystrokes and editor input events.
    InputEvents,
    /// The system clipboard, from the plugin's web views.
    Clipboard,
    /// HTTPS (and loopback HTTP) to one host (`*.example.com` matches subdomains).
    Net(String),
    /// Ask the user when the first request goes to an HTTPS (or loopback) host
    /// the manifest does not list; each answer applies to one host. Plain
    /// HTTP elsewhere always needs `net.http:<host>`.
    NetAsk,
    /// Unencrypted HTTP to one host.
    NetHttp(String),
    /// A local socket or named pipe on the project machine.
    Ipc(String),
    /// Run one external program. Full code execution: never fine-grained.
    Process(String),
    /// Read files outside the project under one path.
    FsRead(String),
    /// Write files outside the project under one path.
    FsWrite(String),
}

/// How a grant is presented (plan 4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Risk {
    /// Listed on the install page, one confirmation.
    Low,
    /// Listed separately with its purpose.
    Medium,
    /// Separate dialog: "equivalent to running arbitrary code on this machine".
    High,
}

impl Capability {
    pub fn risk(&self) -> Risk {
        match self {
            Self::ProjectRead | Self::EditorRead | Self::Storage | Self::Events | Self::VcsRead => Risk::Low,
            Self::EditorWrite
            | Self::DatabaseSources
            | Self::VcsWrite
            | Self::Net(_)
            | Self::NetAsk
            | Self::NetHttp(_)
            | Self::Secrets
            | Self::InputEvents
            | Self::Clipboard => Risk::Medium,
            // A trusted project's own files name the programs the IDE starts (its settings, its
            // build scripts), so writing them is running code.
            Self::ProjectWrite
            | Self::IdeCommands
            | Self::Ipc(_)
            | Self::Process(_)
            | Self::FsRead(_)
            | Self::FsWrite(_) => Risk::High,
        }
    }

    /// Low-risk capabilities that the one-time migration of the 0.1 "declared
    /// means granted" behaviour may grant automatically (plan 4.6).
    pub fn auto_migrates(&self) -> bool {
        self.risk() == Risk::Low
    }

    /// Short user-facing description for install and grant pages.
    pub fn describe(&self) -> String {
        match self {
            Self::ProjectRead => "Read files in the open project".into(),
            Self::EditorRead => "Read the focused editor's file and selection".into(),
            Self::EditorWrite => "Change text in the editor".into(),
            Self::ProjectWrite => "Create and change files in the open project".into(),
            Self::DatabaseSources => "Manage its own database sources and store their passwords in trusted projects".into(),
            Self::IdeCommands => "Run any IDE action or other plugins' commands as if you chose them, including running programs, committing and pushing".into(),
            Self::VcsRead => "Read version control state".into(),
            Self::VcsWrite => "Change version control state (commit, fetch, checkout)".into(),
            Self::Storage => "Store its own data".into(),
            Self::Secrets => "Store secrets in the system keychain".into(),
            Self::Events => "Observe editor, filesystem and version control events".into(),
            Self::InputEvents => "Observe keystrokes and editor input".into(),
            Self::Clipboard => {
                "Copy to the clipboard from its commands, and read and write it from its web views".into()
            }
            Self::Net(host) => format!("Connect to {host} (from the machine the project is on)"),
            Self::NetAsk => {
                "Ask to connect to a host that is not on the list the first time it tries; you allow or refuse each host, and can revoke the allowed ones"
                    .into()
            }
            Self::NetHttp(host) => {
                format!("Connect to {host} over unencrypted HTTP (from the machine the project is on)")
            }
            Self::Ipc(path) => {
                format!("Connect to local socket {path} — equivalent to running arbitrary code on the project machine")
            }
            Self::Process(bin) => format!("Run {bin} — equivalent to running arbitrary code on this machine"),
            Self::FsRead(path) => format!("Read files under {path}, outside the project"),
            Self::FsWrite(path) => format!("Change files under {path}, outside the project"),
        }
    }

    /// Whether `self`, granted, also covers `wanted` (`net:*.x.com` covers `net:a.x.com`).
    pub fn covers(&self, wanted: &Capability) -> bool {
        if self == wanted {
            return true;
        }
        match (self, wanted) {
            (Self::Ipc(pattern), Self::Ipc(path)) => ipc_matches(pattern, path),
            (Self::Net(pattern), Self::Net(host)) | (Self::NetHttp(pattern), Self::NetHttp(host)) => {
                host_matches(pattern, host)
            }
            (Self::FsRead(base), Self::FsRead(path)) | (Self::FsWrite(base), Self::FsWrite(path)) => {
                std::path::Path::new(path).starts_with(std::path::Path::new(base))
            }
            _ => self == wanted,
        }
    }
}

/// `example.com` matches exactly; `*.example.com` matches any subdomain (not the apex).
pub fn host_matches(pattern: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    match pattern.strip_prefix("*.") {
        Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
        None => host == pattern,
    }
}

/// Validates a socket path; a grant may use `*` in its last segment only.
pub fn validate_ipc_name(name: &str, pattern: bool) -> Result<(), String> {
    let pipe = name.starts_with(r"\\.\pipe\");
    let unix = name.starts_with('/')
        || name.starts_with("~/")
        || name.starts_with("$TMPDIR/")
        || name.starts_with("$XDG_RUNTIME_DIR/");
    let parts: Vec<_> = name.strip_prefix(r"\\.\pipe\").unwrap_or(name).split(if pipe { '\\' } else { '/' }).collect();
    if !(pipe || unix)
        || name.contains(['\0', '?'])
        || name.len() > 4096
        || parts.last().is_none_or(|p| p.is_empty())
        || parts.iter().any(|p| matches!(*p, "." | ".."))
        || parts[..parts.len().saturating_sub(1)].iter().any(|p| p.contains('*'))
        || (!pattern && name.contains('*'))
    {
        return Err(
            "ipc: use an absolute socket path or \\\\.\\pipe\\name; only the last grant segment may contain '*'".into(),
        );
    }
    Ok(())
}

/// Expands the three supported host-local prefixes; no shell is involved.
pub fn expand_ipc_name(name: &str) -> Result<String, String> {
    validate_ipc_name(name, true)?;
    for (prefix, key) in [("~/", "HOME"), ("$TMPDIR/", "TMPDIR"), ("$XDG_RUNTIME_DIR/", "XDG_RUNTIME_DIR")] {
        if let Some(rest) = name.strip_prefix(prefix) {
            let base = std::env::var(key).map_err(|_| format!("{key} is not set"))?;
            let expanded = format!("{}/{rest}", base.trim_end_matches('/'));
            validate_ipc_name(&expanded, true)?;
            return Ok(expanded);
        }
    }
    Ok(name.into())
}

fn ipc_matches(pattern: &str, name: &str) -> bool {
    let (Ok(pattern), Ok(name)) = (expand_ipc_name(pattern), expand_ipc_name(name)) else { return false };
    if validate_ipc_name(&name, false).is_err() {
        return false;
    }
    let separator = if pattern.starts_with(r"\\.\pipe\") { '\\' } else { '/' };
    let (Some((parent, pattern)), Some((other, name))) = (pattern.rsplit_once(separator), name.rsplit_once(separator))
    else {
        return false;
    };
    if parent != other {
        return false;
    }
    let mut rest = name;
    let mut pieces = pattern.split('*');
    let first = pieces.next().unwrap_or_default();
    let Some(tail) = rest.strip_prefix(first) else { return false };
    rest = tail;
    let pieces: Vec<_> = pieces.collect();
    if pieces.is_empty() {
        return rest.is_empty();
    }
    for (i, piece) in pieces.iter().enumerate() {
        if i + 1 == pieces.len() {
            return rest.ends_with(piece);
        }
        let Some(at) = rest.find(piece) else { return false };
        rest = &rest[at + piece.len()..];
    }
    true
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProjectRead => f.write_str("project.read"),
            Self::EditorRead => f.write_str("editor.read"),
            Self::EditorWrite => f.write_str("editor.write"),
            Self::ProjectWrite => f.write_str("project.write"),
            Self::IdeCommands => f.write_str("ide.commands"),
            Self::DatabaseSources => f.write_str("database.sources"),
            Self::VcsRead => f.write_str("vcs.read"),
            Self::VcsWrite => f.write_str("vcs.write"),
            Self::Storage => f.write_str("storage"),
            Self::Secrets => f.write_str("secrets"),
            Self::Events => f.write_str("events"),
            Self::InputEvents => f.write_str("events.input"),
            Self::Clipboard => f.write_str("clipboard"),
            Self::Net(h) => write!(f, "net:{h}"),
            Self::NetAsk => f.write_str("net:ask"),
            Self::NetHttp(h) => write!(f, "net.http:{h}"),
            Self::Ipc(p) => write!(f, "ipc:{p}"),
            Self::Process(b) => write!(f, "process:{b}"),
            Self::FsRead(p) => write!(f, "fs.read:{p}"),
            Self::FsWrite(p) => write!(f, "fs.write:{p}"),
        }
    }
}

impl FromStr for Capability {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if let Some((kind, arg)) = s.split_once(':') {
            let arg = arg.trim();
            if arg.is_empty() {
                return Err(format!("capability {s:?} needs a value after ':'"));
            }
            return match kind {
                "net" | "net.http" => {
                    if kind == "net" && arg == "ask" {
                        return Ok(Self::NetAsk);
                    }
                    let host = arg.strip_prefix("*.").unwrap_or(arg);
                    let valid = !host.is_empty()
                        && host.len() <= 253
                        && host.split('.').all(|label| {
                            !label.is_empty()
                                && label.len() <= 63
                                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        });
                    if valid {
                        Ok(if kind == "net" {
                            Self::Net(arg.to_ascii_lowercase())
                        } else {
                            Self::NetHttp(arg.to_ascii_lowercase())
                        })
                    } else {
                        Err(format!("invalid host in {s:?}"))
                    }
                }
                "ipc" => {
                    validate_ipc_name(arg, true)?;
                    Ok(Self::Ipc(arg.to_owned()))
                }
                "process" => {
                    if arg.contains(['/', '\\']) && !std::path::Path::new(arg).is_absolute() {
                        return Err(format!("{s:?}: use a program name or an absolute path"));
                    }
                    Ok(Self::Process(arg.to_owned()))
                }
                "fs.read" | "fs.write" => {
                    if !std::path::Path::new(arg).is_absolute() && !arg.starts_with('~') {
                        return Err(format!("{s:?}: use an absolute path (or ~/…)"));
                    }
                    Ok(if kind == "fs.read" { Self::FsRead(arg.to_owned()) } else { Self::FsWrite(arg.to_owned()) })
                }
                _ => Err(format!("unknown capability {s:?}")),
            };
        }
        Ok(match s {
            "project.read" | "project-read" => Self::ProjectRead,
            "editor.read" | "editor-read" => Self::EditorRead,
            "editor.write" | "editor-write" => Self::EditorWrite,
            "project.write" => Self::ProjectWrite,
            "ide.commands" => Self::IdeCommands,
            "database.sources" => Self::DatabaseSources,
            "vcs.read" => Self::VcsRead,
            "vcs.write" => Self::VcsWrite,
            "storage" => Self::Storage,
            "secrets" => Self::Secrets,
            "events" => Self::Events,
            "events.input" => Self::InputEvents,
            "clipboard" => Self::Clipboard,
            _ => return Err(format!("unknown capability {s:?}")),
        })
    }
}

impl Serialize for Capability {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Capability {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

/// A capability as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInfo {
    /// `project.read`, `net:crates.io`, …
    pub id: String,
    pub risk: Risk,
    pub description: String,
    /// Declared under `optional`: the plugin runs without it.
    pub optional: bool,
    /// Currently granted.
    pub granted: bool,
}

impl CapabilityInfo {
    pub fn new(cap: &Capability, optional: bool, granted: bool) -> Self {
        Self { id: cap.to_string(), risk: cap.risk(), description: cap.describe(), optional, granted }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_prints() {
        for s in [
            "project.read",
            "editor.write",
            "project.write",
            "vcs.write",
            "storage",
            "secrets",
            "events",
            "events.input",
            "net:crates.io",
            "net:*.github.com",
            "process:cargo",
        ] {
            assert_eq!(s.parse::<Capability>().unwrap().to_string(), s);
        }
        // Absolute paths are the platform's.
        let (git, etc, out) = if cfg!(windows) {
            (r"process:C:\Program Files\Git\bin\git.exe", r"fs.read:C:\Windows", r"fs.write:C:\out")
        } else {
            ("process:/usr/bin/git", "fs.read:/etc", "fs.write:/out")
        };
        for s in [git, etc, out] {
            assert_eq!(s.parse::<Capability>().unwrap().to_string(), s);
        }
        assert_eq!("project-read".parse::<Capability>().unwrap(), Capability::ProjectRead);
        assert!("net:".parse::<Capability>().is_err());
        assert!("net:a b".parse::<Capability>().is_err());
        assert!("process:./evil".parse::<Capability>().is_err());
        assert!("fs.read:rel".parse::<Capability>().is_err());
        assert!("fs.write:rel".parse::<Capability>().is_err());
        assert!("network".parse::<Capability>().is_err());
    }

    #[test]
    fn risk_levels() {
        assert_eq!(Capability::ProjectRead.risk(), Risk::Low);
        assert_eq!(Capability::Net("x".into()).risk(), Risk::Medium);
        assert_eq!(Capability::InputEvents.risk(), Risk::Medium);
        assert_eq!("clipboard".parse::<Capability>().unwrap(), Capability::Clipboard);
        assert_eq!(Capability::Clipboard.risk(), Risk::Medium);
        assert_eq!(Capability::Process("cargo".into()).risk(), Risk::High);
        assert!(Capability::Storage.auto_migrates() && !Capability::EditorWrite.auto_migrates());
    }

    /// A trusted project's files name programs the IDE starts by itself: the git and language
    /// server executables in `.openidea/settings.toml`, its build scripts. Writing them is
    /// running code, and the install dialog says so.
    #[test]
    fn writing_project_files_is_a_high_risk_grant() {
        assert_eq!(Capability::ProjectWrite.risk(), Risk::High);
        assert!(!Capability::ProjectWrite.auto_migrates());
    }

    #[test]
    fn host_patterns() {
        assert!(host_matches("crates.io", "crates.io"));
        assert!(host_matches("crates.io", "CRATES.IO."));
        assert!(!host_matches("crates.io", "static.crates.io"));
        assert!(host_matches("*.github.com", "api.github.com"));
        assert!(!host_matches("*.github.com", "github.com"));
        assert!(!host_matches("*.github.com", "evilgithub.com"));
        let any_gh: Capability = "net:*.github.com".parse().unwrap();
        assert!(any_gh.covers(&"net:api.github.com".parse().unwrap()));
        assert!(Capability::FsRead("/etc".into()).covers(&Capability::FsRead("/etc/hosts".into())));
        assert!(!Capability::FsRead("/etc".into()).covers(&Capability::FsRead("/etcx".into())));
    }
}

#[cfg(test)]
mod api14_tests {
    use super::*;
    #[test]
    fn http_grants_do_not_imply_https_and_socket_patterns_stay_in_one_directory() {
        let http: Capability = "net.http:*.example.com".parse().unwrap();
        assert_eq!(http.to_string(), "net.http:*.example.com");
        assert_eq!(http.risk(), Risk::Medium);
        assert!(http.describe().contains("unencrypted"));
        assert!(http.covers(&"net.http:a.example.com".parse().unwrap()));
        assert!(!http.covers(&"net:a.example.com".parse().unwrap()));
        assert!(!"net:*.example.com".parse::<Capability>().unwrap().covers(&"net.http:a.example.com".parse().unwrap()));
        let socket: Capability = "ipc:/tmp/discord-ipc-*-socket".parse().unwrap();
        assert_eq!(socket.risk(), Risk::High);
        assert!(socket.covers(&Capability::Ipc("/tmp/discord-ipc-42-socket".into())));
        assert!(!socket.covers(&Capability::Ipc("/tmp/discord-ipc-dir/evil-socket".into())));
        assert!(!socket.covers(&Capability::Ipc("/tmp/../tmp/discord-ipc-42-socket".into())));
        assert_eq!("ipc:$TMPDIR/discord-ipc-*".parse::<Capability>().unwrap().to_string(), "ipc:$TMPDIR/discord-ipc-*");
        assert!(
            r"ipc:\\.\pipe\discord-*"
                .parse::<Capability>()
                .unwrap()
                .covers(&Capability::Ipc(r"\\.\pipe\discord-0".into()))
        );
        for invalid in
            ["ipc:relative", "ipc:/tmp/*/socket", "ipc:/tmp/../socket", "ipc:/tmp/", "ipc:/tmp/socket?", "net.http:a b"]
        {
            assert!(invalid.parse::<Capability>().is_err(), "{invalid}");
        }
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn ide_commands_is_explicit_and_high_risk() {
        let cap: Capability = "ide.commands".parse().unwrap();
        assert_eq!(cap, Capability::IdeCommands);
        assert_eq!(cap.to_string(), "ide.commands");
        assert_eq!(cap.risk(), Risk::High);
        assert!(!cap.auto_migrates());
        assert!(!Capability::VcsWrite.covers(&cap));
        assert!(!Capability::Process("git".into()).covers(&cap));
    }
}

#[cfg(test)]
mod net_ask_tests {
    use super::*;
    #[test]
    fn net_ask_is_its_own_medium_risk_grant_covering_no_host() {
        let cap: Capability = "net:ask".parse().unwrap();
        assert_eq!(cap, Capability::NetAsk);
        assert_eq!(cap.to_string(), "net:ask");
        assert_eq!(cap.risk(), Risk::Medium);
        assert!(!cap.auto_migrates());
        // It asks; it does not itself connect anywhere or pre-approve a host.
        assert!(!cap.covers(&"net:api.example.com".parse().unwrap()));
        assert!(!cap.covers(&Capability::NetHttp("example.com".into())));
        assert!(!"net:api.example.com".parse::<Capability>().unwrap().covers(&cap));
        assert_ne!("net:ask.com".parse::<Capability>().unwrap(), Capability::NetAsk);
        assert!("net:ask".parse::<Capability>().unwrap().describe().contains("host"));
    }
}

#[cfg(test)]
mod database_tests {
    use super::*;
    #[test]
    fn database_sources_is_a_medium_risk_exact_grant_requiring_api4() {
        let cap: Capability = "database.sources".parse().unwrap();
        assert_eq!(cap, Capability::DatabaseSources);
        assert_eq!(cap.to_string(), "database.sources");
        assert_eq!(cap.risk(), Risk::Medium);
        assert!(!cap.auto_migrates());
        assert!(!Capability::ProjectRead.covers(&cap));
        assert!(!Capability::ProjectWrite.covers(&cap));
        for (api, valid) in [("^1.3", false), ("^1.4", true)] {
            let text = format!(
                "id='db-test'\nname='DB'\nversion='1.0.0'\nengines.openidea='{api}'\n[capabilities]\nrequired=['database.sources']"
            );
            assert_eq!(crate::Manifest::parse(&text).is_ok(), valid);
        }
    }
}
