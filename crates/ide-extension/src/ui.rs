//! UI contributions: validated declarations projected to the client.
//!
//! A `Ui` extension point validates a declaration completely in Rust and
//! commits it as JSON into the [`UiStore`]; the client receives the store's
//! snapshot and projects each item onto an existing `register*` function
//! (`defineUiPoint` in `src/features/plugins/projection.ts`). Large payloads
//! (icon SVGs) go into the store's assets and are fetched on demand.

use crate::index::ContributionIndex;
use crate::point::{Disposable, ExtensionPoint, Package, Placement, Prepared};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// One projected declaration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UiContribution {
    pub plugin_id: String,
    /// Extension point id (`commands`, `iconThemes`, …).
    pub point: String,
    /// Stable within (plugin, point): the client keys its registrations on it.
    pub key: String,
    /// The validated declaration, shaped by the point.
    #[specta(type = specta_typescript::Unknown)]
    pub decl: serde_json::Value,
}

struct Item {
    seq: u64,
    contribution: UiContribution,
}

/// Committed UI contributions of all plugins.
#[derive(Default)]
pub struct UiStore {
    items: RwLock<Vec<Item>>,
    /// (plugin, asset id) → content.
    assets: RwLock<BTreeMap<(String, String), Arc<str>>>,
    seq: AtomicU64,
    revision: AtomicU64,
    index: RwLock<Option<Arc<ContributionIndex>>>,
}

impl UiStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Adds an item; the returned disposable removes it.
    pub fn insert(self: &Arc<Self>, contribution: UiContribution) -> Disposable {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        self.items.write().push(Item { seq, contribution });
        self.revision.fetch_add(1, Ordering::Release);
        let store = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(store) = store.upgrade() {
                store.items.write().retain(|i| i.seq != seq);
                store.revision.fetch_add(1, Ordering::Release);
            }
        })
    }

    /// Stores assets of a plugin (ids are unique per plugin; later ones replace).
    pub fn insert_assets(self: &Arc<Self>, plugin: &str, assets: Vec<(String, String)>) -> Disposable {
        let keys: Vec<(String, String)> = assets.iter().map(|(id, _)| (plugin.to_owned(), id.clone())).collect();
        {
            let mut map = self.assets.write();
            for (id, content) in assets {
                map.insert((plugin.to_owned(), id), Arc::from(content));
            }
        }
        let store = Arc::downgrade(self);
        Disposable::new(move || {
            if let Some(store) = store.upgrade() {
                let mut map = store.assets.write();
                for k in keys {
                    map.remove(&k);
                }
            }
        })
    }

    pub fn asset(&self, plugin: &str, id: &str) -> Option<Arc<str>> {
        self.assets.read().get(&(plugin.to_owned(), id.to_owned())).cloned()
    }

    /// Assets of `plugin` whose id starts with `prefix`.
    pub fn assets_with_prefix(&self, plugin: &str, prefix: &str) -> Vec<(String, Arc<str>)> {
        self.assets
            .read()
            .range((plugin.to_owned(), prefix.to_owned())..)
            .take_while(|((p, id), _)| p == plugin && id.starts_with(prefix))
            .map(|((_, id), v)| (id.clone(), v.clone()))
            .collect()
    }

    /// Where [`UiPoint`]s keep validated declarations of installed packages.
    pub fn set_index(&self, index: Option<Arc<ContributionIndex>>) {
        *self.index.write() = index;
    }

    /// Bumped on every change: clients compare it to skip re-projection.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub fn snapshot(&self) -> Vec<UiContribution> {
        self.items.read().iter().map(|i| i.contribution.clone()).collect()
    }

    /// Items of one point, optionally of one plugin.
    pub fn items(&self, point: &str, plugin: Option<&str>) -> Vec<UiContribution> {
        self.items
            .read()
            .iter()
            .filter(|i| i.contribution.point == point && plugin.is_none_or(|p| i.contribution.plugin_id == p))
            .map(|i| i.contribution.clone())
            .collect()
    }
}

/// What a [`UiPoint`]'s validator produces for one declaration.
#[derive(Debug, Serialize, Deserialize)]
pub struct UiDecl {
    pub key: String,
    pub label: String,
    pub json: serde_json::Value,
    /// Package files referenced (copied on install).
    pub files: Vec<PathBuf>,
    /// Large validated payloads fetched separately by the client.
    pub assets: Vec<(String, String)>,
}

impl UiDecl {
    pub fn new(key: impl Into<String>, label: impl Into<String>, json: serde_json::Value) -> Self {
        Self { key: key.into(), label: label.into(), json, files: Vec::new(), assets: Vec::new() }
    }
}

type Validate = dyn Fn(&Package, toml::Value) -> Result<UiDecl, String> + Send + Sync;

/// A `Ui` extension point defined by a validator: committing stores the
/// validated JSON (and assets) in the [`UiStore`]. Most UI contribution types
/// (menus, keybindings, status bar items, icon themes) are one of these.
pub struct UiPoint {
    id: &'static str,
    store: Arc<UiStore>,
    validate: Box<Validate>,
}

impl UiPoint {
    pub fn new(
        id: &'static str,
        store: Arc<UiStore>,
        validate: impl Fn(&Package, toml::Value) -> Result<UiDecl, String> + Send + Sync + 'static,
    ) -> Self {
        Self { id, store, validate: Box::new(validate) }
    }
}

impl ExtensionPoint for UiPoint {
    fn id(&self) -> &'static str {
        self.id
    }

    fn placement(&self) -> Placement {
        Placement::Ui
    }

    fn prepare(&self, pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let index = pkg.digest.as_ref().and_then(|_| self.store.index.read().clone());
        let ui = match index.as_ref().and_then(|i| i.get(pkg, self.id, &decl)) {
            Some(ui) => ui,
            None => match &index {
                Some(i) => {
                    let ui = (self.validate)(pkg, decl.clone())?;
                    i.put(pkg, self.id, &decl, &ui);
                    ui
                }
                None => (self.validate)(pkg, decl)?,
            },
        };
        let UiDecl { key, label, json, files, assets } = ui;
        let store = self.store.clone();
        let contribution =
            UiContribution { plugin_id: pkg.id().to_owned(), point: self.id.to_owned(), key: key.clone(), decl: json };
        let plugin = pkg.id().to_owned();
        let mut prepared = Prepared::new(label, move || {
            let item = store.insert(contribution);
            if assets.is_empty() {
                return Ok(item);
            }
            let assets = store.insert_assets(&plugin, assets);
            Ok(Disposable::new(move || {
                item.dispose();
                assets.dispose();
            }))
        })
        .key(key);
        prepared.files = files;
        Ok(prepared)
    }
}

/// TOML declaration → JSON for the client.
pub fn to_json(v: &toml::Value) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::registry::ExtensionRegistry;

    #[test]
    fn ui_point_projects_into_the_store() {
        let store = UiStore::new();
        let reg = ExtensionRegistry::new();
        reg.register(Arc::new(UiPoint::new("badges", store.clone(), |_pkg, decl| {
            let text = decl.get("text").and_then(|v| v.as_str()).ok_or("missing text")?.to_owned();
            let mut d = UiDecl::new(text.clone(), text.clone(), serde_json::json!({ "text": text }));
            d.assets.push((format!("badge/{text}"), "<svg/>".into()));
            Ok(d)
        })))
        .unwrap();
        let src = "id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
                   [[contributes.badges]]\ntext = \"hi\"";
        let pkg = Package::new(Manifest::parse(src).unwrap(), PathBuf::from("/x"));
        let rev = store.revision();
        reg.commit(reg.prepare(&pkg).unwrap()).unwrap();
        assert!(store.revision() > rev);
        let items = store.items("badges", Some("p"));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].decl["text"], "hi");
        assert_eq!(store.asset("p", "badge/hi").as_deref(), Some("<svg/>"));
        assert_eq!(store.assets_with_prefix("p", "badge/").len(), 1);
        reg.dispose_plugin("p");
        assert!(store.snapshot().is_empty());
        assert!(store.asset("p", "badge/hi").is_none());
    }
}
