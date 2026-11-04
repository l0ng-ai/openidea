//! The PHP language level: the one chosen in Settings › PHP, else the one the root
//! `composer.json` declares (`config.platform.php`, else the lowest version `require.php` allows).

use ide_core::settings::Settings;
use serde_json::Value;
use std::path::Path;

/// The project's PHP version as `X.Y.Z`; `None` when neither the settings nor
/// `composer.json` name one.
pub fn language_level(root: &Path, s: &Settings) -> Option<String> {
    let explicit = s.languages.php.language_level.trim();
    if !explicit.is_empty() {
        return version(explicit).map(dotted);
    }
    let text = std::fs::read_to_string(root.join("composer.json")).ok()?;
    let composer: Value = serde_json::from_str(&text).ok()?;
    let platform = composer.pointer("/config/platform/php").and_then(Value::as_str).and_then(version);
    platform.or_else(|| lowest_allowed(composer.pointer("/require/php")?.as_str()?)).map(dotted)
}

type Version = (u32, u32, u32);

fn dotted((major, minor, patch): Version) -> String {
    format!("{major}.{minor}.{patch}")
}

/// `7`, `7.4`, `v7.4.3`, `8.1.*`, `7.4.0-dev`: missing parts are 0.
fn version(s: &str) -> Option<Version> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let mut parts = s.split('.').map(|p| {
        let digits: &str = &p[..p.find(|c: char| !c.is_ascii_digit()).unwrap_or(p.len())];
        digits.parse::<u32>().ok()
    });
    let major = parts.next()??;
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

/// The lowest version a Composer constraint allows: the lowest lower bound of its
/// `||` alternatives. `None` when an alternative has no lower bound (`*`, `<8.0`).
fn lowest_allowed(constraint: &str) -> Option<Version> {
    let bounds: Option<Vec<Version>> =
        constraint.split('|').filter(|alt| !alt.trim().is_empty()).map(lower_bound).collect();
    bounds?.into_iter().min()
}

/// The lower bound of constraints that must all hold (`>=7.2 <8.4`, `^7.4, !=7.4.1`,
/// `7.2 - 8.0`): the highest of their lower bounds.
fn lower_bound(alternative: &str) -> Option<Version> {
    // A hyphen range: its first version.
    let alternative = alternative.split(" - ").next().unwrap_or(alternative);
    let mut tokens: Vec<String> = Vec::new();
    for token in alternative.split([' ', ',']).filter(|t| !t.is_empty()) {
        // `>= 7.2`: the operator and its version.
        match tokens.last_mut() {
            Some(op) if op.chars().all(|c| "<>=!~^".contains(c)) => op.push_str(token),
            _ => tokens.push(token.to_owned()),
        }
    }
    tokens
        .iter()
        .filter_map(|t| {
            let t = t.split('@').next().unwrap_or(t);
            if t.starts_with('<') || t.starts_with("!=") {
                return None;
            }
            version(t.trim_start_matches(['>', '=', '^', '~']))
        })
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(composer: Option<&str>, explicit: &str) -> Option<String> {
        let tmp = tempfile::tempdir().unwrap();
        if let Some(composer) = composer {
            std::fs::write(tmp.path().join("composer.json"), composer).unwrap();
        }
        let mut s = Settings::default();
        s.languages.php.language_level = explicit.into();
        language_level(tmp.path(), &s)
    }

    fn required(constraint: &str) -> Option<String> {
        level(Some(&serde_json::json!({ "require": { "php": constraint } }).to_string()), "")
    }

    #[test]
    fn lowest_version_require_php_allows() {
        assert_eq!(required("^7.4 || ^8.0").as_deref(), Some("7.4.0"));
        assert_eq!(required("^8.0 || ^7.4").as_deref(), Some("7.4.0"));
        assert_eq!(required(">=7.2 <8.4").as_deref(), Some("7.2.0"));
        assert_eq!(required(">= 7.2, < 8.4").as_deref(), Some("7.2.0"));
        assert_eq!(required("8.1.*").as_deref(), Some("8.1.0"));
        assert_eq!(required("~7.4.3").as_deref(), Some("7.4.3"));
        assert_eq!(required("7.2 - 8.0").as_deref(), Some("7.2.0"));
        assert_eq!(required("^7.3|^8.0").as_deref(), Some("7.3.0"));
        assert_eq!(required(">=8.1@dev").as_deref(), Some("8.1.0"));
        assert_eq!(required("8").as_deref(), Some("8.0.0"));
    }

    #[test]
    fn no_lower_bound_gives_nothing() {
        for constraint in ["*", "<8.0", "", "^7.4 || *", "dev-main"] {
            assert_eq!(required(constraint), None, "{constraint}");
        }
    }

    #[test]
    fn platform_overrides_require() {
        let composer = r#"{"require": {"php": "^8.2"}, "config": {"platform": {"php": "7.2.34"}}}"#;
        assert_eq!(level(Some(composer), "").as_deref(), Some("7.2.34"));
    }

    #[test]
    fn no_requirement_gives_nothing() {
        assert_eq!(level(None, ""), None);
        assert_eq!(level(Some(r#"{"require": {"ext-json": "*"}}"#), ""), None);
        assert_eq!(level(Some("not json"), ""), None);
    }

    #[test]
    fn explicit_level_wins() {
        let composer = r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "7.4.33"}}}"#;
        assert_eq!(level(Some(composer), "8.1").as_deref(), Some("8.1.0"));
        assert_eq!(level(None, " 5.6 ").as_deref(), Some("5.6.0"));
    }
}
