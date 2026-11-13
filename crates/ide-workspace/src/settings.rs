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

/// Settings a project's own file can't hold: the IDE's MCP server, imported color schemes, and
/// what agents may do without asking (commands run without asking, the modes new tasks start in,
/// whether new tasks ask for approvals).
const USER_ONLY: [&[&str]; 5] = [
    &["mcpServer"],
    &["editor", "customSchemes"],
    &["agentSecurity", "allowedCommands"],
    &["agents", "defaults"],
    &["agents", "newTaskApprovals"],
];

/// The [`USER_ONLY`] setting that writing `value` at `key` would set, as a dotted key.
fn user_only_setting(key: &str, value: &Json) -> Option<String> {
    let segments: Vec<&str> = key.split('.').collect();
    USER_ONLY
        .iter()
        .find(|path| match path.split_at_checked(segments.len()) {
            Some((head, rest)) => head == segments && rest.iter().try_fold(value, |v, seg| v.get(seg)).is_some(),
            None => segments.starts_with(path),
        })
        .map(|path| path.join("."))
}

/// Applies a project layer's limits before it merges onto `below`: [`USER_ONLY`] settings are
/// dropped, and its blocked agent commands add to the ones below instead of replacing them.
fn restrict_project_layer(below: &Json, layer: &mut Json) {
    for path in USER_ONLY {
        let (last, parents) = path.split_last().expect("non-empty path");
        if let Some(table) = parents.iter().try_fold(&mut *layer, |v, seg| v.get_mut(seg)).and_then(Json::as_object_mut)
        {
            table.remove(*last);
        }
    }
    if let (Some(inherited), Some(blocked)) = (
        below.pointer("/agentSecurity/blockedCommands").and_then(Json::as_array),
        layer.pointer_mut("/agentSecurity/blockedCommands").and_then(Json::as_array_mut),
    ) {
        let mut all = inherited.clone();
        for pattern in blocked.drain(..) {
            if !all.contains(&pattern) {
                all.push(pattern);
            }
        }
        *blocked = all;
    }
    // The IDE-wide interpreter list, its view options and the project interpreters of
    // other projects belong to the user's settings, not to one project.
    if let Some(python) = layer.get_mut("languages").and_then(|l| l.get_mut("python")).and_then(Json::as_object_mut) {
        for key in ["interpreters", "hiddenInterpreters", "hideOtherProjectInterpreters", "showInterpreterPaths"] {
            python.remove(key);
        }
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

/// Older settings stored the navigation bar choice as a boolean (`showNavigationBar`,
/// `true` = enabled). Remap it into the three-state `navigationBar` before
/// deserialization, so a plain `navigationBar` field is all specta has to export.
fn normalize_navigation_bar(mut layer: Json) -> Json {
    let Some(appearance) = layer.get_mut("appearance").and_then(Json::as_object_mut) else {
        return layer;
    };
    if appearance.contains_key("navigationBar") {
        // Already migrated; leave invalid values alone so the layer is rejected as a whole.
        return layer;
    }
    let Some(legacy) = appearance.remove("showNavigationBar") else {
        return layer;
    };
    if let Some(on) = legacy.as_bool() {
        appearance.insert("navigationBar".into(), Json::String(if on { "statusBar" } else { "hidden" }.into()));
    }
    // Not a boolean: leave it out and let the default apply, rather than silently
    // turning the navigation bar back on.
    layer
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

/// Merges `layer` onto `merged` if the result still deserializes.
fn try_merge(merged: &mut Json, layer: Json) -> Result<(), String> {
    // Migrate the legacy boolean every layer carries it, before it can clobber
    // the three-state key coming from a lower-priority layer.
    let layer = normalize_navigation_bar(layer);
    let mut candidate = merged.clone();
    // Each named MCP server in a higher layer replaces a server of the same name in a lower layer as a whole.
    if let (Some(base_servers), Some(layer_servers)) = (
        candidate.pointer_mut("/agents/mcpServers").and_then(Json::as_object_mut),
        layer.pointer("/agents/mcpServers").and_then(Json::as_object),
    ) {
        for name in layer_servers.keys() {
            base_servers.remove(name);
        }
    }
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
                restrict_project_layer(&merged, &mut layer);
            }
            if let Err(e) = try_merge(&mut merged, layer) {
                tracing::warn!("{} has invalid settings, ignoring it: {e}", file.display());
            }
        }
        let mut settings: Settings = serde_json::from_value(merged).unwrap_or_default();
        if let Some(root) = self.project_file.as_deref().and_then(Path::parent).and_then(Path::parent)
            && let Ok(Some(workspace)) = crate::workspace::Workspace::load(root)
            && workspace.is_container(root)
        {
            settings.general.project_name = workspace.name.clone();
            settings.project_structure.content_roots =
                workspace.projects.iter().map(|p| ide_core::ipc_path::to_ipc(p)).collect();
        }
        settings
    }

    /// Effective (merged) settings.
    pub fn effective(&self) -> Settings {
        self.effective.read().clone()
    }

    /// Settings defined in `scope`'s file alone (without merging the other layer).
    pub fn layer(&self, scope: SettingsScope) -> Settings {
        let mut merged = defaults_json();
        if let Some(file) = self.file(scope)
            && let Some(mut layer) = read_layer(file)
        {
            if scope == SettingsScope::Project {
                restrict_project_layer(&merged, &mut layer);
            }
            if let Err(e) = try_merge(&mut merged, layer) {
                tracing::warn!("{} has invalid settings, ignoring it: {e}", file.display());
            }
        }
        serde_json::from_value(merged).unwrap_or_default()
    }

    /// Sets one dotted key, e.g. `editor.fontSize`, to a JSON value in `scope`.
    /// `null` removes the key from that layer. Unknown keys and values of the
    /// wrong type are rejected with `InvalidInput`; the file is left untouched.
    pub fn set(&self, scope: SettingsScope, key: &str, value: serde_json::Value) -> IdeResult<Settings> {
        if scope == SettingsScope::Project
            && let Some(setting) = user_only_setting(key, &value)
        {
            return Err(IdeError::invalid(format!("{setting} belongs to user settings")));
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
                restrict_project_layer(&merged, &mut layer);
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

/// A JetBrains IDE's settings folder or exported archive: every
/// entry name, and the text of the entries OpenIDEA maps (the frontend does the mapping).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JetBrainsSettings {
    pub entries: Vec<String>,
    /// Entry name → text, for `colors/*.icls` and the `options/*.xml` files OpenIDEA reads.
    pub files: BTreeMap<String, String>,
}

const JETBRAINS_MARKER: &str = "IntelliJ IDEA Global Settings";
const JETBRAINS_OPTIONS: [&str; 4] =
    ["options/editor-font.xml", "options/colors.scheme.xml", "options/editor.xml", "options/ide.general.xml"];
const JETBRAINS_MAX_TEXT: u64 = 4 << 20;

/// The settings of a JetBrains IDE: an exported `settings.zip`, or the IDE's own settings folder
/// (`options/`, `colors/`, … as an installed IDE keeps them).
pub fn read_jetbrains_settings(path: &Path) -> IdeResult<JetBrainsSettings> {
    if path.is_dir() { read_jetbrains_folder(path) } else { read_jetbrains_archive(path) }
}

fn is_mapped_jetbrains_file(name: &str) -> bool {
    JETBRAINS_OPTIONS.contains(&name)
        || name.strip_prefix("colors/").is_some_and(|n| !n.contains('/') && n.ends_with(".icls"))
}

/// Folders of the settings folder whose files are listed (their names say what the user customised).
const JETBRAINS_LISTED_DIRS: [&str; 6] = ["options", "colors", "keymaps", "codestyles", "templates", "inspection"];

fn read_jetbrains_folder(dir: &Path) -> IdeResult<JetBrainsSettings> {
    use std::io::Read;
    let real_dir = |path: &Path| path.symlink_metadata().is_ok_and(|m| m.is_dir());
    if !real_dir(dir) || !real_dir(&dir.join("options")) {
        return Err(IdeError::invalid("not a JetBrains settings folder"));
    }
    let mut entries = Vec::new();
    let mut files = BTreeMap::new();
    for sub in JETBRAINS_LISTED_DIRS {
        if !real_dir(&dir.join(sub)) {
            continue;
        }
        let mut names: Vec<String> = std::fs::read_dir(dir.join(sub))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for file in names {
            let name = format!("{sub}/{file}");
            if is_mapped_jetbrains_file(&name) {
                let mut text = String::new();
                std::fs::File::open(dir.join(sub).join(&file))?
                    .take(JETBRAINS_MAX_TEXT)
                    .read_to_string(&mut text)
                    .map_err(|e| IdeError::invalid(format!("{name}: {e}")))?;
                files.insert(name.clone(), text);
            }
            entries.push(name);
        }
    }
    // An exported archive lists `installed.txt` when plugins came along; here they sit in `plugins/`.
    if real_dir(&dir.join("plugins")) && std::fs::read_dir(dir.join("plugins")).is_ok_and(|mut d| d.next().is_some()) {
        entries.push("installed.txt".into());
    }
    Ok(JetBrainsSettings { entries, files })
}

fn read_jetbrains_archive(path: &Path) -> IdeResult<JetBrainsSettings> {
    use std::io::Read;
    let not_jetbrains = || IdeError::invalid("not a JetBrains settings archive");
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|_| not_jetbrains())?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut files = BTreeMap::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| not_jetbrains())?;
        let name = entry.name().map_err(|_| not_jetbrains())?.into_owned();
        if is_mapped_jetbrains_file(&name) {
            let mut text = String::new();
            entry
                .take(JETBRAINS_MAX_TEXT)
                .read_to_string(&mut text)
                .map_err(|e| IdeError::invalid(format!("{name}: {e}")))?;
            files.insert(name.clone(), text);
        }
        entries.push(name);
    }
    if !entries.iter().any(|e| e == JETBRAINS_MARKER) {
        return Err(not_jetbrains());
    }
    Ok(JetBrainsSettings { entries, files })
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
    fn compose_file_choices_are_project_settings_and_survive_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(proj.join(".openidea")).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        let choices = json!({"docker/stack.yml": "kept", "manifest.yml": "excluded"});
        store.set(SettingsScope::Project, "files.composeFileOverrides", choices.clone()).unwrap();
        let loaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(serde_json::to_value(&loaded.files.compose_file_overrides).unwrap(), choices);
        assert!(SettingsStore::load(&cfg, None).effective().files.compose_file_overrides.is_empty());
        assert!(store.set(SettingsScope::Project, "files.composeFileOverrides", json!({"bad.yml": "yes"})).is_err());
        assert_eq!(serde_json::to_value(&store.effective().files.compose_file_overrides).unwrap(), choices);
    }

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
    fn the_interpreter_list_and_its_view_options_are_user_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(proj.join(".openidea")).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));
        store.set(SettingsScope::Global, "languages.python.interpreters", json!(["/envs/a/bin/python"])).unwrap();
        store.set(SettingsScope::Global, "languages.python.showInterpreterPaths", json!(false)).unwrap();
        let loaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(loaded.languages.python.interpreters, ["/envs/a/bin/python"]);
        assert!(!loaded.languages.python.show_interpreter_paths);

        // A project's own settings.toml cannot change the IDE-wide list or its view options.
        std::fs::write(
            proj.join(".openidea/settings.toml"),
            "[languages.python]\ninterpreters = [\"/proj/bin/python\"]\n\
             hiddenInterpreters = [\"/envs/a/bin/python\"]\nhideOtherProjectInterpreters = true\n\
             showInterpreterPaths = true\n",
        )
        .unwrap();
        let loaded = SettingsStore::load(&cfg, Some(&proj)).effective();
        assert_eq!(loaded.languages.python.interpreters, ["/envs/a/bin/python"]);
        assert!(loaded.languages.python.hidden_interpreters.is_empty());
        assert!(!loaded.languages.python.hide_other_project_interpreters);
        assert!(!loaded.languages.python.show_interpreter_paths);
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
    fn set_console_log_colors() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&cfg).unwrap();
        let store = SettingsStore::load(&cfg, Some(&proj));

        let s = store.set(SettingsScope::Global, "console.logColors.error", json!("#ff0000")).unwrap();
        assert_eq!(s.console.log_colors.error, "#ff0000");
        assert!(!s.console.log_colors.enabled, "off by default");
        let s = store.set(SettingsScope::Global, "console.logColors.enabled", json!(true)).unwrap();
        assert!(s.console.log_colors.enabled);
        assert_eq!(s.console.log_colors.error, "#ff0000");
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

        let s =
            store.set(SettingsScope::Global, "languages.ruff.configurationDirectory", json!("shared/ruff")).unwrap();
        assert_eq!(s.languages.ruff.configuration_directory, "shared/ruff");

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
    fn unset_settings_keep_their_defaults_json_shape() {
        // `SettingsStore::set` validates a key path against this JSON: a new field that
        // serializes away when unset (`skip_serializing_if`) cannot be written.
        let commit = defaults_json()["vcs"]["commit"].clone();
        assert_eq!(
            commit,
            json!({
                "nonModal": true,
                "clearInitialMessage": false,
                "analyzeCode": true,
                "checkTodo": true,
                "reformat": false,
                "optimizeImports": false,
                "cleanup": false,
                "blankLineAfterSubject": true,
                "limitSubject": true,
                "subjectLimit": 72,
                "limitBody": false,
                "bodyLimit": 72,
                "showRightMargin": true,
                "wrapAtMargin": false,
                "disabledPluginChecks": [],
                "doubleClickOpensDiff": null,
            })
        );
    }

    #[test]
    fn tri_state_commit_setting_writes_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        let store = SettingsStore::load(&cfg, None);
        assert_eq!(store.effective().vcs.commit.double_click_opens_diff, None);
        // A layer without the key: the unset state.
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("settings.toml"), "[vcs.commit]\nnonModal = false\n").unwrap();
        assert_eq!(store.reload().vcs.commit.double_click_opens_diff, None);

        for on in [true, false] {
            let s = store.set(SettingsScope::Global, "vcs.commit.doubleClickOpensDiff", json!(on)).unwrap();
            assert_eq!(s.vcs.commit.double_click_opens_diff, Some(on));
            assert!(!store.effective().vcs.commit.non_modal);
            assert_eq!(
                std::fs::read_to_string(cfg.join("settings.toml")).unwrap(),
                format!("[vcs.commit]\nnonModal = false\ndoubleClickOpensDiff = {on}\n")
            );
            assert_eq!(SettingsStore::load(&cfg, None).effective().vcs.commit.double_click_opens_diff, Some(on));
        }

        // `null` removes the key from the layer: back to following the interface.
        let s = store.set(SettingsScope::Global, "vcs.commit.doubleClickOpensDiff", json!(null)).unwrap();
        assert_eq!(s.vcs.commit.double_click_opens_diff, None);
        assert_eq!(std::fs::read_to_string(cfg.join("settings.toml")).unwrap(), "[vcs.commit]\nnonModal = false\n");
        // A layer already lacking the table keeps its other keys when the key is set.
        let fresh = tmp.path().join("fresh");
        let store = SettingsStore::load(&fresh, None);
        let s = store.set(SettingsScope::Global, "vcs.commit.doubleClickOpensDiff", json!(true)).unwrap();
        assert_eq!(s.vcs.commit.double_click_opens_diff, Some(true));
        assert!(s.vcs.commit.non_modal);
        assert_eq!(
            std::fs::read_to_string(fresh.join("settings.toml")).unwrap(),
            "[vcs.commit]\ndoubleClickOpensDiff = true\n"
        );
        // Wrong types are still rejected.
        assert_eq!(
            store.set(SettingsScope::Global, "vcs.commit.doubleClickOpensDiff", json!("yes")).unwrap_err().kind,
            ide_core::error::ErrorKind::InvalidInput
        );
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
    fn reads_jetbrains_settings_archives() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let write = |name: &str, entries: &[(&str, &str)]| {
            let path = tmp.path().join(name);
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            for (entry, text) in entries {
                zip.start_file(*entry, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(text.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
            path
        };
        let ok = write(
            "settings.zip",
            &[
                (JETBRAINS_MARKER, ""),
                ("colors/_@user_Darcula.icls", "<scheme name=\"_@user_Darcula\"/>"),
                ("options/editor-font.xml", "<application/>"),
                ("options/vcs.xml", "<application/>"),
                ("keymaps/macOS.xml", "<keymap/>"),
            ],
        );
        let read = read_jetbrains_settings(&ok).unwrap();
        assert_eq!(read.entries.len(), 5);
        assert_eq!(read.files.keys().collect::<Vec<_>>(), ["colors/_@user_Darcula.icls", "options/editor-font.xml"]);
        assert!(read_jetbrains_settings(&write("other.zip", &[("options/editor.xml", "")])).is_err());
        std::fs::write(tmp.path().join("plain.zip"), "not a zip").unwrap();
        assert!(read_jetbrains_settings(&tmp.path().join("plain.zip")).is_err());
    }

    #[test]
    fn reads_a_jetbrains_ides_own_settings_folder_like_an_exported_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("IntelliJIdea2025.2");
        let put = |name: &str, text: &str| {
            let path = config.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        put("colors/_@user_Darcula.icls", "<scheme name=\"_@user_Darcula\"/>");
        put("colors/nested/ignored.icls", "<scheme/>");
        put("options/editor-font.xml", "<application/>");
        put("options/vcs.xml", "<application/>");
        put("keymaps/macOS.xml", "<keymap/>");
        put("plugins/Tools/lib/tools.jar", "jar");

        let read = read_jetbrains_settings(&config).unwrap();
        assert_eq!(read.files.keys().collect::<Vec<_>>(), ["colors/_@user_Darcula.icls", "options/editor-font.xml"]);
        assert_eq!(
            read.entries,
            [
                "options/editor-font.xml",
                "options/vcs.xml",
                "colors/_@user_Darcula.icls",
                "keymaps/macOS.xml",
                "installed.txt"
            ]
        );

        assert!(read_jetbrains_settings(&tmp.path().join("missing")).is_err());
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(read_jetbrains_settings(&empty).is_err(), "a folder without options/ is not a settings folder");
    }

    #[cfg(unix)]
    #[test]
    fn jetbrains_folder_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("editor-font.xml"), "outside").unwrap();
        std::fs::write(outside.join("theme.icls"), "outside").unwrap();
        symlink(&outside, config.join("options")).unwrap();
        assert!(read_jetbrains_settings(&config).is_err(), "options/ must be a real directory");

        std::fs::remove_file(config.join("options")).unwrap();
        std::fs::create_dir(config.join("options")).unwrap();
        symlink(outside.join("editor-font.xml"), config.join("options/editor-font.xml")).unwrap();
        for sub in ["colors", "keymaps", "codestyles", "templates", "inspection", "plugins"] {
            symlink(&outside, config.join(sub)).unwrap();
        }
        let read = read_jetbrains_settings(&config).unwrap();
        assert!(read.entries.is_empty());
        assert!(read.files.is_empty());
    }

    #[test]
    fn jetbrains_folder_bounds_mapped_text_like_an_archive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("options")).unwrap();
        std::fs::write(tmp.path().join("options/editor-font.xml"), vec![b'x'; JETBRAINS_MAX_TEXT as usize + 1])
            .unwrap();
        let read = read_jetbrains_settings(tmp.path()).unwrap();
        assert_eq!(read.files["options/editor-font.xml"].len(), JETBRAINS_MAX_TEXT as usize);
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

    #[test]
    fn toolbar_and_status_bar_are_shown_until_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("settings.toml"), "[appearance]\ncompactMode = true\n").unwrap();
        let store = SettingsStore::load(tmp.path(), None);
        let s = store.effective();
        assert!(s.appearance.show_main_toolbar);
        assert!(s.appearance.show_status_bar);
        let s = store.set(SettingsScope::Global, "appearance.showMainToolbar", json!(false)).unwrap();
        assert!(!s.appearance.show_main_toolbar);
        let s = store.set(SettingsScope::Global, "appearance.showStatusBar", json!(false)).unwrap();
        assert!(!s.appearance.show_status_bar);
        assert!(!store.reload().appearance.show_main_toolbar);
    }

    #[test]
    fn legacy_navigation_bar_boolean_migrates_to_the_three_state_key() {
        let tmp = tempfile::tempdir().unwrap();
        // `true` → `statusBar`, where the bar lived before the three-state choice.
        std::fs::write(tmp.path().join("settings.toml"), "[appearance]\nshowNavigationBar = true\n").unwrap();
        assert_eq!(
            SettingsStore::load(tmp.path(), None).effective().appearance.navigation_bar,
            ide_core::settings::NavigationBarPosition::StatusBar
        );
        // `false` → `hidden`.
        std::fs::write(tmp.path().join("settings.toml"), "[appearance]\nshowNavigationBar = false\n").unwrap();
        assert_eq!(
            SettingsStore::load(tmp.path(), None).effective().appearance.navigation_bar,
            ide_core::settings::NavigationBarPosition::Hidden
        );
        // An explicit three-state value wins over the migrated legacy key.
        std::fs::write(
            tmp.path().join("settings.toml"),
            "[appearance]\nshowNavigationBar = true\nnavigationBar = \"top\"\n",
        )
        .unwrap();
        assert_eq!(
            SettingsStore::load(tmp.path(), None).effective().appearance.navigation_bar,
            ide_core::settings::NavigationBarPosition::Top
        );
        // A non-boolean legacy value is dropped and the default (status bar) is used.
        std::fs::write(tmp.path().join("settings.toml"), "[appearance]\nshowNavigationBar = \"everywhere\"\n").unwrap();
        assert_eq!(
            SettingsStore::load(tmp.path(), None).effective().appearance.navigation_bar,
            ide_core::settings::NavigationBarPosition::StatusBar
        );
    }

    #[test]
    fn navigation_bar_layers_migrate_without_rewriting_other_settings() {
        use ide_core::settings::NavigationBarPosition::{Hidden, StatusBar, Top};

        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(".openidea")).unwrap();
        let global_file = tmp.path().join("settings.toml");
        let project_file = project.join(".openidea/settings.toml");
        let global =
            "# keep this comment\n[editor]\nfontSize = 17 # keep this too\n[appearance]\nnavigationBar = \"top\"\n";
        std::fs::write(&global_file, global).unwrap();
        let store = SettingsStore::load(tmp.path(), Some(&project));
        assert_eq!(store.effective().appearance.navigation_bar, Top);
        assert_eq!(std::fs::read_to_string(&global_file).unwrap(), global);

        for (layer, expected) in [
            ("[appearance]\nshowNavigationBar = false\n", Hidden),
            ("[appearance]\nshowNavigationBar = true\n", StatusBar),
            ("[appearance]\nnavigationBar = \"hidden\"\n", Hidden),
            ("[editor]\nfontSize = 19\n", Top),
        ] {
            std::fs::write(&project_file, layer).unwrap();
            assert_eq!(store.reload().appearance.navigation_bar, expected);
            assert_eq!(std::fs::read_to_string(&project_file).unwrap(), layer);
        }

        std::fs::remove_file(&project_file).unwrap();
        let legacy = global.replace("navigationBar = \"top\"", "showNavigationBar = false");
        std::fs::write(&global_file, &legacy).unwrap();
        assert_eq!(store.reload().appearance.navigation_bar, Hidden);
        let updated = store.set(SettingsScope::Global, "appearance.navigationBar", serde_json::json!("top")).unwrap();
        assert_eq!(updated.appearance.navigation_bar, Top);
        assert_eq!(updated.editor.font_size, 17.0);
        let written = std::fs::read_to_string(&global_file).unwrap();
        assert!(written.starts_with(&legacy));
        assert_eq!(
            store.set(SettingsScope::Global, "appearance.navigationBar", Json::Null).unwrap().appearance.navigation_bar,
            Hidden
        );
        assert_eq!(std::fs::read_to_string(&global_file).unwrap(), legacy);
    }

    #[test]
    fn mcp_server_is_default_off_and_cannot_be_enabled_by_a_project() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(".openidea")).unwrap();
        std::fs::write(project.join(".openidea/settings.toml"), "[mcpServer]\nenabled = true\n").unwrap();
        let settings = SettingsStore::load(&config, Some(&project));
        assert!(!settings.effective().mcp_server.enabled);
        assert!(settings.set(SettingsScope::Project, "mcpServer.enabled", serde_json::json!(true)).is_err());
        assert!(
            settings
                .set(SettingsScope::Global, "mcpServer.enabled", serde_json::json!(true))
                .unwrap()
                .mcp_server
                .enabled
        );
    }

    #[test]
    fn a_project_file_can_only_add_to_the_agent_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(".openidea")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.toml"),
            "[agentSecurity]\nallowedCommands = [\"git status\"]\nblockedCommands = [\"git push*\"]\n\n\
             [agents.defaults.claude]\nmodel = \"opus\"\n",
        )
        .unwrap();
        let project_file = project.join(".openidea/settings.toml");
        std::fs::write(
            &project_file,
            "[agentSecurity]\nallowedCommands = [\"node\"]\nblockedCommands = [\"npm publish*\"]\n\n\
             [agents.defaults.claude]\nmode = \"bypassPermissions\"\n\n\
             [agents.defaults.codex]\nmode = \"full-access\"\n",
        )
        .unwrap();
        let store = SettingsStore::load(&config, Some(&project));
        let s = store.effective();
        assert_eq!(s.agent_security.allowed_commands, ["git status"]);
        assert_eq!(s.agent_security.blocked_commands, ["git push*", "npm publish*"]);
        assert_eq!(
            s.agents.defaults,
            BTreeMap::from([("claude".to_owned(), BTreeMap::from([("model".to_owned(), "opus".to_owned())]))])
        );
        let layer = store.layer(SettingsScope::Project);
        assert!(layer.agent_security.allowed_commands.is_empty());
        assert!(layer.agents.defaults.is_empty());

        // An empty project list doesn't clear the user's, nor the built-in one.
        std::fs::write(&project_file, "[agentSecurity]\nblockedCommands = []\n").unwrap();
        assert_eq!(store.reload().agent_security.blocked_commands, ["git push*"]);
        std::fs::remove_file(config.join("settings.toml")).unwrap();
        assert_eq!(
            store.reload().agent_security.blocked_commands,
            ide_core::settings::AgentSecuritySettings::default().blocked_commands
        );

        for (key, value) in [
            ("agentSecurity.allowedCommands", json!(["node"])),
            ("agentSecurity", json!({"allowedCommands": ["node"], "blockedCommands": []})),
            ("agents.defaults", json!({"claude": {"mode": "bypassPermissions"}})),
            ("agents.defaults.claude", json!({"mode": "bypassPermissions"})),
            ("agents.defaults.claude.mode", json!("bypassPermissions")),
            ("agents", json!({"defaults": {"codex": {"mode": "full-access"}}})),
        ] {
            assert!(store.set(SettingsScope::Project, key, value).is_err(), "{key}");
        }
        let s = store.set(SettingsScope::Project, "agentSecurity.blockedCommands", json!(["curl*"])).unwrap();
        assert!(s.agent_security.blocked_commands.ends_with(&["curl*".to_owned()]));
        assert!(s.agent_security.blocked_commands.contains(&"rm -rf /".to_owned()));
        let s = store.set(SettingsScope::Project, "agents.showCost", json!(true)).unwrap();
        assert!(s.agents.show_cost);
    }

    #[test]
    fn new_task_approvals_are_a_user_setting() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let project = tmp.path().join("project");
        std::fs::create_dir_all(project.join(".openidea")).unwrap();
        std::fs::write(project.join(".openidea/settings.toml"), "[agents]\nnewTaskApprovals = \"ask\"\n").unwrap();
        let settings = SettingsStore::load(&config, Some(&project));
        use ide_core::settings::NewTaskApprovals;
        assert_eq!(settings.effective().agents.new_task_approvals, NewTaskApprovals::Bypass);
        assert!(settings.set(SettingsScope::Project, "agents.newTaskApprovals", json!("bypass")).is_err());
        assert!(settings.set(SettingsScope::Project, "agents", json!({"newTaskApprovals": "bypass"})).is_err());
        let s = settings.set(SettingsScope::Global, "agents.newTaskApprovals", json!("ask")).unwrap();
        assert_eq!(s.agents.new_task_approvals, NewTaskApprovals::Ask);
        std::fs::write(project.join(".openidea/settings.toml"), "[agents]\nnewTaskApprovals = \"bypass\"\n").unwrap();
        assert_eq!(settings.reload().agents.new_task_approvals, NewTaskApprovals::Ask);
    }
}
