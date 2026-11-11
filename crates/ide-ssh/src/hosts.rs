//! The concrete `Host` entries of `~/.ssh/config` and its Includes, for picking
//! one in a connection form (Docker's SSH hosts). Wildcard and `Match` blocks
//! never create entries; their values serve as defaults, like `ssh` resolves them,
//! but no command is ever run and nothing but the config files is read.

use crate::target::{SshFiles, expand, expand_include_glob, split_args, split_directive, strip_quotes};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// One `Host` entry of `~/.ssh/config` an `ssh` command line can use by alias.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// The `Host` pattern as written, e.g. `build-server`.
    pub alias: String,
    /// `HostName`, or the alias when the entry has none.
    pub hostname: String,
    /// `User`; empty when unset (`ssh` picks its own default).
    pub user: String,
    /// `Port`; the SSH default (22) when unset.
    pub port: Option<u16>,
    /// `IdentityFile`s in order, `~/` expanded to the home directory.
    pub identity_files: Vec<String>,
}

impl SshConfigHost {
    /// `user@hostname:port` with what is known (the alias when there is no host name).
    pub fn label(&self) -> String {
        let mut s = String::new();
        if !self.user.is_empty() {
            s.push_str(&self.user);
            s.push('@');
        }
        s.push_str(&self.hostname);
        if let Some(p) = self.port {
            s.push_str(&format!(":{p}"));
        }
        s
    }

    /// `ssh://[user@]alias[:port]` for the Docker Engine API URL: the alias stays in
    /// the URL so the system `ssh` that docker runs applies this entry's key, jump
    /// host and the rest.
    pub fn engine_url(&self) -> String {
        let mut url = String::from("ssh://");
        if !self.user.is_empty() {
            url.push_str(&self.user);
            url.push('@');
        }
        url.push_str(&self.alias);
        if let Some(p) = self.port {
            url.push_str(&format!(":{p}"));
        }
        url
    }
}

/// An `alias` a listing can use in an `ssh://…` URL: no option-leading dash, no
/// wildcards, no separators that would break the URL.
fn usable_alias(pattern: &str) -> bool {
    !pattern.is_empty()
        && !pattern.starts_with('-')
        && !pattern.contains(['*', '?', '!', ':', '/', '\\'])
        && pattern.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The values one block sets; the first write of each wins.
#[derive(Default)]
struct Fields {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_files: Vec<String>,
}

impl Fields {
    /// Applies one directive; later calls never overwrite (`ssh` keeps the first value).
    fn set(&mut self, key: &str, args: &[String], alias: &str) {
        match key {
            "hostname" => {
                if self.hostname.is_none()
                    && let Some(raw) = args.first().map(String::as_str)
                {
                    let expanded = expand_tokens(raw, alias);
                    if !expanded.is_empty() && !expanded.starts_with('-') {
                        self.hostname = Some(expanded);
                    }
                }
            }
            "user" => {
                if self.user.is_none()
                    && let Some(user) = args.first().filter(|u| !u.is_empty())
                {
                    self.user = Some(user.clone());
                }
            }
            "port" => {
                if self.port.is_none()
                    && let Some(port) = args.first().and_then(|p| p.parse().ok().filter(|p| *p != 0))
                {
                    self.port = Some(port);
                }
            }
            "identityfile" => {
                for raw in args {
                    if !raw.is_empty() && !raw.eq_ignore_ascii_case("none") {
                        self.identity_files.push(expand(raw).to_string_lossy().into_owned());
                    }
                }
            }
            _ => {}
        }
    }
}

/// A `Host` pattern selecting concrete aliases: no wildcards, no negation.
fn concrete(pattern: &str) -> bool {
    !pattern.starts_with('!') && !pattern.contains(['*', '?'])
}

#[derive(Default)]
struct Listing {
    /// The concrete entries so far, in first-appearance order.
    entries: Vec<(String, Fields)>,
    /// First values of wildcard (`Host *`, `Host *.lan`) blocks, as `ssh` applies
    /// them to every alias.
    defaults: Fields,
}

impl Listing {
    fn read_file(&mut self, path: &Path, depth: usize) {
        if depth >= 8 {
            return;
        }
        let Ok(contents) = std::fs::read_to_string(path) else { return };
        let base_dir = path.parent().unwrap_or_else(|| Path::new(".")).to_owned();
        // The aliases the current `Host` block applies to (`None` after a `Match`,
        // whose conditions a listing cannot decide), plus whether the block also
        // has wildcard patterns, which makes it defaults for every alias.
        let mut aliases: Option<Vec<String>> = None;
        let mut wildcard = false;
        for line in contents.lines() {
            let Some((keyword, value)) = split_directive(line) else { continue };
            let key = keyword.to_ascii_lowercase();
            match key.as_str() {
                "host" => {
                    let patterns = split_args(value);
                    aliases = Some(
                        patterns
                            .iter()
                            .map(String::as_str)
                            .filter(|p| concrete(p))
                            .map(strip_quotes)
                            .map(str::to_owned)
                            .collect(),
                    );
                    wildcard = patterns.iter().any(|p| !concrete(p));
                }
                "match" => {
                    // Never evaluated: a listing must not run commands or guess conditions.
                    aliases = None;
                    wildcard = false;
                }
                "include" => {
                    for raw in split_args(value) {
                        let expanded = expand(&raw);
                        let pattern = if expanded.is_relative() { base_dir.join(expanded) } else { expanded };
                        for file in expand_include_glob(&pattern) {
                            self.read_file(&file, depth + 1);
                        }
                    }
                }
                "hostname" | "user" | "port" | "identityfile" => {
                    let args = split_args(value);
                    if let Some(aliases) = &aliases {
                        for alias in aliases {
                            if let Some(fields) = self.entry_mut(alias) {
                                fields.set(&key, &args, alias);
                            }
                        }
                    }
                    if wildcard {
                        self.defaults.set(&key, &args, "");
                    }
                }
                _ => {}
            }
        }
    }

    fn entry_mut(&mut self, alias: &str) -> Option<&mut Fields> {
        let i = match self.entries.iter().position(|(a, _)| a.eq_ignore_ascii_case(alias)) {
            Some(i) => i,
            None if usable_alias(alias) => {
                self.entries.push((alias.to_owned(), Fields::default()));
                self.entries.len() - 1
            }
            None => return None,
        };
        Some(&mut self.entries[i].1)
    }
}

/// `%h` becomes the alias, `%%` a literal `%`; other tokens stay as written.
fn expand_tokens(template: &str, alias: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            out.push(ch);
        } else {
            match chars.next() {
                Some('h') => out.push_str(alias),
                Some('%') => out.push('%'),
                Some(other) => {
                    out.push('%');
                    out.push(other);
                }
                None => out.push('%'),
            }
        }
    }
    out
}

/// Every concrete `Host` entry of the config file, in file order; entries inherit
/// the first values of wildcard blocks they lack. A missing or unreadable file
/// yields no entries.
pub fn config_hosts(config: Option<&Path>) -> Vec<SshConfigHost> {
    let Some(config) = config else { return Vec::new() };
    let mut listing = Listing::default();
    listing.read_file(config, 0);
    listing
        .entries
        .into_iter()
        .map(|(alias, mut fields)| {
            let hostname =
                fields.hostname.take().or_else(|| listing.defaults.hostname.clone()).unwrap_or_else(|| alias.clone());
            let user = fields.user.take().or_else(|| listing.defaults.user.clone()).unwrap_or_default();
            let port = fields.port.or(listing.defaults.port);
            if fields.identity_files.is_empty() {
                fields.identity_files = listing.defaults.identity_files.clone();
            }
            SshConfigHost { alias, hostname, user, port, identity_files: fields.identity_files }
        })
        .collect()
}

/// The config path `config_hosts` reads by default (`~/.ssh/config`).
pub fn default_config_path() -> Option<PathBuf> {
    SshFiles::default().config
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::write(&config, contents).unwrap();
        (tmp, config)
    }

    fn identity(path: &str) -> String {
        expand(path).to_string_lossy().into_owned()
    }

    #[test]
    fn lists_entries_with_their_fields_in_file_order() {
        let (_tmp, config) = write_config(
            "Host build-server\n  HostName 10.0.0.9\n  User ops\n  Port 2222\n  IdentityFile ~/.ssh/id_build\n\n\
             Host db db-bastion\n  HostName \"10.0.0.5\"\n  User dbops\n\n\
             Host db\n  User later-block-loses\n",
        );
        let hosts = config_hosts(Some(&config));
        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "build-server".into(),
                    hostname: "10.0.0.9".into(),
                    user: "ops".into(),
                    port: Some(2222),
                    identity_files: vec![identity("~/.ssh/id_build")],
                },
                SshConfigHost {
                    alias: "db".into(),
                    hostname: "10.0.0.5".into(),
                    user: "dbops".into(),
                    port: None,
                    identity_files: vec![],
                },
                SshConfigHost {
                    alias: "db-bastion".into(),
                    hostname: "10.0.0.5".into(),
                    user: "dbops".into(),
                    ..Default::default()
                },
            ]
        );
        assert_eq!(hosts[0].label(), "ops@10.0.0.9:2222");
        assert_eq!(hosts[0].engine_url(), "ssh://ops@build-server:2222");
        assert_eq!(hosts[1].engine_url(), "ssh://dbops@db");
        assert_eq!(hosts[2].label(), "dbops@10.0.0.5");
    }

    #[test]
    fn wildcard_blocks_fill_missing_fields_without_creating_entries() {
        let (_tmp, config) = write_config(
            "Host bare\n  HostName bare.example.com\n\n\
             Host *.prod\n  HostName wrong.example\n\n\
             Host *\n  User shared\n  Port 2200\n  IdentityFile ~/.ssh/id_all\n",
        );
        let hosts = config_hosts(Some(&config));
        assert_eq!(
            hosts,
            vec![SshConfigHost {
                alias: "bare".into(),
                hostname: "bare.example.com".into(),
                user: "shared".into(),
                port: Some(2200),
                identity_files: vec![identity("~/.ssh/id_all")],
            }]
        );
    }

    #[test]
    fn match_blocks_are_ignored_and_never_run_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("executed");
        let config = tmp.path().join("config");
        std::fs::write(
            &config,
            format!(
                "Match exec \"touch {}\"\n  HostName wrong.example\n  User wrong\n  Port 1\n  IdentityFile /nope\n\
                 Match final\n  HostName wrong2.example\n\
                 Host real\n  HostName real.example.com\n",
                marker.display()
            ),
        )
        .unwrap();
        let hosts = config_hosts(Some(&config));
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        assert_eq!(hosts[0].hostname, "real.example.com");
        assert!(!marker.exists());
    }

    #[test]
    fn includes_are_followed_and_percent_tokens_expanded() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("parts")).unwrap();
        std::fs::write(
            tmp.path().join("parts/box.conf"),
            "Host included-box\n  HostName %h.example\n  IdentityFile '~/keys/id box'\n",
        )
        .unwrap();
        let config = tmp.path().join("config");
        std::fs::write(&config, "Include parts/*.conf\n\nHost local\n  Port 2223\n").unwrap();
        let hosts = config_hosts(Some(&config));
        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "included-box".into(),
                    hostname: "included-box.example".into(),
                    user: String::new(),
                    port: None,
                    identity_files: vec![identity("~/keys/id box")],
                },
                SshConfigHost {
                    alias: "local".into(),
                    hostname: "local".into(),
                    user: String::new(),
                    port: Some(2223),
                    identity_files: vec![]
                },
            ]
        );
        assert_eq!(hosts[0].engine_url(), "ssh://included-box");
    }

    #[test]
    fn unusable_patterns_are_not_offered() {
        let (_tmp, config) = write_config(
            "*.prod\n  HostName wrong\n\n\
             Host 10.0.0.*\n  HostName wrong\n\n\
             Host -option\n  HostName wrong\n\n\
             Host \"quoted broken\n  HostName wrong\n\n\
             Host keep.me\n  HostName kept.example\n\n\
             Host with:colon\n  HostName wrong\n",
        );
        let hosts = config_hosts(Some(&config));
        assert_eq!(
            hosts,
            vec![SshConfigHost { alias: "keep.me".into(), hostname: "kept.example".into(), ..Default::default() }]
        );
    }

    #[test]
    fn malformed_or_missing_config_yields_no_entries() {
        assert!(config_hosts(None).is_empty());
        let missing = tempfile::tempdir().unwrap().path().join("config");
        assert!(config_hosts(Some(&missing)).is_empty());
        for contents in ["not a directive\n", "\"Host broken\n", ""] {
            let (_tmp, config) = write_config(contents);
            assert!(config_hosts(Some(&config)).is_empty(), "{contents:?}");
        }
    }

    #[test]
    fn valueless_directives_leave_a_usable_entry() {
        let (_tmp, config) = write_config("Host broken\n  HostName\n  Port not-a-number\n");
        assert_eq!(
            config_hosts(Some(&config)),
            vec![SshConfigHost { alias: "broken".into(), hostname: "broken".into(), ..Default::default() }]
        );
    }

    #[test]
    fn token_expansion_keeps_unknown_tokens() {
        assert_eq!(expand_tokens("%h.example", "box"), "box.example");
        assert_eq!(expand_tokens("100%%/%C", "box"), "100%/%C");
        assert_eq!(expand_tokens("%", "box"), "%");
    }
}
