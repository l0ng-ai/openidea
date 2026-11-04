//! `plugin.toml`, the package manifest (plan 4.4).
//!
//! ```toml
//! id = "acme.rust-tools"          # optional publisher namespace before the first '.'
//! name = "Rust Tools"
//! version = "1.2.0"
//! engines.openidea = "^1.0"
//! wasm = "plugin.wasm"
//! activation = ["on-language:rust", "on-command:check"]
//!
//! [capabilities]
//! required = ["project.read", "editor.write"]
//! optional = ["net:crates.io", "process:cargo"]
//!
//! [[contributes.commands]]
//! id = "check"
//! title = "Check"
//! ```
//!
//! `contributes` is kept as raw TOML: each `contributes.<point>` is parsed and
//! validated by the extension point registered under that id
//! ([`crate::ExtensionRegistry`]), so new contribution types need no change here.
//!
//! Manifests in the 0.1 format (`openidea-api = "0.1"`, `permissions = [...]`)
//! still parse: permissions become required capabilities and the plugin is
//! activated at start-up, as before.

use crate::capability::Capability;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

pub const MANIFEST_FILE: &str = "plugin.toml";
/// The plugin API (engine) version this host implements.
pub const ENGINE_VERSION: &str = "1.0.0";
/// The 0.1 API, still accepted for contribution-only packages and 0.1 components.
pub const LEGACY_API: &str = "0.1";
/// Marketplace categories, in the order they are shown.
pub const CATEGORIES: &[&str] =
    &["languages", "themes", "icon-themes", "linters", "vcs", "ai", "frameworks", "tools", "other"];
/// What a manifest may declare in `categories`.
const MAX_CATEGORIES: usize = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    /// Release notes of this version (Settings › Plugins › What's New).
    pub change_notes: Option<String>,
    /// Marketplace categories as declared (see [`Manifest::categories`]).
    pub declared_categories: Vec<String>,
    /// `engines.openidea` (a semver requirement), or the legacy `openidea-api`.
    pub engine: String,
    /// Written in the 0.1 format.
    pub legacy: bool,
    /// Component file relative to the package directory.
    pub wasm: Option<PathBuf>,
    pub activation: Vec<ActivationEvent>,
    pub capabilities: Capabilities,
    /// `contributes.<point>` → its declarations, validated by the extension points.
    pub contributes: toml::Table,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub required: Vec<Capability>,
    pub optional: Vec<Capability>,
}

impl Capabilities {
    pub fn all(&self) -> impl Iterator<Item = &Capability> {
        self.required.iter().chain(&self.optional)
    }

    pub fn is_optional(&self, cap: &Capability) -> bool {
        self.optional.contains(cap) && !self.required.contains(cap)
    }
}

/// When a plugin's code is instantiated (plan 4.4). Contributions are live
/// without it; code only runs once one of these fires.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ActivationEvent {
    /// One of the plugin's commands is run (`on-command:<id>`; `*` = any).
    Command(String),
    /// A file of this language is opened.
    Language(String),
    /// A file matching this glob (project-relative) is opened.
    File(String),
    /// One of the plugin's views is shown.
    View(String),
    /// Periodically: `on-schedule:<seconds>`. Does not keep the plugin alive.
    Schedule(u32),
    /// A workbench event of this kind (`on-event:file-saved`): the plugin is
    /// subscribed from the start, and activated to receive it.
    Event(String),
    /// Shortly after the workbench is ready.
    StartupFinished,
}

impl ActivationEvent {
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if s == "on-startup-finished" {
            return Ok(Self::StartupFinished);
        }
        let (kind, arg) = s.split_once(':').ok_or_else(|| format!("unknown activation event {s:?}"))?;
        let arg = arg.trim();
        if arg.is_empty() {
            return Err(format!("activation event {s:?} needs a value"));
        }
        Ok(match kind {
            "on-command" => Self::Command(arg.into()),
            "on-language" => Self::Language(arg.into()),
            "on-file" => Self::File(arg.into()),
            "on-view" => Self::View(arg.into()),
            "on-schedule" => {
                let secs: u32 =
                    arg.trim_end_matches('s').parse().map_err(|_| format!("{s:?}: expected seconds, e.g. 300"))?;
                if secs < 60 {
                    return Err(format!("{s:?}: the shortest schedule is 60 seconds"));
                }
                Self::Schedule(secs)
            }
            "on-event" => {
                if !EVENT_KINDS.contains(&arg) {
                    return Err(format!("{s:?}: unknown event kind (one of {})", EVENT_KINDS.join(", ")));
                }
                Self::Event(arg.into())
            }
            _ => return Err(format!("unknown activation event {s:?}")),
        })
    }
}

/// Workbench event kinds (`on-event:<kind>`, WIT `events.event-kind`).
/// `scheduled` comes from `on-schedule` instead.
pub const EVENT_KINDS: &[&str] = &["file-opened", "file-saved", "editor-focused", "action-performed", "vcs-changed"];

impl std::fmt::Display for ActivationEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Command(c) => write!(f, "on-command:{c}"),
            Self::Language(l) => write!(f, "on-language:{l}"),
            Self::File(g) => write!(f, "on-file:{g}"),
            Self::View(v) => write!(f, "on-view:{v}"),
            Self::Schedule(s) => write!(f, "on-schedule:{s}"),
            Self::Event(k) => write!(f, "on-event:{k}"),
            Self::StartupFinished => f.write_str("on-startup-finished"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Raw {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    change_notes: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    engines: Option<Engines>,
    /// 0.1 format.
    #[serde(default)]
    openidea_api: Option<String>,
    #[serde(default)]
    wasm: Option<PathBuf>,
    #[serde(default)]
    activation: Option<Vec<String>>,
    #[serde(default)]
    capabilities: Option<RawCapabilities>,
    /// 0.1 format.
    #[serde(default)]
    permissions: Option<Vec<String>>,
    #[serde(default)]
    contributes: toml::Table,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Engines {
    openidea: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCapabilities {
    #[serde(default)]
    required: Vec<String>,
    #[serde(default)]
    optional: Vec<String>,
}

impl Manifest {
    pub fn parse(src: &str) -> Result<Self, String> {
        let raw: Raw = toml::from_str(src).map_err(|e| e.to_string())?;
        let (engine, legacy) = match (raw.engines, raw.openidea_api) {
            (Some(e), None) => (e.openidea, false),
            (None, Some(api)) => (api, true),
            (Some(_), Some(_)) => return Err("use `engines.openidea`, not `openidea-api`".into()),
            (None, None) => return Err("missing `engines.openidea` (e.g. \"^1.0\")".into()),
        };
        if legacy && raw.capabilities.is_some() {
            return Err("`capabilities` requires `engines.openidea`; 0.1 manifests use `permissions`".into());
        }
        if !legacy && raw.permissions.is_some() {
            return Err("`permissions` is the 0.1 format; use `[capabilities] required = [...]`".into());
        }
        let parse_caps = |list: Vec<String>| -> Result<Vec<Capability>, String> {
            let mut out: Vec<Capability> = Vec::new();
            for s in list {
                let cap: Capability = s.parse()?;
                if !out.contains(&cap) {
                    out.push(cap);
                }
            }
            Ok(out)
        };
        let capabilities = match (raw.capabilities, raw.permissions) {
            (Some(c), _) => Capabilities { required: parse_caps(c.required)?, optional: parse_caps(c.optional)? },
            (None, Some(p)) => Capabilities { required: parse_caps(p)?, optional: Vec::new() },
            (None, None) => Capabilities::default(),
        };
        let activation = match raw.activation {
            Some(list) => list.iter().map(|s| ActivationEvent::parse(s)).collect::<Result<Vec<_>, _>>()?,
            // 0.1 plugins were activated at start-up; keep that until they move to 1.0.
            None if legacy && raw.wasm.is_some() => vec![ActivationEvent::StartupFinished],
            None => Vec::new(),
        };
        let m = Manifest {
            id: raw.id,
            name: raw.name,
            version: raw.version,
            description: raw.description,
            authors: raw.authors,
            homepage: raw.homepage,
            license: raw.license,
            change_notes: raw.change_notes,
            declared_categories: raw.categories,
            engine,
            legacy,
            wasm: raw.wasm,
            activation,
            capabilities,
            contributes: raw.contributes,
        };
        m.validate()?;
        Ok(m)
    }

    pub fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join(MANIFEST_FILE);
        let src = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&src).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn validate(&self) -> Result<(), String> {
        validate_plugin_id(&self.id)?;
        if self.name.trim().is_empty() {
            return Err("`name` must not be empty".into());
        }
        if semver::Version::parse(&self.version).is_err() {
            return Err(format!("`version` must be a semantic version like 1.2.3, got {:?}", self.version));
        }
        if !engine_compatible(&self.engine, self.legacy) {
            return Err(if self.legacy {
                format!(
                    "unsupported openidea-api {:?} (this IDE implements {LEGACY_API} and {ENGINE_VERSION})",
                    self.engine
                )
            } else {
                format!("engines.openidea {:?} does not match this IDE's plugin API {ENGINE_VERSION}", self.engine)
            });
        }
        if let Some(wasm) = &self.wasm {
            check_relative(wasm, "wasm")?;
        }
        if self.wasm.is_none() && !self.activation.is_empty() {
            return Err("`activation` needs `wasm`: there is no code to activate".into());
        }
        let mut seen = BTreeSet::new();
        for event in &self.activation {
            if !seen.insert(event) {
                return Err(format!("duplicate activation event {event}"));
            }
        }
        if self.declared_categories.len() > MAX_CATEGORIES {
            return Err(format!("`categories` lists at most {MAX_CATEGORIES}"));
        }
        for c in &self.declared_categories {
            validate_item_id(c, "category")?;
        }
        for (point, decls) in &self.contributes {
            validate_point_id(point)?;
            if !matches!(decls, toml::Value::Array(_) | toml::Value::Table(_)) {
                return Err(format!("`contributes.{point}` must be a table or an array of tables"));
            }
        }
        Ok(())
    }

    /// The declarations of one extension point: `[[contributes.x]]` gives
    /// several, `[contributes.x]` one.
    pub fn declarations(&self, point: &str) -> Vec<toml::Value> {
        match self.contributes.get(point) {
            Some(toml::Value::Array(items)) => items.clone(),
            Some(single @ toml::Value::Table(_)) => vec![single.clone()],
            _ => Vec::new(),
        }
    }

    /// Number of declarations per extension point (for listings before loading).
    pub fn declaration_counts(&self) -> Vec<(String, u32)> {
        self.contributes.keys().map(|p| (p.clone(), self.declarations(p).len() as u32)).collect()
    }

    /// Publisher namespace: the id's part before the first `.` (`acme` in `acme.tools`).
    pub fn publisher(&self) -> Option<&str> {
        self.id.split_once('.').map(|(p, _)| p)
    }

    /// Whether `cap` is declared (required or optional).
    pub fn declares(&self, cap: &Capability) -> bool {
        self.capabilities.all().any(|c| c.covers(cap))
    }
}

impl Manifest {
    /// Its marketplace categories, in [`CATEGORIES`] order: those declared that
    /// this IDE knows; without any, those its contributions imply (themes,
    /// icon themes, languages), else `other`.
    pub fn categories(&self) -> Vec<String> {
        let pick = |f: &dyn Fn(&str) -> bool| CATEGORIES.iter().filter(|c| f(c)).map(|c| c.to_string()).collect();
        let mut out: Vec<String> = pick(&|c| self.declared_categories.iter().any(|d| d == c));
        if out.is_empty() {
            out = pick(&|c| match c {
                "themes" => self.contributes.contains_key("themes"),
                "icon-themes" => self.contributes.contains_key("iconThemes"),
                "languages" => self.contributes.contains_key("languages"),
                _ => false,
            });
        }
        if out.is_empty() {
            out.push("other".into());
        }
        out
    }

    /// Declared categories this IDE doesn't know (ignored).
    pub fn unknown_categories(&self) -> Vec<&str> {
        self.declared_categories.iter().map(String::as_str).filter(|c| !CATEGORIES.contains(c)).collect()
    }
}

/// Whether this host can load a plugin written for `engine`.
pub fn engine_compatible(engine: &str, legacy: bool) -> bool {
    if legacy {
        return engine == LEGACY_API || engine.strip_prefix(LEGACY_API).is_some_and(|rest| rest.starts_with('.'));
    }
    let Ok(req) = semver::VersionReq::parse(engine) else { return false };
    let host = semver::Version::parse(ENGINE_VERSION).expect("valid engine version");
    req.matches(&host)
}

/// Segments of `[a-z0-9][a-z0-9_-]*` joined by `.` (an optional publisher
/// namespace first), at most 64 chars.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    let ok = id.len() <= 64 && !id.is_empty() && id.split('.').all(segment_ok);
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid plugin id {id:?}: use a-z, 0-9, '-', '_' in '.'-separated parts (e.g. acme.tools), max 64"
        ))
    }
}

/// `[a-z0-9][a-z0-9._-]*`, at most 64 chars (commands, themes, views…).
pub fn validate_item_id(id: &str, what: &str) -> Result<(), String> {
    let ok_first = id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let ok_rest = id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if ok_first && ok_rest && id.len() <= 64 {
        Ok(())
    } else {
        Err(format!("invalid {what} {id:?}: use a-z, 0-9, '.', '-', '_', starting with a letter or digit (max 64)"))
    }
}

/// Extension point ids: `camelCase` or `kebab-case` words, dots allowed (`iconThemes`, `menus`).
pub fn validate_point_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
    if ok { Ok(()) } else { Err(format!("invalid contribution point {id:?}")) }
}

fn segment_ok(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Package paths must stay inside the package directory.
pub fn check_relative(path: &Path, what: &str) -> Result<(), String> {
    let ok = !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if ok { Ok(()) } else { Err(format!("{what} {:?} must be a relative path inside the plugin", path.display())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
        id = "acme.rust-tools"
        name = "Rust Tools"
        version = "1.2.0"
        engines.openidea = "^1.0"
        wasm = "plugin.wasm"
        activation = ["on-language:rust", "on-command:check", "on-schedule:300"]

        [capabilities]
        required = ["project.read", "editor.write"]
        optional = ["net:crates.io", "process:cargo"]

        [[contributes.commands]]
        id = "check"
        title = "%check.title%"

        [[contributes.menus]]
        menu = "editor.context"
        command = "check"
        when = "editorLang == rust"

        [contributes.settings]
        schema = "settings.schema.json"
    "#;

    #[test]
    fn event_activation() {
        assert_eq!(ActivationEvent::parse("on-event:file-saved"), Ok(ActivationEvent::Event("file-saved".into())));
        assert_eq!(ActivationEvent::Event("vcs-changed".into()).to_string(), "on-event:vcs-changed");
        let err = ActivationEvent::parse("on-event:keystroke").unwrap_err();
        assert!(err.contains("unknown event kind") && err.contains("action-performed"), "{err}");
        assert!(ActivationEvent::parse("on-event:scheduled").is_err(), "declared with on-schedule");
    }

    #[test]
    fn categories_are_declared_or_implied() {
        let head = "id = \"acme.x\"\nname = \"X\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n";
        let m = |rest: &str| Manifest::parse(&format!("{head}{rest}"));
        // Declared, in the catalogue's order; unknown ones (a newer IDE's) are ignored.
        let declared = m("categories = [\"tools\", \"vcs\", \"robots\"]\n").unwrap();
        assert_eq!(declared.categories(), ["vcs", "tools"]);
        assert_eq!(declared.unknown_categories(), ["robots"]);
        // None declared: implied by the contributions, else `other`.
        let theme = m("[[contributes.themes]]\nid = \"t\"\n[[contributes.languages]]\nid = \"l\"\n").unwrap();
        assert_eq!(theme.categories(), ["languages", "themes"]);
        let declared_wins = m("categories = [\"tools\"]\n[[contributes.languages]]\nid = \"l\"\n").unwrap();
        assert_eq!(declared_wins.categories(), ["tools"]);
        assert_eq!(m("").unwrap().categories(), ["other"]);
        assert!(m("categories = [\"a\", \"b\", \"c\", \"d\"]\n").unwrap_err().contains("at most 3"));
        assert!(m("categories = [\"Bad Name\"]\n").is_err());
    }

    #[test]
    fn parses_the_02_format() {
        let m = Manifest::parse(FULL).unwrap();
        assert_eq!(m.publisher(), Some("acme"));
        assert!(!m.legacy);
        assert_eq!(m.activation.len(), 3);
        assert_eq!(m.activation[2], ActivationEvent::Schedule(300));
        assert_eq!(m.capabilities.required, vec![Capability::ProjectRead, Capability::EditorWrite]);
        assert!(m.capabilities.is_optional(&Capability::Process("cargo".into())));
        assert_eq!(m.declarations("commands").len(), 1);
        assert_eq!(m.declarations("settings").len(), 1, "a single table is one declaration");
        assert!(m.declarations("nope").is_empty());
        let counts: Vec<_> = m.declaration_counts();
        assert!(counts.contains(&("menus".into(), 1)));
    }

    #[test]
    fn parses_the_01_format() {
        let m = Manifest::parse(
            "id = \"hello\"\nname = \"Hello\"\nversion = \"0.1.0\"\nopenidea-api = \"0.1\"\nwasm = \"dist/plugin.wasm\"\n\
             permissions = [\"project-read\", \"editor-write\"]\n[[contributes.commands]]\nid = \"x\"\ntitle = \"X\"",
        )
        .unwrap();
        assert!(m.legacy);
        assert_eq!(m.capabilities.required, vec![Capability::ProjectRead, Capability::EditorWrite]);
        assert_eq!(m.activation, vec![ActivationEvent::StartupFinished]);
        assert_eq!(m.publisher(), None);
    }

    fn err(src: &str) -> String {
        Manifest::parse(src).unwrap_err()
    }

    #[test]
    fn rejects_invalid_manifests() {
        let base = |extra: &str| format!("id = \"ok\"\nname = \"N\"\nversion = \"1.0.0\"\n{extra}");
        assert!(err(&base("")).contains("engines.openidea"));
        assert!(err(&base("engines.openidea = \"^0.3\"")).contains("does not match"));
        assert!(err(&base("engines.openidea = \"^2\"")).contains("does not match"));
        assert!(err(&base("engines.openidea = \"^0.2\"")).contains("does not match"));
        assert!(err(&base("openidea-api = \"0.2\"")).contains("unsupported"));
        assert!(err(&base("engines.openidea = \"^1.0\"\npermissions = [\"project-read\"]")).contains("0.1 format"));
        assert!(
            err(&base("engines.openidea = \"^1.0\"\n[capabilities]\nrequired = [\"network\"]")).contains("unknown")
        );
        assert!(err(&base("engines.openidea = \"^1.0\"\nwasm = \"../x.wasm\"")).contains("relative path"));
        assert!(err(&base("engines.openidea = \"^1.0\"\nactivation = [\"on-command:x\"]")).contains("needs `wasm`"));
        assert!(
            err(&base("engines.openidea = \"^1.0\"\nwasm = \"p.wasm\"\nactivation = [\"on-boot\"]"))
                .contains("unknown")
        );
        assert!(
            err(&base("engines.openidea = \"^1.0\"\nwasm = \"p.wasm\"\nactivation = [\"on-schedule:5\"]"))
                .contains("60 seconds")
        );
        assert!(err(&base("engines.openidea = \"^1.0\"\nbogus = 1")).contains("unknown field"));
        assert!(err(&base("engines.openidea = \"^1.0\"\ncontributes.commands = 3")).contains("table"));
        assert!(
            err("id = \"Bad\"\nname = \"N\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"").contains("plugin id")
        );
        assert!(
            err("id = \"a..b\"\nname = \"N\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"").contains("plugin id")
        );
        assert!(err("id = \"ok\"\nname = \"N\"\nversion = \"1.0\"\nengines.openidea = \"^1.0\"").contains("version"));
    }

    #[test]
    fn ids() {
        assert!(validate_plugin_id("openidea.material-icons").is_ok());
        assert!(validate_plugin_id("hello_2").is_ok());
        assert!(validate_plugin_id(".x").is_err());
        assert!(validate_item_id("word-count.v2_x", "command id").is_ok());
        assert!(validate_item_id("-x", "command id").is_err());
        assert!(validate_point_id("iconThemes").is_ok());
        assert!(validate_point_id("Icon").is_err());
        assert!(engine_compatible("1.0", false));
        assert!(engine_compatible(">=1.0, <2", false));
        assert!(!engine_compatible("^0.2", false), "0.x components don't run on 1.0");
        assert!(engine_compatible("0.1.3", true));
        assert!(!engine_compatible("0.10", true));
    }
}
