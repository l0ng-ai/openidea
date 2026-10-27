//! Where to connect: an [`SshTarget`] and the hosts to go through to reach it
//! (`~/.ssh/config` aliases and `ProxyJump` chains).

use ide_core::remote_settings::{SshAuth, SshConfiguration};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};

/// An SSH host and how to authenticate to it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshTarget {
    /// Host name, or a `Host` alias of `~/.ssh/config` with [`SshAuth::OpenSsh`].
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub auth: SshAuth,
    /// Private key for [`SshAuth::KeyPair`]; `~/` is the home directory.
    pub key_file: String,
}

impl From<&SshConfiguration> for SshTarget {
    fn from(c: &SshConfiguration) -> Self {
        Self { host: c.host.clone(), port: c.port, user: c.user.clone(), auth: c.auth, key_file: c.key_file.clone() }
    }
}

/// The user's OpenSSH files.
#[derive(Debug, Clone)]
pub struct SshFiles {
    pub known_hosts: PathBuf,
    /// `~/.ssh/config` (used with [`SshAuth::OpenSsh`]).
    pub config: Option<PathBuf>,
}

impl Default for SshFiles {
    fn default() -> Self {
        let dir = home().unwrap_or_default().join(".ssh");
        Self { known_hosts: dir.join("known_hosts"), config: Some(dir.join("config")) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hop {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<PathBuf>,
}

impl Hop {
    pub fn label(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

pub(crate) fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `~/x` → `$HOME/x`.
pub fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), home()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(path),
    }
}

fn local_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// One `~/.ssh/config` lookup (a missing or unreadable file means defaults).
fn config_hop(config: Option<&Path>, alias: &str) -> (Hop, Option<String>) {
    let c = config
        .and_then(|p| russh_config::parse_path(p, alias).ok())
        .unwrap_or_else(|| russh_config::Config::default(alias));
    let identity_files = c.host_config.identity_file.clone().unwrap_or_default();
    let hop = Hop { host: c.host().to_owned(), port: c.port(), user: c.user(), identity_files };
    (hop, c.host_config.proxy_jump.clone())
}

/// `[user@]host[:port]` of a `ProxyJump` entry.
fn jump_hop(config: Option<&Path>, spec: &str) -> Hop {
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, spec),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse().ok()),
        _ => (rest, None),
    };
    let (mut hop, _) = config_hop(config, host);
    if let Some(u) = user {
        hop.user = u.to_owned();
    }
    if let Some(p) = port {
        hop.port = p;
    }
    hop
}

/// The SSH hosts to go through, the target last.
pub(crate) fn resolve_hops(target: &SshTarget, config: Option<&Path>) -> IdeResult<Vec<Hop>> {
    let host = target.host.trim();
    if host.is_empty() {
        return Err(IdeError::invalid("SSH host is empty"));
    }
    let (mut hop, proxy_jump) = if target.auth == SshAuth::OpenSsh {
        config_hop(config, host)
    } else {
        (Hop { host: host.to_owned(), port: 22, user: local_user(), identity_files: Vec::new() }, None)
    };
    if let Some(p) = target.port {
        hop.port = p;
    }
    if !target.user.trim().is_empty() {
        hop.user = target.user.trim().to_owned();
    }
    let mut hops: Vec<Hop> = proxy_jump
        .filter(|j| !j.eq_ignore_ascii_case("none"))
        .map(|j| j.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| jump_hop(config, s)).collect())
        .unwrap_or_default();
    hops.push(hop);
    Ok(hops)
}

/// `ssh` arguments that reach `target` (the system client: terminals, git).
pub fn openssh_args(target: &SshTarget) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(p) = target.port {
        args.extend(["-p".into(), p.to_string()]);
    }
    if target.auth == SshAuth::KeyPair && !target.key_file.trim().is_empty() {
        args.extend(["-i".into(), expand(target.key_file.trim()).to_string_lossy().into_owned()]);
        args.extend(["-o".into(), "IdentitiesOnly=yes".into()]);
    }
    if target.auth == SshAuth::Password {
        args.extend(["-o".into(), "PreferredAuthentications=password,keyboard-interactive".into()]);
    }
    let host = target.host.trim();
    // A host starting with `-` must not be read as an option.
    args.push("--".into());
    args.push(if target.user.trim().is_empty() { host.to_owned() } else { format!("{}@{host}", target.user.trim()) });
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_aliases_and_proxy_jumps_from_ssh_config() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            "Host db-bastion\n  HostName 10.0.0.5\n  User ops\n  Port 2222\n  ProxyJump jump@gw.example.com:2200,edge\n  IdentityFile /keys/id_bastion\n\nHost edge\n  HostName edge.example.com\n  User edgeuser\n",
        )
        .unwrap();
        let target = SshTarget { host: "db-bastion".into(), auth: SshAuth::OpenSsh, ..Default::default() };
        let hops = resolve_hops(&target, Some(&config)).unwrap();
        let labels: Vec<String> = hops.iter().map(Hop::label).collect();
        assert_eq!(labels, ["jump@gw.example.com:2200", "edgeuser@edge.example.com:22", "ops@10.0.0.5:2222"]);
        assert_eq!(hops[2].identity_files, [PathBuf::from("/keys/id_bastion")]);

        // Explicit fields win over the config.
        let target = SshTarget { user: "me".into(), port: Some(22), ..target };
        assert_eq!(resolve_hops(&target, Some(&config)).unwrap()[2].label(), "me@10.0.0.5:22");

        // Without OpenSSH mode the host is used as is.
        let target = SshTarget { auth: SshAuth::Password, user: "u".into(), port: None, ..target };
        let hops = resolve_hops(&target, Some(&config)).unwrap();
        assert_eq!(hops.iter().map(Hop::label).collect::<Vec<_>>(), ["u@db-bastion:22"]);
        assert!(resolve_hops(&SshTarget::default(), None).is_err());
    }

    #[test]
    fn builds_openssh_arguments() {
        let t = SshTarget { host: "box".into(), user: "me".into(), port: Some(2200), ..Default::default() };
        assert_eq!(openssh_args(&t), ["-p", "2200", "--", "me@box"]);
        let t =
            SshTarget { host: "box".into(), auth: SshAuth::KeyPair, key_file: "/k/id".into(), ..Default::default() };
        assert_eq!(openssh_args(&t), ["-i", "/k/id", "-o", "IdentitiesOnly=yes", "--", "box"]);
    }
}
