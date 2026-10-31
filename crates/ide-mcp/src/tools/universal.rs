// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/toolsets/general/UniversalToolset.kt), Apache-2.0.
//! `execute_tool`, the router: calls another tool from a command line
//! (`search_file --q **/*.java --limit 1`). In router mode (`invocationMode: viaRouter`) it is
//! the only tool listed besides those whose state is not router-only.

use crate::filter::ROUTER_TOOL_NAME;
use crate::history::Ended;
use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const FLAG_PREFIX: &str = "--";
const MAX_TOOL_NAME_SUGGESTIONS: usize = 5;
const LIMIT_PROPERTY: &str = "limit";
const OFFSET_PROPERTY: &str = "offset";
/// Folded flag names for the last line to read; [`parse_args_to_json`] turns them into a `limit`.
const LAST_LINE_FLAGS: &[&str] = &["endline", "lineend"];

pub const GROUP: &str = "general.UniversalToolset";

pub fn tools() -> Vec<Tool> {
    vec![
        Tool::new(
            ROUTER_TOOL_NAME,
            McpToolKind::Execute,
            "Universal tool executor that can invoke specific IDE MCP tool dynamically.",
            execute_tool,
        )
        .group(GROUP)
        .param(Param::required(
            "command",
            ParamType::String,
            "Command-line string with tool name and arguments",
        )),
    ]
}

fn fail(message: impl Into<String>) -> IdeError {
    IdeError::invalid(message)
}

async fn execute_tool(call: Call) -> IdeResult<Output> {
    let command = call.str("command")?;
    let parts = parse_command_line(&command);
    let Some((name, args)) = parts.split_first() else { return Err(fail("Command is empty")) };
    let tools = call.shared.routable_tools();
    let tool = find_tool(name, &tools)?;
    let schema = tool.input_schema();
    let properties = schema["properties"].as_object().cloned().unwrap_or_default();
    let json_args = parse_args_to_json(args, &properties)?;
    let required: Vec<&str> = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let missing: Vec<&str> = required.into_iter().filter(|r| !json_args.contains_key(*r)).collect();
    if !missing.is_empty() {
        let known = properties.keys().map(|k| format!("{FLAG_PREFIX}{k}")).collect::<Vec<_>>().join(", ");
        return Err(fail(format!("Missing required parameters: {}. Accepted: {known}", missing.join(", "))));
    }

    // A `--projectPath` of the routed tool overrides the router's.
    let target = match json_args.get(crate::tool::PROJECT_PATH).and_then(Value::as_str) {
        Some(path) => {
            let sources = crate::project::Sources { argument: Some(path), ..Default::default() };
            crate::project::target(&call.host(), &sources, call.ui().focused_window().as_deref())?
        }
        None => call.target.clone(),
    };
    let root = target.project.root.clone();
    let started = call.shared.history.begin(&call.client, tool.name, &json_args, true, Some(&root));
    // The routed call's changes are the router call's too.
    let routed = Call {
        shared: call.shared.clone(),
        target,
        args: json_args,
        client: call.client.clone(),
        tool: tool.name,
        cancel: call.cancel.clone(),
        progress: call.progress.clone(),
        session: call.session.clone(),
        outbound: call.outbound.clone(),
        changes: call.changes.clone(),
    };
    let handler = tool.handler.clone();
    let outcome = tokio::spawn(async move { handler(routed).await }).await;
    let mut ended = match &outcome {
        Ok(result) => Ended::of(result),
        Err(_) => Ended::failed(format!("the tool `{}` failed unexpectedly", tool.name)),
    };
    ended.changed_files = call.changes.lock().iter().map(|p| crate::project::display(&root, p)).collect();
    call.shared.history.finish(started, ended);
    match outcome {
        Ok(Ok(output)) => Ok(Output::text(output.text)),
        Ok(Err(e)) if e.kind == ide_core::error::ErrorKind::Cancelled => Err(e),
        Ok(Err(e)) => Err(IdeError::new(e.kind, format!("Tool execution failed: [error]: {}", e.message))),
        Err(_) => Err(IdeError::internal(format!(
            "Tool execution failed: [error]: the tool `{}` failed unexpectedly",
            tool.name
        ))),
    }
}

fn find_tool<'a>(name: &str, tools: &'a [Tool]) -> IdeResult<&'a Tool> {
    if let Some(tool) = tools.iter().find(|t| t.name == name) {
        return Ok(tool);
    }
    let suggestions = nearest_tool_names(name, tools);
    if suggestions.is_empty() {
        return Err(fail(format!("Tool '{name}' not found")));
    }
    Err(fail(format!("Tool '{name}' not found. Did you mean: {}?", suggestions.join(", "))))
}

/// The known tool names ranked by shared name fragments, closest first.
fn nearest_tool_names(name: &str, tools: &[Tool]) -> Vec<String> {
    let fragments = |s: &str| -> Vec<String> {
        s.to_lowercase().split(['_', '-']).filter(|p| !p.is_empty()).map(str::to_owned).collect()
    };
    let wanted = fragments(name);
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(&str, usize)> = tools
        .iter()
        .map(|t| {
            let parts: BTreeSet<String> = fragments(t.name).into_iter().collect();
            let score = parts
                .iter()
                .filter(|part| {
                    wanted.iter().any(|w| w == *part || w.contains(part.as_str()) || part.contains(w.as_str()))
                })
                .count();
            (t.name, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    scored.into_iter().take(MAX_TOOL_NAME_SUGGESTIONS).map(|(n, _)| n.to_owned()).collect()
}

/// Splits a command line like a shell: whitespace separates, `"..."` and `'...'` group, and a
/// backslash before a quote makes it literal (other backslashes stay, for Windows paths).
pub fn parse_command_line(command: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek().is_some_and(|n| quote.map_or(*n == '"' || *n == '\'', |q| *n == q)) => {
                current.extend(chars.next());
            }
            c if quote == Some(c) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(c),
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Turns `--name value` pairs into arguments typed by the tool's schema `properties`. A flag
/// matches a property exactly, or the only one with the same folded name (lowercase, without
/// `_` and `-`); a last-line flag (`--end_line`) becomes `limit` for tools reading a window.
pub fn parse_args_to_json(args: &[String], properties: &Map<String, Value>) -> IdeResult<Map<String, Value>> {
    // In first-seen order; a repeated flag keeps its place and takes the last value.
    fn put(entries: &mut Vec<(String, String)>, key: &str, value: &str) {
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.to_owned(),
            None => entries.push((key.to_owned(), value.to_owned())),
        }
    }
    let mut resolved: Vec<(String, String)> = Vec::new();
    let mut unresolved: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let Some(name) = arg.strip_prefix(FLAG_PREFIX) else {
            return Err(fail(format!(
                "Invalid argument format: '{arg}'. Expected '{FLAG_PREFIX}paramName value' format. For object/array \
                 parameters pass a JSON value, e.g. --findings '[{{...}}]'."
            )));
        };
        let value = args.get(i + 1).ok_or_else(|| fail(format!("Parameter '{name}' requires a value")))?;
        match resolve_flag_name(name, properties) {
            Some(property) => put(&mut resolved, &property, value),
            None => put(&mut unresolved, name, value),
        }
        i += 2;
    }
    convert_last_line_to_limit(&mut resolved, &mut unresolved, properties)?;

    // An empty schema has nothing to check a flag against, so it passes all flags through.
    if let Some((first, _)) = unresolved.first()
        && !properties.is_empty()
    {
        let known = properties.keys().map(|k| format!("{FLAG_PREFIX}{k}")).collect::<Vec<_>>().join(", ");
        return Err(fail(format!("Unknown parameter '{FLAG_PREFIX}{first}'. Accepted: {known}")));
    }
    let mut out = Map::new();
    for (key, value) in resolved.iter().chain(unresolved.iter()) {
        out.insert(key.clone(), convert_value(key, value, properties)?);
    }
    Ok(out)
}

fn convert_last_line_to_limit(
    resolved: &mut Vec<(String, String)>,
    unresolved: &mut Vec<(String, String)>,
    properties: &Map<String, Value>,
) -> IdeResult<()> {
    if !properties.contains_key(LIMIT_PROPERTY) || !properties.contains_key(OFFSET_PROPERTY) {
        return Ok(());
    }
    let Some(index) = unresolved.iter().position(|(k, _)| LAST_LINE_FLAGS.contains(&fold_flag_name(k).as_str())) else {
        return Ok(());
    };
    let flag = unresolved[index].0.clone();
    if resolved.iter().any(|(k, _)| k == LIMIT_PROPERTY) {
        return Err(fail(format!(
            "Pass either '{FLAG_PREFIX}{LIMIT_PROPERTY}' (a line count) or '{FLAG_PREFIX}{flag}' (a last line), not both."
        )));
    }
    let last_line = unresolved[index].1.parse::<i64>().ok();
    let offset =
        resolved.iter().find(|(k, _)| k == OFFSET_PROPERTY).and_then(|(_, v)| v.parse::<i64>().ok()).unwrap_or(1);
    match last_line {
        Some(last) if last >= offset => {
            resolved.push((LIMIT_PROPERTY.into(), (last - offset + 1).to_string()));
            unresolved.remove(index);
            Ok(())
        }
        _ => Err(fail(format!(
            "Parameter '{FLAG_PREFIX}{flag}' must be a line number at or after the offset ({offset})."
        ))),
    }
}

/// The schema property a flag names: the exact name, else the only one with the same folded name.
pub fn resolve_flag_name(name: &str, properties: &Map<String, Value>) -> Option<String> {
    if properties.contains_key(name) {
        return Some(name.to_owned());
    }
    let folded = fold_flag_name(name);
    let mut matching = properties.keys().filter(|k| fold_flag_name(k) == folded);
    match (matching.next(), matching.next()) {
        (Some(only), None) => Some(only.clone()),
        _ => None,
    }
}

fn fold_flag_name(name: &str) -> String {
    name.to_lowercase().replace(['_', '-'], "")
}

fn convert_value(name: &str, value: &str, properties: &Map<String, Value>) -> IdeResult<Value> {
    let ty = properties.get(name).and_then(|s| s.get("type")).and_then(Value::as_str).unwrap_or("string");
    Ok(match ty {
        "boolean" => Value::Bool(value.eq_ignore_ascii_case("true")),
        "integer" | "number" => match value.parse::<i64>() {
            Ok(n) => n.into(),
            Err(_) => value
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .ok_or_else(|| fail(format!("Parameter '{name}' expects a number, got: {value}")))?,
        },
        "array" => parse_structured(name, value, "array", Value::is_array)?,
        "object" => parse_structured(name, value, "object", |v| v.is_object() || v.is_array())?,
        _ => Value::String(value.to_owned()),
    })
}

fn parse_structured(name: &str, value: &str, type_name: &str, accept: fn(&Value) -> bool) -> IdeResult<Value> {
    let parsed: Value = serde_json::from_str(value)
        .map_err(|e| fail(format!("Parameter '{name}' expects a JSON {type_name}, got: {value} ({e})")))?;
    if !accept(&parsed) {
        let kind = match &parsed {
            Value::Null => "JsonNull",
            Value::Object(_) => "JsonObject",
            Value::Array(_) => "JsonArray",
            _ => "JsonPrimitive",
        };
        return Err(fail(format!("Parameter '{name}' expects a JSON {type_name}, got {kind}: {value}")));
    }
    Ok(parsed)
}
