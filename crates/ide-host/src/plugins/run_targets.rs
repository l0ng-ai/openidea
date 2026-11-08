//! Project-owned registrations, retained across idle instance reclamation.
use super::api::{PluginApi, Shared};
use super::{PluginEvent, PluginHost};
use ide_core::{IdeError, IdeResult};
use ide_plugin::{HostError, PluginRunTarget};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRunTarget {
    /// Opaque selector id, namespaced by the host.
    pub id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub target: PluginRunTarget,
    pub prompt: bool,
}

pub(super) type Targets = std::collections::BTreeMap<(PathBuf, String), RegisteredRunTarget>;
fn selector(plugin: &str, id: &str) -> String {
    format!("plugin-target:{}:{plugin}{id}", plugin.len())
}
impl Shared {
    fn target_answer_file(&self, root: &Path, id: &str) -> PathBuf {
        let key = format!("{}\0{id}", root.display());
        self.data_dir.join(".run-target-answers").join(blake3::hash(key.as_bytes()).to_hex().as_str())
    }
    pub(super) fn withdraw_run_targets(&self, plugin: Option<&str>, root: Option<&Path>) {
        let mut targets = self.run_targets.lock();
        let before = targets.len();
        targets.retain(|(r, _), t| !(plugin.is_none_or(|p| p == t.plugin_id) && root.is_none_or(|path| path == r)));
        if before != targets.len() {
            drop(targets);
            self.sink.emit(None, PluginEvent::RunTargetsChanged);
        }
    }
}
impl PluginApi {
    pub(super) fn register_target(&self, root: &Path, target: PluginRunTarget) -> Result<(), HostError> {
        ide_remote::plugin_target::validate(&target).map_err(|e| HostError::Invalid(e.to_string()))?;
        let workspace = self.shared.workspace().ok_or(HostError::Cancelled)?;
        if !workspace.projects().iter().any(|r| r == root) {
            return Err(HostError::NotFound("project is not open".into()));
        }
        if !workspace.trusted(root) {
            return Err(HostError::Denied("project is not trusted".into()));
        }
        self.approved_program_in_project(&target.program, Some(root))?;
        let blocked = self.shared.prompts_blocked.lock();
        if blocked.contains(self.pkg.id()) {
            return Err(HostError::Cancelled);
        }
        let id = selector(self.pkg.id(), &target.id);
        let mut targets = self.shared.run_targets.lock();
        if !targets.contains_key(&(root.into(), id.clone()))
            && targets.iter().filter(|((r, _), t)| r == root && t.plugin_id == self.pkg.id()).count() >= 32
        {
            return Err(HostError::Invalid("at most 32 targets per plugin and project".into()));
        }
        let prompt = !self.shared.target_answer_file(root, &id).exists();
        targets.insert(
            (root.into(), id.clone()),
            RegisteredRunTarget {
                id,
                plugin_id: self.pkg.id().into(),
                plugin_name: self.pkg.manifest.name.clone(),
                target,
                prompt,
            },
        );
        drop(targets);
        drop(blocked);
        self.shared.sink.emit(None, PluginEvent::RunTargetsChanged);
        Ok(())
    }
    pub(super) fn unregister_target(&self, root: &Path, id: &str) {
        if self.shared.run_targets.lock().remove(&(root.into(), selector(self.pkg.id(), id))).is_some() {
            self.shared.sink.emit(None, PluginEvent::RunTargetsChanged);
        }
    }
}
impl PluginHost {
    /// Drops registrations when their project closes or loses trust.
    pub fn withdraw_project_run_targets(&self, root: &Path) {
        self.shared.withdraw_run_targets(None, Some(root));
    }
    pub fn run_targets(&self, root: &Path) -> Vec<RegisteredRunTarget> {
        self.shared.run_targets.lock().iter().filter(|((r, _), _)| r == root).map(|(_, t)| t.clone()).collect()
    }
    pub fn prepare_run_target(
        &self,
        root: &Path,
        id: &str,
        config: &ide_run::RunConfig,
    ) -> IdeResult<ide_run::RunConfig> {
        let target = self
            .shared
            .run_targets
            .lock()
            .get(&(root.into(), id.into()))
            .cloned()
            .ok_or_else(|| IdeError::not_found("plugin run target is no longer available"))?;
        let program = self.program_for_project(&target.plugin_id, &target.target.program, Some(root))?;
        ide_remote::plugin_target::prepare(root, &target.target, &program, config)
    }
}

pub fn list(host: &crate::Host, plugins: &PluginHost, window: &str) -> IdeResult<Vec<RegisteredRunTarget>> {
    Ok(plugins.run_targets(&host.project(window)?.root))
}

/// The first answer wins across the project's windows. Only Use changes settings.
pub fn answer(
    host: &crate::Host,
    plugins: &PluginHost,
    window: &str,
    id: &str,
    use_target: bool,
) -> IdeResult<ide_core::settings::Settings> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let mut targets = plugins.shared.run_targets.lock();
    let target = targets
        .get_mut(&(project.root.clone(), id.into()))
        .ok_or_else(|| IdeError::not_found("plugin run target is no longer available"))?;
    let file = plugins.shared.target_answer_file(&project.root, id);
    if file.exists() {
        target.prompt = false;
        return Ok(project.settings.effective());
    }
    if use_target {
        plugins.program_for_project(&target.plugin_id, &target.target.program, Some(&project.root))?;
        let scope = ide_workspace::SettingsScope::Project;
        for key in ["run.defaultTarget", "languages.php.runTarget", "languages.node.runTarget"] {
            project.settings.set(scope, key, serde_json::json!(id))?;
            for window in host.windows_for_root(&project.root) {
                if let Ok(open) = host.project(&window) {
                    open.settings.reload();
                    open.sink.emit(ide_core::IdeEvent::SettingsChanged { key: key.into() });
                }
            }
        }
    }
    std::fs::create_dir_all(file.parent().unwrap())?;
    std::fs::write(file, if use_target { "use" } else { "not-now" })?;
    target.prompt = false;
    drop(targets);
    plugins.shared.sink.emit(None, PluginEvent::RunTargetsChanged);
    Ok(project.settings.effective())
}
