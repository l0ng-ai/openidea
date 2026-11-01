use ide_core::IdeResult;
use ide_core::editor_settings::LanguageCodeStyle;
use ide_core::settings::LanguageServerSettings;
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::path::Path;

const PROFILE: &str = "OpenIDEA IntelliJ IDEA";
const XML: &str = include_str!("intellij.xml");

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
    let (path, profile) = match style.formatter.as_deref() {
        Some("intellij") => {
            let path = data_dir.join("lsp/jdtls/intellij.xml");
            std::fs::create_dir_all(path.parent().unwrap())?;
            if std::fs::read_to_string(&path).ok().as_deref() != Some(XML) {
                ide_vfs::write_atomic(&path, XML.as_bytes())?;
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
            (path, "")
        }
        _ => return Ok(()),
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
