//! `[[contributes.inspections]]`: a first-class inspection a plugin provides.
//!
//! The declaration is declarative (id, severity, language, description); the
//! actual check runs through the WIT host function `run-inspection` that the
//! plugin component exports. Registration here validates the declaration; the
//! host wires the runtime call separately (see `wit/inspections.wit`).

use ide_extension::{ExtensionPoint, Package, Placement, Prepared, decode};
use serde::{Deserialize, Serialize};

pub const POINT_ID: &str = "inspections";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InspectionDecl {
    id: String,
    #[serde(default = "default_severity")]
    severity: String,
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    description: Option<String>,
}

fn default_severity() -> String {
    "warning".into()
}

pub struct InspectionsPoint;

impl InspectionsPoint {
    pub fn new() -> Self {
        Self
    }
}

impl ExtensionPoint for InspectionsPoint {
    fn id(&self) -> &'static str {
        POINT_ID
    }
    fn placement(&self) -> Placement {
        Placement::Workspace
    }
    fn prepare(&self, _pkg: &Package, decl: toml::Value) -> Result<Prepared, String> {
        let d: InspectionDecl = decode(POINT_ID, decl)?;
        if d.id.trim().is_empty() || d.id.len() > 64 {
            return Err(format!("contributes.{POINT_ID}: `id` must be 1–64 chars"));
        }
        if !["error", "warning", "weak-warning", "info", "hint"].contains(&d.severity.as_str()) {
            return Err(format!("contributes.{POINT_ID}: unknown severity {:?}", d.severity));
        }
        let label = d.id.clone();
        Ok(Prepared::new(label, || Ok(ide_extension::Disposable::noop())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_extension::Package;
    use std::path::PathBuf;

    fn pkg(manifest_toml: &str) -> Package {
        let m = ide_extension::Manifest::parse(manifest_toml).unwrap();
        Package::new(m, PathBuf::from("."))
    }

    #[test]
    fn a_valid_inspection_declaration_prepares() {
        let p = InspectionsPoint::new();
        let pkg = pkg(r#"
id = "acme.foo"
name = "Foo"
version = "1.0.0"
engines.openidea = "^1.0"
[[contributes.inspections]]
id = "acme.unused"
severity = "warning"
languages = ["rust"]
"#);
        let decl = pkg.manifest.declarations("inspections").into_iter().next().unwrap();
        let prepared = p.prepare(&pkg, decl).unwrap();
        assert_eq!(prepared.label, "acme.unused");
    }

    #[test]
    fn an_unknown_severity_is_rejected() {
        let p = InspectionsPoint::new();
        let pkg = pkg(r#"
id = "acme.foo"
name = "Foo"
version = "1.0.0"
engines.openidea = "^1.0"
[[contributes.inspections]]
id = "acme.x"
severity = "loud"
"#);
        let decl = pkg.manifest.declarations("inspections").into_iter().next().unwrap();
        assert!(p.prepare(&pkg, decl).is_err());
    }
}
