//! The PHP language level: the one chosen in Settings › PHP, else the one the root
//! `composer.json` declares (`config.platform.php`, else the lowest version `require.php` allows);
//! the Intelephense storage that goes with it; the stub sets and include paths Intelephense indexes;
//! and the PHPStan run that checks saved files.

use crate::apply::{merge, merge_init_options, setting_path};
use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

/// A PHP version and where it comes from.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PhpLanguageLevel {
    /// `X.Y.Z`.
    pub version: String,
    pub source: PhpLevelSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PhpLevelSource {
    /// `languages.php.languageLevel`.
    Settings,
    /// `config.platform.php` of `composer.json`.
    Platform,
    /// The lowest version `require.php` of `composer.json` allows.
    Require,
}

/// The project's PHP version: the one chosen in the settings, else [`composer_level`];
/// `None` when neither names one.
pub fn language_level(root: &Path, s: &Settings) -> Option<PhpLanguageLevel> {
    let explicit = s.languages.php.language_level.trim();
    if !explicit.is_empty() {
        return version(explicit).map(|v| PhpLanguageLevel::new(v, PhpLevelSource::Settings));
    }
    composer_level(root)
}

/// The PHP version the root `composer.json` declares (the setting's Auto):
/// `config.platform.php`, else the lowest version `require.php` allows.
pub fn composer_level(root: &Path) -> Option<PhpLanguageLevel> {
    let text = std::fs::read_to_string(root.join("composer.json")).ok()?;
    let composer: Value = serde_json::from_str(&text).ok()?;
    if let Some(platform) = composer.pointer("/config/platform/php").and_then(Value::as_str).and_then(version) {
        return Some(PhpLanguageLevel::new(platform, PhpLevelSource::Platform));
    }
    lowest_allowed(composer.pointer("/require/php")?.as_str()?)
        .map(|v| PhpLanguageLevel::new(v, PhpLevelSource::Require))
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

/// `Zend OPcache`, `zend-opcache` and `zend_opcache` name the same stubs.
fn stub_key(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// The `stubs` Intelephense loads: its defaults plus a stub set for each `ext-*` that the root
/// `composer.json` requires (`require`, `require-dev`) and those in Settings › PHP. `None` when
/// that adds nothing to the defaults, so the server keeps its own.
pub fn intelephense_stubs(root: &Path, s: &Settings) -> Option<Vec<String>> {
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
    (stubs.len() > DEFAULT_STUBS.len()).then_some(stubs)
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

/// `vendor/bin/phpstan analyse` of `files` with a JSON report and the configuration file of
/// Settings › PHP, run from `root` with Xdebug off: in debug mode it would try to reach a
/// debugger on every run. The selected PHP runs the script itself (and is first on `PATH`, as for
/// PHPUnit), so a `php8.1` is not replaced by the `php` its `#!/usr/bin/env php` finds, and
/// Windows needs no `phpstan.bat`, whose `cmd` limits the command line. `None` when the project
/// has no PHPStan.
pub fn phpstan_command(root: &Path, s: &Settings, files: &[PathBuf]) -> Option<Command> {
    let bin = root.join("vendor/bin/phpstan");
    if !bin.is_file() {
        return None;
    }
    let php = setting_path(root, &s.languages.php.interpreter)
        .or_else(|| crate::exec::which("php"))
        .unwrap_or_else(|| PathBuf::from("php"));
    let mut cmd = Command::new(php);
    cmd.current_dir(root).arg(bin).args(["analyse", "--error-format=json", "--no-progress"]);
    if let Some(config) = setting_path(root, &s.languages.php.phpstan_config) {
        cmd.arg("--configuration").arg(config);
    }
    cmd.args(files);
    cmd.env("XDEBUG_MODE", "off");
    if let Some(dir) = crate::apply::php_dir(root, s) {
        cmd.env("PATH", crate::exec::path_with(&[&dir]));
    }
    Some(cmd)
}

type Version = (u32, u32, u32);

impl PhpLanguageLevel {
    fn new((major, minor, patch): Version, source: PhpLevelSource) -> Self {
        Self { version: format!("{major}.{minor}.{patch}"), source }
    }
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
        levels(composer, explicit).0.map(|l| l.version)
    }

    /// The effective level and the composer one.
    fn levels(composer: Option<&str>, explicit: &str) -> (Option<PhpLanguageLevel>, Option<PhpLanguageLevel>) {
        let tmp = tempfile::tempdir().unwrap();
        if let Some(composer) = composer {
            std::fs::write(tmp.path().join("composer.json"), composer).unwrap();
        }
        let mut s = Settings::default();
        s.languages.php.language_level = explicit.into();
        (language_level(tmp.path(), &s), composer_level(tmp.path()))
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
    fn include_paths_resolve_against_the_project() {
        let root = Path::new("/work/module");
        let mut s = Settings::default();
        s.languages.php.include_paths = vec!["../platform".into(), "/opt/prestashop".into(), " ".into()];
        assert_eq!(
            include_paths(root, &s),
            [root.join("../platform").to_string_lossy().into_owned(), "/opt/prestashop".to_string()]
        );
    }

    fn phpstan(root: &Path, s: &Settings) -> Option<Command> {
        let cmd = phpstan_command(root, s, &[root.join("src").join("A.php"), root.join("src").join("B.php")])?;
        assert_eq!(cmd.get_current_dir(), Some(root));
        Some(cmd)
    }

    fn text(s: &std::ffi::OsStr) -> String {
        s.to_string_lossy().into_owned()
    }

    fn env(cmd: &Command) -> Vec<(String, Option<String>)> {
        cmd.get_envs().map(|(k, v)| (text(k), v.map(text))).collect()
    }

    #[test]
    fn phpstan_checks_the_files_on_the_selected_php_without_xdebug() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut s = Settings::default();
        assert!(phpstan(root, &s).is_none(), "no vendor/bin/phpstan, no run");

        let bin = root.join("vendor/bin/phpstan");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "").unwrap();
        let cmd = phpstan(root, &s).unwrap();
        // The PHP on PATH unless one is selected.
        assert_eq!(Path::new(cmd.get_program()).file_stem(), Some("php".as_ref()));
        let file = |name: &str| root.join("src").join(name).to_string_lossy().into_owned();
        assert_eq!(
            cmd.get_args().map(text).collect::<Vec<_>>(),
            [
                &*bin.to_string_lossy(),
                "analyse",
                "--error-format=json",
                "--no-progress",
                &file("A.php"),
                &file("B.php")
            ]
        );
        assert_eq!(env(&cmd), [("XDEBUG_MODE".to_string(), Some("off".to_string()))]);

        // A selected PHP runs PHPStan whatever its name, and is first on PATH for what PHPStan starts.
        let php = root.join("php85/bin").join(crate::exe("php8.5"));
        s.languages.php.interpreter = php.to_string_lossy().into_owned();
        let cmd = phpstan(root, &s).unwrap();
        assert_eq!(cmd.get_program(), php.as_os_str());
        let env = env(&cmd);
        let path = env.iter().find(|(k, _)| k == "PATH").and_then(|(_, v)| v.clone()).expect("PATH");
        assert_eq!(std::env::split_paths(&path).next(), Some(root.join("php85/bin")));
        assert!(env.contains(&("XDEBUG_MODE".to_string(), Some("off".to_string()))));
    }

    #[test]
    fn phpstan_uses_the_configuration_file_of_the_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let bin = root.join("vendor/bin/phpstan");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "").unwrap();
        let args = |config: &str| {
            let mut s = Settings::default();
            s.languages.php.phpstan_config = config.into();
            phpstan(root, &s).unwrap().get_args().map(text).collect::<Vec<_>>()
        };
        let resolved = root.join("build/phpstan.ci.neon").to_string_lossy().into_owned();
        assert_eq!(args(" build/phpstan.ci.neon ")[4..6], ["--configuration".to_string(), resolved]);
        let absolute = if cfg!(windows) { "C:/etc/phpstan.neon" } else { "/etc/phpstan.neon" };
        assert_eq!(args(absolute)[4..6], ["--configuration", absolute]);
        // Empty: PHPStan finds phpstan.neon, phpstan.neon.dist or phpstan.dist.neon itself.
        assert!(!args(" ").iter().any(|a| a.starts_with("--configuration")));
    }

    #[test]
    fn each_level_names_its_source() {
        let found = |version: &str, source| Some(PhpLanguageLevel { version: version.into(), source });
        let require = r#"{"require": {"php": "^7.4"}}"#;
        let platform = r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "8.2.1"}}}"#;

        let require_level = found("7.4.0", PhpLevelSource::Require);
        assert_eq!(levels(Some(require), ""), (require_level.clone(), require_level.clone()));
        let platform_level = found("8.2.1", PhpLevelSource::Platform);
        assert_eq!(levels(Some(platform), ""), (platform_level.clone(), platform_level));
        // An explicit level: the composer one is still what Auto would pick.
        assert_eq!(levels(Some(require), "8.1"), (found("8.1.0", PhpLevelSource::Settings), require_level));
        assert_eq!(levels(None, "8.1"), (found("8.1.0", PhpLevelSource::Settings), None));
        assert_eq!(levels(None, ""), (None, None));
        assert_eq!(levels(Some(r#"{"require": {"php": "*"}}"#), ""), (None, None));
    }

    #[test]
    fn explicit_level_wins() {
        let composer = r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "7.4.33"}}}"#;
        assert_eq!(level(Some(composer), "8.1").as_deref(), Some("8.1.0"));
        assert_eq!(level(None, " 5.6 ").as_deref(), Some("5.6.0"));
    }
}
