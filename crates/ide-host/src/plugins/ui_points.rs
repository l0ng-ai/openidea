//! Declarative UI contributions: menus, key
//! bindings, status bar items and settings (L0, shown before any code runs),
//! and the views and custom editors whose content plugin code renders (L2).
//! Everything is validated here; the client only projects the JSON.
//!
//! ```toml
//! [[contributes.menus]]
//! menu = "editor.context"          # projectView.context, editorTab.context, tools
//! command = "check"
//! when = "editorLang == java"
//!
//! [[contributes.keymaps]]
//! command = "check"
//! key = "Ctrl+Alt+C"               # `mac` for a different binding on macOS (`Meta+Alt+C`)
//!
//! [[contributes.statusBar]]
//! id = "branch"
//! text = "…"                       # code replaces it with `set-status-item("branch", …)`
//! command = "show"
//!
//! [contributes.settings]
//! schema = "settings.schema.json"  # {"properties": {"key": {"type": "boolean", "default": true, …}}}
//!
//! [[contributes.views]]
//! id = "clusters"
//! title = "Kubernetes"
//! icon = "server"
//! location = "right"               # left, right, bottom
//!
//! [[contributes.customEditors]]
//! id = "table"
//! title = "Table"
//! patterns = ["*.csv", "*.tsv"]
//! priority = "default"             # or "option": only through Open With
//! layout = "tab"                   # or "split" / "preview": beside the text editor
//! web = "web/index.html"           # a web page from the package instead of rendered content
//!
//! [[contributes.fileIcons]]
//! id = "drawing"
//! patterns = ["*.excalidraw"]
//! icon = "icons/drawing.svg"
//! iconDark = "icons/drawing_dark.svg"
//!
//! [[contributes.fileTemplates]]
//! id = "drawing"
//! name = "Excalidraw Drawing"
//! extension = "excalidraw"
//! path = "templates/drawing.excalidraw"
//! ```

use ide_extension::{Package, UiDecl, decode, validate_item_id, validate_when};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

pub const MENUS: &str = "menus";
pub const KEYMAPS: &str = "keymaps";
pub const STATUS_BAR: &str = "statusBar";
pub const SETTINGS: &str = "settings";
pub const VIEWS: &str = "views";
pub const CUSTOM_EDITORS: &str = "customEditors";
pub const FILE_ICONS: &str = "fileIcons";
pub const FILE_TEMPLATES: &str = "fileTemplates";

const MENU_IDS: [&str; 4] = ["editor.context", "projectView.context", "editorTab.context", "tools"];
const MAX_TITLE: usize = 256;
const MAX_SETTINGS: usize = 200;
const MAX_PATTERNS: usize = 16;

/// Command ids the package declares.
fn commands(pkg: &Package) -> BTreeSet<String> {
    pkg.manifest
        .declarations(super::COMMANDS)
        .iter()
        .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect()
}

fn declared_command(pkg: &Package, point: &str, command: &str) -> Result<(), String> {
    if commands(pkg).contains(command) {
        Ok(())
    } else {
        Err(format!("contributes.{point}: command {command:?} is not declared under [[contributes.commands]]"))
    }
}

fn title(point: &str, t: &str) -> Result<(), String> {
    if t.trim().is_empty() || t.len() > MAX_TITLE {
        return Err(format!("contributes.{point}: titles are 1–{MAX_TITLE} bytes"));
    }
    Ok(())
}

fn json<T: Serialize>(v: &T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MenuDecl {
    menu: String,
    command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    when: Option<String>,
}

pub(super) fn menu(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: MenuDecl = decode(MENUS, decl)?;
    if !MENU_IDS.contains(&d.menu.as_str()) {
        return Err(format!("contributes.menus: unknown menu {:?} (one of {})", d.menu, MENU_IDS.join(", ")));
    }
    declared_command(pkg, MENUS, &d.command)?;
    if let Some(w) = &d.when {
        validate_when(w).map_err(|e| format!("contributes.menus: {e}"))?;
    }
    Ok(UiDecl::new(format!("{}/{}", d.menu, d.command), d.command.clone(), json(&d)?))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KeymapDecl {
    command: String,
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mac: Option<String>,
}

const MODIFIERS: [&str; 4] = ["Meta", "Ctrl", "Alt", "Shift"];
const NAMED_KEYS: [&str; 22] = [
    "Enter",
    "Escape",
    "Tab",
    "Space",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
    "Minus",
    "Equal",
    "Comma",
    "Period",
    "Slash",
    "Semicolon",
    "Quote",
];

/// `Ctrl+Alt+C`, `Meta+K Meta+C` (a chord): at least one modifier per
/// stroke but for function keys, so plugins can't take plain typing.
pub fn validate_binding(binding: &str) -> Result<(), String> {
    let strokes: Vec<&str> = binding.split(' ').collect();
    if strokes.is_empty() || strokes.len() > 2 {
        return Err(format!("{binding:?}: one stroke, or two for a chord"));
    }
    for stroke in strokes {
        let parts: Vec<&str> = stroke.split('+').collect();
        let (key, mods) = parts.split_last().ok_or_else(|| format!("{binding:?}: empty stroke"))?;
        let mut seen = BTreeSet::new();
        for m in mods {
            if !MODIFIERS.contains(m) || !seen.insert(*m) {
                return Err(format!("{binding:?}: unknown or repeated modifier {m:?}"));
            }
        }
        let function = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=24).contains(&n));
        let plain = key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
        if !(function || plain || NAMED_KEYS.contains(key)) {
            return Err(format!("{binding:?}: unknown key {key:?}"));
        }
        if !function && seen.iter().all(|m| *m == "Shift") {
            return Err(format!("{binding:?}: needs Ctrl, Alt or Meta (plain keys are for typing)"));
        }
    }
    Ok(())
}

pub(super) fn keymap(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: KeymapDecl = decode(KEYMAPS, decl)?;
    declared_command(pkg, KEYMAPS, &d.command)?;
    validate_binding(&d.key).map_err(|e| format!("contributes.keymaps: {e}"))?;
    if let Some(m) = &d.mac {
        validate_binding(m).map_err(|e| format!("contributes.keymaps: {e}"))?;
    }
    Ok(UiDecl::new(d.command.clone(), d.key.clone(), json(&d)?))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StatusDecl {
    id: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tooltip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default = "right")]
    align: String,
    #[serde(default)]
    priority: u32,
}

fn right() -> String {
    "right".into()
}

pub(super) fn status_item(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: StatusDecl = decode(STATUS_BAR, decl)?;
    validate_item_id(&d.id, "status bar item id")?;
    if d.text.is_empty() || d.text.len() > 128 || d.tooltip.as_ref().is_some_and(|t| t.len() > 1024) {
        return Err(format!("status bar item {:?}: `text` 1–128 bytes, `tooltip` up to 1 KiB", d.id));
    }
    if d.align != "left" && d.align != "right" {
        return Err(format!("status bar item {:?}: `align` is left or right", d.id));
    }
    if d.priority > 1000 {
        return Err(format!("status bar item {:?}: `priority` is 0–1000", d.id));
    }
    if let Some(c) = &d.command {
        declared_command(pkg, STATUS_BAR, c)?;
    }
    Ok(UiDecl::new(d.id.clone(), d.text.clone(), json(&d)?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsDecl {
    #[serde(default)]
    title: Option<String>,
    schema: PathBuf,
}

#[derive(Debug, Deserialize)]
struct SchemaFile {
    properties: serde_json::Map<String, Value>,
}

/// One setting of a plugin.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingSchema {
    pub key: String,
    /// `boolean`, `string`, `number` or `integer`.
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub default: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub multiline: bool,
}

impl SettingSchema {
    /// Whether `v` is a valid value of this setting.
    pub fn accepts(&self, v: &Value) -> bool {
        match self.kind.as_str() {
            "boolean" => v.is_boolean(),
            "integer" => v.is_i64() || v.is_u64(),
            "number" => v.is_number(),
            _ => v
                .as_str()
                .is_some_and(|s| s.len() <= 64 << 10 && self.options.as_ref().is_none_or(|o| o.iter().any(|x| x == s))),
        }
    }
}

fn setting(key: &str, raw: &Value) -> Result<SettingSchema, String> {
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(format!("setting {key:?}: keys are 1–64 of [A-Za-z0-9._-]"));
    }
    let o = raw.as_object().ok_or_else(|| format!("setting {key:?}: expected an object"))?;
    let kind = o.get("type").and_then(Value::as_str).unwrap_or("");
    let default = match kind {
        "boolean" => o.get("default").cloned().unwrap_or(Value::Bool(false)),
        "string" => o.get("default").cloned().unwrap_or(Value::String(String::new())),
        "number" | "integer" => o.get("default").cloned().unwrap_or(Value::from(0)),
        _ => return Err(format!("setting {key:?}: `type` is boolean, string, number or integer")),
    };
    let options = match o.get("enum") {
        None => None,
        Some(Value::Array(a)) if kind == "string" && !a.is_empty() && a.len() <= 100 => Some(
            a.iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| format!("setting {key:?}: `enum` lists strings")))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Some(_) => return Err(format!("setting {key:?}: `enum` is 1–100 strings of a string setting")),
    };
    let text = |name: &str, max: usize| -> Result<Option<String>, String> {
        match o.get(name) {
            None => Ok(None),
            Some(Value::String(s)) if s.len() <= max => Ok(Some(s.clone())),
            Some(_) => Err(format!("setting {key:?}: `{name}` is a string up to {max} bytes")),
        }
    };
    let s = SettingSchema {
        key: key.to_owned(),
        kind: kind.to_owned(),
        title: text("title", MAX_TITLE)?.unwrap_or_else(|| key.to_owned()),
        description: text("description", 4096)?,
        default,
        options,
        multiline: o.get("multiline").and_then(Value::as_bool).unwrap_or(false),
    };
    if !s.accepts(&s.default) {
        return Err(format!("setting {key:?}: the default does not match its type"));
    }
    Ok(s)
}

/// The validated settings of a `[contributes.settings]` schema file.
pub fn parse_settings_schema(text: &str) -> Result<Vec<SettingSchema>, String> {
    let file: SchemaFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if file.properties.len() > MAX_SETTINGS {
        return Err(format!("more than {MAX_SETTINGS} settings"));
    }
    file.properties.iter().map(|(k, v)| setting(k, v)).collect()
}

pub(super) fn settings(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: SettingsDecl = decode(SETTINGS, decl)?;
    let text = pkg.read_text(&d.schema)?;
    let properties = parse_settings_schema(&text).map_err(|e| format!("{}: {e}", d.schema.display()))?;
    let title = d.title.unwrap_or_else(|| pkg.manifest.name.clone());
    title_ok(&title)?;
    let mut decl =
        UiDecl::new("settings", title.clone(), serde_json::json!({ "title": title, "properties": properties }));
    decl.files.push(d.schema);
    Ok(decl)
}

fn title_ok(t: &str) -> Result<(), String> {
    title(SETTINGS, t)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ViewDecl {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(default = "right")]
    location: String,
    /// A web page of the package (`web/index.html`) instead of content the code renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    web: Option<String>,
}

/// The files of a `web` entry, or a check that the code renders the view.
fn web_or_code(pkg: &Package, web: Option<&str>, what: &str) -> Result<Vec<PathBuf>, String> {
    match web {
        Some(entry) => super::web::web_files(pkg, entry, what),
        None if pkg.manifest.wasm.is_none() => {
            Err(format!("{what}: give a web page (`web`) or the code that renders it (`wasm`)"))
        }
        None => Ok(Vec::new()),
    }
}

pub(super) fn view(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: ViewDecl = decode(VIEWS, decl)?;
    validate_item_id(&d.id, "view id")?;
    title(VIEWS, &d.title)?;
    let files = web_or_code(pkg, d.web.as_deref(), &format!("view {:?}", d.id))?;
    if !["left", "right", "bottom"].contains(&d.location.as_str()) {
        return Err(format!("view {:?}: `location` is left, right or bottom", d.id));
    }
    if d.icon.as_ref().is_some_and(|i| i.len() > 64) {
        return Err(format!("view {:?}: icon names are up to 64 bytes", d.id));
    }
    let mut out = UiDecl::new(d.id.clone(), d.title.clone(), json(&d)?);
    out.files = files;
    Ok(out)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CustomEditorDecl {
    id: String,
    title: String,
    patterns: Vec<String>,
    #[serde(default = "default_priority")]
    priority: String,
    /// `tab`: the file opens in this editor's own tab. `split` / `preview`:
    /// the file opens in the text editor with this editor beside it (Editor /
    /// Editor and Preview / Preview); the value is the layout files start in.
    #[serde(default = "default_layout")]
    layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    web: Option<String>,
}

fn default_priority() -> String {
    "default".into()
}

fn default_layout() -> String {
    "tab".into()
}

/// File name globs (`*.csv`, `{a,b}.json`): no directories.
fn file_patterns(patterns: &[String], what: &str) -> Result<(), String> {
    if patterns.is_empty() || patterns.len() > MAX_PATTERNS {
        return Err(format!("{what}: 1–{MAX_PATTERNS} file name `patterns`"));
    }
    for p in patterns {
        if p.is_empty() || p.len() > 128 || p.contains(['/', '\\']) || globset::Glob::new(p).is_err() {
            return Err(format!("{what}: invalid file name pattern {p:?}"));
        }
    }
    Ok(())
}

pub(super) fn custom_editor(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: CustomEditorDecl = decode(CUSTOM_EDITORS, decl)?;
    validate_item_id(&d.id, "custom editor id")?;
    title(CUSTOM_EDITORS, &d.title)?;
    let what = format!("custom editor {:?}", d.id);
    let files = web_or_code(pkg, d.web.as_deref(), &what)?;
    file_patterns(&d.patterns, &what)?;
    if d.priority != "default" && d.priority != "option" {
        return Err(format!("{what}: `priority` is default or option"));
    }
    if !["tab", "split", "preview"].contains(&d.layout.as_str()) {
        return Err(format!("{what}: `layout` is tab, split or preview"));
    }
    let mut out = UiDecl::new(d.id.clone(), d.title.clone(), json(&d)?);
    out.files = files;
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileIconDecl {
    id: String,
    patterns: Vec<String>,
    icon: PathBuf,
    #[serde(default)]
    icon_dark: Option<PathBuf>,
}

/// Asset id of a file icon's SVG (`dark`: its dark-theme variant).
pub fn file_icon_asset(id: &str, dark: bool) -> String {
    format!("fileIcon/{id}/{}", if dark { "dark" } else { "light" })
}

/// `[[contributes.fileIcons]]`: an icon for the files matching `patterns`,
/// whatever icon theme is in use (the user's own file type icons still win).
pub(super) fn file_icon(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: FileIconDecl = decode(FILE_ICONS, decl)?;
    validate_item_id(&d.id, "file icon id")?;
    let what = format!("file icon {:?}", d.id);
    file_patterns(&d.patterns, &what)?;
    let mut files = Vec::new();
    let mut assets = Vec::new();
    for (path, dark) in [(Some(&d.icon), false), (d.icon_dark.as_ref(), true)] {
        let Some(path) = path else { continue };
        let svg = super::icons::read_icon(pkg, path)?;
        assets.push((file_icon_asset(&d.id, dark), svg));
        files.push(path.clone());
    }
    let json = serde_json::json!({ "id": d.id, "patterns": d.patterns, "dark": d.icon_dark.is_some() });
    let mut out = UiDecl::new(d.id.clone(), d.patterns.join(", "), json);
    out.files = files;
    out.assets = assets;
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileTemplateDecl {
    id: String,
    name: String,
    /// Without the dot.
    extension: String,
    /// The new file's content (`$NAME$`, `$END$` and the other template variables work).
    path: PathBuf,
}

const MAX_TEMPLATE: usize = 256 << 10;

/// `[[contributes.fileTemplates]]`: an entry of the New menu.
pub(super) fn file_template(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: FileTemplateDecl = decode(FILE_TEMPLATES, decl)?;
    validate_item_id(&d.id, "file template id")?;
    title(FILE_TEMPLATES, &d.name)?;
    let what = format!("file template {:?}", d.id);
    let ext = d.extension.trim_start_matches('.');
    if ext.is_empty()
        || ext.len() > 32
        || !ext.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("{what}: `extension` is a file extension like \"md\" ({:?})", d.extension));
    }
    let body = pkg.read_text(&d.path)?;
    if body.len() > MAX_TEMPLATE {
        return Err(format!("{what}: {} is larger than {} KiB", d.path.display(), MAX_TEMPLATE >> 10));
    }
    let json = serde_json::json!({ "id": d.id, "name": d.name, "extension": ext, "body": body });
    let mut out = UiDecl::new(d.id.clone(), d.name.clone(), json);
    out.files = vec![d.path.clone()];
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_need_a_modifier() {
        for ok in ["Ctrl+Alt+C", "Meta+Shift+K", "F5", "Shift+F6", "Meta+K Meta+C", "Alt+Enter"] {
            assert!(validate_binding(ok).is_ok(), "{ok}");
        }
        for bad in ["C", "Shift+C", "Hyper+C", "Ctrl+Ctrl+C", "Ctrl+é", "Ctrl+A B C", ""] {
            assert!(validate_binding(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn settings_schemas_are_typed() {
        let s = parse_settings_schema(
            r#"{"properties": {
                "context": {"type": "string", "title": "Context", "default": ""},
                "watch": {"type": "boolean", "default": true},
                "mode": {"type": "string", "enum": ["a", "b"], "default": "b"},
                "limit": {"type": "integer", "default": 100}
            }}"#,
        )
        .unwrap();
        assert_eq!(s.len(), 4);
        assert!(s.iter().find(|x| x.key == "mode").unwrap().accepts(&Value::from("a")));
        assert!(!s.iter().find(|x| x.key == "mode").unwrap().accepts(&Value::from("c")));
        assert!(parse_settings_schema(r#"{"properties": {"x": {"type": "string", "default": 3}}}"#).is_err());
        assert!(parse_settings_schema(r#"{"properties": {"x": {"type": "object"}}}"#).is_err());
    }
}
