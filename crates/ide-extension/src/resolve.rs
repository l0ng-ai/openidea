//! Which plugins can run, and in which order, given what they depend on.

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// `[[depends]]` of a manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub id: String,
    /// Semver requirement on the dependency's version; none accepts any.
    #[serde(default)]
    pub version: Option<String>,
    /// The plugin runs without it; when present it starts first.
    #[serde(default)]
    pub optional: bool,
}

impl Dependency {
    /// `acme.base ^1.0`.
    pub fn describe(&self) -> String {
        match &self.version {
            Some(v) => format!("{} {v}", self.id),
            None => self.id.clone(),
        }
    }
}

/// A plugin as the resolver sees it.
#[derive(Clone, Copy, Debug)]
pub struct Node<'a> {
    pub id: &'a str,
    pub version: &'a str,
    pub depends: &'a [Dependency],
    /// Not switched off by the user.
    pub enabled: bool,
}

/// Why an enabled plugin cannot run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Blocked {
    /// A required plugin is not installed.
    Missing { requirement: String },
    /// A required plugin is switched off.
    Disabled { id: String },
    /// A required plugin is installed in a version that does not satisfy the requirement.
    Version { requirement: String, found: String },
    /// A required plugin cannot run itself.
    Dependency { id: String },
    /// The plugin is part of a dependency cycle (`a → b → a`).
    Cycle { ring: Vec<String> },
}

impl fmt::Display for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { requirement } => write!(f, "Requires {requirement}, which is not installed"),
            Self::Disabled { id } => write!(f, "Requires {id}, which is disabled"),
            Self::Version { requirement, found } => {
                write!(f, "Requires {requirement}, but version {found} is installed")
            }
            Self::Dependency { id } => write!(f, "Requires {id}, which cannot run"),
            Self::Cycle { ring } => write!(f, "Part of a dependency cycle: {}", ring.join(" → ")),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Plugins that can run, every plugin after the plugins it depends on.
    pub order: Vec<String>,
    /// Enabled plugins that cannot run. Disabled plugins are in neither list.
    pub blocked: BTreeMap<String, Blocked>,
}

/// Decides, for every enabled plugin, whether its required plugins allow it to
/// run and the order to start them in (the counterpart of IntelliJ's
/// `PluginSetBuilder`: dependency graph, topological order, cycle report).
pub fn plan(nodes: &[Node<'_>]) -> Plan {
    let by_id: BTreeMap<&str, &Node<'_>> = nodes.iter().map(|n| (n.id, n)).collect();
    let enabled: Vec<&Node<'_>> = by_id.values().copied().filter(|n| n.enabled).collect();
    let mut blocked: BTreeMap<String, Blocked> = BTreeMap::new();

    for node in &enabled {
        for dep in node.depends.iter().filter(|d| !d.optional) {
            if let Some(reason) = direct_reason(dep, by_id.get(dep.id.as_str()).copied()) {
                blocked.entry(node.id.to_owned()).or_insert(reason);
            }
        }
    }

    // Cycles among plugins whose requirements are otherwise present.
    let candidates: BTreeSet<&str> = enabled.iter().map(|n| n.id).filter(|id| !blocked.contains_key(*id)).collect();
    let graph: Graph<'_> = candidates
        .iter()
        .map(|id| {
            let deps = by_id[id].depends.iter().filter(|d| !d.optional).map(|d| d.id.as_str());
            (*id, deps.filter(|d| candidates.contains(d)).collect())
        })
        .collect();
    for component in components(&graph) {
        let cyclic = component.len() > 1 || graph[component[0]].contains(&component[0]);
        if cyclic {
            let ring = ring_of(&component, &graph);
            for id in component {
                blocked.insert(id.to_owned(), Blocked::Cycle { ring: ring.clone() });
            }
        }
    }

    // A plugin that needs a blocked plugin is blocked too.
    loop {
        let mut changed = false;
        for node in &enabled {
            if blocked.contains_key(node.id) {
                continue;
            }
            if let Some(dep) = node.depends.iter().find(|d| !d.optional && blocked.contains_key(&d.id)) {
                blocked.insert(node.id.to_owned(), Blocked::Dependency { id: dep.id.clone() });
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let runnable: BTreeSet<&str> = enabled.iter().map(|n| n.id).filter(|id| !blocked.contains_key(*id)).collect();
    Plan { order: topological(&runnable, &by_id), blocked }
}

/// Plugins that need `id`, directly or through other plugins, whether or not
/// they are enabled. Optional dependencies do not count.
pub fn dependents(nodes: &[Node<'_>], id: &str) -> Vec<String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut frontier = vec![id.to_owned()];
    while let Some(current) = frontier.pop() {
        for node in nodes {
            if node.depends.iter().any(|d| !d.optional && d.id == current) && found.insert(node.id.to_owned()) {
                frontier.push(node.id.to_owned());
            }
        }
    }
    found.remove(id);
    found.into_iter().collect()
}

/// How one dependency stands right now, for the plugin details page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DependencyState {
    Satisfied,
    Missing,
    Disabled,
    /// Installed, wrong version.
    Version,
    /// Installed and enabled, but cannot run itself.
    Blocked,
}

pub fn dependency_state(dep: &Dependency, found: Option<&Node<'_>>, found_blocked: bool) -> DependencyState {
    match direct_reason(dep, found) {
        Some(Blocked::Missing { .. }) => DependencyState::Missing,
        Some(Blocked::Disabled { .. }) => DependencyState::Disabled,
        Some(Blocked::Version { .. }) => DependencyState::Version,
        _ if found_blocked => DependencyState::Blocked,
        _ => DependencyState::Satisfied,
    }
}

fn direct_reason(dep: &Dependency, found: Option<&Node<'_>>) -> Option<Blocked> {
    let Some(target) = found else {
        return Some(Blocked::Missing { requirement: dep.describe() });
    };
    if !target.enabled {
        return Some(Blocked::Disabled { id: dep.id.clone() });
    }
    let want = dep.version.as_deref()?;
    let satisfied = VersionReq::parse(want)
        .ok()
        .zip(Version::parse(target.version).ok())
        .is_some_and(|(req, have)| req.matches(&have));
    (!satisfied).then(|| Blocked::Version { requirement: dep.describe(), found: target.version.to_owned() })
}

/// Plugin id → the plugin ids it requires.
type Graph<'a> = BTreeMap<&'a str, Vec<&'a str>>;

/// Strongly connected components (Tarjan) of `graph`.
fn components<'a>(graph: &Graph<'a>) -> Vec<Vec<&'a str>> {
    struct State<'a, 'g> {
        index: usize,
        stack: Vec<&'a str>,
        info: BTreeMap<&'a str, (usize, usize, bool)>,
        out: Vec<Vec<&'a str>>,
        graph: &'g Graph<'a>,
    }
    fn visit<'a>(s: &mut State<'a, '_>, v: &'a str) {
        s.info.insert(v, (s.index, s.index, true));
        s.index += 1;
        s.stack.push(v);
        for &w in &s.graph[v] {
            match s.info.get(w).copied() {
                None => {
                    visit(s, w);
                    let low = s.info[w].1;
                    let entry = s.info.get_mut(v).expect("visited");
                    entry.1 = entry.1.min(low);
                }
                Some((index, _, true)) => {
                    let entry = s.info.get_mut(v).expect("visited");
                    entry.1 = entry.1.min(index);
                }
                Some(_) => {}
            }
        }
        let (index, low, _) = s.info[v];
        if index == low {
            let mut component = Vec::new();
            while let Some(w) = s.stack.pop() {
                s.info.get_mut(w).expect("visited").2 = false;
                component.push(w);
                if w == v {
                    break;
                }
            }
            component.sort_unstable();
            s.out.push(component);
        }
    }
    let mut state = State { index: 0, stack: Vec::new(), info: BTreeMap::new(), out: Vec::new(), graph };
    for &id in graph.keys() {
        if !state.info.contains_key(id) {
            visit(&mut state, id);
        }
    }
    state.out
}

/// One cycle through `component`, from its smallest id back to it.
fn ring_of(component: &[&str], graph: &Graph<'_>) -> Vec<String> {
    let start = component[0];
    let mut ring = vec![start.to_owned()];
    let mut current = start;
    let mut seen: BTreeSet<&str> = BTreeSet::from([start]);
    loop {
        let mut next: Vec<&str> = graph[current].iter().copied().filter(|d| component.contains(d)).collect();
        next.sort_unstable();
        // Prefer closing the ring; otherwise take the smallest unseen member.
        let step =
            if next.contains(&start) { start } else { *next.iter().find(|d| !seen.contains(**d)).unwrap_or(&start) };
        ring.push(step.to_owned());
        if step == start {
            return ring;
        }
        seen.insert(step);
        current = step;
    }
}

/// Kahn's algorithm over the runnable plugins; ties break by id. Optional
/// dependencies order too, but never block: leftovers (an optional edge
/// closing a loop) are appended by id.
fn topological(runnable: &BTreeSet<&str>, by_id: &BTreeMap<&str, &Node<'_>>) -> Vec<String> {
    let mut waiting: BTreeMap<&str, BTreeSet<&str>> = runnable
        .iter()
        .map(|id| {
            let deps = by_id[id].depends.iter().map(|d| d.id.as_str()).filter(|d| runnable.contains(d) && d != id);
            (*id, deps.collect())
        })
        .collect();
    let mut order: Vec<String> = Vec::with_capacity(runnable.len());
    while let Some(next) = waiting.iter().find(|(_, deps)| deps.is_empty()).map(|(id, _)| *id) {
        waiting.remove(next);
        for deps in waiting.values_mut() {
            deps.remove(next);
        }
        order.push(next.to_owned());
    }
    order.extend(waiting.keys().map(|id| (*id).to_owned()));
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dep(id: &str) -> Dependency {
        Dependency { id: id.into(), version: None, optional: false }
    }

    fn dep_v(id: &str, version: &str) -> Dependency {
        Dependency { id: id.into(), version: Some(version.into()), optional: false }
    }

    fn optional(id: &str) -> Dependency {
        Dependency { id: id.into(), version: None, optional: true }
    }

    fn node<'a>(id: &'a str, depends: &'a [Dependency]) -> Node<'a> {
        Node { id, version: "1.0.0", depends, enabled: true }
    }

    #[test]
    fn dependencies_start_first_whatever_the_ids_sort_like() {
        let (a, z) = ([dep("z.base")], []);
        let plan = plan(&[node("a.app", &a), node("z.base", &z)]);
        assert_eq!(plan.order, ["z.base", "a.app"]);
        assert!(plan.blocked.is_empty());
    }

    #[test]
    fn independent_plugins_keep_id_order() {
        let plan = plan(&[node("b", &[]), node("a", &[]), node("c", &[])]);
        assert_eq!(plan.order, ["a", "b", "c"]);
    }

    #[test]
    fn a_missing_requirement_blocks_with_the_requirement_text() {
        let needs = [dep_v("acme.base", "^1.0")];
        let plan = plan(&[node("acme.app", &needs)]);
        assert!(plan.order.is_empty());
        assert_eq!(plan.blocked["acme.app"], Blocked::Missing { requirement: "acme.base ^1.0".into() });
        assert_eq!(plan.blocked["acme.app"].to_string(), "Requires acme.base ^1.0, which is not installed");
    }

    #[test]
    fn a_disabled_requirement_blocks_but_the_disabled_plugin_itself_is_not_blocked() {
        let needs = [dep("acme.base")];
        let mut base = node("acme.base", &[]);
        base.enabled = false;
        let plan = plan(&[base, node("acme.app", &needs)]);
        assert_eq!(plan.blocked["acme.app"], Blocked::Disabled { id: "acme.base".into() });
        assert!(!plan.blocked.contains_key("acme.base"));
        assert!(plan.order.is_empty());
    }

    #[test]
    fn the_installed_version_must_satisfy_the_requirement() {
        let needs = [dep_v("acme.base", "^0.2")];
        let mut base = node("acme.base", &[]);
        base.version = "0.3.0";
        let plan_bad = plan(&[base, node("acme.app", &needs)]);
        assert_eq!(
            plan_bad.blocked["acme.app"],
            Blocked::Version { requirement: "acme.base ^0.2".into(), found: "0.3.0".into() }
        );
        assert_eq!(plan_bad.blocked["acme.app"].to_string(), "Requires acme.base ^0.2, but version 0.3.0 is installed");

        base.version = "0.2.7";
        let plan_ok = plan(&[base, node("acme.app", &needs)]);
        assert!(plan_ok.blocked.is_empty());
        assert_eq!(plan_ok.order, ["acme.base", "acme.app"]);
    }

    #[test]
    fn blocking_propagates_to_everything_downstream() {
        let (b, c) = ([dep("a")], [dep("b")]);
        let plan = plan(&[node("b", &b), node("c", &c)]);
        assert_eq!(plan.blocked["b"], Blocked::Missing { requirement: "a".into() });
        assert_eq!(plan.blocked["c"], Blocked::Dependency { id: "b".into() });
        assert!(plan.order.is_empty());
    }

    #[test]
    fn an_optional_requirement_never_blocks_but_orders_when_present() {
        let app = [optional("acme.extra")];
        let alone = plan(&[node("acme.app", &app)]);
        assert_eq!(alone.order, ["acme.app"]);
        assert!(alone.blocked.is_empty());

        let with = plan(&[node("acme.app", &app), node("acme.extra", &[])]);
        assert_eq!(with.order, ["acme.extra", "acme.app"]);

        let mut off = node("acme.extra", &[]);
        off.enabled = false;
        let disabled = plan(&[node("acme.app", &app), off]);
        assert_eq!(disabled.order, ["acme.app"]);
        assert!(disabled.blocked.is_empty());
    }

    #[test]
    fn a_cycle_blocks_its_members_and_names_the_ring() {
        let (a, b, d) = ([dep("b")], [dep("a")], [dep("a")]);
        let plan = plan(&[node("a", &a), node("b", &b), node("d", &d)]);
        let ring = Blocked::Cycle { ring: vec!["a".into(), "b".into(), "a".into()] };
        assert_eq!(plan.blocked["a"], ring);
        assert_eq!(plan.blocked["b"], ring);
        assert_eq!(ring.to_string(), "Part of a dependency cycle: a → b → a");
        assert_eq!(plan.blocked["d"], Blocked::Dependency { id: "a".into() });
        assert!(plan.order.is_empty());
    }

    #[test]
    fn a_plugin_requiring_itself_is_a_cycle() {
        let a = [dep("a")];
        let plan = plan(&[node("a", &a)]);
        assert_eq!(plan.blocked["a"], Blocked::Cycle { ring: vec!["a".into(), "a".into()] });
    }

    #[test]
    fn an_optional_loop_does_not_block_and_still_yields_every_plugin() {
        let (a, b) = ([optional("b")], [optional("a")]);
        let plan = plan(&[node("a", &a), node("b", &b)]);
        assert!(plan.blocked.is_empty());
        assert_eq!(plan.order.len(), 2);
    }

    #[test]
    fn dependents_are_transitive_and_ignore_optional_edges() {
        let (b, c, d) = ([dep("a")], [dep("b")], [optional("a")]);
        let nodes = [node("a", &[]), node("b", &b), node("c", &c), node("d", &d)];
        assert_eq!(dependents(&nodes, "a"), ["b", "c"]);
        assert_eq!(dependents(&nodes, "c"), Vec::<String>::new());
    }

    #[test]
    fn dependency_state_tells_the_details_page_what_to_say() {
        let want = dep_v("base", "^1.0");
        assert_eq!(dependency_state(&want, None, false), DependencyState::Missing);
        let mut base = node("base", &[]);
        assert_eq!(dependency_state(&want, Some(&base), false), DependencyState::Satisfied);
        assert_eq!(dependency_state(&want, Some(&base), true), DependencyState::Blocked);
        base.version = "2.0.0";
        assert_eq!(dependency_state(&want, Some(&base), false), DependencyState::Version);
        base.enabled = false;
        assert_eq!(dependency_state(&want, Some(&base), false), DependencyState::Disabled);
    }
}
