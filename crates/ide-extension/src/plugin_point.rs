//! Extension points a plugin declares for other plugins to contribute to
//! (`[[extension-points]]`), and the check of a contribution against them.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

const MAX_FIELDS: usize = 32;
const MAX_ID: usize = 128;
/// Longest string a contribution may carry in one field.
const MAX_TEXT: usize = 64 * 1024;
const MAX_LIST: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum FieldType {
    String,
    Boolean,
    Integer,
    Number,
    StringList,
}

/// `[[extension-points]]`: a kind of contribution the declaring plugin's code reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct PointDecl {
    /// `<plugin id>.<name>`.
    pub id: String,
    #[serde(default)]
    pub description: String,
    /// Fields a contribution must have.
    #[serde(default)]
    pub required: Vec<String>,
    /// Every field a contribution may have; a contribution with another key is refused.
    #[serde(default)]
    pub fields: BTreeMap<String, FieldType>,
}

impl PointDecl {
    pub fn validate(&self, plugin_id: &str) -> Result<(), String> {
        let prefix = format!("{plugin_id}.");
        let name = self.id.strip_prefix(&prefix).unwrap_or("");
        let name_ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
        if !name_ok || self.id.len() > MAX_ID {
            return Err(format!(
                "invalid extension point {:?}: use \"{plugin_id}.<name>\" with a-z, 0-9, '.', '-', '_' in the name",
                self.id
            ));
        }
        if self.description.len() > 500 {
            return Err(format!("extension point {}: `description` is longer than 500 characters", self.id));
        }
        if self.fields.len() > MAX_FIELDS {
            return Err(format!("extension point {}: at most {MAX_FIELDS} fields", self.id));
        }
        for field in self.fields.keys() {
            let ok = field.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && field.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                && field.len() <= 64;
            if !ok {
                return Err(format!("extension point {}: invalid field name {field:?}", self.id));
            }
        }
        for field in &self.required {
            if !self.fields.contains_key(field) {
                return Err(format!("extension point {}: required field {field:?} is not in `fields`", self.id));
            }
        }
        Ok(())
    }

    /// Checks one contribution and returns it as JSON for the declaring plugin's code.
    pub fn check(&self, value: &toml::Value) -> Result<serde_json::Value, String> {
        let toml::Value::Table(table) = value else {
            return Err("a contribution is a table".into());
        };
        for key in table.keys() {
            if !self.fields.contains_key(key) {
                let known: Vec<&str> = self.fields.keys().map(String::as_str).collect();
                return Err(format!("unknown field {key:?} (this extension point has: {})", known.join(", ")));
            }
        }
        for key in &self.required {
            if !table.contains_key(key) {
                return Err(format!("missing required field {key:?}"));
            }
        }
        let mut out = serde_json::Map::new();
        for (key, value) in table {
            out.insert(key.clone(), convert(key, self.fields[key], value)?);
        }
        Ok(serde_json::Value::Object(out))
    }
}

fn convert(key: &str, ty: FieldType, value: &toml::Value) -> Result<serde_json::Value, String> {
    use serde_json::Value as J;
    let wrong = |expected: &str| format!("field {key:?} must be {expected}");
    match (ty, value) {
        (FieldType::String, toml::Value::String(s)) => text(key, s).map(J::from),
        (FieldType::Boolean, toml::Value::Boolean(b)) => Ok(J::from(*b)),
        (FieldType::Integer, toml::Value::Integer(i)) => Ok(J::from(*i)),
        (FieldType::Number, toml::Value::Integer(i)) => Ok(J::from(*i)),
        (FieldType::Number, toml::Value::Float(f)) if f.is_finite() => Ok(J::from(*f)),
        (FieldType::StringList, toml::Value::Array(items)) => {
            if items.len() > MAX_LIST {
                return Err(format!("field {key:?} has more than {MAX_LIST} items"));
            }
            items
                .iter()
                .map(|item| match item {
                    toml::Value::String(s) => text(key, s).map(J::from),
                    _ => Err(wrong("a list of strings")),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(J::Array)
        }
        (FieldType::String, _) => Err(wrong("a string")),
        (FieldType::Boolean, _) => Err(wrong("true or false")),
        (FieldType::Integer, _) => Err(wrong("an integer")),
        (FieldType::Number, _) => Err(wrong("a number")),
        (FieldType::StringList, _) => Err(wrong("a list of strings")),
    }
}

fn text(key: &str, s: &str) -> Result<String, String> {
    if s.len() > MAX_TEXT {
        return Err(format!("field {key:?} is longer than {} KiB", MAX_TEXT >> 10));
    }
    Ok(s.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(src: &str) -> PointDecl {
        toml::from_str(src).unwrap()
    }

    const COMPLETIONS: &str = r#"
        id = "acme.base.completions"
        description = "Extra completions"
        required = ["label"]
        fields = { label = "string", detail = "string", weight = "integer", scopes = "string-list" }
    "#;

    #[test]
    fn the_id_is_namespaced_by_the_declaring_plugin() {
        assert!(decl(COMPLETIONS).validate("acme.base").is_ok());
        let err = decl(COMPLETIONS).validate("acme.other").unwrap_err();
        assert!(err.contains("acme.other.<name>"), "{err}");
        assert!(decl("id = \"acme.base.\"").validate("acme.base").is_err());
        assert!(decl("id = \"acme.base.Bad Name\"").validate("acme.base").is_err());
    }

    #[test]
    fn required_fields_must_be_declared() {
        let err = decl("id = \"p.x\"\nrequired = [\"a\"]").validate("p").unwrap_err();
        assert!(err.contains("required field \"a\""), "{err}");
    }

    #[test]
    fn checks_a_contribution_and_converts_it_to_json() {
        let point = decl(COMPLETIONS);
        let contribution: toml::Value =
            toml::from_str("label = \"ew.x\"\nweight = 3\nscopes = [\"xml\", \"java\"]").unwrap();
        let json = point.check(&contribution).unwrap();
        assert_eq!(json, serde_json::json!({"label": "ew.x", "weight": 3, "scopes": ["xml", "java"]}));
    }

    #[test]
    fn refuses_what_the_point_does_not_declare() {
        let point = decl(COMPLETIONS);
        let check = |src: &str| point.check(&toml::from_str::<toml::Value>(src).unwrap()).unwrap_err();
        assert!(check("detail = \"x\"").contains("missing required field \"label\""));
        let err = check("label = \"a\"\nextra = 1");
        assert!(err.contains("unknown field \"extra\"") && err.contains("label"), "{err}");
        assert!(check("label = 1").contains("must be a string"));
        assert!(check("label = \"a\"\nweight = \"3\"").contains("must be an integer"));
        assert!(check("label = \"a\"\nscopes = [1]").contains("list of strings"));
    }

    #[test]
    fn numbers_take_integers_and_floats() {
        let point = decl("id = \"p.x\"\nfields = { ratio = \"number\" }");
        assert!(point.check(&toml::from_str::<toml::Value>("ratio = 2").unwrap()).is_ok());
        assert!(point.check(&toml::from_str::<toml::Value>("ratio = 0.5").unwrap()).is_ok());
    }
}
