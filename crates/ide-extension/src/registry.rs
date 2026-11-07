//! Extension points plus the contributions committed to them, accounted per plugin.

use crate::capability::Capability;
use crate::point::{Disposable, ExtensionPoint, Package, Placement, Prepared};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

/// The point behind a package's `locales/<tag>.json` catalogs: it has no
/// `[[contributes.locales]]` table, the directory declares it.
pub const LOCALES_POINT: &str = "locales";
pub const LOCALES_DIR: &str = "locales";

/// A contribution as the plugin details page lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContributionInfo {
    pub point: String,
    pub label: String,
}

struct Entry {
    point: &'static str,
    key: Option<String>,
    label: String,
    disposable: Disposable,
}

/// Every declaration of a package, validated; nothing has taken effect yet.
pub struct PreparedSet {
    pub plugin: String,
    /// Union of what the declarations need (beyond the manifest's own list).
    pub capabilities: Vec<Capability>,
    /// Package files the declarations reference.
    pub files: Vec<PathBuf>,
    /// Declarations for extension points this host does not know (skipped).
    pub warnings: Vec<String>,
    items: Vec<(&'static str, Prepared)>,
}

impl PreparedSet {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}

impl std::fmt::Debug for PreparedSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedSet")
            .field("plugin", &self.plugin)
            .field("items", &self.items.len())
            .field("warnings", &self.warnings)
            .finish()
    }
}

#[derive(Default)]
pub struct ExtensionRegistry {
    points: RwLock<BTreeMap<&'static str, Arc<dyn ExtensionPoint>>>,
    /// plugin id → its contributions in commit order.
    entries: Mutex<BTreeMap<String, Vec<Entry>>>,
}

impl ExtensionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an extension point. Ids are unique.
    pub fn register(&self, point: Arc<dyn ExtensionPoint>) -> Result<(), String> {
        let id = point.id();
        crate::manifest::validate_point_id(id)?;
        let mut points = self.points.write();
        if points.contains_key(id) {
            return Err(format!("extension point {id:?} is already registered"));
        }
        points.insert(id, point);
        Ok(())
    }

    pub fn point_ids(&self) -> Vec<&'static str> {
        self.points.read().keys().copied().collect()
    }

    pub fn placement(&self, point: &str) -> Option<Placement> {
        self.points.read().get(point).map(|p| p.placement())
    }

    fn point(&self, id: &str) -> Option<Arc<dyn ExtensionPoint>> {
        self.points.read().get(id).cloned()
    }

    /// Validates every `contributes.<point>` declaration of `pkg`. Fails as a
    /// whole on the first invalid declaration; unknown points are skipped with
    /// a warning (forward compatibility).
    pub fn prepare(&self, pkg: &Package) -> Result<PreparedSet, String> {
        let mut set = PreparedSet {
            plugin: pkg.id().to_owned(),
            capabilities: Vec::new(),
            files: Vec::new(),
            warnings: Vec::new(),
            items: Vec::new(),
        };
        for point_id in pkg.manifest.contributes.keys() {
            let Some(point) = self.point(point_id) else {
                let msg = format!("contributes.{point_id}: not supported by this version of the IDE; skipped");
                tracing::warn!(plugin = %pkg.id(), "{msg}");
                set.warnings.push(msg);
                continue;
            };
            for (i, decl) in pkg.manifest.declarations(point_id).into_iter().enumerate() {
                let prepared = point
                    .prepare(pkg, decl)
                    .map_err(|e| format!("contributes.{point_id}[{i}]: {}", strip_prefix(&e, point_id)))?;
                for cap in &prepared.capabilities {
                    if !set.capabilities.contains(cap) {
                        set.capabilities.push(cap.clone());
                    }
                }
                for f in &prepared.files {
                    if !set.files.contains(f) {
                        set.files.push(f.clone());
                    }
                }
                set.items.push((point.id(), prepared));
            }
        }
        if let Some(point) = self.point(LOCALES_POINT)
            && !pkg.manifest.contributes.contains_key(LOCALES_POINT)
            && pkg.dir.join(LOCALES_DIR).is_dir()
        {
            let prepared = point
                .prepare(pkg, toml::Value::Table(Default::default()))
                .map_err(|e| format!("{LOCALES_DIR}: {}", strip_prefix(&e, LOCALES_POINT)))?;
            for f in &prepared.files {
                if !set.files.contains(f) {
                    set.files.push(f.clone());
                }
            }
            set.items.push((point.id(), prepared));
        }
        Ok(set)
    }

    /// Makes a prepared set take effect, all or nothing: if one commit fails,
    /// the ones before it are disposed in reverse order.
    pub fn commit(&self, set: PreparedSet) -> Result<(), String> {
        let mut committed: Vec<Entry> = Vec::with_capacity(set.items.len());
        for (point, prepared) in set.items {
            let Prepared { key, label, commit, .. } = prepared;
            match commit() {
                Ok(disposable) => committed.push(Entry { point, key, label, disposable }),
                Err(e) => {
                    tracing::error!(plugin = %set.plugin, "contributes.{point}: commit failed: {e}");
                    while let Some(entry) = committed.pop() {
                        entry.disposable.dispose();
                    }
                    return Err(format!("contributes.{point}: {e}"));
                }
            }
        }
        let replaced = {
            let mut entries = self.entries.lock();
            let list = entries.entry(set.plugin).or_default();
            let mut replaced = Vec::new();
            for new in &committed {
                if let Some(key) = &new.key
                    && let Some(pos) = list.iter().position(|e| e.point == new.point && e.key.as_ref() == Some(key))
                {
                    replaced.push(list.remove(pos));
                }
            }
            list.extend(committed);
            replaced
        };
        for old in replaced.into_iter().rev() {
            old.disposable.dispose();
        }
        Ok(())
    }

    /// Withdraws everything `plugin` contributed, newest first.
    pub fn dispose_plugin(&self, plugin: &str) -> bool {
        let list = self.entries.lock().remove(plugin).unwrap_or_default();
        let any = !list.is_empty();
        for entry in list.into_iter().rev() {
            entry.disposable.dispose();
        }
        any
    }

    pub fn contributions(&self, plugin: &str) -> Vec<ContributionInfo> {
        self.entries
            .lock()
            .get(plugin)
            .map(|list| {
                list.iter().map(|e| ContributionInfo { point: e.point.into(), label: e.label.clone() }).collect()
            })
            .unwrap_or_default()
    }

    /// How many contributions `plugin` has at `point`.
    pub fn count(&self, plugin: &str, point: &str) -> usize {
        self.entries.lock().get(plugin).map_or(0, |list| list.iter().filter(|e| e.point == point).count())
    }

    /// Plugins with at least one contribution.
    pub fn plugins(&self) -> Vec<String> {
        self.entries.lock().iter().filter(|(_, l)| !l.is_empty()).map(|(id, _)| id.clone()).collect()
    }
}

fn strip_prefix<'a>(e: &'a str, point: &str) -> &'a str {
    e.strip_prefix(&format!("contributes.{point}: ")).unwrap_or(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records live items in a shared list; `fail = true` makes commit fail.
    struct Recording {
        id: &'static str,
        live: Arc<Mutex<Vec<String>>>,
        commits: Arc<AtomicUsize>,
    }

    impl ExtensionPoint for Recording {
        fn id(&self) -> &'static str {
            self.id
        }
        fn placement(&self) -> Placement {
            Placement::Ui
        }
        fn prepare(&self, _pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
            let name = decl.get("name").and_then(|v| v.as_str()).ok_or("missing name")?.to_owned();
            let fail = decl.get("fail").and_then(|v| v.as_bool()).unwrap_or(false);
            let (live, commits) = (self.live.clone(), self.commits.clone());
            let label = name.clone();
            let mut p = Prepared::new(label, move || {
                commits.fetch_add(1, Ordering::SeqCst);
                if fail {
                    return Err("boom".into());
                }
                live.lock().push(name.clone());
                Ok(Disposable::new(move || live.lock().retain(|n| *n != name)))
            });
            if let Some(f) = decl.get("file").and_then(|v| v.as_str()) {
                p = p.file(f);
            }
            if decl.get("key").and_then(|v| v.as_bool()).unwrap_or(false) {
                p = p.key("k");
            }
            Ok(p)
        }
    }

    fn setup() -> (ExtensionRegistry, Arc<Mutex<Vec<String>>>) {
        let reg = ExtensionRegistry::new();
        let live = Arc::new(Mutex::new(Vec::new()));
        let commits = Arc::new(AtomicUsize::new(0));
        reg.register(Arc::new(Recording { id: "things", live: live.clone(), commits: commits.clone() })).unwrap();
        reg.register(Arc::new(Recording { id: "others", live: live.clone(), commits })).unwrap();
        (reg, live)
    }

    fn pkg(contributes: &str) -> Package {
        let src = format!("id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n{contributes}");
        Package::new(Manifest::parse(&src).unwrap(), PathBuf::from("/nonexistent"))
    }

    #[test]
    fn commits_and_disposes_per_plugin() {
        let (reg, live) = setup();
        assert!(
            reg.register(Arc::new(Recording { id: "things", live: live.clone(), commits: Default::default() }))
                .is_err()
        );
        let p = pkg(
            "[[contributes.things]]\nname = \"a\"\nfile = \"x.json\"\n[[contributes.things]]\nname = \"b\"\n[contributes.others]\nname = \"c\"",
        );
        let set = reg.prepare(&p).unwrap();
        assert_eq!(set.len(), 3);
        assert_eq!(set.files, [PathBuf::from("x.json")]);
        assert!(live.lock().is_empty(), "prepare has no side effects");
        reg.commit(set).unwrap();
        assert_eq!(*live.lock(), ["c", "a", "b"]);
        assert_eq!(reg.count("p", "things"), 2);
        assert_eq!(reg.contributions("p").len(), 3);
        assert!(reg.dispose_plugin("p"));
        assert!(live.lock().is_empty());
    }

    #[test]
    fn a_failed_commit_rolls_back() {
        let (reg, live) = setup();
        let p = pkg("[[contributes.things]]\nname = \"a\"\n[[contributes.things]]\nname = \"b\"\nfail = true");
        let err = reg.commit(reg.prepare(&p).unwrap()).unwrap_err();
        assert!(err.contains("boom"));
        assert!(live.lock().is_empty(), "a was undone");
        assert!(reg.contributions("p").is_empty());
    }

    #[test]
    fn invalid_declarations_fail_prepare_and_unknown_points_warn() {
        let (reg, _) = setup();
        let err = reg.prepare(&pkg("[[contributes.things]]\nnope = 1")).unwrap_err();
        assert_eq!(err, "contributes.things[0]: missing name");
        let set =
            reg.prepare(&pkg("[[contributes.futureThing]]\nx = 1\n[[contributes.things]]\nname = \"a\"")).unwrap();
        assert_eq!(set.len(), 1);
        assert_eq!(set.warnings.len(), 1);
        assert!(set.warnings[0].contains("futureThing"));
    }
}
