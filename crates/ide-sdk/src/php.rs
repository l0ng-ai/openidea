//! The PHP language level: the one chosen in Settings › PHP, else the one the root
//! `composer.json` declares (`config.platform.php`, else the lowest version `require.php` allows);
//! the Intelephense storage that goes with it; and the stub sets and include paths Intelephense indexes.
//!
//! The native engine (the default, `ide-php`) reads the level, stub sets and include paths
//! too. The Intelephense settings ([`configure_intelephense_storage`], [`intelephense_stubs`])
//! serve the fallback: Intelephense runs only when Settings › PHP › Engine selects it.

use crate::apply::{merge, merge_init_options, setting_path};
use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
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

/// Gives each PHP version its own Intelephense workspace storage (below `data_dir`).
/// Intelephense keeps the built-in functions of the version a workspace was first indexed
/// with in that storage, and reuses them after the version changes. Without a version, or
/// with a `storagePath` of the user's, the server keeps its own storage.
pub fn configure_intelephense_storage(cfg: &mut LanguageServerConfig, data_dir: &Path) {
    if cfg.name != "intelephense" {
        return;
    }
    let mut options =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or(Value::Null);
    if options.get("storagePath").is_some() {
        return;
    }
    // The version Intelephense reads: `workspace/configuration` is answered from the
    // settings merged over the initialization options (`ide_lsp::handler::all_settings`).
    if let Some(settings) = &cfg.settings {
        merge(&mut options, settings.clone());
    }
    let section = options.pointer("/settings/intelephense").unwrap_or(&options);
    let version = section.pointer("/environment/phpVersion").and_then(Value::as_str);
    let Some(version) = version.filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.')) else {
        return;
    };
    let storage = data_dir.join("lsp").join("intelephense").join(version);
    merge_init_options(cfg, json!({ "storagePath": storage.to_string_lossy() }));
}

/// The stub sets Intelephense loads when `stubs` is not set (Intelephense 1.18.5). Setting
/// `stubs` replaces them, so additions are sent together with these.
#[rustfmt::skip]
const DEFAULT_STUBS: &[&str] = &[
    "apache", "bcmath", "bz2", "calendar", "com_dotnet", "Core", "ctype", "curl", "date", "dba", "dom", "enchant",
    "exif", "fileinfo", "filter", "fpm", "ftp", "gd", "hash", "iconv", "imap", "intl", "json", "ldap", "libxml",
    "mbstring", "mcrypt", "mssql", "mysqli", "oci8", "odbc", "openssl", "pcntl", "pcre", "PDO", "pgsql", "Phar",
    "posix", "pspell", "random", "readline", "Reflection", "regex", "session", "shmop", "SimpleXML", "snmp", "soap",
    "sockets", "sodium", "SPL", "sqlite3", "standard", "superglobals", "sybase", "sysvmsg", "sysvsem", "sysvshm",
    "tidy", "tokenizer", "uri", "xml", "xmlreader", "xmlrpc", "xmlwriter", "Zend OPcache", "zip", "zlib",
];

/// Stub sets outside the defaults whose names are not lower case; the rest are the lower-case
/// extension name.
const MIXED_CASE_STUBS: &[&str] =
    &["Ev", "FFI", "LuaSandbox", "Parle", "SQLite", "SaxonC", "SplType", "ZendCache", "ZendDebugger", "ZendUtils"];

/// The stub sets enabled when nothing else is configured: the extensions bundled with PHP
/// itself and the common ones. They are folder names of
/// [phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs), as Intelephense's are.
pub fn default_stub_sets() -> &'static [&'static str] {
    DEFAULT_STUBS
}

/// `Zend OPcache`, `zend-opcache` and `zend_opcache` name the same stubs.
pub fn stub_key(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// The `stubs` Intelephense loads: its defaults plus a stub set for each `ext-*` that the root
/// `composer.json` requires (`require`, `require-dev`) and those in Settings › PHP. `None` when
/// that adds nothing to the defaults, so the server keeps its own.
pub fn intelephense_stubs(root: &Path, s: &Settings) -> Option<Vec<String>> {
    let stubs = stub_sets(root, s);
    (stubs.len() > DEFAULT_STUBS.len()).then_some(stubs)
}

/// The stub sets a project uses, for Intelephense and the native engine alike: the
/// [defaults](default_stub_sets), then a set for each `ext-*` that the root `composer.json`
/// requires (`require`, `require-dev`), then those in Settings › PHP, without duplicates
/// (compared by [`stub_key`]).
pub fn stub_sets(root: &Path, s: &Settings) -> Vec<String> {
    let composer: Option<Value> =
        std::fs::read_to_string(root.join("composer.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    let extensions = ["require", "require-dev"]
        .into_iter()
        .filter_map(|section| composer.as_ref()?.get(section)?.as_object())
        .flat_map(|deps| deps.keys())
        .filter_map(|dep| dep.strip_prefix("ext-"))
        .map(|ext| {
            let key = stub_key(ext);
            MIXED_CASE_STUBS
                .iter()
                .find(|stub| stub_key(stub) == key)
                .map_or(ext.to_ascii_lowercase(), |s| s.to_string())
        });
    let configured = s.languages.php.stubs.iter().map(|stub| stub.trim().to_owned());
    let mut stubs: Vec<String> = DEFAULT_STUBS.iter().map(|s| s.to_string()).collect();
    let mut known: std::collections::HashSet<String> = stubs.iter().map(|s| stub_key(s)).collect();
    for stub in extensions.chain(configured) {
        if !stub.is_empty() && known.insert(stub_key(&stub)) {
            stubs.push(stub);
        }
    }
    stubs
}

/// The folders in Settings › PHP › Include paths, resolved against the project.
pub fn include_paths(root: &Path, s: &Settings) -> Vec<String> {
    s.languages
        .php
        .include_paths
        .iter()
        .filter_map(|p| setting_path(root, p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
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
    fn each_php_version_gets_its_own_intelephense_storage() {
        let data = Path::new("/data");
        let server = |name: &str, options: Value| {
            let mut cfg: LanguageServerConfig =
                toml::from_str(&format!("name = \"{name}\"\ncommand = \"{name}\"")).unwrap();
            if !options.is_null() {
                merge_init_options(&mut cfg, options);
            }
            cfg
        };
        let options = |cfg: &LanguageServerConfig| serde_json::to_value(&cfg.initialization_options).unwrap();

        let mut cfg = server("intelephense", json!({"environment": {"phpVersion": "7.4.0"}, "clearCache": false}));
        configure_intelephense_storage(&mut cfg, data);
        let storage = data.join("lsp").join("intelephense").join("7.4.0");
        assert_eq!(
            options(&cfg),
            json!({"environment": {"phpVersion": "7.4.0"}, "clearCache": false, "storagePath": storage.to_string_lossy()})
        );

        // The version Intelephense reads wins: Settings > Language Servers `settings` over the options.
        let storage_of = |init: Value, settings: Value| {
            let mut cfg = server("intelephense", init);
            cfg.settings = Some(settings);
            configure_intelephense_storage(&mut cfg, data);
            options(&cfg)["storagePath"].clone()
        };
        let path = |v: &str| json!(data.join("lsp").join("intelephense").join(v).to_string_lossy());
        let init = json!({"environment": {"phpVersion": "7.4.0"}});
        assert_eq!(storage_of(init.clone(), json!({"environment": {"phpVersion": "8.3.0"}})), path("8.3.0"));
        assert_eq!(storage_of(init, json!({"other": 1})), path("7.4.0"));
        let nested = json!({"settings": {"intelephense": {"environment": {"phpVersion": "8.0.0"}}}});
        assert_eq!(storage_of(Value::Null, nested), path("8.0.0"));

        // No version, the user's own storage, not a version, another server: unchanged.
        for unchanged in [
            server("intelephense", Value::Null),
            server("intelephense", json!({"environment": {"includePaths": []}})),
            server("intelephense", json!({"environment": {"phpVersion": "8.1.0"}, "storagePath": "/mine"})),
            server("intelephense", json!({"environment": {"phpVersion": "../8.1"}})),
            server("phpactor", json!({"environment": {"phpVersion": "8.1.0"}})),
        ] {
            let mut cfg = unchanged.clone();
            configure_intelephense_storage(&mut cfg, data);
            assert_eq!(cfg, unchanged);
        }
    }

    fn stubs(composer: Option<Value>, configured: &[&str]) -> Option<Vec<String>> {
        let tmp = tempfile::tempdir().unwrap();
        if let Some(composer) = composer {
            std::fs::write(tmp.path().join("composer.json"), composer.to_string()).unwrap();
        }
        let mut s = Settings::default();
        s.languages.php.stubs = configured.iter().map(|s| s.to_string()).collect();
        intelephense_stubs(tmp.path(), &s)
    }

    fn added(stubs: Option<Vec<String>>) -> Vec<String> {
        let stubs = stubs.expect("stubs");
        assert_eq!(stubs[..DEFAULT_STUBS.len()], DEFAULT_STUBS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        stubs[DEFAULT_STUBS.len()..].to_vec()
    }

    #[test]
    fn required_extensions_and_configured_stubs_follow_the_defaults() {
        let composer = json!({
            "require": {"php": "^8.1", "ext-redis": "*", "ext-json": "*", "monolog/monolog": "^3"},
            "require-dev": {"ext-Imagick": "*", "ext-ffi": "*", "ext-redis": "*"}
        });
        assert_eq!(
            added(stubs(Some(composer), &[" wordpress ", "Redis", ""])),
            ["redis", "imagick", "FFI", "wordpress"]
        );
        assert_eq!(added(stubs(None, &["wordpress"])), ["wordpress"]);
    }

    #[test]
    fn nothing_beyond_the_defaults_sends_nothing() {
        assert_eq!(stubs(None, &[]), None);
        assert_eq!(stubs(Some(json!({"require": {"php": "^8.1"}})), &[]), None);
        // Default stub sets under their extension names: `ext-pdo`, `ext-zend-opcache`, `ext-simplexml`.
        let defaults =
            json!({"require": {"ext-pdo": "*", "ext-zend-opcache": "*", "ext-simplexml": "*", "ext-json": "*"}});
        assert_eq!(stubs(Some(defaults), &["SPL", "core"]), None);
        assert_eq!(stubs(Some(json!("not an object")), &[]), None);
    }

    #[test]
    fn stub_sets_always_start_with_the_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        assert_eq!(stub_sets(tmp.path(), &s), DEFAULT_STUBS);
        std::fs::write(tmp.path().join("composer.json"), r#"{"require": {"ext-redis": "*"}}"#).unwrap();
        s.languages.php.stubs = vec!["Zend_OPcache".into(), "wordpress".into()];
        let sets = stub_sets(tmp.path(), &s);
        assert_eq!(sets[..DEFAULT_STUBS.len()], *DEFAULT_STUBS);
        assert_eq!(sets[DEFAULT_STUBS.len()..], ["redis", "wordpress"]);
        assert_eq!(stub_key("Zend OPcache"), stub_key("zend-opcache"));
    }

    #[test]
    fn include_paths_resolve_against_the_project() {
        let root = Path::new("/work/module");
        let mut s = Settings::default();
        s.languages.php.include_paths = vec!["../platform".into(), "/opt/prestashop".into(), " ".into()];
        assert_eq!(
            include_paths(root, &s),
            [root.join("../platform").to_string_lossy().into_owned(), "/opt/prestashop".to_string()]
        );
    }

    #[test]
    fn explicit_level_wins() {
        let composer = r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "7.4.33"}}}"#;
        assert_eq!(level(Some(composer), "8.1").as_deref(), Some("8.1.0"));
        assert_eq!(level(None, " 5.6 ").as_deref(), Some("5.6.0"));
    }
}
