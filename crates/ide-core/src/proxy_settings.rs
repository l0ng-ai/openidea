//! Appearance & Behavior › System Settings › HTTP Proxy, and the proxy the IDE's own
//! connections use: [`set_proxy`] makes a configuration current, every outgoing
//! request asks [`proxy`] (the HTTP client, `curl` downloads, the updater), and with a
//! manual proxy child processes get `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::OsString;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    /// Every connection goes direct.
    None,
    /// The system's proxy: `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` of the environment.
    #[default]
    Auto,
    /// The proxy configured here.
    Manual,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProxyKind {
    #[default]
    Http,
    Socks,
}

impl ProxyKind {
    pub fn default_port(self) -> u16 {
        match self {
            ProxyKind::Http => 80,
            ProxyKind::Socks => 1080,
        }
    }

    fn scheme(self) -> &'static str {
        match self {
            ProxyKind::Http => "http",
            // Host names resolve on the proxy.
            ProxyKind::Socks => "socks5h",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ProxySettings {
    pub mode: ProxyMode,
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    /// Hosts reached directly, comma-separated; `*` matches any characters (`*.example.com`, `192.168.*`).
    pub no_proxy: String,
    /// Send `login` / `password` to the proxy.
    pub authenticate: bool,
    pub login: String,
    /// Kept in the saved passwords rather than `settings.toml`; filled in when settings are read.
    pub password: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Auto,
            kind: ProxyKind::Http,
            host: String::new(),
            port: ProxyKind::Http.default_port(),
            no_proxy: String::new(),
            authenticate: false,
            login: String::new(),
            password: String::new(),
        }
    }
}

impl std::fmt::Debug for ProxySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxySettings")
            .field("mode", &self.mode)
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("no_proxy", &self.no_proxy)
            .field("authenticate", &self.authenticate)
            .field("login", &self.login)
            .field("password", &if self.password.is_empty() { "" } else { "***" })
            .finish()
    }
}

/// How a connection to some host is made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyRoute {
    Direct,
    /// Whatever the environment says (the HTTP library's / `curl`'s own proxy lookup).
    System,
    /// Through this proxy URL, credentials included (`http://user:pass@proxy:3128`).
    Via(String),
}

/// Loopback hosts never go through the manual proxy.
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

impl ProxySettings {
    /// A manual proxy with a host: what [`Self::route`] sends connections through.
    pub fn manual(&self) -> bool {
        self.mode == ProxyMode::Manual && !self.host.trim().is_empty()
    }

    /// What is wrong with the manual configuration, if anything.
    pub fn problem(&self) -> Option<String> {
        if self.mode != ProxyMode::Manual {
            return None;
        }
        let host = self.host.trim();
        if host.is_empty() {
            return Some("Proxy host is empty".into());
        }
        if host.contains(['/', '@', ' ']) {
            return Some(format!("Invalid proxy host: {host}"));
        }
        if self.port == 0 {
            return Some("Proxy port must be between 1 and 65535".into());
        }
        if self.authenticate && self.login.trim().is_empty() {
            return Some("Proxy login is empty".into());
        }
        None
    }

    /// Whether `host` is reached directly: loopback, or a "No proxy for" entry.
    pub fn bypasses(&self, host: &str) -> bool {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        if LOOPBACK.contains(&host.as_str()) {
            return true;
        }
        self.no_proxy_entries().any(|pattern| glob_match(&pattern, &host))
    }

    fn no_proxy_entries(&self) -> impl Iterator<Item = String> + '_ {
        self.no_proxy.split([',', ';', '\n']).map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty())
    }

    /// The manual proxy as a URL, with the credentials when it authenticates.
    pub fn proxy_url(&self) -> Option<String> {
        if !self.manual() {
            return None;
        }
        let host = self.host.trim();
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_owned() };
        let auth = if self.authenticate && !self.login.is_empty() {
            format!("{}:{}@", encode_userinfo(&self.login), encode_userinfo(&self.password))
        } else {
            String::new()
        };
        Some(format!("{}://{auth}{host}:{}", self.kind.scheme(), self.port))
    }

    /// How to connect to `host` (`None`: not known yet, e.g. the request has no URL).
    pub fn route(&self, host: Option<&str>) -> ProxyRoute {
        match self.mode {
            ProxyMode::None => ProxyRoute::Direct,
            ProxyMode::Auto => ProxyRoute::System,
            ProxyMode::Manual => match self.proxy_url() {
                Some(_) if host.is_some_and(|h| self.bypasses(h)) => ProxyRoute::Direct,
                Some(url) => ProxyRoute::Via(url),
                None => ProxyRoute::Direct,
            },
        }
    }

    /// [`Self::route`] for the host of `url` (`https://user@host:443/path`).
    pub fn route_for_url(&self, url: &str) -> ProxyRoute {
        self.route(url_host(url).as_deref())
    }

    /// Arguments that make a `curl` download of `url` follow this configuration. The
    /// manual proxy itself comes from the environment (see [`Self::child_env`]), which
    /// keeps the credentials out of the command line.
    pub fn curl_args(&self, url: &str) -> Vec<&'static str> {
        match self.route_for_url(url) {
            ProxyRoute::Direct => vec!["--noproxy", "*"],
            ProxyRoute::System => Vec::new(),
            // Only this configuration decides what bypasses the proxy.
            ProxyRoute::Via(_) => vec!["--noproxy", ""],
        }
    }

    /// Variables child processes get with a manual proxy (`HTTP_PROXY`, `HTTPS_PROXY`,
    /// `ALL_PROXY`, `NO_PROXY` and their lowercase forms); none otherwise.
    pub fn child_env(&self) -> Vec<(OsString, Option<OsString>)> {
        let Some(url) = self.proxy_url() else { return Vec::new() };
        let mut no_proxy: Vec<String> = LOOPBACK.iter().map(|h| (*h).to_owned()).collect();
        // `*.example.com` is `.example.com` to curl, Go, Python and Node.
        no_proxy.extend(self.no_proxy_entries().map(|e| e.strip_prefix('*').map(str::to_owned).unwrap_or(e)));
        no_proxy.dedup();
        let no_proxy = no_proxy.join(",");
        let mut env = Vec::new();
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            env.push((OsString::from(name), Some(OsString::from(&url))));
            env.push((OsString::from(name.to_ascii_lowercase()), Some(OsString::from(&url))));
        }
        env.push((OsString::from("NO_PROXY"), Some(OsString::from(&no_proxy))));
        env.push((OsString::from("no_proxy"), Some(OsString::from(no_proxy))));
        env
    }
}

/// Case-insensitive host glob (`pattern` is lowercase): `*` matches any run of characters.
fn glob_match(pattern: &str, host: &str) -> bool {
    let (p, h) = (pattern.as_bytes(), host.as_bytes());
    let (mut pi, mut hi) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while hi < h.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some((pi, hi));
            pi += 1;
        } else if pi < p.len() && p[pi] == h[hi] {
            pi += 1;
            hi += 1;
        } else if let Some((sp, sh)) = star {
            pi = sp + 1;
            hi = sh + 1;
            star = Some((sp, sh + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

fn encode_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The host of `url`, without brackets, userinfo or port.
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let host =
        if let Some(v6) = authority.strip_prefix('[') { v6.split(']').next()? } else { authority.split(':').next()? };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

static CURRENT: RwLock<Option<Arc<ProxySettings>>> = RwLock::new(None);

/// Makes `settings` (password filled in) the proxy of every later connection and child process.
pub fn set_proxy(settings: ProxySettings) {
    *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(settings));
}

/// The current proxy configuration (the default, auto-detect, until [`set_proxy`]).
pub fn proxy() -> Arc<ProxySettings> {
    CURRENT.read().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual(host: &str, port: u16) -> ProxySettings {
        ProxySettings { mode: ProxyMode::Manual, host: host.into(), port, ..Default::default() }
    }

    #[test]
    fn auto_is_the_default_and_defers_to_the_system() {
        let p = ProxySettings::default();
        assert_eq!(p.mode, ProxyMode::Auto);
        assert_eq!(p.route_for_url("https://example.com/"), ProxyRoute::System);
        assert!(p.curl_args("https://example.com/").is_empty());
        assert!(p.child_env().is_empty());
        assert_eq!(p.problem(), None);
    }

    #[test]
    fn no_proxy_goes_direct() {
        let p = ProxySettings { mode: ProxyMode::None, ..manual("proxy", 3128) };
        assert_eq!(p.route_for_url("https://example.com/"), ProxyRoute::Direct);
        assert_eq!(p.curl_args("https://example.com/"), ["--noproxy", "*"]);
        assert!(p.child_env().is_empty());
    }

    #[test]
    fn manual_http_and_socks_urls() {
        let p = manual("proxy.corp", 3128);
        assert_eq!(p.route_for_url("https://example.com/x"), ProxyRoute::Via("http://proxy.corp:3128".into()));
        assert_eq!(p.curl_args("https://example.com/x"), ["--noproxy", ""]);
        let socks = ProxySettings { kind: ProxyKind::Socks, ..manual("10.0.0.1", 1080) };
        assert_eq!(socks.proxy_url().as_deref(), Some("socks5h://10.0.0.1:1080"));
        assert_eq!(manual("::1", 8080).proxy_url().as_deref(), Some("http://[::1]:8080"));
        // Manual without a host connects directly.
        assert_eq!(manual(" ", 80).route(Some("example.com")), ProxyRoute::Direct);
        assert!(manual(" ", 80).problem().is_some());
        assert!(manual("proxy", 0).problem().is_some());
        assert!(manual("http://proxy", 80).problem().is_some());
    }

    #[test]
    fn credentials_are_percent_encoded() {
        let p = ProxySettings {
            authenticate: true,
            login: "dom\\me".into(),
            password: "p@ss:w/rd".into(),
            ..manual("proxy", 3128)
        };
        assert_eq!(p.proxy_url().as_deref(), Some("http://dom%5Cme:p%40ss%3Aw%2Frd@proxy:3128"));
        // Not sent without "Proxy authentication".
        let off = ProxySettings { authenticate: false, ..p.clone() };
        assert_eq!(off.proxy_url().as_deref(), Some("http://proxy:3128"));
        assert!(ProxySettings { login: " ".into(), ..p.clone() }.problem().is_some());
        assert!(!format!("{p:?}").contains("p@ss"));
    }

    #[test]
    fn no_proxy_for_list_matches_globs_and_loopback() {
        let p = ProxySettings { no_proxy: "*.example.com, 192.168.*,Intranet".into(), ..manual("proxy", 3128) };
        assert!(p.bypasses("api.example.com"));
        assert!(p.bypasses("a.b.EXAMPLE.com"));
        assert!(!p.bypasses("example.com"));
        assert!(!p.bypasses("example.com.evil.org"));
        assert!(p.bypasses("192.168.1.20"));
        assert!(p.bypasses("intranet"));
        assert!(!p.bypasses("intranet2"));
        assert!(p.bypasses("localhost") && p.bypasses("127.0.0.1") && p.bypasses("[::1]"));
        assert_eq!(p.route_for_url("https://user@api.example.com:8443/v1"), ProxyRoute::Direct);
        assert_eq!(p.curl_args("http://192.168.0.5/"), ["--noproxy", "*"]);
        assert!(matches!(p.route_for_url("https://github.com"), ProxyRoute::Via(_)));
    }

    #[test]
    fn child_processes_get_the_manual_proxy() {
        let p = ProxySettings {
            no_proxy: "*.corp, 10.*".into(),
            authenticate: true,
            login: "me".into(),
            password: "pw".into(),
            ..manual("proxy", 3128)
        };
        let env = p.child_env();
        let get = |k: &str| env.iter().find(|(n, _)| n == k).and_then(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("HTTPS_PROXY"), "http://me:pw@proxy:3128");
        assert_eq!(get("http_proxy"), "http://me:pw@proxy:3128");
        assert_eq!(get("NO_PROXY"), "localhost,127.0.0.1,::1,.corp,10.*");
    }

    #[test]
    fn url_hosts() {
        assert_eq!(url_host("https://Example.com:443/a?b").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://u:p@[::1]:80/").as_deref(), Some("::1"));
        assert_eq!(url_host("example.com/x").as_deref(), Some("example.com"));
        assert_eq!(url_host("file:///tmp/x"), None);
    }
}
