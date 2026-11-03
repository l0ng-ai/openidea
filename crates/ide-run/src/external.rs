//! Run configurations detected outside this crate: plugins' `runDetectors`
//! (docs/plugin_plan.md P3). Their ids start with [`EXTERNAL_PREFIX`]; before
//! one is started the provider names the program to run (the file approved
//! for the plugin's `process:` capability) or refuses.

use crate::RunConfig;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Id prefix of externally detected configurations (`plugin:<plugin>:<id>`).
pub const EXTERNAL_PREFIX: &str = "plugin:";

pub trait ExternalDetection: Send + Sync {
    /// Configurations for the project at `root`; ids start with [`EXTERNAL_PREFIX`].
    fn detect(&self, root: &Path) -> Vec<RunConfig>;
    /// The program to start for `config` (one this provider detected), or why
    /// it may not start.
    fn launch(&self, config: &RunConfig) -> Result<PathBuf, String>;
}

static PROVIDER: RwLock<Option<Arc<dyn ExternalDetection>>> = RwLock::new(None);

/// Installs (or removes) the provider [`crate::detect`] and runs consult.
pub fn set_external_detection(provider: Option<Arc<dyn ExternalDetection>>) {
    *PROVIDER.write() = provider;
}

pub(crate) fn detect(root: &Path, out: &mut Vec<RunConfig>) {
    let provider = PROVIDER.read().clone();
    if let Some(p) = provider {
        out.extend(p.detect(root).into_iter().filter(|c| c.id.starts_with(EXTERNAL_PREFIX)));
    }
}

/// `config` with the program its provider approved, for an externally
/// detected configuration; `None` for every other one.
pub(crate) fn approved(config: &RunConfig) -> Option<Result<RunConfig, String>> {
    if !config.detected || !config.id.starts_with(EXTERNAL_PREFIX) {
        return None;
    }
    let provider = PROVIDER.read().clone();
    Some(match provider {
        Some(p) => p
            .launch(config)
            .map(|program| RunConfig { command: program.to_string_lossy().into_owned(), ..config.clone() }),
        None => Err("the plugin that detected this configuration is not loaded".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProcessManager, StartOptions};

    /// Answers only for projects with its own marker (tests share the provider).
    struct Fake;

    const MARKER: &str = "fake-external-detection.marker";

    impl ExternalDetection for Fake {
        fn detect(&self, root: &Path) -> Vec<RunConfig> {
            if !root.join(MARKER).exists() {
                return Vec::new();
            }
            let mut c: RunConfig = serde_json::from_value(serde_json::json!({
                "id": "plugin:acme:x", "name": "x", "kind": "plugin", "command": "x", "args": ["a"],
                "cwd": null, "env": {}, "detected": true, "isTest": false, "debugAdapter": null
            }))
            .unwrap();
            c.detected = true;
            let other = RunConfig { id: "not-prefixed".into(), ..c.clone() };
            vec![c, other]
        }
        fn launch(&self, _: &RunConfig) -> Result<PathBuf, String> {
            Err("not allowed".into())
        }
    }

    #[test]
    fn external_configs_join_detection_and_launch_only_when_approved() {
        set_external_detection(Some(Arc::new(Fake)));
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(MARKER), "").unwrap();
        let configs = crate::detect(tmp.path());
        assert_eq!(configs.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["plugin:acme:x"]);
        let err = ProcessManager::new()
            .start(tmp.path(), &configs[0], &StartOptions::default(), Arc::new(ide_core::NullSink), Box::new(|_| {}))
            .unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::PermissionDenied);
        assert!(err.message.contains("not allowed"));
    }
}
