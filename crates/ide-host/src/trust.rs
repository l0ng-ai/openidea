//! User-owned project execution decisions. Project settings never grant trust.
use crate::catalogue::TrustClass;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecisions {
    pub projects: Vec<PathBuf>,
    pub locations: Vec<PathBuf>,
    pub restricted: Vec<PathBuf>,
}

pub struct TrustStore {
    file: PathBuf,
    state: Mutex<IdeResult<TrustDecisions>>,
    /// Folders trusted for this process only, by the client that started it ([`TRUSTED_ROOT_ENV`]).
    inherited: Mutex<Vec<PathBuf>>,
    remote_file: PathBuf,
    remote: Mutex<IdeResult<RemoteDecisions>>,
}

/// This machine's decisions about remote projects, by location (see [`TrustStore::remote_decision`]).
#[derive(Clone, Default, Serialize, Deserialize)]
struct RemoteDecisions {
    trusted: Vec<String>,
    restricted: Vec<String>,
}

/// Set by the desktop when it starts the server in a dev container of a folder the user trusts
/// there: the project folder in the container, trusted without asking again. Never persisted.
pub const TRUSTED_ROOT_ENV: &str = "OPENIDEA_TRUSTED_ROOT";

impl TrustStore {
    pub fn load(config: &Path, data: &Path) -> Self {
        let file = data.join("project-trust.json");
        let state = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let projects = ide_workspace::RecentProjects::load(config)
                    .paths()
                    .into_iter()
                    .filter_map(|p| dunce::canonicalize(p).ok())
                    .collect();
                let migrated = TrustDecisions { projects, ..Default::default() };
                persist(&file, &migrated).map(|()| migrated)
            }
            Err(e) => Err(e.into()),
        };
        let remote_file = data.join("remote-project-trust.json");
        let remote = match std::fs::read(&remote_file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RemoteDecisions::default()),
            Err(e) => Err(e.into()),
        };
        Self { file, state: Mutex::new(state), inherited: Mutex::default(), remote_file, remote: Mutex::new(remote) }
    }

    /// The decision made on this machine for the remote project at `location` (`None`: none yet).
    /// Commands a remote window runs here follow it, not the server's own trust.
    pub fn remote_decision(&self, location: &str) -> IdeResult<Option<bool>> {
        let remote = self.remote.lock().clone()?;
        Ok(if remote.restricted.iter().any(|l| l == location) {
            Some(false)
        } else if remote.trusted.iter().any(|l| l == location) {
            Some(true)
        } else {
            None
        })
    }

    pub fn decide_remote(&self, location: &str, trusted: bool) -> IdeResult<()> {
        let mut state = self.remote.lock();
        let mut next = state.clone()?;
        next.trusted.retain(|l| l != location);
        next.restricted.retain(|l| l != location);
        if trusted { &mut next.trusted } else { &mut next.restricted }.push(location.to_owned());
        persist(&self.remote_file, &next)?;
        *state = Ok(next);
        Ok(())
    }

    pub fn decisions(&self) -> IdeResult<TrustDecisions> {
        self.state.lock().clone()
    }

    pub fn trusted(&self, path: &Path) -> IdeResult<bool> {
        let root = dunce::canonicalize(path)?;
        let decisions = self.decisions()?;
        Ok(!decisions.restricted.contains(&root)
            && (decisions.projects.contains(&root)
                || decisions.locations.iter().any(|p| root.starts_with(p))
                || self.inherited.lock().contains(&root)))
    }

    pub fn window_trusted(&self, root: &Path) -> IdeResult<bool> {
        if !self.trusted(root)? {
            return Ok(false);
        }
        if let Some(workspace) = ide_workspace::workspace::Workspace::load(root)?
            && !workspace.is_container(root)
        {
            for member in workspace.projects.iter().filter(|p| *p != root && p.exists()) {
                if !self.trusted(member)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// Trusts `path` for this process without recording a decision (see [`TRUSTED_ROOT_ENV`]).
    pub fn inherit(&self, path: &Path) -> IdeResult<()> {
        let root = dunce::canonicalize(path)?;
        let mut inherited = self.inherited.lock();
        if !inherited.contains(&root) {
            inherited.push(root);
        }
        Ok(())
    }

    pub fn decide(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        let root = match dunce::canonicalize(path) {
            Ok(root) => root,
            Err(_) if !trusted && path.is_absolute() => path.to_path_buf(),
            Err(error) => return Err(error.into()),
        };
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.projects.retain(|p| p != &root);
        next.restricted.retain(|p| p != &root);
        if trusted {
            next.projects.push(root.clone());
            if folder && let Some(parent) = root.parent() {
                let parent = parent.to_path_buf();
                if !next.locations.contains(&parent) {
                    next.locations.push(parent);
                }
            }
        } else {
            next.restricted.push(root);
        }
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }

    pub fn add_location(&self, path: &Path) -> IdeResult<()> {
        let root = dunce::canonicalize(path)?;
        if !root.is_dir() {
            return Err(IdeError::invalid("trusted location must be an existing directory"));
        }
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        if !next.locations.contains(&root) {
            next.locations.push(root);
            persist(&self.file, &next)?;
            *state = Ok(next);
        }
        Ok(())
    }

    pub fn remove_location(&self, path: &Path) -> IdeResult<()> {
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.locations.retain(|p| p != path);
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }
}

fn persist<T: Serialize>(file: &Path, state: &T) -> IdeResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| IdeError::internal(e.to_string()))?;
    ide_vfs::write_atomic(file, &bytes)?;
    Ok(())
}

type McpServers = std::collections::BTreeMap<String, ide_core::settings::AgentMcpServer>;

/// Workspace MCP servers (a project's `agents.mcpServers`) the user turned on in Settings, by a
/// fingerprint of the project and the server's definition. Agents start a workspace server only
/// while its definition is one the user turned on, so a server added or changed in the project's
/// file stays off until then.
pub struct McpServerApprovals {
    file: PathBuf,
    approved: Mutex<std::collections::BTreeSet<String>>,
}

impl McpServerApprovals {
    pub fn load(data: &Path) -> Self {
        let file = data.join("mcp-server-approvals.json");
        let approved = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { file, approved: Mutex::new(approved) }
    }

    fn fingerprint(root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> String {
        // Turning a server off and on again doesn't change what it runs.
        let server = ide_core::settings::AgentMcpServer { enabled: true, ..server.clone() };
        let bytes = serde_json::to_vec(&(root, name, server)).expect("MCP server serializes");
        blake3::hash(&bytes).to_hex().to_string()
    }

    pub fn approved(&self, root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> bool {
        self.approved.lock().contains(&Self::fingerprint(root, name, server))
    }

    pub fn approve(&self, root: &Path, name: &str, server: &ide_core::settings::AgentMcpServer) -> IdeResult<()> {
        let fingerprint = Self::fingerprint(root, name, server);
        let mut approved = self.approved.lock();
        if approved.contains(&fingerprint) {
            return Ok(());
        }
        let mut next = approved.clone();
        next.insert(fingerprint);
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&self.file, &bytes)?;
        *approved = next;
        Ok(())
    }

    /// `workspace` with the servers the user hasn't turned on switched off.
    pub fn apply(&self, root: &Path, mut workspace: McpServers) -> McpServers {
        for (name, server) in &mut workspace {
            server.enabled &= self.approved(root, name, server);
        }
        workspace
    }
}

impl crate::Host {
    pub async fn set_project_trust(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        self.trust.decide(path, trusted, folder)?;
        self.refresh_project_trust().await
    }

    pub async fn refresh_project_trust(&self) -> IdeResult<()> {
        for project in self.projects().into_iter().filter(|p| !p.light) {
            let trusted = self.trust.window_trusted(&project.root).unwrap_or(false);
            let roots = project.content_roots();
            let previous = project.trusted.swap(trusted, std::sync::atomic::Ordering::AcqRel);
            if previous == trusted {
                continue;
            }
            // Maven reactor modules outside the project are content roots of a trusted project only.
            if project.content_roots() != roots {
                project.refresh_index_scope();
                let p = project.clone();
                tokio::task::spawn_blocking(move || p.refresh_repositories());
                project.sink.emit(ide_core::IdeEvent::ProjectRootsChanged { root: project.root.clone().into() });
            }
            if let Some(bridge) = &project.kotlin_bridge {
                bridge.schedule();
            }
            if let Some(phpstan) = &project.phpstan {
                phpstan.interrupt();
            }
            if !trusted {
                if let Some(plugins) = self.plugin_host() {
                    plugins.withdraw_project_run_targets(&project.root);
                }
                project.lsp.set_execution_allowed(false);
            }
            project.repos();
            if trusted {
                if let Some(cmd) = self.environment.project_opened(&project.root, &project.sink) {
                    self.environment.spawn_post_start(cmd, project.root.clone(), project.sink.clone());
                }
                self.environment.direnv_opened(&project.root, &project.sink);
                project.lsp.set_execution_allowed(true);
                project.lsp.prewarm_java_configuration();
            } else {
                self.environment.project_closed();
                self.environment.direnv_closed(&project.root);
                project.agents.shutdown();
                self.processes.kill_project(&project.root);
                project.notebooks.restrict().await;
                let windows: Vec<_> = self
                    .projects
                    .read()
                    .iter()
                    .filter(|(_, current)| std::sync::Arc::ptr_eq(current, &project))
                    .map(|(window, _)| window.clone())
                    .collect();
                for window in windows {
                    let requests = self.project_requests.write().remove(&window).unwrap_or_default();
                    for request in requests {
                        self.cancel_request(request);
                    }
                    self.debugger.stop_key(&window).await;
                }
            }
            project.lsp.reconfigure().await;
            crate::ops::sdk::container_python::ensure(self, &project);
            project.sink.emit(ide_core::IdeEvent::ProjectTrustChanged { root: project.root.clone().into(), trusted });
        }
        Ok(())
    }
}

impl crate::Host {
    /// Whether `window` may run a command of class `trust`.
    pub fn authorize(&self, window: &str, trust: TrustClass) -> IdeResult<()> {
        if trust == TrustClass::Always {
            return Ok(());
        }
        match self.project(window) {
            Ok(project) => project.require_trust(),
            Err(_) if trust == TrustClass::OutsideRestricted => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub root: ide_core::IpcPath,
    pub trusted: bool,
    pub decided: bool,
}
impl TrustStore {
    pub fn status(&self, path: &Path) -> IdeResult<TrustStatus> {
        let root = dunce::canonicalize(path)?;
        let trusted = self.trusted(&root)?;
        let state = self.decisions()?;
        Ok(TrustStatus { decided: trusted || state.restricted.contains(&root), root: root.into(), trusted })
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn remote_project_decisions_are_kept_on_this_machine() {
        let tmp = tempfile::tempdir().unwrap();
        let load = || super::TrustStore::load(&tmp.path().join("config"), &tmp.path().join("data"));
        let store = load();
        let here = r#"[{"kind":"ssh","config":"box"},"/srv/app"]"#;
        assert_eq!(store.remote_decision(here).unwrap(), None);
        store.decide_remote(here, true).unwrap();
        assert_eq!(store.remote_decision(here).unwrap(), Some(true));
        assert_eq!(store.remote_decision(r#"[{"kind":"ssh","config":"box"},"/srv/other"]"#).unwrap(), None);
        store.decide_remote(here, false).unwrap();
        assert_eq!(load().remote_decision(here).unwrap(), Some(false));
    }
}
