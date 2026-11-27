//! `package.json` dependency versions and npm registry metadata.
use super::ManifestDependency;

/// Top-level objects whose string values are version ranges.
const SECTIONS: [&str; 4] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/// npm package names: lowercase, optionally scoped (`@scope/name`).
fn package_name(name: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && !p.starts_with(['.', '_'])
            && p.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-._~".contains(&c))
    };
    name.len() <= 214
        && match name.strip_prefix('@') {
            Some(scoped) => scoped.split_once('/').is_some_and(|(scope, rest)| part(scope) && part(rest)),
            None => part(name),
        }
}

enum Frame {
    /// `key`: the last key read; `value`: a `:` followed it.
    Object {
        key: Option<String>,
        value: bool,
    },
    Array,
}

/// The version string at a UTF-16 `offset` in a dependency section, also in a document
/// being edited (an unclosed string ends at the line end). Aliases (`npm:`), paths, URLs
/// and workspace protocols are not versions.
pub fn dependency_at(text: &str, offset: u32) -> Option<ManifestDependency> {
    // Each container with the key it is the value of.
    let mut stack: Vec<(Frame, Option<String>)> = Vec::new();
    let mut pos = 0u32;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let here = pos;
        pos += c.len_utf16() as u32;
        match c {
            '{' | '[' => {
                let key = match stack.last_mut() {
                    Some((Frame::Object { key, value }, _)) if *value => {
                        *value = false;
                        key.take()
                    }
                    _ => None,
                };
                let frame = if c == '{' { Frame::Object { key: None, value: false } } else { Frame::Array };
                stack.push((frame, key));
            }
            '}' | ']' => {
                stack.pop();
            }
            ':' => {
                if let Some((Frame::Object { value, .. }, _)) = stack.last_mut() {
                    *value = true;
                }
            }
            ',' => {
                if let Some((Frame::Object { key, value }, _)) = stack.last_mut() {
                    (*key, *value) = (None, false);
                }
            }
            '"' => {
                let from = here + 1;
                let mut content = String::new();
                let mut to = from;
                while let Some(&n) = chars.peek() {
                    if n == '"' || n == '\n' || n == '\r' {
                        break;
                    }
                    chars.next();
                    pos += n.len_utf16() as u32;
                    if n == '\\'
                        && let Some(e) = chars.next()
                    {
                        pos += e.len_utf16() as u32;
                        content.push(e);
                    } else {
                        content.push(n);
                    }
                    to = pos;
                }
                if chars.peek() == Some(&'"') {
                    chars.next();
                    pos += 1;
                }
                let in_section =
                    stack.len() == 2 && matches!(&stack[1].1, Some(section) if SECTIONS.contains(&section.as_str()));
                match stack.last_mut() {
                    Some((Frame::Object { key, value }, _)) if *value => {
                        if in_section
                            && from <= offset
                            && offset <= to
                            && let Some(package) = key.as_deref().filter(|k| package_name(k))
                            && !content.contains([':', '/'])
                        {
                            return Some(ManifestDependency {
                                package: package.to_owned(),
                                requirement: content,
                                from,
                                to,
                            });
                        }
                        *value = false;
                    }
                    Some((Frame::Object { key, .. }, _)) => *key = Some(content),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    None
}

/// Registry URL path of a package (`@scope/name` → `@scope%2fname`).
pub fn registry_path(package: &str) -> Option<String> {
    package_name(package).then(|| package.replacen('/', "%2f", 1))
}

/// Versions in a registry document (full or abbreviated metadata), newest first: deprecated
/// versions left out, and pre-releases only when the package has no release.
pub fn registry_versions(text: &str) -> Option<Vec<String>> {
    let doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut versions: Vec<semver::Version> = doc
        .get("versions")?
        .as_object()?
        .iter()
        .filter(|(_, meta)| meta.get("deprecated").is_none_or(|d| d.is_null() || d == false))
        .filter_map(|(v, _)| semver::Version::parse(v).ok())
        .collect();
    if versions.iter().any(|v| v.pre.is_empty()) {
        versions.retain(|v| v.pre.is_empty());
    }
    versions.sort_unstable_by(|a, b| b.cmp(a));
    Some(versions.iter().map(ToString::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Option<ManifestDependency> {
        let offset = text.split_once('|').unwrap().0.encode_utf16().count() as u32;
        dependency_at(&text.replace('|', ""), offset)
    }

    #[test]
    fn finds_versions_in_dependency_sections_only() {
        let doc = r#"{
  "name": "app 中文 😀",
  "version": "1.0.|0",
  "dependencies": { "react": "^18.|2.0", "@types/node": "~2|0" },
  "devDependencies": {
    "vite": "|"
  },
  "scripts": { "dev": "vi|te" },
  "overrides": { "foo": { "bar": "1.|0" } }
}"#;
        let found: Vec<_> = (0..doc.matches('|').count())
            .map(|i| {
                let mut text = String::new();
                for (j, part) in doc.split('|').enumerate() {
                    text.push_str(part);
                    if j == i {
                        text.push('|');
                    }
                }
                at(&text).map(|d| (d.package, d.requirement))
            })
            .collect();
        assert_eq!(
            found,
            [
                None,
                Some(("react".into(), "^18.2.0".into())),
                Some(("@types/node".into(), "~20".into())),
                Some(("vite".into(), "".into())),
                None,
                None,
            ]
        );
    }

    #[test]
    fn utf16_range_covers_the_string_contents_also_while_typing() {
        for (text, contents) in [
            ("{\"x\": \"😀\", \"dependencies\": {\"lodash\": \"^4.|17\"}}", "^4.17"),
            ("{\"dependencies\": {\n  \"lodash\": \"^4.|\n}}", "^4."),
        ] {
            let item = at(text).unwrap();
            let units: Vec<u16> = text.replace('|', "").encode_utf16().collect();
            assert_eq!(String::from_utf16(&units[item.from as usize..item.to as usize]).unwrap(), contents);
        }
    }

    #[test]
    fn skips_keys_names_and_protocols() {
        for text in [
            r#"{"dependencies": {"rea|ct": "^18"}}"#,
            r#"{"dependencies": {"a": "npm:b@^|1"}}"#,
            r#"{"dependencies": {"a": "file:../|a"}}"#,
            r#"{"dependencies": {"a": "workspace:|*"}}"#,
            r#"{"dependencies": {"a": "github:x/|y"}}"#,
            r#"{"dependencies": {"Bad Name": "|1"}}"#,
            r#"{"dependencies": ["|1"]}"#,
        ] {
            assert!(at(text).is_none(), "{text}");
        }
    }

    #[test]
    fn registry_versions_are_newest_first_without_deprecated_or_needless_prereleases() {
        let doc = r#"{"name":"x","versions":{
            "1.9.0":{}, "1.10.0":{}, "2.0.0-rc.1":{}, "0.1.0":{"deprecated":"old"}, "not-semver":{}
        }}"#;
        assert_eq!(registry_versions(doc).unwrap(), ["1.10.0", "1.9.0"]);
        let only_pre = r#"{"versions":{"0.0.1-a":{},"0.0.1-b":{}}}"#;
        assert_eq!(registry_versions(only_pre).unwrap(), ["0.0.1-b", "0.0.1-a"]);
        assert!(registry_versions("{}").is_none());
        assert_eq!(registry_path("@types/node").as_deref(), Some("@types%2fnode"));
        assert_eq!(registry_path("../etc"), None);
    }
}
