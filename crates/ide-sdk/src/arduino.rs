//! Arduino Language Server tool discovery and launch configuration.
//! Resolves `arduino-language-server`, `arduino-cli` and `clangd` from PATH or Arduino IDE 2.

use crate::apply::setting_path;
use crate::exec::which;
use ide_core::settings::{ArduinoSettings, Settings};
use ide_core::{IdeError, IdeResult};
use ide_language::LanguageServerConfig;
use std::path::{Path, PathBuf};

pub const SERVER: &str = "arduino-language-server";

fn user_home() -> Option<PathBuf> {
    if cfg!(windows) {
        ide_core::process::host_var_os("USERPROFILE").map(PathBuf::from).or_else(crate::home_dir)
    } else {
        crate::home_dir()
    }
}

fn ide_resource_dirs() -> Vec<PathBuf> {
    let mut installs = Vec::new();
    if cfg!(windows) {
        if let Some(local) = ide_core::process::host_var_os("LOCALAPPDATA") {
            installs.push(PathBuf::from(local).join("Programs/Arduino IDE"));
        }
        for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = ide_core::process::host_var_os(var) {
                installs.push(PathBuf::from(dir).join("Arduino IDE"));
            }
        }
        installs.into_iter().map(|p| p.join("resources/app/lib/backend/resources")).collect()
    } else if cfg!(target_os = "macos") {
        installs.push(PathBuf::from("/Applications/Arduino IDE.app"));
        if let Some(home) = user_home() {
            installs.push(home.join("Applications/Arduino IDE.app"));
        }
        installs.into_iter().map(|p| p.join("Contents/Resources/app/lib/backend/resources")).collect()
    } else {
        vec![PathBuf::from("/opt/arduino-ide/resources/app/lib/backend/resources")]
    }
}

fn resolve_tool(root: &Path, configured: &str, name: &str) -> IdeResult<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = setting_path(root, configured).unwrap_or_default();
        if path.is_file() {
            return Ok(path);
        }
        if Path::new(configured).components().count() == 1
            && let Some(path) = which(configured)
        {
            return Ok(path);
        }
        return Err(IdeError::unavailable(format!(
            "Arduino tool '{configured}' was not found. Set an installed executable in settings."
        )));
    }
    which(name)
        .or_else(|| ide_resource_dirs().into_iter().map(|p| p.join(crate::exe(name))).find(|p| p.is_file()))
        .ok_or_else(|| IdeError::unavailable(format!(
            "Arduino tool '{name}' was not found on PATH or in Arduino IDE. Install Arduino IDE 2 or set its path in settings."
        )))
}

fn cli_config(root: &Path, configured: &str) -> IdeResult<Option<PathBuf>> {
    if let Some(path) = setting_path(root, configured) {
        if !path.is_file() {
            return Err(IdeError::unavailable(format!("Arduino CLI configuration {} does not exist.", path.display())));
        }
        return Ok(Some(path));
    }
    Ok(user_home().map(|p| p.join(".arduinoIDE/arduino-cli.yaml")).filter(|p| p.is_file()))
}

/// Parses `sketch.yaml` without external YAML parser dependencies.
fn yaml_board(text: &str) -> Option<String> {
    let mut default_fqbn = None;
    let mut default_profile = None;
    let mut current_profile: Option<String> = None;
    let mut profile_fqbns = std::collections::BTreeMap::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let indent = line.chars().take_while(|c| c.is_whitespace()).count();
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches(|c| c == '\'' || c == '"');
            if indent == 0 {
                if key == "default_fqbn" && !val.is_empty() {
                    default_fqbn = Some(val.to_owned());
                } else if key == "default_profile" && !val.is_empty() {
                    default_profile = Some(val.to_owned());
                }
            } else if indent <= 2 {
                if key != "profiles" && val.is_empty() {
                    current_profile = Some(key.to_owned());
                }
            } else if key == "fqbn"
                && !val.is_empty()
                && let Some(p) = &current_profile
            {
                profile_fqbns.insert(p.clone(), val.to_owned());
            }
        }
    }
    if let Some(fqbn) = default_fqbn {
        return Some(fqbn);
    }
    if let Some(prof) = default_profile
        && let Some(fqbn) = profile_fqbns.get(&prof)
    {
        return Some(fqbn.clone());
    }
    None
}

/// Resolves board FQBN from settings, `sketch.yaml`, or standard AVR Uno fallback.
pub fn board(_root: &Path, sketch: &Path, settings: &ArduinoSettings) -> IdeResult<String> {
    let configured = settings.fqbn.trim();
    if !configured.is_empty() {
        return Ok(configured.to_owned());
    }
    let yaml = sketch.join("sketch.yaml");
    if let Ok(text) = std::fs::read_to_string(&yaml)
        && let Some(fqbn) = yaml_board(&text)
    {
        return Ok(fqbn);
    }
    // Fall back to default board for the language server if not configured,
    // so code intelligence functions immediately out of the box.
    Ok("arduino:avr:uno".into())
}

fn argument<'a>(args: &'a [String], flag: &str) -> IdeResult<Option<&'a str>> {
    for (index, arg) in args.iter().enumerate() {
        let key = arg.trim_start_matches('-');
        let value = if key == flag {
            Some(args.get(index + 1).map(String::as_str).filter(|v| !v.starts_with('-')).unwrap_or(""))
        } else {
            key.strip_prefix(flag).and_then(|tail| tail.strip_prefix('='))
        };
        if let Some(value) = value {
            if value.trim().is_empty() {
                return Err(IdeError::invalid(format!("Arduino Language Server argument -{flag} requires a value.")));
            }
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn configure_inner(cfg: &mut LanguageServerConfig, root: &Path, sketch: &Path, settings: &Settings) -> IdeResult<()> {
    let arduino = &settings.languages.arduino;
    let explicit_server = settings.language_servers.get(SERVER).is_some_and(|s| !s.command.trim().is_empty());
    if !explicit_server && cfg.command == SERVER {
        cfg.command = resolve_tool(root, &arduino.language_server, SERVER)?.to_string_lossy().into_owned();
    } else {
        cfg.command = resolve_tool(root, &cfg.command, SERVER)?.to_string_lossy().into_owned();
    }
    for (flag, configured, executable) in [("cli", &arduino.cli, "arduino-cli"), ("clangd", &arduino.clangd, "clangd")]
    {
        if let Some(value) = argument(&cfg.args, flag)? {
            resolve_tool(sketch, value, executable)?;
        } else {
            let path = resolve_tool(root, configured, executable)?;
            cfg.args.extend([format!("-{flag}"), path.to_string_lossy().into_owned()]);
        }
    }
    if let Some(value) = argument(&cfg.args, "cli-config")? {
        cli_config(sketch, value)?;
    } else if let Some(path) = cli_config(root, &arduino.cli_config)? {
        cfg.args.extend(["-cli-config".into(), path.to_string_lossy().into_owned()]);
    }
    if argument(&cfg.args, "fqbn")?.is_none() {
        cfg.args.extend(["-fqbn".into(), board(root, sketch, arduino)?]);
    }
    Ok(())
}

/// Applies discovered Arduino CLI, clangd and board FQBN to the LanguageServerConfig.
pub fn configure(cfg: &mut LanguageServerConfig, root: &Path, sketch: &Path, settings: &Settings) {
    if cfg.name != SERVER {
        return;
    }
    if let Err(error) = configure_inner(cfg, root, sketch, settings) {
        cfg.launch_error = Some(error.message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sketch_yaml_default_fqbn() {
        let yaml = "default_fqbn: arduino:avr:nano\ndefault_port: COM3\n";
        assert_eq!(yaml_board(yaml), Some("arduino:avr:nano".into()));
    }

    #[test]
    fn parses_sketch_yaml_profiles() {
        let yaml = r#"
default_profile: esp32
profiles:
  uno:
    fqbn: arduino:avr:uno
  esp32:
    fqbn: esp32:esp32:esp32
"#;
        assert_eq!(yaml_board(yaml), Some("esp32:esp32:esp32".into()));
    }

    #[test]
    fn board_falls_back_to_avr_uno() {
        let dir = tempfile::tempdir().unwrap();
        let settings = ArduinoSettings::default();
        let fqbn = board(dir.path(), dir.path(), &settings).unwrap();
        assert_eq!(fqbn, "arduino:avr:uno");
    }

    #[test]
    fn board_prefers_settings_fqbn() {
        let dir = tempfile::tempdir().unwrap();
        let settings = ArduinoSettings { fqbn: "arduino:samd:mkr1000".into(), ..Default::default() };
        let fqbn = board(dir.path(), dir.path(), &settings).unwrap();
        assert_eq!(fqbn, "arduino:samd:mkr1000");
    }
}
