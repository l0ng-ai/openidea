//! Code plugins of remote projects:
//! Wasm runs where the project is, so `openidea-server` hosts the desktop's
//! code plugins and they read, search, run processes and publish diagnostics
//! on the remote machine.
//!
//! The desktop stays the authority over what is installed and granted. It
//! pushes its live code plugins with [`SYNC_PACKAGES`]: first their digests
//! and grants, then the files of those the server doesn't have (one package
//! per request); a package missing from a sync is uninstalled. The server
//! installs them under `<data>/remote-plugins` and records the desktop's
//! grants (a `process:` grant is pinned to the program on this machine's
//! `PATH`).
//!
//! The commands a window needs at run time (`plugin_run_command`,
//! `plugin_post_events`, `plugin_event_kinds`, `plugin_status_items`,
//! `plugin_context_keys`, `plugin_cancel_task`, `plugin_answer_prompt`, `plugin_set_active_file`,
//! `plugin_line_markers`, `plugin_view_render`, `plugin_view_event`)
//! carry the desktop commands' names and arguments, so a remote window's UI
//! routes them here unchanged. Plugin results come back as `plugin`
//! notifications ([`PluginEventMessage`]); secrets stay in the desktop's
//! keychain and are asked for with a `plugin_secret` request
//! ([`SecretRequest`]) when a request header needs one (rule 4).

use super::{
    Consent, HostWorkspace, PluginEditor, PluginEvent, PluginHost, PluginSource, PluginStatusItem, SecretStore,
};
use crate::rpc::Dispatcher;
use base64::Engine as _;
use ide_core::{IdeError, IdeResult};
use ide_extension::{MANIFEST_FILE, ledger};
use ide_jsonrpc::Peer;
use ide_plugin::{Invocation, Limits};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

/// The server command the desktop calls with its packages.
pub const SYNC_PACKAGES: &str = "plugin_sync_packages";
/// Server → client notification carrying a [`PluginEventMessage`].
pub const EVENT_NOTIFICATION: &str = "plugin";
/// Server → client request ([`SecretRequest`] → `Option<String>`).
pub const SECRET_REQUEST: &str = "plugin_secret";
/// Under the server's data directory.
pub const PLUGINS_DIR: &str = "remote-plugins";
const INCOMING_DIR: &str = "remote-plugins.incoming";
const SECRET_TIMEOUT: Duration = Duration::from_secs(10);
const EVENT_FLUSH: Duration = Duration::from_millis(250);
const TICKS_PER_SUPERVISION: u32 = 20;

/// One live code plugin of the desktop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePackage {
    pub id: String,
    /// [`package_digest`] of the package.
    pub digest: String,
    /// Capabilities the user granted on the desktop.
    pub granted: Vec<String>,
}

/// One file of a package (`path` relative to the package, `data` base64).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageFile {
    pub path: String,
    pub data: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSyncReport {
    /// Packages the server needs the files of (send them in another sync).
    pub missing: Vec<String>,
    pub installed: Vec<String>,
    pub removed: Vec<String>,
    /// `id: reason`.
    pub failed: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PluginEventMessage {
    /// The window that invoked the plugin (`None`: every window of the connection).
    pub window: Option<String>,
    pub event: PluginEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretRequest {
    pub plugin: String,
    pub name: String,
}

/// Identifies a package's content: the manifest, the files its declarations
/// reference and the component.
pub fn package_digest(dir: &Path, files: &[PathBuf]) -> IdeResult<String> {
    let mut all = files.to_vec();
    all.push(PathBuf::from(MANIFEST_FILE));
    Ok(ledger::package_hash(dir, &all)?)
}

/// Whether a plugin event means something to a remote window (the desktop
/// owns the plugin list, themes and consent).
pub fn forwarded(event: &PluginEvent) -> bool {
    matches!(
        event,
        PluginEvent::Notification { .. }
            | PluginEvent::StatusItemChanged { .. }
            | PluginEvent::ContextChanged { .. }
            | PluginEvent::TaskStarted { .. }
            | PluginEvent::TaskProgress { .. }
            | PluginEvent::TaskEnded { .. }
            | PluginEvent::SubscriptionsChanged
            | PluginEvent::ViewChanged { .. }
            | PluginEvent::ViewMessage { .. }
            | PluginEvent::OpenTerminal { .. }
            | PluginEvent::OpenLocation { .. }
            | PluginEvent::CopyToClipboard { .. }
            | PluginEvent::OpenUrl { .. }
            | PluginEvent::PromptRequested { .. }
            | PluginEvent::PromptClosed { .. }
            | PluginEvent::RevealView { .. }
    )
}

// ---- desktop side -----------------------------------------------------------

impl PluginHost {
    fn package_files(&self, plugin: &super::LoadedPlugin) -> IdeResult<Vec<PathBuf>> {
        let set = self.prepare(&plugin.pkg).map_err(IdeError::invalid)?;
        Ok(set.files.into_iter().chain(plugin.manifest().wasm.clone()).collect())
    }

    /// The live code plugins (installed or linked) for a remote project's server.
    pub fn remote_packages(&self) -> Vec<RemotePackage> {
        let plugins: Vec<_> = self.plugins.read().values().cloned().collect();
        plugins
            .iter()
            .filter(|p| p.dev_root.is_none() && !p.invalid && p.manifest().wasm.is_some())
            .filter(|p| matches!(p.status(), super::PluginStatus::Active | super::PluginStatus::Inactive))
            .filter_map(|p| {
                let files = self.package_files(p).ok()?;
                let digest = package_digest(p.dir(), &files).ok()?;
                let granted = p.meta.lock().granted.iter().map(ToString::to_string).collect();
                Some(RemotePackage { id: p.id().to_owned(), digest, granted })
            })
            .collect()
    }

    /// The files of a package for [`SYNC_PACKAGES`], the manifest first.
    pub fn remote_package_files(&self, id: &str) -> IdeResult<Vec<PackageFile>> {
        let plugin = self.get(id)?;
        let files = self.package_files(&plugin)?;
        std::iter::once(PathBuf::from(MANIFEST_FILE))
            .chain(files)
            .map(|rel| {
                let bytes = std::fs::read(plugin.dir().join(&rel))?;
                let path = rel.to_str().ok_or_else(|| IdeError::invalid("non UTF-8 file name"))?.replace('\\', "/");
                Ok(PackageFile { path, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
            })
            .collect()
    }

    /// A secret a plugin declares, for its remote instance (`plugin_secret`).
    pub fn declared_secret(&self, id: &str, name: &str) -> Option<String> {
        let plugin = self.get(id).ok()?;
        if !self.ui.items(super::providers::SECRETS_POINT, Some(plugin.id())).iter().any(|s| s.key == name) {
            return None;
        }
        let store = self.shared.secrets.read().clone();
        store.get(plugin.id(), name)
    }
}

// ---- server side ------------------------------------------------------------

/// The plugin host of `openidea-server`.
pub struct RemotePlugins {
    host: Arc<PluginHost>,
    incoming: PathBuf,
    sync: Mutex<()>,
}

/// Secrets from the desktop's keychain, asked for when used.
struct ClientSecrets {
    peer: Arc<OnceLock<Peer>>,
    runtime: tokio::runtime::Handle,
}

impl SecretStore for ClientSecrets {
    fn get(&self, plugin: &str, name: &str) -> Option<String> {
        let peer = self.peer.get()?.clone();
        let request = SecretRequest { plugin: plugin.to_owned(), name: name.to_owned() };
        let ask = async move {
            tokio::time::timeout(SECRET_TIMEOUT, peer.request::<_, Option<String>>(SECRET_REQUEST, request, None)).await
        };
        // Plugin threads block on the runtime; a runtime worker (a host
        // command asking) must leave its thread to the other tasks first.
        let answer = if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| self.runtime.block_on(ask))
        } else {
            self.runtime.block_on(ask)
        };
        match answer {
            Ok(Ok(value)) => value,
            Ok(Err(e)) => {
                tracing::warn!("plugin secret {plugin}/{name}: {e}");
                None
            }
            Err(_) => None,
        }
    }

    fn set(&self, _: &str, _: &str, _: Option<&str>) -> Result<(), String> {
        Err("secrets are stored on the desktop".into())
    }
}

impl RemotePlugins {
    /// Creates the host over `<data_dir>/remote-plugins`, loads what earlier
    /// sessions installed and starts event delivery and supervision.
    pub fn start(data_dir: &Path, projects: &Arc<crate::Host>, peer: Arc<OnceLock<Peer>>) -> IdeResult<Arc<Self>> {
        let sink_peer = peer.clone();
        let sink = move |client: Option<&str>, event: PluginEvent| {
            if forwarded(&event)
                && let Some(p) = sink_peer.get()
            {
                let _ = p.notify(EVENT_NOTIFICATION, PluginEventMessage { window: client.map(str::to_owned), event });
            }
        };
        let host = Arc::new(PluginHost::new(data_dir.join(PLUGINS_DIR), Arc::new(sink), Limits::default())?);
        host.set_workspace(Some(Arc::new(HostWorkspace(Arc::downgrade(projects)))));
        host.set_secret_store(Arc::new(ClientSecrets { peer, runtime: projects.runtime.clone() }));
        let trust = Arc::downgrade(projects);
        host.set_project_policy(Arc::new(move |root| {
            trust.upgrade().is_some_and(|h| h.trust.trusted(root).unwrap_or(false))
        }));
        super::set_editor_providers(Some(&host));
        ide_language::set_external_syntax(Some(host.syntax_provider()));
        ide_run::set_external_detection(Some(host.run_detection()));
        host.load_all();
        host.startup_finished();
        spawn_supervision(Arc::downgrade(&host))?;
        Ok(Arc::new(Self { host, incoming: data_dir.join(INCOMING_DIR), sync: Mutex::new(()) }))
    }

    pub fn host(&self) -> &Arc<PluginHost> {
        &self.host
    }

    /// Makes the installed packages match `packages`: uninstalls the others,
    /// follows changed grants, installs those with `files` and reports the
    /// rest as missing.
    pub fn sync(
        &self,
        packages: Vec<RemotePackage>,
        mut files: BTreeMap<String, Vec<PackageFile>>,
    ) -> PackageSyncReport {
        let _guard = self.sync.lock();
        let mut report = PackageSyncReport::default();
        let wanted: BTreeSet<&str> = packages.iter().map(|p| p.id.as_str()).collect();
        let installed: Vec<String> = self
            .host
            .plugins
            .read()
            .values()
            .filter(|p| p.source == PluginSource::Installed)
            .map(|p| p.id().to_owned())
            .collect();
        for id in installed.iter().filter(|id| !wanted.contains(id.as_str())) {
            match self.host.uninstall(id) {
                Ok(()) => report.removed.push(id.clone()),
                Err(e) => report.failed.push(format!("{id}: {e}")),
            }
        }
        for pkg in packages {
            if !valid_id(&pkg.id) {
                report.failed.push(format!("{}: invalid plugin id", pkg.id));
                continue;
            }
            // The desktop asked the user, change of signer included.
            let consent = Consent { optional: pkg.granted.clone(), signer_change: true };
            if self.current_digest(&pkg.id).as_deref() == Some(pkg.digest.as_str()) {
                if let Err(e) = self.follow_grants(&pkg, &consent) {
                    report.failed.push(format!("{}: {e}", pkg.id));
                }
                continue;
            }
            match files.remove(&pkg.id) {
                None => report.missing.push(pkg.id),
                Some(list) => match self.install(&pkg, list, &consent) {
                    Ok(()) => report.installed.push(pkg.id),
                    Err(e) => report.failed.push(format!("{}: {}", pkg.id, e.message)),
                },
            }
        }
        report
    }

    fn current_digest(&self, id: &str) -> Option<String> {
        let plugin = self.host.plugins.read().get(id).cloned()?;
        if plugin.source != PluginSource::Installed || plugin.invalid {
            return None;
        }
        let files = self.host.package_files(&plugin).ok()?;
        package_digest(plugin.dir(), &files).ok()
    }

    fn follow_grants(&self, pkg: &RemotePackage, consent: &Consent) -> IdeResult<()> {
        let info = self.host.info_of(&pkg.id)?;
        let have: BTreeSet<&str> = info.capabilities.iter().filter(|c| c.granted).map(|c| c.id.as_str()).collect();
        let want: BTreeSet<&str> = pkg.granted.iter().map(String::as_str).collect();
        if have != want || info.status == super::PluginStatus::NeedsConsent {
            self.host.grant(&pkg.id, consent)?;
        }
        Ok(())
    }

    fn install(&self, pkg: &RemotePackage, files: Vec<PackageFile>, consent: &Consent) -> IdeResult<()> {
        let dir = self.incoming.join(&pkg.id);
        let _ = std::fs::remove_dir_all(&dir);
        let result = (|| {
            let mut rels = Vec::new();
            for f in files {
                let rel = safe_relative(&f.path)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(f.data.as_bytes())
                    .map_err(|e| IdeError::invalid(format!("{}: {e}", f.path)))?;
                let to = dir.join(&rel);
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&to, bytes)?;
                if rel != Path::new(MANIFEST_FILE) {
                    rels.push(rel);
                }
            }
            if package_digest(&dir, &rels)? != pkg.digest {
                return Err(IdeError::invalid("the package arrived incomplete or changed"));
            }
            let info = self.host.install_from_dir(&dir, consent)?;
            if info.id != pkg.id {
                let _ = self.host.uninstall(&info.id);
                return Err(IdeError::invalid(format!("the package is plugin {:?}", info.id)));
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    /// The run-time commands of remote windows plus [`SYNC_PACKAGES`].
    pub fn register(self: &Arc<Self>, d: &mut Dispatcher) {
        let this = self.clone();
        d.add(SYNC_PACKAGES, move |c| {
            let this = this.clone();
            async move {
                let packages: Vec<RemotePackage> = c.arg("packages")?;
                let files: Option<BTreeMap<String, Vec<PackageFile>>> = c.arg("files")?;
                blocking(move || Ok(this.sync(packages, files.unwrap_or_default()))).await
            }
        });
        let host = Arc::downgrade(&self.host);
        let h = host.clone();
        d.add("plugin_run_command", move |c| {
            let h = h.clone();
            async move {
                let host = alive(&h)?;
                let plugin_id: String = c.arg("pluginId")?;
                let command_id: String = c.arg("commandId")?;
                let arg: Option<String> = c.arg("arg")?;
                let editor: Option<PluginEditor> = c.arg("editor")?;
                let paths: Option<Vec<PathBuf>> = c.arg("paths")?;
                let invocation = Invocation {
                    client: Some(c.window.clone()),
                    workspace_root: c.host.project(&c.window).ok().map(|p| p.root.clone()),
                    editor: editor.map(PluginEditor::context),
                    selected_paths: paths.unwrap_or_default(),
                };
                blocking(move || host.run_command(&plugin_id, &command_id, arg.as_deref(), invocation)).await
            }
        });
        let h = host.clone();
        d.add("plugin_post_events", move |c| {
            let h = h.clone();
            async move {
                alive(&h)?.post_events(Some(&c.window), c.arg("events")?);
                Ok(())
            }
        });
        let h = host.clone();
        d.add("plugin_event_kinds", move |_| {
            let h = h.clone();
            async move { Ok(alive(&h)?.event_kinds().into_iter().collect::<Vec<_>>()) }
        });
        let h = host.clone();
        d.add("plugin_status_items", move |_| {
            let h = h.clone();
            async move {
                Ok(alive(&h)?
                    .status_items()
                    .into_iter()
                    .map(|(plugin_id, id, item)| PluginStatusItem { plugin_id, id, item })
                    .collect::<Vec<_>>())
            }
        });
        let h = host.clone();
        d.add("plugin_context_keys", move |c| {
            let h = h.clone();
            async move { Ok(alive(&h)?.context_keys(Some(&c.window))) }
        });
        let h = host.clone();
        d.add("plugin_cancel_task", move |c| {
            let h = h.clone();
            async move { Ok(alive(&h)?.cancel_task(&c.arg::<String>("taskId")?)) }
        });
        let h = host.clone();
        d.add("plugin_answer_prompt", move |c| {
            let h = h.clone();
            async move { Ok(alive(&h)?.answer_prompt(&c.arg::<String>("promptId")?, c.arg("answer")?)) }
        });
        let h = host.clone();
        d.add("plugin_set_active_file", move |c| {
            let h = h.clone();
            async move {
                alive(&h)?.set_active_file(&c.window, c.arg("path")?);
                Ok(())
            }
        });
        let h = host.clone();
        d.add("plugin_view_render", move |c| {
            let h = h.clone();
            async move {
                let plugins = alive(&h)?;
                super::views::render(
                    &c.host,
                    plugins,
                    &c.window,
                    c.arg("pluginId")?,
                    c.arg("view")?,
                    c.arg("viewport")?,
                    c.arg("doc")?,
                    c.arg("editor")?,
                )
                .await
            }
        });
        let h = host.clone();
        d.add("plugin_view_event", move |c| {
            let h = h.clone();
            async move {
                let plugins = alive(&h)?;
                super::views::event(
                    &c.host,
                    plugins,
                    &c.window,
                    c.arg("pluginId")?,
                    c.arg("view")?,
                    c.arg("event")?,
                    c.arg("doc")?,
                    c.arg("editor")?,
                )
                .await
            }
        });
        let h = host.clone();
        d.add("plugin_navigation_files", move |c| {
            let h = h.clone();
            async move { super::index_ops::plugin_navigation_files(&c.host, alive(&h)?, &c.window).await }
        });
        let h = host.clone();
        d.add("plugin_navigation_invalidate", move |c| { let h = h.clone(); async move {
            super::index_ops::plugin_navigation_invalidate(&c.host, alive(&h)?, &c.window, c.arg("paths")?)
        } });
        let h = host.clone();
        d.add("plugin_navigation_index", move |c| {
            let h = h.clone();
            async move {
                super::index_ops::plugin_navigation_index(
                    &c.host,
                    alive(&h)?,
                    &c.window,
                    c.arg("paths")?,
                    c.arg("request")?,
                )
                .await
            }
        });
        let h = host.clone();
        d.add("plugin_navigation_goto", move |c| {
            let h = h.clone();
            async move {
                super::index_ops::plugin_navigation_goto(&c.host, alive(&h)?, &c.window, c.arg("doc")?, c.arg("pos")?)
                    .await
            }
        });
        let h = host.clone();
        d.add("plugin_navigation_markers", move |c| {
            let h = h.clone();
            async move {
                super::index_ops::plugin_navigation_markers(&c.host, alive(&h)?, &c.window, c.arg("paths")?).await
            }
        });
        d.add("plugin_line_markers", |c| async move {
            crate::ops::lsp::plugin_line_markers(&c.host, &c.window, c.arg("doc")?).await
        });
    }
}

fn alive(host: &Weak<PluginHost>) -> IdeResult<Arc<PluginHost>> {
    host.upgrade().ok_or_else(|| IdeError::unavailable("the plugin host has shut down"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

fn spawn_supervision(host: Weak<PluginHost>) -> IdeResult<()> {
    std::thread::Builder::new().name("remote-plugins".into()).spawn(move || {
        for n in 1u32.. {
            std::thread::sleep(EVENT_FLUSH);
            let Some(host) = host.upgrade() else { return };
            host.flush_events();
            if n % TICKS_PER_SUPERVISION == 0 {
                host.tick();
            }
        }
    })?;
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// `path` as a relative path inside a package (no `..`, no root).
fn safe_relative(path: &str) -> IdeResult<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(IdeError::invalid(format!("invalid file path {path:?} in package")));
    }
    Ok(p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_paths_stay_inside_the_package() {
        assert!(safe_relative("dist/plugin.wasm").is_ok());
        for bad in ["", "../x", "/etc/passwd", "a/../../b", "./x"] {
            assert!(safe_relative(bad).is_err(), "{bad}");
        }
        assert!(valid_id("ai-completion"));
        assert!(!valid_id("../x") && !valid_id(".data") && !valid_id(""));
    }
}
