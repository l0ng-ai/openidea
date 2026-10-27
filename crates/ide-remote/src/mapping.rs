//! Local ↔ remote paths of a deployment server's mappings, and excluded names.

use globset::{Glob, GlobSet, GlobSetBuilder};
use ide_core::remote_settings::{DeploymentServer, DeploymentSettings};
use ide_ssh::sftp::join;
use std::path::{Component, Path, PathBuf};

/// A server's mappings resolved against the project and the server root.
#[derive(Debug, Clone)]
pub struct Mappings {
    root: PathBuf,
    /// (absolute local folder, absolute remote folder, web path), longest local first.
    entries: Vec<(PathBuf, String, String)>,
    web_url: String,
}

/// `a/b` (POSIX) of a relative path.
pub fn posix(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

impl Mappings {
    /// `remote_root` is the server root resolved on the host (its login
    /// directory when the setting is empty). A server without mappings maps the
    /// project root onto the server root.
    pub fn new(server: &DeploymentServer, project_root: &Path, remote_root: &str) -> Self {
        let mut entries: Vec<(PathBuf, String, String)> = server
            .mappings
            .iter()
            .map(|m| {
                let local = m.local.trim().trim_matches('/');
                let local = if local.is_empty() { project_root.to_path_buf() } else { project_root.join(local) };
                // Relative to the server root, with or without a leading `/`.
                let deployment = m.deployment.trim().trim_start_matches("./").trim_matches('/');
                let remote = if deployment.is_empty() { remote_root.to_owned() } else { join(remote_root, deployment) };
                (local, remote.trim_end_matches('/').to_owned(), m.web.trim().trim_matches('/').to_owned())
            })
            .collect();
        if entries.is_empty() {
            entries.push((project_root.to_path_buf(), remote_root.trim_end_matches('/').to_owned(), String::new()));
        }
        entries.sort_by_key(|(l, _, _)| std::cmp::Reverse(l.components().count()));
        Self {
            root: project_root.to_path_buf(),
            entries,
            web_url: server.web_url.trim().trim_end_matches('/').to_owned(),
        }
    }

    pub fn project_root(&self) -> &Path {
        &self.root
    }

    /// The remote path of a local file or folder (`None`: not under any mapping).
    pub fn remote(&self, local: &Path) -> Option<String> {
        self.entries.iter().find_map(|(l, r, _)| {
            let rel = local.strip_prefix(l).ok()?;
            // `..` would leave the mapping (`posix` drops it).
            if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
                return None;
            }
            let rel = posix(rel);
            Some(if rel.is_empty() { r.clone() } else { join(r, &rel) })
        })
    }

    /// `remote` is the remote folder of a mapping (deleting it would wipe the deployment).
    pub fn is_root(&self, remote: &str) -> bool {
        let remote = remote.trim_end_matches('/');
        self.entries.iter().any(|(_, r, _)| r.trim_end_matches('/') == remote)
    }

    /// The local path of a remote file or folder (`None`: not under any mapping).
    pub fn local(&self, remote: &str) -> Option<PathBuf> {
        let remote = remote.trim_end_matches('/');
        let mut best: Option<(&PathBuf, &str, usize)> = None;
        for (l, r, _) in &self.entries {
            let rest = if remote == r {
                ""
            } else if let Some(rest) = remote.strip_prefix(r.as_str()).and_then(|x| x.strip_prefix('/')) {
                rest
            } else if r.is_empty() || r == "/" {
                remote.trim_start_matches('/')
            } else {
                continue;
            };
            if best.is_none_or(|(_, _, len)| r.len() > len) {
                best = Some((l, rest, r.len()));
            }
        }
        let (l, rest, _) = best?;
        // A `..` from the server must not leave the local folder.
        if rest.split('/').any(|s| s == ".." || s == ".") {
            return None;
        }
        Some(rest.split('/').filter(|s| !s.is_empty()).fold(l.clone(), |p, s| p.join(s)))
    }

    /// The web URL of a local file (`None` without a server URL or mapping).
    pub fn web_url(&self, local: &Path) -> Option<String> {
        if self.web_url.is_empty() {
            return None;
        }
        self.entries.iter().find_map(|(l, _, web)| {
            let rel = posix(local.strip_prefix(l).ok()?);
            let path =
                [web.as_str(), rel.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/");
            Some(if path.is_empty() { format!("{}/", self.web_url) } else { format!("{}/{path}", self.web_url) })
        })
    }
}

/// Settings › Deployment › Options "Exclude items by name".
#[derive(Debug, Clone)]
pub struct Excludes {
    names: GlobSet,
    /// Remote paths (absolute) never touched.
    remote: Vec<String>,
}

impl Excludes {
    pub fn new(settings: &DeploymentSettings, server: &DeploymentServer, remote_root: &str) -> Self {
        let mut b = GlobSetBuilder::new();
        for pattern in settings.exclude.iter().flat_map(|p| p.split(';')).map(str::trim).filter(|p| !p.is_empty()) {
            match Glob::new(pattern) {
                Ok(g) => {
                    b.add(g);
                }
                Err(e) => tracing::warn!("deployment exclude {pattern:?}: {e}"),
            }
        }
        let remote = server
            .excluded_paths
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| join(remote_root, p.trim_start_matches('/')).trim_end_matches('/').to_owned())
            .collect();
        Self { names: b.build().unwrap_or_else(|_| GlobSet::empty()), remote }
    }

    pub fn name(&self, name: &str) -> bool {
        self.names.is_match(name)
    }

    /// Any component of `rel` (relative to the project) is excluded by name.
    pub fn local(&self, rel: &Path) -> bool {
        rel.components().any(|c| matches!(c, Component::Normal(s) if self.name(&s.to_string_lossy())))
    }

    pub fn remote(&self, path: &str) -> bool {
        let path = path.trim_end_matches('/');
        path.rsplit('/').next().is_some_and(|n| self.name(n))
            || self
                .remote
                .iter()
                .any(|r| path == r || path.strip_prefix(r.as_str()).is_some_and(|x| x.starts_with('/')))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::remote_settings::DeploymentMapping;

    fn server(mappings: Vec<(&str, &str, &str)>) -> DeploymentServer {
        DeploymentServer {
            web_url: "https://example.com/app/".into(),
            mappings: mappings
                .into_iter()
                .map(|(l, d, w)| DeploymentMapping { local: l.into(), deployment: d.into(), web: w.into() })
                .collect(),
            excluded_paths: vec!["logs".into()],
            ..Default::default()
        }
    }

    #[test]
    fn maps_paths_both_ways_by_the_longest_mapping() {
        let root = Path::new("/p");
        let m = Mappings::new(&server(vec![("", "www", ""), ("static", "/cdn/assets/", "s")]), root, "/home/me");
        assert_eq!(m.remote(Path::new("/p/src/a.py")).as_deref(), Some("/home/me/www/src/a.py"));
        assert_eq!(m.remote(Path::new("/p/static/x.css")).as_deref(), Some("/home/me/cdn/assets/x.css"));
        assert_eq!(m.remote(Path::new("/p")).as_deref(), Some("/home/me/www"));
        assert_eq!(m.remote(Path::new("/elsewhere/a")), None);
        assert_eq!(m.local("/home/me/www/src/a.py"), Some(PathBuf::from("/p/src/a.py")));
        assert_eq!(m.local("/home/me/cdn/assets/x.css"), Some(PathBuf::from("/p/static/x.css")));
        assert_eq!(m.local("/var/other"), None);
        assert_eq!(m.web_url(Path::new("/p/static/x.css")).as_deref(), Some("https://example.com/app/s/x.css"));
        assert_eq!(m.web_url(Path::new("/p/index.html")).as_deref(), Some("https://example.com/app/index.html"));
    }

    #[test]
    fn without_mappings_the_project_root_maps_onto_the_server_root() {
        let m = Mappings::new(&server(vec![]), Path::new("/p"), "/srv/app");
        assert_eq!(m.remote(Path::new("/p/a/b.txt")).as_deref(), Some("/srv/app/a/b.txt"));
        assert_eq!(m.local("/srv/app"), Some(PathBuf::from("/p")));
    }

    #[test]
    fn excludes_names_and_remote_paths() {
        let settings =
            DeploymentSettings { exclude: vec![".git;*.pyc".into(), "node_modules".into()], ..Default::default() };
        let x = Excludes::new(&settings, &server(vec![]), "/srv");
        assert!(x.local(Path::new("src/.git/config")));
        assert!(x.local(Path::new("a/b.pyc")));
        assert!(x.local(Path::new("node_modules/x")));
        assert!(!x.local(Path::new("src/main.py")));
        assert!(x.remote("/srv/logs/today.log"));
        assert!(x.remote("/srv/logs"));
        assert!(!x.remote("/srv/logsx"));
    }
}
