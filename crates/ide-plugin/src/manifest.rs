//! `plugin.toml`: the plugin package manifest.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// Plugin API version implemented by this host (`openidea-api` in the manifest).
pub const API_VERSION: &str = "0.1";
pub const MANIFEST_FILE: &str = "plugin.toml";

/// Capabilities a plugin must declare to use the gated host functions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    /// `workspace-root`, `read-file` (inside the project root only).
    ProjectRead,
    /// `active-file`.
    EditorRead,
    /// `insert-text`, `replace-selection`.
    EditorWrite,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::ProjectRead => "project-read",
            Permission::EditorRead => "editor-read",
            Permission::EditorWrite => "editor-write",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Release notes of this version (Settings › Plugins › What's New).
    #[serde(default)]
    pub change_notes: Option<String>,
    pub openidea_api: String,
    /// Component file relative to the package directory; absent for
    /// contribution-only plugins (themes, languages).
    #[serde(default)]
    pub wasm: Option<PathBuf>,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default)]
    pub contributes: Contributions,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default)]
    pub commands: Vec<CommandDecl>,
    #[serde(default)]
    pub languages: Vec<FileDecl>,
    #[serde(default)]
    pub themes: Vec<ThemeDecl>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandDecl {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
}

/// A contributed file, relative to the package directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileDecl {
    pub path: PathBuf,
}

/// A contributed theme: the UI theme file plus an optional editor colour scheme
/// whose tokens are merged over it (IntelliJ's `.theme.json` + `.icls`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ThemeDecl {
    pub path: PathBuf,
    #[serde(default)]
    pub editor_scheme: Option<PathBuf>,
}

impl PluginManifest {
    pub fn parse(src: &str) -> Result<Self, String> {
        let manifest: Self = toml::from_str(src).map_err(|e| e.to_string())?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join(MANIFEST_FILE);
        let src = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&src).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_plugin_id(&self.id)?;
        if self.name.trim().is_empty() {
            return Err("`name` must not be empty".into());
        }
        if !is_version(&self.version) {
            return Err(format!("`version` must look like 1.2.3, got {:?}", self.version));
        }
        if !api_compatible(&self.openidea_api) {
            return Err(format!(
                "unsupported openidea-api {:?} (this IDE implements {API_VERSION})",
                self.openidea_api
            ));
        }
        if let Some(wasm) = &self.wasm {
            check_relative(wasm, "wasm")?;
        }
        let mut seen = std::collections::HashSet::new();
        for c in &self.contributes.commands {
            validate_command_id(&c.id)?;
            if !seen.insert(c.id.as_str()) {
                return Err(format!("duplicate command id {:?}", c.id));
            }
            if c.title.trim().is_empty() {
                return Err(format!("command {:?} has an empty title", c.id));
            }
        }
        let theme_files = self.contributes.themes.iter().flat_map(|t| std::iter::once(&t.path).chain(&t.editor_scheme));
        for path in self.contributes.languages.iter().map(|f| &f.path).chain(theme_files) {
            check_relative(path, "contributes path")?;
        }
        Ok(())
    }

    /// Every file of the package besides the manifest (what an install copies).
    pub fn files(&self) -> Vec<&Path> {
        let mut files: Vec<&Path> = self.wasm.iter().map(PathBuf::as_path).collect();
        files.extend(self.contributes.languages.iter().map(|f| f.path.as_path()));
        for t in &self.contributes.themes {
            files.push(t.path.as_path());
            files.extend(t.editor_scheme.as_deref());
        }
        files
    }

    pub fn has(&self, p: Permission) -> bool {
        self.permissions.contains(&p)
    }
}

/// `[a-z0-9][a-z0-9_-]*`, at most 64 chars (no dots: it is one segment of an action id).
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    validate_ident(id, "plugin id", false)
}

/// `[a-z0-9][a-z0-9._-]*`, at most 64 chars.
pub fn validate_command_id(id: &str) -> Result<(), String> {
    validate_ident(id, "command id", true)
}

fn validate_ident(id: &str, what: &str, dots: bool) -> Result<(), String> {
    let ok_first = id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let ok_rest =
        id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || (dots && c == '.'));
    if ok_first && ok_rest && id.len() <= 64 {
        Ok(())
    } else {
        let allowed = if dots { "a-z, 0-9, '.', '-', '_'" } else { "a-z, 0-9, '-', '_'" };
        Err(format!("invalid {what} {id:?}: use {allowed}, starting with a letter or digit (max 64)"))
    }
}

fn is_version(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `0.1` and `0.1.x` are compatible with API 0.1 (pre-1.0: minor is breaking).
fn api_compatible(v: &str) -> bool {
    v == API_VERSION || v.strip_prefix(API_VERSION).is_some_and(|rest| rest.starts_with('.'))
}

/// Package paths must stay inside the package directory.
fn check_relative(path: &Path, what: &str) -> Result<(), String> {
    let ok = !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if ok { Ok(()) } else { Err(format!("{what} {:?} must be a relative path inside the plugin", path.display())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
        id = "hello"
        name = "Hello"
        version = "0.1.0"
        description = "Says hello"
        authors = ["A"]
        openidea-api = "0.1"
        wasm = "dist/plugin.wasm"
        permissions = ["project-read", "editor-write"]

        [[contributes.commands]]
        id = "say.hi"
        title = "Say Hi"
        category = "Hello"

        [[contributes.themes]]
        path = "themes/dark.json"
        editor-scheme = "themes/dark.scheme.json"
    "#;

    #[test]
    fn parses_full_manifest() {
        let m = PluginManifest::parse(FULL).unwrap();
        assert_eq!(m.id, "hello");
        assert_eq!(m.permissions, vec![Permission::ProjectRead, Permission::EditorWrite]);
        assert_eq!(m.contributes.commands[0].category.as_deref(), Some("Hello"));
        assert_eq!(
            m.files(),
            vec![Path::new("dist/plugin.wasm"), Path::new("themes/dark.json"), Path::new("themes/dark.scheme.json")]
        );
        assert!(m.has(Permission::EditorWrite) && !m.has(Permission::EditorRead));
    }

    #[test]
    fn minimal_contribution_only_manifest() {
        let m =
            PluginManifest::parse("id = \"t\"\nname = \"T\"\nversion = \"1.0.0\"\nopenidea-api = \"0.1.3\"").unwrap();
        assert!(m.wasm.is_none() && m.permissions.is_empty());
    }

    fn err(src: &str) -> String {
        PluginManifest::parse(src).unwrap_err()
    }

    #[test]
    fn rejects_invalid_manifests() {
        let base = |extra: &str, id: &str, api: &str| {
            format!("id = \"{id}\"\nname = \"N\"\nversion = \"1.0.0\"\nopenidea-api = \"{api}\"\n{extra}")
        };
        assert!(err(&base("", "Bad.Id", "0.1")).contains("invalid plugin id"));
        assert!(err(&base("", "ok", "0.2")).contains("unsupported openidea-api"));
        assert!(err(&base("", "ok", "0.10")).contains("unsupported openidea-api"));
        assert!(err(&base("permissions = [\"network\"]", "ok", "0.1")).contains("unknown variant"));
        assert!(err(&base("wasm = \"../evil.wasm\"", "ok", "0.1")).contains("relative path"));
        assert!(err(&base("wasm = \"/abs.wasm\"", "ok", "0.1")).contains("relative path"));
        assert!(err(&base("bogus = 1", "ok", "0.1")).contains("unknown field"));
        let dup =
            "[[contributes.commands]]\nid = \"a\"\ntitle = \"A\"\n[[contributes.commands]]\nid = \"a\"\ntitle = \"B\"";
        assert!(err(&base(dup, "ok", "0.1")).contains("duplicate command"));
        let traversal = "[[contributes.languages]]\npath = \"a/../../x.toml\"";
        assert!(err(&base(traversal, "ok", "0.1")).contains("relative path"));
        let scheme_escape = "[[contributes.themes]]\npath = \"t.json\"\neditor-scheme = \"../s.json\"";
        assert!(err(&base(scheme_escape, "ok", "0.1")).contains("relative path"));
        assert!(err("id = \"ok\"\nname = \"N\"\nversion = \"1.0\"\nopenidea-api = \"0.1\"").contains("version"));
        assert!(err("id = \"ok\"\nname = \" \"\nversion = \"1.0.0\"\nopenidea-api = \"0.1\"").contains("name"));
    }

    #[test]
    fn ident_rules() {
        assert!(validate_command_id("word-count.v2_x").is_ok());
        assert!(validate_command_id("-x").is_err());
        assert!(validate_command_id("").is_err());
        assert!(validate_command_id(&"a".repeat(65)).is_err());
        assert!(validate_plugin_id("a.b").is_err());
        assert!(is_version("1.2.3-beta.1+build"));
        assert!(!is_version("1.2.x"));
    }
}
