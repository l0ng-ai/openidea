//! Plugins bundled with the app, like IntelliJ's: the ids listed in
//! `plugins/bundled.json`, whose packages ship in the app's resources
//! (`<resources>/plugins/`; debug builds use the repository's `plugins/official/`).
//! [`PluginHost::sync_bundled`] applies them at start-up:
//!
//! - one that isn't installed is installed, and so enabled; its required
//!   capabilities are granted without an install page ([`Ledger::grant_bundled`]);
//! - an installed one is replaced when the app brings a newer version, once: a
//!   newer version from the marketplace stays, and so does a rolled-back update;
//! - disabling it is the user's choice and survives both;
//! - it can't be uninstalled. An id dropped from the list leaves the plugin
//!   installed as an ordinary one, which the user may then uninstall.
//!
//! [`Ledger::grant_bundled`]: ide_extension::ledger::Ledger::grant_bundled

use super::{LoadedPlugin, PluginHost, PluginSource, package_dirs};
use ide_extension::{Manifest, validate_plugin_id};
use semver::Version;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    plugins: Vec<String>,
}

fn parse(text: &str) -> Result<Vec<String>, String> {
    let list: List = serde_json::from_str(text).map_err(|e| e.to_string())?;
    for id in &list.plugins {
        validate_plugin_id(id)?;
    }
    Ok(list.plugins)
}

/// The ids of the plugins bundled with this build (`plugins/bundled.json`).
pub fn bundled_ids() -> Vec<String> {
    parse(include_str!("../../../../plugins/bundled.json")).unwrap_or_else(|e| {
        tracing::error!("plugins/bundled.json: {e}");
        Vec::new()
    })
}

/// `offered` is a newer version than `installed`.
fn newer(offered: &str, installed: &str) -> bool {
    match (Version::parse(offered), Version::parse(installed)) {
        (Ok(offered), Ok(installed)) => offered > installed,
        _ => false,
    }
}

impl PluginHost {
    /// Installs or updates the bundled plugins `ids` from the package folders
    /// in `sources`. Call it once [`load_all`](Self::load_all) has run; a
    /// package that is missing or doesn't install is logged and skipped.
    pub fn sync_bundled(&self, ids: &[String], sources: &[PathBuf]) {
        let mut changed = {
            let mut state = self.state.lock();
            let before = state.bundled.len();
            state.bundled.retain(|id, _| ids.contains(id));
            state.bundled.len() != before
        };
        let mut packages: Vec<(Manifest, PathBuf)> = Vec::new();
        for dir in sources.iter().flat_map(|d| package_dirs(d)) {
            if let Ok(m) = Manifest::load(&dir)
                && ids.contains(&m.id)
                && !packages.iter().any(|(p, _)| p.id == m.id)
            {
                packages.push((m, dir));
            }
        }
        for id in ids {
            let Some((manifest, dir)) = packages.iter().find(|(m, _)| m.id == *id) else {
                tracing::warn!("bundled plugin {id}: no package in {}", joined(sources));
                continue;
            };
            let version = &manifest.version;
            if self.bundled_install_due(id, version) {
                if let Err(e) = self.install(dir, None) {
                    tracing::warn!("bundled plugin {id} {version}: {}", e.message);
                    continue;
                }
                tracing::info!("bundled plugin {id} {version} installed");
            } else if self.state.lock().bundled.get(id) == Some(version) {
                continue;
            }
            self.state.lock().bundled.insert(id.clone(), version.clone());
            changed = true;
        }
        if changed {
            self.save_state();
            self.changed();
        }
    }

    /// Whether the app's `version` of bundled plugin `id` should be installed.
    fn bundled_install_due(&self, id: &str, version: &str) -> bool {
        let installed = self.plugins.read().get(id).map(|p| (p.source, p.manifest().version.clone()));
        match installed {
            None => true,
            // Offered once: a rolled-back update isn't installed again.
            Some((PluginSource::Installed, have)) => {
                newer(version, &have) && self.state.lock().bundled.get(id).map(String::as_str) != Some(version)
            }
            // A linked or project copy with the same id wins, as over any install.
            Some(_) => false,
        }
    }

    pub(super) fn is_bundled(&self, plugin: &LoadedPlugin) -> bool {
        plugin.source == PluginSource::Installed && self.state.lock().bundled.contains_key(plugin.id())
    }
}

fn joined(dirs: &[PathBuf]) -> String {
    dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_shipped_list_names_official_plugins() {
        let ids = parse(include_str!("../../../../plugins/bundled.json")).unwrap();
        let official = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/official");
        let available: Vec<String> =
            package_dirs(&official).iter().filter_map(|d| Manifest::load(d).ok()).map(|m| m.id).collect();
        for id in ids {
            assert!(available.contains(&id), "{id} is not a plugin in plugins/official");
        }
    }

    #[test]
    fn lists_are_checked() {
        assert_eq!(parse(r#"{ "plugins": ["openidea.a", "b"] }"#).unwrap(), ["openidea.a", "b"]);
        assert!(parse(r#"{ "plugins": ["Not An Id"] }"#).is_err());
        assert!(parse(r#"["openidea.a"]"#).is_err());
        assert!(newer("1.10.0", "1.9.0") && !newer("1.0.0", "1.0.0") && !newer("2.0.0", "x"));
    }
}
