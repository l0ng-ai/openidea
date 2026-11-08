//! Where to connect: an [`SshTarget`] and the hosts to go through to reach it
//! (`~/.ssh/config` aliases and `ProxyJump` chains).

use ide_core::remote_settings::{SshAuth, SshConfiguration};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MATCH_EXEC_TIMEOUT: Duration = Duration::from_secs(10);

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
    pub proxy_command: Option<String>,
    pub host_key_policy: HostKeyPolicy,
    pub known_hosts: Option<PathBuf>,
}

/// `StrictHostKeyChecking`: what happens to a host key missing from `known_hosts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyPolicy {
    /// The user decides on an unknown key; a changed key is refused (`yes`, `ask`).
    Ask,
    /// An unknown key is recorded without asking; a changed key is refused (`accept-new`).
    AcceptNew,
    /// Every key is accepted (`no`, `off`, or no `known_hosts` file to check against).
    Off,
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

#[derive(Default)]
struct RawConfig {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_files: Vec<String>,
    proxy_jump: Option<String>,
    proxy_command: Option<String>,
    host_key_policy: Option<HostKeyPolicy>,
    user_known_hosts_file: Option<String>,
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Splits an `ssh_config` line into `(keyword, rest)`, supporting both whitespace and `=` separators.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_ascii_whitespace() || c == '=')?;
    let key = &line[..end];
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').map_or(rest, str::trim_start);
    Some((key, rest))
}

/// Splits whitespace-delimited arguments while respecting single and double quotes.
fn split_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut in_token = false;
    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                in_token = true;
            }
            None if ch.is_ascii_whitespace() => {
                if in_token {
                    args.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            None => {
                cur.push(ch);
                in_token = true;
            }
        }
    }
    if in_token {
        args.push(cur);
    }
    args
}

/// Matches `text` against a glob `pattern` with `*` and `?` wildcards.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star_pi, mut star_ti) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&t[ti])) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_pi = Some(pi);
            pi += 1;
            star_ti = ti;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// OpenSSH pattern-list matching: any matching `!pattern` rejects, else any matching pattern accepts.
fn pattern_list_matches<'a>(patterns: impl IntoIterator<Item = &'a str>, candidate: &str) -> bool {
    let mut matched = false;
    for raw in patterns {
        if raw.is_empty() {
            continue;
        }
        if let Some(neg) = raw.strip_prefix('!') {
            if glob_match(neg, candidate) {
                return false;
            }
        } else if glob_match(raw, candidate) {
            matched = true;
        }
    }
    matched
}

/// Expands OpenSSH percent tokens (`%h`, `%H`, `%n`, `%p`, `%r`, `%u`, `%d`, `%%`).
fn expand_tokens(template: &str, alias: &str, host: &str, port: u16, remote_user: &str, local_user: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars();
    let home_dir = home().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('h' | 'H') => out.push_str(host),
            Some('n') => out.push_str(alias),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(remote_user),
            Some('u') => out.push_str(local_user),
            Some('d') => out.push_str(&home_dir),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Runs a `Match exec` command; one that does not finish in time counts as not matching.
fn eval_match_exec(command: &str) -> bool {
    #[cfg(unix)]
    let mut cmd = {
        let mut c = std::process::Command::new("/bin/sh");
        c.arg("-c").arg(command);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(command);
        c
    };
    ide_core::process::prepare(&mut cmd);
    ide_core::process::own_group(&mut cmd);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return false };
    let deadline = Instant::now() + MATCH_EXEC_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                ide_core::process::kill_tree(&mut child);
                return false;
            }
        }
    }
}

fn eval_match(
    value: &str,
    alias: &str,
    port_override: Option<u16>,
    user_override: Option<&str>,
    out: &RawConfig,
) -> bool {
    let tokens = split_args(value);
    if tokens.is_empty() {
        return false;
    }
    let local = local_user();
    let host = out.hostname.as_deref().unwrap_or(alias);
    let port = port_override.or(out.port).unwrap_or(22);
    let user = user_override.map(str::trim).filter(|s| !s.is_empty()).or(out.user.as_deref()).unwrap_or(&local);

    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i].as_str();
        let (raw_key, inline_val) = match tok.split_once('=') {
            Some((k, v)) => (k, Some(v)),
            None => (tok, None),
        };
        let (negated, key) = match raw_key.strip_prefix('!') {
            Some(k) => (true, k.to_ascii_lowercase()),
            None => (false, raw_key.to_ascii_lowercase()),
        };
        match key.as_str() {
            "all" | "canonical" | "final" => {
                if negated {
                    return false;
                }
                i += 1;
            }
            "host" | "originalhost" | "user" | "localuser" | "exec" => {
                let arg = match inline_val {
                    Some(v) => {
                        i += 1;
                        v
                    }
                    None => {
                        let Some(next) = tokens.get(i + 1) else { return false };
                        i += 2;
                        next.as_str()
                    }
                };
                let ok = match key.as_str() {
                    "host" => pattern_list_matches(arg.split(','), host),
                    "originalhost" => pattern_list_matches(arg.split(','), alias),
                    "user" => pattern_list_matches(arg.split(','), user),
                    "localuser" => pattern_list_matches(arg.split(','), &local),
                    "exec" => {
                        let cmd = expand_tokens(arg, alias, host, port, user, &local);
                        eval_match_exec(&cmd)
                    }
                    _ => false,
                };
                if ok == negated {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

/// Expands a path pattern that may contain `*` or `?` in its path segments.
fn expand_include_glob(pattern: &Path) -> Vec<PathBuf> {
    use std::path::Component;
    let mut paths = vec![PathBuf::new()];
    for comp in pattern.components() {
        match comp {
            Component::Normal(os) => {
                let s = os.to_string_lossy();
                if s.contains('*') || s.contains('?') {
                    let mut next = Vec::new();
                    for base in &paths {
                        let dir = if base.as_os_str().is_empty() { Path::new(".") } else { base.as_path() };
                        let Ok(entries) = std::fs::read_dir(dir) else { continue };
                        let mut matched: Vec<PathBuf> = entries
                            .filter_map(Result::ok)
                            .filter(|e| glob_match(&s, &e.file_name().to_string_lossy()))
                            .map(|e| e.path())
                            .collect();
                        matched.sort();
                        next.extend(matched);
                    }
                    paths = next;
                } else {
                    for p in &mut paths {
                        p.push(os);
                    }
                }
            }
            other => {
                for p in &mut paths {
                    p.push(other.as_os_str());
                }
            }
        }
    }
    paths.into_iter().filter(|p| p.is_file()).collect()
}

fn parse_config_file(
    path: &Path,
    alias: &str,
    port_override: Option<u16>,
    user_override: Option<&str>,
    out: &mut RawConfig,
    depth: usize,
) {
    if depth >= 8 {
        return;
    }
    let Ok(contents) = std::fs::read_to_string(path) else { return };
    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut active = true;
    for line in contents.lines() {
        let Some((key, value)) = split_directive(line) else { continue };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                let patterns = split_args(value);
                active = pattern_list_matches(patterns.iter().map(String::as_str), alias);
            }
            "match" => {
                active = eval_match(value, alias, port_override, user_override, out);
            }
            _ if !active => {}
            "include" => {
                for raw in split_args(value) {
                    let expanded = expand(&raw);
                    let pat = if expanded.is_relative() { base_dir.join(expanded) } else { expanded };
                    for file in expand_include_glob(&pat) {
                        parse_config_file(&file, alias, port_override, user_override, out, depth + 1);
                    }
                }
            }
            "hostname" => {
                if out.hostname.is_none() {
                    let raw = strip_quotes(value);
                    out.hostname = Some(raw.replace("%h", alias).replace("%%", "%"));
                }
            }
            "user" => {
                if out.user.is_none() {
                    out.user = Some(strip_quotes(value).to_owned());
                }
            }
            "port" => {
                if out.port.is_none() {
                    out.port = strip_quotes(value).parse().ok();
                }
            }
            "identityfile" => {
                let raw = strip_quotes(value);
                if !raw.is_empty() && !raw.eq_ignore_ascii_case("none") {
                    out.identity_files.push(raw.to_owned());
                }
            }
            // Whichever of `ProxyJump` and `ProxyCommand` comes first wins, as in OpenSSH.
            "proxyjump" => {
                if out.proxy_jump.is_none() && out.proxy_command.is_none() {
                    out.proxy_jump = Some(strip_quotes(value).to_owned());
                }
            }
            "proxycommand" => {
                if out.proxy_command.is_none() && out.proxy_jump.is_none() {
                    out.proxy_command = Some(strip_quotes(value).to_owned());
                }
            }
            "stricthostkeychecking" => {
                if out.host_key_policy.is_none() {
                    out.host_key_policy = Some(match strip_quotes(value).to_ascii_lowercase().as_str() {
                        "no" | "off" | "false" => HostKeyPolicy::Off,
                        "accept-new" => HostKeyPolicy::AcceptNew,
                        _ => HostKeyPolicy::Ask,
                    });
                }
            }
            "userknownhostsfile" => {
                if out.user_known_hosts_file.is_none()
                    && let Some(first) = split_args(value).into_iter().next()
                {
                    out.user_known_hosts_file = Some(first);
                }
            }
            _ => {}
        }
    }
}

/// One `~/.ssh/config` lookup (a missing or unreadable file means defaults).
fn config_hop(
    config: Option<&Path>,
    alias: &str,
    port_override: Option<u16>,
    user_override: Option<&str>,
) -> (Hop, Option<String>) {
    let mut raw = RawConfig::default();
    if let Some(p) = config {
        parse_config_file(p, alias, port_override, user_override, &mut raw, 0);
    }
    let local = local_user();
    let host = raw.hostname.unwrap_or_else(|| alias.to_owned());
    let port = port_override.or(raw.port).unwrap_or(22);
    let user = user_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or(raw.user)
        .unwrap_or_else(|| local.clone());
    let identity_files =
        raw.identity_files.iter().map(|p| expand(&expand_tokens(p, alias, &host, port, &user, &local))).collect();
    let proxy_command = raw
        .proxy_command
        .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case("none"))
        .map(|c| expand_tokens(&c, alias, &host, port, &user, &local));
    let proxy_jump = raw.proxy_jump.filter(|j| !j.is_empty() && !j.eq_ignore_ascii_case("none"));
    let (known_hosts, null_known_hosts) = match raw.user_known_hosts_file.as_deref() {
        Some(kh) if kh.eq_ignore_ascii_case("none") || kh == "/dev/null" || kh.eq_ignore_ascii_case("nul") => {
            (None, true)
        }
        Some(kh) => (Some(expand(&expand_tokens(kh, alias, &host, port, &user, &local))), false),
        None => (None, false),
    };
    let host_key_policy =
        if null_known_hosts { HostKeyPolicy::Off } else { raw.host_key_policy.unwrap_or(HostKeyPolicy::Ask) };
    let hop = Hop { host, port, user, identity_files, proxy_command, host_key_policy, known_hosts };
    (hop, proxy_jump)
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
    let (hop, _) = config_hop(config, host, port, user);
    hop
}

/// The SSH hosts to go through, the target last.
pub(crate) fn resolve_hops(target: &SshTarget, config: Option<&Path>) -> IdeResult<Vec<Hop>> {
    let host = target.host.trim();
    if host.is_empty() {
        return Err(IdeError::invalid("SSH host is empty"));
    }
    let user_override = Some(target.user.trim()).filter(|u| !u.is_empty());
    let (hop, proxy_jump) = if target.auth == SshAuth::OpenSsh {
        config_hop(config, host, target.port, user_override)
    } else {
        (
            Hop {
                host: host.to_owned(),
                port: target.port.unwrap_or(22),
                user: user_override.map(str::to_owned).unwrap_or_else(local_user),
                identity_files: Vec::new(),
                proxy_command: None,
                host_key_policy: HostKeyPolicy::Ask,
                known_hosts: None,
            },
            None,
        )
    };
    let mut hops: Vec<Hop> = if hop.proxy_command.is_some() {
        Vec::new()
    } else {
        proxy_jump
            .map(|j| j.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| jump_hop(config, s)).collect())
            .unwrap_or_default()
    };
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
    fn resolves_include_match_equals_and_proxy_command() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("ssh.d");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("coder.conf"),
            "Host coder-vscode--*\n  ProxyCommand /bin/coder ssh --stdio %h\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n",
        )
        .unwrap();
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            "Include \"ssh.d/*.conf\"\n\nHost *.coder\n\tConnectTimeout=0\n\tStrictHostKeyChecking=no\n\tUserKnownHostsFile=/dev/null\n\nMatch host *.coder !exec \"false\"\n\tProxyCommand /opt/homebrew/bin/coder --global-config \"/path with spaces/coderv2\" ssh --stdio --hostname-suffix coder %h %p %r\n",
        )
        .unwrap();

        let target = SshTarget {
            host: "deng-devbox.coder".into(),
            port: Some(22),
            user: "dengliu".into(),
            auth: SshAuth::OpenSsh,
            ..Default::default()
        };
        let hops = resolve_hops(&target, Some(&config)).unwrap();
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].host, "deng-devbox.coder");
        assert_eq!(hops[0].port, 22);
        assert_eq!(hops[0].user, "dengliu");
        assert_eq!(hops[0].host_key_policy, HostKeyPolicy::Off);
        assert_eq!(hops[0].known_hosts, None);
        assert_eq!(
            hops[0].proxy_command.as_deref(),
            Some(
                "/opt/homebrew/bin/coder --global-config \"/path with spaces/coderv2\" ssh --stdio --hostname-suffix coder deng-devbox.coder 22 dengliu"
            )
        );

        let included = SshTarget {
            host: "coder-vscode--devbox".into(),
            user: "coder".into(),
            auth: SshAuth::OpenSsh,
            ..Default::default()
        };
        let hops = resolve_hops(&included, Some(&config)).unwrap();
        assert_eq!(hops[0].proxy_command.as_deref(), Some("/bin/coder ssh --stdio coder-vscode--devbox"));
        assert_eq!(hops[0].host_key_policy, HostKeyPolicy::Off);
    }

    #[test]
    fn the_first_of_proxy_jump_and_proxy_command_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            "Host a\n  ProxyJump bastion\n  ProxyCommand nc %h %p\nHost b\n  ProxyCommand nc %h %p\n  ProxyJump bastion\n",
        )
        .unwrap();
        let target = |host: &str| SshTarget { host: host.into(), auth: SshAuth::OpenSsh, ..Default::default() };
        let hops = resolve_hops(&target("a"), Some(&config)).unwrap();
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].host, "bastion");
        assert_eq!(hops[1].proxy_command, None);
        let hops = resolve_hops(&target("b"), Some(&config)).unwrap();
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].proxy_command.as_deref(), Some("nc b 22"));
    }

    #[test]
    fn strict_host_key_checking_values() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            "Host new\n  StrictHostKeyChecking accept-new\nHost off\n  StrictHostKeyChecking=no\n\
             Host ask\n  StrictHostKeyChecking ask\nHost null\n  UserKnownHostsFile /dev/null\n\
             Match exec \"exit 1\"\n  StrictHostKeyChecking no\n",
        )
        .unwrap();
        let policy = |host: &str| {
            let target = SshTarget { host: host.into(), auth: SshAuth::OpenSsh, ..Default::default() };
            resolve_hops(&target, Some(&config)).unwrap()[0].host_key_policy
        };
        assert_eq!(policy("new"), HostKeyPolicy::AcceptNew);
        assert_eq!(policy("off"), HostKeyPolicy::Off);
        assert_eq!(policy("ask"), HostKeyPolicy::Ask);
        assert_eq!(policy("null"), HostKeyPolicy::Off);
        assert_eq!(policy("other"), HostKeyPolicy::Ask);
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
