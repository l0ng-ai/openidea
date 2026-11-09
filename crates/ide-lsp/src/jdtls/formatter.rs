use ide_core::IdeResult;
use ide_core::editor_settings::LanguageCodeStyle;
use ide_core::settings::LanguageServerSettings;
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::path::Path;

const PROFILE: &str = "OpenIDEA IntelliJ IDEA";
const XML: &str = include_str!("intellij.xml");
const GENERATED_PROFILE: &str = "OpenIDEA Code Style";
const TAB_CHAR: &str = "org.eclipse.jdt.core.formatter.tabulation.char";
const TAB_SIZE: &str = "org.eclipse.jdt.core.formatter.tabulation.size";
const INDENT_SIZE: &str = "org.eclipse.jdt.core.formatter.indentation.size";

/// The Tabs and Indents override as Eclipse formatter settings. The profile must
/// carry them too: `indentation.size`, the per-level width, cannot come from the
/// format request, and an unset Indent follows the tab size, as in IDEA.
fn indent_settings(style: &LanguageCodeStyle) -> Option<Vec<(&'static str, String)>> {
    let tab_char = style.use_tab.map(|tab| if tab { "tab" } else { "space" });
    let indent = style.indent.or(style.tab_size);
    if tab_char.is_none() && style.tab_size.is_none() && indent.is_none() {
        return None;
    }
    let mut settings: Vec<(&'static str, String)> = Vec::new();
    if let Some(char) = tab_char {
        settings.push((TAB_CHAR, char.to_owned()));
    }
    if let Some(size) = style.tab_size {
        settings.push((TAB_SIZE, size.to_string()));
    }
    if let Some(size) = indent {
        settings.push((INDENT_SIZE, size.to_string()));
    }
    Some(settings)
}

fn patch_profile_xml(mut xml: String, settings: &[(&'static str, String)]) -> String {
    for (id, value) in settings {
        let marker = format!(r#"<setting id="{id}" value=""#);
        let Some(at) = xml.find(&marker) else { continue };
        let start = at + marker.len();
        let Some(end) = xml[start..].find('"') else { continue };
        xml.replace_range(start..start + end, value);
    }
    xml
}

/// A minimal Eclipse profile with just the override: unset keys keep jdtls's
/// built-in formatter defaults.
fn indent_profile_xml(settings: &[(&'static str, String)]) -> String {
    let mut xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles version="21">
  <profile kind="CodeFormatterProfile" name="{}" version="21">
"#,
        GENERATED_PROFILE
    );
    for (id, value) in settings {
        xml.push_str(&format!(r#"    <setting id="{id}" value="{value}"/>"#));
        xml.push('\n');
    }
    xml.push_str("  </profile>\n</profiles>\n");
    xml
}

/// Protocol settings only: switching profiles reaches a running jdtls through
/// didChangeConfiguration. Explicit language-server settings are applied later.
pub fn configure_formatter(
    cfg: &mut LanguageServerConfig,
    style: Option<&LanguageCodeStyle>,
    project_root: &Path,
    data_dir: &Path,
    overrides: Option<&LanguageServerSettings>,
) -> IdeResult<()> {
    if cfg.name != "jdtls" {
        return Ok(());
    }
    // jdtls retains omitted preferences. Send empty values when returning to
    // Default, while preserving any profile from the base server configuration.
    let inherited = crate::handler::all_settings(cfg);
    let defaults = json!({
        "url": inherited.pointer("/java/format/settings/url").cloned().unwrap_or(json!("")),
        "profile": inherited.pointer("/java/format/settings/profile").cloned().unwrap_or(json!("")),
    });
    let mut settings = cfg.settings.take().unwrap_or_else(|| json!({}));
    settings["java"]["format"]["settings"] = formatter_overrides(defaults, overrides);
    cfg.settings = Some(settings);
    let Some(style) = style else { return Ok(()) };
    let indent = indent_settings(style);
    let (path, profile) = match style.formatter.as_deref() {
        Some("intellij") => {
            let path = data_dir.join("lsp/jdtls/intellij.xml");
            std::fs::create_dir_all(path.parent().unwrap())?;
            let xml = match indent {
                Some(indent) => patch_profile_xml(XML.to_owned(), &indent),
                None => XML.to_owned(),
            };
            if std::fs::read_to_string(&path).ok().as_deref() != Some(xml.as_str()) {
                ide_vfs::write_atomic(&path, xml.as_bytes())?;
            }
            (path, PROFILE)
        }
        Some("custom") => {
            let value = style.formatter_path.as_deref().unwrap_or_default().trim();
            if value.is_empty() {
                return Err(ide_core::IdeError::invalid("Choose an Eclipse formatter XML file."));
            }
            let path = project_root.join(value);
            // Fail without poisoning the server launch; code intelligence remains available.
            std::fs::File::open(&path).map_err(|error| {
                let path = path.display();
                ide_core::IdeError::invalid(format!("Cannot read Java formatter XML {path}: {error}"))
            })?;
            if !path.is_file() {
                return Err(ide_core::IdeError::invalid(format!("Not a formatter XML file: {}", path.display())));
            }
            // The user's profile defines the style; the override stays editor-only.
            (path, "")
        }
        _ => {
            // Default formatter: with a Tabs and Indents override, hand jdtls a
            // minimal generated profile carrying it — the format request cannot
            // set indentation.size. Without an override the built-in style stays.
            let Some(indent) = indent else { return Ok(()) };
            let path = data_dir.join("lsp/jdtls/indent.xml");
            std::fs::create_dir_all(path.parent().unwrap())?;
            let xml = indent_profile_xml(&indent);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(xml.as_str()) {
                ide_vfs::write_atomic(&path, xml.as_bytes())?;
            }
            (path, GENERATED_PROFILE)
        }
    };
    let mut settings = cfg.settings.take().unwrap_or_else(|| json!({}));
    settings["java"]["format"]["settings"] = formatter_overrides(
        json!({
            "url": crate::uri::path_to_uri_string(&path),
            "profile": profile,
        }),
        overrides,
    );
    cfg.settings = Some(settings);
    Ok(())
}

fn formatter_overrides(mut format: serde_json::Value, overrides: Option<&LanguageServerSettings>) -> serde_json::Value {
    if let Some(overrides) = overrides {
        // all_settings merges protocol settings over initializationOptions.
        // Mirror explicit formatter keys so generated protocol values cannot
        // accidentally mask an advanced initializationOptions override.
        for layer in [
            overrides.initialization_options.as_ref().and_then(|v| v.pointer("/settings/java/format/settings")),
            overrides.settings.as_ref().and_then(|v| v.pointer("/settings/java/format/settings")),
            overrides.settings.as_ref().and_then(|v| v.pointer("/java/format/settings")),
        ]
        .into_iter()
        .flatten()
        {
            for key in ["url", "profile"] {
                if let Some(value) = layer.get(key) {
                    format[key] = value.clone();
                }
            }
        }
    }
    format
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(name: &str) -> LanguageServerConfig {
        serde_json::from_value(json!({"name": name, "command": name})).unwrap()
    }

    #[test]
    fn profiles_resolve_paths_preserve_settings_and_leave_other_servers_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project with 空格");
        let data = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        let custom = root.join("style.xml");
        std::fs::write(&custom, XML).unwrap();
        for name in ["jdtls", "rust-analyzer"] {
            for mode in ["default", "intellij", "custom", "unknown"] {
                let mut cfg = LanguageServerConfig {
                    name: name.into(),
                    settings: Some(json!({"java": {"autobuild": {"enabled": false}}})),
                    ..config(name)
                };
                let initial = cfg.clone();
                let style = LanguageCodeStyle {
                    formatter: Some(mode.into()),
                    formatter_path: Some("style.xml".into()),
                    ..Default::default()
                };
                configure_formatter(&mut cfg, Some(&style), &root, &data, None).unwrap();
                if name != "jdtls" {
                    assert_eq!(cfg, initial);
                    continue;
                }
                let settings = crate::handler::all_settings(&cfg);
                if !["intellij", "custom"].contains(&mode) {
                    assert_eq!(settings["java"]["format"]["settings"], json!({"url": "", "profile": ""}));
                    continue;
                }
                let path = if mode == "custom" { custom.clone() } else { data.join("lsp/jdtls/intellij.xml") };
                assert_eq!(settings["java"]["format"]["settings"]["url"], crate::uri::path_to_uri_string(&path));
                assert_eq!(
                    settings["java"]["format"]["settings"]["profile"],
                    if mode == "custom" { "" } else { PROFILE }
                );
                assert_eq!(settings["java"]["autobuild"]["enabled"], false);
                assert_eq!(std::fs::read_to_string(path).unwrap(), XML);
            }
        }
    }

    #[test]
    fn tabs_and_indents_override_reaches_the_formatter_profile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let data = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();

        // The IntelliJ profile is the bundled XML with the override patched in.
        let mut cfg = config("jdtls");
        let style = LanguageCodeStyle {
            formatter: Some("intellij".into()),
            use_tab: Some(true),
            tab_size: Some(1),
            indent: Some(1),
            ..Default::default()
        };
        configure_formatter(&mut cfg, Some(&style), &root, &data, None).unwrap();
        let settings = crate::handler::all_settings(&cfg)["java"]["format"]["settings"].clone();
        assert_eq!(settings["profile"], PROFILE);
        let patched = std::fs::read_to_string(data.join("lsp/jdtls/intellij.xml")).unwrap();
        assert!(patched.contains(&format!(r#"<setting id="{TAB_CHAR}" value="tab"/>"#)));
        assert!(patched.contains(&format!(r#"<setting id="{TAB_SIZE}" value="1"/>"#)));
        assert!(patched.contains(&format!(r#"<setting id="{INDENT_SIZE}" value="1"/>"#)));

        // The default formatter gets a minimal generated profile.
        let mut cfg = config("jdtls");
        let style = LanguageCodeStyle { use_tab: Some(false), tab_size: Some(2), ..Default::default() };
        configure_formatter(&mut cfg, Some(&style), &root, &data, None).unwrap();
        let settings = crate::handler::all_settings(&cfg)["java"]["format"]["settings"].clone();
        let path = data.join("lsp/jdtls/indent.xml");
        assert_eq!(settings["url"], crate::uri::path_to_uri_string(&path));
        assert_eq!(settings["profile"], GENERATED_PROFILE);
        let xml = std::fs::read_to_string(&path).unwrap();
        assert!(xml.contains(&format!(r#"<setting id="{TAB_CHAR}" value="space"/>"#)));
        // An unset Indent follows the tab size, as in IDEA.
        assert!(xml.contains(&format!(r#"<setting id="{INDENT_SIZE}" value="2"/>"#)));

        // Only Indent: the bundled tab settings stay.
        let mut cfg = config("jdtls");
        let style = LanguageCodeStyle { formatter: Some("intellij".into()), indent: Some(2), ..Default::default() };
        configure_formatter(&mut cfg, Some(&style), &root, &data, None).unwrap();
        let patched = std::fs::read_to_string(data.join("lsp/jdtls/intellij.xml")).unwrap();
        assert!(patched.contains(&format!(r#"<setting id="{INDENT_SIZE}" value="2"/>"#)));
        assert!(patched.contains(&format!(r#"<setting id="{TAB_CHAR}" value="space"/>"#)));
        assert!(patched.contains(&format!(r#"<setting id="{TAB_SIZE}" value="4"/>"#)));
    }

    #[test]
    fn tabs_and_indents_override_leaves_custom_profiles_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let custom = root.join("style.xml");
        std::fs::write(&custom, XML).unwrap();
        let mut cfg = config("jdtls");
        let style = LanguageCodeStyle {
            formatter: Some("custom".into()),
            formatter_path: Some("style.xml".into()),
            use_tab: Some(true),
            tab_size: Some(1),
            indent: Some(1),
            ..Default::default()
        };
        configure_formatter(&mut cfg, Some(&style), &root, dir.path(), None).unwrap();
        assert_eq!(std::fs::read_to_string(&custom).unwrap(), XML);
    }

    #[test]
    fn unavailable_custom_paths_are_nonfatal_and_do_not_set_launch_error() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["", "missing.xml", "."] {
            let mut cfg = config("jdtls");
            let style = LanguageCodeStyle {
                formatter: Some("custom".into()),
                formatter_path: Some(path.into()),
                ..Default::default()
            };
            assert!(configure_formatter(&mut cfg, Some(&style), dir.path(), dir.path(), None).is_err());
            assert!(cfg.launch_error.is_none());
            assert_eq!(crate::handler::all_settings(&cfg)["java"]["format"]["settings"]["url"], "");
        }
    }

    #[test]
    fn default_keeps_explicit_server_configuration_and_custom_accepts_absolute_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom.xml");
        std::fs::write(&path, XML).unwrap();
        let mut cfg = config("jdtls");
        cfg.initialization_options = Some(
            toml::Value::try_from(json!({
                "settings": {"java": {"format": {"settings": {"url": "existing.xml", "profile": "Existing"}}}}
            }))
            .unwrap(),
        );
        configure_formatter(&mut cfg, None, dir.path(), dir.path(), None).unwrap();
        assert_eq!(
            crate::handler::all_settings(&cfg)["java"]["format"]["settings"],
            json!({"url": "existing.xml", "profile": "Existing"})
        );
        let style = LanguageCodeStyle {
            formatter: Some("custom".into()),
            formatter_path: Some(path.to_string_lossy().into_owned()),
            ..Default::default()
        };
        configure_formatter(&mut cfg, Some(&style), &dir.path().join("different-root"), dir.path(), None).unwrap();
        assert_eq!(
            crate::handler::all_settings(&cfg)["java"]["format"]["settings"]["url"],
            crate::uri::path_to_uri_string(&path)
        );
    }
    #[test]
    fn advanced_formatter_options_win_for_each_profile_and_protocol_layer() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("custom.xml"), XML).unwrap();
        for mode in ["default", "intellij", "custom"] {
            for layer in ["initialization", "wrapped", "direct"] {
                let mut overrides = LanguageServerSettings {
                    initialization_options: Some(json!({"settings": {"java": {"format": {"settings": {
                        "url": "advanced.xml", "profile": "Advanced"
                    }}}}})),
                    ..Default::default()
                };
                if layer != "initialization" {
                    let value = json!({"java": {"format": {"settings": {"profile": "Protocol"}}}});
                    overrides.settings = Some(if layer == "wrapped" { json!({"settings": value}) } else { value });
                }
                let mut cfg = config("jdtls");
                let style = LanguageCodeStyle {
                    formatter: Some(mode.into()),
                    formatter_path: Some("custom.xml".into()),
                    ..Default::default()
                };
                configure_formatter(&mut cfg, Some(&style), dir.path(), dir.path(), Some(&overrides)).unwrap();
                assert_eq!(
                    crate::handler::all_settings(&cfg)["java"]["format"]["settings"],
                    json!({
                        "url": "advanced.xml",
                        "profile": if layer == "initialization" { "Advanced" } else { "Protocol" },
                    })
                );
            }
        }
    }
}
