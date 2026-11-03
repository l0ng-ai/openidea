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
    VcsRead,
    VcsWrite,
    /// The plugin's own key-value store and data directory.
    Storage,
    /// The plugin's own secrets (kept in the client's OS keychain).
    Secrets,
    /// Workbench events (file opened, saved, focus…), not keystrokes.
    Events,
    /// Keystrokes and editor input events.
    InputEvents,
    /// The system clipboard, from the plugin's web views.
    Clipboard,
    /// HTTP(S) to one host (`*.example.com` matches subdomains).
    Net(String),
    /// Run one external program. Full code execution: never fine-grained.
    Process(String),
    /// Read files outside the project under one path.
    FsRead(String),
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
            Self::EditorWrite | Self::VcsWrite | Self::Net(_) | Self::Secrets | Self::InputEvents | Self::Clipboard => {
                Risk::Medium
            }
            Self::Process(_) | Self::FsRead(_) => Risk::High,
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
            Self::VcsRead => "Read version control state".into(),
            Self::VcsWrite => "Change version control state (commit, fetch, checkout)".into(),
            Self::Storage => "Store its own data".into(),
            Self::Secrets => "Store secrets in the system keychain".into(),
            Self::Events => "Observe workbench events (files opened, saved, focus)".into(),
            Self::InputEvents => "Observe keystrokes and editor input".into(),
            Self::Clipboard => "Read and write the clipboard from its web views".into(),
            Self::Net(host) => format!("Connect to {host} (from the machine the project is on)"),
            Self::Process(bin) => format!("Run {bin} — equivalent to running arbitrary code on this machine"),
            Self::FsRead(path) => format!("Read files under {path}, outside the project"),
        }
    }

    /// Whether `self`, granted, also covers `wanted` (`net:*.x.com` covers `net:a.x.com`).
    pub fn covers(&self, wanted: &Capability) -> bool {
        match (self, wanted) {
            (Self::Net(pattern), Self::Net(host)) => host_matches(pattern, host),
            (Self::FsRead(base), Self::FsRead(path)) => {
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

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProjectRead => f.write_str("project.read"),
            Self::EditorRead => f.write_str("editor.read"),
            Self::EditorWrite => f.write_str("editor.write"),
            Self::VcsRead => f.write_str("vcs.read"),
            Self::VcsWrite => f.write_str("vcs.write"),
            Self::Storage => f.write_str("storage"),
            Self::Secrets => f.write_str("secrets"),
            Self::Events => f.write_str("events"),
            Self::InputEvents => f.write_str("events.input"),
            Self::Clipboard => f.write_str("clipboard"),
            Self::Net(h) => write!(f, "net:{h}"),
            Self::Process(b) => write!(f, "process:{b}"),
            Self::FsRead(p) => write!(f, "fs.read:{p}"),
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
                "net" => {
                    let host = arg.strip_prefix("*.").unwrap_or(arg);
                    let valid = !host.is_empty()
                        && host.len() <= 253
                        && host.split('.').all(|label| {
                            !label.is_empty()
                                && label.len() <= 63
                                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        });
                    if valid { Ok(Self::Net(arg.to_ascii_lowercase())) } else { Err(format!("invalid host in {s:?}")) }
                }
                "process" => {
                    if arg.contains(['/', '\\']) && !std::path::Path::new(arg).is_absolute() {
                        return Err(format!("{s:?}: use a program name or an absolute path"));
                    }
                    Ok(Self::Process(arg.to_owned()))
                }
                "fs.read" => {
                    if !std::path::Path::new(arg).is_absolute() && !arg.starts_with('~') {
                        return Err(format!("{s:?}: use an absolute path (or ~/…)"));
                    }
                    Ok(Self::FsRead(arg.to_owned()))
                }
                _ => Err(format!("unknown capability {s:?}")),
            };
        }
        Ok(match s {
            "project.read" | "project-read" => Self::ProjectRead,
            "editor.read" | "editor-read" => Self::EditorRead,
            "editor.write" | "editor-write" => Self::EditorWrite,
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
        let (git, etc) = if cfg!(windows) {
            (r"process:C:\Program Files\Git\bin\git.exe", r"fs.read:C:\Windows")
        } else {
            ("process:/usr/bin/git", "fs.read:/etc")
        };
        for s in [git, etc] {
            assert_eq!(s.parse::<Capability>().unwrap().to_string(), s);
        }
        assert_eq!("project-read".parse::<Capability>().unwrap(), Capability::ProjectRead);
        assert!("net:".parse::<Capability>().is_err());
        assert!("net:a b".parse::<Capability>().is_err());
        assert!("process:./evil".parse::<Capability>().is_err());
        assert!("fs.read:rel".parse::<Capability>().is_err());
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
