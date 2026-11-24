//! Shared by the integration tests (each declares `mod common;`).

use ide_host::HostConfig;
use std::path::Path;
use std::sync::Arc;

/// A host under `base`: `config`, `data` and `data` again for the machine-local directory,
/// built-in languages, no grammars, a sink that drops events, the window as its own owner, the
/// current tokio runtime and no project environment. Override fields with
/// `HostConfig { sink_for: .., ..common::host_config(base) }`. Call it inside a runtime.
pub fn host_config(base: &Path) -> HostConfig {
    HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }
}
