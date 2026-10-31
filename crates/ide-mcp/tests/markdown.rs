// Ported from JetBrains intellij-community plugins/mcp-server (tests/testSrc/com/intellij/mcpserver/McpToolsMarkdownExporterTest.kt), Apache-2.0.
//! The tools as Markdown.

mod common;

use ide_core::mcp::{McpSettings, McpToolKind};
use ide_mcp::markdown::{generate_markdown, tool_markdown};
use ide_mcp::tool::{Output, Tool};
use serde_json::{Value, json};

fn md(lines: &[&str]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

#[test]
fn single_tool_renders_a_parameters_table() {
    let input = schema(
        json!({
            "sessionId": { "type": "string", "description": "Active session identifier" },
            "line": { "type": "integer", "description": "1-based line number" },
        }),
        &["sessionId", "line"],
    );
    let out = tool_markdown("run_to_target", "Resumes execution to the specified line.", &input, None);
    assert!(out.starts_with(&md(&[
        "# run_to_target",
        "Resumes execution to the specified line.",
        "",
        "## Parameters",
        "| Name | Type | Description |",
        "| --- | --- | --- |",
    ])));
    assert!(out.contains("| sessionId* | string | Active session identifier |\n"));
    assert!(out.contains("| line* | integer | 1-based line number |\n"));
    assert!(out.ends_with("|\n\n"));
}

#[test]
fn output_schema_renders_an_output_section() {
    let input = schema(json!({ "path": { "type": "string", "description": "Target path" } }), &["path"]);
    let output = schema(json!({ "previousValue": { "type": "string", "description": "Value prior to update" } }), &[]);
    let out = tool_markdown("mutate_value", "Updates the value at the supplied path.", &input, Some(&output));
    assert_eq!(
        out,
        md(&[
            "# mutate_value",
            "Updates the value at the supplied path.",
            "",
            "## Parameters",
            "| Name | Type | Description |",
            "| --- | --- | --- |",
            "| path* | string | Target path |",
            "",
            "## Output",
            "| Name | Type | Description |",
            "| --- | --- | --- |",
            "| previousValue | string | Value prior to update |",
            "",
        ])
    );
}

#[test]
fn empty_schemas_render_placeholders() {
    let empty = schema(json!({}), &[]);
    assert_eq!(
        tool_markdown("ping", "Performs no work.", &empty, None),
        md(&["# ping", "Performs no work.", "", "## Parameters", "No parameters.", ""])
    );
    assert_eq!(
        tool_markdown("ping", "Performs no work.", &empty, Some(&empty)),
        md(&[
            "# ping",
            "Performs no work.",
            "",
            "## Parameters",
            "No parameters.",
            "",
            "## Output",
            "No output fields.",
            ""
        ])
    );
}

#[test]
fn escapes_pipes_and_line_breaks() {
    let input =
        schema(json!({ "input": { "type": "string", "description": "Accepts a | separated list." } }), &["input"]);
    let out = tool_markdown("alt|tool", "Provide configurationName | filePath+line.", &input, None);
    assert!(out.contains("# alt|tool\n"), "{out}");
    assert!(out.contains("Provide configurationName \\| filePath+line.\n"), "{out}");
    assert!(out.contains("| input* | string | Accepts a \\| separated list. |\n"), "{out}");
    for description in [
        "Starts a task.\nReturns the handle.",
        "Starts a task.\r\nReturns the handle.",
        "Starts a task.\rReturns the handle.",
    ] {
        let out = tool_markdown("start_task", description, &schema(json!({}), &[]), None);
        assert!(out.contains("Starts a task.<br/>Returns the handle.\n"), "{out}");
    }
}

#[test]
fn renders_types() {
    let input = schema(
        json!({
            "silenced": { "type": ["boolean", "null"], "description": "Suppresses notifications when true" },
            "priority": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH"], "description": "Priority level" },
            "tags": { "type": "array", "items": { "type": "string" }, "description": "Tag filter" },
            "payload": { "description": "Untyped payload" },
            "location": {
                "type": "object",
                "description": "Current cursor position",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "column": { "type": ["integer", "null"], "description": "1-based column when known" },
                },
                "required": ["path"],
            },
            "entries": {
                "type": "array",
                "description": "Active task entries",
                "items": { "type": "object", "properties": { "id": { "type": "string", "description": "Identifier" } } },
            },
        }),
        &[],
    );
    let out = tool_markdown("t", "d", &input, None);
    for row in [
        "| silenced | boolean? | Suppresses notifications when true |",
        "| priority | LOW \\\\| MEDIUM \\\\| HIGH | Priority level |",
        "| tags | array[string] | Tag filter |",
        "| payload | N/A | Untyped payload |",
        "| location | object | Current cursor position |",
        "| &nbsp;&nbsp;path* | string | File path |",
        "| &nbsp;&nbsp;column | integer? | 1-based column when known |",
        "| entries | array[object] | Active task entries |",
        "| &nbsp;&nbsp;[].id | string | Identifier |",
    ] {
        assert!(out.contains(row), "missing {row}: {out}");
    }
}

fn fake(name: &'static str, group: &'static str) -> Tool {
    Tool::new(name, McpToolKind::Read, "d", |_| async { Ok(Output::text("")) }).group(group)
}

#[test]
fn groups_and_sorts_case_insensitively() {
    assert_eq!(generate_markdown(&[]), md(&["# Tools", ""]));
    let tools = [
        fake("writer", "example.FileToolset"),
        fake("Reader", "example.FileToolset"),
        fake("ping", "example.GeneralToolset"),
        fake("Marker", "example.GeneralToolset"),
    ];
    let out = generate_markdown(&tools);
    let at = |s: &str| out.find(s).unwrap_or_else(|| panic!("{s} missing: {out}"));
    assert!(at("## Files") < at("### Reader") && at("### Reader") < at("### writer"));
    assert!(
        at("### writer") < at("## General") && at("## General") < at("### Marker") && at("### Marker") < at("### ping")
    );
    assert!(out.contains("### ping\nd\n\n#### Parameters\n| Name | Type | Description |\n"), "{out}");
}

#[test]
fn indents_of_wide_whitespace_are_trimmed_by_character() {
    // An ideographic space is three bytes: the common indent is one character, not one byte.
    let input = schema(json!({}), &[]);
    let out = tool_markdown("wide", "\u{3000}\u{3000}a\n b\n", &input, None);
    assert!(out.starts_with("# wide\n\u{3000}a<br/>b\n"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn exports_the_offered_tools() {
    let h = common::Harness::new(&[]).await;
    let out = h.server.tools_markdown(&McpSettings::default());
    assert!(out.starts_with("# Tools\n\n## Code Analysis\n"), "{out}");
    assert!(out.contains("### read_file\n") && out.contains("| file_path* | string |"), "{out}");
    assert!(out.contains("### execute_tool\n"), "{out}");
    assert!(!out.contains("### get_ide_diagnostics"), "experimental tools are off");
    let off = McpSettings { disabled_tools: vec!["read_file".into()], ..Default::default() };
    assert!(!h.server.tools_markdown(&off).contains("### read_file"));
}
