// Ported from JetBrains intellij-community plugins/mcp-server (tests/testSrc/com/intellij/mcpserver/McpToolFilterTest.kt, McpToolFilterOptimizerTest.kt, McpToolInvocationModeTest.kt, impl/DisallowListBasedMcpToolFilterProviderTest.kt), Apache-2.0.
//! Tool filtering: masks, filters, the filter context, tool states, experimental tools,
//! invocation modes and the filter optimizer.

mod common;

use common::Harness;
use ide_core::mcp::{McpInvocationMode, McpSettings, McpToolKind, McpToolState};
use ide_mcp::filter::{FilterSettings, McpToolFilter, ROUTER_TOOL_NAME, ToolFilterContext, build_optimized_filter};
use ide_mcp::tool::{Output, Tool};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn fake(name: &'static str, group: &'static str) -> Tool {
    Tool::new(name, McpToolKind::Read, "test", |_| async { Ok(Output::text("ok")) }).group(group)
}

fn names(tools: &[Tool]) -> Vec<&'static str> {
    let mut n: Vec<_> = tools.iter().map(|t| t.name).collect();
    n.sort();
    n
}

// --- McpToolFilter -------------------------------------------------------------------

#[test]
fn allow_all_includes_all_tools() {
    let f = McpToolFilter::AllowAll;
    for name in ["read_file", "write_file", "execute_command", "any_tool_name", ""] {
        assert!(f.includes_name(name));
    }
}

#[test]
fn allow_list_includes_only_allowed_tools_case_sensitively() {
    let f = McpToolFilter::AllowList(["read_file", "write_file", "grep"].map(String::from).into());
    assert!(f.includes_name("read_file") && f.includes_name("grep"));
    assert!(f.includes_name("general.ReadToolset.read_file"));
    assert!(!f.includes_name("execute_command") && !f.includes_name("Read_File") && !f.includes_name("READ_FILE"));
    let empty = McpToolFilter::AllowList(Default::default());
    assert!(!empty.includes_name("read_file"));
}

#[test]
fn mask_with_single_allow_pattern_allows_unmatched_names() {
    let f = McpToolFilter::from_mask_list(Some("read_file"));
    assert!(f.includes_name("read_file"));
    assert!(f.includes_name("write_file"));
}

#[test]
fn mask_wildcard_matches_dots() {
    let f = McpToolFilter::from_mask_list(Some("com.intellij.mcpserver.toolsets.general.*"));
    assert!(f.includes_name("com.intellij.mcpserver.toolsets.general.read_file"));
    assert!(f.includes_name("com.intellij.mcpserver.toolsets.general.nested.tool"));
    assert!(f.includes_name("com.intellij.mcpserver.toolsets.vcs.git_commit"));
}

#[test]
fn mask_disallow_all_then_allow_prefix() {
    let f = McpToolFilter::from_mask_list(Some("-*,+com.intellij.mcpserver.toolsets.general.*"));
    assert!(f.includes_name("com.intellij.mcpserver.toolsets.general.read_file"));
    assert!(!f.includes_name("com.intellij.mcpserver.toolsets.vcs.git_commit"));
    assert!(!f.includes_name("other_tool"));
}

#[test]
fn mask_complex_pattern_last_match_wins() {
    let f = McpToolFilter::from_mask_list(Some("-*,+com.intellij.mcpserver.toolsets.general.*,-*.read_file"));
    assert!(!f.includes_name("com.intellij.mcpserver.toolsets.general.read_file"));
    assert!(f.includes_name("com.intellij.mcpserver.toolsets.general.write_file"));
    assert!(!f.includes_name("com.intellij.mcpserver.toolsets.vcs.git_commit"));
    assert!(!McpToolFilter::from_mask_list(Some("+read_file,-read_file")).includes_name("read_file"));
}

#[test]
fn mask_explicit_prefixes_and_whitespace() {
    let allow = McpToolFilter::from_mask_list(Some("+read_file,+write_file"));
    assert!(allow.includes_name("read_file") && allow.includes_name("other_tool"));
    let deny = McpToolFilter::from_mask_list(Some("-read_file,-write_file"));
    assert!(!deny.includes_name("read_file") && !deny.includes_name("write_file") && deny.includes_name("other_tool"));
    let spaced = McpToolFilter::from_mask_list(Some(" -* , +read_file , +write_file "));
    assert!(spaced.includes_name("read_file") && spaced.includes_name("write_file") && !spaced.includes_name("other"));
    let question = McpToolFilter::from_mask_list(Some("-*,+search_?ext"));
    assert!(question.includes_name("search_text") && !question.includes_name("search_regex"));
}

#[test]
fn from_mask_list_null_empty_and_blank() {
    assert!(matches!(McpToolFilter::from_mask_list(None), McpToolFilter::AllowAll));
    assert!(matches!(McpToolFilter::from_mask_list(Some("")), McpToolFilter::ProhibitAll));
    assert!(matches!(McpToolFilter::from_mask_list(Some("   ")), McpToolFilter::ProhibitAll));
    let f = McpToolFilter::from_mask_list(Some("-*,+read_file"));
    assert!(matches!(f, McpToolFilter::MaskBased(_)));
    assert!(f.includes_name("read_file") && !f.includes_name("write_file"));
}

#[test]
fn masks_match_our_and_the_jetbrains_qualified_names() {
    let read = fake("read_file", "general.ReadToolset");
    let status = fake("git_status", "vcs.VcsToolset");
    let ours = McpToolFilter::from_mask_list(Some("-*,+general.*"));
    assert!(ours.includes(&read) && !ours.includes(&status));
    let theirs = McpToolFilter::from_mask_list(Some("-*,+com.intellij.mcpserver.toolsets.vcs.*"));
    assert!(!theirs.includes(&read) && theirs.includes(&status));
    let experimental = fake("x", "test.TestToolset").experimental();
    assert!(!McpToolFilter::AllowNonExperimental.includes(&experimental));
    assert!(McpToolFilter::AllowNonExperimental.includes(&read));
}

// --- the filter context ----------------------------------------------------------------

#[test]
fn update_state_sets_enabled_and_router_only_independently() {
    let tools = [fake("read_file", "test.TestToolset")];
    let mut c = ToolFilterContext::new(&tools);
    // Default: enabled, router-only.
    assert!(c.on_tools().is_empty());
    assert_eq!(c.router_only_tools().len(), 1);

    c.update_state(Some(false), None, |_| true);
    assert!(c.on_tools().is_empty() && c.router_only_tools().is_empty());
    c.update_state(Some(true), None, |_| true);
    assert!(c.on_tools().is_empty());
    assert_eq!(c.router_only_tools().len(), 1, "routerOnly stayed true");

    c.update_state(Some(true), Some(false), |_| true);
    assert_eq!(c.on_tools().len(), 1);
    c.update_state(Some(false), None, |_| true);
    assert!(c.on_tools().is_empty() && c.router_only_tools().is_empty(), "routerOnly stayed false, enabled is off");
}

#[test]
fn update_state_only_touches_picked_tools() {
    let tools = [fake("tool_a", "test.TestToolset"), fake("tool_b", "test.TestToolset")];
    let mut c = ToolFilterContext::new(&tools);
    c.update_state(Some(false), None, |t| t.name == "tool_a");
    c.update_state(Some(false), Some(false), |t| t.name == "tool_a");
    assert!(c.on_tools().is_empty());
    assert_eq!(c.router_only_tools().iter().map(|t| t.name).collect::<Vec<_>>(), ["tool_b"]);
}

// --- tool states (the disallow list) ---------------------------------------------------

fn settings(states: &[(&str, bool, bool)]) -> FilterSettings {
    FilterSettings {
        tool_states: states
            .iter()
            .map(|(k, enabled, router_only)| {
                ((*k).to_owned(), McpToolState { enabled: *enabled, router_only: *router_only })
            })
            .collect(),
        ..Default::default()
    }
}

#[test]
fn tool_state_by_qualified_name_disables_or_lists_a_tool() {
    let tools = [fake("read_file", "example.Toolset")];
    let off = settings(&[("example.Toolset.read_file", false, true)]);
    let c = off.context(&tools);
    assert!(c.on_tools().is_empty() && c.router_only_tools().is_empty());

    let on = settings(&[("example.Toolset.read_file", true, false)]);
    let c = on.context(&tools);
    assert_eq!(c.on_tools().len(), 1);
    assert!(c.router_only_tools().is_empty());
}

#[test]
fn tool_state_falls_back_to_the_plain_name_and_to_disabled_tools() {
    let tools = [fake("read_file", "example.Toolset")];
    let c = settings(&[("read_file", false, true)]).context(&tools);
    assert!(c.router_only_tools().is_empty());

    let legacy = FilterSettings { disabled_tools: ["read_file".to_owned()].into(), ..Default::default() };
    assert!(legacy.context(&tools).router_only_tools().is_empty());
    // A stored state wins over `disabledTools`.
    let both =
        FilterSettings { disabled_tools: ["read_file".to_owned()].into(), ..settings(&[("read_file", true, true)]) };
    assert_eq!(both.context(&tools).router_only_tools().len(), 1);
}

#[test]
fn tool_states_tell_tools_of_the_same_name_apart() {
    let tools = [fake("read_file", "example.ToolsetA"), fake("read_file2", "example.ToolsetB")];
    let c = settings(&[("example.ToolsetA.read_file", false, true)]).context(&tools);
    assert_eq!(c.router_only_tools().iter().map(|t| t.name).collect::<Vec<_>>(), ["read_file2"]);
}

#[test]
fn the_mask_filter_runs_after_tool_states() {
    let tools = [fake("read_file", "general.ReadToolset"), fake("search_text", "general.SearchToolset")];
    let s = FilterSettings { tools_filter: "-*.read_file".into(), ..settings(&[("read_file", true, false)]) };
    assert_eq!(names(&s.listed_tools(&tools)), ["search_text"]);
    // A blank filter filters nothing.
    let blank = FilterSettings { tools_filter: "  ".into(), ..Default::default() };
    assert_eq!(names(&blank.listed_tools(&tools)), ["read_file", "search_text"]);
}

#[test]
fn experimental_tools_are_hidden_unless_switched_on() {
    let tools = [fake("stable", "test.TestToolset"), fake("lab", "test.TestToolset").experimental()];
    assert_eq!(names(&FilterSettings::default().listed_tools(&tools)), ["stable"]);
    let on = FilterSettings { experimental_tools: true, ..Default::default() };
    assert_eq!(names(&on.listed_tools(&tools)), ["lab", "stable"]);
    // Switching the one tool on is enough.
    assert_eq!(names(&settings(&[("lab", true, true)]).listed_tools(&tools)), ["lab", "stable"]);
}

// --- invocation modes ------------------------------------------------------------------

fn mode_tools() -> Vec<Tool> {
    vec![
        fake("tool_a", "test.TestToolset"),
        fake("tool_b", "test.TestToolset"),
        fake("tool_c", "test.TestToolset"),
        fake(ROUTER_TOOL_NAME, "general.UniversalToolset"),
    ]
}

#[test]
fn direct_mode_lists_every_enabled_tool_and_the_router() {
    let s = settings(&[("test.TestToolset.tool_c", true, false)]);
    assert_eq!(names(&s.listed_tools(&mode_tools())), ["execute_tool", "tool_a", "tool_b", "tool_c"]);
}

#[test]
fn router_mode_lists_the_router_and_tools_that_are_not_router_only() {
    let s = FilterSettings {
        invocation_mode: McpInvocationMode::ViaRouter,
        ..settings(&[("test.TestToolset.tool_c", true, false)])
    };
    assert_eq!(names(&s.listed_tools(&mode_tools())), ["execute_tool", "tool_c"]);
    assert_eq!(names(&s.routable_tools(&mode_tools())), ["tool_a", "tool_b", "tool_c"], "never routes to itself");
    // The router stays listed although its state disables it.
    let off = FilterSettings {
        invocation_mode: McpInvocationMode::ViaRouter,
        ..settings(&[(ROUTER_TOOL_NAME, false, false)])
    };
    assert!(names(&off.listed_tools(&mode_tools())).contains(&ROUTER_TOOL_NAME));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_lists_and_accepts_tools_by_the_settings() {
    let h = Harness::new(&[("a.txt", "hello\n")]).await;
    let list = |body: String| -> Vec<String> {
        let v: Value = serde_json::from_str(&body).unwrap();
        v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect()
    };
    h.initialize("test-client").await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let direct = list(body);
    assert!(direct.contains(&"read_file".to_owned()) && direct.contains(&ROUTER_TOOL_NAME.to_owned()));
    assert!(!direct.contains(&"get_ide_diagnostics".to_owned()), "experimental tools are off by default");

    let mut states = BTreeMap::new();
    states.insert("general.ReadToolset.read_file".to_owned(), McpToolState { enabled: true, router_only: false });
    let routed =
        McpSettings { invocation_mode: McpInvocationMode::ViaRouter, tool_states: states, ..Default::default() };
    h.server.apply(&routed).await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).await;
    let mut listed = list(body);
    listed.sort();
    assert_eq!(listed, ["execute_tool", "read_file"]);
    // A router-only tool cannot be called directly.
    let (_, _, body) = h
        .post(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "search_file", "arguments": { "q": "*.txt" } } }))
        .await;
    assert!(body.contains("unknown tool `search_file`"), "{body}");

    let filtered = McpSettings { tools_filter: "-*,+general.SearchToolset.*".into(), ..Default::default() };
    h.server.apply(&filtered).await;
    let (_, _, body) = h.post(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" })).await;
    let mut listed = list(body);
    listed.sort();
    assert_eq!(listed, ["search_file", "search_regex", "search_symbol", "search_text"]);

    let info = h.server.tools(&filtered);
    let read = info.iter().find(|t| t.name == "read_file").unwrap();
    assert!(!read.enabled);
    assert_eq!((read.group.as_str(), read.group_name.as_str()), ("general.ReadToolset", "File Reading"));
    assert_eq!(read.fully_qualified_name, "general.ReadToolset.read_file");
    let diagnostics = info.iter().find(|t| t.name == "get_ide_diagnostics").unwrap();
    assert!(diagnostics.experimental && !diagnostics.enabled);
    assert!(info.iter().all(|t| t.group != ide_mcp::filter::DEFAULT_GROUP), "every tool has its JetBrains toolset");
}

// --- the optimizer ---------------------------------------------------------------------

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn group(name: &str, tools: &[&str]) -> (String, BTreeSet<String>) {
    (name.to_owned(), set(tools))
}

#[test]
fn optimizer_all_enabled_or_all_disabled() {
    let groups = [group("Cat1", &["Cat1.tool1", "Cat1.tool2"])];
    assert_eq!(build_optimized_filter(&set(&["Cat1.tool1", "Cat1.tool2"]), &set(&[]), &groups), "*");
    assert_eq!(build_optimized_filter(&set(&[]), &set(&["Cat1.tool1", "Cat1.tool2"]), &groups), "-*");
}

#[test]
fn optimizer_uses_group_masks() {
    let two = [group("Cat1", &["Cat1.tool1", "Cat1.tool2"]), group("Cat2", &["Cat2.tool1", "Cat2.tool2"])];
    assert_eq!(
        build_optimized_filter(&set(&["Cat1.tool1", "Cat1.tool2"]), &set(&["Cat2.tool1", "Cat2.tool2"]), &two),
        "-Cat2.*"
    );
    let three = [two[0].clone(), two[1].clone(), group("Cat3", &["Cat3.tool1", "Cat3.tool2"])];
    assert_eq!(
        build_optimized_filter(
            &set(&["Cat1.tool1", "Cat1.tool2"]),
            &set(&["Cat2.tool1", "Cat2.tool2", "Cat3.tool1", "Cat3.tool2"]),
            &three
        ),
        "-*,+Cat1.*"
    );
}

#[test]
fn optimizer_handles_partly_enabled_groups() {
    let groups = [
        group("Cat1", &["Cat1.tool1", "Cat1.tool2", "Cat1.tool3", "Cat1.tool4"]),
        group("Cat2", &["Cat2.tool1", "Cat2.tool2"]),
    ];
    assert_eq!(
        build_optimized_filter(
            &set(&["Cat1.tool1", "Cat2.tool1", "Cat2.tool2"]),
            &set(&["Cat1.tool2", "Cat1.tool3", "Cat1.tool4"]),
            &groups
        ),
        "-Cat1.*,+Cat1.tool1"
    );
    assert_eq!(
        build_optimized_filter(
            &set(&["Cat1.tool1", "Cat1.tool2", "Cat2.tool1", "Cat2.tool2"]),
            &set(&["Cat1.tool3", "Cat1.tool4"]),
            &groups
        ),
        "-Cat1.tool3,-Cat1.tool4"
    );
}

#[test]
fn optimizer_complex_scenario_and_sorting() {
    let groups = [
        group("Cat1", &["Cat1.tool1", "Cat1.tool2", "Cat1.tool3", "Cat1.tool4"]),
        group("Cat2", &["Cat2.tool1", "Cat2.tool2"]),
        group("Cat3", &["Cat3.tool1", "Cat3.tool2", "Cat3.tool3", "Cat3.tool4"]),
    ];
    assert_eq!(
        build_optimized_filter(
            &set(&["Cat1.tool1", "Cat1.tool2", "Cat1.tool3", "Cat3.tool1"]),
            &set(&["Cat1.tool4", "Cat2.tool1", "Cat2.tool2", "Cat3.tool2", "Cat3.tool3", "Cat3.tool4"]),
            &groups
        ),
        "-*,+Cat1.*,-Cat1.tool4,+Cat3.tool1"
    );
    let one = [group("Cat1", &["Cat1.zebra", "Cat1.apple", "Cat1.mango", "Cat1.banana"])];
    assert_eq!(
        build_optimized_filter(&set(&["Cat1.zebra", "Cat1.apple"]), &set(&["Cat1.mango", "Cat1.banana"]), &one),
        "-Cat1.banana,-Cat1.mango"
    );
}

#[test]
fn group_display_names() {
    assert_eq!(ide_mcp::filter::group_display_name("general.SearchToolset"), "Search");
    assert_eq!(ide_mcp::filter::group_display_name("vcs.VcsToolset"), "Version Control");
    assert_eq!(ide_mcp::filter::group_display_name("example.MyFancyToolset"), "My Fancy");
}
