//! Editor › Code Style › JavaScript / TypeScript (Spaces, Punctuation, Imports) as the TypeScript
//! servers' `typescript.format.*` / `typescript.preferences.*` settings (`javascript.*` for
//! JavaScript and JSX). tsserver applies them to Reformat Code and to the code it writes:
//! quick fixes, auto-imports, refactorings and organize imports.

use ide_core::editor_settings::LanguageCodeStyle;
use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use ide_workspace::EditorConfig;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;

const SERVERS: [&str; 2] = ["vtsls", "typescript-language-server"];

/// tsserver's space options the Spaces tab sets, with the IntelliJ `.editorconfig` property
/// (`ij_<language>_<name>`) that sets the same thing.
const SPACES: [(&str, Option<&str>); 14] = [
    ("insertSpaceAfterCommaDelimiter", Some("space_after_comma")),
    ("insertSpaceAfterSemicolonInForStatements", Some("space_after_semicolon")),
    ("insertSpaceBeforeAndAfterBinaryOperators", None),
    ("insertSpaceAfterKeywordsInControlFlowStatements", None),
    ("insertSpaceAfterFunctionKeywordForAnonymousFunctions", Some("space_before_function_left_parenth")),
    ("insertSpaceBeforeFunctionParenthesis", Some("space_before_method_parentheses")),
    ("insertSpaceAfterConstructor", None),
    ("insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis", None),
    ("insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets", Some("spaces_within_brackets")),
    ("insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces", Some("spaces_within_object_literal_braces")),
    ("insertSpaceAfterOpeningAndBeforeClosingEmptyBraces", None),
    ("insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces", Some("spaces_within_interpolation_expressions")),
    ("insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces", None),
    ("insertSpaceAfterTypeAssertion", None),
];

/// Adds the code style of JavaScript and TypeScript to a TypeScript server's settings. A file's
/// `.editorconfig` comes first, as in the editor (resolved for the server root's `index.ts` /
/// `index.js`: the servers take one configuration per project); the server's own settings win.
pub fn configure(cfg: &mut LanguageServerConfig, server_root: &Path, settings: &Settings) {
    if !SERVERS.contains(&cfg.name.as_str()) {
        return;
    }
    let code_style = &settings.editor.code_style;
    let editorconfig = code_style.editorconfig.then(EditorConfig::new);
    let mut layer = Map::new();
    for (language, ext) in [("typescript", "ts"), ("javascript", "js")] {
        let pairs = editorconfig
            .as_ref()
            .and_then(|e| e.resolve_pairs(&server_root.join(format!("index.{ext}"))))
            .unwrap_or_default();
        let section = section(language, code_style.languages.get(language), &pairs);
        layer.insert(language.into(), Value::Object(section));
    }
    let mut merged = Value::Object(layer);
    if let Some(own) = cfg.settings.take() {
        ide_sdk::apply::merge(&mut merged, own);
    }
    cfg.settings = Some(merged);
}

/// The `format` and `preferences` of one language's section.
fn section(
    language: &str,
    style: Option<&LanguageCodeStyle>,
    editorconfig: &HashMap<String, String>,
) -> Map<String, Value> {
    let get = |key: &str| editorconfig.get(key).map(|v| v.to_ascii_lowercase());
    let flag = |name: &str| match get(&format!("ij_{language}_{name}")).as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let pick = |value: Option<&String>, allowed: &[&str]| value.filter(|v| allowed.contains(&v.as_str())).cloned();

    let mut format = Map::new();
    for (key, ij) in SPACES {
        if let Some(on) = ij.and_then(flag).or_else(|| style.and_then(|s| s.spaces.get(key).copied())) {
            format.insert(key.into(), json!(on));
        }
    }
    let semicolons = flag("use_semicolon_after_statement")
        .map(|on| if on { "insert" } else { "remove" }.to_owned())
        .or_else(|| pick(style.and_then(|s| s.semicolons.as_ref()), &["ignore", "insert", "remove"]));
    if let Some(semicolons) = semicolons {
        format.insert("semicolons".into(), json!(semicolons));
    }
    let quotes = pick(get("quote_type").as_ref(), &["auto", "single", "double"])
        .or_else(|| flag("use_double_quotes").map(|on| if on { "double" } else { "single" }.to_owned()))
        .or_else(|| pick(style.and_then(|s| s.quotes.as_ref()), &["auto", "single", "double"]));

    let mut section = Map::new();
    if !format.is_empty() {
        section.insert("format".into(), Value::Object(format));
    }
    // vtsls reads VS Code's names (`quoteStyle`, `importModuleSpecifier`), typescript-language-server
    // tsserver's (`quotePreference`, `importModuleSpecifierPreference`).
    let mut preferences = Map::new();
    if let Some(quotes) = quotes {
        preferences.insert("quoteStyle".into(), json!(quotes));
        preferences.insert("quotePreference".into(), json!(quotes));
    }
    let paths = ["shortest", "relative", "non-relative", "project-relative"];
    if let Some(paths) = pick(style.and_then(|s| s.import_module_specifier.as_ref()), &paths) {
        preferences.insert("importModuleSpecifier".into(), json!(paths));
        preferences.insert("importModuleSpecifierPreference".into(), json!(paths));
    }
    let endings = ["auto", "minimal", "index", "js"];
    if let Some(ending) = pick(style.and_then(|s| s.import_module_specifier_ending.as_ref()), &endings) {
        preferences.insert("importModuleSpecifierEnding".into(), json!(ending));
    }
    // Sent even when empty: vtsls has no default for these, so a list left out keeps tsserver's
    // previous one, and clearing it would only apply after a restart. `[]` excludes nothing.
    let none = Vec::new();
    let patterns = style.map_or(&none, |s| &s.auto_import_file_exclude_patterns);
    let regexes = style.map_or(&none, |s| &s.auto_import_specifier_exclude_regexes);
    preferences.insert("autoImportFileExcludePatterns".into(), json!(patterns));
    preferences.insert("autoImportSpecifierExcludeRegexes".into(), json!(regexes));
    section.insert("preferences".into(), Value::Object(preferences));
    section
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str) -> LanguageServerConfig {
        serde_json::from_value(json!({ "name": name, "command": name })).unwrap()
    }

    #[test]
    fn code_style_reaches_typescript_and_javascript_sections() {
        let mut settings = Settings::default();
        let ts = LanguageCodeStyle {
            semicolons: Some("remove".into()),
            quotes: Some("single".into()),
            spaces: [("insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces".into(), false)].into(),
            ..Default::default()
        };
        settings.editor.code_style.languages.insert("typescript".into(), ts);
        let js = LanguageCodeStyle { semicolons: Some("insert".into()), ..Default::default() };
        settings.editor.code_style.languages.insert("javascript".into(), js);
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = server("vtsls");
        cfg.settings = Some(json!({ "typescript": { "preferences": { "quoteStyle": "double" } } }));
        configure(&mut cfg, dir.path(), &settings);
        assert_eq!(
            cfg.settings.unwrap(),
            json!({
                "typescript": {
                    "format": { "semicolons": "remove", "insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces": false },
                    // The server's own settings win.
                    "preferences": {
                        "quoteStyle": "double",
                        "quotePreference": "single",
                        "autoImportFileExcludePatterns": [],
                        "autoImportSpecifierExcludeRegexes": [],
                    },
                },
                "javascript": {
                    "format": { "semicolons": "insert" },
                    "preferences": { "autoImportFileExcludePatterns": [], "autoImportSpecifierExcludeRegexes": [] },
                },
            })
        );

        let mut eslint = server("eslint");
        configure(&mut eslint, dir.path(), &settings);
        assert_eq!(eslint.settings, None);
        let mut untouched = server("vtsls");
        configure(&mut untouched, dir.path(), &Settings::default());
        // Nothing set: the server's defaults, and empty exclusion lists so that clearing one reaches
        // a running server.
        let empty = json!({ "autoImportFileExcludePatterns": [], "autoImportSpecifierExcludeRegexes": [] });
        let empty = json!({ "typescript": { "preferences": empty }, "javascript": { "preferences": empty } });
        assert_eq!(untouched.settings, Some(empty));
    }

    #[test]
    fn import_style_reaches_the_preferences_of_each_language() {
        let mut settings = Settings::default();
        let ts = LanguageCodeStyle {
            import_module_specifier: Some("relative".into()),
            import_module_specifier_ending: Some("index".into()),
            auto_import_file_exclude_patterns: vec!["**/index.ts".into()],
            auto_import_specifier_exclude_regexes: vec!["^node:".into()],
            ..Default::default()
        };
        settings.editor.code_style.languages.insert("typescript".into(), ts);
        let js = LanguageCodeStyle {
            import_module_specifier: Some("non-relative".into()),
            // Not a tsserver value: left out.
            import_module_specifier_ending: Some("ts".into()),
            ..Default::default()
        };
        settings.editor.code_style.languages.insert("javascript".into(), js);
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = server("vtsls");
        configure(&mut cfg, dir.path(), &settings);
        assert_eq!(
            cfg.settings.unwrap(),
            json!({
                "typescript": { "preferences": {
                    "importModuleSpecifier": "relative",
                    "importModuleSpecifierPreference": "relative",
                    "importModuleSpecifierEnding": "index",
                    "autoImportFileExcludePatterns": ["**/index.ts"],
                    "autoImportSpecifierExcludeRegexes": ["^node:"],
                } },
                "javascript": { "preferences": {
                    "importModuleSpecifier": "non-relative",
                    "importModuleSpecifierPreference": "non-relative",
                    "autoImportFileExcludePatterns": [],
                    "autoImportSpecifierExcludeRegexes": [],
                } },
            })
        );
    }

    #[test]
    fn editorconfig_comes_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*.ts]\nquote_type = double\nij_typescript_use_semicolon_after_statement = false\n\
             ij_typescript_space_after_comma = false\n[*.js]\nij_javascript_use_double_quotes = false\n",
        )
        .unwrap();
        let mut settings = Settings::default();
        let ts = LanguageCodeStyle {
            semicolons: Some("insert".into()),
            quotes: Some("single".into()),
            ..Default::default()
        };
        settings.editor.code_style.languages.insert("typescript".into(), ts);
        let mut cfg = server("typescript-language-server");
        configure(&mut cfg, dir.path(), &settings);
        let s = cfg.settings.unwrap();
        assert_eq!(
            s["typescript"]["format"],
            json!({ "semicolons": "remove", "insertSpaceAfterCommaDelimiter": false })
        );
        assert_eq!(s["typescript"]["preferences"]["quotePreference"], "double");
        assert_eq!(s["javascript"]["preferences"]["quoteStyle"], "single");

        settings.editor.code_style.editorconfig = false;
        let mut cfg = server("vtsls");
        configure(&mut cfg, dir.path(), &settings);
        let s = cfg.settings.unwrap();
        assert_eq!(s["typescript"]["format"], json!({ "semicolons": "insert" }));
        assert_eq!(s["javascript"].get("format"), None);
    }
}
