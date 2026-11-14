//! Agents and how to launch them: the built-in ones, plus user-defined agents from
//! `<config>/agents/<id>.toml` (written by hand, or by installing one from the ACP
//! Registry, see `registry`).

use crate::{AcpImportOutcome, AgentCommandReadOnlyReason, AgentProvider, AgentSource, CustomAgentInput, EnvSecrets};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    ("qoder", "Qoder", Driver::Acp, &["qodercli", "--acp"], "Run `qodercli login` in a terminal."),
    ("qodercn", "Qoder CN", Driver::Acp, &["qoderclicn", "--acp"], "Run `qoderclicn login` in a terminal."),
    ("kimi", "Kimi CLI", Driver::Acp, &["kimi", "acp"], "Run `kimi` in a terminal and sign in."),
    ("goose", "Goose", Driver::Acp, &["goose", "acp"], "Run `goose configure` in a terminal."),
    ("auggie", "Auggie", Driver::Acp, &["auggie", "--acp"], "Run `auggie login` in a terminal."),
    ("kiro", "Kiro", Driver::Acp, &["kiro-cli", "acp"], "Run `kiro-cli login` in a terminal."),
    ("vibe", "Mistral Vibe", Driver::Acp, &["vibe-acp"], "Run `vibe` in a terminal and sign in."),
    ("omp", "OMP", Driver::Acp, &["omp", "acp"], "Run `omp` in a terminal and sign in."),
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

impl ProviderSpec {
    pub(crate) fn login_hint(&self, program: &Path) -> String {
        if !program.is_absolute() {
            return self.login_hint.clone();
        }
        let search = ide_core::process::host_var_os("PATH").unwrap_or_default();
        let builtin = builtin_spec(&self.id);
        let on_path = builtin.as_ref().and_then(|b| ide_core::process::find_executable(&b.command, &search));
        render_login_hint(self, program, on_path.as_deref(), cfg!(windows))
    }

    pub(crate) fn sign_in_message(&self, auth_methods: &[Value]) -> String {
        let name = &self.name;
        let program = Path::new(&self.command);
        let terminal_args = matches!(self.source, AgentSource::Registry { .. })
            .then(|| {
                auth_methods.iter().find_map(|method| {
                    if method.get("type").and_then(Value::as_str) != Some("terminal") {
                        return None;
                    }
                    method.get("args")?.as_array()?.iter().map(Value::as_str).collect::<Option<Vec<_>>>()
                })
            })
            .flatten();
        let hint = match terminal_args {
            Some(args) => {
                let command = render_login_command(program, args, cfg!(windows));
                format!("Run `{command}` in a terminal.")
            }
            None => self.login_hint(program),
        };
        format!("{name} needs you to sign in. {hint}")
    }

    /// Resolve once before connecting, so authentication guidance names that same install.
    pub(crate) fn resolve_for_launch(mut self, cwd: &Path) -> Self {
        if self.driver != Driver::Acp {
            self.command = crate::native::newest_install(&self.command);
        }
        let program = ide_jsonrpc::resolve_spawn_program(&self.command, &self.env);
        self.command =
            if program.components().count() > 1 && !program.is_absolute() { cwd.join(program) } else { program }
                .to_string_lossy()
                .into_owned();
        self
    }
}

fn render_login_hint(spec: &ProviderSpec, program: &Path, on_path: Option<&Path>, windows: bool) -> String {
    let Some(builtin) = builtin_spec(&spec.id) else { return spec.login_hint.clone() };
    let prefix = format!("Run `{}", builtin.command);
    let Some(rest) = spec.login_hint.strip_prefix(&prefix).filter(|rest| rest.starts_with([' ', '`'])) else {
        return spec.login_hint.clone();
    };
    let same_path = |a: &Path, b: &Path| {
        a == b || dunce::canonicalize(a).ok().zip(dunce::canonicalize(b).ok()).is_some_and(|(a, b)| a == b)
    };
    if on_path.is_some_and(|path| same_path(path, program)) {
        return spec.login_hint.clone();
    }
    let (args, suffix) = rest.split_once('`').expect("built-in login hints delimit their command");
    let command = render_login_command(program, args.split_whitespace(), windows);
    match suffix {
        " in a terminal." => format!("Run `{command}` in a terminal."),
        " in a terminal and sign in." => format!("Run `{command}` in a terminal and sign in."),
        _ => spec.login_hint.clone(),
    }
}

fn render_login_command<'a>(program: &Path, args: impl IntoIterator<Item = &'a str>, windows: bool) -> String {
    let quote = |word: &str| {
        if windows { format!("'{}'", word.replace('\'', "''")) } else { format!("'{}'", word.replace('\'', "'\\''")) }
    };
    let mut command = format!("{}{}", if windows { "& " } else { "" }, quote(&program.to_string_lossy()));
    for arg in args {
        command.push(' ');
        if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_=./".contains(c)) {
            command.push_str(arg);
        } else {
            command.push_str(&quote(arg));
        }
    }
    command
}

/// Whether `id` names a built-in agent that needs no registry install (native drivers
/// and `npx -y` adapters). CLI built-ins (`copilot`, `gemini`, …) can be installed and
/// updated from the ACP Registry into `<config>/agents/<id>.toml`.
pub(crate) fn is_builtin(id: &str) -> bool {
    BUILTIN.iter().any(|&(bid, _, driver, cmd, _)| bid == id && (driver != Driver::Acp || cmd.first() == Some(&"npx")))
}

/// Display name of a built-in agent, when `id` is one.
pub(crate) fn builtin_name(id: &str) -> Option<&'static str> {
    BUILTIN.iter().find(|&&(bid, _, _, _, _)| bid == id).map(|&(_, name, _, _, _)| name)
}

/// The built-in spec of `id`.
pub(crate) fn builtin_spec(id: &str) -> Option<ProviderSpec> {
    builtins().into_iter().find(|s| s.id == id)
}

/// The ACP adapters of Claude Code and Codex, which the native drivers replace: they still
/// launch, but are listed only once customized through an agent file or used by a task.
const UNLISTED: &[&str] = &["claude-acp", "codex-acp"];

pub(crate) fn is_unlisted(spec: &ProviderSpec) -> bool {
    UNLISTED.contains(&spec.id.as_str()) && builtin_spec(&spec.id).as_ref() == Some(spec)
}

/// Public launch metadata, keeping the built-in defaults separate from agent-file overrides.
pub(crate) fn describe(spec: &ProviderSpec) -> AgentProvider {
    let builtin = builtin_spec(&spec.id);
    let reason = if matches!(spec.source, AgentSource::Registry { .. }) {
        Some(AgentCommandReadOnlyReason::Registry)
    } else if let Some(default) = &builtin {
        matches!(default.command.as_str(), "npx" | "bunx" | "uvx").then_some(AgentCommandReadOnlyReason::PackageRunner)
    } else {
        Some(AgentCommandReadOnlyReason::CustomAgent)
    };
    AgentProvider {
        id: spec.id.clone(),
        name: spec.name.clone(),
        command: std::iter::once(spec.command.as_str())
            .chain(spec.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        program: spec.command.clone(),
        args: spec.args.clone(),
        default_program: builtin.as_ref().map(|b| b.command.clone()),
        default_args: builtin.as_ref().map(|b| b.args.clone()).unwrap_or_default(),
        login_hint: Some(spec.login_hint(&ide_jsonrpc::resolve_spawn_program(&spec.command, &spec.env))),
        command_overridden: builtin.as_ref().is_some_and(|b| b.command != spec.command),
        command_editable: reason.is_none(),
        command_read_only_reason: reason,
        installed: installed(&spec.command),
        env: spec.env.iter().cloned().collect(),
        config: vec![],
        thought_levels: BTreeMap::new(),
        commands: vec![],
        source: spec.source.clone(),
    }
}

/// Overrides built-in `id`'s command through its agent file, preserving other
/// customizations. `None` restores the built-in command and removes a redundant file.
pub(crate) fn set_builtin_command(
    custom_dir: &Path,
    secrets: Option<&dyn EnvSecrets>,
    id: &str,
    command: Option<&str>,
) -> IdeResult<()> {
    update_builtin(custom_dir, secrets, id, |agent, builtin| {
        agent.command = command.unwrap_or(&builtin.command).to_owned()
    })
}

/// The environment built-in `id` starts with, through its agent file (empty clears it).
pub(crate) fn set_builtin_env(
    custom_dir: &Path,
    secrets: Option<&dyn EnvSecrets>,
    id: &str,
    env: BTreeMap<String, String>,
) -> IdeResult<()> {
    update_builtin(custom_dir, secrets, id, |agent, _| agent.env = env)
}

/// Changes built-in `id`'s agent file; a file left with only the built-in's values is removed.
fn update_builtin(
    custom_dir: &Path,
    secrets: Option<&dyn EnvSecrets>,
    id: &str,
    change: impl FnOnce(&mut CustomAgent, &ProviderSpec),
) -> IdeResult<()> {
    let Some(builtin) = builtin_spec(id) else {
        return Err(IdeError::invalid(format!("{id} is not a built-in agent")));
    };
    let file = custom_dir.join(format!("{id}.toml"));
    let mut agent = if file.try_exists()? {
        CustomAgent::read_with(&file, id, secrets).map_err(IdeError::invalid)?
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
    change(&mut agent, &builtin);
    if agent.command == builtin.command
        && agent.name.as_deref() == Some(builtin.name.as_str())
        && agent.driver == builtin.driver
        && agent.args == builtin.args
        && agent.env.is_empty()
    {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        forget_env(secrets, id, &[]);
        return Ok(());
    }
    agent.write_with(&file, id, secrets)
}

/// Saves a new custom agent; refuses built-in and ACP Registry ids, taken ids
/// and an empty command. The id is also the agent file's name, so it must be
/// a safe file stem.
pub(crate) fn save_custom(
    custom_dir: &Path,
    secrets: Option<&dyn EnvSecrets>,
    input: &CustomAgentInput,
) -> IdeResult<()> {
    let id = validated_custom_id(&input.id)?;
    if builtin_spec(&id).is_some() {
        return Err(IdeError::invalid(format!("{id} is a built-in agent; change its command instead")));
    }
    if input.command.trim().is_empty() {
        return Err(IdeError::invalid("the agent command must not be empty"));
    }
    let file = custom_dir.join(format!("{id}.toml"));
    if file.try_exists()? {
        if CustomAgent::read(&file).is_ok_and(|a| a.registry.is_some()) {
            return Err(IdeError::invalid(format!(
                "{id} is installed from the ACP Registry; uninstall it there to replace it"
            )));
        }
        return Err(IdeError::invalid(format!("there is already a custom agent '{id}'")));
    }
    CustomAgent {
        name: Some(input.name.clone()),
        driver: Driver::Acp,
        command: input.command.clone(),
        args: input.args.clone(),
        env: input.env.clone(),
        registry: None,
    }
    .write_with(&file, &id, secrets)
}

/// Removes a custom agent's file; refuses built-in, ACP Registry and missing ids.
pub(crate) fn remove_custom(custom_dir: &Path, secrets: Option<&dyn EnvSecrets>, id: &str) -> IdeResult<()> {
    let id = validated_custom_id(id)?;
    let id = id.as_str();
    if builtin_spec(id).is_some() {
        return Err(IdeError::invalid(format!("{id} is a built-in agent and cannot be removed")));
    }
    let file = custom_dir.join(format!("{id}.toml"));
    let agent =
        CustomAgent::read(&file).map_err(|_| IdeError::not_found(format!("there is no custom agent '{id}'")))?;
    if agent.registry.is_some() {
        return Err(IdeError::invalid(format!("{id} is installed from the ACP Registry; uninstall it there")));
    }
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => {
            forget_env(secrets, id, &[]);
            Ok(())
        }
    }
}

/// Imports a JetBrains `acp.json` file's `agent_servers` entries as custom
/// agents, one outcome per entry; entries that collide, lack a command or
/// have no usable name are skipped with a reason.
pub(crate) fn import_acp(
    custom_dir: &Path,
    secrets: Option<&dyn EnvSecrets>,
    text: &str,
) -> IdeResult<Vec<AcpImportOutcome>> {
    #[derive(Deserialize)]
    struct AcpJson {
        #[serde(default)]
        agent_servers: BTreeMap<String, AcpServer>,
    }
    #[derive(Deserialize)]
    struct AcpServer {
        #[serde(default)]
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    }
    let parsed: AcpJson =
        serde_json::from_str(text).map_err(|e| IdeError::invalid(format!("not an acp.json file: {e}")))?;
    let mut outcomes = Vec::with_capacity(parsed.agent_servers.len());
    for (name, server) in parsed.agent_servers {
        let id = slugify_id(&name);
        let mut outcome = AcpImportOutcome { name, id: id.clone(), saved: false, reason: String::new() };
        if id.is_empty() {
            outcome.reason = "the name has no usable characters for an id".to_owned();
        } else if builtin_spec(&id).is_some() {
            outcome.reason = format!("{id} is a built-in agent");
        } else if server.command.trim().is_empty() {
            outcome.reason = "the entry has no command".to_owned();
        } else if custom_dir.join(format!("{id}.toml")).try_exists()? {
            outcome.reason = format!("there is already a custom agent '{id}'");
        } else {
            CustomAgent {
                name: Some(outcome.name.clone()),
                driver: Driver::Acp,
                command: server.command,
                args: server.args,
                env: server.env,
                registry: None,
            }
            .write_with(&custom_dir.join(format!("{id}.toml")), &id, secrets)?;
            outcome.saved = true;
        }
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

/// A custom agent id doubles as a file stem: letters, digits, `-` and `_` only.
fn validated_custom_id(id: &str) -> IdeResult<String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Ok(id.to_owned());
    }
    Err(IdeError::invalid(format!("'{id}' is not a usable agent id (letters, digits, '-' and '_' only)")))
}

/// Turns an `acp.json` server name into a file-stem id (`"My Agent!"` → `"my-agent"`).
fn slugify_id(name: &str) -> String {
    let mut id = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            id.push(c.to_ascii_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_matches('-').to_owned()
}

/// An agent file, `<config>/agents/<id>.toml`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

    /// Reads agent `id`'s file with its environment values filled in from `secrets`; values
    /// still written in the file (by hand, by an older version) move there first. A registry
    /// install keeps the environment its registry entry gives it in the file.
    pub(crate) fn read_with(path: &Path, id: &str, secrets: Option<&dyn EnvSecrets>) -> Result<Self, String> {
        let mut agent = Self::read(path)?;
        let Some(secrets) = secrets.filter(|_| agent.registry.is_none()) else {
            return Ok(agent);
        };
        let written = agent.env.values().any(|v| !v.is_empty());
        for (name, value) in agent.env.iter_mut() {
            if value.is_empty()
                && let Some(saved) = secrets.get(&env_key(id, name))
            {
                *value = saved;
            }
        }
        if written && let Err(e) = agent.write_with(path, id, Some(secrets)) {
            tracing::warn!("agent {id}: could not move environment values out of {}: {}", path.display(), e.message);
        }
        Ok(agent)
    }

    /// Writes agent `id`'s file with the environment's names only, its values saved in `secrets`.
    pub(crate) fn write_with(&self, path: &Path, id: &str, secrets: Option<&dyn EnvSecrets>) -> IdeResult<()> {
        let Some(secrets) = secrets.filter(|_| self.registry.is_none()) else {
            return Ok(self.write(path)?);
        };
        let mut keys = Vec::with_capacity(self.env.len());
        for (name, value) in &self.env {
            let key = env_key(id, name);
            if value.is_empty() {
                secrets.delete(&key);
            } else if secrets.get(&key).as_deref() != Some(value.as_str()) {
                secrets.set(&key, value)?;
            }
            keys.push(key);
        }
        forget_env(Some(secrets), id, &keys);
        let names = self.env.keys().map(|name| (name.clone(), String::new())).collect();
        Ok(Self { env: names, ..self.clone() }.write(path)?)
    }
}

fn env_key(id: &str, name: &str) -> String {
    format!("agent/{id}/env/{}", name.replace('%', "%25").replace('/', "%2F"))
}

/// Forgets agent `id`'s saved environment values, except `keep`.
fn forget_env(secrets: Option<&dyn EnvSecrets>, id: &str, keep: &[String]) {
    let Some(secrets) = secrets else { return };
    for key in secrets.keys(&format!("agent/{id}/env/")) {
        if !keep.contains(&key) {
            secrets.delete(&key);
        }
    }
}

/// Built-in agents, then the `*.toml` agents of `custom_dir`; a custom agent with a
/// built-in id replaces it.
pub(crate) fn load(custom_dir: Option<&Path>, secrets: Option<&dyn EnvSecrets>) -> Vec<ProviderSpec> {
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
        let agent = match CustomAgent::read_with(&path, &id, secrets) {
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
        let mut spec = ProviderSpec {
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
            Some(existing) => {
                spec.login_hint = existing.login_hint.clone();
                if spec.source == AgentSource::Custom {
                    spec.source = AgentSource::Builtin;
                }
                *existing = spec;
            }
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
    use serde_json::json;

    #[test]
    fn qoder_global_and_cn_editions_are_both_built_in() {
        let info = |id: &str| describe(&load(None, None).into_iter().find(|s| s.id == id).unwrap());
        let (global, cn) = (info("qoder"), info("qodercn"));
        assert_eq!((global.name.as_str(), global.command.as_str()), ("Qoder", "qodercli --acp"));
        assert_eq!((cn.name.as_str(), cn.command.as_str()), ("Qoder CN", "qoderclicn --acp"));
        assert_eq!(global.login_hint.as_deref(), Some("Run `qodercli login` in a terminal."));
    }

    #[test]
    fn qodercn_is_available_without_a_file_and_preserves_existing_customizations() {
        let dir = tempfile::tempdir().unwrap();
        let qodercn = load(None, None).into_iter().find(|s| s.id == "qodercn").unwrap();
        assert_eq!(qodercn.driver, Driver::Acp);
        assert!(!is_unlisted(&qodercn));
        let info = describe(&qodercn);
        assert_eq!(info.name, "Qoder CN");
        assert_eq!(info.command, "qoderclicn --acp");
        assert_eq!(info.source, AgentSource::Builtin);
        assert!(info.command_editable);
        assert_eq!(info.login_hint.as_deref(), Some("Run `qoderclicn login` in a terminal."));

        std::fs::write(
            dir.path().join("qodercn.toml"),
            "command = \"/custom/qoderclicn\"\nargs = [\"--acp\"]\n[env]\nK = \"v\"\n",
        )
        .unwrap();
        let specs = load(Some(dir.path()), None);
        assert_eq!(specs.iter().filter(|s| s.id == "qodercn").count(), 1);
        let custom = specs.iter().find(|s| s.id == "qodercn").unwrap();
        assert_eq!(custom.command, "/custom/qoderclicn");
        assert_eq!(custom.env, [("K".into(), "v".into())]);
        set_builtin_command(dir.path(), None, "qodercn", None).unwrap();
        let reset = load(Some(dir.path()), None).into_iter().find(|s| s.id == "qodercn").unwrap();
        assert_eq!(reset.command, "qoderclicn");
        assert_eq!(reset.args, ["--acp"]);
        assert_eq!(reset.env, custom.env);
    }

    #[test]
    fn login_hints_cover_all_builtin_commands_and_preserve_separate_login_tools() {
        for spec in builtins() {
            let separate = matches!(spec.id.as_str(), "claude-acp" | "codex-acp" | "vibe");
            for windows in [false, true] {
                let program =
                    if windows { Path::new(r"C:\Agent Tools\renamed.cmd") } else { Path::new("/agent tools/renamed") };
                let hint = render_login_hint(&spec, program, None, windows);
                if separate {
                    assert_eq!(hint, spec.login_hint, "{}", spec.id);
                } else {
                    let prefix =
                        if windows { "Run `& 'C:\\Agent Tools\\renamed.cmd'" } else { "Run `'/agent tools/renamed'" };
                    assert!(hint.starts_with(prefix), "{}: {hint}", spec.id);
                    assert_eq!(
                        render_login_hint(&spec, program, Some(program), windows),
                        spec.login_hint,
                        "a PATH-resolved command stays bare: {}",
                        spec.id
                    );
                    assert_eq!(render_login_hint(&spec, program, Some(Path::new("/other/install")), windows), hint);
                }
            }
        }
    }

    #[test]
    fn login_commands_quote_shell_metacharacters_and_keep_arguments() {
        let cursor = builtin_spec("cursor").unwrap();
        assert_eq!(
            render_login_hint(&cursor, Path::new("/agent's tools/$cli"), None, false),
            "Run `'/agent'\\''s tools/$cli' login` in a terminal."
        );
        assert_eq!(
            render_login_hint(&cursor, Path::new(r"C:\agent's tools\$cli.cmd"), None, true),
            r"Run `& 'C:\agent''s tools\$cli.cmd' login` in a terminal."
        );
        let opencode = builtin_spec("opencode").unwrap();
        assert_eq!(
            render_login_hint(&opencode, Path::new("/registry/opencode"), None, false),
            "Run `'/registry/opencode' auth login` in a terminal."
        );
        let mut custom = cursor;
        custom.id = "custom".into();
        custom.login_hint = "Sign in with the agent's own command line first.".into();
        assert_eq!(render_login_hint(&custom, Path::new("/custom"), None, false), custom.login_hint);
    }

    #[test]
    fn launch_resolution_uses_the_child_path_and_absolutizes_relative_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let mut cursor = builtin_spec("cursor").unwrap();
        let command = if cfg!(windows) { "cursor-agent.cmd" } else { "cursor-agent" };
        let program = dir.path().join(command);
        std::fs::write(&program, "").unwrap();
        cursor.env.push(("PATH".into(), dir.path().to_string_lossy().into_owned()));
        let resolved = cursor.clone().resolve_for_launch(dir.path());
        assert_eq!(Path::new(&resolved.command), program);
        assert!(resolved.sign_in_message(&[]).contains(&*program.to_string_lossy()));
        cursor.command = format!("tools/{command}");
        let resolved = cursor.resolve_for_launch(dir.path());
        assert_eq!(Path::new(&resolved.command), dir.path().join("tools").join(command));
    }

    #[test]
    fn terminal_login_commands_quote_the_binary_and_each_argument() {
        for (windows, expected) in [
            (false, "'/agent'\\''s tools/$cli' auth login --account 'user name' 'a'\\''b' '$token' ''"),
            (true, "& '/agent''s tools/$cli' auth login --account 'user name' 'a''b' '$token' ''"),
        ] {
            assert_eq!(
                render_login_command(
                    Path::new("/agent's tools/$cli"),
                    ["auth", "login", "--account", "user name", "a'b", "$token", ""],
                    windows
                ),
                expected
            );
        }
        let mut spec = builtin_spec("cursor").unwrap();
        spec.id = "custom".into();
        spec.source = AgentSource::Registry { version: "1.4.5".into(), update: None };
        spec.login_hint = "Sign in with the agent's own command line first.".into();
        for method in [
            json!({"type": "terminal"}),
            json!({"type": "terminal", "args": ["login", null]}),
            json!({"type": "agent", "args": ["login"]}),
        ] {
            assert_eq!(
                spec.sign_in_message(&[method]),
                "Cursor needs you to sign in. Sign in with the agent's own command line first."
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn registry_login_hint_names_the_installed_executable() {
        let mut spec = builtin_spec("cursor").unwrap();
        spec.command = "/registry path/dist-package/cursor-agent".into();
        assert_eq!(
            describe(&spec).login_hint.as_deref(),
            Some("Run `'/registry path/dist-package/cursor-agent' login` in a terminal.")
        );
    }

    #[test]
    fn launch_metadata_distinguishes_defaults_overrides_and_read_only_agents() {
        let dir = tempfile::tempdir().unwrap();
        let list = || load(Some(dir.path()), None).iter().map(describe).collect::<Vec<_>>();
        let defaults = list();
        let codex = defaults.iter().find(|p| p.id == "codex").unwrap();
        assert_eq!(codex.program, "codex");
        assert_eq!(codex.default_program.as_deref(), Some("codex"));
        assert_eq!(codex.args, ["app-server"]);
        assert_eq!(codex.default_args, codex.args);
        assert_eq!(codex.command, "codex app-server");
        assert_eq!(codex.login_hint.as_deref(), Some("Run `codex login` in a terminal."));
        assert!(!codex.command_overridden);
        assert!(codex.command_editable);
        for p in &defaults {
            assert_eq!(p.source, AgentSource::Builtin);
            assert!(p.default_program.is_some());
            assert_eq!(p.command_editable, !p.id.ends_with("-acp"));
            assert_eq!(
                p.command_read_only_reason,
                p.id.ends_with("-acp").then_some(AgentCommandReadOnlyReason::PackageRunner)
            );
        }
        set_builtin_command(dir.path(), None, "codex", Some("/path with spaces/codex")).unwrap();
        let overridden = list().into_iter().find(|p| p.id == "codex").unwrap();
        assert_eq!(overridden.program, "/path with spaces/codex");
        assert_eq!(overridden.args, codex.args);
        assert_eq!(overridden.default_program, codex.default_program);
        assert!(overridden.command_overridden && overridden.command_editable);
        assert_eq!(overridden.source, AgentSource::Builtin);
        set_builtin_command(dir.path(), None, "codex", Some("codex")).unwrap();
        assert!(!list().iter().find(|p| p.id == "codex").unwrap().command_overridden);
        std::fs::write(
            dir.path().join("gemini.toml"),
            "command = \"/registry/gemini\"\n[registry]\nid = \"gemini\"\nversion = \"1.0\"\n",
        )
        .unwrap();
        let registry = list().into_iter().find(|p| p.id == "gemini").unwrap();
        assert_eq!(registry.default_program.as_deref(), Some("gemini"));
        assert!(!registry.command_editable);
        assert_eq!(registry.command_read_only_reason, Some(AgentCommandReadOnlyReason::Registry));
        assert!(matches!(registry.source, AgentSource::Registry { .. }));
        std::fs::write(dir.path().join("mine.toml"), "command = \"mine\"\n").unwrap();
        let custom = list().into_iter().find(|p| p.id == "mine").unwrap();
        assert_eq!(custom.default_program, None);
        assert_eq!(custom.command_read_only_reason, Some(AgentCommandReadOnlyReason::CustomAgent));
    }

    #[test]
    fn custom_agents_extend_and_override_the_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
        write("mine.toml", "name = \"Mine\"\ncommand = \"/opt/mine\"\nargs = [\"acp\"]\n[env]\nK = \"v\"\n");
        write("gemini.toml", "command = \"gemini\"\nargs = [\"--acp\"]\n");
        write("broken.toml", "nope = 1\n");
        let specs = load(Some(dir.path()), None);
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
    fn set_builtin_env_writes_and_clears_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("CLAUDE_CODE_ENTRYPOINT".to_owned(), "openidea".to_owned())]);
        set_builtin_env(dir.path(), None, "claude", env.clone()).unwrap();
        let claude = load(Some(dir.path()), None).into_iter().find(|s| s.id == "claude").unwrap();
        assert_eq!(claude.env, vec![("CLAUDE_CODE_ENTRYPOINT".to_owned(), "openidea".to_owned())]);
        assert_eq!(describe(&claude).env, env);
        // The command override and the environment are kept independently.
        set_builtin_command(dir.path(), None, "claude", Some("/opt/claude")).unwrap();
        set_builtin_command(dir.path(), None, "claude", None).unwrap();
        assert!(dir.path().join("claude.toml").is_file());
        set_builtin_env(dir.path(), None, "claude", BTreeMap::new()).unwrap();
        assert!(!dir.path().join("claude.toml").exists());
        set_builtin_env(dir.path(), None, "not-a-builtin", env).unwrap_err();
    }

    #[test]
    fn acp_adapters_of_native_agents_are_unlisted_until_customized() {
        let dir = tempfile::tempdir().unwrap();
        let unlisted =
            |dir: &Path| load(Some(dir), None).into_iter().filter(is_unlisted).map(|s| s.id).collect::<Vec<_>>();
        assert_eq!(unlisted(dir.path()), ["claude-acp", "codex-acp"]);
        set_builtin_env(dir.path(), None, "codex-acp", BTreeMap::from([("A".to_owned(), "1".to_owned())])).unwrap();
        assert_eq!(unlisted(dir.path()), ["claude-acp"]);
    }

    #[test]
    fn set_builtin_command_overrides_and_clears_a_builtin() {
        let dir = tempfile::tempdir().unwrap();
        set_builtin_command(dir.path(), None, "not-a-builtin", Some("/x")).unwrap_err();
        set_builtin_command(dir.path(), None, "claude", Some("/opt/claude")).unwrap();
        let claude = load(Some(dir.path()), None).into_iter().find(|s| s.id == "claude").unwrap();
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
        set_builtin_command(dir.path(), None, "codex", Some("/x")).unwrap_err();
        set_builtin_command(dir.path(), None, "codex", None).unwrap_err();
        assert!(path.exists());
        // Clearing (twice) returns the built-in to auto-detection.
        set_builtin_command(dir.path(), None, "claude", None).unwrap();
        set_builtin_command(dir.path(), None, "claude", None).unwrap();
        assert!(!dir.path().join("claude.toml").exists());
        assert_eq!(load(Some(dir.path()), None).iter().find(|s| s.id == "claude").unwrap().command, "claude");
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

            set_builtin_command(dir.path(), None, "claude", Some("/new/claude")).unwrap();
            agent.command = "/new/claude".into();
            assert_eq!(CustomAgent::read(&path).unwrap(), agent, "{field}");

            set_builtin_command(dir.path(), None, "claude", None).unwrap();
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

        set_builtin_command(dir.path(), None, "codex", None).unwrap();

        assert!(!path.exists());
        assert_eq!(
            load(Some(dir.path()), None).into_iter().find(|s| s.id == "codex").unwrap(),
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
        let spec = load(Some(path.parent().unwrap()), None).into_iter().find(|s| s.id == "amp-acp").unwrap();
        assert_eq!(spec.source, AgentSource::Registry { version: "0.10.0".into(), update: None });
        assert!(toml::from_str::<CustomAgent>("command = \"x\"\n[registry]\nid = \"x\"\n").is_err());
    }

    fn custom_input(id: &str) -> CustomAgentInput {
        CustomAgentInput {
            id: id.into(),
            name: "Mine".into(),
            command: "/opt/mine".into(),
            args: vec!["acp".into()],
            env: BTreeMap::from([("K".to_owned(), "v".to_owned())]),
        }
    }

    #[test]
    fn custom_agents_save_list_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        save_custom(dir.path(), None, &custom_input("mine")).unwrap();
        let mine = load(Some(dir.path()), None).into_iter().find(|s| s.id == "mine").unwrap();
        assert_eq!((mine.name.as_str(), mine.command.as_str()), ("Mine", "/opt/mine"));
        assert_eq!(mine.env, vec![("K".to_owned(), "v".to_owned())]);
        assert_eq!(mine.source, AgentSource::Custom);
        remove_custom(dir.path(), None, "mine").unwrap();
        assert!(!load(Some(dir.path()), None).iter().any(|s| s.id == "mine"));
        remove_custom(dir.path(), None, "mine").unwrap_err();
    }

    #[test]
    fn custom_agents_refuse_builtin_registry_and_bad_ids() {
        let dir = tempfile::tempdir().unwrap();
        save_custom(dir.path(), None, &custom_input("claude")).unwrap_err();
        save_custom(dir.path(), None, &custom_input("../evil")).unwrap_err();
        save_custom(dir.path(), None, &custom_input("")).unwrap_err();
        let mut empty_command = custom_input("mine");
        empty_command.command = "  ".into();
        save_custom(dir.path(), None, &empty_command).unwrap_err();
        save_custom(dir.path(), None, &custom_input("mine")).unwrap();
        save_custom(dir.path(), None, &custom_input("mine")).unwrap_err();
        remove_custom(dir.path(), None, "claude").unwrap_err();
        // An id that isn't a plain file stem never reaches outside the agents directory.
        let outside = dir.path().join("outside.toml");
        std::fs::write(&outside, "command = \"/bin/sh\"\n").unwrap();
        let agents = dir.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        remove_custom(&agents, None, "../outside").unwrap_err();
        assert!(outside.exists());
        std::fs::write(
            dir.path().join("amp-acp.toml"),
            "command = \"/registry/amp\"\n[registry]\nid = \"amp-acp\"\nversion = \"1.0\"\n",
        )
        .unwrap();
        save_custom(dir.path(), None, &custom_input("amp-acp")).unwrap_err();
        remove_custom(dir.path(), None, "amp-acp").unwrap_err();
    }

    #[derive(Default)]
    struct MemorySecrets(parking_lot::Mutex<BTreeMap<String, String>>);

    impl EnvSecrets for MemorySecrets {
        fn get(&self, key: &str) -> Option<String> {
            self.0.lock().get(key).cloned()
        }
        fn set(&self, key: &str, value: &str) -> IdeResult<()> {
            self.0.lock().insert(key.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, key: &str) {
            self.0.lock().remove(key);
        }
        fn keys(&self, prefix: &str) -> Vec<String> {
            self.0.lock().keys().filter(|k| k.starts_with(prefix)).cloned().collect()
        }
    }

    #[test]
    fn environment_values_go_to_the_secrets_and_the_files_keep_the_names() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let s = Some(&secrets as &dyn EnvSecrets);
        let env = BTreeMap::from([("API_KEY".to_owned(), "v-91f".to_owned()), ("A/B".to_owned(), String::new())]);
        set_builtin_env(dir.path(), s, "claude", env.clone()).unwrap();
        save_custom(dir.path(), s, &CustomAgentInput { env: env.clone(), ..custom_input("mine") }).unwrap();
        for id in ["claude", "mine"] {
            let text = std::fs::read_to_string(dir.path().join(format!("{id}.toml"))).unwrap();
            assert!(text.contains("API_KEY") && !text.contains("v-91f"), "{text}");
            let spec = load(Some(dir.path()), s).into_iter().find(|p| p.id == id).unwrap();
            assert_eq!(describe(&spec).env, env);
        }
        assert_eq!(secrets.keys("agent/"), ["agent/claude/env/API_KEY", "agent/mine/env/API_KEY"]);

        set_builtin_command(dir.path(), s, "claude", Some("/opt/claude")).unwrap();
        assert_eq!(secrets.get("agent/claude/env/API_KEY").as_deref(), Some("v-91f"));
        set_builtin_env(dir.path(), s, "claude", BTreeMap::from([("OTHER".to_owned(), "x".to_owned())])).unwrap();
        assert_eq!(secrets.keys("agent/claude/"), ["agent/claude/env/OTHER"]);
        set_builtin_command(dir.path(), s, "claude", None).unwrap();
        set_builtin_env(dir.path(), s, "claude", BTreeMap::new()).unwrap();
        remove_custom(dir.path(), s, "mine").unwrap();
        assert_eq!(secrets.keys("agent/"), Vec::<String>::new());
    }

    #[test]
    fn values_written_in_agent_files_move_to_the_secrets_unless_installed_from_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let s = Some(&secrets as &dyn EnvSecrets);
        std::fs::write(dir.path().join("mine.toml"), "command = \"/opt/mine\"\n[env]\nK = \"v-91f\"\nS = \"\"\n")
            .unwrap();
        secrets.set("agent/mine/env/S", "saved").unwrap();
        let registry =
            "command = \"/registry/amp\"\n[env]\nR = \"1\"\n[registry]\nid = \"amp-acp\"\nversion = \"1.0\"\n";
        std::fs::write(dir.path().join("amp-acp.toml"), registry).unwrap();
        let specs = load(Some(dir.path()), s);
        assert_eq!(
            specs.iter().find(|p| p.id == "mine").unwrap().env,
            [("K".to_owned(), "v-91f".to_owned()), ("S".to_owned(), "saved".to_owned())]
        );
        assert!(!std::fs::read_to_string(dir.path().join("mine.toml")).unwrap().contains("v-91f"));
        assert_eq!(secrets.keys("agent/"), ["agent/mine/env/K", "agent/mine/env/S"]);
        assert_eq!(std::fs::read_to_string(dir.path().join("amp-acp.toml")).unwrap(), registry);
    }

    #[test]
    fn acp_json_imports_servers_and_skips_collisions() {
        let dir = tempfile::tempdir().unwrap();
        save_custom(dir.path(), None, &custom_input("taken")).unwrap();
        let outcomes = import_acp(
            dir.path(),
            None,
            r#"{"agent_servers": {
                "My Agent!": {"command": "/opt/agent", "args": ["--acp"], "env": {"K": "v"}},
                "taken": {"command": "/opt/taken"},
                "claude": {"command": "/opt/claude"},
                "!!!": {"command": "/opt/noname"},
                "silent": {"args": []}
            }}"#,
        )
        .unwrap();
        let saved: Vec<&str> = outcomes.iter().filter(|o| o.saved).map(|o| o.id.as_str()).collect();
        assert_eq!(saved, ["my-agent"]);
        assert!(outcomes.iter().filter(|o| !o.saved).all(|o| !o.reason.is_empty()));
        let mine = load(Some(dir.path()), None).into_iter().find(|s| s.id == "my-agent").unwrap();
        assert_eq!((mine.name.as_str(), mine.command.as_str()), ("My Agent!", "/opt/agent"));
        assert_eq!(mine.source, AgentSource::Custom);
        import_acp(dir.path(), None, "not json").unwrap_err();
        assert!(import_acp(dir.path(), None, "{}").unwrap().is_empty());
    }
}
