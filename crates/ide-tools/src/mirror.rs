//! Download mirrors: user-configured proxy prefixes the installer tries, in order, when an
//! official host is slow or unreachable (Tools › Download sources).
//!
//! The official URL is appended to the prefix unchanged, which is what the public GitHub
//! proxies speak. Only `github.com` is mirrored: those proxies hard-code that host, so an
//! Eclipse or Open VSX address through one answers 502. Hosts that carry credentials are
//! never mirrored either — the GitHub token must not reach a third party.

use ide_core::settings::ToolDownloadSettings;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

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

/// The mirror entries of the setting: prefixes separated by commas or whitespace, in the
/// order given, without the ones that are not URLs and without repeats.
pub fn mirrors(setting: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for entry in setting.split(|c: char| c == ',' || c.is_whitespace()).filter(|e| !e.is_empty()) {
        if prefix(entry).is_some() && !out.iter().any(|seen| prefix(seen) == prefix(entry)) {
            out.push(entry);
        }
    }
    out
}

/// How long a mirror that failed to deliver waits behind the others.
const FAILED_FOR: Duration = Duration::from_secs(10 * 60);

/// Mirrors whose last download failed, with when: tried after the ones that have not.
static FAILED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Records how a download through `mirror` went. A mirror that could not deliver moves behind
/// the others for a while, so the next downloads don't each wait for it to time out first;
/// a success puts it back in its place.
pub fn report(mirror: &str, delivered: bool) {
    let Some(key) = prefix(mirror) else { return };
    let mut failed = FAILED.lock();
    let failed = failed.get_or_insert_with(HashMap::new);
    if delivered {
        failed.remove(&key);
    } else {
        failed.insert(key, Instant::now());
    }
}

fn recently_failed(mirror: &str) -> bool {
    let Some(key) = prefix(mirror) else { return false };
    FAILED.lock().as_ref().and_then(|f| f.get(&key)).is_some_and(|at| at.elapsed() < FAILED_FOR)
}

/// The URLs to try for `url`: each configured mirror in order, then the official host.
///
/// Configured mirrors are tried first — the user set them because the official host is slow, so
/// waiting for that host to fail first would defeat the point. A mirror that failed recently
/// ([`report`]) goes after the others. The official host stays last as the fallback, and with
/// no mirror the list is exactly `[url]`, so an unconfigured IDE downloads as it always did.
pub fn candidates(url: &str, settings: &ToolDownloadSettings) -> Vec<Candidate> {
    let (mut fresh, mut failed): (Vec<Candidate>, Vec<Candidate>) = mirrors(&settings.github_mirror)
        .into_iter()
        .filter_map(|mirror| Some(Candidate { url: through(url, mirror)?, mirror: Some(mirror.to_owned()) }))
        .partition(|c| !c.mirror.as_deref().is_some_and(recently_failed));
    fresh.append(&mut failed);
    fresh.push(Candidate { url: url.to_owned(), mirror: None });
    fresh
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
    fn several_mirrors_are_tried_in_order_before_the_official_host() {
        let candidates = candidates(ASSET, &settings("https://a.test/, https://b.test\n  https://a.test  ftp://x"));
        let sources: Vec<_> = candidates.iter().map(Candidate::describe).collect();
        assert_eq!(sources, ["https://a.test/", "https://b.test", "the official source"]);
        assert_eq!(candidates[1].url, format!("https://b.test/{ASSET}"));
    }

    #[test]
    fn a_mirror_that_failed_goes_behind_the_others_until_it_delivers() {
        let setting = settings("https://first.fail.test https://second.fail.test");
        let order = || candidates(ASSET, &setting).iter().map(|c| c.describe().to_owned()).collect::<Vec<_>>();
        report("https://first.fail.test/", false);
        assert_eq!(order(), ["https://second.fail.test", "https://first.fail.test", "the official source"]);
        report("https://first.fail.test", true);
        assert_eq!(order(), ["https://first.fail.test", "https://second.fail.test", "the official source"]);
    }

    #[test]
    fn an_already_prefixed_url_is_not_prefixed_twice() {
        let once = through(ASSET, "https://gh-proxy.com").unwrap();
        assert_eq!(through(&once, "https://gh-proxy.com"), None);
    }
}
