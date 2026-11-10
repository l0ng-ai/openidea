//! Extension points plus the contributions committed to them, accounted per plugin.

use crate::capability::Capability;
use crate::plugin_point::PointDecl;
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
    point: String,
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
    items: Vec<(String, Prepared)>,
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

/// What one plugin contributed to an extension point another plugin declared.
#[derive(Clone, Debug, PartialEq)]
pub struct Contribution {
    /// The contributing plugin.
    pub plugin: String,
    /// The declaration as JSON, checked against the point's fields.
    pub data: serde_json::Value,
}

/// An extension point a plugin declared, with who contributes to it.
#[derive(Clone, Debug, PartialEq)]
pub struct DeclaredPoint {
    pub owner: String,
    pub decl: PointDecl,
    /// Plugin ids, in commit order, once each.
    pub contributors: Vec<String>,
}

#[derive(Default)]
struct Dynamic {
    points: BTreeMap<String, (String, PointDecl)>,
    contributions: BTreeMap<String, Vec<Contribution>>,
}

/// Called with (point id, owner plugin) after contributions to a declared point changed.
pub type ChangeListener = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Default)]
pub struct ExtensionRegistry {
    points: RwLock<BTreeMap<&'static str, Arc<dyn ExtensionPoint>>>,
    /// plugin id → its contributions in commit order.
    entries: Mutex<BTreeMap<String, Vec<Entry>>>,
    /// Points declared by plugins and what was contributed to them.
    dynamic: Arc<Mutex<Dynamic>>,
    listener: Arc<RwLock<Option<ChangeListener>>>,
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

    /// Registers the function told when contributions to a plugin-declared point change.
    pub fn set_change_listener(&self, listener: ChangeListener) {
        *self.listener.write() = Some(listener);
    }

    /// The plugin that declared `point`, while it is committed.
    pub fn point_owner(&self, point: &str) -> Option<String> {
        self.dynamic.lock().points.get(point).map(|(owner, _)| owner.clone())
    }

    /// What plugins contributed to `point`, in commit order. Empty unless a plugin declares it.
    pub fn contributions_to(&self, point: &str) -> Vec<Contribution> {
        let dynamic = self.dynamic.lock();
        if !dynamic.points.contains_key(point) {
            return Vec::new();
        }
        dynamic.contributions.get(point).cloned().unwrap_or_default()
    }

    /// The points `owner` declared, with their contributors.
    pub fn declared_points(&self, owner: &str) -> Vec<DeclaredPoint> {
        let dynamic = self.dynamic.lock();
        dynamic
            .points
            .iter()
            .filter(|(_, (o, _))| o == owner)
            .map(|(id, (owner, decl))| {
                let mut contributors: Vec<String> = Vec::new();
                for c in dynamic.contributions.get(id).into_iter().flatten() {
                    if !contributors.contains(&c.plugin) {
                        contributors.push(c.plugin.clone());
                    }
                }
                DeclaredPoint { owner: owner.clone(), decl: decl.clone(), contributors }
            })
            .collect()
    }

    /// Makes `pkg`'s `[[extension-points]]` known: they take effect with the set's commit.
    fn prepare_declarations(&self, pkg: &Package) -> Vec<(String, Prepared)> {
        pkg.manifest
            .extension_points
            .iter()
            .map(|decl| {
                let (dynamic, owner, decl) = (self.dynamic.clone(), pkg.id().to_owned(), decl.clone());
                let id = decl.id.clone();
                let prepared = Prepared::new(format!("Extension point {id}"), move || {
                    let id = decl.id.clone();
                    dynamic.lock().points.insert(id.clone(), (owner.clone(), decl));
                    Ok(Disposable::new(move || {
                        dynamic.lock().points.remove(&id);
                    }))
                })
                .key(format!("extension-point:{id}"));
                (id, prepared)
            })
            .collect()
    }

    /// Validates `pkg`'s contributions to a point some plugin declares, or `None`
    /// when no plugin declares `point` (the caller then skips it as unknown).
    fn prepare_contributions(&self, pkg: &Package, point: &str) -> Option<Result<Vec<Prepared>, String>> {
        let declared = self.dynamic.lock().points.get(point).cloned();
        let own =
            pkg.manifest.extension_points.iter().find(|d| d.id == point).map(|d| (pkg.id().to_owned(), d.clone()));
        let (owner, decl) = declared.or(own)?;
        if owner != pkg.id() && !pkg.manifest.depends.iter().any(|d| d.id == owner) {
            return Some(Err(format!("{point} is declared by {owner}: add it to [[depends]]")));
        }
        let listener = self.listener.clone();
        let result = pkg
            .manifest
            .declarations(point)
            .into_iter()
            .enumerate()
            .map(|(i, value)| {
                let data = decl.check(&value).map_err(|e| format!("contributions[{i}]: {e}"))?;
                let label = decl
                    .required
                    .first()
                    .and_then(|field| data.get(field))
                    .and_then(|v| v.as_str())
                    .map_or_else(|| point.to_owned(), str::to_owned);
                let contribution = Contribution { plugin: pkg.id().to_owned(), data };
                let (dynamic, listener, point) = (self.dynamic.clone(), listener.clone(), point.to_owned());
                Ok(Prepared::new(label, move || {
                    dynamic.lock().contributions.entry(point.clone()).or_default().push(contribution.clone());
                    notify(&dynamic, &listener, &point);
                    Ok(Disposable::new(move || {
                        {
                            let mut guard = dynamic.lock();
                            if let Some(list) = guard.contributions.get_mut(&point)
                                && let Some(pos) = list.iter().position(|c| *c == contribution)
                            {
                                list.remove(pos);
                            }
                        }
                        notify(&dynamic, &listener, &point);
                    }))
                }))
            })
            .collect();
        Some(result)
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
        // Declared points first: contributions to them (the plugin's own too) commit after.
        set.items.extend(self.prepare_declarations(pkg));
        for point_id in pkg.manifest.contributes.keys() {
            let Some(point) = self.point(point_id) else {
                if let Some(result) = self.prepare_contributions(pkg, point_id) {
                    let prepared = result.map_err(|e| format!("contributes.{point_id}: {e}"))?;
                    set.items.extend(prepared.into_iter().map(|p| (point_id.clone(), p)));
                    continue;
                }
                // Point ids are `<owner id>.<name>`, so the dependency that owns it can be named.
                let owner =
                    pkg.manifest.depends.iter().find(|d| point_id.strip_prefix(&format!("{}.", d.id)).is_some());
                let msg = match owner {
                    Some(owner) => {
                        format!("contributes.{point_id}: {} is not running, so this is skipped until it is", owner.id)
                    }
                    None => format!("contributes.{point_id}: not supported by this version of the IDE; skipped"),
                };
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
                set.items.push((point.id().to_owned(), prepared));
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
            set.items.push((point.id().to_owned(), prepared));
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
                list.iter().map(|e| ContributionInfo { point: e.point.clone(), label: e.label.clone() }).collect()
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

fn notify(dynamic: &Mutex<Dynamic>, listener: &RwLock<Option<ChangeListener>>, point: &str) {
    let owner = dynamic.lock().points.get(point).map(|(owner, _)| owner.clone());
    let callback = listener.read().clone();
    if let (Some(owner), Some(callback)) = (owner, callback) {
        callback(point, &owner);
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

    fn pkg_of(id: &str, body: &str) -> Package {
        let src = format!("id = \"{id}\"\nname = \"N\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.5\"\n{body}");
        Package::new(Manifest::parse(&src).unwrap(), PathBuf::from("/nonexistent"))
    }

    const BASE: &str = r#"
        [[extension-points]]
        id = "acme.base.things"
        required = ["name"]
        fields = { name = "string", weight = "integer" }
    "#;
    const PLUGIN: &str =
        "[[depends]]\nid = \"acme.base\"\n\n[[contributes.\"acme.base.things\"]]\nname = \"a\"\nweight = 2\n";

    fn commit(reg: &ExtensionRegistry, pkg: &Package) {
        reg.commit(reg.prepare(pkg).unwrap()).unwrap();
    }

    #[test]
    fn a_plugin_declares_a_point_and_a_dependent_contributes_to_it() {
        let reg = ExtensionRegistry::new();
        commit(&reg, &pkg_of("acme.base", BASE));
        assert_eq!(reg.point_owner("acme.base.things").as_deref(), Some("acme.base"));
        assert!(reg.contributions_to("acme.base.things").is_empty());

        commit(&reg, &pkg_of("acme.more", PLUGIN));
        let got = reg.contributions_to("acme.base.things");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].plugin, "acme.more");
        assert_eq!(got[0].data, serde_json::json!({"name": "a", "weight": 2}));
        assert_eq!(
            reg.contributions("acme.more")[0],
            ContributionInfo { point: "acme.base.things".into(), label: "a".into() }
        );
        let declared = reg.declared_points("acme.base");
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].contributors, ["acme.more"]);

        assert!(reg.dispose_plugin("acme.more"));
        assert!(reg.contributions_to("acme.base.things").is_empty());
        assert!(reg.dispose_plugin("acme.base"));
        assert_eq!(reg.point_owner("acme.base.things"), None);
    }

    #[test]
    fn contributions_disappear_from_view_while_the_owner_is_gone() {
        let reg = ExtensionRegistry::new();
        commit(&reg, &pkg_of("acme.base", BASE));
        commit(&reg, &pkg_of("acme.more", PLUGIN));
        reg.dispose_plugin("acme.base");
        assert!(reg.contributions_to("acme.base.things").is_empty(), "nobody may read a point that is not declared");
        commit(&reg, &pkg_of("acme.base", BASE));
        assert_eq!(reg.contributions_to("acme.base.things").len(), 1, "back with the owner");
    }

    #[test]
    fn contributing_needs_a_dependency_on_the_owner() {
        let reg = ExtensionRegistry::new();
        commit(&reg, &pkg_of("acme.base", BASE));
        let err =
            reg.prepare(&pkg_of("acme.rogue", "[[contributes.\"acme.base.things\"]]\nname = \"x\"\n")).unwrap_err();
        assert!(err.contains("acme.base") && err.contains("[[depends]]"), "{err}");
    }

    #[test]
    fn a_contribution_is_checked_against_the_declared_fields() {
        let reg = ExtensionRegistry::new();
        commit(&reg, &pkg_of("acme.base", BASE));
        let bad = "[[depends]]\nid = \"acme.base\"\n[[contributes.\"acme.base.things\"]]\nweight = 1\n";
        let err = reg.prepare(&pkg_of("acme.more", bad)).unwrap_err();
        assert_eq!(err, "contributes.acme.base.things: contributions[0]: missing required field \"name\"");
    }

    #[test]
    fn a_point_nobody_declares_is_skipped_with_a_warning() {
        let reg = ExtensionRegistry::new();
        let set = reg.prepare(&pkg_of("acme.more", PLUGIN)).unwrap();
        assert!(set.is_empty());
        assert!(set.warnings[0].contains("acme.base.things"), "{:?}", set.warnings);
    }

    #[test]
    fn a_missing_owner_is_named_instead_of_blaming_the_ide_version() {
        let reg = ExtensionRegistry::new();
        let set = reg.prepare(&pkg_of("acme.more", PLUGIN)).unwrap();
        let warning = &set.warnings[0];
        assert!(warning.contains("acme.base") && warning.contains("not running"), "{warning}");
        assert!(!warning.contains("this version of the IDE"), "{warning}");

        let unrelated = "[[contributes.\"acme.nobody.things\"]]\nname = \"x\"\n";
        let set = reg.prepare(&pkg_of("acme.more", unrelated)).unwrap();
        assert!(set.warnings[0].contains("this version of the IDE"), "{:?}", set.warnings);
    }

    #[test]
    fn a_plugin_may_contribute_to_its_own_point() {
        let reg = ExtensionRegistry::new();
        let own = format!("{BASE}\n[[contributes.\"acme.base.things\"]]\nname = \"builtin\"\n");
        commit(&reg, &pkg_of("acme.base", &own));
        assert_eq!(reg.contributions_to("acme.base.things")[0].data["name"], "builtin");
    }

    #[test]
    fn the_owner_hears_about_changes_to_its_point() {
        let reg = ExtensionRegistry::new();
        let heard: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let sink = heard.clone();
        reg.set_change_listener(Arc::new(move |point, owner| sink.lock().push((point.into(), owner.into()))));
        commit(&reg, &pkg_of("acme.base", BASE));
        assert!(heard.lock().is_empty(), "declaring is not a contribution");
        commit(&reg, &pkg_of("acme.more", PLUGIN));
        reg.dispose_plugin("acme.more");
        let expected = ("acme.base.things".to_owned(), "acme.base".to_owned());
        assert_eq!(*heard.lock(), [expected.clone(), expected]);
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
