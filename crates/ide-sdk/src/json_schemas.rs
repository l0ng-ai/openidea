//! Settings › JSON Schema Mappings, sent as vscode-json-language-server's `json.schemas` and
//! yaml-language-server's `yaml.schemas`.
//!
//! Both servers validate a file against every schema whose patterns match it, so the built-in
//! SchemaStore mappings exclude (`!pattern`) the files a custom mapping takes.

use ide_core::settings::JsonSchemaMapping;
use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
use std::path::Path;

pub const JSON_SERVER: &str = "vscode-json-language-server";
pub const YAML_SERVER: &str = "yaml-language-server";

pub fn configure(cfg: &mut LanguageServerConfig, root: &Path, mappings: &[JsonSchemaMapping]) {
    if cfg.name != JSON_SERVER && cfg.name != YAML_SERVER {
        return;
    }
    let mappings: Vec<(String, Vec<String>)> = mappings
        .iter()
        .filter_map(|m| {
            let files: Vec<String> = m
                .files
                .iter()
                .map(|f| f.trim().trim_start_matches("./").to_owned())
                .filter(|f| !f.is_empty())
                .collect();
            let schema = m.schema.trim();
            (!schema.is_empty() && !files.is_empty()).then(|| (schema_uri(root, schema), files))
        })
        .collect();
    if mappings.is_empty() {
        return;
    }
    let excluded: Vec<Value> = mappings.iter().flat_map(|(_, files)| files).map(|f| json!(format!("!{f}"))).collect();
    let mut settings = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
    if cfg.name == JSON_SERVER {
        let schemas = &mut settings["json"]["schemas"];
        let builtin = match schemas.take() {
            Value::Array(list) => list,
            _ => Vec::new(),
        };
        let mut list: Vec<Value> =
            mappings.into_iter().map(|(url, files)| json!({ "url": url, "fileMatch": files })).collect();
        list.extend(builtin.into_iter().map(|mut entry| {
            if let Some(patterns) = entry.get_mut("fileMatch").and_then(Value::as_array_mut) {
                patterns.extend(excluded.iter().cloned());
            }
            entry
        }));
        *schemas = Value::Array(list);
    } else {
        let schemas = &mut settings["yaml"]["schemas"];
        if !schemas.is_object() {
            *schemas = json!({});
        }
        let map = schemas.as_object_mut().expect("object");
        for patterns in map.values_mut() {
            if let Value::String(single) = patterns {
                *patterns = json!([single.clone()]);
            }
            if let Some(list) = patterns.as_array_mut() {
                list.extend(excluded.iter().cloned());
            }
        }
        for (url, files) in mappings {
            let entry = map.entry(url).or_insert_with(|| json!([]));
            match entry.as_array_mut() {
                // A built-in schema mapped again: the custom patterns go before its exclusions.
                Some(list) => {
                    list.retain(|p| !p.as_str().is_some_and(|p| files.iter().any(|f| p == format!("!{f}"))));
                    list.extend(files.into_iter().map(Value::String));
                }
                None => *entry = json!(files),
            }
        }
    }
    cfg.settings = Some(settings);
}

/// A URL as it is; a path, relative to the project, as a `file:` URI.
fn schema_uri(root: &Path, schema: &str) -> String {
    if schema.contains("://") {
        return schema.to_owned();
    }
    let path = root.join(schema);
    url::Url::from_file_path(&path).map_or_else(|()| path.to_string_lossy().into_owned(), String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_language::LanguageRegistry;

    fn server(language: &str, name: &str) -> LanguageServerConfig {
        let registry = LanguageRegistry::load(None).unwrap();
        let lang = registry.get(&ide_core::LanguageId::new(language)).expect("language");
        lang.language_servers.iter().find(|s| s.name == name).expect("server").clone()
    }

    fn mapping(schema: &str, files: &[&str]) -> JsonSchemaMapping {
        JsonSchemaMapping {
            name: "Custom".into(),
            schema: schema.into(),
            files: files.iter().map(|f| (*f).to_owned()).collect(),
        }
    }

    #[test]
    fn custom_json_mappings_come_first_and_built_in_ones_skip_their_files() {
        let mut cfg = server("json", JSON_SERVER);
        let root = Path::new("/work/app");
        configure(&mut cfg, root, &[mapping("schemas/app.json", &["./config/*.json", " package.json "])]);
        let schemas = cfg.settings.as_ref().unwrap()["json"]["schemas"].as_array().unwrap().clone();
        assert_eq!(
            schemas[0],
            json!({ "url": "file:///work/app/schemas/app.json", "fileMatch": ["config/*.json", "package.json"] })
        );
        let package = schemas.iter().find(|s| s["url"] == "https://json.schemastore.org/package.json").unwrap();
        assert_eq!(package["fileMatch"], json!(["package.json", "!config/*.json", "!package.json"]));
        assert_eq!(cfg.settings.as_ref().unwrap()["json"]["validate"]["enable"], json!(true));
    }

    #[test]
    fn custom_yaml_mappings_add_to_yaml_schemas() {
        let mut cfg = server("yaml", YAML_SERVER);
        configure(&mut cfg, Path::new("/work/app"), &[mapping("https://example.com/s.json", &["deploy/*.yaml"])]);
        let schemas = cfg.settings.as_ref().unwrap()["yaml"]["schemas"].as_object().unwrap().clone();
        assert_eq!(schemas["https://example.com/s.json"], json!(["deploy/*.yaml"]));
        let compose = schemas.get(ide_language::COMPOSE_SCHEMA_URL).unwrap().as_array().unwrap();
        assert_eq!(compose.last(), Some(&json!("!deploy/*.yaml")));
        assert!(compose.contains(&json!("compose.yaml")));
    }

    #[test]
    fn incomplete_mappings_and_other_servers_are_left_alone() {
        let mut cfg = server("json", JSON_SERVER);
        let before = cfg.settings.clone();
        configure(&mut cfg, Path::new("/w"), &[mapping("", &["a.json"]), mapping("s.json", &["  "])]);
        assert_eq!(cfg.settings, before);
        let mut other = LanguageServerConfig { name: "taplo".into(), ..cfg.clone() };
        configure(&mut other, Path::new("/w"), &[mapping("s.json", &["a.toml"])]);
        assert_eq!(other.settings, before);
    }
}
