use ide_core::settings::Settings;
use ide_core::{IdeError, IdeResult, project_dir};
use parking_lot::RwLock;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item, Table, TableLike};

/// Layered settings: defaults → `<app-config>/settings.toml` → `<project>/.openidea/settings.toml`.
/// Writes go through `toml_edit` so user comments survive.
///
/// TOML keys use the camelCase names of the serde [`Settings`] struct, e.g.
/// `[editor]` / `fontSize = 14`. A layer that fails to parse or holds values of
/// the wrong type is logged and ignored as a whole.
///
/// One default is dynamic: on the first launch (no layer sets `appearance.locale`),
/// [`SettingsStore::adopt_system_locale`] adopts the operating system's language —
/// `zh` on Simplified Chinese systems, `en` elsewhere — and persists it, so later
/// launches keep it until the user picks a language in Settings.
const PROJECT_FILE: &str = "settings.toml";

pub struct SettingsStore {
    global_file: PathBuf,
    project_file: Option<PathBuf>,
    effective: RwLock<Settings>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    Global,
    Project,
}

fn remove_custom_schemes(layer: &mut Json) {
    if let Some(editor) = layer.get_mut("editor").and_then(Json::as_object_mut) {
        editor.remove("customSchemes");
    }
}

fn defaults_json() -> Json {
    serde_json::to_value(Settings::default()).expect("settings serialize")
}

fn deep_merge(base: &mut Json, layer: Json) {
    match (base, layer) {
        (Json::Object(base), Json::Object(layer)) => {
            for (k, v) in layer {
                match base.get_mut(&k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, layer) => *base = layer,
    }
}

fn parse_layer(text: &str) -> Result<Json, String> {
    let table: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
    serde_json::to_value(table).map_err(|e| e.to_string())
}

/// Reads one layer; `None` when missing or invalid (logged).
fn read_layer(file: &Path) -> Option<Json> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!("cannot read {}: {e}", file.display());
            return None;
        }
    };
    match parse_layer(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("{} is not valid TOML, ignoring it: {e}", file.display());
            None
        }
    }
}

/// The UI locale implied by a system locale tag: Simplified Chinese (`zh-CN`,
/// `zh-Hans-CN`, `zh_CN.UTF-8`…) → `zh`, everything else → `en`. Accepts BCP 47
/// and POSIX forms.
pub fn locale_for_system(tag: Option<&str>) -> &'static str {
    // No locale reported (unsupported platform): fall back to English.
    let Some(tag) = tag else { return "en" };
    // Strip a POSIX codeset / modifier (`zh_CN.UTF-8@cjk`) before splitting.
    let base = tag.split(['.', '@']).next().unwrap_or(tag);
    let mut parts = base.split(['-', '_']);
    // Only Chinese has a bundled translation; every other language stays English.
    if !parts.next().is_some_and(|l| l.eq_ignore_ascii_case("zh")) {
        return "en";
    }
    // Of the Chinese variants, only Simplified gets the Chinese catalog;
    // Traditional (`zh-TW`, `zh-HK`, `zh-Hant`…) stays English.
    let traditional = parts.any(|p| matches!(p.to_ascii_lowercase().as_str(), "hant" | "tw" | "hk" | "mo"));
    if traditional { "en" } else { "zh" }
}

/// The UI locale for a fresh install, taken from the operating system.
fn default_locale() -> String {
    locale_for_system(sys_locale::get_locale().as_deref()).to_owned()
}

/// Merges `layer` onto `merged` if the result still deserializes.
fn try_merge(merged: &mut Json, layer: Json) -> Result<(), String> {
    let mut candidate = merged.clone();
    deep_merge(&mut candidate, layer);
    serde_json::from_value::<Settings>(candidate.clone()).map_err(|e| e.to_string())?;
    *merged = candidate;
    Ok(())
}

fn json_to_toml(value: &Json) -> IdeResult<toml_edit::Value> {
    Ok(match value {
        Json::Null => return Err(IdeError::invalid("null is not allowed inside a settings value")),
        Json::Bool(b) => (*b).into(),
        Json::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().ok_or_else(|| IdeError::invalid(format!("unsupported number {n}")))?.into(),
        },
        Json::String(s) => s.as_str().into(),
        Json::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for item in items {
                arr.push(json_to_toml(item)?);
            }
            arr.into()
        }
        Json::Object(map) => {
            let mut t = toml_edit::InlineTable::new();
            // TOML has no null: an unset optional field is left out.
            for (k, v) in map.iter().filter(|(_, v)| !v.is_null()) {
                t.insert(k, json_to_toml(v)?);
            }
            t.into()
        }
    })
}

/// Sets (or removes, for `None`) a dotted key in a TOML document. A new
/// `map_entry` object becomes a `[languageServers.ruff]` table rather than an
/// inline table under an explicit `[languageServers]` header.
fn set_in_document(doc: &mut DocumentMut, segments: &[&str], value: Option<toml_edit::Value>, map_entry: bool) {
    let (last, parents) = segments.split_last().expect("non-empty key");
    let mut table: &mut dyn TableLike = doc.as_table_mut();
    let mut in_inline = false;
    for seg in parents {
        if !table.get(seg).is_some_and(Item::is_table_like) {
            if value.is_none() {
                return;
            }
            // Implicit: no `[languageServers]` header above `[languageServers.ruff]`.
            let mut new = Table::new();
            new.set_implicit(true);
            table.insert(seg, Item::Table(new));
        }
        let item = table.get_mut(seg).expect("table just ensured");
        in_inline |= item.is_inline_table();
        table = item.as_table_like_mut().expect("table just ensured");
    }
    match value {
        Some(toml_edit::Value::InlineTable(t))
            if map_entry && !in_inline && !matches!(table.get(last), Some(Item::Value(_))) =>
        {
            table.insert(last, Item::Table(t.into_table()));
        }
        Some(v) => match table.get_mut(last) {
            // Keep the key's decor (comments, spacing) when replacing a value.
            Some(Item::Value(existing)) => {
                let decor = existing.decor().clone();
                *existing = v;
                *existing.decor_mut() = decor;
            }
            _ => {
                table.insert(last, Item::Value(v));
            }
        },
        None => {
            table.remove(last);
        }
    }
}

impl SettingsStore {
    pub fn load(config_dir: &Path, project_root: Option<&Path>) -> Self {
        let store = Self {
            global_file: config_dir.join("settings.toml"),
            project_file: project_root.map(|r| project_dir::path(r, PROJECT_FILE)),
            effective: RwLock::new(Settings::default()),
        };
        store.reload();
        store
    }

    pub fn file(&self, scope: SettingsScope) -> Option<&Path> {
        match scope {
            SettingsScope::Global => Some(&self.global_file),
            SettingsScope::Project => self.project_file.as_deref(),
        }
    }

    fn layers(&self) -> Vec<(SettingsScope, PathBuf)> {
        [SettingsScope::Global, SettingsScope::Project]
            .into_iter()
            .filter_map(|scope| Some((scope, self.file(scope)?.to_path_buf())))
            .collect()
    }

    fn compute(&self) -> Settings {
        let mut merged = defaults_json();
        for (scope, file) in self.layers() {
            let Some(mut layer) = read_layer(&file) else { continue };
            if scope == SettingsScope::Project {
                remove_custom_schemes(&mut layer);
            }
            if let Err(e) = try_merge(&mut merged, layer) {
                tracing::warn!("{} has invalid settings, ignoring it: {e}", file.display());
            }
        }
        let mut settings: Settings = serde_json::from_value(merged).unwrap_or_default();
        if let Some(root) = self.project_file.as_deref().and_then(Path::parent).and_then(Path::parent)
            && let Ok(Some(workspace)) = crate::workspace::Workspace::load(root)
        {
            settings.general.project_name = workspace.name;
            settings.project_structure.content_roots =
                workspace.projects.iter().map(|p| ide_core::ipc_path::to_ipc(p)).collect();
        }
        settings
    }

    /// Effective (merged) settings.
    pub fn effective(&self) -> Settings {
        self.effective.read().clone()
    }

    /// Sets one dotted key, e.g. `editor.fontSize`, to a JSON value in `scope`.
    /// `null` removes the key from that layer. Unknown keys and values of the
    /// wrong type are rejected with `InvalidInput`; the file is left untouched.
    pub fn set(&self, scope: SettingsScope, key: &str, value: serde_json::Value) -> IdeResult<Settings> {
        if scope == SettingsScope::Project
            && (key == "editor.customSchemes"
                || key.starts_with("editor.customSchemes.")
                || (key == "editor" && value.get("customSchemes").is_some()))
        {
            return Err(IdeError::invalid("custom color schemes belong to user settings"));
        }
        let file = self.file(scope).ok_or_else(|| IdeError::invalid("no project is open"))?.to_path_buf();
        let segments: Vec<&str> = key.split('.').collect();
        if segments.iter().any(|s| s.is_empty()) {
            return Err(IdeError::invalid(format!("invalid settings key {key:?}")));
        }
        let defaults = defaults_json();
        let mut cursor = &defaults;
        let mut map_entry = false;
        for (i, seg) in segments.iter().enumerate() {
            match cursor.get(seg) {
                Some(next) => cursor = next,
                // An entry of a map setting (`languageServers.rust-analyzer`): the merge below validates it.
                None if cursor.as_object().is_some_and(|m| m.is_empty()) => {
                    map_entry = i + 1 == segments.len();
                    break;
                }
                None => return Err(IdeError::invalid(format!("unknown setting {key:?}"))),
            }
        }

        let text = match std::fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let mut doc: DocumentMut = text
            .parse()
            .map_err(|e| IdeError::invalid(format!("{} is not valid TOML; fix it first: {e}", file.display())))?;
        let new_value = if value.is_null() { None } else { Some(json_to_toml(&value)?) };
        set_in_document(&mut doc, &segments, new_value, map_entry);
        let new_text = doc.to_string();

        // Validate the resulting stack before touching the disk.
        let mut merged = defaults_json();
        for (layer_scope, layer_file) in self.layers() {
            let is_target = layer_scope == scope;
            let layer = if is_target { parse_layer(&new_text).ok() } else { read_layer(&layer_file) };
            let Some(mut layer) = layer else { continue };
            if layer_scope == SettingsScope::Project {
                remove_custom_schemes(&mut layer);
            }
            if let Err(e) = try_merge(&mut merged, layer)
                && is_target
            {
                return Err(IdeError::invalid(format!("invalid value for {key}: {e}")));
            }
        }

        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        ide_vfs::write_atomic(&file, new_text.as_bytes())?;
        Ok(self.reload())
    }

    /// Re-reads all layers from disk.
    pub fn reload(&self) -> Settings {
        let settings = self.compute();
        *self.effective.write() = settings.clone();
        settings
    }

    /// First launch only: when the global layer doesn't set `appearance.locale`
    /// yet, adopt the operating system's language as the default — `zh` on
    /// Simplified Chinese systems, `en` elsewhere — and persist it. An existing
    /// choice (the user's or an earlier adoption) is left untouched, so later
    /// launches never override it with the OS language.
    ///
    /// Only the global layer is consulted: it is the one the user's Settings
    /// writes go to, and adoption runs at startup before any project is open
    /// (a project-scoped language still wins for its own project).
    pub fn adopt_system_locale(&self) -> IdeResult<Settings> {
        // `read_layer` is `None` for a missing file as well as a broken one, so
        // a fresh install falls through to the adoption branch below (a broken
        // file then fails in `set` and is reported by the caller).
        let set = read_layer(&self.global_file)
            .is_some_and(|layer| layer.get("appearance").and_then(|a| a.get("locale")).is_some());
        if set {
            // A stored language always wins over the OS; never re-detect.
            return Ok(self.effective());
        }
        // Persist the detected language, making later launches treat it like
        // an explicit setting (the user can still change it in Settings).
        self.set(SettingsScope::Global, "appearance.locale", Json::String(default_locale()))
    }

    /// File › Manage IDE Settings › Export Settings…: the global layer plus
    /// frontend-held IDE state (`storage`: keymaps' companions such as live
    /// templates, macros) as one JSON file.
    pub fn export_bundle(&self, path: &Path, storage: BTreeMap<String, String>) -> IdeResult<()> {
        let settings = match std::fs::read_to_string(&self.global_file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let bundle = SettingsBundle { format: BUNDLE_FORMAT.into(), version: BUNDLE_VERSION, settings, storage };
        let json = serde_json::to_vec_pretty(&bundle).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(path, &json)?;
        Ok(())
    }

    /// Import Settings…: replaces the global layer with the bundle's (validated
    /// first) and returns the new effective settings and the bundle's `storage`.
    pub fn import_bundle(&self, path: &Path) -> IdeResult<(Settings, BTreeMap<String, String>)> {
        let bytes = std::fs::read(path)?;
        let bundle: SettingsBundle = serde_json::from_slice(&bytes)
            .map_err(|e| IdeError::invalid(format!("not an OpenIDEA settings file: {e}")))?;
        if bundle.format != BUNDLE_FORMAT || bundle.version > BUNDLE_VERSION {
            return Err(IdeError::invalid("not an OpenIDEA settings file, or one from a newer version"));
        }
        let layer = parse_layer(&bundle.settings).map_err(|e| IdeError::invalid(format!("invalid settings: {e}")))?;
        try_merge(&mut defaults_json(), layer).map_err(|e| IdeError::invalid(format!("invalid settings: {e}")))?;
        if let Some(dir) = self.global_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        ide_vfs::write_atomic(&self.global_file, bundle.settings.as_bytes())?;
        Ok((self.reload(), bundle.storage))
    }
}

const BUNDLE_FORMAT: &str = "openidea-settings";
const BUNDLE_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct SettingsBundle {
    format: String,
    version: u32,
    /// The global `settings.toml`, verbatim (comments included).
    settings: String,
    #[serde(default)]
    storage: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn custom_color_schemes_are_user_settings_and_survive_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(proj.join(".openidea")).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        let schemes = json!({"custom-forest": {"name": "Forest", "parent": "dark", "attributes": {
            "keyword": {"foreground": "#99dd77", "bold": true}
        }}});
        store.set(SettingsScope::Global, "editor.customSchemes", schemes.clone()).unwrap();
        store.set(SettingsScope::Global, "editor.colorScheme", json!("custom-forest")).unwrap();
        let loaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(loaded.editor.color_scheme, "custom-forest");
        assert_eq!(serde_json::to_value(&loaded.editor.custom_schemes).unwrap(), schemes);
        assert!(store.set(SettingsScope::Project, "editor.customSchemes", schemes.clone()).is_err());
        assert!(
            store
                .set(SettingsScope::Project, "editor.customSchemes.custom-other", schemes["custom-forest"].clone())
                .is_err()
        );
        assert!(store.set(SettingsScope::Project, "editor", json!({"customSchemes": schemes})).is_err());
        std::fs::write(
            proj.join(".openidea/settings.toml"),
            "[editor.customSchemes.custom-forest]\nname = \"Project\"\nparent = \"light\"\nattributes = {}\n",
        )
        .unwrap();
        assert_eq!(store.reload().editor.custom_schemes["custom-forest"].name, "Forest");
        store.set(SettingsScope::Global, "editor.customSchemes", json!({})).unwrap();
        assert!(SettingsStore::load(&cfg, Some(&proj)).effective().editor.custom_schemes.is_empty());
    }

    #[test]
    fn layering_and_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(proj.join(".openidea")).unwrap();
        std::fs::write(cfg.join("settings.toml"), "keymap = \"vscode\"\n[editor]\nfontSize = 15\ntabSize = 2\n")
            .unwrap();
        std::fs::write(proj.join(".openidea/settings.toml"), "[editor]\ntabSize = 8\n").unwrap();

        let s = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(s.keymap, "vscode");
        assert_eq!(s.editor.font_size, 15.0);
        assert_eq!(s.editor.tab_size, 8);
        assert_eq!(s.editor.font_family, "JetBrains Mono");

        // Invalid project layer: ignored, global still applies.
        std::fs::write(proj.join(".openidea/settings.toml"), "[editor]\ntabSize = \"wide\"\n").unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        assert_eq!(store.effective().editor.tab_size, 2);
        // Broken TOML in the global layer: defaults.
        std::fs::write(cfg.join("settings.toml"), "[editor\n").unwrap();
        assert_eq!(store.reload().editor.font_size, 13.0);

        let global_only = SettingsStore::load(&cfg, None);
        assert_eq!(
            global_only.set(SettingsScope::Project, "editor.fontSize", json!(1)).unwrap_err().kind,
            ide_core::error::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn system_locale_maps_to_a_ui_locale() {
        for (tag, locale) in [
            (None, "en"),
            (Some(""), "en"),
            (Some("en-US"), "en"),
            (Some("en_GB.UTF-8"), "en"),
            (Some("ja-JP"), "en"),
            (Some("fr-FR"), "en"),
            (Some("zh"), "zh"),
            (Some("zh-CN"), "zh"),
            (Some("zh-Hans"), "zh"),
            (Some("zh-Hans-CN"), "zh"),
            (Some("zh_CN.UTF-8"), "zh"),
            (Some("zh_CN.UTF-8@cjk"), "zh"),
            (Some("zh-SG"), "zh"),
            (Some("zh-TW"), "en"),
            (Some("zh-Hant"), "en"),
            (Some("zh-Hant-TW"), "en"),
            (Some("zh_HK.UTF-8"), "en"),
        ] {
            assert_eq!(locale_for_system(tag), locale, "system tag {tag:?}");
        }
    }

    #[test]
    fn first_launch_adopts_the_system_language_and_an_explicit_choice_wins() {
        let tmp = tempfile::tempdir().unwrap();

        // Fresh install: before adoption the static default applies, after it the
        // OS language is detected and persisted.
        let cfg = tmp.path().join("cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        let store = SettingsStore::load(&cfg, None);
        assert_eq!(store.effective().appearance.locale, "en");
        assert_eq!(store.adopt_system_locale().unwrap().appearance.locale, default_locale());
        assert_eq!(SettingsStore::load(&cfg, None).effective().appearance.locale, default_locale());
        assert!(std::fs::read_to_string(cfg.join("settings.toml")).unwrap().contains("locale"));

        // Existing settings without a language (older versions) are adopted too.
        let cfg2 = tmp.path().join("cfg2");
        std::fs::create_dir_all(&cfg2).unwrap();
        std::fs::write(cfg2.join("settings.toml"), "[editor]\nfontSize = 16\n").unwrap();
        let upgraded = SettingsStore::load(&cfg2, None);
        assert_eq!(upgraded.effective().editor.font_size, 16.0);
        assert_eq!(upgraded.adopt_system_locale().unwrap().appearance.locale, default_locale());
        assert_eq!(upgraded.effective().editor.font_size, 16.0);

        // The user's explicit choice survives adoption (i.e. later launches),
        // whatever the OS language is.
        for choice in ["en", "zh"] {
            let store = SettingsStore::load(&cfg, None);
            let s = store.set(SettingsScope::Global, "appearance.locale", json!(choice)).unwrap();
            assert_eq!(s.appearance.locale, choice);
            assert_eq!(store.adopt_system_locale().unwrap().appearance.locale, choice);
            assert_eq!(SettingsStore::load(&cfg, None).effective().appearance.locale, choice);
        }

        // Removing the choice falls back to the static default until the next
        // launch adopts the OS language again.
        let s = store.set(SettingsScope::Global, "appearance.locale", Json::Null).unwrap();
        assert_eq!(s.appearance.locale, "en");
        assert_eq!(store.adopt_system_locale().unwrap().appearance.locale, default_locale());
    }

    #[test]
    fn set_preserves_comments_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        let original = "# My settings\n\n[editor]\n# bigger is better\nfontSize = 14 # pt\nsoftWrap = true\n";
        std::fs::write(cfg.join("settings.toml"), original).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));

        let s = store.set(SettingsScope::Global, "editor.fontSize", json!(16)).unwrap();
        assert_eq!(s.editor.font_size, 16.0);
        assert!(s.editor.soft_wrap);
        let text = std::fs::read_to_string(cfg.join("settings.toml")).unwrap();
        assert_eq!(text, "# My settings\n\n[editor]\n# bigger is better\nfontSize = 16 # pt\nsoftWrap = true\n");

        let s = store.set(SettingsScope::Global, "appearance.theme", json!("light")).unwrap();
        assert_eq!(s.appearance.theme, "light");
        let s = store.set(SettingsScope::Global, "files.exclude", json!(["**/dist"])).unwrap();
        assert_eq!(s.files.exclude, vec!["**/dist".to_string()]);
        let s = store.set(SettingsScope::Global, "editor.lineHeight", json!(22.5)).unwrap();
        assert_eq!(s.editor.line_height, 22.5);
        // An unset optional field (null) inside an object is left out.
        let ssh = json!([{ "id": "a", "name": "mac", "host": "macmini", "port": null, "user": "" }]);
        let s = store.set(SettingsScope::Global, "ssh.configs", ssh).unwrap();
        assert_eq!(s.ssh.configs[0].port, None);
        assert!(!std::fs::read_to_string(cfg.join("settings.toml")).unwrap().contains("port"));
        // Map-valued setting whose keys contain dots, replaced as a whole.
        let s = store
            .set(
                SettingsScope::Global,
                "appearance.statusBarWidgets",
                json!({"perf.memory": true, "editor.caret": false}),
            )
            .unwrap();
        assert_eq!(s.appearance.status_bar_widgets.get("perf.memory"), Some(&true));
        let s =
            store.set(SettingsScope::Global, "appearance.statusBarWidgets", json!({"editor.caret": false})).unwrap();
        assert_eq!(s.appearance.status_bar_widgets.len(), 1);
        // One entry of a map setting, set and removed on its own.
        let s = store
            .set(
                SettingsScope::Global,
                "languageServers.rust-analyzer",
                json!({"args": ["--log"], "initializationOptions": {"check": {"command": "clippy"}}}),
            )
            .unwrap();
        let ra = &s.language_servers["rust-analyzer"];
        assert!(ra.enabled);
        assert_eq!(ra.args.as_deref(), Some(&["--log".to_string()][..]));
        assert_eq!(ra.initialization_options, Some(json!({"check": {"command": "clippy"}})));
        assert_eq!(
            store
                .set(SettingsScope::Global, "languageServers.rust-analyzer", json!({"enabled": "no"}))
                .unwrap_err()
                .kind,
            ide_core::error::ErrorKind::InvalidInput
        );
        let s = store.set(SettingsScope::Global, "languageServers.rust-analyzer", json!(null)).unwrap();
        assert!(s.language_servers.is_empty());
        // New parent tables stay implicit: no empty `[languageServers]` header.
        let fresh = tmp.path().join("fresh");
        let s = SettingsStore::load(&fresh, None)
            .set(SettingsScope::Global, "languageServers.ruff.languages", json!(["python"]))
            .unwrap();
        assert!(s.language_servers["ruff"].is_custom());
        let text = std::fs::read_to_string(fresh.join("settings.toml")).unwrap();
        assert_eq!(text, "[languageServers.ruff]\nlanguages = [\"python\"]\n");
        // A whole new entry: a table of its own, still under an implicit parent.
        let added = tmp.path().join("added");
        let s = SettingsStore::load(&added, None)
            .set(
                SettingsScope::Global,
                "languageServers.ruff",
                json!({"command": "ruff", "args": ["server"], "languages": ["python"]}),
            )
            .unwrap();
        assert_eq!(s.language_servers["ruff"].command, "ruff");
        let text = std::fs::read_to_string(added.join("settings.toml")).unwrap();
        assert_eq!(text, "[languageServers.ruff]\nargs = [\"server\"]\ncommand = \"ruff\"\nlanguages = [\"python\"]\n");

        // Project layer is created on demand and wins.
        let s = store.set(SettingsScope::Project, "editor.fontSize", json!(12)).unwrap();
        assert_eq!(s.editor.font_size, 12.0);
        assert_eq!(std::fs::read_to_string(proj.join(".openidea/settings.toml")).unwrap(), "[editor]\nfontSize = 12\n");
        let s = store.set(SettingsScope::Project, "editor.fontSize", json!(null)).unwrap();
        assert_eq!(s.editor.font_size, 16.0);

        let err = |key: &str, v: Json| store.set(SettingsScope::Global, key, v).unwrap_err().kind;
        assert_eq!(err("editor.fontSize", json!("huge")), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(err("editor.nope", json!(1)), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(err("editor..x", json!(1)), ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(store.effective().editor.font_size, 16.0);

        let reloaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(reloaded, store.effective());
    }

    #[test]
    fn inspection_profiles_live_in_their_layers() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        store.set(SettingsScope::Global, "inspections.default", json!({"lsp:ruff:F401": {"enabled": false}})).unwrap();
        store.set(SettingsScope::Project, "inspections.project", json!({"lsp:ruff": {"severity": "typo"}})).unwrap();
        let s = store.set(SettingsScope::Project, "inspections.profile", json!("project")).unwrap();
        assert_eq!(s.inspections.profile, "project");
        assert_eq!(s.inspections.default["lsp:ruff:F401"].enabled, Some(false));
        assert_eq!(s.inspections.project["lsp:ruff"].severity, Some(ide_core::settings::InspectionLevel::Typo));
        assert!(store.set(SettingsScope::Project, "inspections.project", json!({"x": {"severity": "loud"}})).is_err());
        let global = std::fs::read_to_string(cfg.join("settings.toml")).unwrap();
        assert!(!global.contains("profile"), "{global}");
    }

    #[test]
    fn settings_bundle_round_trips_and_rejects_invalid_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        let source = SettingsStore::load(&a, None);
        source.set(SettingsScope::Global, "editor.fontSize", json!(17)).unwrap();
        source.set(SettingsScope::Global, "general.powerSaveMode", json!(true)).unwrap();
        let file = tmp.path().join("settings.json");
        let storage = BTreeMap::from([("openidea.macros.v1".to_owned(), "[]".to_owned())]);
        source.export_bundle(&file, storage.clone()).unwrap();

        let target = SettingsStore::load(&b, None);
        let (settings, imported) = target.import_bundle(&file).unwrap();
        assert_eq!(settings.editor.font_size, 17.0);
        assert!(settings.general.power_save_mode);
        assert_eq!(imported, storage);
        assert_eq!(target.effective(), source.effective());

        let bad = tmp.path().join("bad.json");
        std::fs::write(&bad, r#"{"format":"openidea-settings","version":1,"settings":"[editor]\nfontSize = \"x\"\n"}"#)
            .unwrap();
        assert!(target.import_bundle(&bad).is_err());
        std::fs::write(&bad, r#"{"format":"other","version":1,"settings":""}"#).unwrap();
        assert!(target.import_bundle(&bad).is_err());
        assert_eq!(target.effective().editor.font_size, 17.0);
    }

    #[test]
    fn main_toolbar_can_be_set_and_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(tmp.path(), None);
        let s = store
            .set(
                SettingsScope::Global,
                "appearance.mainToolbar",
                json!({"left": ["project"], "right": [], "hidden": ["vcs.branch"]}),
            )
            .unwrap();
        let toolbar = s.appearance.main_toolbar.unwrap();
        assert_eq!(toolbar.left, ["project"]);
        assert_eq!(toolbar.hidden, ["vcs.branch"]);
        let s = store.set(SettingsScope::Global, "appearance.mainToolbar", Json::Null).unwrap();
        assert_eq!(s.appearance.main_toolbar, None);
    }
}
