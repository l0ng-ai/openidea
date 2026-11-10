//! Plugin dependencies at run time: which plugins may start, in which order,
//! and what follows when a plugin they need goes away or comes back.

use super::{LoadedPlugin, PluginHost, PluginStatus, types::*};
use ide_extension::{Blocked, Node, Plan, dependency_state, dependents, plan};
use ide_plugin::WorkbenchEvent;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Points whose contributions changed since the owners were last told.
pub(super) type PendingChanges = Arc<parking_lot::Mutex<BTreeSet<String>>>;

impl PluginHost {
    /// The plan for the plugins as they are now. Plugins that are switched off,
    /// broken or being uninstalled cannot be depended on.
    fn dependency_plan(&self) -> Plan {
        self.with_nodes(|_, plan| plan.clone())
    }

    fn with_nodes<R>(&self, f: impl FnOnce(&[Node<'_>], &Plan) -> R) -> R {
        let plugins: Vec<Arc<LoadedPlugin>> = self.plugins.read().values().cloned().collect();
        let disabled = self.state.lock().disabled.clone();
        let nodes: Vec<Node<'_>> = plugins
            .iter()
            .map(|p| Node {
                id: p.id(),
                version: &p.manifest().version,
                depends: &p.manifest().depends,
                enabled: !disabled.contains(p.id()) && !p.invalid && !p.meta.lock().uninstalling,
            })
            .collect();
        let plan = plan(&nodes);
        f(&nodes, &plan)
    }

    /// Why `plugin` may not start now, if it may not.
    pub(super) fn blocked_reason(&self, plugin: &LoadedPlugin) -> Option<Blocked> {
        if let Some(reason) = self.dependency_plan().blocked.get(plugin.id()) {
            return Some(reason.clone());
        }
        // Enabled and present, but it could not start itself (failed, waiting for consent).
        let plugins = self.plugins.read();
        plugin
            .manifest()
            .depends
            .iter()
            .filter(|d| !d.optional)
            .find(|d| {
                plugins.get(&d.id).is_some_and(|p| {
                    matches!(p.status(), PluginStatus::Failed | PluginStatus::NeedsConsent | PluginStatus::Blocked)
                })
            })
            .map(|d| Blocked::Dependency { id: d.id.clone() })
    }

    /// Stops `plugin` and shows why it is not running.
    pub(super) fn set_blocked(&self, plugin: &LoadedPlugin, reason: &Blocked) {
        self.stop(plugin);
        let mut meta = plugin.meta.lock();
        meta.status = PluginStatus::Blocked;
        meta.error = Some(reason.to_string());
        meta.warnings.clear();
        tracing::info!(plugin = %plugin.id(), "{reason}");
    }

    /// Orders `plugins` so each comes after the plugins it needs.
    pub(super) fn in_start_order(&self, mut plugins: Vec<Arc<LoadedPlugin>>) -> Vec<Arc<LoadedPlugin>> {
        let order = self.dependency_plan().order;
        let rank = |id: &str| order.iter().position(|o| o == id).unwrap_or(usize::MAX);
        plugins.sort_by(|a, b| rank(a.id()).cmp(&rank(b.id())).then_with(|| a.id().cmp(b.id())));
        plugins
    }

    /// Brings every plugin in line with the dependency plan: plugins that lost
    /// something they need stop, plugins that can run again start. Called with
    /// the lifecycle lock held, after anything that adds, removes, enables or
    /// disables a plugin.
    pub(super) fn reconcile(&self) {
        let plan = self.dependency_plan();
        let get = |id: &str| self.plugins.read().get(id).cloned();
        for (id, reason) in &plan.blocked {
            if let Some(plugin) = get(id)
                && (plugin.status() != PluginStatus::Blocked
                    || plugin.meta.lock().error.as_deref() != Some(&reason.to_string()))
            {
                self.set_blocked(&plugin, reason);
            }
        }
        for id in &plan.order {
            if let Some(plugin) = get(id)
                && plugin.status() == PluginStatus::Blocked
            {
                self.start(&plugin);
            }
        }
    }

    /// After `id` started again (reloaded, updated): plugins that need it follow,
    /// and what they contributed is checked against its current extension points.
    pub(super) fn settle_dependents(&self, id: &str) {
        self.restart_dependents(id);
        self.reconcile();
    }

    /// Starts again the running plugins that need `id`, and those that list it
    /// as an optional requirement: the latter skipped their contributions to its
    /// points while it was absent, so they take effect when it appears.
    fn restart_dependents(&self, id: &str) {
        let mut ids = self.with_nodes(|nodes, _| dependents(nodes, id));
        for optional in self.optional_dependents(id) {
            if !ids.contains(&optional) {
                ids.push(optional);
            }
        }
        for dependent in ids {
            self.restart_live(&dependent);
        }
    }

    /// After `id` was enabled: the plugins that list it as an optional requirement
    /// start again (the ones that need it start through [`reconcile`](Self::reconcile)).
    pub(super) fn restart_optional_dependents(&self, id: &str) {
        for dependent in self.optional_dependents(id) {
            self.restart_live(&dependent);
        }
    }

    fn optional_dependents(&self, id: &str) -> Vec<String> {
        self.plugins
            .read()
            .values()
            .filter(|p| p.manifest().depends.iter().any(|d| d.optional && d.id == id))
            .map(|p| p.id().to_owned())
            .collect()
    }

    fn restart_live(&self, id: &str) {
        let Some(plugin) = self.plugins.read().get(id).cloned() else { return };
        if plugin.status().is_live() {
            self.stop(&plugin);
            self.start(&plugin);
        }
    }

    /// Tells plugins that declare an extension point that contributions to it changed.
    pub(super) fn flush_extension_changes(&self) {
        let points: Vec<String> = std::mem::take(&mut *self.extension_changes.lock()).into_iter().collect();
        if !points.is_empty() {
            self.post_events(None, vec![WorkbenchEvent::ExtensionsChanged(points)]);
        }
    }

    /// `[[depends]]` with their state, who needs this plugin, and its extension points.
    pub(super) fn relations(
        &self,
        plugin: &LoadedPlugin,
    ) -> (Vec<DependencyInfo>, Vec<DependentInfo>, Vec<ExtensionPointInfo>) {
        let disabled = self.state.lock().disabled.clone();
        let plugins = self.plugins.read();
        let depends = plugin
            .manifest()
            .depends
            .iter()
            .map(|dep| {
                let found = plugins.get(&dep.id);
                let node = found.map(|p| Node {
                    id: p.id(),
                    version: &p.manifest().version,
                    depends: &[],
                    enabled: !disabled.contains(p.id()) && !p.invalid,
                });
                let stuck = found.is_some_and(|p| {
                    matches!(p.status(), PluginStatus::Failed | PluginStatus::NeedsConsent | PluginStatus::Blocked)
                });
                DependencyInfo {
                    id: dep.id.clone(),
                    name: found.map(|p| p.manifest().name.clone()),
                    version: dep.version.clone(),
                    optional: dep.optional,
                    state: dependency_state(dep, node.as_ref(), stuck),
                }
            })
            .collect();
        let all: Vec<Node<'_>> = plugins
            .values()
            .map(|p| Node {
                id: p.id(),
                version: &p.manifest().version,
                depends: &p.manifest().depends,
                enabled: !disabled.contains(p.id()) && !p.invalid,
            })
            .collect();
        let needing = dependents(&all, plugin.id())
            .into_iter()
            .filter_map(|id| plugins.get(&id))
            .map(|p| DependentInfo {
                id: p.id().to_owned(),
                name: p.manifest().name.clone(),
                enabled: !disabled.contains(p.id()),
            })
            .collect();
        let points = self
            .registry
            .declared_points(plugin.id())
            .into_iter()
            .map(|p| ExtensionPointInfo {
                id: p.decl.id,
                description: p.decl.description,
                contributors: p.contributors,
            })
            .collect();
        (depends, needing, points)
    }
}
