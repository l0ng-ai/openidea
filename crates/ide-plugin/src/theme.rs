//! Theme contributions: design-token overrides applied as CSS variables on `:root`.
//! Theme and editor-scheme files are JSON that may contain `//` and `/* */` comments.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

const MAX_TOKENS: usize = 512;
const MAX_VALUE_LEN: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeKind {
    Dark,
    Light,
}

/// `{"id", "name", "kind", "tokens": {"--bg-app": "#002b36", ...}}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDef {
    pub id: String,
    pub name: String,
    pub kind: ThemeKind,
    pub tokens: BTreeMap<String, String>,
}

/// `{"name"?, "tokens": {...}}`: an editor colour scheme merged over a theme.
#[derive(Deserialize)]
struct EditorScheme {
    tokens: BTreeMap<String, String>,
}

impl ThemeDef {
    pub fn parse(src: &str) -> Result<Self, String> {
        let theme: Self =
            serde_json::from_str(&strip_json_comments(src)).map_err(|e| format!("invalid theme JSON: {e}"))?;
        theme.validate()?;
        Ok(theme)
    }

    /// Merges an editor colour scheme file over the theme's tokens (the scheme wins).
    pub fn merge_editor_scheme(&mut self, src: &str) -> Result<(), String> {
        let scheme: EditorScheme =
            serde_json::from_str(&strip_json_comments(src)).map_err(|e| format!("invalid editor scheme JSON: {e}"))?;
        self.tokens.extend(scheme.tokens);
        self.validate()
    }

    pub fn validate(&self) -> Result<(), String> {
        crate::manifest::validate_command_id(&self.id).map_err(|e| e.replace("command id", "theme id"))?;
        if self.name.trim().is_empty() {
            return Err("theme name must not be empty".into());
        }
        if self.tokens.len() > MAX_TOKENS {
            return Err(format!("too many tokens (max {MAX_TOKENS})"));
        }
        for (name, value) in &self.tokens {
            let valid_name = name.len() > 2
                && name.len() <= 64
                && name.starts_with("--")
                && name[2..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !valid_name {
                return Err(format!("invalid token name {name:?}: expected a CSS variable like --bg-app"));
            }
            if !is_safe_value(value) {
                return Err(format!("token {name}: unsupported value {value:?}"));
            }
        }
        Ok(())
    }
}

/// Blanks out `//` and `/* */` comments outside strings, keeping newlines so
/// parse errors still point at the right line.
fn strip_json_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let (mut in_str, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('/', Some('/')) => {
                if chars.by_ref().any(|c| c == '\n') {
                    out.push('\n');
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                    }
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
                out.push(' ');
            }
            _ => {
                in_str = c == '"';
                out.push(c);
            }
        }
    }
    out
}

/// Values are plain CSS values (colours, lengths, font stacks). Anything that
/// could break out of the declaration or fetch resources is rejected.
fn is_safe_value(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    !v.trim().is_empty()
        && v.len() <= MAX_VALUE_LEN
        && !v.chars().any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r'))
        && !lower.contains("url(")
        && !lower.contains("image(")
        && !lower.contains("@import")
        && !lower.contains("expression(")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates() {
        let t = ThemeDef::parse(r##"{"id":"sol","name":"Sol","kind":"dark","tokens":{"--bg-app":"#002b36","--font-ui":"'Inter', sans-serif"}}"##)
            .unwrap();
        assert_eq!(t.kind, ThemeKind::Dark);
        assert_eq!(t.tokens["--bg-app"], "#002b36");
    }

    #[test]
    fn rejects_unsafe_tokens() {
        let mk = |k: &str, v: &str| {
            ThemeDef { id: "t".into(), name: "T".into(), kind: ThemeKind::Light, tokens: [(k.into(), v.into())].into() }
                .validate()
        };
        assert!(mk("--bg", "red").is_ok());
        assert!(mk("bg", "red").is_err());
        assert!(mk("--Bg", "red").is_err());
        assert!(mk("--bg", "red; color: blue").is_err());
        assert!(mk("--bg", "url(https://evil)").is_err());
        assert!(mk("--bg", "}body{").is_err());
        assert!(mk("--bg", " ").is_err());
        assert!(ThemeDef::parse("{\"id\":\"x\"}").is_err());
    }

    #[test]
    fn allows_comments_outside_strings() {
        let src = r##"{
            // line comment
            "id": "c", "name": "C // not a comment", "kind": "dark",
            /* block
               comment */
            "tokens": { "--bg-app": "#000" /* inline */, "--font-ui": "\"a/*b\", sans-serif" }
        }"##;
        let t = ThemeDef::parse(src).unwrap();
        assert_eq!(t.name, "C // not a comment");
        assert_eq!(t.tokens["--font-ui"], "\"a/*b\", sans-serif");
        assert!(ThemeDef::parse("{\n  // x\n  \"id\": 1\n}").unwrap_err().contains("line 3"));
    }

    #[test]
    fn merges_editor_scheme_over_theme() {
        let mut t = ThemeDef::parse(
            r##"{"id":"m","name":"M","kind":"dark","tokens":{"--bg-app":"#111","--syn-keyword":"#222"}}"##,
        )
        .unwrap();
        t.merge_editor_scheme(r##"{"name":"M", /* editor */ "tokens":{"--syn-keyword":"#333","--caret":"#fff"}}"##)
            .unwrap();
        assert_eq!(t.tokens["--bg-app"], "#111");
        assert_eq!(t.tokens["--syn-keyword"], "#333");
        assert_eq!(t.tokens["--caret"], "#fff");
        assert!(t.clone().merge_editor_scheme(r#"{"tokens":{"--caret":"url(x)"}}"#).is_err());
        assert!(t.merge_editor_scheme(r#"{"name":"no tokens"}"#).is_err());
    }
}
