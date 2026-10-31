// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/McpToolFilter.kt, MaskList.kt, McpToolFilterProvider.kt, impl/*McpToolFilterProvider.kt, settings/McpToolFilterOptimizer.kt, settings/McpToolDisallowListSettings.kt), Apache-2.0.
//! Which tools a session sees: the mask-list filter (`toolsFilter`), the per-tool states
//! (`toolStates`, with the older `disabledTools` as a fallback), experimental tools, and the
//! invocation mode, in which only the `execute_tool` router (and tools that are not
//! router-only) are listed and the router reaches the rest.

use crate::tool::Tool;
use ide_core::mcp::{McpInvocationMode, McpSettings, McpToolState};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// The name of the router tool ([`crate::tools::universal`]).
pub const ROUTER_TOOL_NAME: &str = "execute_tool";

/// The group of a tool nobody put into one.
pub const DEFAULT_GROUP: &str = "general.OtherToolset";

/// What fully qualified names are prefixed with in the JetBrains IDEs, so their filter strings
/// (`-*,+com.intellij.mcpserver.toolsets.general.*`) work here unchanged.
const JETBRAINS_PACKAGE: &str = "com.intellij.mcpserver.toolsets.";

/// A group's display name: the JetBrains IDEs' name for that toolset, else one derived from
/// the class name (`FooBarToolset` → `Foo Bar`).
pub fn group_display_name(group: &str) -> String {
    let short = group.rsplit('.').next().unwrap_or(group);
    let known = match short {
        "AnalysisToolset" => "Code Analysis",
        "CodeInsightToolset" => "Code Insight",
        "DiagnosticsToolset" => "IDE Diagnostics",
        "ExecutionToolset" => "Run Configurations",
        "FileToolset" => "Files",
        "FormattingToolset" => "Formatting",
        "ImportsToolset" => "Imports",
        "PatchToolset" => "Patch",
        "ReadToolset" => "File Reading",
        "RefactoringToolset" => "Refactoring",
        "SearchToolset" => "Search",
        "UniversalToolset" => "Universal Tool Router",
        "VcsToolset" => "Version Control",
        "TerminalToolset" => "Terminal",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    let base = short.strip_suffix("Toolset").unwrap_or(short);
    let mut words: Vec<String> = Vec::new();
    for c in base.chars() {
        match words.last_mut() {
            Some(w) if !c.is_uppercase() => w.push(c),
            _ => words.push(c.to_string()),
        }
    }
    words.join(" ")
}

// --- masks ---------------------------------------------------------------------------

/// A comma-separated list of masks: `+mask` (or a bare mask) allows, `-mask` disallows,
/// `*` matches any characters (dots included) and `?` one. The last matching mask decides;
/// a name no mask matches is allowed.
#[derive(Clone, Debug)]
pub struct MaskList {
    masks: Vec<(String, bool)>,
}

impl MaskList {
    pub fn new(list: &str) -> Self {
        let masks = list
            .split(',')
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(|m| match m.as_bytes()[0] {
                b'-' => (m[1..].to_owned(), false),
                b'+' => (m[1..].to_owned(), true),
                _ => (m.to_owned(), true),
            })
            .collect();
        Self { masks }
    }

    pub fn matches(&self, name: &str) -> bool {
        self.matches_any(&[name])
    }

    /// Like [`MaskList::matches`]; a mask applies when it matches any of `names`.
    pub fn matches_any(&self, names: &[&str]) -> bool {
        let mut allowed = true;
        for (mask, allow) in &self.masks {
            if names.iter().any(|n| wildcard_match(mask, n)) {
                allowed = *allow;
            }
        }
        allowed
    }
}

/// `*` / `?` wildcard matching of the whole `text` (case-sensitive, like `PatternUtil.fromMask`).
fn wildcard_match(mask: &str, text: &str) -> bool {
    let (m, t): (Vec<char>, Vec<char>) = (mask.chars().collect(), text.chars().collect());
    let (mut mi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if mi < m.len() && (m[mi] == '?' || m[mi] == t[ti]) {
            mi += 1;
            ti += 1;
        } else if mi < m.len() && m[mi] == '*' {
            star = Some((mi, ti));
            mi += 1;
        } else if let Some((sm, st)) = star {
            mi = sm + 1;
            ti = st + 1;
            star = Some((sm, st + 1));
        } else {
            return false;
        }
    }
    m[mi..].iter().all(|c| *c == '*')
}

/// The names masks are matched against: ours (`general.SearchToolset.search_text`) and the
/// JetBrains one (`com.intellij.mcpserver.toolsets.general.SearchToolset.search_text`).
fn mask_names(tool: &Tool) -> [String; 2] {
    let fqn = tool.fully_qualified_name();
    let jetbrains = format!("{JETBRAINS_PACKAGE}{fqn}");
    [fqn, jetbrains]
}

fn tool_matches(masks: &MaskList, tool: &Tool) -> bool {
    let [a, b] = mask_names(tool);
    masks.matches_any(&[&a, &b])
}

/// Selects tools for a session by name.
#[derive(Clone, Debug)]
pub enum McpToolFilter {
    AllowAll,
    ProhibitAll,
    /// Only these plain tool names (the part after the last `.` of a qualified name).
    AllowList(HashSet<String>),
    MaskBased(MaskList),
    AllowNonExperimental,
}

impl McpToolFilter {
    /// No list (`None`) allows everything; an empty or blank one nothing.
    pub fn from_mask_list(list: Option<&str>) -> Self {
        match list {
            None => Self::AllowAll,
            Some(l) if l.trim().is_empty() => Self::ProhibitAll,
            Some(l) => Self::MaskBased(MaskList::new(l)),
        }
    }

    /// Whether a tool with this (plain or qualified) name passes.
    pub fn includes_name(&self, name: &str) -> bool {
        match self {
            Self::AllowAll | Self::AllowNonExperimental => true,
            Self::ProhibitAll => false,
            Self::AllowList(names) => names.contains(name.rsplit('.').next().unwrap_or(name)),
            Self::MaskBased(masks) => masks.matches(name),
        }
    }

    pub fn includes(&self, tool: &Tool) -> bool {
        match self {
            Self::AllowNonExperimental => !tool.experimental,
            Self::MaskBased(masks) => tool_matches(masks, tool),
            _ => self.includes_name(&tool.fully_qualified_name()),
        }
    }
}

// --- the filter context ----------------------------------------------------------------

/// Every tool with its [`McpToolState`]; the filter steps update the states in turn.
pub struct ToolFilterContext<'a> {
    states: Vec<(&'a Tool, McpToolState)>,
}

impl<'a> ToolFilterContext<'a> {
    pub fn new(tools: &'a [Tool]) -> Self {
        Self { states: tools.iter().map(|t| (t, McpToolState::default())).collect() }
    }

    /// Enabled tools listed directly in router mode.
    pub fn on_tools(&self) -> Vec<&'a Tool> {
        self.states.iter().filter(|(_, s)| s.enabled && !s.router_only).map(|(t, _)| *t).collect()
    }

    /// Enabled tools reachable only through the router in router mode.
    pub fn router_only_tools(&self) -> Vec<&'a Tool> {
        self.states.iter().filter(|(_, s)| s.enabled && s.router_only).map(|(t, _)| *t).collect()
    }

    pub fn state(&self, tool: &str) -> Option<McpToolState> {
        self.states.iter().find(|(t, _)| t.name == tool).map(|(_, s)| *s)
    }

    /// Sets `enabled` and / or `router_only` (`None` keeps it) of the tools `predicate` picks.
    pub fn update_state(
        &mut self,
        enabled: Option<bool>,
        router_only: Option<bool>,
        predicate: impl Fn(&Tool) -> bool,
    ) {
        for (tool, state) in &mut self.states {
            if predicate(tool) {
                state.enabled = enabled.unwrap_or(state.enabled);
                state.router_only = router_only.unwrap_or(state.router_only);
            }
        }
    }

    /// Hides the tools a non-blank `list` disallows (`applyMaskFilter`).
    pub fn apply_mask_filter(&mut self, list: &str) {
        if list.trim().is_empty() {
            return;
        }
        let masks = MaskList::new(list);
        self.update_state(Some(false), None, |t| !tool_matches(&masks, t));
    }
}

// --- the settings ----------------------------------------------------------------------

/// The settings the filter steps read (from [`McpSettings`]).
#[derive(Clone, Debug, Default)]
pub struct FilterSettings {
    pub tools_filter: String,
    pub tool_states: BTreeMap<String, McpToolState>,
    /// `disabledTools`: disabled unless `tool_states` says otherwise.
    pub disabled_tools: HashSet<String>,
    pub invocation_mode: McpInvocationMode,
    pub experimental_tools: bool,
}

impl From<&McpSettings> for FilterSettings {
    fn from(s: &McpSettings) -> Self {
        Self {
            tools_filter: s.tools_filter.clone(),
            tool_states: s.tool_states.clone(),
            disabled_tools: s.disabled_tools.iter().cloned().collect(),
            invocation_mode: s.invocation_mode,
            experimental_tools: s.experimental_tools,
        }
    }
}

impl FilterSettings {
    /// The stored state of `tool`: by qualified name, then plain name, then `disabledTools`.
    fn stored_state(&self, tool: &Tool) -> Option<McpToolState> {
        self.tool_states.get(&tool.fully_qualified_name()).or_else(|| self.tool_states.get(tool.name)).copied().or_else(
            || self.disabled_tools.contains(tool.name).then_some(McpToolState { enabled: false, router_only: true }),
        )
    }

    /// Runs the filter steps over `tools`: tool states, then the mask filter, then experimental tools.
    pub fn context<'a>(&self, tools: &'a [Tool]) -> ToolFilterContext<'a> {
        let mut context = ToolFilterContext::new(tools);
        for tool in tools {
            let state = self.stored_state(tool).unwrap_or_default();
            context.update_state(Some(state.enabled), Some(state.router_only), |t| t.name == tool.name);
        }
        context.apply_mask_filter(&self.tools_filter);
        if !self.experimental_tools {
            // A tool the user switched on explicitly stays on.
            context.update_state(Some(false), None, |t| {
                !McpToolFilter::AllowNonExperimental.includes(t) && self.stored_state(t).is_none_or(|s| !s.enabled)
            });
        }
        context
    }

    /// The tools `tools/list` offers: every enabled tool, or in router mode the router and the
    /// enabled tools that are not router-only. The router is always listed in router mode.
    pub fn listed_tools(&self, tools: &[Tool]) -> Vec<Tool> {
        let context = self.context(tools);
        let listed: Vec<&Tool> = match self.invocation_mode {
            McpInvocationMode::Direct => {
                tools.iter().filter(|t| context.state(t.name).is_some_and(|s| s.enabled)).collect()
            }
            McpInvocationMode::ViaRouter => {
                let on = context.on_tools();
                tools.iter().filter(|t| t.name == ROUTER_TOOL_NAME || on.iter().any(|o| o.name == t.name)).collect()
            }
        };
        listed.into_iter().cloned().collect()
    }

    /// The tools the router can call: every enabled tool but itself.
    pub fn routable_tools(&self, tools: &[Tool]) -> Vec<Tool> {
        let context = self.context(tools);
        tools
            .iter()
            .filter(|t| t.name != ROUTER_TOOL_NAME && context.state(t.name).is_some_and(|s| s.enabled))
            .cloned()
            .collect()
    }
}

// --- the optimizer ---------------------------------------------------------------------

/// The filter string for "nothing filtered".
pub const DEFAULT_FILTER: &str = "";

/// Builds a short mask list that enables `enabled` and disables `disabled` (qualified names),
/// given each group's tools:
/// 1. a group whose tools are all on (off) gets one `+group.*` (`-group.*`) mask;
/// 2. when fewer than half of the groups have at least half of their tools on, the list starts
///    with `-*` and enables what is on, else it disables what is off;
/// 3. a group with fewer than half of its tools on is disabled and its tools enabled one by one.
pub fn build_optimized_filter(
    enabled: &BTreeSet<String>,
    disabled: &BTreeSet<String>,
    groups: &[(String, BTreeSet<String>)],
) -> String {
    if disabled.is_empty() {
        return "*".into();
    }
    if enabled.is_empty() {
        return "-*".into();
    }
    struct Stats<'a> {
        group: &'a str,
        total: usize,
        enabled: Vec<&'a String>,
        disabled: Vec<&'a String>,
    }
    impl Stats<'_> {
        fn share(&self) -> f64 {
            if self.total == 0 { 0.0 } else { self.enabled.len() as f64 / self.total as f64 }
        }
    }
    let stats: Vec<Stats> = groups
        .iter()
        .map(|(group, tools)| Stats {
            group,
            total: tools.len(),
            enabled: tools.iter().filter(|t| enabled.contains(*t)).collect(),
            disabled: tools.iter().filter(|t| disabled.contains(*t)).collect(),
        })
        .collect();
    let majority_on = stats.iter().filter(|s| s.share() >= 0.5).count();
    let deny_all_first = (majority_on as f64) < stats.len() as f64 * 0.5;

    let mut parts = Vec::new();
    if deny_all_first {
        parts.push("-*".to_owned());
        for s in &stats {
            if s.enabled.is_empty() {
                continue;
            }
            if s.enabled.len() == s.total {
                parts.push(format!("+{}.*", s.group));
            } else if s.share() >= 0.5 {
                parts.push(format!("+{}.*", s.group));
                parts.extend(s.disabled.iter().map(|t| format!("-{t}")));
            } else {
                parts.extend(s.enabled.iter().map(|t| format!("+{t}")));
            }
        }
    } else {
        for s in &stats {
            if s.enabled.len() == s.total {
                continue;
            }
            if s.enabled.is_empty() {
                parts.push(format!("-{}.*", s.group));
            } else if s.share() < 0.5 {
                parts.push(format!("-{}.*", s.group));
                parts.extend(s.enabled.iter().map(|t| format!("+{t}")));
            } else {
                parts.extend(s.disabled.iter().map(|t| format!("-{t}")));
            }
        }
    }
    if parts.is_empty() { DEFAULT_FILTER.into() } else { parts.join(",") }
}
