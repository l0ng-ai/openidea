//! Endpoint providers contributed by plugins (`[[contributes.endpoints]]`).
//!
//! The IDE runs the declared command with the project root as its argument and
//! parses the returned string as a JSON [`PluginEndpointTable`]:
//!
//! ```json
//! {
//!   "endpoints": [{
//!     "method": "GET", "path": "/photos/:id", "target": "photos#show",
//!     "targetClass": "PhotosController", "name": "photo",
//!     "file": "/app/config/routes.rb", "line": 12,
//!     "request": { "method": "GET", "url": "http://localhost:3000/photos/{{id}}",
//!                  "headers": [{ "name": "Accept", "value": "application/json" }] },
//!     "docs": [["Helper", "photo_path"]]
//!   }],
//!   "diagnostics": [{ "file": "/app/config/routes.rb", "line": 40, "message": "…" }],
//!   "files": ["/app/config/routes.rb"]
//! }
//! ```
//!
//! `file` paths may be project-relative; they are made absolute here.

use crate::manifest::EndpointDecl;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestHeader {
    pub name: String,
    pub value: String,
}

/// The `.http` request to generate for an endpoint.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<PluginRequestHeader>,
    #[serde(default)]
    #[specta(optional)]
    pub body: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEndpoint {
    /// `GET`, `POST`, …, `ANY`.
    pub method: String,
    pub path: String,
    /// Short handler (`photos#show`).
    pub target: String,
    /// Handler class, the row's right column (`PhotosController`).
    #[serde(default)]
    pub target_class: String,
    /// Route / URL helper name.
    #[serde(default)]
    #[specta(optional)]
    pub name: Option<String>,
    /// Declaring file (absolute after parsing) and 1-based line.
    pub file: String,
    pub line: u32,
    /// Default: the method against `http://localhost` + path.
    #[serde(default)]
    #[specta(optional)]
    pub request: Option<PluginRequest>,
    /// Extra rows of the Documentation tab.
    #[serde(default)]
    pub docs: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEndpointDiagnostic {
    pub file: String,
    pub line: u32,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEndpointTable {
    pub endpoints: Vec<PluginEndpoint>,
    #[serde(default)]
    pub diagnostics: Vec<PluginEndpointDiagnostic>,
    /// Files read; a change to one re-runs the provider.
    #[serde(default)]
    pub files: Vec<String>,
}

/// Whether the provider applies to the project at `root`: one of its markers exists (none: always).
pub fn applies(decl: &EndpointDecl, root: &Path) -> bool {
    decl.markers.is_empty() || decl.markers.iter().any(|m| root.join(m).exists())
}

/// Parses the command's output and makes every path absolute under `root`.
pub fn parse_table(json: &str, root: &Path) -> Result<PluginEndpointTable, String> {
    if json.trim().is_empty() {
        return Err("the endpoints command returned nothing".to_owned());
    }
    let mut table: PluginEndpointTable =
        serde_json::from_str(json).map_err(|e| format!("invalid endpoint table: {e}"))?;
    let absolute = |p: &mut String| {
        let path = Path::new(p);
        if path.is_relative() {
            *p = root.join(path).to_string_lossy().into_owned();
        }
    };
    for e in &mut table.endpoints {
        absolute(&mut e.file);
        if e.method.is_empty() {
            e.method = "ANY".to_owned();
        }
        e.method.make_ascii_uppercase();
    }
    for d in &mut table.diagnostics {
        absolute(&mut d.file);
    }
    for f in &mut table.files {
        absolute(f);
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(markers: &[&str]) -> EndpointDecl {
        EndpointDecl {
            framework: "Rails".into(),
            r#type: "HTTP".into(),
            command: "endpoints".into(),
            markers: markers.iter().map(|m| m.to_string()).collect(),
            watch: vec!["config/routes/*.rb".into()],
            icon: None,
        }
    }

    #[test]
    fn applies_when_a_marker_exists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(applies(&decl(&[]), dir.path()));
        assert!(!applies(&decl(&["config/routes.rb"]), dir.path()));
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config/routes.rb"), "").unwrap();
        assert!(applies(&decl(&["bin/rails", "config/routes.rb"]), dir.path()));
    }

    #[test]
    fn parses_the_table_and_absolutises_paths() {
        let root = Path::new("/app");
        let table = parse_table(
            r#"{"endpoints":[{"method":"get","path":"/up","target":"rails/health#show","file":"config/routes.rb","line":6}],
                "diagnostics":[{"file":"/app/config/routes.rb","line":9,"message":"x"}],"files":["config/routes.rb"]}"#,
            root,
        )
        .unwrap();
        assert_eq!(table.endpoints[0].method, "GET");
        assert_eq!(table.endpoints[0].file, "/app/config/routes.rb");
        assert_eq!(table.endpoints[0].target_class, "");
        assert!(table.endpoints[0].request.is_none());
        assert_eq!(table.files, ["/app/config/routes.rb"]);
        assert_eq!(table.diagnostics[0].file, "/app/config/routes.rb");
        assert!(parse_table("", root).is_err());
        assert!(parse_table("{\"endpoints\": 1}", root).unwrap_err().starts_with("invalid endpoint table"));
    }
}
