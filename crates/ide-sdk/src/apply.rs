//! Applying the selected interpreters / toolchains (`languages.*` settings) to
//! language servers, run configurations and terminals.

use crate::discover::{project_venv_python, workspace_tsdk};
use crate::exec::{path_with, search_path, which};
use crate::{angular, godot, pinned, vue};
use crate::{bin_dir, exe, venv_of};
use ide_core::settings::{InspectionLevel, InspectionSettings, LanguageServerSettings, Settings};
use ide_core::version_managers::Tool;
use ide_core::{IdeError, IdeResult};
use ide_language::{LanguageConfig, LanguageServerConfig};
use ide_run::RunConfig;
use serde_json::{Value, json};
use std::collections::HashMap;
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

fn toml_has_table(file: &Path, table: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Ok(value) = toml::from_str::<toml::Value>(&text) else { return false };
    table.split('.').try_fold(&value, |value, key| value.get(key)).is_some_and(toml::Value::is_table)
}

/// The Ruff configuration file selected by `languages.ruff.configurationDirectory`.
/// A file can be chosen directly; a directory resolves `ruff.toml`, `.ruff.toml`,
/// then a `pyproject.toml` containing `[tool.ruff]`.
pub fn ruff_configuration(root: &Path, configured: &str) -> IdeResult<Option<PathBuf>> {
    let Some(path) = setting_path(root, configured) else { return Ok(None) };
    if path.is_file() {
        return Ok(Some(path));
    }
    if !path.is_dir() {
        return Err(IdeError::invalid(format!("Ruff configuration path does not exist: {}", path.display())));
    }
    for name in ["ruff.toml", ".ruff.toml"] {
        let file = path.join(name);
        if file.is_file() {
            return Ok(Some(file));
        }
    }
    let pyproject = path.join("pyproject.toml");
    if toml_has_table(&pyproject, "tool.ruff") {
        return Ok(Some(pyproject));
    }
    Err(IdeError::invalid(format!(
        "Ruff configuration directory has no ruff.toml, .ruff.toml, or pyproject.toml with [tool.ruff]: {}",
        path.display()
    )))
}

/// The project interpreter: the configured one, else a project virtualenv
/// (`.venv`, `venv`, …) or pixi environment (`.pixi/envs/<env>`) in the project
/// root, else the Python the project pins for mise / asdf.
pub fn python_interpreter(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.python.interpreter)
        .or_else(|| project_venv_python(root))
        .or_else(|| pinned::pinned_python(root))
}

/// An explicit project interpreter wins; otherwise use the closest virtualenv to the file.
pub fn python_interpreter_near(root: &Path, near: Option<&Path>, s: &Settings) -> Option<PathBuf> {
    if let Some(python) = setting_path(root, &s.languages.python.interpreter) {
        return Some(python);
    }
    let near = near.filter(|dir| dir.starts_with(root)).unwrap_or(root);
    near.ancestors()
        .take_while(|dir| dir.starts_with(root))
        .find_map(project_venv_python)
        .or_else(|| pinned::pinned_python(near))
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

/// Module-specific JDK from `projectStructure.modules`, falling back to [`project_jdk`].
pub fn module_jdk(root: &Path, module: &Path, s: &Settings) -> Option<crate::java::Jdk> {
    let module_cfg = s.project_structure.module_settings(root, module);
    if let Some(cfg) = module_cfg
        && let Some(jdk) = jdk_setting(root, &cfg.jdk)
    {
        return jdk.inspect_err(|p| tracing::warn!("module JDK {}", not_a_jdk(p))).ok();
    }
    project_jdk(root, s)
}

/// Effective Java language level (`8`, `11`, `17`, `21`, `25`) for `module`, checking
/// `projectStructure.modules` first, then `languages.java.languageLevel`.
pub fn effective_java_language_level<'a>(root: &Path, module: &Path, s: &'a Settings) -> Option<&'a str> {
    let module_level = s.project_structure.module_settings(root, module).and_then(|m| non_empty(&m.language_level));
    module_level.or_else(|| non_empty(&s.languages.java.language_level))
}

/// The JDK chosen to run jdtls (`languages.java.jdtlsJdk`): `Ok(None)` when not
/// set, `Err` (the message) when it is not a JDK home.
pub fn jdtls_jdk(root: &Path, s: &Settings) -> Result<Option<crate::java::Jdk>, String> {
    match jdk_setting(root, &s.languages.java.jdtls_jdk) {
        None => Ok(None),
        Some(Ok(jdk)) if !ide_core::java_runtime::supports_java_bundles(&jdk.home) => {
            Err(crate::java::server_jdk_incomplete_message(&jdk, jdk.major.max(crate::java::JDTLS_MIN_JAVA)))
        }
        Some(Ok(jdk)) => match crate::java::java_execution_error(&crate::java::java_executable(&jdk.home)) {
            Some(error) => Err(error),
            None => Ok(Some(jdk)),
        },
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

/// Maven runner JRE, falling back to the project JDK and then the POM's Java version.
pub fn maven_jdk(root: &Path, s: &Settings, release: Option<u32>) -> Option<crate::java::Jdk> {
    match jdk_setting(root, &s.languages.java.maven.runner_jre) {
        Some(jdk) => jdk.inspect_err(|p| tracing::warn!("Maven runner JRE {}", not_a_jdk(p))).ok(),
        None => project_jdk(root, s).or_else(|| {
            let installed = crate::java::installed_jdks();
            release.and_then(|r| crate::java::pick_jdk(&installed, Some(r))).cloned()
        }),
    }
}

/// Default environment shared by Maven sync, builds and run configurations.
pub fn maven_build_env(root: &Path, s: &Settings, release: Option<u32>) -> std::collections::BTreeMap<String, String> {
    maven_jdk(root, s, release)
        .map(|jdk| std::collections::BTreeMap::from([("JAVA_HOME".into(), jdk.home.to_string_lossy().into_owned())]))
        .unwrap_or_default()
}

/// `mvn` of the configured Maven home (`languages.java.maven.home`): the
/// executable itself, `<home>/bin/mvn` or `<bin>/mvn`; else of the Maven the project
/// pins for mise / asdf when it has no Maven wrapper. With `maven.daemon` on, the
/// Maven Daemon (`mvnd`) replaces all of that — it embeds its own Maven — unless
/// it is not installed or the runner JRE is older than the Java 17 its daemon
/// needs, in which case the build stays on mvn (with a logged warning).
pub fn maven_command(root: &Path, s: &Settings) -> Option<PathBuf> {
    if s.languages.java.maven.daemon {
        match mvnd_command(root, s) {
            // Without a selected JDK, mvnd picks its own Java, which may still be new enough.
            Some(mvnd) if maven_jdk(root, s, None).is_none_or(|j| j.major >= 17) => return Some(mvnd),
            Some(_) => tracing::warn!(
                "Maven daemon: the runner JRE is older than the Java 17 its daemon needs; building with mvn"
            ),
            None => tracing::warn!("Maven daemon is enabled but mvnd was not found; building with mvn"),
        }
    }
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

/// The `mvnd` executable when the Maven Daemon is enabled: the configured home
/// (`languages.java.maven.mvndHome`, the executable itself or `<home>/bin/mvnd`),
/// else `$MVND_HOME`, else `mvnd` on `PATH`, else the common Homebrew / sdkman
/// locations. `None` = not found; the caller falls back to `mvn`.
pub fn mvnd_command(root: &Path, s: &Settings) -> Option<PathBuf> {
    let name = if cfg!(windows) { "mvnd.cmd" } else { "mvnd" };
    if let Some(p) = setting_path(root, &s.languages.java.maven.mvnd_home) {
        let found = [p.clone(), p.join("bin").join(name), p.join(name)].into_iter().find(|c| c.is_file());
        if found.is_none() {
            tracing::warn!("Maven Daemon home {} has no {name}", p.display());
        }
        return found;
    }
    if let Some(home) = std::env::var_os("MVND_HOME").map(PathBuf::from) {
        let found = [home.join("bin").join(name), home.join(name)].into_iter().find(|c| c.is_file());
        if found.is_none() {
            tracing::warn!("MVND_HOME {} has no {name}", home.display());
        }
        return found;
    }
    if let Some(found) = crate::exec::which(name) {
        return Some(found);
    }
    if let Some(home) = crate::home_dir() {
        let sdkman = home.join(".sdkman/candidates/mvnd/current");
        let candidates = [
            sdkman.join("bin").join(name),
            PathBuf::from("/opt/homebrew/opt/mvnd").join("bin").join(name),
            PathBuf::from("/usr/local/opt/mvnd").join("bin").join(name),
        ];
        return candidates.into_iter().find(|c| c.is_file());
    }
    None
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

fn gradle_run_jdk<'a>(
    release: Option<u32>,
    configured: Option<&'a crate::java::Jdk>,
    installed: &'a [crate::java::Jdk],
    gradle: Option<(u32, u32)>,
) -> Option<&'a crate::java::Jdk> {
    configured.or_else(|| {
        let release = release?;
        // An unknown Gradle version cannot narrow the choice: the release alone decides.
        let Some(gradle) = gradle else { return crate::java::pick_jdk(installed, Some(release)) };
        let compatible: Vec<_> = installed.iter().filter(|jdk| gradle_supports_java(gradle, jdk.major)).collect();
        compatible
            .iter()
            .copied()
            .find(|jdk| jdk.major == release)
            .or_else(|| compatible.iter().copied().filter(|jdk| jdk.major > release).min_by_key(|jdk| jdk.major))
            .or_else(|| compatible.iter().copied().max_by_key(|jdk| jdk.major))
    })
}

/// Default environment shared by Gradle model builds and Run configurations.
pub fn gradle_build_env(
    root: &Path,
    build_dir: &Path,
    command: &str,
    settings: &Settings,
    release: Option<u32>,
) -> std::collections::BTreeMap<String, String> {
    let configured = project_jdk(root, settings);
    let installed = crate::java::installed_jdks();
    let jdk = gradle_run_jdk(
        release.or_else(|| crate::java::project_java_version(build_dir)),
        configured.as_ref(),
        &installed,
        gradle_distribution_version(build_dir, command),
    );
    let env = jdk
        .map(|jdk| std::collections::BTreeMap::from([("JAVA_HOME".into(), jdk.home.to_string_lossy().into_owned())]))
        .unwrap_or_default();
    gradle_env(root, settings, env)
}

fn gradle_supports_java(gradle: (u32, u32), java: u32) -> bool {
    // https://docs.gradle.org/current/userguide/compatibility.html#java_runtime
    let minimum = match java {
        8 => (2, 0),
        9 => (4, 3),
        10 => (4, 7),
        11 => (5, 0),
        12 => (5, 4),
        13 => (6, 0),
        14 => (6, 3),
        15 => (6, 7),
        16 => (7, 0),
        17 => (7, 3),
        18 => (7, 5),
        19 => (7, 6),
        20 => (8, 3),
        21 => (8, 5),
        22 => (8, 8),
        23 => (8, 10),
        24 => (8, 14),
        25 => (9, 1),
        26 => (9, 4),
        27 => (9, 8),
        _ => return false,
    };
    gradle >= minimum && (java >= 17 || gradle < (9, 0))
}

fn gradle_distribution_version(build_dir: &Path, command: &str) -> Option<(u32, u32)> {
    let version = |text: &str| {
        let mut parts = text.split('.');
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    };
    if Path::new(command).file_stem().is_some_and(|name| name == "gradlew") {
        let properties = std::fs::read_to_string(build_dir.join("gradle/wrapper/gradle-wrapper.properties")).ok()?;
        let url = properties.lines().find_map(|line| line.trim().strip_prefix("distributionUrl="))?;
        return version(url.rsplit_once("gradle-")?.1.split('-').next()?);
    }
    let path = Path::new(command);
    let path = if path.is_absolute() { path.to_path_buf() } else { crate::exec::which(command)? };
    let path = dunce::canonicalize(path).ok()?;
    let home = path.parent()?.parent()?;
    for lib in [home.join("lib"), home.join("libexec/lib")] {
        let Ok(entries) = std::fs::read_dir(lib) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(v) = name.strip_prefix("gradle-launcher-").and_then(|name| name.strip_suffix(".jar")) {
                return version(v);
            }
        }
    }
    None
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

/// Maven options from settings, placed before the goals: `-s <settings.xml>`,
/// `-t <toolchains.xml>`, `-Dmaven.repo.local=<dir>`, `-T <count>` and `-P <profiles>`.
pub fn maven_options(root: &Path, s: &Settings) -> Vec<String> {
    let m = &s.languages.java.maven;
    let mut out = Vec::new();
    if let Some(file) = setting_path(root, &m.user_settings) {
        out.extend(["-s".to_owned(), file.to_string_lossy().into_owned()]);
    }
    if let Some(file) = setting_path(root, &m.toolchains) {
        out.extend(["-t".to_owned(), file.to_string_lossy().into_owned()]);
    }
    if let Some(dir) = setting_path(root, &m.local_repository) {
        out.push(format!("-Dmaven.repo.local={}", dir.to_string_lossy()));
    }
    if let Some(threads) = m.thread_count() {
        out.extend(["-T".to_owned(), threads.to_owned()]);
    }
    if let Some(profiles) = non_empty(&m.active_profiles) {
        out.extend(["-P".to_owned(), profiles.to_owned()]);
    }
    out
}

fn maven_settings_prefixes(args: &[String]) -> Vec<usize> {
    let mut prefixes = vec![0];
    let mut i = 0;
    while i < args.len() {
        let Some(n) = maven_option_len(&args[i..]) else { break };
        i += n;
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
            .chain(saved.iter().cloned())
            .filter(|base| base.kind == "maven" && (id == base.id || id.starts_with(&format!("{}:", base.id))))
            .max_by_key(|base| base.id.len())
            .filter(|base| !saved.iter().any(|user| user.id == base.id));
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

pub(crate) fn merge(base: &mut Value, layer: Value) {
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

/// Explicit Gradle links constrain discovery and isolate JDT's persisted import state.
pub fn configure_gradle_import(
    cfg: &mut LanguageServerConfig,
    linked: Option<&[String]>,
    build_files: Option<&[String]>,
) {
    let Some(linked) = linked.filter(|_| cfg.name == "jdtls") else { return };
    merge_init_options(
        cfg,
        json!({
            "settings": {"java": {"import": {"gradle": {"enabled": !linked.is_empty()}}}},
            "projectConfigurations": build_files.unwrap_or_default()
        }),
    );
    if let Some(settings) = &mut cfg.settings {
        merge(settings, json!({"java": {"import": {"gradle": {"enabled": !linked.is_empty()}}}}));
    }
    if let Some(index) = cfg.args.iter().position(|arg| arg == "-data")
        && let Some(workspace) = cfg.args.get_mut(index + 1)
    {
        let mut hash = 0xcbf29ce484222325u64;
        for dir in linked {
            for byte in dir.bytes().chain([0]) {
                hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
            }
        }
        *workspace = format!("{workspace}-gradle-{hash:016x}");
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

/// Editor › Inspections › Java: "Serializable class without 'serialVersionUID'" (off by default,
/// as in IntelliJ IDEA). ECJ reports it, so it is a compiler option rather than a filter.
pub const SERIAL_VERSION_INSPECTION: &str = "java:missing-serial-version";

/// ECJ's level for a missing `serialVersionUID`, from the inspection profile in effect.
fn missing_serial_version(inspections: &InspectionSettings) -> Option<&'static str> {
    let o = inspections.active().get(SERIAL_VERSION_INSPECTION)?;
    if o.enabled != Some(true) {
        return None;
    }
    Some(match o.severity {
        Some(InspectionLevel::Error) => "error",
        None | Some(InspectionLevel::Warning) => "warning",
        Some(_) => "info",
    })
}

/// Workspace compiler defaults; Eclipse project preferences still take precedence.
/// Each variant has its own file, so changing an inspection restarts the server with it.
pub fn configure_java_compiler(cfg: &mut LanguageServerConfig, data_dir: &Path, inspections: &InspectionSettings) {
    configure_java_compiler_with_level(cfg, data_dir, inspections, None);
}

/// Like [`configure_java_compiler`], also applying the Project Structure Java language level
/// (`source`, `compliance`, `codegen.targetPlatform`) when configured.
pub fn configure_java_compiler_with_level(
    cfg: &mut LanguageServerConfig,
    data_dir: &Path,
    inspections: &InspectionSettings,
    language_level: Option<&str>,
) {
    const DEFAULTS: &str = "org.eclipse.jdt.core.compiler.problem.forbiddenReference=warning\n\
org.eclipse.jdt.core.compiler.problem.discouragedReference=warning\n";
    let serial = missing_serial_version(inspections);
    let normalized_level = language_level.map(str::trim).and_then(|l| match l {
        "8" | "1.8" => Some(("8", "1.8")),
        "11" => Some(("11", "11")),
        "17" => Some(("17", "17")),
        "21" => Some(("21", "21")),
        "25" => Some(("25", "25")),
        _ => None,
    });
    let mut stem = "compiler-defaults".to_owned();
    let mut content = DEFAULTS.to_owned();
    if let Some(level) = serial {
        stem.push_str(&format!("-serial-{level}"));
        content.push_str(&format!("org.eclipse.jdt.core.compiler.problem.missingSerialVersion={level}\n"));
    }
    if let Some((tag, jdt_ver)) = normalized_level {
        stem.push_str(&format!("-level-{tag}"));
        content.push_str(&format!(
            "org.eclipse.jdt.core.compiler.source={jdt_ver}\n\
org.eclipse.jdt.core.compiler.compliance={jdt_ver}\n\
org.eclipse.jdt.core.compiler.codegen.targetPlatform={jdt_ver}\n"
        ));
    }
    let name = format!("{stem}.prefs");
    let file = data_dir.join("lsp/jdtls").join(name);
    let write = || -> ide_core::IdeResult<()> {
        std::fs::create_dir_all(file.parent().expect("compiler preferences directory"))?;
        if std::fs::read_to_string(&file).ok().as_deref() != Some(content.as_str()) {
            ide_vfs::write_atomic(&file, content.as_bytes())?;
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

    if name == "ruff" {
        match ruff_configuration(root, &s.languages.ruff.configuration_directory) {
            Ok(Some(path)) => {
                let mut settings = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
                settings["configuration"] = json!(path.to_string_lossy());
                cfg.settings = Some(settings);
            }
            Ok(None) => {}
            Err(e) => cfg.launch_error = Some(e.message),
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
        // m2e resolves and downloads into `maven.repo.local`; without it the
        // embedded Maven falls back to ~/.m2 even when the IDE's own `mvn`
        // runs honor the configured local repository. A `-Dmaven.repo.local`
        // the user put in their own jdtls VM options wins.
        if let Some(repo) = maven_local_repository(root, s) {
            let arg = format!("-Dmaven.repo.local={}", repo.to_string_lossy());
            let taken = cfg.args.iter().enumerate().any(|(i, a)| {
                let value = a
                    .strip_prefix("--jvm-arg=")
                    .or_else(|| (i > 0 && cfg.args[i - 1] == "--jvm-arg").then_some(a.as_str()));
                value.is_some_and(|a| a.split('=').next() == Some("-Dmaven.repo.local"))
            });
            if !taken {
                cfg.args.push(format!("--jvm-arg={arg}"));
            }
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
        cfg.tsserver_project_extras.extensions = vec![vue::EXTENSION.into()];
    }
    if name == "vtsls"
        && cfg.tsserver_project
        && !server_root.ancestors().any(|d| d.join("tsconfig.json").is_file() || d.join("jsconfig.json").is_file())
    {
        let node = node_dir(root, s).map(|d| d.join(exe("node"))).filter(|p| p.is_file()).or_else(|| which("node"));
        cfg.tsserver_project_extras.paths = vue::cli_paths(server_root, node.as_deref());
    }
    if name == vue::SERVER {
        configure_vue_typescript(cfg, root, server_root, s);
    }

    // Intelephense reads it as `intelephense.environment.phpVersion` (`workspace/configuration`).
    if name == "intelephense"
        && let Some(level) = crate::php::language_level(root, s)
    {
        merge_init_options(cfg, json!({ "environment": { "phpVersion": level.version } }));
    }
    if name == "intelephense" {
        if let Some(stubs) = crate::php::intelephense_stubs(root, s) {
            merge_init_options(cfg, json!({ "stubs": stubs }));
        }
        let include_paths = crate::php::include_paths(root, s);
        if !include_paths.is_empty() {
            merge_init_options(cfg, json!({ "environment": { "includePaths": include_paths } }));
        }
    }

    // Node-based servers (`#!/usr/bin/env node`) run on the selected Node.js.
    if let Some(dir) = node_dir(root, s) {
        path_dirs.push(dir);
    }
    // PHP servers (phpactor, `php intelephense`-style wrappers) on the selected PHP.
    if let Some(dir) = php_dir(root, s) {
        path_dirs.push(dir);
    }

    // Gems install to the Ruby's bindir, which is not always on `PATH` (Homebrew).
    if name == "ruby-lsp"
        && let Some(ruby) = ruby_interpreter(root, s)
    {
        path_dirs.extend(crate::ruby::gem_bin_dirs(&ruby, server_root));
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
    if non_empty(&s.languages.ruff.configuration_directory).is_some() {
        for cfg in out.iter_mut().filter(|cfg| cfg.name == "ruff") {
            cfg.require_root_marker = false;
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
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        pinned: None,
        target: None,
        target_key: None,
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

fn maven_option_flag(arg: &str) -> Option<&'static str> {
    for (short, long) in
        [("-s", "--settings"), ("-t", "--toolchains"), ("-T", "--threads"), ("-P", "--activate-profiles")]
    {
        if arg.starts_with(short) || arg == long || arg.starts_with(&format!("{long}=")) {
            return Some(short);
        }
    }
    arg.starts_with("-Dmaven.repo.local=").then_some("-Dmaven.repo.local")
}

fn maven_option_len(args: &[String]) -> Option<usize> {
    let arg = args.first()?;
    maven_option_flag(arg)?;
    let separate = matches!(
        arg.as_str(),
        "-s" | "--settings" | "-t" | "--toolchains" | "-T" | "--threads" | "-P" | "--activate-profiles"
    );
    Some(if separate { 2.min(args.len()) } else { 1 })
}

/// [`maven_options`] grouped with each option's value.
fn maven_option_groups(options: &[String]) -> Vec<&[String]> {
    let mut groups = Vec::new();
    let mut i = 0;
    while i < options.len() {
        let n = maven_option_len(&options[i..]).unwrap_or(1);
        groups.push(&options[i..i + n]);
        i += n;
    }
    groups
}

/// Whether the configuration sets the same option, including attached and long forms.
fn sets_maven_option(args: &[String], group: &[String]) -> bool {
    let Some(flag) = group.first().and_then(|a| maven_option_flag(a)) else { return true };
    args.iter().any(|a| maven_option_flag(a) == Some(flag))
        || (flag == "-Dmaven.repo.local"
            && args.windows(2).any(|a| a[0] == "-D" && a[1].starts_with("maven.repo.local=")))
}

/// Settings options precede the goals. Tool-window checkbox profiles are additive;
/// profiles explicitly typed in the configuration replace the Settings profiles.
fn add_maven_options(args: &mut Vec<String>, options: &[String], additive_profiles: bool) {
    let missing: Vec<String> = maven_option_groups(options)
        .into_iter()
        .filter(|g| {
            if additive_profiles && g[0] == "-P" {
                !args.windows(g.len()).any(|w| w == *g)
            } else {
                !sets_maven_option(args, g)
            }
        })
        .flatten()
        .cloned()
        .collect();
    args.splice(0..0, missing);
}

/// The interpreter target or project default; an explicit local choice returns an empty id.
pub fn run_target<'a>(config: &RunConfig, settings: &'a Settings) -> Option<&'a str> {
    let name = ide_run::wrap::program_name(&config.command);
    let target = if matches!(name.as_str(), "php" | "composer" | "phpunit" | "pest")
        || matches!(config.kind.as_str(), "php" | "composer" | "phpunit")
    {
        &settings.languages.php.run_target
    } else if matches!(name.as_str(), "node" | "npm" | "npx" | "pnpm" | "yarn" | "bun")
        || matches!(config.kind.as_str(), "node" | "npm" | "vitest" | "jest" | "mocha")
    {
        &settings.languages.node.run_target
    } else {
        return non_empty(&settings.run.default_target);
    };
    if target == "local" {
        Some("")
    } else if target.is_empty() {
        non_empty(&settings.run.default_target)
    } else {
        Some(target)
    }
}

/// Points run configurations at the selected toolchains: Python configs use the
/// project interpreter, npm scripts the chosen package manager and Node.js,
/// cargo / go configs the selected toolchain, Maven / Gradle their runner JDK
/// (and Maven the configured home and options).
pub fn apply_to_run_configs(configs: &mut [RunConfig], root: &Path, s: &Settings) {
    let explicit_python = setting_path(root, &s.languages.python.interpreter);
    let pm = non_empty(&s.languages.node.package_manager);
    let php = setting_path(root, &s.languages.php.interpreter);
    let rust = rust_bin(root, s);
    let gopath = setting_path(root, &s.languages.go.gopath);
    let jdk = project_jdk(root, s);
    let mvn = maven_command(root, s);
    let mvn_options = maven_options(root, s);

    // Module-local toolchains, looked up once per owning module and only for the kinds using them.
    let mut toolchains: HashMap<(&'static str, PathBuf), Option<PathBuf>> = HashMap::new();
    let mut toolchain = |tool: &'static str, owner: &Path| {
        toolchains
            .entry((tool, owner.to_path_buf()))
            .or_insert_with(|| {
                // A module outside the project (an external linked build) keeps the project's choices.
                let near = if owner.starts_with(root) { owner } else { root };
                match tool {
                    "python" => python_interpreter_near(root, Some(near), s),
                    "node" if non_empty(&s.languages.node.interpreter).is_none() => {
                        node_dir(near, s).or_else(|| node_dir(root, s))
                    }
                    "node" => node_dir(root, s),
                    "go" if non_empty(&s.languages.go.goroot).is_none() => goroot(near, s).or_else(|| goroot(root, s)),
                    "go" => goroot(root, s),
                    _ => setting_path(root, &s.languages.ruby.interpreter).or_else(|| ruby_interpreter(near, s)),
                }
            })
            .clone()
    };

    for c in configs.iter_mut() {
        if let Some(pm) = pm
            && c.kind == "npm"
            && c.detected
            && matches!(c.command.as_str(), "npm" | "pnpm" | "yarn" | "bun")
        {
            c.command = pm.to_owned();
        }
        if c.extras.target.is_none() {
            c.extras.target = run_target(c, s).map(str::to_owned);
        }
        if c.extras.target.as_deref().is_some_and(|t| t.starts_with("plugin-target:")) {
            continue;
        }
        let owner = ide_run::scope::owner(root, c);
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
                let python = toolchain("python", &owner);
                if let Some(venv) = python.as_deref().and_then(venv_of)
                    && !c.env.contains_key("VIRTUAL_ENV")
                {
                    c.env.insert("VIRTUAL_ENV".into(), venv.to_string_lossy().into_owned());
                    path_dirs.push(venv.join(bin_dir()));
                }
            }
            "npm" | "node" | "deno" | "bun" => {
                // The configuration's own Node interpreter, else the project's.
                let own = c.extras.params.get("nodeInterpreter").and_then(|p| setting_path(root, p));
                if let Some(dir) =
                    own.and_then(|p| p.parent().map(Path::to_path_buf)).or_else(|| toolchain("node", &owner))
                {
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
                if let Some(goroot) = &toolchain("go", &owner) {
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
                for (key, value) in gradle_build_env(root, &build_dir, &c.command, s, None) {
                    c.env.entry(key).or_insert(value);
                }
            }
            "ruby" | "rake" | "rspec" => {
                if let Some(ruby) = &toolchain("ruby", &owner)
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
            "tomcat" => {
                if let Some(jdk) = &jdk {
                    c.env.entry("JAVA_HOME".into()).or_insert_with(|| jdk.home.to_string_lossy().into_owned());
                }
            }
            "maven" => {
                for (key, value) in maven_build_env(root, s, None) {
                    c.env.entry(key).or_insert(value);
                }
                if let Some(mvn) = &mvn
                    && (c.detected
                        || generated_maven_goal(c)
                        || matches!(c.command.as_str(), "mvn" | "mvn.cmd" | "mvn.bat"))
                {
                    c.command = mvn.to_string_lossy().into_owned();
                }
                let additive_profiles = generated_maven_goal(c)
                    && c.id.split_once(".xml:").is_some_and(|(_, goals)| {
                        !goals.split_whitespace().any(|a| maven_option_flag(a) == Some("-P"))
                    });
                add_maven_options(&mut c.args, &mvn_options, additive_profiles);
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
    if out.extras.target.as_deref() == run_target(&out, s) {
        out.extras.target = None;
    }
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
    fn serial_version_inspection_sets_the_compiler_option() {
        let tmp = tempfile::tempdir().unwrap();
        let url = |inspections: &InspectionSettings| {
            let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
            configure_java_compiler(&mut cfg, tmp.path(), inspections);
            options(&cfg).pointer("/settings/java/settings/url").unwrap().as_str().unwrap().to_owned()
        };
        let set = |o: ide_core::settings::InspectionOverride| {
            let mut s = InspectionSettings::default();
            s.default.insert(SERIAL_VERSION_INSPECTION.into(), o);
            s
        };
        let off = url(&InspectionSettings::default());
        assert!(!std::fs::read_to_string(&off).unwrap().contains("missingSerialVersion"));
        let on = url(&set(ide_core::settings::InspectionOverride { enabled: Some(true), ..Default::default() }));
        assert_ne!(on, off, "a new file, so the server restarts with it");
        assert!(std::fs::read_to_string(&on).unwrap().ends_with("compiler.problem.missingSerialVersion=warning\n"));
        let error = url(&set(ide_core::settings::InspectionOverride {
            enabled: Some(true),
            severity: Some(InspectionLevel::Error),
            ..Default::default()
        }));
        assert!(std::fs::read_to_string(error).unwrap().ends_with("missingSerialVersion=error\n"));
        let weak = url(&set(ide_core::settings::InspectionOverride {
            enabled: Some(true),
            severity: Some(InspectionLevel::WeakWarning),
            ..Default::default()
        }));
        assert!(std::fs::read_to_string(weak).unwrap().ends_with("missingSerialVersion=info\n"));
        let severity_only = url(&set(ide_core::settings::InspectionOverride {
            severity: Some(InspectionLevel::Error),
            ..Default::default()
        }));
        assert_eq!(severity_only, off, "off by default");
    }

    #[test]
    fn compiler_defaults_live_in_the_cache_and_preserve_other_options() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache with spaces 测试");
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        merge_init_options(&mut cfg, json!({"settings": {"java": {"format": {"tabSize": 4}}}}));
        configure_java_compiler(&mut cfg, &cache, &InspectionSettings::default());
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
        configure_java_compiler(&mut cfg, &cache, &InspectionSettings::default());
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), modified);
        assert_eq!(self::options(&cfg), options);
    }

    #[test]
    fn explicit_compiler_settings_keep_priority() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        merge_init_options(&mut cfg, json!({"settings": {"java": {"settings": {"url": "own.prefs"}}}}));
        configure_java_compiler(&mut cfg, tmp.path(), &InspectionSettings::default());
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
mod gradle_runtime_tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn gradle_runs_use_the_builds_toolchain_without_overriding_user_choices() {
        let temp = tempfile::tempdir().unwrap();
        let installed =
            [25, 21, 17, 11, 8].map(|major| crate::java::Jdk { major, home: temp.path().join(format!("jdk{major}")) });
        for (name, script, expected) in [
            ("kotlin", "kotlin { jvmToolchain(21) }", Some(21)),
            ("java", "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }", Some(17)),
            ("unspecified", "plugins { id 'java' }", None),
        ] {
            let dir = temp.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("build.gradle.kts"), script).unwrap();
            let picked = gradle_run_jdk(crate::java::project_java_version(&dir), None, &installed, Some((9, 0)));
            assert_eq!(picked.map(|jdk| jdk.major), expected);
            assert_eq!(gradle_run_jdk(expected, Some(&installed[0]), &installed, Some((9, 0))), Some(&installed[0]));
            let mut settings = Settings::default();
            settings.languages.java.gradle.jvm = "custom-gradle-jdk".into();
            let env = gradle_env(temp.path(), &settings, BTreeMap::from([("JAVA_HOME".into(), "/fallback".into())]));
            assert_eq!(env["JAVA_HOME"], temp.path().join("custom-gradle-jdk").to_string_lossy());
        }
        let dir = temp.path().join("kotlin");
        for (gradle, target, expected) in
            [((9, 0), 8, 17), ((8, 4), 21, 17), ((8, 5), 21, 21), ((7, 2), 21, 11), ((9, 0), 25, 21), ((9, 1), 25, 25)]
        {
            std::fs::write(dir.join("build.gradle.kts"), format!("kotlin {{ jvmToolchain({target}) }}")).unwrap();
            assert_eq!(gradle_run_jdk(Some(target), None, &installed, Some(gradle)).unwrap().major, expected);
        }
        assert_eq!(gradle_run_jdk(Some(21), None, &installed, None).unwrap().major, 21);
        assert_eq!(gradle_run_jdk(Some(19), None, &installed, None).unwrap().major, 21);
        assert!(gradle_run_jdk(None, None, &installed, None).is_none());
    }

    #[test]
    fn reads_wrapper_and_local_gradle_versions_without_running_them() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("gradle/wrapper")).unwrap();
        std::fs::write(
            root.join("gradle/wrapper/gradle-wrapper.properties"),
            "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4.0-bin.zip\n",
        )
        .unwrap();
        for command in ["./gradlew", "gradlew.bat"] {
            assert_eq!(gradle_distribution_version(root, command), Some((8, 4)));
        }
        for layout in ["lib", "libexec/lib"] {
            let home = root.join(layout.replace('/', "-"));
            std::fs::create_dir_all(home.join("bin")).unwrap();
            std::fs::create_dir_all(home.join(layout)).unwrap();
            let command = home.join("bin/gradle");
            std::fs::write(&command, "").unwrap();
            std::fs::write(home.join(layout).join("gradle-launcher-9.0.0.jar"), "").unwrap();
            assert_eq!(gradle_distribution_version(root, &command.to_string_lossy()), Some((9, 0)));
        }
    }
}

#[cfg(test)]
mod maven_linkage_tests {
    use super::*;

    #[test]
    fn explicit_gradle_links_scope_jdt_import_and_unlink_all_disables_gradle() {
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        cfg.args = vec!["-data".into(), "/cache/jdtls".into()];
        let files = ["file:///p/a/settings.gradle".to_owned(), "file:///p/maven/pom.xml".to_owned()];
        configure_gradle_import(&mut cfg, Some(&["a".into()]), Some(&files));
        let options = serde_json::to_value(&cfg.initialization_options).unwrap();
        assert_eq!(options["projectConfigurations"], json!(files));
        assert_eq!(options.pointer("/settings/java/import/gradle/enabled"), Some(&json!(true)));
        assert!(cfg.args[1].starts_with("/cache/jdtls-gradle-"));
        let linked_cache = cfg.args[1].clone();
        cfg.args[1] = "/cache/jdtls".into();
        configure_gradle_import(&mut cfg, Some(&[]), Some(&files[1..]));
        let options = serde_json::to_value(&cfg.initialization_options).unwrap();
        assert_eq!(options["projectConfigurations"], json!(&files[1..]));
        assert_eq!(options.pointer("/settings/java/import/gradle/enabled"), Some(&json!(false)));
        assert_ne!(linked_cache, cfg.args[1]);
    }

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

#[cfg(all(test, unix))]
mod ruby_lsp_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn ruby_lsp_is_found_in_the_rubys_gem_bindir_when_that_is_off_path() {
        let tmp = tempfile::tempdir().unwrap();
        let bindir = tmp.path().join("gems/bin");
        std::fs::create_dir_all(&bindir).unwrap();
        // Homebrew's Ruby: `Gem.bindir` is not on `PATH`.
        let ruby = tmp.path().join("ruby");
        std::fs::write(&ruby, format!("#!/bin/sh\necho '{}'\necho '/nonexistent/user/bin'\n", bindir.display()))
            .unwrap();
        std::fs::set_permissions(&ruby, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut s = Settings::default();
        s.languages.ruby.interpreter = ruby.to_string_lossy().into_owned();
        let mut cfg = custom_server("ruby-lsp", &LanguageServerSettings::default());
        configure_server(&mut cfg, tmp.path(), tmp.path(), &s);
        let path = cfg.env.get("PATH").expect("PATH set");
        let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
        assert!(dirs.contains(&bindir), "{dirs:?}");
        assert!(!dirs.iter().any(|d| d.starts_with("/nonexistent")), "{dirs:?}");
    }
}
