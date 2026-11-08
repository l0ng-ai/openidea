//! The `runDetectors` extension point: run configurations a plugin offers in
//! projects that contain a marker file.
//!
//! ```toml
//! [[contributes.runDetectors]]
//! id = "forge-test"
//! name = "forge test"
//! files = ["foundry.toml"]       # any of these at the project root
//! command = "forge"
//! args = ["test"]
//! test = true                    # results go to the test tree
//! ```
//!
//! The command is a `process:` capability like a language server's: the
//! configuration is offered only while it is granted, and starts the approved
//! file (checked right before it starts).

use ide_extension::{
    Capability, Disposable, ExtensionPoint, Package, Placement, Prepared, check_relative, decode, validate_item_id,
};
use ide_language::ProgramPin;
use ide_run::{EXTERNAL_PREFIX, ExternalDetection, RunConfig};
use parking_lot::RwLock;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub const POINT_ID: &str = "runDetectors";
const MAX_FILES: usize = 16;
const MAX_ARGS: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Detector {
    pub id: String,
    pub name: String,
    pub files: Vec<PathBuf>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub test: bool,
    /// Optional output parser, including the API 1.4 plugin export.
    #[serde(default)]
    pub framework: Option<String>,
}

/// Detectors of enabled plugins.
#[derive(Default)]
pub struct RunDetectors {
    items: RwLock<Vec<(u64, String, Detector)>>,
    seq: AtomicU64,
}

impl RunDetectors {
    fn add(self: &Arc<Self>, plugin: String, detector: Detector) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push((seq, plugin, detector));
        let weak = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(this) = weak.upgrade() {
                this.items.write().retain(|(s, _, _)| *s != seq);
            }
        })
    }
}

pub struct RunDetectorsPoint {
    store: Arc<RunDetectors>,
}

impl RunDetectorsPoint {
    pub fn new(store: Arc<RunDetectors>) -> Self {
        Self { store }
    }
}

impl ExtensionPoint for RunDetectorsPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }

    fn placement(&self) -> Placement {
        Placement::Workspace
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let d: Detector = decode(POINT_ID, decl)?;
        if d.framework.is_some() {
            pkg.manifest.needs_api("runDetectors.framework", 4)?;
        }
        if d.framework.as_ref().is_some_and(|v| v.is_empty() || v.len() > 64) {
            return Err("invalid test framework".into());
        }
        validate_item_id(&d.id, "run detector id")?;
        if d.name.trim().is_empty() || d.name.len() > 128 {
            return Err(format!("run detector {:?}: `name` must be 1–128 bytes", d.id));
        }
        if d.files.is_empty() || d.files.len() > MAX_FILES {
            return Err(format!("run detector {:?}: give 1–{MAX_FILES} marker `files`", d.id));
        }
        for f in &d.files {
            check_relative(f, "files")?;
        }
        let program = d.command.trim();
        if program.is_empty() || program.contains(char::is_whitespace) {
            return Err(format!("run detector {:?}: `command` is one program name (arguments go in `args`)", d.id));
        }
        if d.args.len() > MAX_ARGS {
            return Err(format!("run detector {:?}: at most {MAX_ARGS} arguments", d.id));
        }
        let cap = Capability::Process(program.to_owned());
        let (store, plugin, label) = (self.store.clone(), pkg.id().to_owned(), d.name.clone());
        let key = d.id.clone();
        Ok(Prepared::new(label, move || Ok(store.add(plugin, d))).key(key).capability(cap))
    }
}

type Pins = Arc<RwLock<HashMap<(String, String), ProgramPin>>>;
pub(super) type DynamicConfigurations =
    Arc<RwLock<std::collections::BTreeMap<(String, PathBuf), Vec<ide_plugin::PluginRunConfiguration>>>>;

/// [`ExternalDetection`] over the detectors and the approved programs.
pub struct PluginRunDetection {
    pub(crate) store: Arc<RunDetectors>,
    pub(crate) pins: Pins,
    pub(crate) dynamic: DynamicConfigurations,
    pub(crate) project_pins: super::api::ProjectPins,
}

pub(super) fn config_id(plugin: &str, detector: &str) -> String {
    format!("{EXTERNAL_PREFIX}{plugin}:{detector}")
}

impl PluginRunDetection {
    fn pin(&self, plugin: &str, d: &Detector, root: Option<&Path>) -> Option<ProgramPin> {
        let cap = Capability::Process(d.command.trim().to_owned());
        root.and_then(|root| self.project_pins.read().get(&(plugin.into(), cap.to_string(), root.into())).cloned())
            .or_else(|| self.pins.read().get(&(plugin.to_owned(), cap.to_string())).cloned())
    }
}

impl ExternalDetection for PluginRunDetection {
    fn detect(&self, root: &Path) -> Vec<RunConfig> {
        let items = self.store.items.read().clone();
        let mut configs: Vec<_> = items
            .into_iter()
            .filter(|(_, plugin, d)| {
                self.pin(plugin, d, Some(root)).is_some() && d.files.iter().any(|f| root.join(f).exists())
            })
            .map(|(_, plugin, d)| RunConfig {
                id: config_id(&plugin, &d.id),
                name: d.name.clone(),
                kind: "plugin".into(),
                command: d.command.trim().to_owned(),
                args: d.args.clone(),
                cwd: Some(root.to_path_buf().into()),
                env: Default::default(),
                detected: true,
                is_test: d.test,
                debug_adapter: None,
                allow_parallel: false,
                extras: ide_run::RunExtras {
                    params: d.framework.clone().map(|f| [("framework".into(), f)].into()).unwrap_or_default(),
                    ..Default::default()
                },
            })
            .collect();
        for ((plugin, project), entries) in self.dynamic.read().iter().filter(|((_, project), _)| project == root) {
            for c in entries {
                let cap = Capability::Process(c.program.clone());
                if !self.project_pins.read().contains_key(&(plugin.clone(), cap.to_string(), project.clone()))
                    && !self.pins.read().contains_key(&(plugin.clone(), cap.to_string()))
                {
                    continue;
                }
                let mut config = RunConfig {
                    id: String::new(),
                    name: c.name.clone(),
                    kind: "plugin".into(),
                    command: c.program.clone(),
                    args: c.args.clone(),
                    cwd: Some(root.to_path_buf().into()),
                    env: Default::default(),
                    detected: true,
                    is_test: c.test,
                    debug_adapter: None,
                    allow_parallel: false,
                    extras: Default::default(),
                };
                config.id = config_id(plugin, &c.id);
                config.cwd = Some(c.cwd.as_ref().map(|p| root.join(p)).unwrap_or_else(|| root.to_path_buf()).into());
                if let Some(framework) = &c.framework {
                    config.extras.params.insert("framework".into(), framework.clone());
                }
                configs.push(config);
            }
        }
        configs
    }

    fn launch(&self, config: &RunConfig) -> Result<PathBuf, String> {
        let dynamic = self.dynamic.read();
        if let Some(((plugin, root), c)) =
            dynamic.iter().flat_map(|(k, entries)| entries.iter().map(move |c| (k, c))).find(|((plugin, root), c)| {
                config_id(plugin, &c.id) == config.id && config.cwd.as_ref().is_some_and(|cwd| cwd.starts_with(root))
            })
        {
            let cap = Capability::Process(c.program.clone()).to_string();
            let pin = self
                .project_pins
                .read()
                .get(&(plugin.clone(), cap.clone(), root.clone()))
                .cloned()
                .or_else(|| self.pins.read().get(&(plugin.clone(), cap)).cloned())
                .ok_or_else(|| "run program is no longer granted".to_owned())?;
            return pin.verify().map(Path::to_path_buf);
        }
        drop(dynamic);
        let items = self.store.items.read();
        let (plugin, d) = items
            .iter()
            .find(|(_, plugin, d)| config_id(plugin, &d.id) == config.id)
            .map(|(_, p, d)| (p.clone(), d.clone()))
            .ok_or_else(|| "the plugin that detected this configuration is no longer enabled".to_owned())?;
        drop(items);
        let pin = self.pin(&plugin, &d, config.cwd.as_ref().map(|p| p.as_ref())).ok_or_else(|| {
            format!("allow process:{} for plugin {plugin} in Settings › Plugins to run this configuration", d.command)
        })?;
        pin.verify().map(Path::to_path_buf)
    }
}
