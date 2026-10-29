//! Language server / debug adapter installer.
//!
//! A registry of installable tools keyed by the server / adapter `name` used
//! in `languages/*.toml`, detection (managed tools dir, then `PATH`), and
//! installers that never need `sudo`: everything goes to
//! `<app-data>/tools/<name>/` (npm packages to `<app-data>/tools/node_modules`),
//! except toolchain-managed components (`rustup component`, `pip --user`).
//!
//! Language servers find managed tools once [`extend_process_path`] has put
//! [`tools_bin_dirs`] on the process `PATH` at startup.

pub mod archive;
pub mod jdk;
pub mod platform;
mod process;
pub mod registry;
pub mod server;
pub mod sources;

use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_language::LanguageConfig;
use parking_lot::Mutex;
use platform::{Os, Platform};
pub use process::progress_event;
pub use process::{Emit, Http, run_streamed};
use process::{run_collect, run_quiet};
pub use registry::{Method, ReleaseSource, TOOLS, ToolKind, ToolSpec};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    /// Installed by the IDE (managed tools dir or a toolchain component it manages).
    Installed,
    /// Found on the system `PATH`.
    OnPath,
    /// The executable chosen in settings.
    Custom,
    Missing,
}

/// UI-facing state of one tool.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// Server / adapter name from `languages/*.toml`.
    pub name: String,
    pub display_name: String,
    pub kind: ToolKind,
    /// The executable the IDE launches.
    pub command: String,
    /// Names of the languages using this tool.
    pub languages: Vec<String>,
    pub status: ToolStatus,
    pub path: Option<ide_core::IpcPath>,
    pub version: Option<String>,
    /// How it gets installed, e.g. `npm`, `GitHub release`; `None` when not installable.
    pub install_method: Option<String>,
    pub can_install: bool,
    /// Why install is impossible right now (missing npm, no build for this platform, …).
    pub unavailable_reason: Option<String>,
    pub can_uninstall: bool,
    /// Manual install instructions from the language definition.
    pub install_hint: Option<String>,
    pub homepage: Option<String>,
    /// Why the executable chosen in settings cannot be used (status is then `Missing`).
    pub custom_error: Option<String>,
    /// A language server's arguments from its language definition.
    pub default_args: Vec<String>,
    /// A language server's `initializationOptions` from its language definition, as JSON text.
    pub default_initialization_options: Option<String>,
}

/// Streamed install progress.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InstallEvent {
    /// One line of installer output.
    Line { text: String },
    /// Download progress; `fraction` is 0..1 when the size is known.
    Progress { fraction: Option<f64>, message: String },
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: Option<String>,
    source: Option<String>,
}

const MANIFEST: &str = ".openidea-tool.json";

/// `typescript@<7` → `typescript`, `@vue/language-server` unchanged.
fn npm_name(spec: &str) -> &str {
    match spec[1..].find('@') {
        Some(i) => &spec[..i + 1],
        None => spec,
    }
}

pub fn tools_dir(app_data: &Path) -> PathBuf {
    app_data.join("tools")
}

/// Where a [`registry::Method::PipTarget`] tool's package lives (`<tools>/<name>/lib`).
pub fn python_lib_dir(tools_root: &Path, name: &str) -> PathBuf {
    tools_root.join(name).join("lib")
}

/// Every directory a managed tool's executables can live in (existing or not,
/// so a `PATH` computed at startup also covers tools installed later).
pub fn tools_bin_dirs(app_data: &Path) -> Vec<PathBuf> {
    bin_dirs_in(&tools_dir(app_data), Platform::current())
}

fn bin_dirs_in(root: &Path, platform: Platform) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("node_modules").join(".bin")];
    for spec in TOOLS {
        if let Some(d) = managed_bin_dir(root, spec, platform)
            && !dirs.contains(&d)
        {
            dirs.push(d);
        }
    }
    dirs
}

fn managed_bin_dir(root: &Path, spec: &ToolSpec, platform: Platform) -> Option<PathBuf> {
    match spec.method {
        Method::Npm { .. } => Some(root.join("node_modules").join(".bin")),
        Method::Go { .. } | Method::Gem { .. } | Method::DotnetTool { .. } | Method::Release { .. } => {
            Some(root.join(spec.name).join("bin"))
        }
        Method::PipVenv { .. } => {
            Some(root.join(spec.name).join("venv").join(if platform.os == Os::Windows { "Scripts" } else { "bin" }))
        }
        Method::Rustup { .. } | Method::PipUser { .. } | Method::PipTarget { .. } => None,
    }
}

/// Prepends [`tools_bin_dirs`] to this process's `PATH` so language servers,
/// debug adapters and terminals find managed tools. Call once at startup,
/// before other threads start (it mutates the process environment).
pub fn extend_process_path(app_data: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let extended = path_with_tools(app_data, &current);
    if extended != current {
        // SAFETY: documented to run at startup before any other thread reads the environment.
        unsafe { std::env::set_var("PATH", extended) };
    }
}

/// `path` (a `PATH` value) with [`tools_bin_dirs`] in front, those it lacks, and the
/// mise / asdf shims when their shell hook didn't put them there.
pub fn path_with_tools(app_data: &Path, path: &std::ffi::OsStr) -> OsString {
    let path = &ide_core::version_managers::path_with_shims(&ide_core::version_managers::managers(), path);
    let mut dirs = tools_bin_dirs(app_data);
    let current: Vec<PathBuf> = if path.is_empty() { Vec::new() } else { std::env::split_paths(path).collect() };
    dirs.retain(|d| !current.contains(d));
    if dirs.is_empty() {
        return path.to_owned();
    }
    dirs.extend(current);
    std::env::join_paths(dirs).unwrap_or_else(|_| path.to_owned())
}

/// `PATH` plus the usual per-user tool locations (GUI apps on macOS start with a minimal `PATH`).
pub fn default_search_path() -> OsString {
    let mut dirs: Vec<PathBuf> =
        ide_core::process::host_var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
        for rel in [".cargo/bin", ".local/bin", "go/bin", ".bun/bin", ".volta/bin", ".npm-global/bin", "Library/pnpm"] {
            dirs.push(home.join(rel));
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

static INSTALLING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct InstallGuard(String);

impl InstallGuard {
    fn acquire(name: &str) -> IdeResult<Self> {
        let mut set = INSTALLING.lock();
        if !set.get_or_insert_with(HashSet::new).insert(name.to_string()) {
            return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{name} is already being installed")));
        }
        Ok(Self(name.to_string()))
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Some(set) = INSTALLING.lock().as_mut() {
            set.remove(&self.0);
        }
    }
}

/// Which languages use which tool, from the language definitions.
#[derive(Default)]
struct Usage {
    languages: Vec<String>,
    command: Option<String>,
    kind: Option<ToolKind>,
    install_hint: Option<String>,
    args: Vec<String>,
    initialization_options: Option<String>,
}

fn usages(langs: &[LanguageConfig]) -> BTreeMap<String, Usage> {
    let mut map: BTreeMap<String, Usage> = BTreeMap::new();
    let mut add = |name: &str, command: &str, kind: ToolKind, hint: Option<&String>, lang: &str| {
        let u = map.entry(name.to_string()).or_default();
        if !u.languages.iter().any(|l| l == lang) {
            u.languages.push(lang.to_string());
        }
        u.command.get_or_insert_with(|| command.to_string());
        u.kind.get_or_insert(kind);
        if u.install_hint.is_none() {
            u.install_hint = hint.cloned();
        }
    };
    for l in langs {
        for s in &l.language_servers {
            add(&s.name, &s.command, ToolKind::LanguageServer, s.install_hint.as_ref(), &l.name);
        }
    }
    let servers: HashSet<&str> = langs.iter().flat_map(|l| &l.language_servers).map(|s| s.name.as_str()).collect();
    for l in langs {
        if let Some(d) = &l.debugger {
            // An adapter named like a server but launched differently (ElixirLS's
            // `elixir-ls-debugger`) is a tool of its own, listed by its command.
            let name =
                if servers.contains(d.adapter.as_str()) && d.command != d.adapter { &d.command } else { &d.adapter };
            add(name, &d.command, ToolKind::Debugger, d.install_hint.as_ref(), &l.name);
        }
    }
    for (plugin, host) in registry::PLUGIN_HOSTS {
        let languages = map.get(*host).map(|u| u.languages.clone()).unwrap_or_default();
        map.entry(plugin.to_string()).or_default().languages = languages;
    }
    // A server's defaults come from the first definition using it.
    for s in langs.iter().flat_map(|l| &l.language_servers).rev() {
        if let Some(u) = map.get_mut(&s.name) {
            u.args = s.args.clone();
            u.initialization_options =
                s.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).map(|v| v.to_string());
        }
    }
    map
}

/// Extracts the first version-looking token (`1.2.3`, `v0.16.1`, `2024-12-18`) from tool output.
pub fn parse_version(text: &str) -> Option<String> {
    for token in text.split(|c: char| c.is_whitespace() || matches!(c, ',' | '(' | ')' | '"' | '\'' | ';')) {
        let t = token.trim_start_matches(['v', 'V']).trim_end_matches(['.', ':']);
        let t = t.strip_prefix("version").unwrap_or(t);
        if t.starts_with(|c: char| c.is_ascii_digit())
            && t.contains(['.', '-'])
            && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
            && t.chars().filter(|c| c.is_ascii_digit()).count() >= 2
        {
            return Some(t.to_string());
        }
    }
    None
}

/// A tool whose "command" is a plugin jar (e.g. a jdtls bundle) rather than an executable.
fn is_bundle(command: &str) -> bool {
    command.ends_with(".jar")
}

/// Path of an installed plugin bundle (`<tools>/<name>/bin/<jar>`), if present.
pub fn managed_bundle(app_data: &Path, name: &str) -> Option<PathBuf> {
    let spec = registry::find(name)?;
    let jar = spec.commands.first().filter(|c| is_bundle(c))?;
    let path = tools_dir(app_data).join(spec.name).join("bin").join(jar);
    path.is_file().then_some(path)
}

/// Installer and detector over one tools directory.
pub struct Tools {
    root: PathBuf,
    /// Search path for system tools (excludes our own dirs).
    system_path: OsString,
    /// `PATH` handed to installer child processes.
    child_path: OsString,
    platform: Platform,
    /// Executables chosen in settings, by command.
    custom: BTreeMap<String, PathBuf>,
    /// Executables found outside the search path (app bundles), by command.
    found: BTreeMap<String, PathBuf>,
}

impl Tools {
    /// Tools under `<app_data>/tools` using [`default_search_path`].
    pub fn new(app_data: &Path) -> Self {
        Self::with_paths(tools_dir(app_data), default_search_path(), Platform::current())
    }

    pub fn with_paths(root: PathBuf, search_path: OsString, platform: Platform) -> Self {
        let ours = bin_dirs_in(&root, platform);
        let system: Vec<PathBuf> = std::env::split_paths(&search_path).filter(|d| !ours.contains(d)).collect();
        let system_path = std::env::join_paths(&system).unwrap_or_default();
        let child_path = std::env::join_paths(ours.iter().chain(system.iter())).unwrap_or_default();
        Self { root, system_path, child_path, platform, custom: BTreeMap::new(), found: BTreeMap::new() }
    }

    /// Reports the executables chosen in settings (command → path) as the tools' location.
    pub fn with_custom_paths(mut self, custom: BTreeMap<String, PathBuf>) -> Self {
        self.custom = custom;
        self
    }

    /// Reports executables located outside the search path (command → path) as on the PATH.
    pub fn with_found_paths(mut self, found: BTreeMap<String, PathBuf>) -> Self {
        self.found = found;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn which(&self, cmd: &str) -> Option<PathBuf> {
        which::which_in(cmd, Some(&self.system_path), &self.root).ok()
    }

    fn which_any(&self, cmds: &[&str]) -> Option<PathBuf> {
        cmds.iter().find_map(|c| self.which(c))
    }

    fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut cmd = Command::new(program);
        ide_core::process::prepare(&mut cmd).env("PATH", &self.child_path);
        cmd
    }

    fn python(&self) -> Option<PathBuf> {
        self.which_any(&["python3", "python"])
    }

    /// Executable `cmd` inside `dir`, honouring Windows suffixes.
    fn exe_in(&self, dir: &Path, cmd: &str) -> Option<PathBuf> {
        let candidates: Vec<String> = if self.platform.os == Os::Windows {
            ["exe", "cmd", "bat"].iter().map(|e| format!("{cmd}.{e}")).chain([cmd.to_string()]).collect()
        } else {
            vec![cmd.to_string()]
        };
        candidates.into_iter().map(|c| dir.join(c)).find(|p| p.is_file())
    }

    fn manifest(&self, name: &str) -> Option<Manifest> {
        let dir = self.root.join(name);
        let bytes = std::fs::read(dir.join(MANIFEST)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn write_manifest(&self, name: &str, m: &Manifest) -> IdeResult<()> {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(MANIFEST), serde_json::to_vec_pretty(m).unwrap_or_default())?;
        Ok(())
    }

    fn npm_package_version(&self, pkg: &str) -> Option<String> {
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(self.root.join("node_modules").join(pkg).join("package.json")).ok()?)
                .ok()?;
        json.get("version")?.as_str().map(String::from)
    }

    /// Whether an installed npm tool other than `tool` also installs `package`.
    fn npm_dependency_in_use(&self, tool: &str, package: &str) -> bool {
        TOOLS.iter().any(|t| match t.method {
            Method::Npm { packages } if t.name != tool => {
                packages.iter().skip(1).any(|p| npm_name(p) == package)
                    && self.npm_package_version(npm_name(packages[0])).is_some()
            }
            _ => false,
        })
    }

    fn query_version(&self, spec: &ToolSpec, found: &Path) -> Option<String> {
        let (cmd, args) = spec.version?;
        let sibling = found.parent().and_then(|d| self.exe_in(d, cmd));
        let program = sibling.or_else(|| self.which(cmd))?;
        let mut c = self.command(program);
        c.args(args);
        let (ok, out) = run_quiet(c, Duration::from_secs(4))?;
        if !ok {
            return None;
        }
        parse_version(&out)
    }

    /// Requirement check for installing `spec` right now.
    fn unavailable_reason(&self, spec: &ToolSpec) -> Option<String> {
        self.installer_missing(spec)
            .or_else(|| spec.needs.iter().find(|(cmd, _)| self.which(cmd).is_none()).map(|(_, why)| why.to_string()))
    }

    /// What the install method itself lacks (npm, a build for this platform, …).
    fn installer_missing(&self, spec: &ToolSpec) -> Option<String> {
        let need = |ok: bool, msg: &str| (!ok).then(|| msg.to_string());
        match spec.method {
            Method::Rustup { .. } => need(self.which("rustup").is_some(), "rustup is required (https://rustup.rs)"),
            Method::Npm { .. } => need(
                self.which_any(&["npm", "pnpm"]).is_some(),
                "npm or pnpm is required: install Node.js (https://nodejs.org)",
            ),
            Method::Go { .. } => need(self.which("go").is_some(), "Go is required (https://go.dev/dl)"),
            Method::Gem { .. } => need(self.which("gem").is_some(), "Ruby is required (https://www.ruby-lang.org)"),
            Method::DotnetTool { .. } => {
                need(self.which("dotnet").is_some(), ".NET SDK is required (https://dotnet.microsoft.com/download)")
            }
            Method::PipVenv { .. } => need(
                self.which("uv").is_some() || self.python().is_some(),
                "Python 3 or uv is required (https://www.python.org)",
            ),
            Method::PipUser { .. } | Method::PipTarget { .. } => {
                need(self.python().is_some(), "Python 3 is required (https://www.python.org)")
            }
            Method::Release { assets, .. } => {
                let p = self.platform;
                let has_rule = assets.iter().any(|r| {
                    r.os == p.os && (r.arch.is_none_or(|a| a == p.arch) || (p.os == Os::Mac && r.arch.is_some()))
                });
                if !has_rule {
                    return Some(format!("No prebuilt release for {:?} {:?}", p.os, p.arch));
                }
                need(self.which("curl").is_some(), "curl is required to download tools")
            }
        }
    }

    fn info_for(&self, name: &str, usage: Option<&Usage>) -> Option<ToolInfo> {
        let spec = registry::find(name);
        let languages = usage.map(|u| u.languages.clone()).unwrap_or_default();
        let install_hint = usage.and_then(|u| u.install_hint.clone());
        let Some(spec) = spec else {
            let u = usage?;
            let command = u.command.clone()?;
            let path = self.which(&command).or_else(|| self.found.get(&command).cloned());
            return Some(ToolInfo {
                name: name.to_string(),
                display_name: name.to_string(),
                kind: u.kind.unwrap_or(ToolKind::LanguageServer),
                status: if path.is_some() { ToolStatus::OnPath } else { ToolStatus::Missing },
                command,
                languages,
                path: path.map(Into::into),
                version: None,
                install_method: None,
                can_install: false,
                unavailable_reason: None,
                can_uninstall: false,
                install_hint,
                homepage: None,
                custom_error: None,
                default_args: u.args.clone(),
                default_initialization_options: u.initialization_options.clone(),
            })
            .map(|info| self.apply_custom(info, None));
        };
        let (status, path, version) = self.detect(spec);
        let unavailable_reason = self.unavailable_reason(spec);
        let can_uninstall = status == ToolStatus::Installed;
        Some(ToolInfo {
            name: spec.name.to_string(),
            display_name: spec.display.to_string(),
            kind: spec.kind,
            command: usage.and_then(|u| u.command.clone()).unwrap_or_else(|| spec.commands[0].to_string()),
            languages,
            status,
            path: path.map(Into::into),
            version,
            install_method: Some(spec.method.label().to_string()),
            can_install: unavailable_reason.is_none(),
            unavailable_reason,
            can_uninstall,
            install_hint,
            homepage: Some(spec.homepage.to_string()),
            custom_error: None,
            default_args: usage.map(|u| u.args.clone()).unwrap_or_default(),
            default_initialization_options: usage.and_then(|u| u.initialization_options.clone()),
        })
        .map(|info| self.apply_custom(info, Some(spec)))
    }

    /// Overrides the detected location with the executable chosen in settings.
    fn apply_custom(&self, mut info: ToolInfo, spec: Option<&ToolSpec>) -> ToolInfo {
        let Some(path) = self.custom.get(&info.command) else { return info };
        if !path.is_file() {
            info.status = ToolStatus::Missing;
            info.custom_error = Some(format!("{} does not exist", path.display()));
            info.path = None;
            info.version = None;
            return info;
        }
        info.version = spec.and_then(|spec| {
            let (cmd, args) = spec.version?;
            // The version command is the tool itself, whatever the chosen file is called.
            let program =
                if cmd == spec.commands[0] { path.clone() } else { path.parent().and_then(|d| self.exe_in(d, cmd))? };
            let mut c = self.command(program);
            c.args(args);
            let (ok, out) = run_quiet(c, Duration::from_secs(4))?;
            if ok { parse_version(&out) } else { None }
        });
        info.status = ToolStatus::Custom;
        info.path = Some(path.clone().into());
        info
    }

    fn detect(&self, spec: &ToolSpec) -> (ToolStatus, Option<PathBuf>, Option<String>) {
        let main = spec.commands[0];
        match spec.method {
            Method::Rustup { .. } => {
                let Some(path) = self.which(main) else { return (ToolStatus::Missing, None, None) };
                // The rustup proxy exists even without the component; it only answers when installed.
                let mut c = self.command(&path);
                c.arg("--version");
                match run_quiet(c, Duration::from_secs(5)) {
                    Some((true, out)) => (ToolStatus::Installed, Some(path), parse_version(&out)),
                    _ => (ToolStatus::Missing, None, None),
                }
            }
            Method::PipTarget { module, .. } => {
                let lib = python_lib_dir(&self.root, spec.name);
                if lib.join(module).join("__init__.py").is_file() {
                    let version = self.manifest(spec.name).and_then(|m| m.version);
                    return (ToolStatus::Installed, Some(lib), version);
                }
                // Importable by the default interpreter (pip install --user / a system package).
                let Some(python) = self.python() else { return (ToolStatus::Missing, None, None) };
                let mut c = self.command(&python);
                c.args(["-c", &format!("import {module}; print({module}.__version__)")]);
                match run_quiet(c, Duration::from_secs(5)) {
                    Some((true, out)) => (ToolStatus::OnPath, Some(python), parse_version(&out)),
                    _ => (ToolStatus::Missing, None, None),
                }
            }
            Method::PipUser { module, .. } => {
                let Some(python) = self.python() else { return (ToolStatus::Missing, None, None) };
                let mut c = self.command(&python);
                c.args(["-c", &format!("import {module}; print({module}.__version__)")]);
                match run_quiet(c, Duration::from_secs(5)) {
                    Some((true, out)) => (ToolStatus::Installed, Some(python), parse_version(&out)),
                    _ => (ToolStatus::Missing, None, None),
                }
            }
            _ => {
                let managed = managed_bin_dir(&self.root, spec, self.platform).and_then(|d| self.exe_in(&d, main));
                if let Some(path) = managed {
                    let version = match spec.method {
                        Method::Npm { packages } => self.npm_package_version(npm_name(packages[0])),
                        _ => self.manifest(spec.name).and_then(|m| m.version),
                    }
                    .or_else(|| self.query_version(spec, &path));
                    return (ToolStatus::Installed, Some(path), version);
                }
                match self.which(main) {
                    Some(path) => {
                        let version = self.query_version(spec, &path);
                        (ToolStatus::OnPath, Some(path), version)
                    }
                    None => (ToolStatus::Missing, None, None),
                }
            }
        }
    }

    /// Status of every registry tool plus every other server / adapter the
    /// language definitions mention, sorted by display name.
    pub fn list(&self, langs: &[LanguageConfig]) -> Vec<ToolInfo> {
        let usage = usages(langs);
        let mut names: Vec<String> = TOOLS.iter().map(|t| t.name.to_string()).collect();
        for name in usage.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<ToolInfo>> = Mutex::new(Vec::with_capacity(names.len()));
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(name) = names.get(i) else { break };
                        if let Some(info) = self.info_for(name, usage.get(name)) {
                            results.lock().push(info);
                        }
                    }
                });
            }
        });
        let mut out = results.into_inner();
        out.sort_by_key(|a| a.display_name.to_lowercase());
        out
    }

    pub fn info(&self, name: &str, langs: &[LanguageConfig]) -> IdeResult<ToolInfo> {
        let usage = usages(langs);
        self.info_for(name, usage.get(name)).ok_or_else(|| IdeError::not_found(format!("unknown tool `{name}`")))
    }

    /// Installs (or reinstalls / updates) `name`, streaming output to `emit`.
    pub fn install(
        &self,
        name: &str,
        langs: &[LanguageConfig],
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<ToolInfo> {
        let spec = registry::find(name).ok_or_else(|| {
            let hint = usages(langs).get(name).and_then(|u| u.install_hint.clone());
            IdeError::unavailable(match hint {
                Some(h) => format!("{name} cannot be installed automatically. {h}"),
                None => format!("{name} cannot be installed automatically"),
            })
        })?;
        if let Some(reason) = self.unavailable_reason(spec) {
            return Err(IdeError::unavailable(reason));
        }
        let _guard = InstallGuard::acquire(name)?;
        std::fs::create_dir_all(&self.root)?;
        emit(InstallEvent::Line { text: format!("Installing {} via {}…", spec.display, spec.method.label()) });
        match spec.method {
            Method::Rustup { component } => {
                let mut c = self.command(self.which("rustup").expect("checked"));
                c.args(["component", "add", component]);
                run_streamed(c, cancel, emit)?;
            }
            Method::Npm { packages } => self.install_npm(packages, cancel, emit)?,
            Method::Go { module } => self.install_go(spec, module, cancel, emit)?,
            Method::Gem { gem } => self.install_gem(spec, gem, cancel, emit)?,
            Method::DotnetTool { package } => self.install_dotnet_tool(spec, package, cancel, emit)?,
            Method::PipVenv { package } => self.install_venv(spec, package, cancel, emit)?,
            Method::PipUser { package, .. } => self.install_pip_user(package, cancel, emit)?,
            Method::PipTarget { package, .. } => self.install_pip_target(spec, package, cancel, emit)?,
            Method::Release { source, assets, locate } => {
                self.install_release(spec, source, assets, locate, cancel, emit)?
            }
        }
        let info = self.info(name, langs)?;
        if info.status == ToolStatus::Missing {
            return Err(IdeError::new(
                ErrorKind::Io,
                format!("installer finished but `{}` was not found afterwards", spec.commands[0]),
            ));
        }
        emit(InstallEvent::Line {
            text: format!("{} {} installed", spec.display, info.version.as_deref().unwrap_or("")).replace("  ", " "),
        });
        Ok(info)
    }

    fn npm_manager(&self) -> IdeResult<(PathBuf, bool)> {
        let npm = self.which("npm");
        let pnpm = self.which("pnpm");
        let use_pnpm = self.root.join("pnpm-lock.yaml").exists() && pnpm.is_some() || npm.is_none();
        match (use_pnpm, npm, pnpm) {
            (true, _, Some(p)) => Ok((p, true)),
            (false, Some(n), _) => Ok((n, false)),
            _ => Err(IdeError::unavailable("npm or pnpm is required: install Node.js (https://nodejs.org)")),
        }
    }

    fn ensure_package_json(&self) -> IdeResult<()> {
        let pj = self.root.join("package.json");
        if !pj.exists() {
            std::fs::write(pj, "{\n  \"name\": \"openidea-tools\",\n  \"private\": true\n}\n")?;
        }
        Ok(())
    }

    fn install_npm(&self, packages: &[&str], cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
        let (manager, pnpm) = self.npm_manager()?;
        self.ensure_package_json()?;
        let mut c = self.command(manager);
        let specs = packages.iter().map(|p| if npm_name(p) == *p { format!("{p}@latest") } else { p.to_string() });
        if pnpm {
            c.arg("add").arg("--dir").arg(&self.root).args(specs);
        } else {
            c.args(["install", "--no-fund", "--no-audit", "--loglevel=http", "--prefix"]).arg(&self.root).args(specs);
        }
        c.current_dir(&self.root);
        run_streamed(c, cancel, emit).map(drop)
    }

    fn install_go(&self, spec: &ToolSpec, module: &str, cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
        let dir = self.root.join(spec.name);
        let bin = dir.join("bin");
        let _ = std::fs::remove_dir_all(&bin);
        std::fs::create_dir_all(&bin)?;
        let mut c = self.command(self.which("go").expect("checked"));
        c.args(["install", "-v", module]).env("GOBIN", &bin).current_dir(&dir);
        if let Err(e) = run_streamed(c, cancel, emit) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        let version = self.exe_in(&bin, spec.commands[0]).and_then(|exe| {
            let mut c = self.command(self.which("go")?);
            c.args(["version", "-m"]).arg(exe);
            let (_, out) = run_quiet(c, Duration::from_secs(10))?;
            out.lines().find_map(|l| {
                let mut parts = l.split_whitespace();
                (parts.next() == Some("mod"))
                    .then(|| parts.nth(1))
                    .flatten()
                    .map(|v| v.trim_start_matches('v').to_string())
            })
        });
        self.write_manifest(spec.name, &Manifest { version, source: Some(module.to_string()) })
    }

    fn install_gem(&self, spec: &ToolSpec, gem: &str, cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
        let dir = self.root.join(spec.name);
        let _ = std::fs::remove_dir_all(&dir);
        let home = dir.join("gems");
        std::fs::create_dir_all(&home)?;
        let mut c = self.command(self.which("gem").expect("checked"));
        c.args(["install", "--no-document", "--install-dir"]).arg(&home).arg("--bindir").arg(home.join("bin")).arg(gem);
        let result = run_streamed(c, cancel, emit).and_then(|_| {
            // RubyGems' stubs only find their gems through GEM_HOME / GEM_PATH.
            let env = [("GEM_HOME", home.as_path()), ("GEM_PATH", home.as_path())];
            for cmd in spec.commands {
                let stub = self
                    .exe_in(&home.join("bin"), cmd)
                    .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("gem {gem} did not install `{cmd}`")))?;
                archive::env_wrapper(&dir.join("bin"), cmd, &stub, &env)?;
            }
            Ok(())
        });
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        // `gems/gems/<gem>-<version>/`
        let version = std::fs::read_dir(home.join("gems")).ok().and_then(|entries| {
            entries.flatten().find_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.strip_prefix(&format!("{gem}-"))
                    .filter(|v| v.starts_with(|c: char| c.is_ascii_digit()))
                    .map(String::from)
            })
        });
        self.write_manifest(spec.name, &Manifest { version, source: Some(format!("rubygems:{gem}")) })
    }

    fn install_dotnet_tool(
        &self,
        spec: &ToolSpec,
        package: &str,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let dir = self.root.join(spec.name);
        let _ = std::fs::remove_dir_all(&dir);
        let tool = dir.join("tool");
        std::fs::create_dir_all(&tool)?;
        let dotnet = self.which("dotnet").expect("checked");
        let mut c = self.command(&dotnet);
        c.args(["tool", "install", package, "--tool-path"]).arg(&tool);
        let result = run_streamed(c, cancel, emit).and_then(|_| {
            // The tool's apphost looks for .NET in the default location only; a
            // Homebrew / user-local SDK must be named through DOTNET_ROOT.
            let root = self.dotnet_root(&dotnet);
            for cmd in spec.commands {
                let exe = self
                    .exe_in(&tool, cmd)
                    .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("{package} did not install `{cmd}`")))?;
                match &root {
                    Some(root) => archive::env_wrapper(&dir.join("bin"), cmd, &exe, &[("DOTNET_ROOT", root)])?,
                    None => archive::link_executable(&dir.join("bin"), cmd, &exe)?,
                };
            }
            Ok(())
        });
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        // `Package Id      Version      Commands` table.
        let mut c = self.command(&dotnet);
        c.args(["tool", "list", "--tool-path"]).arg(&tool);
        let version = run_quiet(c, Duration::from_secs(20)).and_then(|(_, out)| {
            out.lines().find_map(|l| {
                let mut cols = l.split_whitespace();
                cols.next().filter(|id| id.eq_ignore_ascii_case(package))?;
                cols.next().map(String::from)
            })
        });
        self.write_manifest(spec.name, &Manifest { version, source: Some(format!("nuget:{package}")) })
    }

    /// The .NET install `dotnet` runs from: `Microsoft.NETCore.App 9.0.1 [<root>/shared/Microsoft.NETCore.App]`.
    fn dotnet_root(&self, dotnet: &Path) -> Option<PathBuf> {
        let mut c = self.command(dotnet);
        c.arg("--list-runtimes");
        let (_, out) = run_quiet(c, Duration::from_secs(20))?;
        let line = out.lines().find(|l| l.starts_with("Microsoft.NETCore.App "))?;
        let shared = line.rsplit_once('[')?.1.trim_end().strip_suffix(']')?;
        Path::new(shared).parent()?.parent().map(Path::to_path_buf)
    }

    fn install_venv(&self, spec: &ToolSpec, package: &str, cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
        let dir = self.root.join(spec.name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let venv = dir.join("venv");
        let python = venv.join(if self.platform.os == Os::Windows { "Scripts/python.exe" } else { "bin/python" });
        let result = (|| {
            if let Some(uv) = self.which("uv") {
                let mut c = self.command(&uv);
                c.arg("venv").arg(&venv);
                run_streamed(c, cancel, emit)?;
                let mut c = self.command(&uv);
                c.args(["pip", "install", "--python"]).arg(&python).arg(package);
                run_streamed(c, cancel, emit)?;
            } else {
                let mut c = self.command(self.python().expect("checked"));
                c.args(["-m", "venv"]).arg(&venv);
                run_streamed(c, cancel, emit)?;
                let mut c = self.command(&python);
                c.args(["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", package]);
                run_streamed(c, cancel, emit)?;
            }
            IdeResult::Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        let version = self
            .exe_in(&venv.join(if self.platform.os == Os::Windows { "Scripts" } else { "bin" }), spec.commands[0])
            .and_then(|p| self.query_version(spec, &p));
        self.write_manifest(spec.name, &Manifest { version, source: Some(format!("pypi:{package}")) })
    }

    fn install_pip_user(&self, package: &str, cancel: &CancellationToken, emit: Emit) -> IdeResult<()> {
        let python = self.python().expect("checked");
        let pip = |extra: &[&str]| {
            let mut c = self.command(&python);
            c.args(["-m", "pip", "install", "--user", "--upgrade", "--disable-pip-version-check"])
                .args(extra)
                .arg(package);
            run_collect(c, cancel, emit)
        };
        let (ok, out, status) = pip(&[])?;
        if ok {
            return Ok(());
        }
        if out.contains("externally-managed-environment") {
            emit(InstallEvent::Line {
                text: "This Python is externally managed; installing into the user site with --break-system-packages"
                    .into(),
            });
            let (ok, _, status) = pip(&["--break-system-packages"])?;
            if ok {
                return Ok(());
            }
            return Err(IdeError::new(ErrorKind::Io, format!("pip install {package} failed ({status})")));
        }
        Err(IdeError::new(ErrorKind::Io, format!("pip install {package} failed ({status})")))
    }

    /// The universal (`py3-none-any`) wheel, so the copy works with every interpreter
    /// version a project selects, not just the one that installed it.
    fn install_pip_target(
        &self,
        spec: &ToolSpec,
        package: &str,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let dir = self.root.join(spec.name);
        let _ = std::fs::remove_dir_all(&dir);
        let lib = python_lib_dir(&self.root, spec.name);
        std::fs::create_dir_all(&lib)?;
        let mut c = self.command(self.python().expect("checked"));
        c.args(["-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--upgrade", "--target"])
            .arg(&lib)
            .args(["--only-binary=:all:", "--platform", "any", "--implementation", "py"])
            .arg(package);
        if let Err(e) = run_streamed(c, cancel, emit) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        let version = std::fs::read_dir(&lib).ok().and_then(|entries| {
            entries.flatten().find_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let rest = name.strip_suffix(".dist-info")?.strip_prefix(package)?.strip_prefix('-')?;
                Some(rest.to_owned())
            })
        });
        self.write_manifest(spec.name, &Manifest { version, source: Some(format!("pypi:{package}")) })
    }

    fn resolve_release(
        &self,
        http: &Http,
        source: ReleaseSource,
        assets: &[platform::AssetRule],
        cancel: &CancellationToken,
    ) -> IdeResult<sources::Download> {
        match source {
            ReleaseSource::GitHub { repo } => {
                let json = http.get_text(&sources::github_latest_url(repo), cancel)?;
                sources::github_pick(&json, assets, self.platform)
            }
            ReleaseSource::HashiCorp { product } => {
                let json = http.get_text(&sources::hashicorp_latest_url(product), cancel)?;
                sources::hashicorp_pick(&json, assets, self.platform)
            }
            ReleaseSource::EclipseJdtls => {
                let index = http.get_text(sources::JDTLS_MILESTONES, cancel)?;
                let version = sources::jdtls_latest_milestone(&index)
                    .ok_or_else(|| IdeError::new(ErrorKind::Protocol, "no JDT LS milestone found"))?;
                let latest = http.get_text(&format!("{}{version}/latest.txt", sources::JDTLS_MILESTONES), cancel)?;
                sources::jdtls_download(&version, &latest)
            }
            ReleaseSource::OpenVsx { namespace, extension } => {
                let json = http.get_text(&sources::openvsx_latest_url(namespace, extension), cancel)?;
                sources::openvsx_pick(&json, assets, self.platform)
            }
            ReleaseSource::MavenCentral { group, artifact } => {
                let xml = http.get_text(&sources::maven_metadata_url(group, artifact), cancel)?;
                sources::maven_pick(group, artifact, &xml)
            }
        }
    }

    fn install_release(
        &self,
        spec: &ToolSpec,
        source: ReleaseSource,
        assets: &[platform::AssetRule],
        locate: &[&str],
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let http = Http::new(&self.system_path)?;
        emit(InstallEvent::Line { text: "Resolving the latest release…".into() });
        let dl = self.resolve_release(&http, source, assets, cancel)?;
        emit(InstallEvent::Line { text: format!("Downloading {} ({})", dl.name, dl.url) });
        let staging = self.root.join(format!(".staging-{}", spec.name));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        let result = self.download_and_unpack(spec, &http, &dl, locate, &staging, cancel, emit);
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn download_and_unpack(
        &self,
        spec: &ToolSpec,
        http: &Http,
        dl: &sources::Download,
        locate: &[&str],
        staging: &Path,
        cancel: &CancellationToken,
        emit: Emit,
    ) -> IdeResult<()> {
        let archive = fetch_verified(http, dl, staging, cancel, emit)?;
        emit(InstallEvent::Line { text: "Extracting…".into() });
        let pkg = staging.join("pkg");
        let kind = archive::ArchiveKind::from_name(&dl.name);
        let main = spec.commands[0];
        let exe_name = self.platform.exe(main);
        match kind {
            archive::ArchiveKind::Gz | archive::ArchiveKind::Raw => {
                archive::extract(&archive, kind, &pkg.join("bin"), &exe_name, cancel)?
            }
            _ => archive::extract(&archive, kind, &pkg, &exe_name, cancel)?,
        }
        let names: Vec<String> = locate
            .iter()
            .flat_map(|n| {
                if self.platform.os == Os::Windows && !n.contains('.') {
                    vec![format!("{n}.exe"), format!("{n}.cmd"), format!("{n}.bat")]
                } else {
                    vec![n.to_string()]
                }
            })
            .collect();
        let found = archive::locate(&pkg, &names)
            .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("`{main}` was not found in {}", dl.name)))?;
        let rel = found.strip_prefix(&pkg).expect("inside pkg").to_path_buf();
        let final_dir = self.root.join(spec.name);
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir)?;
        }
        std::fs::rename(&pkg, &final_dir)?;
        let target = final_dir.join(&rel);
        let bin = final_dir.join("bin");
        if is_bundle(main) {
            // A plugin jar loaded by another tool: a stable name, no launcher script.
            std::fs::create_dir_all(&bin)?;
            if target != bin.join(main) {
                std::fs::copy(&target, bin.join(main))?;
            }
        } else {
            archive::make_executable(&target)?;
            if self.exe_in(&bin, main).as_deref() != Some(target.as_path()) {
                archive::link_executable(&bin, main, &target)?;
            }
        }
        // Downloads made by the IDE itself are not quarantined, but archives may carry the flag.
        clear_quarantine(&final_dir);
        self.write_manifest(spec.name, &Manifest { version: Some(dl.version.clone()), source: Some(dl.url.clone()) })
    }

    /// Removes a tool the IDE installed.
    pub fn uninstall(&self, name: &str, langs: &[LanguageConfig]) -> IdeResult<ToolInfo> {
        let spec = registry::find(name).ok_or_else(|| IdeError::not_found(format!("unknown tool `{name}`")))?;
        let _guard = InstallGuard::acquire(name)?;
        let cancel = CancellationToken::new();
        let quiet = |_: InstallEvent| {};
        match spec.method {
            Method::Rustup { component } => {
                let rustup = self.which("rustup").ok_or_else(|| IdeError::unavailable("rustup not found"))?;
                let mut c = self.command(rustup);
                c.args(["component", "remove", component]);
                run_streamed(c, &cancel, &quiet)?;
            }
            Method::PipUser { package, .. } => {
                let python = self.python().ok_or_else(|| IdeError::unavailable("python3 not found"))?;
                let pip = |extra: &[&str]| {
                    let mut c = self.command(&python);
                    c.args(["-m", "pip", "uninstall", "-y", "--disable-pip-version-check"]).args(extra).arg(package);
                    run_collect(c, &cancel, &quiet)
                };
                let (ok, out, status) = pip(&[])?;
                if !ok {
                    let retried =
                        out.contains("externally-managed-environment") && pip(&["--break-system-packages"])?.0;
                    if !retried {
                        return Err(IdeError::new(ErrorKind::Io, format!("pip uninstall {package} failed ({status})")));
                    }
                }
            }
            Method::Npm { packages } => {
                if self.root.join("node_modules").exists() {
                    // Shared dependencies (`typescript`) stay while another installed tool needs them.
                    let packages: Vec<&str> = packages
                        .iter()
                        .enumerate()
                        .filter(|(i, p)| *i == 0 || !self.npm_dependency_in_use(spec.name, npm_name(p)))
                        .map(|(_, p)| npm_name(p))
                        .collect();
                    let (manager, pnpm) = self.npm_manager()?;
                    let mut c = self.command(manager);
                    if pnpm {
                        c.arg("remove").arg("--dir").arg(&self.root).args(&packages);
                    } else {
                        c.args(["uninstall", "--no-fund", "--no-audit", "--prefix"]).arg(&self.root).args(&packages);
                    }
                    c.current_dir(&self.root);
                    run_streamed(c, &cancel, &quiet)?;
                }
            }
            Method::Go { .. }
            | Method::Gem { .. }
            | Method::DotnetTool { .. }
            | Method::PipVenv { .. }
            | Method::PipTarget { .. }
            | Method::Release { .. } => {
                let dir = self.root.join(spec.name);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
            }
        }
        self.info(name, langs)
    }
}

/// Downloads `dl` into `staging` and checks its SHA-256 when one is published;
/// returns the downloaded file.
fn fetch_verified(
    http: &Http,
    dl: &sources::Download,
    staging: &Path,
    cancel: &CancellationToken,
    emit: Emit,
) -> IdeResult<PathBuf> {
    let archive = staging.join(&dl.name);
    http.download(&dl.url, &archive, dl.size, cancel, emit)?;
    let expected = match (&dl.sha256, &dl.checksum_url) {
        (Some(h), _) => Some(h.clone()),
        (None, Some(url)) => match http.get_text(url, cancel) {
            Ok(text) => sources::parse_checksum(&text, &dl.name),
            Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
            Err(_) => None,
        },
        (None, None) => None,
    };
    match expected {
        Some(expected) => {
            let actual = sources::sha256_file(&archive)?;
            if actual != expected {
                return Err(IdeError::new(
                    ErrorKind::Io,
                    format!("checksum mismatch for {}: expected {expected}, got {actual}", dl.name),
                ));
            }
            emit(InstallEvent::Line { text: "Checksum verified (SHA-256)".into() });
        }
        None => emit(InstallEvent::Line { text: "No checksum published; skipping verification".into() }),
    }
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    Ok(archive)
}

/// Removes the quarantine flag archives may carry, so macOS runs what was unpacked.
fn clear_quarantine(dir: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(dir).output();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dir;
}

#[cfg(test)]
mod tests;
