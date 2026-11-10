use super::{
    RawConfig, SshFiles, eval_match, expand, expand_include_glob, pattern_list_matches, split_args, split_directive,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct ConfigCache {
    loaded_at: Option<Instant>,
    files: HashMap<PathBuf, Option<Arc<str>>>,
    includes: HashMap<PathBuf, Vec<PathBuf>>,
}

impl ConfigCache {
    fn read(&mut self, path: &Path) -> Option<Arc<str>> {
        self.files.entry(path.to_owned()).or_insert_with(|| std::fs::read_to_string(path).ok().map(Arc::from)).clone()
    }

    fn includes(&mut self, pattern: &Path) -> Vec<PathBuf> {
        self.includes.entry(pattern.to_owned()).or_insert_with(|| expand_include_glob(pattern)).clone()
    }
}

struct RemoteConfig<'a> {
    alias: &'a str,
    port: Option<u16>,
    user: Option<&'a str>,
    directory: &'a Path,
    active: bool,
    raw: RawConfig,
}

impl RemoteConfig<'_> {
    fn read(&mut self, path: &Path, cache: &mut ConfigCache, depth: usize) -> Option<()> {
        if depth >= 8 {
            return Some(());
        }
        let Some(contents) = cache.read(path) else { return Some(()) };
        for line in contents.lines() {
            let line = without_comment(line)?;
            let Some((key, value)) = split_directive(line) else {
                if !line.trim().is_empty() {
                    return None;
                }
                continue;
            };
            let args = split_args(value);
            match key.to_ascii_lowercase().as_str() {
                "host" => self.active = pattern_list_matches(args.iter().map(String::as_str), self.alias),
                "match" => {
                    // Host detection has no canonical/final pass and never evaluates commands, even negated ones.
                    self.active =
                        !args.iter().any(|a| matches!(a.to_ascii_lowercase().as_str(), "canonical" | "final"))
                            && eval_match(value, self.alias, self.port, self.user, &self.raw, false);
                }
                _ if !self.active => {}
                "include" => {
                    for arg in args {
                        let expanded = expand(&arg);
                        let pattern = if expanded.is_relative() { self.directory.join(expanded) } else { expanded };
                        for file in cache.includes(&pattern) {
                            self.read(&file, cache, depth + 1)?;
                        }
                    }
                }
                "hostname" if self.raw.hostname.is_none() => {
                    let [host] = args.as_slice() else { return None };
                    let host = expand_hostname(host, self.alias)?;
                    if !valid_host(&host) {
                        return None;
                    }
                    self.raw.hostname = Some(host);
                }
                "user" if self.raw.user.is_none() => {
                    let [user] = args.as_slice() else { return None };
                    self.raw.user = Some(user.clone());
                }
                "port" if self.raw.port.is_none() => {
                    let [port] = args.as_slice() else { return None };
                    self.raw.port = Some(port.parse().ok().filter(|p| *p != 0)?);
                }
                // Identity files, proxy commands and all other connection options are intentionally ignored.
                _ => {}
            }
        }
        Some(())
    }
}

fn without_comment(line: &str) -> Option<&str> {
    let mut quote = None;
    for (i, ch) in line.char_indices() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch == '#' => return Some(&line[..i]),
            None => {}
        }
    }
    quote.is_none().then_some(line)
}

fn expand_hostname(template: &str, alias: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            out.push(ch);
        } else {
            match chars.next()? {
                'h' => out.push_str(alias),
                '%' => out.push('%'),
                _ => return None,
            }
        }
    }
    Some(out)
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && (host.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || host.parse::<std::net::Ipv6Addr>().is_ok())
}

/// Resolves SSH git remote hosts for forge detection, never for making connections.
/// Reads only `~/.ssh/config` and its Includes, without running commands. File contents and
/// Include expansions are cached for one second, including missing files.
/// `ssh.github.com` (normally port 443) and `altssh.gitlab.com` become their web hosts;
/// explicit users, ports and paths remain unchanged. Non-SSH URLs are returned unchanged.
pub fn resolve_ssh_remote_url(url: &str) -> String {
    static CACHE: OnceLock<Mutex<ConfigCache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Mutex::default).lock();
    if cache.loaded_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(1))
        || cache.files.len() > 128
        || cache.includes.len() > 128
    {
        *cache = ConfigCache { loaded_at: Some(Instant::now()), ..Default::default() };
    }
    resolve(url, SshFiles::default().config.as_deref(), &mut cache)
}

/// Like [`resolve_ssh_remote_url`], using an explicit config file without the shared cache.
pub fn resolve_ssh_remote_url_with(url: &str, config: Option<&Path>) -> String {
    resolve(url, config, &mut ConfigCache::default())
}

fn resolve(url: &str, config: Option<&Path>, cache: &mut ConfigCache) -> String {
    let trimmed = url.trim();
    let (prefix, alias, suffix, port, user) = if let Some((scheme, rest)) = trimmed.split_once("://") {
        if !scheme.eq_ignore_ascii_case("ssh") {
            return url.to_owned();
        }
        let Some((authority, _)) = rest.split_once('/') else { return url.to_owned() };
        let (user, host_port) = authority.rsplit_once('@').map_or((None, authority), |(u, h)| (Some(u), h));
        // Bracketed IPv6 literals have no Host alias to resolve.
        if host_port.starts_with('[') {
            return url.to_owned();
        }
        let (alias, port) = match host_port.split_once(':') {
            Some((host, port)) => {
                let Ok(port) = port.parse::<u16>() else { return url.to_owned() };
                if port == 0 {
                    return url.to_owned();
                }
                (host, Some(port))
            }
            None => (host_port, None),
        };
        let start = scheme.len() + 3 + user.map_or(0, |u| u.len() + 1);
        (&trimmed[..start], alias, &trimmed[start + alias.len()..], port, user)
    } else {
        let Some((left, path)) = trimmed.split_once(':') else { return url.to_owned() };
        if path.is_empty() || left.contains(['/', '\\']) || (left.len() == 1 && path.starts_with(['/', '\\'])) {
            return url.to_owned();
        }
        let (user, alias) = left.rsplit_once('@').map_or((None, left), |(u, h)| (Some(u), h));
        let start = user.map_or(0, |u| u.len() + 1);
        (&trimmed[..start], alias, &trimmed[left.len()..], None, user)
    };
    if !valid_host(alias) || alias.contains(':') {
        return url.to_owned();
    }
    let mut parsed = RemoteConfig {
        alias,
        port,
        user,
        directory: config.and_then(Path::parent).unwrap_or_else(|| Path::new(".")),
        active: true,
        raw: RawConfig::default(),
    };
    if let Some(path) = config
        && parsed.read(path, cache, 0).is_none()
    {
        return url.to_owned();
    }
    let host = parsed.raw.hostname.as_deref().unwrap_or(alias);
    let host = if host.eq_ignore_ascii_case("ssh.github.com") {
        "github.com"
    } else if host.eq_ignore_ascii_case("altssh.gitlab.com") {
        "gitlab.com"
    } else {
        host
    };
    if host == alias {
        return url.to_owned();
    }
    if host.contains(':') { format!("{prefix}[{host}]{suffix}") } else { format!("{prefix}{host}{suffix}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_inspection_never_executes_commands_or_reads_connection_files() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let marker = tmp.path().join("executed");
        let unrelated = tmp.path().join("not-config");
        std::fs::write(&unrelated, "HostName wrong.example\n").unwrap();
        std::fs::write(
            &config,
            format!(
                "Match exec \"touch {}\"\n  HostName wrong.example\n\
                 Match !exec \"touch {}\"\n  HostName wrong.example\n\
                 Host *\n  ProxyCommand touch {}\n  LocalCommand touch {}\n\
                 IdentityFile {}\n  UserKnownHostsFile {}\n  HostName github.com\n",
                marker.display(),
                marker.display(),
                marker.display(),
                marker.display(),
                unrelated.display(),
                unrelated.display(),
            ),
        )
        .unwrap();
        let mut cache = ConfigCache::default();
        assert_eq!(resolve("git@alias:o/r", Some(&config), &mut cache), "git@github.com:o/r");
        assert!(!marker.exists());
        assert_eq!(cache.files.keys().collect::<Vec<_>>(), [&config]);
    }

    #[test]
    fn includes_are_ordered_conditional_and_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(tmp.path().join("b.conf"), "Host *\n  HostName wrong.example\n").unwrap();
        std::fs::write(tmp.path().join("a.conf"), "Host *\n  HostName github.com\n").unwrap();
        std::fs::write(&config, "Host !alias *\n  Include b.conf\nHost alias\n  Include *.conf\n").unwrap();
        assert_eq!(resolve_ssh_remote_url_with("git@alias:o/r", Some(&config)), "git@github.com:o/r");
        for i in 0..9 {
            std::fs::write(tmp.path().join(format!("level{i}")), format!("Include level{}\n", i + 1)).unwrap();
        }
        std::fs::write(tmp.path().join("level9"), "HostName wrong.example\n").unwrap();
        std::fs::write(&config, "Include level0\nInclude config\nHost alias\n  HostName github.com\n").unwrap();
        let mut cache = ConfigCache::default();
        assert_eq!(resolve("git@alias:o/r", Some(&config), &mut cache), "git@github.com:o/r");
        assert!(!cache.files.contains_key(&tmp.path().join("level7")));
        // Reusing the cache does not reread a file for each remote.
        std::fs::write(&config, "HostName wrong.example\n").unwrap();
        assert_eq!(resolve("git@alias:o/r", Some(&config), &mut cache), "git@github.com:o/r");
    }

    #[test]
    fn explicit_url_fields_and_ssh_host_normalization_are_preserved() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(&config, "Host alias\n  User configured\n  Port 2222\n  HostName ssh.github.com\n").unwrap();
        for (url, expected) in [
            ("ssh://alice@alias:443/o/r.git", "ssh://alice@github.com:443/o/r.git"),
            ("ssh://alias/o/r.git", "ssh://github.com/o/r.git"),
            ("git@alias:/o/r.git", "git@github.com:/o/r.git"),
            ("git@ssh.github.com:o/r.git", "git@github.com:o/r.git"),
            ("ssh://git@altssh.gitlab.com:443/o/r.git", "ssh://git@gitlab.com:443/o/r.git"),
        ] {
            assert_eq!(resolve_ssh_remote_url_with(url, Some(&config)), expected, "{url}");
        }
        std::fs::write(&config, "Host alias\n  HostName 2001:db8::1\n").unwrap();
        assert_eq!(
            resolve_ssh_remote_url_with("ssh://git@alias:2222/o/r", Some(&config)),
            "ssh://git@[2001:db8::1]:2222/o/r"
        );
        std::fs::write(&config, "Host alias\n  HostName %h.example\n").unwrap();
        assert_eq!(resolve_ssh_remote_url_with("git@alias:o/r", Some(&config)), "git@alias.example:o/r");
    }
}
