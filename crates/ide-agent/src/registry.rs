//! The ACP Registry (agentclientprotocol.com): third-party agents, installed into an
//! app-owned directory and saved as `<config>/agents/<id>.toml` with a `[registry]` table.
//!
//! An installed agent runs from `<data>/agents/tools/<id>/<version>/`: a release archive
//! (SHA-256 checked when the registry gives one), an npm package installed there at the
//! registry's exact version, or a uv tool. Updating installs the new version alongside
//! and switches the agent file; [`maintain`] removes versions no agent file uses at the
//! next start, when no task runs on them.

use crate::provider::{self, CustomAgent, Driver, RegistryRef};
use crate::{AgentProvider, AgentSource};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_tools::archive::{self, ArchiveKind};
use ide_tools::platform::{Arch, Os, Platform};
use ide_tools::{Emit, Http, InstallEvent};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
/// [`maintain`] refreshes a saved index older than this, so updates show without opening
/// the registry.
const REFRESH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug)]
pub struct RegistryPaths {
    /// Agent files, `<config>/agents`.
    pub agents_dir: PathBuf,
    /// Installed agents, `<data>/agents/tools/<id>/<version>`.
    pub tools_dir: PathBuf,
    /// The index as last fetched, for offline use and update checks.
    pub cache_file: PathBuf,
}

impl RegistryPaths {
    pub fn new(config_dir: &Path, data_dir: &Path) -> Self {
        Self {
            agents_dir: config_dir.join("agents"),
            tools_dir: data_dir.join("agents").join("tools"),
            cache_file: data_dir.join("agents").join("registry.json"),
        }
    }

    fn agent_file(&self, id: &str) -> PathBuf {
        self.agents_dir.join(format!("{id}.toml"))
    }
}

/// A registry agent this machine can run (or has installed).
#[derive(Clone, Debug, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    /// The registry's current version.
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    /// How it installs here; `None` when it no longer can (an installed agent whose
    /// runtime went away).
    pub distribution: Option<RegistryDistribution>,
    /// The release archive comes without a SHA-256, so the download cannot be checked.
    /// npm and uv packages are checked by those tools.
    pub no_checksum: bool,
    /// The installed version.
    pub installed: Option<String>,
    /// Whether [`Self::version`] is newer than the installed one.
    pub update: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RegistryDistribution {
    /// A release archive for this OS and architecture.
    Binary,
    /// An npm package (needs Node.js).
    Npx,
    /// A Python package run by uv.
    Uvx,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistry {
    pub agents: Vec<RegistryAgent>,
    /// Set when the registry could not be reached and the copy saved earlier is shown.
    pub warning: Option<String>,
}

// ---- the index (https://github.com/agentclientprotocol/registry) ----

#[derive(Clone, Debug, Deserialize)]
struct Entry {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    distribution: Distribution,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Distribution {
    /// By `<os>-<arch>`, e.g. `darwin-aarch64`.
    #[serde(default)]
    binary: BTreeMap<String, Binary>,
    #[serde(default)]
    npx: Option<Package>,
    #[serde(default)]
    uvx: Option<Package>,
}

#[derive(Clone, Debug, Deserialize)]
struct Binary {
    archive: String,
    /// Path of the executable inside the archive.
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Package {
    /// `name@version` (npm) or `name==version` (uv).
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn parse(text: &str) -> IdeResult<Vec<Entry>> {
    #[derive(Deserialize)]
    struct Index {
        agents: Vec<serde_json::Value>,
    }
    let index: Index = serde_json::from_str(text)
        .map_err(|e| IdeError::new(ErrorKind::Protocol, format!("the ACP Registry index is invalid: {e}")))?;
    // One malformed entry does not hide the others; ids and versions name directories.
    Ok(index
        .agents
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Entry>(v).ok())
        .filter(|e| safe_segment(&e.id) && safe_segment(&e.version))
        .collect())
}

fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

/// How an entry installs on `platform`: its binary for this OS/arch first, then npm
/// (needs `npm` and `node`), then uv.
enum Choice<'a> {
    Binary(&'a Binary),
    Npx(&'a Package),
    Uvx(&'a Package),
}

impl Choice<'_> {
    fn kind(&self) -> RegistryDistribution {
        match self {
            Choice::Binary(_) => RegistryDistribution::Binary,
            Choice::Npx(_) => RegistryDistribution::Npx,
            Choice::Uvx(_) => RegistryDistribution::Uvx,
        }
    }
}

fn platform_key(p: Platform) -> String {
    let os = match p.os {
        Os::Mac => "darwin",
        Os::Linux => "linux",
        Os::Windows => "windows",
    };
    let arch = match p.arch {
        Arch::Arm64 => "aarch64",
        Arch::X64 => "x86_64",
    };
    format!("{os}-{arch}")
}

fn choose<'a>(entry: &'a Entry, platform: Platform, on_path: &dyn Fn(&str) -> bool) -> Option<Choice<'a>> {
    let d = &entry.distribution;
    if let Some(b) = d.binary.get(&platform_key(platform)) {
        return Some(Choice::Binary(b));
    }
    if let Some(p) = &d.npx
        && on_path("npm")
        && on_path("node")
    {
        return Some(Choice::Npx(p));
    }
    if let Some(p) = &d.uvx
        && on_path("uv")
    {
        return Some(Choice::Uvx(p));
    }
    None
}

/// Registry agents that are built-in ones under another id.
const BUILTIN_ALIASES: &[&str] = &["github-copilot-cli", "qwen-code", "mistral-vibe"];

fn is_builtin(id: &str) -> bool {
    provider::is_builtin(id) || BUILTIN_ALIASES.contains(&id)
}

fn on_path(command: &str) -> bool {
    which::which(command).is_ok()
}

/// `1.10.0` > `1.9.2`; a release is newer than its pre-releases.
fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<&str> {
        v.trim_start_matches('v').split(['.', '-', '+']).collect()
    }
    let (a, b) = (parts(latest), parts(current));
    for (x, y) in a.iter().zip(&b) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Greater,
            (Err(_), Ok(_)) => Ordering::Less,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord == Ordering::Greater;
        }
    }
    // `1.0.0` vs `1.0.0-beta`: the shorter is the release.
    a.len() < b.len()
}

// ---- listing ----

/// Registry agents this machine can run, except built-in ones and ids the user's own
/// agent files take. Falls back to the saved index when the registry is unreachable.
pub fn list(paths: &RegistryPaths, cancel: &CancellationToken) -> IdeResult<AgentRegistry> {
    let (text, warning) = match fetch(paths, cancel) {
        Ok(text) => (text, None),
        Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
        Err(e) => match fs::read_to_string(&paths.cache_file) {
            Ok(text) => (
                text,
                Some(format!("Could not reach the ACP Registry ({}); showing the list saved earlier.", e.message)),
            ),
            Err(_) => return Err(e),
        },
    };
    let agents = visible(paths, &parse(&text)?, Platform::current(), &on_path);
    Ok(AgentRegistry { agents, warning })
}

fn visible(
    paths: &RegistryPaths,
    entries: &[Entry],
    platform: Platform,
    on_path: &dyn Fn(&str) -> bool,
) -> Vec<RegistryAgent> {
    let mut agents: Vec<RegistryAgent> = entries
        .iter()
        .filter(|e| !is_builtin(&e.id))
        .filter_map(|e| {
            let file = paths.agent_file(&e.id);
            let installed = if file.exists() {
                // A file of the user's own (or one that does not parse) keeps its id.
                Some(CustomAgent::read(&file).ok()?.registry?.version)
            } else {
                None
            };
            let choice = choose(e, platform, on_path);
            let no_checksum = matches!(choice, Some(Choice::Binary(b)) if b.sha256.is_none());
            let distribution = choice.map(|c| c.kind());
            if distribution.is_none() && installed.is_none() {
                return None;
            }
            Some(RegistryAgent {
                update: installed.as_deref().is_some_and(|v| is_newer(&e.version, v)),
                id: e.id.clone(),
                name: e.name.clone(),
                version: e.version.clone(),
                description: e.description.clone(),
                repository: e.repository.clone(),
                website: e.website.clone(),
                authors: e.authors.clone(),
                license: e.license.clone(),
                distribution,
                no_checksum,
                installed,
            })
        })
        .collect();
    agents.sort_by_key(|a| a.name.to_lowercase());
    agents
}

/// Fills in [`AgentSource::Registry::update`] from the saved index.
pub fn mark_updates(paths: &RegistryPaths, providers: &mut [AgentProvider]) {
    let Some(entries) = fs::read_to_string(&paths.cache_file).ok().and_then(|t| parse(&t).ok()) else { return };
    for p in providers {
        if let AgentSource::Registry { version, update } = &mut p.source
            && let Some(e) = entries.iter().find(|e| e.id == p.id)
            && is_newer(&e.version, version)
        {
            *update = Some(e.version.clone());
        }
    }
}

/// HTTPS only, redirects included. Tests serve downloads over `file://`.
fn http() -> IdeResult<Http> {
    let http = Http::new(&ide_tools::default_search_path())?;
    Ok(if cfg!(test) { http } else { http.https_only() })
}

fn check_url(url: &str) -> IdeResult<()> {
    if url.starts_with("https://") || (cfg!(test) && url.starts_with("file://")) {
        Ok(())
    } else {
        Err(IdeError::new(ErrorKind::Protocol, format!("refusing to download {url}: only HTTPS downloads are allowed")))
    }
}

/// An npm / uv package spec from the registry, which must not read as an option.
fn check_spec(spec: &str) -> IdeResult<()> {
    if spec.is_empty() || spec.starts_with('-') || spec.chars().any(char::is_whitespace) {
        Err(IdeError::new(ErrorKind::Protocol, format!("unsupported package `{spec}`")))
    } else {
        Ok(())
    }
}

fn fetch(paths: &RegistryPaths, cancel: &CancellationToken) -> IdeResult<String> {
    let http = http()?;
    let text = http.get_text_limited(REGISTRY_URL, Some(MAX_REGISTRY_BYTES), cancel)?;
    parse(&text)?;
    if let Err(e) = write_atomic(&paths.cache_file, text.as_bytes()) {
        tracing::warn!("cannot save the ACP Registry index: {e}");
    }
    Ok(text)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

// ---- install / remove ----

/// Installs (or updates to) the registry's current version of `id`, streaming progress
/// through `emit`, and points the agent file at it.
pub fn install(paths: &RegistryPaths, id: &str, cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
    // The saved index is what the user picked from; fetch only when there is none.
    let text = match fs::read_to_string(&paths.cache_file) {
        Ok(text) => text,
        Err(_) => fetch(paths, cancel)?,
    };
    let entries = parse(&text)?;
    let entry = entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| IdeError::not_found(format!("{id} is not in the ACP Registry")))?;
    install_entry(paths, entry, Platform::current(), &on_path, cancel, emit)
}

fn install_entry(
    paths: &RegistryPaths,
    entry: &Entry,
    platform: Platform,
    on_path: &dyn Fn(&str) -> bool,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<()> {
    if is_builtin(&entry.id) {
        return Err(IdeError::invalid(format!("{} is built in", entry.name)));
    }
    let file = paths.agent_file(&entry.id);
    if file.exists() && CustomAgent::read(&file).ok().and_then(|a| a.registry).is_none() {
        return Err(IdeError::new(
            ErrorKind::AlreadyExists,
            format!("{} already defines an agent with this id", file.display()),
        ));
    }
    let choice = choose(entry, platform, on_path).ok_or_else(|| {
        IdeError::unavailable(format!("{} has no build for this system (or needs Node.js or uv)", entry.name))
    })?;
    let dir = paths.tools_dir.join(&entry.id).join(&entry.version);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    let installed = match &choice {
        Choice::Binary(b) => install_binary(b, &dir, cancel, emit).map(|exe| (exe, b.args.clone(), b.env.clone())),
        Choice::Npx(p) => {
            install_npm(p, entry, &dir, platform, cancel, emit).map(|exe| (exe, p.args.clone(), p.env.clone()))
        }
        Choice::Uvx(p) => {
            install_uv(p, entry, &dir, platform, cancel, emit).map(|exe| (exe, p.args.clone(), p.env.clone()))
        }
    };
    let (exe, args, env) = match installed {
        Ok(x) => x,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    let agent = CustomAgent {
        name: Some(entry.name.clone()),
        driver: Driver::Acp,
        command: exe.to_string_lossy().into_owned(),
        args,
        env,
        registry: Some(RegistryRef { id: entry.id.clone(), version: entry.version.clone() }),
    };
    agent.write(&file)?;
    emit(InstallEvent::Line { text: format!("{} {} installed", entry.name, entry.version) });
    Ok(())
}

pub(crate) fn verify_sha256(file: &Path, expected: &str) -> IdeResult<()> {
    let actual = ide_tools::sources::sha256_file(file)?;
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(IdeError::new(ErrorKind::Io, format!("checksum mismatch: expected SHA-256 {expected}, got {actual}")))
    }
}

/// The segments of an archive's `cmd` (`./bin/agent`, `./dist\agent.cmd`), refusing
/// paths that leave the archive.
fn command_path(cmd: &str) -> IdeResult<Vec<String>> {
    let normalized = cmd.replace('\\', "/");
    let bad = || IdeError::new(ErrorKind::Protocol, format!("unsupported command path `{cmd}`"));
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(bad());
    }
    let parts: Vec<String> = normalized.split('/').filter(|p| !p.is_empty() && *p != ".").map(str::to_owned).collect();
    if parts.is_empty() || parts.iter().any(|p| p == "..") {
        return Err(bad());
    }
    Ok(parts)
}

fn install_binary(b: &Binary, dir: &Path, cancel: &CancellationToken, emit: Emit) -> IdeResult<PathBuf> {
    let segments = command_path(&b.cmd)?;
    check_url(&b.archive)?;
    let url_path = b.archive.split(['?', '#']).next().unwrap_or_default();
    let name = url_path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty() && *n != "." && *n != ".." && !n.contains('\\'))
        .unwrap_or("download");
    let downloads = dir.join(".download");
    fs::create_dir_all(&downloads)?;
    let file = downloads.join(name);
    emit(InstallEvent::Line { text: format!("Downloading {}", b.archive) });
    http()?.download(&b.archive, &file, None, cancel, emit)?;
    match &b.sha256 {
        Some(expected) => {
            verify_sha256(&file, expected)?;
            emit(InstallEvent::Line { text: "SHA-256 checksum verified".into() });
        }
        None => emit(InstallEvent::Line { text: "The registry gives no checksum for this download".into() }),
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    emit(InstallEvent::Line { text: "Extracting…".into() });
    let kind = ArchiveKind::from_name(name);
    let (exe_name, parents) = segments.split_last().expect("command_path is never empty");
    let dest = match kind {
        // A bare executable goes where `cmd` expects it.
        ArchiveKind::Raw | ArchiveKind::Gz => parents.iter().fold(dir.to_path_buf(), |p, s| p.join(s)),
        _ => dir.to_path_buf(),
    };
    archive::extract(&file, kind, &dest, exe_name, cancel)?;
    let _ = fs::remove_dir_all(&downloads);
    let exe = segments.iter().fold(dir.to_path_buf(), |p, s| p.join(s));
    if !exe.is_file() {
        return Err(IdeError::new(ErrorKind::Protocol, format!("the download has no {}", b.cmd)));
    }
    archive::make_executable(&exe)?;
    Ok(exe)
}

/// `@scope/name@1.2.3` → (`@scope/name`, `1.2.3`).
fn split_npm_spec(spec: &str) -> (&str, Option<&str>) {
    let start = usize::from(spec.starts_with('@'));
    match spec[start..].find('@') {
        Some(i) => (&spec[..start + i], Some(&spec[start + i + 1..])),
        None => (spec, None),
    }
}

/// The command of an npm package: its only one, else the one named after the package
/// or the agent.
fn npm_bin(manifest: &serde_json::Value, name: &str, agent_id: &str) -> Option<String> {
    let base = name.rsplit('/').next().unwrap_or(name);
    match manifest.get("bin")? {
        serde_json::Value::String(_) => Some(base.to_owned()),
        serde_json::Value::Object(bins) if bins.len() == 1 => bins.keys().next().cloned(),
        serde_json::Value::Object(bins) => {
            [base, agent_id].into_iter().find(|k| bins.contains_key(*k)).map(str::to_owned)
        }
        _ => None,
    }
}

fn install_npm(
    p: &Package,
    entry: &Entry,
    dir: &Path,
    platform: Platform,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<PathBuf> {
    let (name, version) = split_npm_spec(&p.package);
    let spec = match version {
        Some(v) if !v.is_empty() => p.package.clone(),
        _ => format!("{name}@{}", entry.version),
    };
    check_spec(&spec)?;
    let npm = which::which("npm").map_err(|_| IdeError::unavailable(format!("npm is required to install {name}")))?;
    let mut cmd = Command::new(npm);
    cmd.arg("install").arg("--prefix").arg(dir).args(["--no-audit", "--no-fund"]).arg(&spec).current_dir(dir);
    ide_tools::run_streamed(cmd, cancel, emit)?;
    let modules = dir.join("node_modules");
    let manifest: serde_json::Value = fs::read_to_string(modules.join(name).join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| IdeError::new(ErrorKind::Protocol, format!("{spec} was not installed")))?;
    let bin = npm_bin(&manifest, name, &entry.id)
        .ok_or_else(|| IdeError::new(ErrorKind::Protocol, format!("{spec} has no command to run")))?;
    let file = if platform.os == Os::Windows { format!("{bin}.cmd") } else { bin };
    let exe = modules.join(".bin").join(file);
    if !exe.exists() {
        return Err(IdeError::new(ErrorKind::Protocol, format!("{spec} did not install {}", exe.display())));
    }
    Ok(exe)
}

/// `name[extra]==1.2` → (`name`, `1.2`).
fn split_uv_spec(spec: &str) -> (&str, Option<&str>) {
    let (name, version) = match spec.split_once("==") {
        Some((n, v)) => (n, Some(v.trim())),
        None => (spec, None),
    };
    (name.split('[').next().unwrap_or(name).trim(), version)
}

fn install_uv(
    p: &Package,
    entry: &Entry,
    dir: &Path,
    platform: Platform,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<PathBuf> {
    let (name, version) = split_uv_spec(&p.package);
    let spec = match version {
        Some(v) if !v.is_empty() => p.package.clone(),
        _ => format!("{name}=={}", entry.version),
    };
    check_spec(&spec)?;
    let uv = which::which("uv").map_err(|_| IdeError::unavailable(format!("uv is required to install {name}")))?;
    let bin = dir.join("bin");
    let mut cmd = Command::new(uv);
    cmd.args(["tool", "install", "--force"])
        .arg(&spec)
        .env("UV_TOOL_DIR", dir.join("tools"))
        .env("UV_TOOL_BIN_DIR", &bin)
        .current_dir(dir);
    ide_tools::run_streamed(cmd, cancel, emit)?;
    let exe = [name, entry.id.as_str()].iter().map(|n| bin.join(platform.exe(n))).find(|p| p.is_file()).or_else(|| {
        let files: Vec<PathBuf> = fs::read_dir(&bin).ok()?.flatten().map(|e| e.path()).collect();
        (files.len() == 1).then(|| files[0].clone())
    });
    exe.ok_or_else(|| IdeError::new(ErrorKind::Protocol, format!("{spec} installed no command named {name}")))
}

/// Deletes a registry agent's file and installed files.
pub fn remove(paths: &RegistryPaths, id: &str) -> IdeResult<()> {
    if !safe_segment(id) {
        return Err(IdeError::invalid(format!("invalid agent id {id}")));
    }
    let file = paths.agent_file(id);
    let agent = CustomAgent::read(&file).map_err(|_| IdeError::not_found(format!("{id} is not installed")))?;
    if agent.registry.is_none() {
        return Err(IdeError::invalid(format!("{id} was not installed from the ACP Registry")));
    }
    fs::remove_file(&file)?;
    // What a running agent still holds open (Windows) goes at the next start (`maintain`).
    let _ = fs::remove_dir_all(paths.tools_dir.join(id));
    Ok(())
}

/// Once per process, on its own thread: removes installed versions no agent file uses
/// (left by updates and removals) and refreshes a saved index older than a day.
pub fn maintain(paths: RegistryPaths) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let spawned = std::thread::Builder::new().name("agent-registry".into()).spawn(move || {
            prune(&paths);
            let stale = fs::metadata(&paths.cache_file)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_none_or(|age| age > REFRESH_AFTER);
            // Only for agents installed from the registry: nobody else needs the index.
            if stale
                && has_registry_agents(&paths)
                && let Err(e) = fetch(&paths, &CancellationToken::new())
            {
                tracing::debug!("ACP Registry not refreshed: {e}");
            }
        });
        if let Err(e) = spawned {
            tracing::warn!("cannot start the ACP Registry maintenance: {e}");
        }
    });
}

fn has_registry_agents(paths: &RegistryPaths) -> bool {
    fs::read_dir(&paths.tools_dir).is_ok_and(|mut d| d.next().is_some())
}

fn prune(paths: &RegistryPaths) {
    let Ok(ids) = fs::read_dir(&paths.tools_dir) else { return };
    for id_dir in ids.flatten() {
        let id = id_dir.file_name().to_string_lossy().into_owned();
        let file = paths.agent_file(&id);
        let keep = if file.exists() {
            // An agent file that does not parse keeps everything until it is fixed.
            match CustomAgent::read(&file) {
                Ok(agent) => agent.registry.map(|r| r.version),
                Err(_) => continue,
            }
        } else {
            None
        };
        let Some(keep) = keep else {
            let _ = fs::remove_dir_all(id_dir.path());
            continue;
        };
        for version in fs::read_dir(id_dir.path()).into_iter().flatten().flatten() {
            if version.file_name().to_string_lossy() != keep {
                let _ = fs::remove_dir_all(version.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_ARM: Platform = Platform { os: Os::Mac, arch: Arch::Arm64 };
    const LINUX: Platform = Platform { os: Os::Linux, arch: Arch::X64 };
    const WINDOWS: Platform = Platform { os: Os::Windows, arch: Arch::X64 };

    const INDEX: &str = r#"{"version":"1.0.0","agents":[
        {"id":"amp-acp","name":"Amp","version":"0.10.0","description":"Amp over ACP",
         "repository":"https://github.com/x/amp-acp","authors":["x"],"license":"Apache-2.0",
         "icon":"https://cdn/amp.svg",
         "distribution":{"binary":{
            "darwin-aarch64":{"archive":"https://x/amp-darwin-aarch64.tar.gz","cmd":"./amp-acp","sha256":"ab"},
            "windows-x86_64":{"archive":"https://x/amp.zip","cmd":"amp-acp.exe"}}}},
        {"id":"cline","name":"Cline","version":"3.0.74","description":"",
         "distribution":{"npx":{"package":"cline@3.0.74","args":["--acp"]}}},
        {"id":"fast-agent","name":"fast-agent","version":"0.10.1",
         "distribution":{"uvx":{"package":"fast-agent-acp==0.10.1","args":["-x"],"env":{"K":"v"}}}},
        {"id":"claude-acp","name":"Claude Agent","version":"0.98.0",
         "distribution":{"npx":{"package":"@agentclientprotocol/claude-agent-acp@0.98.0"}}},
        {"id":"../evil","name":"Evil","version":"1","distribution":{}},
        {"id":"broken","name":"Broken"}
    ],"extensions":[]}"#;

    fn paths(root: &Path) -> RegistryPaths {
        RegistryPaths::new(&root.join("config"), &root.join("data"))
    }

    #[test]
    fn parses_the_index_and_skips_bad_entries() {
        let entries = parse(INDEX).unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["amp-acp", "cline", "fast-agent", "claude-acp"]);
        let amp = &entries[0];
        assert_eq!(amp.distribution.binary["darwin-aarch64"].sha256.as_deref(), Some("ab"));
        assert_eq!(entries[2].distribution.uvx.as_ref().unwrap().env["K"], "v");
        assert!(parse("{\"agents\": 3}").is_err());
    }

    #[test]
    fn shows_what_this_platform_can_run() {
        let dir = tempfile::tempdir().unwrap();
        let entries = parse(INDEX).unwrap();
        let ids = |platform, on_path: &dyn Fn(&str) -> bool| -> Vec<(String, Option<RegistryDistribution>)> {
            visible(&paths(dir.path()), &entries, platform, on_path)
                .into_iter()
                .map(|a| (a.id, a.distribution))
                .collect()
        };
        let none = |_: &str| false;
        let all = |_: &str| true;
        // Built-in agents (claude-acp) never show.
        assert_eq!(ids(MAC_ARM, &none), [("amp-acp".to_owned(), Some(RegistryDistribution::Binary))]);
        assert!(ids(LINUX, &none).is_empty());
        let node_only = |c: &str| c == "npm" || c == "node";
        assert_eq!(ids(LINUX, &node_only), [("cline".to_owned(), Some(RegistryDistribution::Npx))]);
        assert_eq!(
            ids(LINUX, &all),
            [
                ("cline".to_owned(), Some(RegistryDistribution::Npx)),
                ("fast-agent".to_owned(), Some(RegistryDistribution::Uvx))
            ]
        );
        assert_eq!(platform_key(WINDOWS), "windows-x86_64");
        assert_eq!(platform_key(MAC_ARM), "darwin-aarch64");
    }

    #[test]
    fn flags_release_archives_without_a_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let entries = parse(INDEX).unwrap();
        let flags = |platform| -> Vec<(String, bool)> {
            visible(&paths(dir.path()), &entries, platform, &|_| true)
                .into_iter()
                .map(|a| (a.id, a.no_checksum))
                .collect()
        };
        assert_eq!(flags(MAC_ARM)[0], ("amp-acp".to_owned(), false));
        assert_eq!(flags(WINDOWS)[0], ("amp-acp".to_owned(), true));
        // npm and uv check their own packages.
        assert!(flags(LINUX).iter().all(|(_, no_checksum)| !no_checksum));
    }

    #[test]
    fn installed_versions_updates_and_the_users_own_agents() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let entries = parse(INDEX).unwrap();
        let installed = |id: &str, version: &str| CustomAgent {
            name: None,
            driver: Driver::Acp,
            command: "/x".into(),
            args: vec![],
            env: BTreeMap::new(),
            registry: Some(RegistryRef { id: id.into(), version: version.into() }),
        };
        installed("amp-acp", "0.9.0").write(&p.agent_file("amp-acp")).unwrap();
        // The user's own `cline.toml` hides the registry's cline.
        fs::write(p.agent_file("cline"), "command = \"cline\"\n").unwrap();
        let shown = visible(&p, &entries, LINUX, &|_| true);
        let amp = shown.iter().find(|a| a.id == "amp-acp").unwrap();
        // Installed agents stay listed (to remove them) even without a build for this system.
        assert_eq!((amp.installed.as_deref(), amp.update, amp.distribution), (Some("0.9.0"), true, None));
        assert!(!shown.iter().any(|a| a.id == "cline"));

        write_atomic(&p.cache_file, INDEX.as_bytes()).unwrap();
        let mut providers: Vec<AgentProvider> = provider::load(Some(&p.agents_dir))
            .into_iter()
            .filter(|s| s.id == "amp-acp")
            .map(|s| AgentProvider {
                id: s.id,
                name: s.name,
                command: s.command,
                installed: false,
                config: vec![],
                commands: vec![],
                source: s.source,
            })
            .collect();
        mark_updates(&p, &mut providers);
        assert_eq!(
            providers[0].source,
            AgentSource::Registry { version: "0.9.0".into(), update: Some("0.10.0".into()) }
        );
    }

    #[test]
    fn version_order() {
        assert!(is_newer("0.10.0", "0.9.2"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
        assert!(!is_newer("2.3.0", "2.3.0"));
        assert!(is_newer("2026.10.22", "2026.9.30"));
    }

    #[test]
    fn package_specs_and_commands() {
        assert_eq!(split_npm_spec("@scope/pkg@1.2.3"), ("@scope/pkg", Some("1.2.3")));
        assert_eq!(split_npm_spec("cline@3.0.74"), ("cline", Some("3.0.74")));
        assert_eq!(split_npm_spec("@scope/pkg"), ("@scope/pkg", None));
        assert_eq!(split_uv_spec("fast-agent-acp[all]==0.10.1"), ("fast-agent-acp", Some("0.10.1")));
        let m = |v: &str| serde_json::from_str::<serde_json::Value>(v).unwrap();
        assert_eq!(npm_bin(&m(r#"{"bin":"cli.js"}"#), "@google/gemini-cli", "gemini").as_deref(), Some("gemini-cli"));
        assert_eq!(npm_bin(&m(r#"{"bin":{"copilot":"a.js"}}"#), "@github/copilot", "x").as_deref(), Some("copilot"));
        assert_eq!(npm_bin(&m(r#"{"bin":{"a":"a.js","droid":"d.js"}}"#), "droid", "factory").as_deref(), Some("droid"));
        assert_eq!(npm_bin(&m(r#"{"bin":{"a":"a.js","b":"b.js"}}"#), "pkg", "id"), None);
        assert_eq!(npm_bin(&m(r#"{}"#), "pkg", "id"), None);
        assert_eq!(command_path("./dist-package\\cursor-agent.cmd").unwrap(), ["dist-package", "cursor-agent.cmd"]);
        assert_eq!(command_path("harn.exe").unwrap(), ["harn.exe"]);
        assert!(command_path("../x").is_err());
        assert!(command_path("/usr/bin/x").is_err());
        assert!(command_path("C:/x").is_err());
        assert!(check_spec("cline@3.0.74").is_ok());
        assert!(check_spec("--prefix=/").is_err());
        assert!(check_spec("a b").is_err());
        assert!(check_url("https://x/a.tar.gz").is_ok());
        assert!(check_url("http://x/a.tar.gz").is_err());
        assert!(check_url("ftp://x/a").is_err());
    }

    #[test]
    fn checksums_are_verified() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a");
        fs::write(&f, "hello").unwrap();
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        verify_sha256(&f, sha).unwrap();
        verify_sha256(&f, &sha.to_uppercase()).unwrap();
        assert!(verify_sha256(&f, &"0".repeat(64)).is_err());
    }

    /// A raw executable served over `file://` (curl), installed, updated and removed.
    #[cfg(unix)]
    #[test]
    fn installs_updates_and_removes_a_binary_agent() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        let served = dir.path().join("served");
        fs::create_dir_all(&served).unwrap();
        let exe = served.join("agent-bin");
        fs::write(&exe, "#!/bin/sh\necho hi\n").unwrap();
        let sha = ide_tools::sources::sha256_file(&exe).unwrap();
        let index = |version: &str, sha: &str| {
            format!(
                r#"{{"agents":[{{"id":"demo","name":"Demo","version":"{version}","distribution":{{"binary":{{
                "linux-x86_64":{{"archive":"file://{}","cmd":"./agent-bin","args":["acp"],"env":{{"A":"1"}},"sha256":"{sha}"}}}}}}}}]}}"#,
                exe.display()
            )
        };
        let cancel = CancellationToken::new();
        let lines = std::sync::Mutex::new(Vec::new());
        let emit = |e: InstallEvent| {
            if let InstallEvent::Line { text } = e {
                lines.lock().unwrap().push(text);
            }
        };
        let entries = parse(&index("1.0.0", &sha)).unwrap();
        install_entry(&p, &entries[0], LINUX, &|_| false, &cancel, &emit).unwrap();
        assert!(lines.lock().unwrap().iter().any(|l| l == "SHA-256 checksum verified"));
        let v1 = p.tools_dir.join("demo/1.0.0/agent-bin");
        assert!(v1.is_file());
        assert!(!p.tools_dir.join("demo/1.0.0/.download").exists());
        let agent = CustomAgent::read(&p.agent_file("demo")).unwrap();
        assert_eq!(agent.command, v1.to_string_lossy());
        assert_eq!((agent.args.as_slice(), agent.env["A"].as_str()), (&["acp".to_owned()][..], "1"));
        assert_eq!(agent.registry, Some(RegistryRef { id: "demo".into(), version: "1.0.0".into() }));
        let spec = provider::load(Some(&p.agents_dir)).into_iter().find(|s| s.id == "demo").unwrap();
        assert_eq!(spec.source, AgentSource::Registry { version: "1.0.0".into(), update: None });
        assert!(provider::installed(&spec.command));

        // A bad checksum fails and leaves the installed version in place.
        let bad = parse(&index("2.0.0", &"0".repeat(64))).unwrap();
        let err = install_entry(&p, &bad[0], LINUX, &|_| false, &cancel, &emit).unwrap_err();
        assert!(err.message.contains("checksum mismatch"), "{err:?}");
        assert!(!p.tools_dir.join("demo/2.0.0").exists());
        assert_eq!(CustomAgent::read(&p.agent_file("demo")).unwrap().registry.unwrap().version, "1.0.0");

        // An update goes alongside; the old version goes at the next start.
        let v2 = parse(&index("2.0.0", &sha)).unwrap();
        install_entry(&p, &v2[0], LINUX, &|_| false, &cancel, &emit).unwrap();
        assert!(v1.is_file());
        prune(&p);
        assert!(!v1.exists());
        assert!(p.tools_dir.join("demo/2.0.0/agent-bin").is_file());

        remove(&p, "demo").unwrap();
        assert!(!p.agent_file("demo").exists());
        assert!(!p.tools_dir.join("demo").exists());
        assert!(remove(&p, "demo").is_err());
    }

    #[test]
    fn refuses_to_replace_the_users_own_agent() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(dir.path());
        fs::create_dir_all(&p.agents_dir).unwrap();
        fs::write(p.agent_file("amp-acp"), "command = \"amp\"\n").unwrap();
        let entries = parse(INDEX).unwrap();
        let err = install_entry(&p, &entries[0], MAC_ARM, &|_| false, &CancellationToken::new(), &|_| {}).unwrap_err();
        assert_eq!(err.kind, ErrorKind::AlreadyExists);
        assert!(remove(&p, "amp-acp").is_err());
        assert!(p.agent_file("amp-acp").exists());
    }
}
