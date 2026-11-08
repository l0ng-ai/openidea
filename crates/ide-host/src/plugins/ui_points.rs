//! Declarative UI contributions: menus, key
//! bindings, status bar items and settings (L0, shown before any code runs),
//! and the views and custom editors whose content plugin code renders (L2).
//! Everything is validated here; the client only projects the JSON.
//!
//! ```toml
//! [[contributes.menus]]
//! menu = "editor.context"          # projectView.context, editorTab.context, tools, viewItem.context, commit.message
//! command = "check"
//! when = "editorLang == java"
//! # view = "<view id>"             # required for (only allowed on) viewItem.context
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
//! id = "jobs"
//! title = "Jobs"
//! icon = "server"
//! location = "right"               # left, right, bottom, services (nodes of the Services tool window)
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
//! [[contributes.commitChecks]]
//! id = "conventional"
//! title = "Conventional Commits"   # Commit Options › Before Commit; `commit-checker.check` runs it
//!
//! [[contributes.fileTemplates]]
//! id = "drawing"
//! name = "Excalidraw Drawing"
//! extension = "excalidraw"
//! path = "templates/drawing.excalidraw"
//! ```

use ide_extension::{LOCALES_DIR, Package, UiDecl, decode, validate_item_id, validate_when};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// A view whose tree shows in the Services tool window; the plugin's
/// `detail-provider` renders the selected node's pane.
pub const SERVICES_LOCATION: &str = "services";
pub const MENUS: &str = "menus";
pub const KEYMAPS: &str = "keymaps";
pub const STATUS_BAR: &str = "statusBar";
pub const SETTINGS: &str = "settings";
pub const VIEWS: &str = "views";
pub const CUSTOM_EDITORS: &str = "customEditors";
pub const FILE_ICONS: &str = "fileIcons";
pub const MARKER_ICONS: &str = "markerIcons";
pub const FILE_TEMPLATES: &str = "fileTemplates";
pub const COMMIT_CHECKS: &str = "commitChecks";

const VIEW_ITEM_MENU: &str = "viewItem.context";
/// The toolbar above the commit message (Commit tool window and dialog).
const COMMIT_MESSAGE_MENU: &str = "commit.message";
const MENU_IDS: [&str; 6] =
    ["editor.context", "projectView.context", "editorTab.context", "tools", VIEW_ITEM_MENU, COMMIT_MESSAGE_MENU];
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

fn declared_view(pkg: &Package, id: &str) -> Option<toml::Value> {
    pkg.manifest.declarations(VIEWS).into_iter().find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    view: Option<String>,
    /// Groups the plugin's entries of one context menu that name the same
    /// submenu under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submenu: Option<String>,
}

pub(super) fn menu(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: MenuDecl = decode(MENUS, decl)?;
    if !MENU_IDS.contains(&d.menu.as_str()) {
        return Err(format!("contributes.menus: unknown menu {:?} (one of {})", d.menu, MENU_IDS.join(", ")));
    }
    declared_command(pkg, MENUS, &d.command)?;
    if d.menu == COMMIT_MESSAGE_MENU {
        pkg.manifest.needs_api(&format!("contributes.menus: {COMMIT_MESSAGE_MENU}"), 3)?;
    }
    if let Some(w) = &d.when {
        validate_when(w).map_err(|e| format!("contributes.menus: {e}"))?;
    }
    if let Some(submenu) = &d.submenu {
        if !d.menu.ends_with(".context") {
            return Err(format!("contributes.menus: `submenu` is only for context menus, not {:?}", d.menu));
        }
        title(MENUS, submenu)?;
        pkg.manifest.needs_api("contributes.menus: submenu", 3)?;
    }
    let key = match (d.menu == VIEW_ITEM_MENU, &d.view) {
        (true, None) => return Err(format!("contributes.menus: {VIEW_ITEM_MENU} needs `view`")),
        (true, Some(v)) => {
            pkg.manifest.needs_api(&format!("contributes.menus: {VIEW_ITEM_MENU}"), 2)?;
            let Some(view) = declared_view(pkg, v) else {
                return Err(format!("contributes.menus: view {v:?} is not declared under [[contributes.views]]"));
            };
            if view.get("web").is_some() {
                return Err(format!(
                    "contributes.menus: view {v:?} is a web view (viewItem.context needs a tree or list the plugin renders)"
                ));
            }
            format!("{VIEW_ITEM_MENU}/{v}/{}", d.command)
        }
        (false, Some(_)) => return Err(format!("contributes.menus: `view` is only for {VIEW_ITEM_MENU}")),
        (false, None) => format!("{}/{}", d.menu, d.command),
    };
    Ok(UiDecl::new(key, d.command.clone(), json(&d)?))
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
    schema: Option<PathBuf>,
    #[serde(default)]
    pages: Vec<SettingsPage>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsPage {
    id: String,
    title: String,
    schema: PathBuf,
    #[serde(default)]
    actions: Vec<SettingsAction>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SettingsAction {
    title: String,
    command: String,
}

#[derive(Debug, Deserialize)]
struct SchemaFile {
    #[serde(deserialize_with = "ordered_properties")]
    properties: Vec<(String, Box<serde_json::value::RawValue>)>,
}

// Preserve schema field order locally, without changing serde_json maps throughout the host.
fn ordered_properties<'de, D>(deserializer: D) -> Result<Vec<(String, Box<serde_json::value::RawValue>)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Properties;
    impl<'de> serde::de::Visitor<'de> for Properties {
        type Value = Vec<(String, Box<serde_json::value::RawValue>)>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an object of setting schemas")
        }

        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut fields = Vec::new();
            let mut keys = BTreeSet::new();
            while let Some((key, value)) = map.next_entry::<String, Box<serde_json::value::RawValue>>()? {
                if !keys.insert(key.clone()) {
                    return Err(serde::de::Error::custom(format!("duplicate setting key {key:?}")));
                }
                fields.push((key, value));
            }
            Ok(fields)
        }
    }
    deserializer.deserialize_map(Properties)
}

/// One setting of a plugin.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingSchema {
    pub key: String,
    /// A scalar, top-level `array`, or `object` table row.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<SettingSchema>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<SettingSchema>,
}

impl SettingSchema {
    /// Whether `v` is a valid value of this setting.
    pub fn accepts(&self, v: &Value) -> bool {
        match self.kind.as_str() {
            "boolean" => v.is_boolean(),
            "integer" => v.is_i64() || v.is_u64(),
            "number" => v.is_number(),
            "array" => v.as_array().is_some_and(|a| {
                a.len() <= 1000 && self.items.as_ref().is_some_and(|item| a.iter().all(|v| item.accepts(v)))
            }),
            "object" => v.as_object().is_some_and(|o| {
                o.len() == self.properties.len()
                    && self.properties.iter().all(|p| o.get(&p.key).is_some_and(|v| p.accepts(v)))
            }),
            _ => v
                .as_str()
                .is_some_and(|s| s.len() <= 64 << 10 && self.options.as_ref().is_none_or(|o| o.iter().any(|x| x == s))),
        }
    }
}

fn setting(key: &str, raw: &serde_json::value::RawValue) -> Result<SettingSchema, String> {
    setting_at(key, raw, 0)
}

fn setting_at(key: &str, raw: &serde_json::value::RawValue, depth: u8) -> Result<SettingSchema, String> {
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(format!("setting {key:?}: keys are 1–64 of [A-Za-z0-9._-]"));
    }
    let value: Value = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
    let o = value.as_object().ok_or_else(|| format!("setting {key:?}: expected an object"))?;
    let kind = o.get("type").and_then(Value::as_str).unwrap_or("");
    let mut items = None;
    let mut properties = Vec::new();
    let default = match kind {
        "boolean" => o.get("default").cloned().unwrap_or(Value::Bool(false)),
        "string" => o.get("default").cloned().unwrap_or(Value::String(String::new())),
        "number" | "integer" => o.get("default").cloned().unwrap_or(Value::from(0)),
        "array" if depth == 0 => {
            #[derive(Deserialize)]
            struct ArraySchema {
                items: Box<serde_json::value::RawValue>,
            }
            let array: ArraySchema = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
            let item = setting_at("item", &array.items, 1)?;
            if item.kind != "string" && item.kind != "object" {
                return Err(format!("setting {key:?}: items must be strings or objects"));
            }
            items = Some(Box::new(item));
            o.get("default").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
        }
        "object" if depth == 1 => {
            let fields = serde_json::from_str::<SchemaFile>(raw.get()).map_err(|e| e.to_string())?.properties;
            if fields.is_empty() || fields.len() > MAX_SETTINGS {
                return Err(format!("setting {key:?}: table needs 1–{MAX_SETTINGS} columns"));
            }
            properties = fields.iter().map(|(k, v)| setting_at(k, v, 2)).collect::<Result<_, _>>()?;
            o.get("default").cloned().unwrap_or_else(|| {
                Value::Object(properties.iter().map(|p| (p.key.clone(), p.default.clone())).collect())
            })
        }
        _ => return Err(format!("setting {key:?}: unsupported setting type {kind:?}")),
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
        group: text("group", MAX_TITLE)?,
        items,
        properties,
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
    if d.schema.is_some() == !d.pages.is_empty() {
        return Err("settings: use either `schema` or nonempty `pages`".into());
    }
    if d.pages.len() > 32 {
        return Err("settings: at most 32 pages".into());
    }
    let title = d.title.unwrap_or_else(|| pkg.manifest.name.clone());
    title_ok(&title)?;
    let mut files = Vec::new();
    let mut keys = BTreeSet::new();
    let mut load = |path: &Path| -> Result<Vec<SettingSchema>, String> {
        let properties =
            parse_settings_schema(&pkg.read_text(path)?).map_err(|e| format!("{}: {e}", path.display()))?;
        for p in &properties {
            if !keys.insert(p.key.clone()) {
                return Err(format!("settings: duplicate key {:?} across pages", p.key));
            }
            if p.group.is_some() || p.kind == "array" {
                pkg.manifest.needs_api("settings: groups / arrays", 3)?;
            }
        }
        if keys.len() > MAX_SETTINGS {
            return Err(format!("more than {MAX_SETTINGS} settings"));
        }
        files.push(path.to_path_buf());
        Ok(properties)
    };
    let mut properties = Vec::new();
    let mut pages = Vec::new();
    if let Some(path) = d.schema {
        properties = load(&path)?;
    } else {
        pkg.manifest.needs_api("contributes.settings.pages", 3)?;
        let mut ids = BTreeSet::new();
        for p in d.pages {
            validate_item_id(&p.id, "settings page id")?;
            if p.id.contains('.') || !ids.insert(p.id.clone()) {
                return Err(format!("settings: page id {:?} must be unique and contain no dots", p.id));
            }
            title_ok(&p.title)?;
            if p.actions.len() > 32 {
                return Err("settings: at most 32 actions per page".into());
            }
            for a in &p.actions {
                title_ok(&a.title)?;
                declared_command(pkg, SETTINGS, &a.command)?;
            }
            let fields = load(&p.schema)?;
            properties.extend(fields.clone());
            pages.push(serde_json::json!({
                "id": p.id, "title": p.title, "properties": fields, "actions": p.actions,
            }));
        }
    }
    let mut decl = UiDecl::new(
        "settings",
        title.clone(),
        serde_json::json!({
            "title": title, "properties": properties, "pages": pages,
        }),
    );
    decl.files = files;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    when: Option<String>,
    /// Show the selected tree/list item's detail-provider tabs beside it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    detail: bool,
    /// `default` or `none` (tool-window web views that render their own header row).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    header: Option<String>,
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
    if let Some(group) = &d.group {
        pkg.manifest.needs_api("contributes.views.group", 3)?;
        validate_item_id(group, "view group")?;
    }
    if let Some(when) = &d.when {
        pkg.manifest.needs_api("contributes.views.when", 3)?;
        validate_when(when).map_err(|e| format!("contributes.views: {e}"))?;
    }

    let files = web_or_code(pkg, d.web.as_deref(), &format!("view {:?}", d.id))?;
    if !["left", "right", "bottom", SERVICES_LOCATION].contains(&d.location.as_str()) {
        return Err(format!("view {:?}: `location` is left, right, bottom or services", d.id));
    }
    if d.location == SERVICES_LOCATION {
        pkg.manifest.needs_api(&format!("view {:?}: `location = \"services\"`", d.id), 3)?;
        if d.web.is_some() {
            return Err(format!("view {:?}: a services view is rendered by the plugin's code (no `web`)", d.id));
        }
    }
    if d.detail {
        pkg.manifest.needs_api(&format!("view {:?}: `detail`", d.id), 3)?;
        if d.web.is_some() {
            return Err(format!("view {:?}: `detail` needs a tree or list rendered by the plugin (no `web`)", d.id));
        }
    }
    if let Some(header) = &d.header {
        pkg.manifest.needs_api("contributes.views.header", 3)?;
        if header != "default" && header != "none" {
            return Err(format!("view {:?}: `header` is default or none", d.id));
        }
        if header == "none" && (d.web.is_none() || d.group.is_some()) {
            return Err(format!(
                "view {:?}: `header = \"none\"` is only for ungrouped tool-window web views (`web`)",
                d.id
            ));
        }
    }
    if d.icon.as_ref().is_some_and(|i| i.len() > 64) {
        return Err(format!("view {:?}: icon names are up to 64 bytes", d.id));
    }
    let mut out = UiDecl::new(d.id.clone(), d.title.clone(), json(&d)?);
    out.files = files;
    if let Some(icon) = d.icon.as_deref().filter(|i| i.ends_with(".svg")) {
        let path = std::path::PathBuf::from(icon);
        let svg = super::icons::read_icon(pkg, &path, super::icons::MAX_SVG)?;
        out.assets.push((view_icon_asset(&d.id), svg));
        out.files.push(path);
    }
    Ok(out)
}

pub fn view_icon_asset(id: &str) -> String {
    format!("viewIcon/{id}")
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
        let svg = super::icons::read_icon(pkg, path, super::icons::MAX_SVG)?;
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
struct MarkerIconDecl {
    id: String,
    icon: PathBuf,
    #[serde(default)]
    icon_dark: Option<PathBuf>,
}

pub(super) fn marker_icon(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    pkg.manifest.needs_api("contributes.markerIcons", 3)?;
    let d: MarkerIconDecl = decode(MARKER_ICONS, decl)?;
    validate_item_id(&d.id, "marker icon id")?;
    if d.icon.to_string_lossy().len() > 256 {
        return Err("marker icon paths are up to 256 bytes".into());
    }
    let mut out = UiDecl::new(d.id.clone(), d.id.clone(), serde_json::json!({ "id": d.id, "icon": d.icon }));
    for (path, variant) in [(Some(&d.icon), "light"), (d.icon_dark.as_ref(), "dark")] {
        let Some(path) = path else { continue };
        let svg = super::icons::read_icon(pkg, path, super::icons::MAX_SVG)?;
        out.assets.push((format!("markerIcon/{}/{variant}", d.id), svg));
        out.files.push(path.clone());
    }
    // A changed SVG must reproject even when its declared path stays the same.
    let bytes = serde_json::to_vec(&out.assets).map_err(|e| e.to_string())?;
    out.json["revision"] = Value::String(blake3::hash(&bytes).to_hex().to_string());
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileTemplateDecl {
    id: String,
    name: String,
    /// Without the dot.
    #[serde(default)]
    extension: String,
    file_name: Option<String>,
    variables: Option<Vec<FileTemplateVariable>>,
    /// The new file's content (`$NAME$`, `$END$` and the other template variables work).
    path: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FileTemplateVariable {
    name: String,
    prompt: String,
}

const MAX_TEMPLATE: usize = 256 << 10;

/// `[[contributes.fileTemplates]]`: an entry of the New menu.
pub(super) fn file_template(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: FileTemplateDecl = decode(FILE_TEMPLATES, decl)?;
    validate_item_id(&d.id, "file template id")?;
    title(FILE_TEMPLATES, &d.name)?;
    let what = format!("file template {:?}", d.id);
    if d.file_name.is_some() || d.variables.is_some() {
        pkg.manifest.needs_api("contributes.fileTemplates: fileName / variables", 3)?;
    }
    if let Some(name) = &d.file_name {
        let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        if name.is_empty()
            || name.len() > 255
            || name.trim() != name
            || name.ends_with('.')
            || matches!(name.as_str(), "." | "..")
            || name.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes().get(3), Some(b'1'..=b'9'))
                && stem.len() == 4)
        {
            return Err(format!("{what}: `fileName` must be a safe single file name"));
        }
    }
    let mut names = std::collections::HashSet::new();
    let variables = d.variables.unwrap_or_default();
    if variables.len() > 32 {
        return Err(format!("{what}: at most 32 variables are allowed"));
    }
    for variable in &variables {
        let name = &variable.name;
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_alphabetic() || c == b'_' || i > 0 && c.is_ascii_digit())
            || matches!(
                name.as_str(),
                "NAME"
                    | "FILE_NAME"
                    | "PACKAGE"
                    | "PACKAGE_NAME"
                    | "PROJECT_NAME"
                    | "USER"
                    | "DATE"
                    | "TIME"
                    | "YEAR"
                    | "END"
            )
            || !names.insert(name)
        {
            return Err(format!("{what}: invalid, reserved or duplicate variable name {name:?}"));
        }
        title("file template variable prompt", &variable.prompt)?;
    }
    let ext = d.extension.trim_start_matches('.');
    if (ext.is_empty() && d.file_name.is_none())
        || ext.len() > 32
        || !ext.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("{what}: `extension` is a file extension like \"md\" ({:?})", d.extension));
    }
    let body = pkg.read_text(&d.path)?;
    if body.len() > MAX_TEMPLATE {
        return Err(format!("{what}: {} is larger than {} KiB", d.path.display(), MAX_TEMPLATE >> 10));
    }
    let json = serde_json::json!({ "id": d.id, "name": d.name, "extension": ext, "body": body, "fileName": d.file_name, "variables": variables });
    let mut out = UiDecl::new(d.id.clone(), d.name.clone(), json);
    out.files = vec![d.path.clone()];
    Ok(out)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommitCheckDecl {
    id: String,
    title: String,
}

/// `[[contributes.commitChecks]]`: a before-commit check run by the plugin's
/// `commit-checker` export, listed in Commit Options.
pub(super) fn commit_check(pkg: &Package, decl: toml::Value) -> Result<UiDecl, String> {
    let d: CommitCheckDecl = decode(COMMIT_CHECKS, decl)?;
    pkg.manifest.needs_api(&format!("contributes.{COMMIT_CHECKS}"), 3)?;
    validate_item_id(&d.id, "commit check id")?;
    title(COMMIT_CHECKS, &d.title)?;
    if pkg.manifest.wasm.is_none() {
        return Err(format!("contributes.{COMMIT_CHECKS}: needs `wasm` (the checks run in the plugin's code)"));
    }
    if !pkg.manifest.capabilities.all().any(|c| *c == ide_extension::Capability::VcsRead) {
        return Err(format!("contributes.{COMMIT_CHECKS}: needs the `vcs.read` capability (checks read the commit)"));
    }
    Ok(UiDecl::new(d.id.clone(), d.title.clone(), json(&d)?))
}

const MAX_CATALOG_ENTRIES: usize = 20_000;

pub fn locale_asset(tag: &str) -> String {
    format!("locale/{tag}")
}

fn locale_tag_ok(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or_default();
    (2..=3).contains(&language.len())
        && language.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| (1..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// `locales/<tag>.json`: English source text → translation, for the plugin's own strings.
pub(super) fn locales(pkg: &Package, _decl: toml::Value) -> Result<UiDecl, String> {
    let dir = Path::new(LOCALES_DIR);
    let mut names: Vec<String> = std::fs::read_dir(pkg.dir.join(dir))
        .map_err(|e| format!("{LOCALES_DIR}: {e}"))?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    let mut tags = Vec::new();
    let mut files = Vec::new();
    let mut assets = Vec::new();
    for name in names {
        let tag = name.trim_end_matches(".json");
        if !locale_tag_ok(tag) {
            return Err(format!("{LOCALES_DIR}/{name}: the file name must be a language tag such as fr or zh-CN"));
        }
        let file = dir.join(&name);
        let text = pkg.read_text(&file)?;
        let catalog: BTreeMap<String, Value> = serde_json::from_str(&text)
            .map_err(|e| format!("{}: not a JSON object of strings ({e})", file.display()))?;
        if catalog.len() > MAX_CATALOG_ENTRIES {
            return Err(format!("{}: more than {MAX_CATALOG_ENTRIES} entries", file.display()));
        }
        if let Some((key, _)) = catalog.iter().find(|(_, v)| !v.is_string()) {
            return Err(format!("{}: the value of {key:?} is not a string", file.display()));
        }
        assets.push((locale_asset(tag), text));
        tags.push(tag.to_owned());
        files.push(file);
    }
    let mut out = UiDecl::new("locales", tags.join(", "), serde_json::json!({ "tags": tags }));
    out.files = files;
    out.assets = assets;
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

    #[test]
    fn collections_validate_every_cell_and_keep_schema_order() {
        let schema =
            parse_settings_schema(include_str!("../../../ide-plugin/tests/fixtures/settings-pages/llm.json")).unwrap();
        let profiles = &schema[0];
        let item = profiles.items.as_ref().unwrap();
        assert_eq!(
            item.properties.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            ["name", "provider", "baseUrl", "model", "enabled", "temperature", "limit"]
        );
        assert!(profiles.accepts(&serde_json::json!([item.default])));
        for (field, value) in [
            ("provider", Value::from("unknown")),
            ("enabled", Value::from("true")),
            ("limit", Value::from(1.5)),
            ("model", Value::Null),
        ] {
            let mut row = item.default.clone();
            row[field] = value;
            assert!(!profiles.accepts(&serde_json::json!([row])), "{field}");
        }
        assert!(!profiles.accepts(&serde_json::json!([{}])));
        for items in [
            r#"{"type":"number"}"#,
            r#"{"type":"array","items":{"type":"string"}}"#,
            r#"{"type":"object","properties":{}}"#,
            r#"{"type":"object","properties":{"nested":{"type":"object"}}}"#,
        ] {
            assert!(
                parse_settings_schema(&format!(r#"{{"properties":{{"x":{{"type":"array","items":{items}}}}}}}"#))
                    .is_err()
            );
        }
        let lists = parse_settings_schema(
            r#"{"properties":{"z":{"type":"array","items":{"type":"string"}},"a":{"type":"boolean"}}}"#,
        )
        .unwrap();
        assert_eq!(lists[0].key, "z");
        assert!(lists[0].accepts(&serde_json::json!(["feat", "fix"])));
        assert!(!lists[0].accepts(&serde_json::json!([1])));
    }

    #[test]
    fn schema_order_is_local_and_duplicate_fields_are_rejected() {
        let raw = r#"{"properties":{"z":{"type":"string"},"a":{"type":"boolean"}}}"#;
        let fields = parse_settings_schema(raw).unwrap();
        assert_eq!(fields.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["z", "a"]);
        let ordinary: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(ordinary["properties"].as_object().unwrap().keys().collect::<Vec<_>>(), ["a", "z"]);
        for raw in [
            r#"{"properties":{"x":{"type":"string"},"x":{"type":"boolean"}}}"#,
            r#"{"properties":{"rows":{"type":"array","items":{"type":"object","properties":{"x":{"type":"string"},"x":{"type":"boolean"}}}}}}"#,
        ] {
            assert!(parse_settings_schema(raw).unwrap_err().contains("duplicate setting key"));
        }
    }

    #[test]
    fn settings_pages_validate_manifest_files_commands_and_api() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/settings-pages");
        let source = std::fs::read_to_string(root.join("plugin.toml")).unwrap();
        let check = |source: &str| {
            let manifest = ide_extension::Manifest::parse(source)?;
            let decl = manifest.declarations(SETTINGS).into_iter().next().unwrap();
            settings(&Package::new(manifest, root.clone()), decl)
        };
        let valid = check(&source).unwrap();
        assert_eq!(valid.json["pages"].as_array().unwrap().len(), 2);
        assert_eq!(valid.json["properties"].as_array().unwrap().len(), 3);
        assert_eq!(valid.files.len(), 2);
        for bad in [
            source.replace("^1.3", "^1.2"),
            source.replace(r#"id = "llm""#, r#"id = "templates""#),
            source.replace(r#"command = "test""#, r#"command = "missing""#),
            source.replace("llm.json", "missing.json"),
            source.replace("llm.json", "../outside.json"),
            source.replace("llm.json", "templates.json"),
            source.replace(r#"id = "llm""#, r#"id = "llm.child""#),
        ] {
            assert!(check(&bad).is_err(), "{bad}");
        }
        let old = source.split("[contributes.settings]").next().unwrap().replace("^1.3", "^1.0");
        let old = format!("{old}\n[contributes.settings]\nschema = \"legacy.json\"\n");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("legacy.json"), r#"{"properties":{"enabled":{"type":"boolean"}}}"#).unwrap();
        let manifest = ide_extension::Manifest::parse(&old).unwrap();
        let decl = manifest.declarations(SETTINGS).into_iter().next().unwrap();
        assert!(settings(&Package::new(manifest, dir.path().to_path_buf()), decl).is_ok());
        for field in [r#"{"type":"string","group":"Provider"}"#, r#"{"type":"array","items":{"type":"string"}}"#] {
            std::fs::write(dir.path().join("legacy.json"), format!(r#"{{"properties":{{"x":{field}}}}}"#)).unwrap();
            for (api, valid) in [("^1.0", false), ("^1.2", false), ("^1.3", true)] {
                let manifest = ide_extension::Manifest::parse(&old.replace("^1.0", api)).unwrap();
                let decl = manifest.declarations(SETTINGS).into_iter().next().unwrap();
                assert_eq!(settings(&Package::new(manifest, dir.path().to_path_buf()), decl).is_ok(), valid);
            }
        }
    }

    fn package_with_catalogs(files: &[(&str, &str)]) -> (tempfile::TempDir, Package) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(LOCALES_DIR)).unwrap();
        for (name, text) in files {
            std::fs::write(dir.path().join(LOCALES_DIR).join(name), text).unwrap();
        }
        let src = "id = \"p\"\nname = \"P\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"";
        let pkg = Package::new(ide_extension::Manifest::parse(src).unwrap(), dir.path().to_path_buf());
        (dir, pkg)
    }

    #[test]
    fn catalogs_become_assets_by_language_tag() {
        let (_dir, pkg) = package_with_catalogs(&[
            ("fr.json", r#"{"Refresh": "Actualiser"}"#),
            ("zh-CN.json", r#"{"Refresh": "刷新"}"#),
            ("notes.txt", "ignored"),
        ]);
        let decl = locales(&pkg, toml::Value::Table(Default::default())).unwrap();
        assert_eq!(decl.json["tags"], serde_json::json!(["fr", "zh-CN"]));
        assert_eq!(decl.assets.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["locale/fr", "locale/zh-CN"]);
    }

    #[test]
    fn invalid_catalogs_are_refused() {
        for (name, text) in [
            ("fr.json", "{"),
            ("fr.json", r#"["Refresh"]"#),
            ("fr.json", r#"{"Refresh": 3}"#),
            ("fr.json", r#"{"Refresh": {"a": "b"}}"#),
            ("french!.json", "{}"),
        ] {
            let (_dir, pkg) = package_with_catalogs(&[(name, text)]);
            assert!(locales(&pkg, toml::Value::Table(Default::default())).is_err(), "{name}: {text}");
        }
    }
}
