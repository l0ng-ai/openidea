//! Download mirrors: a user-configured proxy prefix the installer tries when an official host
//! is slow or unreachable (Tools › Download sources).
//!
//! The official URL is appended to the prefix unchanged, which is what the public GitHub
//! proxies speak. Only `github.com` is mirrored: those proxies hard-code that host, so an
//! Eclipse or Open VSX address through one answers 502. Hosts that carry credentials are
//! never mirrored either — the GitHub token must not reach a third party.

use ide_core::settings::ToolDownloadSettings;

/// The only host a mirror prefix may be prepended to.
const MIRRORED_PREFIX: &str = "https://github.com/";

/// Where one download is fetched from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub url: String,
    /// The mirror this URL goes through; `None` for the official host.
    pub mirror: Option<String>,
}

impl Candidate {
    /// The source shown to the user in install messages.
    pub fn describe(&self) -> &str {
        match &self.mirror {
            Some(mirror) => mirror,
            None => "the official source",
        }
    }
}

/// The mirror prefix, normalised to end in `/`; `None` when none is set or it is not an
/// `http(s)://` URL.
pub fn prefix(mirror: &str) -> Option<String> {
    let trimmed = mirror.trim();
    let rest = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("http://"))?;
    if rest.split('/').next().unwrap_or("").is_empty() {
        return None;
    }
    Some(if trimmed.ends_with('/') { trimmed.to_owned() } else { format!("{trimmed}/") })
}

/// `url` through `mirror`, or `None` when it is not a source a prefix can carry.
pub fn through(url: &str, mirror: &str) -> Option<String> {
    let prefix = prefix(mirror)?;
    if !url.starts_with(MIRRORED_PREFIX) {
        return None;
    }
    Some(format!("{prefix}{url}"))
}

/// The URLs to try for `url`: the mirror when one is set, then the official host.
///
/// A configured mirror is tried first — the user set it because the official host is slow, so
/// waiting for that host to fail first would defeat the point. The official host stays last as
/// the fallback, and with no mirror the list is exactly `[url]`, so an unconfigured IDE
/// downloads as it always did.
pub fn candidates(url: &str, settings: &ToolDownloadSettings) -> Vec<Candidate> {
    let official = Candidate { url: url.to_owned(), mirror: None };
    match through(url, &settings.github_mirror) {
        Some(mirrored) => vec![Candidate { url: mirrored, mirror: Some(settings.github_mirror.clone()) }, official],
        None => vec![official],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET: &str = "https://github.com/LuaLS/lua-language-server/releases/download/3.13.5/x.zip";

    fn settings(mirror: &str) -> ToolDownloadSettings {
        ToolDownloadSettings { github_mirror: mirror.into() }
    }

    #[test]
    fn no_mirror_keeps_the_official_url_only() {
        assert_eq!(candidates(ASSET, &settings("")), vec![Candidate { url: ASSET.into(), mirror: None }]);
    }

    #[test]
    fn the_prefix_gets_one_trailing_slash() {
        for mirror in ["https://gh-proxy.com", "https://gh-proxy.com/", "  https://gh-proxy.com  "] {
            assert_eq!(
                through(ASSET, mirror).as_deref(),
                Some(
                    "https://gh-proxy.com/https://github.com/LuaLS/lua-language-server/releases/download/3.13.5/x.zip"
                ),
            );
        }
    }

    #[test]
    fn hosts_a_prefix_cannot_carry_stay_official() {
        for url in [
            // The public proxies only answer for github.com; these answer 502 through them.
            "https://download.eclipse.org/jdtls/milestones/1.63.0/x.tar.gz",
            "https://open-vsx.org/api/vscjava/vscode-java-debug/0.60.0/file/x.vsix",
            "https://api.github.com/repos/cli/cli/releases/latest",
            "https://repo1.maven.org/maven2/org/eclipse/lsp4j/1.0.0/x.jar",
        ] {
            assert_eq!(through(url, "https://gh-proxy.com"), None, "{url}");
            assert_eq!(candidates(url, &settings("https://gh-proxy.com")).len(), 1, "{url}");
        }
    }

    #[test]
    fn a_configured_mirror_goes_first() {
        let candidates = candidates(ASSET, &settings("https://gh-proxy.com"));
        assert_eq!(candidates[0].mirror.as_deref(), Some("https://gh-proxy.com"));
        assert_eq!(candidates[1].mirror, None, "the official host is the fallback");
    }

    #[test]
    fn a_prefix_that_is_not_a_url_is_ignored() {
        for mirror in ["gh-proxy.com", "ftp://x", "https://", "   "] {
            assert_eq!(prefix(mirror), None, "{mirror}");
            assert_eq!(through(ASSET, mirror), None, "{mirror}");
        }
    }

    #[test]
    fn an_already_prefixed_url_is_not_prefixed_twice() {
        let once = through(ASSET, "https://gh-proxy.com").unwrap();
        assert_eq!(through(&once, "https://gh-proxy.com"), None);
    }
}
