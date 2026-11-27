//! Named JSON snippets, retained as read-only UI declarations.
use ide_extension::{Package, UiDecl, decode};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    language: String,
    path: std::path::PathBuf,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Lines {
    One(String),
    Many(Vec<String>),
}
impl Lines {
    fn values(self) -> Vec<String> {
        match self {
            Self::One(s) => vec![s],
            Self::Many(v) => v,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snippet {
    prefix: Lines,
    body: Lines,
    description: Option<String>,
}

pub(super) fn declaration(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    pkg.manifest.needs_api("contributes.snippets", 4)?;
    let d: Decl = decode("snippets", decl)?;
    if d.language.is_empty()
        || d.language.len() > 64
        || !d.language.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+#".contains(c))
    {
        return Err("snippets: invalid language id".into());
    }
    let text = pkg.read_text(&d.path)?;
    if text.len() > 1024 * 1024 {
        return Err("snippets: file exceeds 1 MiB".into());
    }
    let snippets: std::collections::BTreeMap<String, Snippet> =
        serde_json::from_str(&text).map_err(|e| format!("snippets: {e}"))?;
    if snippets.len() > 1000 {
        return Err("snippets: at most 1000 entries per file".into());
    }
    let mut entries = vec![];
    for (name, s) in snippets {
        let prefixes = s.prefix.values();
        let body = s.body.values().join("\n");
        if name.is_empty()
            || name.len() > 256
            || prefixes.is_empty()
            || prefixes.len() > 32
            || prefixes.iter().any(|p| p.is_empty() || p.len() > 256)
            || body.len() > 65536
            || s.description.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err(format!("snippets: invalid entry {name:?}"));
        }
        entries.push(serde_json::json!({"name":name,"prefixes":prefixes,"body":body,"description":s.description.unwrap_or_default()}));
    }
    let key = d.path.to_string_lossy().into_owned();
    let mut out = UiDecl::new(
        key.clone(),
        d.language.clone(),
        serde_json::json!({"source":key,"language":d.language,"entries":entries}),
    );
    out.files.push(d.path);
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_every_snippet_at_install_and_requires_api4() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = |api| {
            ide_extension::Manifest::parse(&format!(
                "id='test'\nname='Test'\nversion='1.0.0'\nengines.openidea='{api}'"
            ))
            .unwrap()
        };
        let decl: toml::Value = toml::from_str("language='sql'\npath='snippets.json'").unwrap();
        std::fs::write(
            dir.path().join("snippets.json"),
            r#"{"Select":{"prefix":["sel","select"],"body":["SELECT ${1:column}","FROM $1$0"],"description":"Query"}}"#,
        )
        .unwrap();
        let pkg = Package::new(manifest("^1.4"), dir.path().into());
        let out = declaration(&pkg, decl.clone()).unwrap();
        assert_eq!(out.json["entries"][0]["body"], "SELECT ${1:column}\nFROM $1$0");
        assert!(declaration(&Package::new(manifest("^1.3"), dir.path().into()), decl.clone()).is_err());
        for text in [
            r#"{"x":{"prefix":[],"body":"x"}}"#,
            r#"{"x":{"prefix":"x","body":42}}"#,
            r#"{"x":{"prefix":"x","body":"x","extra":1}}"#,
        ] {
            std::fs::write(dir.path().join("snippets.json"), text).unwrap();
            assert!(declaration(&pkg, decl.clone()).is_err());
        }
    }
}
