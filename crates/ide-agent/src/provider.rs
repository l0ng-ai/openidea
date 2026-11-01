//! Agents and how to launch them: the built-in ones, plus user-defined agents from
//! `<config>/agents/<id>.toml` (written by hand, or by installing one from the ACP
//! Registry, see `registry`).

use crate::AgentSource;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The protocol an agent speaks. Native ones run behind an in-process ACP endpoint
/// (`native`), so tasks see every agent as ACP and read features from its capabilities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Driver {
    #[default]
    Acp,
    /// `codex app-server`.
    Codex,
    /// `claude` in stream-json mode.
    Claude,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// How to sign in when the agent reports it needs authentication.
    pub login_hint: String,
    pub source: AgentSource,
}

/// `(id, name, driver, command line, sign-in hint)`. npm adapters are pinned so a
/// session's protocol does not change under the user.
const BUILTIN: &[(&str, &str, Driver, &[&str], &str)] = &[
    ("claude", "Claude Code", Driver::Claude, &["claude"], "Run `claude` in a terminal and sign in."),
    ("codex", "Codex", Driver::Codex, &["codex", "app-server"], "Run `codex login` in a terminal."),
    (
        "claude-acp",
        "Claude Code (ACP)",
        Driver::Acp,
        &["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.97.0"],
        "Run `claude` in a terminal and sign in.",
    ),
    (
        "codex-acp",
        "Codex (ACP)",
        Driver::Acp,
        &["npx", "-y", "@agentclientprotocol/codex-acp@2.3.0"],
        "Run `codex login` in a terminal.",
    ),
    ("gemini", "Gemini CLI", Driver::Acp, &["gemini", "--experimental-acp"], "Run `gemini` in a terminal and sign in."),
    ("copilot", "GitHub Copilot", Driver::Acp, &["copilot", "--acp"], "Run `copilot` in a terminal and sign in."),
    ("cursor", "Cursor", Driver::Acp, &["cursor-agent", "acp"], "Run `cursor-agent login` in a terminal."),
    ("opencode", "OpenCode", Driver::Acp, &["opencode", "acp"], "Run `opencode auth login` in a terminal."),
    ("qwen", "Qwen Code", Driver::Acp, &["qwen", "--experimental-acp"], "Run `qwen` in a terminal and sign in."),
    ("kimi", "Kimi CLI", Driver::Acp, &["kimi", "acp"], "Run `kimi` in a terminal and sign in."),
    ("goose", "Goose", Driver::Acp, &["goose", "acp"], "Run `goose configure` in a terminal."),
    ("auggie", "Auggie", Driver::Acp, &["auggie", "--acp"], "Run `auggie login` in a terminal."),
    ("kiro", "Kiro", Driver::Acp, &["kiro-cli", "acp"], "Run `kiro-cli login` in a terminal."),
    ("vibe", "Mistral Vibe", Driver::Acp, &["vibe-acp"], "Run `vibe` in a terminal and sign in."),
];

fn builtins() -> Vec<ProviderSpec> {
    BUILTIN
        .iter()
        .map(|(id, name, driver, cmd, hint)| ProviderSpec {
            id: (*id).into(),
            name: (*name).into(),
            driver: *driver,
            command: cmd[0].into(),
            args: cmd[1..].iter().map(|a| (*a).to_owned()).collect(),
            env: Vec::new(),
            login_hint: (*hint).into(),
            source: AgentSource::Builtin,
        })
        .collect()
}

/// Whether `id` names a built-in agent.
pub(crate) fn is_builtin(id: &str) -> bool {
    BUILTIN.iter().any(|b| b.0 == id)
}

/// The built-in spec of `id`.
pub(crate) fn builtin_spec(id: &str) -> Option<ProviderSpec> {
    builtins().into_iter().find(|s| s.id == id)
}

/// Overrides built-in `id`'s command through its agent file, preserving other
/// customizations. `None` restores the built-in command and removes a redundant file.
pub(crate) fn set_builtin_command(custom_dir: &Path, id: &str, command: Option<&str>) -> IdeResult<()> {
    let Some(builtin) = builtin_spec(id) else {
        return Err(IdeError::invalid(format!("{id} is not a built-in agent")));
    };
    let file = custom_dir.join(format!("{id}.toml"));
    let mut agent = if file.try_exists()? {
        CustomAgent::read(&file).map_err(IdeError::invalid)?
    } else {
        CustomAgent {
            name: Some(builtin.name.clone()),
            driver: builtin.driver,
            command: builtin.command.clone(),
            args: builtin.args.clone(),
            env: BTreeMap::new(),
            registry: None,
        }
    };
    if agent.registry.is_some() {
        return Err(IdeError::invalid(format!("{id} is installed from the ACP Registry")));
    }
    if command.is_none()
        && agent.name.as_deref() == Some(builtin.name.as_str())
        && agent.driver == builtin.driver
        && agent.args == builtin.args
        && agent.env.is_empty()
    {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        return Ok(());
    }
    agent.command = command.unwrap_or(&builtin.command).to_owned();
    agent.write(&file)?;
    Ok(())
}

/// An agent file, `<config>/agents/<id>.toml`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CustomAgent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Driver::is_acp")]
    pub driver: Driver,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Set when the agent was installed from the ACP Registry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<RegistryRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RegistryRef {
    pub id: String,
    pub version: String,
}

impl Driver {
    fn is_acp(&self) -> bool {
        *self == Driver::Acp
    }
}

impl CustomAgent {
    pub(crate) fn read(path: &Path) -> Result<Self, String> {
        std::fs::read_to_string(path)
            .map_err(|e| e.to_string())
            .and_then(|t| toml::from_str::<CustomAgent>(&t).map_err(|e| e.to_string()))
    }

    /// Writes the file atomically (a reader never sees half of it).
    pub(crate) fn write(&self, path: &Path) -> std::io::Result<()> {
        let text = toml::to_string(self).map_err(std::io::Error::other)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }
}

/// Built-in agents, then the `*.toml` agents of `custom_dir`; a custom agent with a
/// built-in id replaces it.
pub(crate) fn load(custom_dir: Option<&Path>) -> Vec<ProviderSpec> {
    let mut specs = builtins();
    let mut files: Vec<PathBuf> = custom_dir
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "toml"))
        .collect();
    files.sort();
    for path in files {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue };
        let agent = match CustomAgent::read(&path) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("skipping agent {}: {e}", path.display());
                continue;
            }
        };
        let env: Vec<(String, String)> = agent.env.into_iter().collect();
        let source = match agent.registry {
            Some(r) => AgentSource::Registry { version: r.version, update: None },
            None => AgentSource::Custom,
        };
        let spec = ProviderSpec {
            name: agent.name.unwrap_or_else(|| id.clone()),
            driver: agent.driver,
            command: agent.command,
            args: agent.args,
            env,
            login_hint: "Sign in with the agent's own command line first.".into(),
            source,
            id,
        };
        match specs.iter_mut().find(|s| s.id == spec.id) {
            Some(existing) => *existing = spec,
            None => specs.push(spec),
        }
    }
    specs
}

/// Whether `command` resolves to an executable (a path, or a name on `PATH`).
pub(crate) fn installed(command: &str) -> bool {
    let p = Path::new(command);
    if p.components().count() > 1 {
        return is_executable(p);
    }
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[] };
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            let c = dir.join(command);
            is_executable(&c) || exts.iter().any(|e| is_executable(&c.with_extension(e)))
        })
    })
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_agents_extend_and_override_the_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
        write("mine.toml", "name = \"Mine\"\ncommand = \"/opt/mine\"\nargs = [\"acp\"]\n[env]\nK = \"v\"\n");
        write("gemini.toml", "command = \"gemini\"\nargs = [\"--acp\"]\n");
        write("broken.toml", "nope = 1\n");
        let specs = load(Some(dir.path()));
        let mine = specs.iter().find(|s| s.id == "mine").unwrap();
        assert_eq!((mine.name.as_str(), mine.command.as_str()), ("Mine", "/opt/mine"));
        assert_eq!(mine.env, vec![("K".to_owned(), "v".to_owned())]);
        let gemini = specs.iter().find(|s| s.id == "gemini").unwrap();
        assert_eq!((gemini.name.as_str(), gemini.args.as_slice()), ("gemini", &["--acp".to_owned()][..]));
        assert!(!specs.iter().any(|s| s.id == "broken"));
        assert_eq!(specs.iter().filter(|s| s.id == "claude").count(), 1);
        assert!(!installed("/definitely/not/here"));
        assert!(installed("sh"));
    }

    #[test]
    fn set_builtin_command_overrides_and_clears_a_builtin() {
        let dir = tempfile::tempdir().unwrap();
        set_builtin_command(dir.path(), "not-a-builtin", Some("/x")).unwrap_err();
        set_builtin_command(dir.path(), "claude", Some("/opt/claude")).unwrap();
        let claude = load(Some(dir.path())).into_iter().find(|s| s.id == "claude").unwrap();
        assert_eq!((claude.command.as_str(), claude.driver), ("/opt/claude", Driver::Claude));
        assert!(claude.args.is_empty());
        // A registry install is neither overwritten nor removed by a command override.
        let path = dir.path().join("codex.toml");
        CustomAgent {
            name: None,
            driver: Driver::Acp,
            command: "amp".into(),
            args: vec![],
            env: BTreeMap::new(),
            registry: Some(RegistryRef { id: "amp-acp".into(), version: "1.0.0".into() }),
        }
        .write(&path)
        .unwrap();
        set_builtin_command(dir.path(), "codex", Some("/x")).unwrap_err();
        set_builtin_command(dir.path(), "codex", None).unwrap_err();
        assert!(path.exists());
        // Clearing (twice) returns the built-in to auto-detection.
        set_builtin_command(dir.path(), "claude", None).unwrap();
        set_builtin_command(dir.path(), "claude", None).unwrap();
        assert!(!dir.path().join("claude.toml").exists());
        assert_eq!(load(Some(dir.path())).iter().find(|s| s.id == "claude").unwrap().command, "claude");
    }

    #[test]
    fn set_builtin_command_preserves_other_customizations_on_save_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude.toml");
        for field in ["name", "driver", "args", "env", "unnamed"] {
            let mut agent = CustomAgent {
                name: Some("Claude Code".into()),
                driver: Driver::Claude,
                command: "/old/claude".into(),
                args: vec![],
                env: BTreeMap::new(),
                registry: None,
            };
            match field {
                "name" => agent.name = Some("My Claude".into()),
                "driver" => agent.driver = Driver::Acp,
                "args" => agent.args.push("--verbose".into()),
                "env" => {
                    agent.env.insert("K".into(), "v".into());
                }
                "unnamed" => agent.name = None,
                _ => unreachable!(),
            }
            agent.write(&path).unwrap();

            set_builtin_command(dir.path(), "claude", Some("/new/claude")).unwrap();
            agent.command = "/new/claude".into();
            assert_eq!(CustomAgent::read(&path).unwrap(), agent, "{field}");

            set_builtin_command(dir.path(), "claude", None).unwrap();
            agent.command = "claude".into();
            assert_eq!(CustomAgent::read(&path).unwrap(), agent, "{field}");
        }
    }

    #[test]
    fn resetting_a_command_only_override_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex.toml");
        std::fs::write(
            &path,
            "name = \"Codex\"\ndriver = \"codex\"\ncommand = \"/custom/codex\"\nargs = [\"app-server\"]\n",
        )
        .unwrap();

        set_builtin_command(dir.path(), "codex", None).unwrap();

        assert!(!path.exists());
        assert_eq!(
            load(Some(dir.path())).into_iter().find(|s| s.id == "codex").unwrap(),
            builtin_spec("codex").unwrap()
        );
    }

    #[test]
    fn agent_files_round_trip_with_their_registry_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents").join("amp-acp.toml");
        let agent = CustomAgent {
            name: Some("Amp".into()),
            driver: Driver::Acp,
            command: "/data/agents/tools/amp-acp/0.10.0/amp-acp".into(),
            args: vec!["acp".into()],
            env: BTreeMap::from([("K".to_owned(), "v".to_owned())]),
            registry: Some(RegistryRef { id: "amp-acp".into(), version: "0.10.0".into() }),
        };
        agent.write(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[registry]") && !text.contains("driver"), "{text}");
        assert_eq!(CustomAgent::read(&path).unwrap(), agent);
        let spec = load(Some(path.parent().unwrap())).into_iter().find(|s| s.id == "amp-acp").unwrap();
        assert_eq!(spec.source, AgentSource::Registry { version: "0.10.0".into(), update: None });
        assert!(toml::from_str::<CustomAgent>("command = \"x\"\n[registry]\nid = \"x\"\n").is_err());
    }
}
