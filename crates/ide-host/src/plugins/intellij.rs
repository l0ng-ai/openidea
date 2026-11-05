//! IntelliJ theme plugins, read for import as OpenIDEA theme plugins: a
//! Marketplace download (a `.jar`, or a `.zip` holding the plugin's
//! `lib/*.jar`), an installed plugin's folder or a loose `.theme.json`; and the
//! theme plugins of the JetBrains IDEs on this machine, with the theme each IDE
//! is set to (`options/laf.xml`).
//!
//! Nothing is converted here: the UI maps IntelliJ keys onto design tokens
//! (`src/features/plugins/intellijTheme.ts`, shared with `pnpm
//! theme:import-intellij`) and [`super::PluginHost::stage_package`] writes the
//! result for the install page, which validates it like any package.

use ide_core::{IdeError, IdeResult, IpcPath};
use quick_xml::{Reader, XmlVersion, events::Event};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::OsString;
use std::io::{Cursor, Read, Seek};
use std::path::{Path, PathBuf};

/// A descriptor, theme or editor scheme larger than this is not one.
pub(super) const MAX_FILE: u64 = 4 << 20;
/// The descriptor IntelliJ plugins ship in their jar.
pub(super) const PLUGIN_XML: &str = "META-INF/plugin.xml";
/// A plugin jar read into memory from a Marketplace zip.
const MAX_JAR: u64 = 64 << 20;
/// Jars of one plugin looked into.
const MAX_JARS: usize = 64;
/// All the jars read into memory from one Marketplace zip.
const MAX_NESTED: u64 = 256 << 20;
/// Descriptors read for one plugin: `plugin.xml` and those it includes.
const MAX_DESCRIPTORS: usize = 64;

/// A theme plugin's themes, as read from its files.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntellijThemeSource {
    /// The plugin's `<name>`, or the theme's for a loose file.
    pub name: String,
    pub plugin_id: Option<String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub themes: Vec<IntellijThemeFile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntellijThemeFile {
    /// The `themeProvider` id (what `laf.xml` names), or the file name without `.theme.json`.
    pub id: String,
    /// The `.theme.json`, comments removed.
    pub theme: String,
    /// The editor scheme (`.icls` XML) its `editorScheme` names, when the plugin has it.
    pub editor_scheme: Option<String>,
}

/// A theme of a plugin installed in a JetBrains IDE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIntellijTheme {
    /// The IDE and its version: `IntelliJ IDEA 2025.2`.
    pub ide: String,
    /// The plugin's name.
    pub plugin: String,
    /// What to import: the plugin's folder or jar.
    pub path: IpcPath,
    pub theme_id: String,
    pub theme_name: String,
    pub dark: bool,
    /// The IDE is set to this theme.
    pub active: bool,
}

/// Reads the themes of an IntelliJ theme plugin (a `.jar`, a Marketplace
/// `.zip`, an installed plugin's folder) or of a `.theme.json`.
pub fn read_source(path: &Path) -> IdeResult<IntellijThemeSource> {
    read(path).map_err(IdeError::invalid)
}

/// The theme plugins of the JetBrains IDEs (and Android Studio) of this user,
/// the themes their IDEs are set to first.
pub fn installed_themes() -> Vec<InstalledIntellijTheme> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let layout = if cfg!(target_os = "macos") {
        Layout::Mac
    } else if cfg!(windows) {
        Layout::Windows
    } else {
        Layout::Xdg
    };
    find_installed(&ide_dirs(layout, &home, |key| std::env::var_os(key)))
}

fn read(path: &Path) -> Result<IntellijThemeSource, String> {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        return loose_theme(path);
    }
    let mut jars = plugin_jars(path)?;
    let plugin = descriptor(&mut jars)?;
    let shown = || path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if plugin.themes.is_empty() {
        return Err(format!("{} is not a theme plugin: its plugin.xml declares no themeProvider", shown()));
    }
    let mut themes = Vec::new();
    let mut problem = None;
    for (id, theme_path) in &plugin.themes {
        match plugin_theme(&mut jars, id, theme_path) {
            Ok(theme) => themes.push(theme),
            Err(e) => problem = problem.or(Some(e)),
        }
    }
    if themes.is_empty() {
        return Err(problem.unwrap_or_else(|| format!("{} has no readable theme", shown())));
    }
    Ok(IntellijThemeSource {
        name: plugin.name.unwrap_or_else(shown),
        plugin_id: plugin.id,
        version: plugin.version,
        vendor: plugin.vendor,
        themes,
    })
}

fn plugin_theme(jars: &mut [Jar], id: &str, path: &str) -> Result<IntellijThemeFile, String> {
    let bytes = find(jars, entry_name(path), MAX_FILE)?.ok_or_else(|| format!("{path} is missing from the plugin"))?;
    let (theme, fields) = theme_json(&bytes).map_err(|e| format!("{path}: {e}"))?;
    let editor_scheme = match string_field(&fields, "editorScheme") {
        Some(scheme) => find(jars, entry_name(scheme), MAX_FILE)?.map(|b| text(&b)),
        None => None,
    };
    Ok(IntellijThemeFile { id: id.to_owned(), theme, editor_scheme })
}

/// A `.theme.json` with the editor scheme beside it (its `editorScheme` names a path in the plugin's jar).
fn loose_theme(path: &Path) -> Result<IntellijThemeSource, String> {
    let (theme, fields) = theme_json(&read_file(path)?).map_err(|e| format!("{}: {e}", path.display()))?;
    // Any JSON object parses: an IntelliJ theme has UI colours or an editor scheme.
    let scheme_ref = string_field(&fields, "editorScheme");
    if !fields.get("ui").is_some_and(serde_json::Value::is_object) && scheme_ref.is_none() {
        return Err(format!("{} is not an IntelliJ theme: it has no \"ui\" or \"editorScheme\"", path.display()));
    }
    let editor_scheme = scheme_ref
        .and_then(|p| Path::new(p).file_name().map(|n| path.with_file_name(n)))
        .filter(|p| p.is_file())
        .map(|p| read_file(&p).map(|b| text(&b)))
        .transpose()?;
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let id = file.strip_suffix(".theme.json").or_else(|| file.strip_suffix(".json")).unwrap_or(&file).to_owned();
    Ok(IntellijThemeSource {
        name: string_field(&fields, "name").map_or_else(|| id.clone(), str::to_owned),
        plugin_id: None,
        version: None,
        vendor: string_field(&fields, "author").map(str::to_owned),
        themes: vec![IntellijThemeFile { id, theme, editor_scheme }],
    })
}

type JsonObject = serde_json::Map<String, serde_json::Value>;

/// The theme JSON, comments removed, and its fields, if it is an object.
fn theme_json(bytes: &[u8]) -> Result<(String, JsonObject), String> {
    let json = super::theme::strip_json_comments(&text(bytes));
    match serde_json::from_str::<serde_json::Value>(&json) {
        Ok(serde_json::Value::Object(fields)) => Ok((json, fields)),
        Ok(_) => Err("not a theme: expected a JSON object".into()),
        Err(e) => Err(format!("invalid theme JSON: {e}")),
    }
}

fn string_field<'a>(fields: &'a JsonObject, key: &str) -> Option<&'a str> {
    fields.get(key)?.as_str().filter(|s| !s.trim().is_empty())
}

/// `/themes/x.theme.json` → `themes/x.theme.json`.
fn entry_name(path: &str) -> &str {
    path.trim().trim_start_matches('/')
}

pub(super) fn text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let shown = |e: std::io::Error| format!("{}: {e}", path.display());
    let file = std::fs::File::open(path).map_err(shown)?;
    let mut buf = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut buf).map_err(shown)?;
    if buf.len() as u64 > MAX_FILE {
        return Err(format!("{} is too large for a theme", path.display()));
    }
    Ok(buf)
}

pub(super) trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}
pub(super) type Jar = zip::ZipArchive<Box<dyn ReadSeek>>;

fn open_jar(path: &Path) -> Result<Jar, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let reader: Box<dyn ReadSeek> = Box::new(std::io::BufReader::new(file));
    zip::ZipArchive::new(reader).map_err(|e| format!("{} is not a jar or zip file ({e})", path.display()))
}

/// The jars of the plugin at `path`: a jar, a Marketplace zip (`<plugin>/lib/*.jar`)
/// or an installed plugin's folder (`lib/*.jar`).
pub(super) fn plugin_jars(path: &Path) -> Result<Vec<Jar>, String> {
    let not_plugin = || format!("{} is not an IntelliJ plugin: no {PLUGIN_XML} and no lib/*.jar", path.display());
    if path.is_dir() {
        let mut found: Vec<PathBuf> = [path.join("lib"), path.join("lib").join("modules")]
            .iter()
            .flat_map(|dir| std::fs::read_dir(dir).into_iter().flatten().flatten())
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_jar(p))
            .collect();
        found.sort();
        let jars: Vec<Jar> = found.iter().take(MAX_JARS).filter_map(|p| open_jar(p).ok()).collect();
        return if jars.is_empty() { Err(not_plugin()) } else { Ok(jars) };
    }
    let mut archive = open_jar(path)?;
    if archive.index_for_name(PLUGIN_XML).is_some() {
        return Ok(vec![archive]);
    }
    let jars = nested_jars(&mut archive, MAX_JAR, MAX_NESTED);
    if jars.is_empty() { Err(not_plugin()) } else { Ok(jars) }
}

/// The `lib` jars of a Marketplace zip, smallest first (a theme's own jar is small)
/// while they fit `max_total`; library jars too large or not jars at all are skipped.
fn nested_jars(archive: &mut Jar, max_jar: u64, max_total: u64) -> Vec<Jar> {
    let mut nested: Vec<(u64, String)> = entry_names(archive)
        .into_iter()
        .filter(|n| is_lib_jar(n))
        .filter_map(|n| Some((archive.by_name(&n).ok()?.size(), n)))
        .filter(|(size, _)| *size <= max_jar)
        .collect();
    nested.sort();
    let (mut jars, mut loaded) = (Vec::new(), 0u64);
    for (size, name) in nested.into_iter().take(MAX_JARS) {
        if loaded.saturating_add(size) > max_total {
            break;
        }
        let Ok(Some(bytes)) = read_entry(archive, &name, max_jar) else { continue };
        loaded += size;
        let reader: Box<dyn ReadSeek> = Box::new(Cursor::new(bytes));
        if let Ok(jar) = zip::ZipArchive::new(reader) {
            jars.push(jar);
        }
    }
    jars
}

fn entry_names(jar: &Jar) -> Vec<String> {
    jar.file_names().filter_map(Result::ok).map(|n| n.into_owned()).collect()
}

fn is_jar(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jar"))
}

/// `lib/x.jar`, `<plugin>/lib/x.jar` or `<plugin>/lib/modules/x.jar` in a Marketplace zip.
fn is_lib_jar(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    let n = parts.len();
    name.to_ascii_lowercase().ends_with(".jar")
        && (2..=4).contains(&n)
        && (parts[n - 2] == "lib" || (n >= 3 && parts[n - 2] == "modules" && parts[n - 3] == "lib"))
}

fn read_entry(jar: &mut Jar, name: &str, max: u64) -> Result<Option<Vec<u8>>, String> {
    let Ok(file) = jar.by_name(name) else { return Ok(None) };
    if file.is_dir() {
        return Ok(None);
    }
    if file.size() > max {
        return Err(format!("{name} is too large"));
    }
    let mut buf = Vec::with_capacity(file.size() as usize);
    file.take(max.saturating_add(1)).read_to_end(&mut buf).map_err(|e| format!("{name}: {e}"))?;
    if buf.len() as u64 > max {
        return Err(format!("{name} is too large"));
    }
    Ok(Some(buf))
}

pub(super) fn find(jars: &mut [Jar], name: &str, max: u64) -> Result<Option<Vec<u8>>, String> {
    for jar in jars.iter_mut() {
        if let Some(bytes) = read_entry(jar, name, max)? {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

/// What the plugin's descriptors say: `<idea-plugin>`'s `id`, `name`, `version`,
/// `vendor`, and its `themeProvider`s (id, path in the jar).
#[derive(Debug, Default, PartialEq)]
struct Descriptor {
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    vendor: Option<String>,
    themes: Vec<(String, String)>,
}

/// Reads `META-INF/plugin.xml` and the descriptors it includes (`<xi:include href>`), in any jar.
fn descriptor(jars: &mut [Jar]) -> Result<Descriptor, String> {
    let main = find(jars, PLUGIN_XML, MAX_FILE)
        .ok()
        .flatten()
        .ok_or_else(|| format!("not an IntelliJ plugin: no {PLUGIN_XML}"))?;
    let mut out = Descriptor::default();
    let mut includes = Vec::new();
    parse_descriptor(&text(&main), true, &mut out, &mut includes).map_err(|e| format!("{PLUGIN_XML}: {e}"))?;
    let mut read = std::collections::HashSet::from([PLUGIN_XML.to_owned()]);
    while let Some(href) = includes.pop() {
        let name = include_entry(&href);
        if read.len() >= MAX_DESCRIPTORS || !read.insert(name.clone()) {
            continue;
        }
        let Ok(Some(bytes)) = find(jars, &name, MAX_FILE) else { continue };
        let _ = parse_descriptor(&text(&bytes), false, &mut out, &mut includes);
    }
    let mut seen = std::collections::HashSet::new();
    out.themes.retain(|(id, _)| seen.insert(id.clone()));
    Ok(out)
}

/// An `<xi:include href>` as a jar entry: `/META-INF/x.xml` from the jar's root, `x.xml` beside plugin.xml.
fn include_entry(href: &str) -> String {
    let href = href.trim();
    href.strip_prefix('/').map_or_else(|| format!("META-INF/{href}"), str::to_owned)
}

fn parse_descriptor(xml: &str, main: bool, out: &mut Descriptor, includes: &mut Vec<String>) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = tag.local_name().as_ref().to_owned();
                if name == "include" {
                    let href = tag.attributes().flatten().find(|a| a.key.local_name().as_ref() == "href");
                    if let Some(href) = href.and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok()) {
                        includes.push(href.into_owned());
                    }
                }
                if name == "themeProvider" {
                    let (mut id, mut path) = (None, None);
                    for a in tag.attributes() {
                        let a = a.map_err(|e| e.to_string())?;
                        let value = a.normalized_value(XmlVersion::Implicit1_0).map_err(|e| e.to_string())?;
                        match a.key.local_name().as_ref() {
                            "id" => id = Some(value.trim().to_owned()),
                            "path" => path = Some(value.trim().to_owned()),
                            _ => {}
                        }
                    }
                    if let (Some(id), Some(path)) = (id, path)
                        && !id.is_empty()
                        && !path.is_empty()
                    {
                        out.themes.push((id, path));
                    }
                }
                if matches!(event, Event::Start(_)) {
                    stack.push(name);
                    text.clear();
                }
            }
            Event::Text(t) => text.push_str(&t.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(t) => text.push_str(t.as_ref()),
            Event::GeneralRef(r) => {
                let name = r.as_ref();
                let escaped = format!("&{name};");
                text.push_str(&quick_xml::escape::unescape(&escaped).map_err(|e| e.to_string())?);
            }
            Event::End(_) => {
                let name = stack.pop().ok_or("unbalanced element")?;
                // Direct children of <idea-plugin>.
                if main && stack.len() == 1 && stack[0] == "idea-plugin" {
                    let value = text.trim();
                    let slot = match name.as_str() {
                        "id" => Some(&mut out.id),
                        "name" => Some(&mut out.name),
                        "version" => Some(&mut out.version),
                        "vendor" => Some(&mut out.vendor),
                        _ => None,
                    };
                    if let Some(slot) = slot
                        && slot.is_none()
                        && !value.is_empty()
                    {
                        *slot = Some(value.to_owned());
                    }
                }
                text.clear();
            }
            Event::Eof => return if stack.is_empty() { Ok(()) } else { Err("unclosed element".into()) },
            _ => {}
        }
    }
}

/// Where an OS keeps the IDEs' settings and plugins.
#[derive(Clone, Copy, Debug)]
enum Layout {
    /// `~/Library/Application Support/<vendor>/<IDE>`, plugins in its `plugins/`.
    Mac,
    /// `%APPDATA%\<vendor>\<IDE>`, plugins in its `plugins\`.
    Windows,
    /// `$XDG_CONFIG_HOME/<vendor>/<IDE>`, plugins in `$XDG_DATA_HOME/<vendor>/<IDE>`.
    Xdg,
}

#[derive(Debug, PartialEq)]
struct IdeDir {
    label: String,
    product: String,
    version: (u32, u32),
    config: PathBuf,
    plugins: PathBuf,
}

/// The settings folders of JetBrains IDEs and Android Studio (2020.1 and later), newest first.
fn ide_dirs(layout: Layout, home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Vec<IdeDir> {
    let var = |key: &str| env(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let (config_root, data_root) = match layout {
        Layout::Mac => {
            let root = home.join("Library").join("Application Support");
            (root.clone(), root)
        }
        Layout::Windows => {
            let root = var("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
            (root.clone(), root)
        }
        Layout::Xdg => (
            var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
            var("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share")),
        ),
    };
    let mut out = Vec::new();
    for vendor in ["JetBrains", "Google"] {
        for entry in std::fs::read_dir(config_root.join(vendor)).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((product, version, shown)) = product_dir(&name) else { continue };
            let config = entry.path();
            if !config.is_dir() {
                continue;
            }
            let plugins = match layout {
                Layout::Xdg => data_root.join(vendor).join(&name),
                Layout::Mac | Layout::Windows => config.join("plugins"),
            };
            out.push(IdeDir {
                label: format!("{} {shown}", product_label(product)),
                product: product.to_owned(),
                version,
                config,
                plugins,
            });
        }
    }
    out.sort_by(|a, b| b.version.cmp(&a.version).then_with(|| a.label.cmp(&b.label)));
    out
}

/// `IntelliJIdea2025.2` → (`IntelliJIdea`, (2025, 2), `2025.2`).
fn product_dir(name: &str) -> Option<(&str, (u32, u32), &str)> {
    let at = name.find(|c: char| c.is_ascii_digit())?;
    let (product, version) = name.split_at(at);
    if product.is_empty() || !product.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let (year, minor) = version.split_once('.')?;
    let ok = |s: &str| !s.is_empty() && s.len() <= 4 && s.chars().all(|c| c.is_ascii_digit());
    if year.len() != 4 || !ok(year) || !ok(minor) {
        return None;
    }
    Some((product, (year.parse().ok()?, minor.parse().ok()?), version))
}

fn product_label(product: &str) -> &str {
    match product {
        "IntelliJIdea" => "IntelliJ IDEA",
        "IdeaIC" => "IntelliJ IDEA Community Edition",
        "PyCharmCE" => "PyCharm Community Edition",
        "AndroidStudio" => "Android Studio",
        "AndroidStudioPreview" => "Android Studio Preview",
        other => other,
    }
}

/// The theme ids `options/laf.xml` selects: the current one, and with "Sync with OS" the preferred light and dark.
fn active_theme_ids(config: &Path) -> Vec<String> {
    let Ok(bytes) = read_file(&config.join("options").join("laf.xml")) else { return Vec::new() };
    let xml = text(&bytes);
    let mut reader = Reader::from_str(&xml);
    let (mut ids, mut preferred, mut autodetect) = (Vec::new(), Vec::new(), false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) => {
                let attr = |key: &str| {
                    tag.attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == key)
                        .and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok().map(|v| v.trim().to_owned()))
                };
                match tag.local_name().as_ref() {
                    "component" if attr("name").as_deref() == Some("LafManager") => {
                        autodetect = attr("autodetect").as_deref() == Some("true");
                    }
                    "laf" => ids.extend(attr("themeId")),
                    "preferred-light-laf" | "preferred-dark-laf" => preferred.extend(attr("themeId")),
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    if autodetect {
        ids.extend(preferred);
    }
    ids.retain(|id| !id.is_empty());
    ids
}

fn find_installed(ides: &[IdeDir]) -> Vec<InstalledIntellijTheme> {
    let mut out = Vec::new();
    for ide in ides {
        let active = active_theme_ids(&ide.config);
        let mut plugins: Vec<PathBuf> = std::fs::read_dir(&ide.plugins)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() || (p.is_file() && is_jar(p)))
            .collect();
        plugins.sort();
        for plugin in plugins {
            let Ok(mut jars) = plugin_jars(&plugin) else { continue };
            let Ok(found) = descriptor(&mut jars) else { continue };
            for (id, path) in &found.themes {
                let Ok(Some(bytes)) = find(&mut jars, entry_name(path), MAX_FILE) else { continue };
                let Ok((_, fields)) = theme_json(&bytes) else { continue };
                let file = || plugin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                out.push(InstalledIntellijTheme {
                    ide: ide.label.clone(),
                    plugin: found.name.clone().unwrap_or_else(file),
                    path: plugin.clone().into(),
                    theme_id: id.clone(),
                    theme_name: string_field(&fields, "name").unwrap_or(id).to_owned(),
                    dark: fields.get("dark").and_then(serde_json::Value::as_bool).unwrap_or(true),
                    active: active.contains(id),
                });
            }
        }
    }
    // Stable: the IDEs' order (newest first) within each group.
    out.sort_by_key(|t| !t.active);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PLUGIN: &str = r#"<idea-plugin>
  <id>com.example.deepsea</id>
  <name>Deep Sea &amp; Friends</name>
  <version>2.3</version>
  <vendor email="a@example.com">Someone</vendor>
  <description><![CDATA[<b>Dark</b> themes]]></description>
  <depends>com.intellij.modules.platform</depends>
  <extensions defaultExtensionNs="com.intellij">
    <themeProvider id="deep-sea-id" path="/themes/DeepSea.theme.json"/>
    <themeProvider id="shallow-id" path="themes/Shallow.theme.json" />
  </extensions>
</idea-plugin>"#;

    const DEEP: &str = r##"{
  // comment
  "name": "Deep Sea",
  "dark": true,
  "editorScheme": "/themes/DeepSea.xml",
  "ui": { "*": { "background": "#101820" } }
}"##;
    const SHALLOW: &str = r#"{ "name": "Shallow", "dark": false, "ui": {} }"#;
    const SCHEME: &str = r#"<scheme name="Deep Sea" version="142" parent_scheme="Darcula"/>"#;

    fn jar_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn theme_jar() -> Vec<u8> {
        jar_bytes(&[
            ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
            (PLUGIN_XML, PLUGIN.as_bytes()),
            ("themes/DeepSea.theme.json", DEEP.as_bytes()),
            ("themes/DeepSea.xml", SCHEME.as_bytes()),
            ("themes/Shallow.theme.json", SHALLOW.as_bytes()),
        ])
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn expected_source() -> IntellijThemeSource {
        IntellijThemeSource {
            name: "Deep Sea & Friends".into(),
            plugin_id: Some("com.example.deepsea".into()),
            version: Some("2.3".into()),
            vendor: Some("Someone".into()),
            themes: vec![
                IntellijThemeFile {
                    id: "deep-sea-id".into(),
                    theme: super::super::theme::strip_json_comments(DEEP),
                    editor_scheme: Some(SCHEME.into()),
                },
                IntellijThemeFile { id: "shallow-id".into(), theme: SHALLOW.into(), editor_scheme: None },
            ],
        }
    }

    #[test]
    fn reads_a_theme_jar_with_its_editor_scheme() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp.path().join("deep-sea.jar");
        write(&jar, &theme_jar());
        let source = read_source(&jar).unwrap();
        assert_eq!(source, expected_source());
        assert!(!source.themes[0].theme.contains("comment"));
    }

    #[test]
    fn reads_a_marketplace_zip_and_an_installed_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let other = jar_bytes(&[("META-INF/MANIFEST.MF", b"x"), ("a/B.class", b"\xCA\xFE")]);
        let zip = tmp.path().join("DeepSea-2.3.zip");
        write(&zip, &jar_bytes(&[("DeepSea/lib/a-util.jar", &other), ("DeepSea/lib/deep-sea.jar", &theme_jar())]));
        assert_eq!(read_source(&zip).unwrap(), expected_source());

        let dir = tmp.path().join("plugins").join("DeepSea");
        write(&dir.join("lib").join("deep-sea.jar"), &theme_jar());
        write(&dir.join("lib").join("a-util.jar"), &other);
        assert_eq!(read_source(&dir).unwrap(), expected_source());
    }

    #[test]
    fn skips_library_jars_it_cannot_or_need_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        // Stored, not deflated: as large in the zip as its content.
        let mut big = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        big.start_file("lib/Data.class", stored).unwrap();
        big.write_all(&[b'x'; 8192]).unwrap();
        let big = big.finish().unwrap().into_inner();
        let zip = tmp.path().join("DeepSea.zip");
        write(
            &zip,
            &jar_bytes(&[
                ("DeepSea/lib/a-broken.jar", b"not a jar"),
                ("DeepSea/lib/b-big.jar", &big),
                ("DeepSea/lib/deep-sea.jar", &theme_jar()),
            ]),
        );
        assert_eq!(read_source(&zip).unwrap(), expected_source());

        // The broken jar is skipped; a jar over the size limit, or past the total
        // (smallest first), is not read, while the theme's small jar still is.
        let mut archive = open_jar(&zip).unwrap();
        let theme_len = theme_jar().len() as u64;
        assert_eq!(nested_jars(&mut archive, u64::MAX, u64::MAX).len(), 2);
        let one = nested_jars(&mut archive, theme_len + 64, u64::MAX);
        assert_eq!(one.len(), 1);
        assert!(one[0].index_for_name(PLUGIN_XML).is_some());
        assert_eq!(nested_jars(&mut archive, u64::MAX, theme_len + 64).len(), 1);
        assert!(nested_jars(&mut archive, 8, u64::MAX).is_empty());
    }

    #[test]
    fn reads_a_loose_theme_json_with_the_scheme_beside_it() {
        let tmp = tempfile::tempdir().unwrap();
        let theme = tmp.path().join("DeepSea.theme.json");
        write(&theme, DEEP.as_bytes());
        write(&tmp.path().join("DeepSea.xml"), SCHEME.as_bytes());
        let source = read_source(&theme).unwrap();
        assert_eq!(source.name, "Deep Sea");
        assert_eq!(source.themes.len(), 1);
        assert_eq!(source.themes[0].id, "DeepSea");
        assert_eq!(source.themes[0].editor_scheme.as_deref(), Some(SCHEME));

        std::fs::remove_file(tmp.path().join("DeepSea.xml")).unwrap();
        assert_eq!(read_source(&theme).unwrap().themes[0].editor_scheme, None);
    }

    #[test]
    fn says_what_is_wrong_with_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let not_zip = tmp.path().join("notes.jar");
        write(&not_zip, b"hello");
        assert!(read_source(&not_zip).unwrap_err().message.contains("not a jar or zip"));

        let other_plugin = tmp.path().join("tools.jar");
        let xml = "<idea-plugin><name>Tools</name><actions/></idea-plugin>";
        write(&other_plugin, &jar_bytes(&[(PLUGIN_XML, xml.as_bytes())]));
        assert!(read_source(&other_plugin).unwrap_err().message.contains("not a theme plugin"));

        let package = tmp.path().join("package.zip");
        write(&package, &jar_bytes(&[("plugin.toml", b"id = \"x\"")]));
        assert!(read_source(&package).unwrap_err().message.contains("not an IntelliJ plugin"));

        let other = tmp.path().join("package.json");
        write(&other, br#"{ "name": "app", "version": "1.0.0" }"#);
        assert!(read_source(&other).unwrap_err().message.contains("is not an IntelliJ theme"));

        let broken = tmp.path().join("broken.theme.json");
        write(&broken, b"{ \"name\": ");
        assert!(read_source(&broken).unwrap_err().message.contains("invalid theme JSON"));

        let missing = tmp.path().join("missing.jar");
        let xml = r#"<idea-plugin><name>M</name><themeProvider id="m" path="/m.theme.json"/></idea-plugin>"#;
        write(&missing, &jar_bytes(&[(PLUGIN_XML, xml.as_bytes())]));
        assert!(read_source(&missing).unwrap_err().message.contains("/m.theme.json is missing"));
    }

    #[test]
    fn finds_theme_providers_in_included_descriptors() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp.path().join("split.jar");
        let main = r#"<idea-plugin xmlns:xi="http://www.w3.org/2001/XInclude"><name>Split</name>
            <xi:include href="/META-INF/themes.xml"/></idea-plugin>"#;
        let part = r#"<idea-plugin xmlns:xi="http://www.w3.org/2001/XInclude"><extensions defaultExtensionNs="com.intellij">
            <themeProvider id="s" path="/s.theme.json"/></extensions><name>Not this</name>
            <xi:include href="more.xml"/><xi:include href="/META-INF/themes.xml"/></idea-plugin>"#;
        let more = r#"<idea-plugin><themeProvider id="m" path="/m.theme.json"/></idea-plugin>"#;
        let unrelated = r#"<idea-plugin><themeProvider id="x" path="/x.theme.json"/></idea-plugin>"#;
        write(
            &jar,
            &jar_bytes(&[
                ("META-INF/themes.xml", part.as_bytes()),
                ("META-INF/more.xml", more.as_bytes()),
                ("META-INF/unrelated.xml", unrelated.as_bytes()),
                (PLUGIN_XML, main.as_bytes()),
                ("s.theme.json", br#"{"name":"S"}"#),
                ("m.theme.json", br#"{"name":"M"}"#),
                ("x.theme.json", br#"{"name":"X"}"#),
            ]),
        );
        let source = read_source(&jar).unwrap();
        assert_eq!(source.name, "Split");
        // Only what plugin.xml includes (relative or from the root, once each) counts.
        assert_eq!(source.themes.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["s", "m"]);
    }

    #[test]
    fn parses_ide_folder_names() {
        assert_eq!(product_dir("IntelliJIdea2025.2"), Some(("IntelliJIdea", (2025, 2), "2025.2")));
        assert_eq!(product_dir("PyCharmCE2023.10"), Some(("PyCharmCE", (2023, 10), "2023.10")));
        assert_eq!(product_dir("AndroidStudio2024.3"), Some(("AndroidStudio", (2024, 3), "2024.3")));
        for name in
            ["Toolbox", "consentOptions", "IntelliJIdea2025", "Idea-2025.1", "2025.1", "Rider25.1", "Go Land2025.1"]
        {
            assert_eq!(product_dir(name), None, "{name}");
        }
    }

    #[test]
    fn locates_the_settings_and_plugins_of_each_os() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let mk = |p: PathBuf| {
            std::fs::create_dir_all(&p).unwrap();
            p
        };
        let mac = mk(home.join("Library/Application Support/JetBrains/IntelliJIdea2025.2"));
        mk(home.join("Library/Application Support/JetBrains/Toolbox"));
        let dirs = ide_dirs(Layout::Mac, home, |_| None);
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].label, "IntelliJ IDEA 2025.2");
        assert_eq!((dirs[0].config.clone(), dirs[0].plugins.clone()), (mac.clone(), mac.join("plugins")));

        let appdata = mk(home.join("Roaming"));
        let win = mk(appdata.join("JetBrains/PyCharm2024.3"));
        let studio = mk(appdata.join("Google/AndroidStudio2025.1"));
        let env = |k: &str| (k == "APPDATA").then(|| appdata.clone().into_os_string());
        let dirs = ide_dirs(Layout::Windows, home, env);
        assert_eq!(
            dirs.iter().map(|d| d.label.as_str()).collect::<Vec<_>>(),
            ["Android Studio 2025.1", "PyCharm 2024.3"]
        );
        assert_eq!(dirs[1].plugins, win.join("plugins"));
        assert_eq!(dirs[0].config, studio);

        let config = mk(home.join(".config/JetBrains/IdeaIC2024.1"));
        mk(home.join(".config/JetBrains/GoLand2025.2"));
        let dirs = ide_dirs(Layout::Xdg, home, |_| None);
        assert_eq!(dirs.iter().map(|d| d.product.as_str()).collect::<Vec<_>>(), ["GoLand", "IdeaIC"]);
        assert_eq!(dirs[1].label, "IntelliJ IDEA Community Edition 2024.1");
        assert_eq!(dirs[1].config, config);
        assert_eq!(dirs[1].plugins, home.join(".local/share/JetBrains/IdeaIC2024.1"));

        let xdg_data = home.join("data");
        let env = |k: &str| (k == "XDG_DATA_HOME").then(|| xdg_data.clone().into_os_string());
        assert_eq!(ide_dirs(Layout::Xdg, home, env)[1].plugins, xdg_data.join("JetBrains/IdeaIC2024.1"));
    }

    #[test]
    fn reads_the_selected_theme_from_laf_xml() {
        let tmp = tempfile::tempdir().unwrap();
        let laf = tmp.path().join("options/laf.xml");
        write(
            &laf,
            br#"<application>
  <component name="LafManager">
    <laf class-name="com.intellij.ide.ui.laf.UIThemeBasedLookAndFeelInfo" themeId="deep-sea-id" />
    <preferred-light-laf themeId="shallow-id" />
  </component>
</application>"#,
        );
        assert_eq!(active_theme_ids(tmp.path()), ["deep-sea-id"]);
        let synced = std::fs::read_to_string(&laf)
            .unwrap()
            .replace(r#"name="LafManager""#, r#"name="LafManager" autodetect="true""#);
        write(&laf, synced.as_bytes());
        assert_eq!(active_theme_ids(tmp.path()), ["deep-sea-id", "shallow-id"]);
        assert!(active_theme_ids(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn lists_installed_theme_plugins_the_ides_current_first() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("IntelliJIdea2025.2");
        let plugins = config.join("plugins");
        write(&plugins.join("DeepSea/lib/deep-sea.jar"), &theme_jar());
        write(
            &plugins.join("Tools/lib/tools.jar"),
            &jar_bytes(&[(PLUGIN_XML, b"<idea-plugin><name>T</name></idea-plugin>")]),
        );
        write(&plugins.join("broken.jar"), b"not a jar");
        write(
            &config.join("options/laf.xml"),
            br#"<application><component name="LafManager"><laf themeId="shallow-id"/></component></application>"#,
        );
        let ide = IdeDir {
            label: "IntelliJ IDEA 2025.2".into(),
            product: "IntelliJIdea".into(),
            version: (2025, 2),
            config: config.clone(),
            plugins: plugins.clone(),
        };
        let found = find_installed(&[ide]);
        let theme = |id: &str, name: &str, dark: bool, active: bool| InstalledIntellijTheme {
            ide: "IntelliJ IDEA 2025.2".into(),
            plugin: "Deep Sea & Friends".into(),
            path: plugins.join("DeepSea").into(),
            theme_id: id.into(),
            theme_name: name.into(),
            dark,
            active,
        };
        assert_eq!(found, [theme("shallow-id", "Shallow", false, true), theme("deep-sea-id", "Deep Sea", true, false)]);
        assert!(find_installed(&[]).is_empty());
    }
}
