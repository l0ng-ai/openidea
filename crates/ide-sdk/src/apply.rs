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

/// The project Ruby: the configured one, else the `.ruby-version` / mise / asdf
/// install, else `ruby` on PATH.
pub fn ruby_interpreter(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.ruby.interpreter).or_else(|| crate::ruby::project_ruby(root))
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

/// The directory of the configured `php` executable (it also holds the matching `phpize`,
/// `pecl`…): put on the `PATH` so `#!/usr/bin/env php` scripts such as `vendor/bin/phpunit`
/// and Composer run on the selected interpreter.
pub(crate) fn php_dir(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.php.interpreter).and_then(|p| p.parent().map(Path::to_path_buf))
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
        Some(jdk) => jdk.inspect_err(|p| tracing::warn!("project JDK {}", not_a_jdk(p))).ok(),
        None => pinned::pinned_install(root, Tool::Java).and_then(|(dir, _)| pinned::jdk_in_install(&dir)),
    }
}

/// The JDK chosen to run jdtls (`languages.java.jdtlsJdk`): `Ok(None)` when not
/// set, `Err` (the message) when it is not a JDK home.
pub fn jdtls_jdk(root: &Path, s: &Settings) -> Result<Option<crate::java::Jdk>, String> {
    match jdk_setting(root, &s.languages.java.jdtls_jdk) {
        None => Ok(None),
        Some(Ok(jdk)) if !ide_core::java_runtime::supports_java_bundles(&jdk.home) => {
            Err(crate::java::server_jdk_incomplete_message(&jdk, jdk.major.max(crate::java::JDTLS_MIN_JAVA)))
        }
        Some(Ok(jdk)) => Ok(Some(jdk)),
        Some(Err(p)) => {
            Err(format!("The language server JDK {} (Settings › Languages & Frameworks › Java).", not_a_jdk(&p)))
        }
    }
}

/// Why the configured JDK path `p` is not used: gone (e.g. a version manager removed
/// it on upgrade) or not a JDK.
fn not_a_jdk(p: &Path) -> String {
    if p.exists() {
        format!("{} is not a JDK home", p.display())
    } else {
        format!("{} does not exist; choose another JDK or clear the setting to detect one", p.display())
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

fn maven_settings_prefixes(args: &[String]) -> Vec<usize> {
    let mut prefixes = vec![0];
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "-s" && args.get(i + 1).is_some() {
            i += 2;
        } else if arg.starts_with("-Dmaven.repo.local=") {
            i += 1;
        } else {
            break;
        }
        prefixes.push(i);
    }
    prefixes
}

fn generated_maven_goal(config: &RunConfig) -> bool {
    config.id.starts_with("maven:goal:") && config.extras.params.is_empty()
}

fn maven_goal_prefix(config: &RunConfig) -> Option<usize> {
    let (_, goals) = config.id.split_once(".xml:")?;
    maven_settings_prefixes(&config.args)
        .into_iter()
        .find(|&start| (start + 1..=config.args.len()).any(|end| config.args[start..end].join(" ") == goals))
}

/// Applies the current Maven settings at launch, including temporary configurations
/// made before build-tool defaults stopped being stored in their command and arguments.
pub fn prepare_maven_run(config: &mut RunConfig, root: &Path, s: &Settings) {
    let mut detected = config.detected;
    if generated_maven_goal(config) {
        // The id records the user's original goals; only the settings prefix before them is derived.
        if let Some(prefix) = maven_goal_prefix(config) {
            config.args.drain(..prefix);
        }
        let name = config.command.rsplit(['/', '\\']).next().unwrap_or_default().to_ascii_lowercase();
        if !matches!(name.as_str(), "mvnw" | "mvnw.cmd" | "mvnw.bat") {
            config.command = "mvn".into();
            if maven_command(root, s).is_none() {
                let cwd = config.cwd.as_ref().map_or_else(|| root.to_path_buf(), |dir| root.join(dir.as_ref()));
                for dir in cwd.ancestors().take_while(|dir| dir.starts_with(root)) {
                    let wrapper = dir.join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
                    if wrapper.is_file() {
                        config.command = wrapper.to_string_lossy().into_owned();
                        break;
                    }
                }
            }
        }
    } else if config.detected || config.id.starts_with("context:") {
        let saved = ide_run::load_user_configs(root).unwrap_or_default();
        let id = config
            .id
            .strip_prefix("context:target:context:")
            .or_else(|| config.id.strip_prefix("context:"))
            .unwrap_or(&config.id);
        let id = id.strip_prefix("workspace:").and_then(|id| id.split_once(':')).map_or(id, |(_, id)| id);
        let source = ide_run::detect(root)
            .into_iter()
            .filter(|base| {
                base.kind == "maven"
                    && (id == base.id || id.starts_with(&format!("{}:", base.id)))
                    && !saved.iter().any(|user| user.id == base.id)
            })
            .max_by_key(|base| base.id.len());
        if let Some(base) = source.filter(|_| config.extras.params.is_empty()) {
            if let Some(prefix) = maven_settings_prefixes(&config.args)
                .into_iter()
                .find(|&start| config.args[start..].starts_with(&base.args))
            {
                config.args.drain(..prefix);
            }
            config.command = base.command;
        } else {
            detected = false;
        }
    }
    let original = config.detected;
    config.detected = detected;
    apply_to_run_configs(std::slice::from_mut(config), root, s);
    config.detected = original;
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

const PYTHON_SERVERS: [&str; 7] = ["basedpyright", "pyright", "ty", "pyrefly", "pylsp", "jedi-language-server", "ruff"];

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
/// `build_files` (`file:` URIs), when given, are the only build files jdtls imports: the
/// exclusions cannot leave out a module of a reactor jdtls imports.
pub fn configure_maven_import(
    cfg: &mut LanguageServerConfig,
    root: &Path,
    excluded_poms: &[PathBuf],
    build_files: Option<&[String]>,
) {
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
        if let Some(files) = build_files {
            merge_init_options(cfg, json!({"projectConfigurations": files}));
        }
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

/// Workspace compiler defaults; Eclipse project preferences still take precedence.
pub(crate) fn configure_java_compiler(cfg: &mut LanguageServerConfig, data_dir: &Path) {
    let file = data_dir.join("lsp/jdtls/compiler-defaults.prefs");
    const DEFAULTS: &str = "org.eclipse.jdt.core.compiler.problem.forbiddenReference=warning\n\
org.eclipse.jdt.core.compiler.problem.discouragedReference=warning\n";
    let write = || -> ide_core::IdeResult<()> {
        std::fs::create_dir_all(file.parent().expect("compiler preferences directory"))?;
        if std::fs::read_to_string(&file).ok().as_deref() != Some(DEFAULTS) {
            ide_vfs::write_atomic(&file, DEFAULTS.as_bytes())?;
        }
        Ok(())
    };
    if let Err(e) = write() {
        tracing::warn!("jdtls: cannot write compiler defaults: {e}");
        return;
    }
    // jdtls accepts absolute filesystem paths as well as URLs (including paths
    // containing spaces and Windows backslashes). Explicit server settings win later.
    let defaults = json!({"settings": {"java": {"settings": {"url": file.to_string_lossy()}}}});
    let existing = cfg.initialization_options.clone();
    merge_init_options(cfg, defaults);
    if let Some(existing) = existing {
        merge_init_options(cfg, serde_json::to_value(existing).expect("TOML initialization options"));
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
        let mut build = crate::go::build_settings(&s.languages.go.build_tags);
        let module_env = crate::go::module_environment(server_root, &s.languages.go.modules);
        for (key, value) in module_env {
            build["env"][key] = json!(value);
        }
        let mut settings = cfg.settings.take().unwrap_or_else(|| json!({}));
        // gopls retains omitted keys on reconfiguration. Explicit empty values
        // restore defaults when the last project constraint is cleared.
        let init = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok());
        for (key, default) in [("buildFlags", json!([])), ("env", json!({}))] {
            if settings.get(key).is_none() {
                settings[key] = init.as_ref().and_then(|v| v.get(key)).cloned().unwrap_or(default);
            }
        }
        merge(&mut settings, build);
        cfg.settings = Some(settings);
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
    // PHP servers (phpactor, `php intelephense`-style wrappers) on the selected PHP.
    if let Some(dir) = php_dir(root, s) {
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
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        pinned: None,
    }
}

/// Command and arguments from Settings › Language Servers; applied before
/// [`configure_server`] so toolchain adjustments (a custom path, JVM args) still follow.
pub fn server_launch_overrides(cfg: &mut LanguageServerConfig, s: &Settings) {
    let Some(ls) = s.language_servers.get(&cfg.name) else { return };
    if let Some(command) = non_empty(ls.command.trim()) {
        cfg.command = command.to_owned();
        // The user's own program, not the one approved for a plugin.
        cfg.pinned = None;
    }
    if let Some(args) = &ls.args {
        cfg.args = args.clone();
    }
}

/// Environment, features, `initializationOptions` and `workspace/configuration`
/// settings from Settings › Language Servers; applied last so they win over derived values.
pub fn server_protocol_overrides(cfg: &mut LanguageServerConfig, s: &Settings) {
    let Some(ls) = s.language_servers.get(&cfg.name) else { return };
    cfg.env.extend(ls.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    if let Some(features) = &ls.features {
        cfg.features = features.clone();
    }
    if let Some(kinds) = &ls.code_action_kinds {
        cfg.code_action_kinds = kinds.clone();
    }
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

/// [`maven_options`] as the groups they are passed in (`-s <file>`, `-Dmaven.repo.local=…`).
fn maven_option_groups(options: &[String]) -> Vec<&[String]> {
    let mut groups = Vec::new();
    let mut i = 0;
    while i < options.len() {
        let n = if options[i] == "-s" { 2.min(options.len() - i) } else { 1 };
        groups.push(&options[i..i + n]);
        i += n;
    }
    groups
}

/// Whether `args` set what `group` sets: a user settings file, or the local repository.
fn sets_maven_option(args: &[String], group: &[String]) -> bool {
    match group.first().map(String::as_str) {
        Some("-s") => args.iter().any(|a| a == "-s" || a == "--settings" || a.starts_with("--settings=")),
        Some(flag) => {
            let key = flag.split_once('=').map_or(flag, |(k, _)| k);
            args.iter().any(|a| a.split_once('=').map_or(a.as_str(), |(k, _)| k) == key)
                || args
                    .windows(2)
                    .any(|a| a[0] == "-D" && format!("-D{}", a[1].split('=').next().unwrap_or_default()) == key)
        }
        None => true,
    }
}

/// Settings › Maven's options ahead of the goals, each unless the configuration sets it itself.
fn add_maven_options(args: &mut Vec<String>, options: &[String]) {
    let missing: Vec<String> =
        maven_option_groups(options).into_iter().filter(|g| !sets_maven_option(args, g)).flatten().cloned().collect();
    args.splice(0..0, missing);
}

/// Points run configurations at the selected toolchains: Python configs use the
/// project interpreter, npm scripts the chosen package manager and Node.js,
/// cargo / go configs the selected toolchain, Maven / Gradle the project JDK
/// (and Maven the configured home and options).
pub fn apply_to_run_configs(configs: &mut [RunConfig], root: &Path, s: &Settings) {
    let explicit_python = setting_path(root, &s.languages.python.interpreter);
    let python = python_interpreter(root, s);
    let pm = non_empty(&s.languages.node.package_manager);
    let node = node_dir(root, s);
    let php = setting_path(root, &s.languages.php.interpreter);
    let rust = rust_bin(root, s);
    let go = goroot(root, s);
    let gopath = setting_path(root, &s.languages.go.gopath);
    let jdk = project_jdk(root, s);
    let mvn = maven_command(root, s);
    let mvn_options = maven_options(root, s);
    let ruby = ruby_interpreter(root, s);

    for c in configs.iter_mut() {
        resolve_run_command(c, root, s);
        let mut path_dirs: Vec<PathBuf> = Vec::new();
        match c.kind.as_str() {
            "python" | "pytest" | "django-test" => {
                if let Some(py) = &explicit_python {
                    let runner = PY_RUNNERS.contains(&c.command.as_str());
                    if (c.kind == "python" || c.kind == "django-test") && (runner || is_python_command(&c.command)) {
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
                // The configuration's own Node interpreter, else the project's.
                let own = c.extras.params.get("nodeInterpreter").and_then(|p| setting_path(root, p));
                if let Some(dir) = own.and_then(|p| p.parent().map(Path::to_path_buf)).or_else(|| node.clone()) {
                    path_dirs.push(dir);
                }
            }
            "php" | "phpunit" | "composer" => {
                if let Some(php) = &php {
                    if c.kind == "php" && c.detected && c.command == "php" {
                        c.command = php.to_string_lossy().into_owned();
                    }
                    path_dirs.extend(php.parent().map(Path::to_path_buf));
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
                for (key, value) in crate::go::module_environment(root, &s.languages.go.modules) {
                    c.env.entry(key).or_insert(value);
                }
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
            "ruby" | "rake" | "rspec" => {
                if let Some(ruby) = &ruby
                    && let Some(bin) = crate::ruby::bin_dir_of(ruby)
                {
                    // `ruby`, `bundle`, `rake`, `rspec` of the chosen interpreter when installed
                    // alongside it; the rest (a project `bin/rspec` binstub) stays as is.
                    let name = Path::new(&c.command).file_name().map(|n| n.to_string_lossy().into_owned());
                    if let Some(name) = name
                        && matches!(name.as_str(), "ruby" | "bundle" | "rake" | "rspec" | "gem" | "irb")
                        && !c.command.contains('/')
                        && !c.command.contains('\\')
                    {
                        let exe = bin.join(exe(&name));
                        if exe.is_file() {
                            c.command = exe.to_string_lossy().into_owned();
                        }
                    }
                    path_dirs.push(bin);
                }
            }
            "maven" | "tomcat" => {
                if let Some(jdk) = &jdk {
                    c.env.entry("JAVA_HOME".into()).or_insert_with(|| jdk.home.to_string_lossy().into_owned());
                }
                if c.kind == "maven" {
                    if let Some(mvn) = &mvn
                        && (c.detected
                            || generated_maven_goal(c)
                            || matches!(c.command.as_str(), "mvn" | "mvn.cmd" | "mvn.bat"))
                    {
                        c.command = mvn.to_string_lossy().into_owned();
                    }
                    add_maven_options(&mut c.args, &mvn_options);
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

/// `config` as it should be saved: without what [`apply_to_run_configs`] derives from
/// settings, so a configuration read from the run list, edited and saved keeps following
/// Languages & Frameworks instead of freezing today's toolchain (and the IDE's whole
/// `PATH`) into `run.toml`. A value counts as derived when applying settings to the
/// configuration without it produces it again: an environment entry (`PATH`,
/// `VIRTUAL_ENV`, `JAVA_HOME`, `GOROOT`, …) or an absolute command its bare name
/// resolves to (the project interpreter, a toolchain's `cargo` / `go`, Maven's `mvn`).
pub fn without_derived(config: &RunConfig, root: &Path, s: &Settings) -> RunConfig {
    let applied = |c: &RunConfig| {
        let mut c = c.clone();
        apply_to_run_configs(std::slice::from_mut(&mut c), root, s);
        c
    };
    let mut out = config.clone();
    // Until nothing changes: some entries are derived only once others are gone
    // (the virtualenv's `PATH` is added only without `VIRTUAL_ENV`). An entry derived before
    // the configuration's own choice (an npm script's Node interpreter) is derived too.
    while let Some(key) = out
        .env
        .iter()
        .find(|(key, value)| {
            let mut probe = out.clone();
            probe.env.remove(*key);
            let mut plain = probe.clone();
            plain.extras.params.clear();
            applied(&probe).env.get(*key) == Some(*value) || applied(&plain).env.get(*key) == Some(*value)
        })
        .map(|(key, _)| key.clone())
    {
        out.env.remove(&key);
    }
    // Settings › Maven's options, which applying puts back ahead of the goals.
    if out.kind == "maven" {
        let options = maven_options(root, s);
        let mut probe = out.clone();
        let mut prefix = generated_maven_goal(&out).then(|| maven_goal_prefix(&out)).flatten();
        for group in maven_option_groups(&options) {
            if let Some(at) = probe.args.windows(group.len()).position(|w| w == group)
                && prefix.is_none_or(|limit| at + group.len() <= limit)
            {
                probe.args.drain(at..at + group.len());
                if let Some(limit) = &mut prefix {
                    *limit -= group.len();
                }
            }
        }
        if applied(&probe).args == out.args {
            out.args = probe.args;
        }
    }
    let path = Path::new(&config.command);
    if path.is_absolute()
        && let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned())
    {
        let mut probe = out.clone();
        probe.command = name.clone();
        if applied(&probe).command == config.command {
            out.command = name;
        }
    }
    out
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Command typed into a new terminal to activate the project virtualenv
/// (Tools › Terminal › "Activate virtualenv"). `shell` must be the resolved PTY shell.
pub fn terminal_activation(root: &Path, s: &Settings, shell: &str) -> Option<String> {
    if !s.languages.python.activate_virtualenv {
        return None;
    }
    let venv = python_interpreter(root, s).as_deref().and_then(venv_of)?;
    if std::env::var_os("VIRTUAL_ENV").is_some_and(|v| Path::new(&v) == venv) {
        return None;
    }
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let name = Path::new(name).file_stem().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
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
mod java_compiler_tests {
    use super::*;

    fn options(cfg: &LanguageServerConfig) -> Value {
        serde_json::to_value(cfg.initialization_options.as_ref().unwrap()).unwrap()
    }

    #[test]
    fn compiler_defaults_live_in_the_cache_and_preserve_other_options() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache with spaces 测试");
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        merge_init_options(&mut cfg, json!({"settings": {"java": {"format": {"tabSize": 4}}}}));
        configure_java_compiler(&mut cfg, &cache);
        let options = options(&cfg);
        let path = PathBuf::from(options.pointer("/settings/java/settings/url").unwrap().as_str().unwrap());
        assert!(path.starts_with(&cache));
        let prefs = std::fs::read_to_string(&path).unwrap();
        assert_eq!(prefs.lines().count(), 2);
        for problem in ["forbiddenReference", "discouragedReference"] {
            assert!(prefs.contains(&format!("org.eclipse.jdt.core.compiler.problem.{problem}=warning\n")));
        }
        assert_eq!(options.pointer("/settings/java/format/tabSize"), Some(&json!(4)));
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        configure_java_compiler(&mut cfg, &cache);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), modified);
        assert_eq!(self::options(&cfg), options);
    }

    #[test]
    fn explicit_compiler_settings_keep_priority() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        merge_init_options(&mut cfg, json!({"settings": {"java": {"settings": {"url": "own.prefs"}}}}));
        configure_java_compiler(&mut cfg, tmp.path());
        assert_eq!(options(&cfg).pointer("/settings/java/settings/url"), Some(&json!("own.prefs")));

        for settings in [
            json!({"java": {"settings": {"url": "custom.prefs"}}}),
            json!({"settings": {"java": {"settings": {"url": "custom.prefs"}}}}),
        ] {
            cfg.settings = None;
            let mut s = Settings::default();
            s.language_servers.insert(
                "jdtls".into(),
                LanguageServerSettings { settings: Some(settings.clone()), ..Default::default() },
            );
            server_protocol_overrides(&mut cfg, &s);
            assert_eq!(cfg.settings, Some(settings));
        }
        let mut s = Settings::default();
        s.language_servers.insert(
            "jdtls".into(),
            LanguageServerSettings {
                initialization_options: Some(json!({"settings": {"java": {"settings": {"url": "user.prefs"}}}})),
                ..Default::default()
            },
        );
        server_protocol_overrides(&mut cfg, &s);
        assert_eq!(options(&cfg).pointer("/settings/java/settings/url"), Some(&json!("user.prefs")));
    }
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
        configure_maven_import(&mut cfg, tmp.path(), &["a/child/pom.xml".into(), "a/pom.xml".into()], None);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        let exclusions = options.pointer("/settings/java/import/exclusions").unwrap().as_array().unwrap();
        assert!(exclusions.contains(&json!("**/custom")));
        assert!(exclusions.contains(&json!(tmp.path().join("a").to_string_lossy().replace('\\', "/"))));
        assert!(exclusions.contains(&json!(tmp.path().join("a/child").to_string_lossy().replace('\\', "/"))));
        assert!(cfg.args[1].starts_with("/cache/jdtls-maven-"));
        assert!(options.get("projectConfigurations").is_none());
    }

    #[test]
    fn import_lists_the_build_files_when_given() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        let files = ["file:///p/r/x/pom.xml".to_owned(), "file:///p/build.gradle".to_owned()];
        configure_maven_import(&mut cfg, tmp.path(), &["r/y/pom.xml".into()], Some(&files));
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert_eq!(options["projectConfigurations"], json!(files));
        // Nothing unlinked: jdtls finds the build files itself.
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        configure_maven_import(&mut cfg, tmp.path(), &[], Some(&files));
        assert!(serde_json::to_value(cfg.initialization_options).unwrap().get("projectConfigurations").is_none());
    }
}
