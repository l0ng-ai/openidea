//! Bundled XML catalogs for LemMinX so known-broken remote XSDs resolve locally.
//!
//! Doctrine's hosted `doctrine-mapping.xsd` advertises the wrong `targetNamespace`
//! (the schema URL itself) after an http→https rewrite, so any mapping file that
//! points `xsi:schemaLocation` at that URL fails with `TargetNamespace.1` /
//! `cvc-elt.1.a`. An OASIS catalog maps the namespace and those system IDs to the
//! correct upstream schema we ship.

use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const SERVER: &str = "lemminx";

const DOCTRINE_XSD: &str = include_str!("../schemas/xml/doctrine-mapping.xsd");

const CATALOG_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
  <uri name="http://doctrine-project.org/schemas/orm/doctrine-mapping" uri="doctrine-mapping.xsd"/>
  <uri name="https://www.doctrine-project.org/schemas/orm/doctrine-mapping.xsd" uri="doctrine-mapping.xsd"/>
  <system systemId="https://www.doctrine-project.org/schemas/orm/doctrine-mapping.xsd" uri="doctrine-mapping.xsd"/>
  <system systemId="http://www.doctrine-project.org/schemas/orm/doctrine-mapping.xsd" uri="doctrine-mapping.xsd"/>
</catalog>
"#;

/// Writes the bundled catalog (idempotent) and prepends it to LemMinX `xml.catalogs`.
pub fn configure_lemminx_catalogs(cfg: &mut LanguageServerConfig) {
    if cfg.name != SERVER {
        return;
    }
    let Some(catalog) = ensure_catalog() else { return };
    let catalog = path_for_settings(&catalog);
    let mut settings = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let catalogs = settings
        .as_object_mut()
        .expect("object")
        .entry("xml")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .and_then(|xml| xml.entry("catalogs").or_insert_with(|| json!([])).as_array_mut());
    if let Some(catalogs) = catalogs {
        if catalogs.iter().any(|v| v.as_str() == Some(catalog.as_str())) {
            cfg.settings = Some(settings);
            return;
        }
        catalogs.insert(0, Value::String(catalog));
    }
    cfg.settings = Some(settings);
}

fn ensure_catalog() -> Option<PathBuf> {
    static CATALOG: OnceLock<Option<PathBuf>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let dir = std::env::temp_dir().join("openidea-xml-catalog");
            std::fs::create_dir_all(&dir).ok()?;
            let xsd = dir.join("doctrine-mapping.xsd");
            write_if_changed(&xsd, DOCTRINE_XSD.as_bytes())?;
            let catalog = dir.join("catalog.xml");
            write_if_changed(&catalog, CATALOG_TEMPLATE.as_bytes())?;
            Some(catalog)
        })
        .clone()
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Option<()> {
    if std::fs::read(path).ok().as_deref() == Some(bytes) {
        return Some(());
    }
    ide_vfs::write_atomic(path, bytes).ok().map(|_| ())
}

fn path_for_settings(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_language::LanguageRegistry;

    #[test]
    fn bundled_xsd_keeps_http_namespace() {
        assert!(DOCTRINE_XSD.contains("targetNamespace=\"http://doctrine-project.org/schemas/orm/doctrine-mapping\""));
        assert!(!DOCTRINE_XSD.contains("xmlns:xs=\"https://www.w3.org/2001/XMLSchema\""));
        assert!(!DOCTRINE_XSD.contains("targetNamespace=\"https://www.doctrine-project.org"));
    }

    #[test]
    fn prepends_catalog_without_dropping_user_entries() {
        let reg = LanguageRegistry::load(None).unwrap();
        let xml = reg.get(&ide_core::LanguageId::new("xml")).unwrap();
        let mut cfg = xml.language_servers[0].clone();
        cfg.settings = Some(json!({"xml": {"catalogs": ["/user/catalog.xml"]}}));
        configure_lemminx_catalogs(&mut cfg);
        let list: Vec<String> = cfg.settings.as_ref().unwrap()["xml"]["catalogs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        assert_eq!(list.len(), 2);
        assert!(list[0].ends_with("catalog.xml"));
        assert_eq!(list[1], "/user/catalog.xml");
        configure_lemminx_catalogs(&mut cfg);
        assert_eq!(cfg.settings.as_ref().unwrap()["xml"]["catalogs"].as_array().unwrap().len(), 2);
        let catalog = PathBuf::from(&list[0]);
        let body = std::fs::read_to_string(&catalog).unwrap();
        assert!(body.contains("doctrine-mapping.xsd"));
        let xsd = catalog.with_file_name("doctrine-mapping.xsd");
        assert_eq!(std::fs::read_to_string(xsd).unwrap(), DOCTRINE_XSD);
    }

    #[test]
    fn ignores_other_servers() {
        let reg = LanguageRegistry::load(None).unwrap();
        let yaml = reg.get(&ide_core::LanguageId::new("yaml")).unwrap();
        let mut cfg = yaml.language_servers[0].clone();
        let before = cfg.settings.clone();
        configure_lemminx_catalogs(&mut cfg);
        assert_eq!(cfg.settings, before);
    }
}
