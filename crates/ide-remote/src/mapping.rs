//! Local ↔ remote paths of a deployment server's mappings, and excluded names.

use globset::{Glob, GlobSet, GlobSetBuilder};
use ide_core::IpcPath;
use ide_core::remote_settings::{DeploymentServer, DeploymentSettings};
use ide_ssh::sftp::join;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// A server's mappings resolved against the project and the server root.
#[derive(Debug, Clone)]
pub struct Mappings {
    root: PathBuf,
    /// (absolute local folder, absolute remote folder, web path), longest local first.
    entries: Vec<(PathBuf, String, String)>,
    web_url: String,
}

/// A mapping resolved by the backend for the Remote Host browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ResolvedMapping {
    pub local: IpcPath,
    pub deployment: String,
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

/// The folder of a mapping's local path: relative to the project (a leading `/` is the
/// project root too), or absolute inside it as IntelliJ's deployment settings write it.
/// An existing outside absolute path is skipped unless its project-relative folder exists.
fn local_folder(local: &str, project_root: &Path) -> Option<PathBuf> {
    let path = Path::new(local);
    if path.is_absolute()
        && let Ok(rel) = path.strip_prefix(project_root)
    {
        return Some(project_root.join(rel));
    }
    // The same folder spelled differently (symlink, letter case).
    if path.is_absolute()
        && let (Ok(path), Ok(root)) = (path.canonicalize(), project_root.canonicalize())
        && let Ok(rel) = path.strip_prefix(root)
    {
        return Some(project_root.join(rel));
    }
    // A Windows drive/UNC prefix must not replace the project root on join.
    let rel: PathBuf = path.components().filter(|c| !matches!(c, Component::Prefix(_) | Component::RootDir)).collect();
    let relative = project_root.join(rel);
    if !path.is_absolute() || relative.is_dir() || !path.exists() { Some(relative) } else { None }
}

impl Mappings {
    /// `remote_root` is the server root resolved on the host (its login
    /// directory when the setting is empty). A server without mappings maps the
    /// project root onto the server root.
    pub fn new(server: &DeploymentServer, project_root: &Path, remote_root: &str) -> Self {
        let mut entries: Vec<(PathBuf, String, String)> = server
            .mappings
            .iter()
            .filter_map(|m| {
                let local = local_folder(m.local.trim(), project_root)?;
                // Relative to the server root, with or without a leading `/`.
                let deployment = m.deployment.trim().trim_start_matches("./").trim_matches('/');
                let deployment = if deployment == "." { "" } else { deployment };
                let remote = if deployment.is_empty() { remote_root.to_owned() } else { join(remote_root, deployment) };
                Some((local, remote.trim_end_matches('/').to_owned(), m.web.trim().trim_matches('/').to_owned()))
            })
            .collect();
        if server.mappings.is_empty() {
            entries.push((project_root.to_path_buf(), remote_root.trim_end_matches('/').to_owned(), String::new()));
        }
        entries.sort_by_key(|(l, _, _)| std::cmp::Reverse(l.components().count()));
        Self {
            root: project_root.to_path_buf(),
            entries,
            web_url: server.web_url.trim().trim_end_matches('/').to_owned(),
        }
    }

    pub fn resolved(&self) -> Vec<ResolvedMapping> {
        self.entries
            .iter()
            .map(|(local, remote, _)| ResolvedMapping {
                local: local.clone().into(),
                deployment: if remote.is_empty() { "/".into() } else { remote.clone() },
            })
            .collect()
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
    fn local_paths_may_be_absolute_inside_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let assets = root.join("static");
        std::fs::create_dir_all(&assets).unwrap();
        for (local, static_local) in [
            (root.to_string_lossy().into_owned(), assets.to_string_lossy().into_owned()),
            (ide_core::ipc_path::to_ipc(&root), format!("{}/", ide_core::ipc_path::to_ipc(&assets))),
        ] {
            let m = Mappings::new(&server(vec![(&local, "/", ""), (&static_local, "cdn", "")]), &root, "/mnt/deploy");
            assert_eq!(m.remote(&root.join("src/a.py")).as_deref(), Some("/mnt/deploy/src/a.py"));
            assert_eq!(m.remote(&assets.join("x.css")).as_deref(), Some("/mnt/deploy/cdn/x.css"));
            assert_eq!(m.local("/mnt/deploy/cdn/x.css"), Some(assets.join("x.css")));
        }
        // A leading `/` that is not the project stays project-relative.
        let m = Mappings::new(&server(vec![("/static/", "", "")]), &root, "/mnt/deploy");
        assert_eq!(m.remote(&assets.join("x.css")).as_deref(), Some("/mnt/deploy/x.css"));
    }

    #[test]
    fn existing_outside_absolute_mapping_does_not_cover_nested_project_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let nested = root.join(posix(&outside)).join("a.txt");
        std::fs::create_dir_all(nested.parent().unwrap().parent().unwrap()).unwrap();
        // A nested project file at the outside path's spelling is not a mapping folder.
        std::fs::write(nested.parent().unwrap(), "nested").unwrap();
        for local in [outside.to_string_lossy().into_owned(), ide_core::ipc_path::to_ipc(&outside)] {
            let m = Mappings::new(&server(vec![(&local, "/", "")]), &root, "/srv");
            assert_eq!(local_folder(&local, &root), None);
            assert_eq!(m.remote(&root.join("a.txt")), None);
            assert_eq!(m.remote(&outside.join("a.txt")), None);
            assert_eq!(m.remote(nested.parent().unwrap()), None);
            assert_eq!(m.remote(&nested), None);
            assert_eq!(m.local("/srv/a.txt"), None);
            assert!(m.resolved().is_empty());
        }
    }

    #[test]
    fn local_folder_resolution_prefers_inside_then_existing_relative_then_missing_absolute() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let inside = root.join("src");
        std::fs::create_dir_all(&inside).unwrap();
        assert_eq!(local_folder(inside.to_str().unwrap(), &root), Some(inside));
        assert_eq!(local_folder("/", &root), Some(root.clone()));
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let relative = root.join(posix(&outside));
        std::fs::create_dir_all(&relative).unwrap();
        assert_eq!(local_folder(outside.to_str().unwrap(), &root), Some(relative.clone()));
        let nested = relative.join("a.txt");
        std::fs::write(&nested, "nested project file").unwrap();
        let m = Mappings::new(&server(vec![(outside.to_str().unwrap(), "/", "")]), &root, "/srv");
        assert_eq!(m.remote(&nested).as_deref(), Some("/srv/a.txt"));
        assert_eq!(m.local("/srv/a.txt"), Some(nested));
        let missing = tmp.path().join("missing");
        assert_eq!(local_folder(missing.to_str().unwrap(), &root), Some(root.join(posix(&missing))));
        assert_eq!(local_folder("/src/", &root), Some(root.join("src")));
    }

    #[cfg(unix)]
    #[test]
    fn absolute_symlink_inside_project_resolves_to_the_project_spelling() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(root.join("src"), &alias).unwrap();
        let m = Mappings::new(&server(vec![(alias.to_str().unwrap(), ".", "")]), &root, "/srv");
        assert_eq!(m.local("/srv/a.txt"), Some(root.join("src/a.txt")));
        assert_eq!(m.resolved()[0].local.to_path_buf(), root.join("src"));
    }

    #[test]
    fn deployment_dot_is_the_server_root() {
        let m = Mappings::new(&server(vec![("", ".", "")]), Path::new("/p"), "/mnt/deploy");
        assert_eq!(m.remote(Path::new("/p/a.txt")).as_deref(), Some("/mnt/deploy/a.txt"));
        assert_eq!(m.local("/mnt/deploy/a.txt"), Some(PathBuf::from("/p/a.txt")));
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
