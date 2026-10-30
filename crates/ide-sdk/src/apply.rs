//! Applying the selected interpreters / toolchains (`languages.*` settings) to
//! language servers, run configurations and terminals.

use crate::discover::{project_venv_python, workspace_tsdk};
use crate::exec::{path_with, search_path};
use crate::{angular, godot, pinned, vue};
use crate::{bin_dir, exe, venv_of};
use ide_core::settings::{LanguageServerSettings, Settings};
use ide_core::version_managers::Tool;
use ide_language::{LanguageConfig, LanguageServerConfig};
use ide_run::RunConfig;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn non_empty(s: &str) -> Option<&str> {
    let s = s.trim();
    (!s.is_empty()).then_some(s)
}

/// Resolves `~/` and project-relative paths of a setting.
pub fn setting_path(root: &Path, s: &str) -> Option<PathBuf> {
    let s = non_empty(s)?;
    let p = match s.strip_prefix("~/") {
        Some(rest) => crate::home_dir()?.join(rest),
        None => PathBuf::from(s),
    };
    Some(if p.is_absolute() { p } else { root.join(p) })
}

/// The project interpreter: the configured one, else a project virtualenv
/// (`.venv`, `venv`, …) in the project root, else the Python the project pins for mise / asdf.
pub fn python_interpreter(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.python.interpreter)
        .or_else(|| project_venv_python(root))
        .or_else(|| pinned::pinned_python(root))
}

/// The configured `node` executable's directory, else the `bin` of the Node.js the
/// project pins for mise / asdf.
pub(crate) fn node_dir(root: &Path, s: &Settings) -> Option<PathBuf> {
    match setting_path(root, &s.languages.node.interpreter) {
        Some(p) => p.parent().map(Path::to_path_buf),
        None => pinned::pinned_install(root, Tool::Node)
            .map(|(dir, _)| dir.join("bin"))
            .filter(|bin| bin.join(exe("node")).is_file()),
    }
}

/// The configured Rust toolchain's `bin` directory and rustup toolchain name.
pub(crate) fn rust_bin(root: &Path, s: &Settings) -> Option<(PathBuf, Option<String>)> {
    let dir = setting_path(root, &s.languages.rust.toolchain)?;
    let bin = if dir.join("bin").join(exe("rustc")).is_file() || dir.join("bin").join(exe("cargo")).is_file() {
        dir.join("bin")
    } else {
        dir
    };
    let home = bin.parent();
    let toolchain = home
        .filter(|h| h.parent().is_some_and(|p| p.ends_with("toolchains")))
        .and_then(|h| h.file_name())
        .map(|n| n.to_string_lossy().into_owned());
    Some((bin, toolchain))
}

/// The configured GOROOT, else the Go the project pins for mise / asdf.
pub(crate) fn goroot(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.go.goroot)
        .or_else(|| pinned::pinned_install(root, Tool::Go).and_then(|(dir, _)| pinned::goroot_in_install(&dir)))
}

/// A JDK setting: a JDK home, its `bin` or its `bin/java`.
fn jdk_setting(root: &Path, value: &str) -> Option<Result<crate::java::Jdk, PathBuf>> {
    let p = setting_path(root, value)?;
    Some(p.ancestors().take(3).find_map(crate::java::jdk_at).ok_or(p))
}

/// The project JDK (`languages.java.jdk`), else the JDK the project pins for mise / asdf.
pub fn project_jdk(root: &Path, s: &Settings) -> Option<crate::java::Jdk> {
    match jdk_setting(root, &s.languages.java.jdk) {
        Some(jdk) => jdk.inspect_err(|p| tracing::warn!("project JDK {} is not a JDK home", p.display())).ok(),
        None => pinned::pinned_install(root, Tool::Java).and_then(|(dir, _)| pinned::jdk_in_install(&dir)),
    }
}

/// The JDK chosen to run jdtls (`languages.java.jdtlsJdk`): `Ok(None)` when not
/// set, `Err` (the message) when it is not a JDK home.
pub fn jdtls_jdk(root: &Path, s: &Settings) -> Result<Option<crate::java::Jdk>, String> {
    match jdk_setting(root, &s.languages.java.jdtls_jdk) {
        None => Ok(None),
        Some(Ok(jdk)) => Ok(Some(jdk)),
        Some(Err(p)) => Err(format!(
            "The language server JDK {} is not a JDK home (Settings › Languages & Frameworks › Java).",
            p.display()
        )),
    }
}

/// `mvn` of the configured Maven home (`languages.java.maven.home`): the
/// executable itself, `<home>/bin/mvn` or `<bin>/mvn`; else of the Maven the project
/// pins for mise / asdf when it has no Maven wrapper.
pub fn maven_command(root: &Path, s: &Settings) -> Option<PathBuf> {
    let name = if cfg!(windows) { "mvn.cmd" } else { "mvn" };
    let Some(p) = setting_path(root, &s.languages.java.maven.home) else {
        if root.join("mvnw").is_file() || root.join("mvnw.cmd").is_file() {
            return None;
        }
        let (dir, _) = pinned::pinned_install(root, Tool::Maven)?;
        let homes = std::iter::once(dir.clone()).chain(std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()));
        return homes.map(|h| h.join("bin").join(name)).find(|c| c.is_file());
    };
    let found = [p.clone(), p.join("bin").join(name), p.join(name)].into_iter().find(|c| c.is_file());
    if found.is_none() {
        tracing::warn!("Maven home {} has no {name}", p.display());
    }
    found
}

/// Project launcher policy for sync and tool-window tasks.
pub fn gradle_command(root: &Path, build_dir: &Path, s: &Settings) -> PathBuf {
    resolve_gradle_command(root, build_dir, s, true)
}

fn resolve_gradle_command(root: &Path, build_dir: &Path, s: &Settings, use_wrapper: bool) -> PathBuf {
    let g = &s.languages.java.gradle;
    let name = if cfg!(windows) { "gradle.bat" } else { "gradle" };
    if g.distribution == ide_core::settings::GradleDistribution::Local
        && let Some(home) = setting_path(root, &g.home)
    {
        return home.join("bin").join(name);
    }
    let wrapper = build_dir.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
    if use_wrapper && wrapper.is_file() {
        return wrapper;
    }
    pinned::pinned_install(build_dir, Tool::Gradle)
        .map(|(home, _)| home.join("bin").join(name))
        .unwrap_or_else(|| name.into())
}

/// Gradle JVM overrides Project JDK; model callers supply the module's fallback environment.
pub fn gradle_env(
    root: &Path,
    s: &Settings,
    mut env: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    if let Some(home) = setting_path(root, &s.languages.java.gradle.jvm) {
        env.insert("JAVA_HOME".into(), home.to_string_lossy().into_owned());
    }
    if let Some(home) = setting_path(root, &s.languages.java.gradle.user_home) {
        env.insert("GRADLE_USER_HOME".into(), home.to_string_lossy().into_owned());
    }
    env
}

/// Maven options from settings, placed before the goals: `-s <settings.xml>`
/// and `-Dmaven.repo.local=<dir>`.
pub fn maven_options(root: &Path, s: &Settings) -> Vec<String> {
    let m = &s.languages.java.maven;
    let mut out = Vec::new();
    if let Some(file) = setting_path(root, &m.user_settings) {
        out.extend(["-s".to_owned(), file.to_string_lossy().into_owned()]);
    }
    if let Some(dir) = setting_path(root, &m.local_repository) {
        out.push(format!("-Dmaven.repo.local={}", dir.to_string_lossy()));
    }
    out
}

/// The Maven local repository from settings: the configured one, else
/// `<localRepository>` of the configured user `settings.xml`; `None` = Maven's default.
pub fn maven_local_repository(root: &Path, s: &Settings) -> Option<PathBuf> {
    let m = &s.languages.java.maven;
    setting_path(root, &m.local_repository).or_else(|| {
        let text = std::fs::read_to_string(setting_path(root, &m.user_settings)?).ok()?;
        let repo = crate::java::xml_value(&crate::lombok::strip_xml_comments(&text), "localRepository")?;
        let home = crate::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        let repo = repo.replace("${user.home}", &home);
        (!repo.is_empty() && !repo.contains("${")).then(|| PathBuf::from(repo))
    })
}

/// TypeScript `lib` directory for the selected version; `None` = the server's bundled one.
pub fn tsdk(root: &Path, s: &Settings) -> Option<PathBuf> {
    match s.languages.typescript.version.trim() {
        "" | "bundled" => None,
        "workspace" => workspace_tsdk(root),
        custom => {
            let p = setting_path(root, custom)?;
            Some(if p.extension().is_some_and(|e| e == "js") { p.parent()?.to_path_buf() } else { p })
        }
    }
}

const PYTHON_SERVERS: [&str; 6] = ["basedpyright", "pyright", "ty", "pylsp", "jedi-language-server", "ruff"];

fn merge(base: &mut Value, layer: Value) {
    match (base, layer) {
        (Value::Object(base), Value::Object(layer)) => {
            for (k, v) in layer {
                match base.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, layer) => *base = layer,
    }
}

/// Excludes project-relative Maven POM paths from JDTLS import, preserving user exclusions.
pub fn configure_maven_import(cfg: &mut LanguageServerConfig, root: &Path, excluded_poms: &[PathBuf]) {
    if cfg.name != "jdtls" {
        return;
    }
    let mut options =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| json!({}));
    if let Some(settings) = &cfg.settings {
        merge(&mut options, settings.clone());
    }
    let mut exclusions = options
        .pointer("/java/import/exclusions")
        .or_else(|| options.pointer("/settings/java/import/exclusions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            vec![
                json!("**/node_modules/**"),
                json!("**/.metadata/**"),
                json!("**/archetype-resources/**"),
                json!("**/META-INF/maven/**"),
            ]
        });
    for pom in excluded_poms {
        let directory = root.join(pom).parent().unwrap_or(root).to_path_buf();
        let directory = directory.to_string_lossy().replace('\\', "/");
        // Java NIO glob syntax treats these characters specially even in literal paths.
        let escaped: String =
            directory.chars().flat_map(|c| if "*?[]{}\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
        exclusions.push(json!(escaped));
    }
    if !excluded_poms.is_empty() {
        merge_init_options(cfg, json!({"settings": {"java": {"import": {"exclusions": exclusions}}}}));
        if let Some(settings) = &mut cfg.settings {
            merge(
                settings,
                json!({"java": {"import": {"exclusions": exclusions}}, "settings": {"java": {"import": {"exclusions": exclusions}}}}),
            );
        }
        // A fresh workspace cannot retain Maven projects imported before unlinking.
        if let Some(index) = cfg.args.iter().position(|arg| arg == "-data")
            && let Some(workspace) = cfg.args.get_mut(index + 1)
        {
            let mut hash = 0xcbf29ce484222325u64;
            for pom in excluded_poms {
                for byte in pom.to_string_lossy().bytes().chain([0]) {
                    hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                }
            }
            *workspace = format!("{workspace}-maven-{hash:016x}");
        }
    }
}

pub(crate) fn merge_init_options(cfg: &mut LanguageServerConfig, layer: Value) {
    let mut current =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| json!({}));
    if !current.is_object() {
        current = json!({});
    }
    merge(&mut current, layer);
    match toml::Value::try_from(current) {
        Ok(v) => cfg.initialization_options = Some(v),
        Err(e) => tracing::warn!("{}: cannot apply settings to initialization options: {e}", cfg.name),
    }
}

/// Adjusts a language server's launch configuration from settings: interpreter
/// paths, toolchain `PATH`, env (`GOROOT`, `RUST_SRC_PATH`, `VIRTUAL_ENV`) and
/// server settings (`python.pythonPath`, rust-analyzer `check.command`, `typescript.tsdk`).
/// `root` is the project root, `server_root` the server's workspace root.
/// The executable to launch for `command`: the one chosen in settings, else for
/// commands with well-known install locations (Godot) the one found there.
pub fn tool_command(root: &Path, s: &Settings, command: &str) -> Option<PathBuf> {
    let custom = s.tool_path(command).and_then(|p| setting_path(root, p));
    if command == godot::COMMAND {
        return godot::find(custom);
    }
    custom
}

/// Points a run configuration launching a bare tool name at the executable from
/// [`tool_command`] (Godot apps live outside the search path).
pub fn resolve_run_command(config: &mut RunConfig, root: &Path, s: &Settings) {
    if config.command == godot::COMMAND
        && let Some(path) = tool_command(root, s, &config.command)
    {
        config.command = path.to_string_lossy().into_owned();
    }
}

pub fn configure_server(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    if let Some(custom) = tool_command(root, s, &cfg.command) {
        cfg.command = custom.to_string_lossy().into_owned();
    }
    let mut path_dirs: Vec<PathBuf> = Vec::new();
    let name = cfg.name.clone();
    let name = name.as_str();

    if PYTHON_SERVERS.contains(&name) {
        let python = project_venv_python(server_root)
            .filter(|_| non_empty(&s.languages.python.interpreter).is_none())
            .or_else(|| python_interpreter(root, s));
        if let Some(python) = python {
            let p = python.to_string_lossy().into_owned();
            match name {
                "basedpyright" | "pyright" => merge_init_options(cfg, json!({ "python": { "pythonPath": p } })),
                "pylsp" => merge_init_options(cfg, json!({ "pylsp": { "plugins": { "jedi": { "environment": p } } } })),
                "jedi-language-server" => merge_init_options(cfg, json!({ "workspace": { "environmentPath": p } })),
                _ => {}
            }
            if let Some(venv) = venv_of(&python) {
                cfg.env.insert("VIRTUAL_ENV".into(), venv.to_string_lossy().into_owned());
                path_dirs.push(venv.join(bin_dir()));
            }
        }
    }

    if name == "rust-analyzer" {
        let r = &s.languages.rust;
        let extra_args: Vec<&str> = r.rustfmt_args.split_whitespace().collect();
        // Only non-default values: rust-analyzer's own defaults (and the
        // language definition's options) stay untouched otherwise.
        let mut layer = serde_json::Map::new();
        if !r.check_on_save {
            layer.insert("checkOnSave".into(), json!(false));
        }
        if let Some(cmd) = non_empty(&r.check_command).filter(|c| *c != "check") {
            layer.insert("check".into(), json!({ "command": cmd }));
        }
        if !extra_args.is_empty() {
            layer.insert("rustfmt".into(), json!({ "extraArgs": extra_args }));
        }
        if !layer.is_empty() {
            merge_init_options(cfg, Value::Object(layer));
        }
        if let Some((bin, toolchain)) = rust_bin(root, s) {
            path_dirs.push(bin);
            if let Some(t) = toolchain {
                cfg.env.insert("RUSTUP_TOOLCHAIN".into(), t);
            }
        }
        if let Some(src) = setting_path(root, &r.stdlib) {
            cfg.env.insert("RUST_SRC_PATH".into(), src.to_string_lossy().into_owned());
        }
    }

    if name == "gopls" {
        if let Some(goroot) = goroot(root, s) {
            path_dirs.push(goroot.join("bin"));
            cfg.env.insert("GOROOT".into(), goroot.to_string_lossy().into_owned());
        }
        if let Some(gopath) = setting_path(root, &s.languages.go.gopath) {
            cfg.env.insert("GOPATH".into(), gopath.to_string_lossy().into_owned());
        }
    }

    if name == "jdtls" {
        // The jdtls launcher forwards `--jvm-arg=` values to the JVM it starts.
        let args = s.languages.java.jdtls_vm_args.split_whitespace().map(|a| format!("--jvm-arg={a}"));
        cfg.args.extend(args);
        // m2e (the Maven import) reads mirrors, servers and `<localRepository>` from it.
        if let Some(file) = setting_path(root, &s.languages.java.maven.user_settings) {
            let file = file.to_string_lossy();
            merge_init_options(
                cfg,
                json!({ "settings": { "java": { "configuration": { "maven": { "userSettings": file } } } } }),
            );
        }
    }

    if let Some(lib) = tsdk(server_root, s).or_else(|| tsdk(root, s)) {
        let lib_s = lib.to_string_lossy().into_owned();
        match name {
            "vtsls" => merge_init_options(cfg, json!({ "typescript": { "tsdk": lib_s } })),
            "typescript-language-server" => {
                merge_init_options(cfg, json!({ "tsserver": { "path": lib.join("tsserver.js").to_string_lossy() } }))
            }
            _ => {}
        }
    }
    let vue_command = s.tool_path(vue::SERVER).and_then(|p| setting_path(root, p));
    let vue_command = vue_command.as_deref().map_or(vue::SERVER.into(), Path::to_string_lossy);
    if name == "vtsls"
        && let Some(vue) = vue::server_package(&vue_command, &search_path())
    {
        let plugin = vue::tsserver_plugin(&vue);
        merge_init_options(cfg, json!({ "vtsls": { "tsserver": { "globalPlugins": [plugin] } } }));
    }
    if name == vue::SERVER {
        configure_vue_typescript(cfg, root, server_root, s);
    }

    // Node-based servers (`#!/usr/bin/env node`) run on the selected Node.js.
    if let Some(dir) = node_dir(root, s) {
        path_dirs.push(dir);
    }

    if !path_dirs.is_empty() {
        let dirs: Vec<&Path> = path_dirs.iter().map(PathBuf::as_path).collect();
        cfg.env.insert("PATH".into(), path_with(&dirs));
    }

    // Last: it finds the server on the `PATH` set above.
    if name == angular::SERVER {
        configure_angular(cfg, root, server_root, s);
    }
}

/// The servers `language` uses after Settings › Language Servers: the
/// definition's ones that aren't disabled, then the ones defined in settings for it.
pub fn language_servers(language: &str, defined: &[LanguageServerConfig], s: &Settings) -> Vec<LanguageServerConfig> {
    let enabled = |name: &str| s.language_servers.get(name).is_none_or(|ls| ls.enabled);
    let mut out: Vec<LanguageServerConfig> = defined.iter().filter(|c| enabled(&c.name)).cloned().collect();
    for (name, ls) in &s.language_servers {
        if ls.enabled && ls.languages.iter().any(|l| l == language) && !out.iter().any(|c| &c.name == name) {
            out.push(custom_server(name, ls));
        }
    }
    out
}

/// Adds the servers defined in settings to the languages they serve (to list
/// them with the tools); disabled ones stay so they can be turned back on.
pub fn with_custom_servers(langs: &mut [LanguageConfig], s: &Settings) {
    for (name, ls) in s.language_servers.iter().filter(|(_, ls)| ls.is_custom()) {
        for lang in langs.iter_mut().filter(|l| ls.languages.iter().any(|id| id == l.id.as_str())) {
            if !lang.language_servers.iter().any(|c| &c.name == name) {
                lang.language_servers.push(custom_server(name, ls));
            }
        }
    }
}

fn custom_server(name: &str, ls: &LanguageServerSettings) -> LanguageServerConfig {
    LanguageServerConfig {
        name: name.to_owned(),
        command: ls.command.trim().to_owned(),
        args: Vec::new(),
        env: Default::default(),
        root_markers: ls.root_markers.clone(),
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: Some(match ls.command.trim() {
            "" => format!("Set the command of `{name}` in Settings › Language Servers"),
            command => format!("`{command}` was not found: install it, or set its path in Settings › Language Servers"),
        }),
        connect: None,
        fallback: false,
        max_java: None,
        launch_error: None,
    }
}

/// Command and arguments from Settings › Language Servers; applied before
/// [`configure_server`] so toolchain adjustments (a custom path, JVM args) still follow.
pub fn server_launch_overrides(cfg: &mut LanguageServerConfig, s: &Settings) {
    let Some(ls) = s.language_servers.get(&cfg.name) else { return };
    if let Some(command) = non_empty(ls.command.trim()) {
        cfg.command = command.to_owned();
    }
    if let Some(args) = &ls.args {
        cfg.args = args.clone();
    }
}

/// Environment, `initializationOptions` and `workspace/configuration` settings
/// from Settings › Language Servers; applied last so they win over derived values.
pub fn server_protocol_overrides(cfg: &mut LanguageServerConfig, s: &Settings) {
    let Some(ls) = s.language_servers.get(&cfg.name) else { return };
    cfg.env.extend(ls.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    if let Some(options) = &ls.initialization_options {
        merge_init_options(cfg, options.clone());
    }
    if let Some(settings) = &ls.settings {
        let mut current = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
        merge(&mut current, settings.clone());
        cfg.settings = Some(current);
    }
}

/// vue-language-server loads TypeScript as a library (`--tsdk`, else its own
/// `require('typescript')`): the selected version, else its own, else the
/// project's — whichever still has the language-service API.
fn configure_vue_typescript(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    let selected = tsdk(server_root, s).or_else(|| tsdk(root, s)).filter(|l| vue::has_ts_api(l));
    let package = vue::server_package(&cfg.command, &search_path());
    let own = package.as_deref().and_then(vue::own_typescript);
    let workspace = || workspace_tsdk(server_root).or_else(|| workspace_tsdk(root)).filter(|l| vue::has_ts_api(l));
    let lib = match selected {
        Some(lib) => Some(lib),
        None if own.is_some() => None,
        None => workspace(),
    };
    match lib {
        Some(lib) => cfg.args.push(format!("--tsdk={}", lib.to_string_lossy())),
        None if own.is_none() && package.is_some() => cfg.launch_error = Some(vue::missing_typescript_message()),
        None => {}
    }
}

/// ngserver loads TypeScript and `@angular/language-service` from probe
/// locations: its own package (it depends on both), then the project. A selected
/// TypeScript version goes first (`--tsdk`); the project's Angular version decides
/// the template syntax. Without its package the server can't start.
fn configure_angular(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    // Found as the launcher finds it; missing, it asks to be installed.
    let path = cfg.env.get("PATH").map_or_else(search_path, OsString::from);
    let Some(bin) = ide_core::tool_path::find_command(&cfg.command, &path, server_root) else { return };
    let Some(package) = angular::server_package(&bin, &path, server_root, &cfg.env) else {
        cfg.launch_error = Some(angular::missing_package_message(&bin));
        return;
    };
    let package = package.to_string_lossy().into_owned();
    // The server splits the list at commas.
    if package.contains(',') {
        cfg.launch_error = Some(angular::comma_message(&package));
        return;
    }
    // Launch the server whose package is probed, not another one on the path.
    cfg.command = bin.to_string_lossy().into_owned();
    let project = server_root.to_string_lossy();
    let probes = if project.contains(',') { package } else { format!("{package},{project}") };
    cfg.args.extend(["--ngProbeLocations".into(), probes.clone(), "--tsProbeLocations".into(), probes]);
    if let Some(lib) = tsdk(server_root, s).or_else(|| tsdk(root, s)) {
        cfg.args.extend(["--tsdk".into(), lib.to_string_lossy().into_owned()]);
    }
    // The project root is an ancestor of the server's.
    if let Some(version) = angular::core_version(server_root) {
        cfg.args.extend(angular::version_args(&version));
    }
}

fn is_python_command(cmd: &str) -> bool {
    let name = Path::new(cmd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    name == "python"
        || name == "python3"
        || name.strip_prefix("python3.").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit()))
}

const PY_RUNNERS: [&str; 3] = ["uv", "poetry", "pdm"];

/// Points run configurations at the selected toolchains: Python configs use the
/// project interpreter, npm scripts the chosen package manager and Node.js,
/// cargo / go configs the selected toolchain, Maven / Gradle the project JDK
/// (and Maven the configured home and options).
pub fn apply_to_run_configs(configs: &mut [RunConfig], root: &Path, s: &Settings) {
    let explicit_python = setting_path(root, &s.languages.python.interpreter);
    let python = python_interpreter(root, s);
    let pm = non_empty(&s.languages.node.package_manager);
    let node = node_dir(root, s);
    let rust = rust_bin(root, s);
    let go = goroot(root, s);
    let gopath = setting_path(root, &s.languages.go.gopath);
    let jdk = project_jdk(root, s);
    let mvn = maven_command(root, s);
    let mvn_options = maven_options(root, s);

    for c in configs.iter_mut() {
        resolve_run_command(c, root, s);
        let mut path_dirs: Vec<PathBuf> = Vec::new();
        match c.kind.as_str() {
            "python" | "pytest" => {
                if let Some(py) = &explicit_python {
                    let runner = PY_RUNNERS.contains(&c.command.as_str());
                    if c.kind == "python" && (runner || is_python_command(&c.command)) {
                        if runner && c.args.first().map(String::as_str) == Some("run") {
                            // `uv run python …` → `<interpreter> …`
                            let skip = if c.args.get(1).is_some_and(|a| is_python_command(a)) { 2 } else { 1 };
                            c.args.drain(..skip.min(c.args.len()));
                        }
                        c.command = py.to_string_lossy().into_owned();
                    } else if c.kind == "pytest" && c.detected {
                        let rest: Vec<String> = match c.args.as_slice() {
                            [run, tool, rest @ ..] if run == "run" && tool == "pytest" => rest.to_vec(),
                            [m, tool, rest @ ..] if m == "-m" && tool == "pytest" => rest.to_vec(),
                            other => other.to_vec(),
                        };
                        c.command = py.to_string_lossy().into_owned();
                        c.args = ["-m".to_owned(), "pytest".to_owned()].into_iter().chain(rest).collect();
                    }
                }
                if let Some(venv) = python.as_deref().and_then(venv_of)
                    && !c.env.contains_key("VIRTUAL_ENV")
                {
                    c.env.insert("VIRTUAL_ENV".into(), venv.to_string_lossy().into_owned());
                    path_dirs.push(venv.join(bin_dir()));
                }
            }
            "npm" => {
                if let Some(pm) = pm
                    && c.detected
                    && matches!(c.command.as_str(), "npm" | "pnpm" | "yarn" | "bun")
                {
                    c.command = pm.to_owned();
                }
                if let Some(dir) = &node {
                    path_dirs.push(dir.clone());
                }
            }
            "cargo" => {
                if let Some((bin, toolchain)) = &rust {
                    if c.command == "cargo" && bin.join(exe("cargo")).is_file() {
                        c.command = bin.join(exe("cargo")).to_string_lossy().into_owned();
                    }
                    path_dirs.push(bin.clone());
                    if let Some(t) = toolchain {
                        c.env.entry("RUSTUP_TOOLCHAIN".into()).or_insert_with(|| t.clone());
                    }
                }
            }
            "go" => {
                if let Some(goroot) = &go {
                    let bin = goroot.join("bin");
                    if c.command == "go" && bin.join(exe("go")).is_file() {
                        c.command = bin.join(exe("go")).to_string_lossy().into_owned();
                    }
                    c.env.entry("GOROOT".into()).or_insert_with(|| goroot.to_string_lossy().into_owned());
                    path_dirs.push(bin);
                }
                if let Some(gopath) = &gopath {
                    c.env.entry("GOPATH".into()).or_insert_with(|| gopath.to_string_lossy().into_owned());
                }
            }
            "gradle" => {
                let build_dir = c.cwd.as_ref().map(|p| root.join(p.as_ref())).unwrap_or_else(|| root.to_path_buf());
                if matches!(c.command.as_str(), "gradle" | "gradle.bat") {
                    c.command = resolve_gradle_command(root, &build_dir, s, false).to_string_lossy().into_owned();
                }
                let defaults = jdk
                    .as_ref()
                    .map(|j| {
                        std::collections::BTreeMap::from([("JAVA_HOME".into(), j.home.to_string_lossy().into_owned())])
                    })
                    .unwrap_or_default();
                for (key, value) in gradle_env(root, s, defaults) {
                    c.env.entry(key).or_insert(value);
                }
            }
            "maven" | "tomcat" => {
                if let Some(jdk) = &jdk {
                    c.env.entry("JAVA_HOME".into()).or_insert_with(|| jdk.home.to_string_lossy().into_owned());
                }
                if c.kind == "maven" && c.detected {
                    if let Some(mvn) = &mvn {
                        c.command = mvn.to_string_lossy().into_owned();
                    }
                    if !c.args.starts_with(&mvn_options) {
                        c.args.splice(0..0, mvn_options.iter().cloned());
                    }
                } else if c.kind == "maven"
                    && matches!(c.command.as_str(), "mvn" | "mvn.cmd" | "mvn.bat")
                    && let Some(mvn) = &mvn
                {
                    // A goal configuration saved from the tool window keeps the
                    // literal `mvn` / `mvn.cmd` the launcher resolved to; without a
                    // wrapper it cannot start when Maven lives on a version
                    // manager's shims or a configured home (#328). Detected configs
                    // take the Maven options too, but the saved ones already baked
                    // them into `args`.
                    c.command = mvn.to_string_lossy().into_owned();
                }
            }
            _ => {}
        }
        if !path_dirs.is_empty() && !c.env.contains_key("PATH") {
            let dirs: Vec<&Path> = path_dirs.iter().map(PathBuf::as_path).collect();
            c.env.insert("PATH".into(), path_with(&dirs));
        }
    }
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Command typed into a new terminal to activate the project virtualenv
/// (PyCharm's Tools › Terminal › "Activate virtualenv"), for the given shell.
pub fn terminal_activation(root: &Path, s: &Settings, shell: Option<&str>) -> Option<String> {
    if !s.languages.python.activate_virtualenv {
        return None;
    }
    let venv = python_interpreter(root, s).as_deref().and_then(venv_of)?;
    if std::env::var_os("VIRTUAL_ENV").is_some_and(|v| Path::new(&v) == venv) {
        return None;
    }
    let shell = shell
        .map(str::to_owned)
        .or_else(|| std::env::var("SHELL").ok())
        .or_else(|| std::env::var("COMSPEC").ok())
        .unwrap_or_default();
    let name = Path::new(&shell).file_stem().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let script = |file: &str| venv.join(bin_dir()).join(file);
    let line = match name.as_str() {
        "fish" => format!("source {}", sh_quote(&script("activate.fish").to_string_lossy())),
        "csh" | "tcsh" => format!("source {}", sh_quote(&script("activate.csh").to_string_lossy())),
        "nu" => format!("overlay use {}", sh_quote(&script("activate.nu").to_string_lossy())),
        "pwsh" | "powershell" => format!("& '{}'", script("Activate.ps1").to_string_lossy().replace('\'', "''")),
        "cmd" => format!("\"{}\"", script("activate.bat").to_string_lossy()),
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "mksh" | "ash" => {
            format!("source {}", sh_quote(&script("activate").to_string_lossy()))
        }
        // Not a shell (e.g. `docker exec` in a terminal tab): type nothing.
        _ => return None,
    };
    let target = match name.as_str() {
        "fish" => "activate.fish",
        "csh" | "tcsh" => "activate.csh",
        "nu" => "activate.nu",
        "pwsh" | "powershell" => "Activate.ps1",
        "cmd" => "activate.bat",
        _ => "activate",
    };
    script(target).is_file().then_some(line)
}

#[cfg(test)]
mod maven_linkage_tests {
    use super::*;

    #[test]
    fn import_excludes_unlinked_modules_and_changes_persistent_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/child")).unwrap();
        std::fs::write(tmp.path().join("a/pom.xml"), "<project><modules><module>child</module></modules></project>")
            .unwrap();
        std::fs::write(tmp.path().join("a/child/pom.xml"), "<project/>").unwrap();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        cfg.args = vec!["-data".into(), "/cache/jdtls".into()];
        merge_init_options(&mut cfg, json!({"settings":{"java":{"import":{"exclusions":["**/custom"]}}}}));
        configure_maven_import(&mut cfg, tmp.path(), &["a/child/pom.xml".into(), "a/pom.xml".into()]);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        let exclusions = options.pointer("/settings/java/import/exclusions").unwrap().as_array().unwrap();
        assert!(exclusions.contains(&json!("**/custom")));
        assert!(exclusions.contains(&json!(tmp.path().join("a").to_string_lossy().replace('\\', "/"))));
        assert!(exclusions.contains(&json!(tmp.path().join("a/child").to_string_lossy().replace('\\', "/"))));
        assert!(cfg.args[1].starts_with("/cache/jdtls-maven-"));
    }
}
