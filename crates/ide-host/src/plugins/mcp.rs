//! Validated MCP declarations and dispatch through the ordinary plugin actor.
use super::{PluginHost, PluginStatus};
use ide_core::{IdeError, IdeResult};
use ide_extension::{Package, UiDecl, decode};
use ide_plugin::Invocation;
use serde::Deserialize;

pub(super) const POINT: &str = "mcpTools";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration {
    name: String,
    description: String,
    input_schema: std::path::PathBuf,
    read_only: bool,
    destructive: bool,
}
fn tool_name(plugin: &str, name: &str) -> String {
    let plugin: String = plugin
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' { c } else { '_' })
        .collect();
    format!("{plugin}__{name}")
}
pub(super) fn declaration(pkg: &Package, value: toml::Value) -> Result<UiDecl, String> {
    pkg.manifest.needs_api("contributes.mcpTools", 4)?;
    if pkg.manifest.wasm.is_none() {
        return Err("mcpTools requires wasm".into());
    }
    let d: Declaration = decode(POINT, value)?;
    if d.name.is_empty()
        || d.name.len() > 40
        || !d.name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        || tool_name(pkg.id(), &d.name).len() > 64
        || d.description.trim().is_empty()
        || d.description.len() > 4096
    {
        return Err(
            "mcpTools: name must match [a-z0-9_]{1,40}, namespaced name at most 64 bytes, description 1–4096 bytes"
                .into(),
        );
    }
    let text = pkg.read_text(&d.input_schema)?;
    if text.len() > 256 << 10 {
        return Err("mcpTools: schema exceeds 256 KiB".into());
    }
    let schema: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("mcpTools: {e}"))?;
    if schema.get("type").and_then(serde_json::Value::as_str) != Some("object") {
        return Err("mcpTools: inputSchema must describe an object".into());
    }
    // No HTTP or filesystem resolver features: schemas must be self-contained.
    jsonschema::validator_for(&schema).map_err(|e| format!("mcpTools: invalid JSON Schema: {e}"))?;
    let mut out = UiDecl::new(
        d.name.clone(),
        d.description.clone(),
        serde_json::json!({
            "name": d.name, "description": d.description, "inputSchema": schema, "readOnly": d.read_only, "destructive": d.destructive,
        }),
    );
    out.files.push(d.input_schema);
    Ok(out)
}

impl PluginHost {
    /// Live declarations only, refreshed on every list/call. Ambiguous normalized names fail closed.
    pub fn mcp_tools(&self, root: &std::path::Path) -> Vec<(String, String, ide_mcp::Tool)> {
        let mut tools = vec![];
        for item in self.ui.items(POINT, None) {
            let Ok(plugin) = self.get(&item.plugin_id) else { continue };
            if !matches!(plugin.status(), PluginStatus::Active | PluginStatus::Inactive)
                || plugin.dev_root.as_deref().is_some_and(|r| r != root)
            {
                continue;
            }
            let d = &item.decl;
            let Some(name) = d["name"].as_str() else { continue };
            tools.push((
                plugin.id().to_owned(),
                name.to_owned(),
                ide_mcp::Tool {
                    name: tool_name(plugin.id(), name),
                    description: format!(
                        "{} (plugin: {} [{}])",
                        d["description"].as_str().unwrap_or_default(),
                        plugin.manifest().name,
                        plugin.id()
                    ),
                    input_schema: d["inputSchema"].clone(),
                    output_schema: None,
                    read_only: d["readOnly"].as_bool().unwrap_or(false),
                    destructive: d["destructive"].as_bool().unwrap_or(true),
                },
            ));
        }
        let mut counts = std::collections::HashMap::new();
        for (_, _, tool) in &tools {
            *counts.entry(tool.name.clone()).or_insert(0) += 1;
        }
        tools.retain(|(_, _, tool)| counts[&tool.name] == 1);
        tools
    }
    pub fn call_mcp_tool(
        &self,
        plugin: &str,
        tool: &str,
        arguments: &str,
        invocation: Invocation,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<String> {
        if arguments.len() > 1 << 20 {
            return Err(IdeError::invalid("MCP arguments exceed 1 MiB"));
        }
        let root =
            invocation.workspace_root.as_ref().ok_or_else(|| IdeError::invalid("MCP requires a project window"))?;
        let (_, _, declared) = self
            .mcp_tools(std::path::Path::new(root))
            .into_iter()
            .find(|(p, n, _)| p == plugin && n == tool)
            .ok_or_else(|| IdeError::not_found("plugin MCP tool is no longer available"))?;
        let args: serde_json::Value = serde_json::from_str(arguments).map_err(|e| IdeError::invalid(e.to_string()))?;
        let validator =
            jsonschema::validator_for(&declared.input_schema).map_err(|e| IdeError::invalid(e.to_string()))?;
        if !validator.is_valid(&args) {
            return Err(IdeError::invalid("MCP arguments do not match inputSchema"));
        }
        let (tool, arguments) = (tool.to_owned(), arguments.to_owned());
        self.code_call_cancellable(plugin, invocation, "calling the MCP tool", Some(cancel), move |rt, inv| {
            rt.mcp_call(&tool, &arguments, inv)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_names_schema_files_versions_and_schema_keywords_at_install() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = |api: &str| {
            Package::new(
                ide_extension::Manifest::parse(&format!(
                    "id='test.tools'\nname='Tools'\nversion='1.0.0'\nengines.openidea='{api}'\nwasm='plugin.wasm'"
                ))
                .unwrap(),
                tmp.path().into(),
            )
        };
        let decl = |name: &str, path: &str| {
            toml::from_str::<toml::Value>(&format!(
                "name='{name}'\ndescription='Tool'\ninputSchema='{path}'\nreadOnly=true\ndestructive=false"
            ))
            .unwrap()
        };
        std::fs::write(
            tmp.path().join("args.json"),
            r##"{"type":"object","$defs":{"text":{"type":"string"}},"properties":{"text":{"$ref":"#/$defs/text"}}}"##,
        )
        .unwrap();
        assert_eq!(declaration(&pkg("^1.4"), decl("echo", "args.json")).unwrap().files.len(), 1);
        assert!(declaration(&pkg("^1.3"), decl("echo", "args.json")).is_err());
        for name in ["", "Bad", "bad-name", &"x".repeat(41)] {
            assert!(declaration(&pkg("^1.4"), decl(name, "args.json")).is_err());
        }
        assert!(declaration(&pkg("^1.4"), decl("echo", "../args.json")).is_err());
        for schema in [
            r#"{"type":"nonsense"}"#,
            r#"{"type":"object","required":42}"#,
            r#"{"type":"object","properties":{"x":{"$ref":"file:///private/secret"}}}"#,
            r#"{"type":"object","properties":{"x":{"$ref":"https://example.invalid/schema"}}}"#,
        ] {
            std::fs::write(tmp.path().join("args.json"), schema).unwrap();
            assert!(declaration(&pkg("^1.4"), decl("echo", "args.json")).is_err(), "{schema}");
        }
        assert_eq!(tool_name("a.b-c", "echo"), "a_b_c__echo");
    }
}
