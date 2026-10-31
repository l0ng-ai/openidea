// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/McpToolsMarkdownExporter.kt), Apache-2.0.
//! The tools as Markdown: per group a section, per tool its description and tables of its
//! parameters and output fields (`*` marks required ones).

use crate::filter::group_display_name;
use crate::tool::Tool;
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fmt::Write;

/// `# Tools`, then a `##` section per group (by class name, case-insensitively) with the
/// group's tools (by name, case-insensitively) at heading level 3.
pub fn generate_markdown(tools: &[Tool]) -> String {
    let mut groups: Vec<&str> = tools.iter().map(|t| t.group).collect::<BTreeSet<_>>().into_iter().collect();
    groups.sort_by_key(|g| short_name(g).to_lowercase());
    let mut out = String::from("# Tools\n\n");
    for group in groups {
        let _ = writeln!(out, "## {}\n", group_display_name(group));
        let mut members: Vec<&Tool> = tools.iter().filter(|t| t.group == group).collect();
        members.sort_by_key(|t| t.name.to_lowercase());
        for tool in members {
            let output = tool.output_schema.as_ref();
            tool_section(&mut out, tool.name, tool.description, &tool.input_schema(), output, 3);
        }
    }
    out
}

/// One tool as a document of its own (heading level 1).
pub fn tool_markdown(name: &str, description: &str, input_schema: &Value, output_schema: Option<&Value>) -> String {
    let mut out = String::new();
    tool_section(&mut out, name, description, input_schema, output_schema, 1);
    out
}

fn short_name(group: &str) -> &str {
    group.rsplit('.').next().unwrap_or(group)
}

fn tool_section(out: &mut String, name: &str, description: &str, input: &Value, output: Option<&Value>, level: usize) {
    let heading = "#".repeat(level);
    let _ = writeln!(out, "{heading} {name}");
    let description = trim_indent(description);
    if !description.trim().is_empty() {
        let _ = writeln!(out, "{}", escape_markdown(&escape_line_breaks(&description)));
    }
    out.push('\n');
    let _ = writeln!(out, "{heading}# Parameters");
    schema_table(out, input, "No parameters.");
    out.push('\n');
    if let Some(output) = output {
        let _ = writeln!(out, "{heading}# Output");
        schema_table(out, output, "No output fields.");
        out.push('\n');
    }
}

fn schema_table(out: &mut String, schema: &Value, empty: &str) {
    let mut rows = Vec::new();
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        collect_rows(properties, &required_set(schema), &mut rows, 0, "");
    }
    if rows.is_empty() {
        let _ = writeln!(out, "{empty}");
        return;
    }
    out.push_str("| Name | Type | Description |\n| --- | --- | --- |\n");
    for (name, ty, description) in rows {
        let description =
            description.map(|d| escape_markdown(&escape_line_breaks(&trim_indent(&d)))).unwrap_or_default();
        let _ = writeln!(out, "| {name} | {} | {description} |", escape_markdown(&ty));
    }
}

/// Rows of `(name, type, description)`; nested object properties and array item properties
/// follow their parent, indented by `&nbsp;&nbsp;` per level (items prefixed with `[].`).
fn collect_rows(
    properties: &Map<String, Value>,
    required: &BTreeSet<String>,
    rows: &mut Vec<(String, String, Option<String>)>,
    depth: usize,
    prefix: &str,
) {
    let indent = "&nbsp;&nbsp;".repeat(depth);
    for (name, schema) in properties {
        let Some(schema) = schema.as_object() else { continue };
        let star = if required.contains(name) { "*" } else { "" };
        let description = schema.get("description").and_then(Value::as_str).map(str::to_owned);
        rows.push((format!("{indent}{prefix}{name}{star}"), extract_type(schema), description));
        if let Some(nested) = schema.get("properties").and_then(Value::as_object) {
            collect_rows(nested, &required_set(&Value::Object(schema.clone())), rows, depth + 1, "");
        }
        if let Some(items) = schema.get("items").and_then(Value::as_object)
            && let Some(nested) = items.get("properties").and_then(Value::as_object)
        {
            collect_rows(nested, &required_set(&Value::Object(items.clone())), rows, depth + 1, "[].");
        }
    }
}

fn required_set(schema: &Value) -> BTreeSet<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `string`, `boolean?` (nullable union), `a \| b` (enum), `array[string]`, `N/A` (untyped).
fn extract_type(schema: &Map<String, Value>) -> String {
    let raw = match schema.get("type") {
        Some(Value::String(t)) => Some(t.as_str()),
        Some(Value::Array(types)) => {
            let types: Vec<&str> = types.iter().filter_map(Value::as_str).collect();
            let base = types.iter().find(|t| **t != "null").copied().unwrap_or("any");
            return if types.contains(&"null") { format!("{base}?") } else { base.into() };
        }
        _ => None,
    };
    match (schema.get("enum").and_then(Value::as_array), raw) {
        (Some(values), None | Some("string")) => {
            values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" \\| ")
        }
        (_, Some("array")) => {
            let item = schema.get("items").and_then(Value::as_object).map(extract_type);
            format!("array[{}]", item.as_deref().unwrap_or("any"))
        }
        (_, Some(t)) => t.into(),
        (_, None) => "N/A".into(),
    }
}

/// Kotlin's `trimIndent`: drops blank first and last lines and the common indent.
fn trim_indent(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    if lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    // Counted in characters, as Kotlin does: indents may mix one-byte and wider whitespace.
    let indent_chars = |l: &str| l.chars().take_while(|c| c.is_whitespace()).count();
    let indent = lines.iter().filter(|l| !l.trim().is_empty()).map(|l| indent_chars(l)).min().unwrap_or(0);
    lines
        .iter()
        .map(|l| match l.char_indices().nth(indent) {
            _ if l.trim().is_empty() => "",
            Some((at, _)) => &l[at..],
            None => "",
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn escape_line_breaks(text: &str) -> String {
    text.replace("\r\n", "<br/>").replace(['\n', '\r'], "<br/>")
}

fn escape_markdown(text: &str) -> String {
    text.replace('|', "\\|")
}
