//! Applying the selected interpreters / toolchains (`languages.*` settings) to
//! language servers, run configurations and terminals.

use crate::discover::{project_venv_python, workspace_tsdk};
use crate::exec::{path_with, search_path, which};
use crate::npm::{has_ts_api, native_typescript, own_typescript};
use crate::{angular, astro, godot, pinned, vue};
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

/// Whether the TOML `file` has the dotted `table` (`tool.ruff`).
pub fn toml_has_table(file: &Path, table: &str) -> bool {
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
/// root, else the project's Pipenv environment, else its `default` Hatch environment,
/// else the Python the project pins for mise / asdf. A configured interpreter whose executable is gone (uninstalled,
/// moved) is skipped like PyCharm's "Invalid" SDKs, so runs fall back instead of
/// failing on a dead path.
/// `None` when the project interpreter is a run target's (see [`crate::container_python`]).
pub fn python_interpreter(root: &Path, s: &Settings) -> Option<PathBuf> {
    if s.languages.python.run_target().is_some() {
        return None;
    }
    setting_path(root, &s.languages.python.interpreter)
        .filter(|p| p.is_file())
        .or_else(|| project_venv_python(root))
        .or_else(|| pinned::pinned_python(root))
}

/// An absolute or `~/` path from the settings; `None` for anything else.
pub fn absolute_setting_path(s: &str) -> Option<PathBuf> {
    setting_path(Path::new(""), s).filter(|p| p.is_absolute())
}

/// Why a folder added to an interpreter's paths stays off the import path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum UserPathProblem {
    /// Not an existing folder.
    Missing,
    /// Not absolute or `~/`, or it holds the separator of `PYTHONPATH`.
    Invalid,
}

/// A folder added to an interpreter's paths (All Interpreters › Show Paths), as it goes on the
/// import path.
pub fn user_path(s: &str) -> Result<PathBuf, UserPathProblem> {
    let path = absolute_setting_path(s).ok_or(UserPathProblem::Invalid)?;
    // `PYTHONPATH` cannot hold a path with its separator in it: joining would fail every launch.
    if std::env::join_paths([&path]).is_err() {
        return Err(UserPathProblem::Invalid);
    }
    if !path.is_dir() {
        return Err(UserPathProblem::Missing);
    }
    Ok(path)
}

/// Whether the settings key `key` names the interpreter `python`. Paths are compared as
/// written, not through symlinks: a virtualenv's `python` links to its base interpreter, and
/// the two are different interpreters.
fn names_interpreter(key: &str, python: &Path) -> bool {
    let Some(key) = absolute_setting_path(key) else { return false };
    if cfg!(windows) {
        let fold = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
        fold(&key) == fold(python)
    } else {
        key == python
    }
}

/// The folders the user added to `python`'s paths that can be imported from.
pub fn interpreter_user_paths(python: &Path, s: &Settings) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for (interpreter, paths) in &s.languages.python.interpreter_paths {
        if !names_interpreter(interpreter, python) {
            continue;
        }
        for path in paths.iter().filter_map(|p| user_path(p).ok()) {
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// The interpreter a Python language server started for `server_root` analyses with: that
/// folder's own virtualenv unless an interpreter is configured, else the project interpreter.
pub fn python_server_interpreter(root: &Path, server_root: &Path, s: &Settings) -> Option<PathBuf> {
    project_venv_python(server_root)
        .filter(|_| non_empty(&s.languages.python.interpreter).is_none())
        .or_else(|| python_interpreter(root, s))
}

/// An explicit project interpreter wins; otherwise use the closest virtualenv to the file.
pub fn python_interpreter_near(root: &Path, near: Option<&Path>, s: &Settings) -> Option<PathBuf> {
    if s.languages.python.run_target().is_some() {
        return None;
    }
    if let Some(python) = setting_path(root, &s.languages.python.interpreter).filter(|p| p.is_file()) {
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

/// The directory of the configured Zig install (holding `zig`), else `None` for `PATH`.
pub(crate) fn zig_bin(root: &Path, s: &Settings) -> Option<PathBuf> {
    setting_path(root, &s.languages.zig.zig)
        .map(|p| if p.is_file() { p.parent().map(Path::to_path_buf).unwrap_or(p) } else { p })
}

/// Runtime choices for package-manager based IDE tool installs.
#[derive(Default)]
pub struct ToolInstallEnvironment {
    pub commands: std::collections::BTreeMap<String, PathBuf>,
    pub env: std::collections::BTreeMap<String, String>,
}

/// Uses the same configured / project-pinned SDKs as Run and language servers.
/// Build tags and target OS settings intentionally do not apply to host tools.
pub fn tool_install_environment(root: &Path, s: &Settings) -> ToolInstallEnvironment {
    let mut runtime = ToolInstallEnvironment::default();
    if let Some(go) = goroot(root, s) {
        runtime.commands.insert("go".into(), go.join("bin").join(exe("go")));
        runtime.env.insert("GOROOT".into(), go.to_string_lossy().into_owned());
    }
    if let Some(node) = node_dir(root, s) {
        let node = setting_path(root, &s.languages.node.interpreter).unwrap_or_else(|| node.join(exe("node")));
        runtime.commands.insert("node".into(), node);
    }
    if let Some(ruby) = ruby_interpreter(root, s) {
        runtime.commands.insert("ruby".into(), ruby);
    }
    if let Some(python) = python_interpreter(root, s) {
        runtime.commands.insert("python".into(), python);
    }
    runtime
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
        // `gradlew` can't start without its jar, which `.gitignore`s with `*.jar` often leave
        // out: run the distribution the wrapper already unpacked instead.
        if build_dir.join("gradle/wrapper/gradle-wrapper.jar").is_file() {
            return wrapper;
        }
        let home = setting_path(root, &g.user_home)
            .or_else(|| std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from))
            .or_else(|| Some(crate::home_dir()?.join(".gradle")));
        if let Some(gradle) = home.and_then(|home| unpacked_wrapper_distribution(build_dir, &home)) {
            return gradle;
        }
        // Nothing to run instead: the wrapper's failure explains what is missing.
        return wrapper;
    }
    pinned::pinned_install(build_dir, Tool::Gradle)
        .map(|(home, _)| home.join("bin").join(name))
        .unwrap_or_else(|| name.into())
}

/// `bin/gradle` of the distribution `gradle/wrapper/gradle-wrapper.properties` names, once the
/// wrapper has unpacked it in `<gradle_user_home>/wrapper/dists` (and marked it complete).
fn unpacked_wrapper_distribution(build_dir: &Path, gradle_user_home: &Path) -> Option<PathBuf> {
    let properties = std::fs::read_to_string(build_dir.join("gradle/wrapper/gradle-wrapper.properties")).ok()?;
    let url = properties.lines().find_map(|line| line.trim().strip_prefix("distributionUrl="))?;
    let zip = url.trim().replace("\\:", ":").rsplit('/').next()?.to_owned();
    let name = zip.strip_suffix(".zip")?;
    let gradle = if cfg!(windows) { "gradle.bat" } else { "gradle" };
    // One directory per distribution URL hash, each holding the unpacked `gradle-<version>`.
    let hashes = std::fs::read_dir(gradle_user_home.join("wrapper/dists").join(name)).ok()?;
    hashes.flatten().map(|e| e.path()).filter(|dir| dir.join(format!("{zip}.ok")).is_file()).find_map(|dir| {
        std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path().join("bin").join(gradle)).find(|p| p.is_file())
    })
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

/// The newest installed JDK that Gradle `gradle` runs on.
fn newest_gradle_jdk(gradle: (u32, u32), installed: &[crate::java::Jdk]) -> Option<&crate::java::Jdk> {
    installed.iter().filter(|jdk| gradle_supports_java(gradle, jdk.major)).max_by_key(|jdk| jdk.major)
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

/// Settings › Build Tools › Gradle → jdtls `java.import.gradle.*`: the Java import of the Gradle
/// build in `build_dir` runs the same Gradle installation, user home and JVM as the IDE's own
/// Gradle runs ([`gradle_build_env`]: Gradle JVM, else the Project JDK, else an installed JDK
/// this Gradle version runs on). Without it a project that ships no wrapper is never imported,
/// one whose caches live in a configured user home resolves no dependencies, and an older Gradle
/// fails on the JDK jdtls itself runs on. The wrapper stays jdtls's default unless a local
/// distribution is chosen.
pub fn configure_gradle_runtime(cfg: &mut LanguageServerConfig, root: &Path, build_dir: &Path, s: &Settings) {
    if cfg.name != "jdtls" {
        return;
    }
    let g = &s.languages.java.gradle;
    let mut gradle = serde_json::Map::new();
    if g.distribution == ide_core::settings::GradleDistribution::Local
        && let Some(home) = setting_path(root, &g.home)
    {
        gradle.insert("home".into(), json!(home.to_string_lossy()));
        gradle.insert("wrapper".into(), json!({"enabled": false}));
    }
    let gradle_build = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"]
        .iter()
        .any(|f| build_dir.join(f).is_file());
    let env = if gradle_build {
        let command = gradle_command(root, build_dir, s);
        let command = command.to_string_lossy();
        let mut env = gradle_build_env(root, build_dir, &command, s, None);
        // No Project JDK and no Java version the build declares: jdtls would import on its own
        // runtime, which an older Gradle cannot run on. Use an installed JDK this Gradle supports.
        if !env.contains_key("JAVA_HOME")
            && let Some(gradle) = gradle_distribution_version(build_dir, &command)
            && let Some(jdk) = newest_gradle_jdk(gradle, &crate::java::installed_jdks())
        {
            env.insert("JAVA_HOME".into(), jdk.home.to_string_lossy().into_owned());
        }
        env
    } else {
        gradle_env(root, s, Default::default())
    };
    if let Some(home) = env.get("GRADLE_USER_HOME") {
        gradle.insert("user".into(), json!({"home": home}));
    }
    if let Some(home) = env.get("JAVA_HOME") {
        gradle.insert("java".into(), json!({"home": home}));
    }
    if gradle.is_empty() {
        return;
    }
    merge(cfg.settings.get_or_insert_with(|| json!({})), json!({"java": {"import": {"gradle": gradle}}}));
}

/// Gradle's Eclipse model, which jdtls imports the build through, leaves out project dependencies
/// a source set only compiles against (`compileOnly(project(":a"))`) and marks some as test-only,
/// so their classes don't resolve in the editor although Gradle compiles. jdtls's Gradle import
/// runs an init script that adds them, written to the first of `dirs` whose path has no
/// whitespace: Buildship stores the import's arguments joined by spaces and splits them again,
/// so `Application Support` would break the path. The name carries the script's hash, so
/// releases running side by side never overwrite each other's script.
pub fn configure_gradle_classpath(cfg: &mut LanguageServerConfig, dirs: &[PathBuf]) {
    const SCRIPT: &str = include_str!("gradle-classpath.init.gradle");
    if cfg.name != "jdtls" {
        return;
    }
    let mut hash = 0xcbf29ce484222325u64;
    for byte in SCRIPT.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let name = format!("openidea-classpath-{hash:016x}.init.gradle");
    let Some(script) = dirs
        .iter()
        .map(|dir| dir.join(&name))
        .filter(|script| !script.to_string_lossy().contains(char::is_whitespace))
        .find(|script| {
            std::fs::read(script).ok().as_deref() == Some(SCRIPT.as_bytes())
                || script.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
                    && std::fs::write(script, SCRIPT).is_ok()
        })
    else {
        tracing::warn!("no directory without spaces for the Gradle classpath init script: {dirs:?}");
        return;
    };
    merge(
        cfg.settings.get_or_insert_with(|| json!({})),
        json!({"java": {"import": {"gradle": {"arguments": ["--init-script", script.to_string_lossy()]}}}}),
    );
}

/// Settings › Build Tools › Maven › Automatically download sources and Always update
/// snapshots → jdtls `java.maven.downloadSources` / `java.maven.updateSnapshots`.
pub fn configure_maven_sources(cfg: &mut LanguageServerConfig, s: &Settings) {
    if cfg.name != "jdtls" {
        return;
    }
    let m = &s.languages.java.maven;
    merge(
        cfg.settings.get_or_insert_with(|| json!({})),
        json!({"java": {"maven": {"downloadSources": m.download_sources, "updateSnapshots": m.update_snapshots}}}),
    );
}

/// Maven options from settings, placed before the goals: `-s <settings.xml>`,
/// `-t <toolchains.xml>`, `-Dmaven.repo.local=<dir>`, `-T <count>`, `-P <profiles>` and `-U`.
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
    if m.update_snapshots {
        out.push("-U".to_owned());
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
        let home = crate::home_dir().unwrap_or_default();
        settings_local_repository(&setting_path(root, &m.user_settings)?, &home)
    })
}

/// The local repository a plain `mvn` uses when nothing is configured: `<localRepository>` of
/// `~/.m2/settings.xml`, else `~/.m2/repository`.
pub fn default_maven_repository() -> Option<PathBuf> {
    default_maven_repository_in(&crate::home_dir()?)
}

pub(crate) fn default_maven_repository_in(home: &Path) -> Option<PathBuf> {
    let m2 = home.join(".m2");
    Some(settings_local_repository(&m2.join("settings.xml"), home).unwrap_or_else(|| m2.join("repository")))
}

/// `<localRepository>` of a Maven `settings.xml`, with `${user.home}` expanded.
fn settings_local_repository(file: &Path, home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(file).ok()?;
    let repo = crate::java::xml_value(&crate::lombok::strip_xml_comments(&text), "localRepository")?;
    let repo = repo.replace("${user.home}", &home.to_string_lossy());
    (!repo.is_empty() && !repo.contains("${")).then(|| PathBuf::from(repo))
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `settings_xml` with `<localRepository>` set to `repo`: an existing one is replaced, else
/// one goes right after the `<settings>` open tag. `None` without a `<settings>` element.
pub(crate) fn with_local_repository(settings_xml: &str, repo: &str) -> Option<String> {
    use crate::maven_profiles::{find_tag, mask_comments};
    let masked = mask_comments(settings_xml);
    let element = format!("<localRepository>{}</localRepository>", xml_escape(repo));
    if let Some(start) = find_tag(&masked, "<localRepository", 0) {
        let open_end = start + masked[start..].find('>')?;
        let end = if masked[..open_end].ends_with('/') {
            open_end + 1
        } else {
            let close = open_end + masked[open_end..].find("</localRepository")?;
            close + masked[close..].find('>')? + 1
        };
        return Some(format!("{}{element}{}", &settings_xml[..start], &settings_xml[end..]));
    }
    let start = find_tag(&masked, "<settings", 0)?;
    let end = start + masked[start..].find('>')?;
    if masked[..end].ends_with('/') {
        return None;
    }
    Some(format!("{}{element}{}", &settings_xml[..=end], &settings_xml[end + 1..]))
}

/// The user settings m2e (the JDTLS Maven import) reads, as a file and its text: the
/// configured `settings.xml`, else `~/.m2/settings.xml`, with the configured local
/// repository as its `<localRepository>`. m2e reads mirrors, servers and the local
/// repository from this file only, never from `-Dmaven.repo.local`, which is how the IDE's
/// own `mvn` runs get the configured repository (#1739). The file is `None` when there is none.
pub(crate) fn m2e_user_settings(root: &Path, s: &Settings, home: &Path) -> (Option<PathBuf>, String) {
    let m = &s.languages.java.maven;
    let file = setting_path(root, &m.user_settings)
        .or_else(|| Some(home.join(".m2").join("settings.xml")).filter(|f| f.is_file()));
    let text = file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .unwrap_or_else(|| "<settings>\n</settings>\n".into());
    match setting_path(root, &m.local_repository) {
        Some(repo) => {
            let merged = with_local_repository(&text, &repo.to_string_lossy());
            (file, merged.unwrap_or(text))
        }
        None => (file, text),
    }
}

fn write_m2e_settings(root: &Path, text: &str) -> Option<PathBuf> {
    let file = ide_core::project_dir::path(root, "maven-settings.xml");
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    match std::fs::read_to_string(&file) {
        Ok(existing) if existing == text => {}
        _ => std::fs::write(&file, text).ok()?,
    }
    Some(file)
}

/// The user settings file m2e should read (see [`m2e_user_settings`]): the configured
/// `settings.xml` as it is when no local repository is configured or it already names that
/// one, else a derived copy under `<root>/.openidea/`. `None` = m2e's default applies.
pub fn maven_user_settings_for_m2e(root: &Path, s: &Settings) -> Option<PathBuf> {
    maven_user_settings_for_m2e_in(root, s, &crate::home_dir().unwrap_or_default())
}

pub(crate) fn maven_user_settings_for_m2e_in(root: &Path, s: &Settings, home: &Path) -> Option<PathBuf> {
    let m = &s.languages.java.maven;
    let configured = setting_path(root, &m.user_settings);
    setting_path(root, &m.local_repository)?;
    let (file, text) = m2e_user_settings(root, s, home);
    if file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).is_some_and(|original| original == text) {
        return file;
    }
    write_m2e_settings(root, &text).or(configured)
}

/// `conf/settings.xml` of the Maven installation the IDE's `mvn` runs use (Settings ›
/// Maven home, a version manager's pin, else `mvn` on `PATH`; none with a project wrapper):
/// `mvn` reads its mirrors and repositories as global settings, m2e only when told to.
pub fn maven_global_settings(root: &Path, s: &Settings) -> Option<PathBuf> {
    let mvn = match maven_command(root, s) {
        Some(mvn) => mvn,
        None if root.join("mvnw").is_file() || root.join("mvnw.cmd").is_file() => return None,
        None => crate::exec::which("mvn")?,
    };
    let mvn = dunce::canonicalize(&mvn).unwrap_or(mvn);
    let file = mvn.parent()?.parent()?.join("conf").join("settings.xml");
    file.is_file().then_some(file)
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

/// TypeScript 7's native executable when the selected TypeScript is one (see
/// [`native_typescript`]); `None` for the bundled one and TypeScript 6 and older.
pub fn native_tsdk(root: &Path, s: &Settings) -> Option<PathBuf> {
    match s.languages.typescript.version.trim() {
        "" | "bundled" => None,
        "workspace" => native_typescript(&root.join("node_modules/typescript")),
        custom => native_typescript(&setting_path(root, custom)?),
    }
}

const PYTHON_SERVERS: [&str; 8] =
    ["basedpyright", "pyright", "ty", "pyrefly", "pylsp", "jedi-language-server", "ruff", "djlsp"];

pub fn merge(base: &mut Value, layer: Value) {
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

/// Excludes project-relative Maven POM paths and the project's excluded folders (everything
/// below them, such as checkouts in `.worktrees`) from JDTLS import, preserving user exclusions.
/// `build_files` (`file:` URIs), when given, are the only build files jdtls imports: the
/// exclusions cannot leave out a module of a reactor jdtls imports.
pub fn configure_maven_import(
    cfg: &mut LanguageServerConfig,
    root: &Path,
    excluded_poms: &[PathBuf],
    excluded_folders: &[String],
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
    // Java NIO glob syntax treats these characters specially even in literal paths.
    let glob = |directory: &Path| -> String {
        let directory = directory.to_string_lossy().replace('\\', "/");
        directory.chars().flat_map(|c| if "*?[]{}\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect()
    };
    for pom in excluded_poms {
        exclusions.push(json!(glob(root.join(pom).parent().unwrap_or(root))));
    }
    // Builds below an excluded folder repeat the coordinates of the project's own builds (a
    // checkout of the same repository) and would take their place: one project per name.
    for folder in excluded_folders.iter().map(|f| f.trim_matches('/')).filter(|f| !f.is_empty()) {
        let folder = glob(&root.join(folder));
        exclusions.push(json!(format!("{folder}/**")));
        exclusions.push(json!(folder));
    }
    if !excluded_poms.is_empty() || !excluded_folders.is_empty() {
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
            let excluded = excluded_poms.iter().map(|pom| pom.to_string_lossy()).chain(
                // Folders hash apart from POMs of the same name; projects without excluded
                // folders keep the workspace their unlinked POMs already had.
                excluded_folders.iter().map(|f| format!("folder:{f}").into()),
            );
            for path in excluded {
                for byte in path.bytes().chain([0]) {
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

/// The settings section a Python type checker reads its analysis settings from:
/// basedpyright uses its own section, Pyright the `python` one. `None` for servers
/// that have no `analysis.extraPaths` (ty, pyrefly, Ruff, pylsp, …).
fn python_analysis_section(name: &str) -> Option<&'static str> {
    match name {
        "basedpyright" => Some("basedpyright"),
        "pyright" => Some("python"),
        _ => None,
    }
}

/// Adds attached dependency roots to basedpyright/Pyright's `analysis.extraPaths`, so
/// imports into projects configured in Project Structure › Dependencies resolve in the
/// editor too — not just in the IDE's own index/navigation.
///
/// Existing paths (from the user's `pyrightconfig.json` / `[tool.basedpyright]`, or a
/// container run target) are kept first and de-duplicated: `merge` replaces arrays
/// wholesale, so it cannot be used here. Paths are IPC-style (`/`-separated) to match
/// the container snapshot's `extraPaths`.
pub fn configure_python_extra_paths(cfg: &mut LanguageServerConfig, roots: &[PathBuf]) {
    let Some(section) = python_analysis_section(&cfg.name) else { return };
    if roots.is_empty() {
        return;
    }
    let mut current =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| json!({}));
    let mut node = &mut current;
    for key in ["settings", section, "analysis"] {
        node = object_entry(node, key);
    }
    let analysis = node.as_object_mut().expect("made an object above").entry("extraPaths").or_insert_with(|| json!([]));
    let mut paths: Vec<String> = analysis
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    for root in roots {
        let path = ide_core::ipc_path::to_ipc(root);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    *analysis = json!(paths);
    match toml::Value::try_from(current) {
        Ok(v) => cfg.initialization_options = Some(v),
        Err(e) => tracing::warn!("{}: cannot add extraPaths to initialization options: {e}", cfg.name),
    }
}

/// `value[key]`, made an empty object when it is missing or not an object; `value` too.
fn object_entry<'a>(value: &'a mut Value, key: &str) -> &'a mut Value {
    if !value.is_object() {
        *value = json!({});
    }
    let entry = value.as_object_mut().expect("made an object above").entry(key).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry
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

/// A Java language level as (file-name tag, JDT compliance value): `6` / `1.6` → `("6", "1.6")`,
/// `17` → `("17", "17")`. Levels 5–8 use JDT's `1.x` spelling; unknown values are ignored.
fn java_compliance(level: &str) -> Option<(String, String)> {
    let level = level.trim();
    let major: u32 = level.strip_prefix("1.").unwrap_or(level).parse().ok()?;
    match major {
        5..=8 => Some((major.to_string(), format!("1.{major}"))),
        9..=99 if !level.starts_with("1.") => Some((major.to_string(), major.to_string())),
        _ => None,
    }
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
    let normalized_level = language_level.and_then(java_compliance);
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
    // A `file:` URI: jdtls parses the setting as a URI when matching watched-file
    // changes, which fails on a bare path with spaces. Explicit server settings win later.
    let url = url::Url::from_file_path(&file).map_or_else(|()| file.to_string_lossy().into_owned(), String::from);
    let defaults = json!({"settings": {"java": {"settings": {"url": url}}}});
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
    custom.or_else(|| flutter_sdk_tool(root, s, command))
}

/// `flutter` / `dart` of the Flutter SDK in Settings › Languages & Frameworks › Flutter, else
/// `None` (the search path). Dart is the SDK's own (`bin/cache/dart-sdk`), else its `bin/dart`
/// wrapper, which downloads it on first use.
pub fn flutter_sdk_tool(root: &Path, s: &Settings, command: &str) -> Option<PathBuf> {
    let bin = setting_path(root, &s.languages.flutter.sdk)?.join("bin");
    let script = |name: &str| bin.join(if cfg!(windows) { format!("{name}.bat") } else { name.to_owned() });
    match command {
        "flutter" => Some(script("flutter")),
        "dart" => Some(
            Some(bin.join("cache/dart-sdk/bin").join(exe("dart")))
                .filter(|d| d.is_file())
                .unwrap_or_else(|| script("dart")),
        ),
        _ => None,
    }
}

/// Points a run configuration launching a bare tool name at the executable from
/// [`tool_command`] (Godot apps live outside the search path; `flutter` / `dart` follow the
/// Flutter SDK setting).
pub fn resolve_run_command(config: &mut RunConfig, root: &Path, s: &Settings) {
    if matches!(config.command.as_str(), godot::COMMAND | "flutter" | "dart")
        && let Some(path) = tool_command(root, s, &config.command)
    {
        config.command = path.to_string_lossy().into_owned();
    }
}

/// The environment folder holding `python` (`<env>/bin/python`, `<env>/Scripts/python.exe`):
/// a virtualenv, or a conda or pixi environment.
fn environment_of(python: &Path) -> Option<PathBuf> {
    venv_of(python).or_else(|| {
        let bin = python.parent()?;
        let env = bin.parent()?;
        matches!(bin.file_name()?.to_str()?, "bin" | "Scripts").then(|| env.to_path_buf())
    })
}

pub fn configure_server(cfg: &mut LanguageServerConfig, root: &Path, server_root: &Path, s: &Settings) {
    let mut path_dirs: Vec<PathBuf> = Vec::new();
    if let Some(custom) = tool_command(root, s, &cfg.command) {
        // An executable chosen from a Node.js installation (`~/.nvm/versions/node/v26/bin/tsc`,
        // its `npx`) runs on that Node: its `#!/usr/bin/env node` finds the `node` beside it.
        if let Some(bin) = custom.parent().filter(|bin| bin.join(exe("node")).is_file()) {
            path_dirs.push(bin.to_path_buf());
        }
        cfg.command = custom.to_string_lossy().into_owned();
    }
    // `java -jar` servers run on the project JDK when there is one, like JAR Application runs.
    if cfg.command == "java"
        && let Some(java) =
            project_jdk(root, s).map(|jdk| crate::java::java_executable(&jdk.home)).filter(|j| j.is_file())
    {
        cfg.command = java.to_string_lossy().into_owned();
    }
    let name = cfg.name.clone();
    let name = name.as_str();

    if PYTHON_SERVERS.contains(&name) {
        let python = python_server_interpreter(root, server_root, s);
        if let Some(python) = python {
            let p = python.to_string_lossy().into_owned();
            match name {
                "basedpyright" | "pyright" => merge_init_options(cfg, json!({ "python": { "pythonPath": p } })),
                "pylsp" => merge_init_options(cfg, json!({ "pylsp": { "plugins": { "jedi": { "environment": p } } } })),
                "jedi-language-server" => merge_init_options(cfg, json!({ "workspace": { "environmentPath": p } })),
                // Django's template tags, filters and template folders are read by running a script
                // with the interpreter in one of these environment folders.
                "djlsp" => {
                    if let Some(env) = environment_of(&python) {
                        merge_init_options(cfg, json!({ "env_directories": [env.to_string_lossy()] }));
                    }
                }
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

    if name == "yaml-language-server" && !s.files.compose_file_overrides.is_empty() {
        let mut settings = cfg.settings.take().filter(Value::is_object).unwrap_or_else(|| json!({}));
        let mut kept = Vec::new();
        let mut excluded = Vec::new();
        for (path, status) in &s.files.compose_file_overrides {
            let p = Path::new(path);
            let abs = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
            let normalized = abs.to_string_lossy().replace('\\', "/");
            match status {
                ide_core::settings::ComposeFileOverride::Kept => kept.push(normalized),
                ide_core::settings::ComposeFileOverride::Excluded => excluded.push(normalized),
            }
        }
        let yaml = settings
            .as_object_mut()
            .expect("object")
            .entry("yaml")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .expect("object");
        let schemas = yaml.entry("schemas").or_insert_with(|| json!({})).as_object_mut().expect("object");
        let entry = schemas.entry(ide_language::COMPOSE_SCHEMA_URL).or_insert_with(|| json!([]));
        if let Value::String(single) = entry {
            *entry = json!([single.clone()]);
        }
        if let Some(list) = entry.as_array_mut() {
            for p in kept {
                if !list.iter().any(|v| v.as_str() == Some(&p)) {
                    list.push(Value::String(p));
                }
            }
            for p in &excluded {
                let neg = format!("!{p}");
                if !list.iter().any(|v| v.as_str() == Some(&neg)) {
                    list.push(Value::String(neg));
                }
            }
        }
        cfg.settings = Some(settings);
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
        if s.languages.go.gofumpt {
            build["gofumpt"] = json!(true);
        }
        let mut settings = cfg.settings.take().unwrap_or_else(|| json!({}));
        // gopls retains omitted keys on reconfiguration. Explicit empty values
        // restore defaults when the last project constraint is cleared.
        // Settings › Language Servers options are merged later, so look at them too.
        let init = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok());
        let user_init = s.language_servers.get(&cfg.name).and_then(|ls| ls.initialization_options.as_ref());
        for (key, default) in [("buildFlags", json!([])), ("env", json!({})), ("gofumpt", json!(false))] {
            if settings.get(key).is_none() {
                let explicit = user_init.and_then(|v| v.get(key)).or_else(|| init.as_ref()?.get(key));
                settings[key] = explicit.cloned().unwrap_or(default);
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
        // m2e (the Maven import) reads mirrors, servers and `<localRepository>`
        // from the settings file — never from `-Dmaven.repo.local`. The
        // derived file carries the configured local repository so the import
        // downloads where the IDE's own `mvn` runs do (#1739).
        if let Some(file) =
            maven_user_settings_for_m2e(root, s).or_else(|| setting_path(root, &s.languages.java.maven.user_settings))
        {
            let file = file.to_string_lossy();
            merge_init_options(
                cfg,
                json!({ "settings": { "java": { "configuration": { "maven": { "userSettings": file } } } } }),
            );
        }
        if let Some(file) = maven_global_settings(root, s) {
            let file = file.to_string_lossy();
            merge_init_options(
                cfg,
                json!({ "settings": { "java": { "configuration": { "maven": { "globalSettings": file } } } } }),
            );
        }
        // The JVM system property is still forwarded for JVM-level consumers,
        // but it is the settings file above that m2e honors. A
        // `-Dmaven.repo.local` the user put in their own jdtls VM options wins.
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

    if name == "java-analyzer" {
        // Unset, java-analyzer finds a JDK and the Maven local repository the way Maven does;
        // the server's own `initializationOptions` in settings are merged later and win.
        let mut layer = serde_json::Map::new();
        if let Some(jdk) = project_jdk(root, s) {
            layer.insert("jdkHome".into(), json!(jdk.home.to_string_lossy()));
        }
        if let Some(repo) = maven_local_repository(root, s) {
            layer.insert("maven".into(), json!({ "localRepository": repo.to_string_lossy() }));
        }
        if !layer.is_empty() {
            merge_init_options(cfg, Value::Object(layer));
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
    let vue_pkg = vue::server_package(&vue_command, &search_path());
    // TypeScript 7 serves LSP itself: it replaces the tsserver-based server, whose plugin
    // host goes away with it. The Vue language server's `@vue/typescript-plugin` loads into
    // that host, so a Vue project that has the server keeps the vtsls route and its `.vue`
    // support; elsewhere the native server still wins.
    if matches!(name, "vtsls" | "typescript-language-server")
        && !(name == "vtsls" && vue_pkg.is_some() && (vue::vue_project(server_root) || vue::vue_project(root)))
        && let Some(native) = native_tsdk(server_root, s).or_else(|| native_tsdk(root, s))
    {
        cfg.command = native.to_string_lossy().into_owned();
        cfg.args = vec!["--lsp".into(), "--stdio".into()];
        cfg.display_name = Some("TypeScript 7".into());
        cfg.initialization_options = None;
        // Completing a JSX prop adds `=""` or `={}` by its type, as vtsls does by default;
        // TypeScript 7 adds no value unless asked.
        let jsx = json!({ "preferences": { "jsxAttributeCompletionStyle": "auto" } });
        merge_init_options(cfg, json!({ "typescript": jsx, "javascript": jsx }));
        cfg.tsserver_project = false;
        return;
    }
    if name == "vtsls"
        && let Some(vue) = vue_pkg
    {
        let plugin = vue::tsserver_plugin(&vue);
        merge_init_options(cfg, json!({ "vtsls": { "tsserver": { "globalPlugins": [plugin] } } }));
        cfg.tsserver_project_extras.extensions = vec![vue::EXTENSION.into()];
        // Hybrid mode: one program holds every .vue's virtual TypeScript, so the
        // heap must clear it (vtsls' default 3072 dies in a GC death spiral), and
        // the syntax tsserver duplicates the plugin and its file watching.
        merge_init_options(
            cfg,
            json!({ "typescript": { "tsserver": { "useSyntaxServer": "never", "maxTsServerMemory": 8192 } } }),
        );
        // A configured project resolves its own types; the typings installer only
        // serves inferred projects and keeps scanning npm in the background.
        if server_root.ancestors().any(|d| d.join("tsconfig.json").is_file() || d.join("jsconfig.json").is_file()) {
            merge_init_options(cfg, json!({ "typescript": { "disableAutomaticTypeAcquisition": true } }));
        }
    }
    let memory = s.languages.typescript.tsserver_max_memory;
    if name == "vtsls" && memory > 0 {
        merge_init_options(cfg, json!({ "typescript": { "tsserver": { "maxTsServerMemory": memory } } }));
    }
    if name == "vtsls"
        && cfg.tsserver_project
        && !server_root.ancestors().any(|d| d.join("tsconfig.json").is_file() || d.join("jsconfig.json").is_file())
    {
        let node = node_dir(root, s).map(|d| d.join(exe("node"))).filter(|p| p.is_file()).or_else(|| which("node"));
        let mut paths = vue::cli_paths(server_root, node.as_deref());
        // The project's own Vite / Rollup / esbuild aliases replace the Vue template's `@`.
        paths.extend(crate::path_aliases::paths(server_root));
        cfg.tsserver_project_extras.paths = paths;
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
    if name == astro::SERVER {
        astro::configure(cfg, root, server_root, s);
    }
    // Biome lints with the project's own version (its configuration follows that version's
    // schema); an explicit executable setting still wins.
    if name == "biome"
        && cfg.command == "biome"
        && let Some(bin) = crate::npm::project_bin("biome", root, server_root)
    {
        cfg.command = bin.to_string_lossy().into_owned();
    }
    if name == crate::mdx::SERVER {
        crate::mdx::configure(cfg, root, server_root, s);
    }
    if name == crate::arduino::SERVER {
        crate::arduino::configure(cfg, root, server_root, s);
    }
}

/// Registers the companion module-resolution plugin for the Vue hybrid mode's tsserver.
/// The Vue plugin only resolves imports that name the
/// `.vue` file: a directory `index.js` re-exporting a sibling `.vue`
/// (`import ChildButton from './ChildButton'`) leaves the component `any`, and with it every
/// `@event="method"` handler type in the project's templates (#3728; VS Code patches tsserver
/// itself for this). The companion plugin retries only what tsserver and the Vue plugin left
/// unresolved, so it is registered after theirs. No-op without it (no Vue language server).
pub fn configure_vue_module_resolution(cfg: &mut LanguageServerConfig, data_dir: &Path) -> bool {
    let Some(vue_at) = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).and_then(|v| {
        v.pointer("/vtsls/tsserver/globalPlugins")
            .and_then(Value::as_array)
            .and_then(|plugins| plugins.iter().position(|p| p.get("name").and_then(Value::as_str) == Some(vue::PLUGIN)))
    }) else {
        return false;
    };
    let Some(plugin) = vue::module_resolution_plugin(data_dir) else {
        return false;
    };
    let mut current =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| json!({}));
    let Some(plugins) = current.pointer_mut("/vtsls/tsserver/globalPlugins").and_then(Value::as_array_mut) else {
        return false;
    };
    match plugins.iter().position(|p| p.get("name").and_then(Value::as_str) == Some(vue::MODULE_RESOLUTION_PLUGIN)) {
        Some(at) => plugins[at] = plugin,
        None => plugins.insert(vue_at + 1, plugin),
    }
    match toml::Value::try_from(current) {
        Ok(v) => cfg.initialization_options = Some(v),
        Err(e) => tracing::warn!("{}: cannot apply settings to initialization options: {e}", cfg.name),
    }
    true
}

/// Registers the tsserver plugin that adds the Vite / Rollup / esbuild path aliases of each
/// package under `server_root` to that package's tsserver projects' `paths`, below
/// tsconfig.json / jsconfig.json's own (#6020). Only vtsls hosts tsserver plugins (not
/// TypeScript 7's native server). No-op without aliases.
pub fn configure_path_aliases(cfg: &mut LanguageServerConfig, server_root: &Path, data_dir: &Path) -> bool {
    if cfg.name != "vtsls" || !cfg.tsserver_project {
        return false;
    }
    let packages = crate::path_aliases::packages(server_root);
    if packages.is_empty() {
        return false;
    }
    let Some(plugin) = crate::path_aliases::tsserver_plugin(data_dir, server_root, &packages) else {
        return false;
    };
    push_global_plugin(cfg, plugin);
    true
}

/// Registers CSS Modules Kit (`@css-modules-kit/ts-plugin`, installed under `location`) as a
/// vtsls global plugin when a tsconfig.json at, above or below `server_root` sets
/// `cmkOptions.enabled` (#6071). No-op elsewhere, and without the plugin (`None`).
pub fn configure_css_modules(cfg: &mut LanguageServerConfig, server_root: &Path, location: Option<&Path>) -> bool {
    if cfg.name != "vtsls" || !cfg.tsserver_project {
        return false;
    }
    let Some(location) = location.filter(|_| crate::css_modules::enabled(server_root)) else {
        return false;
    };
    // Both are Volar plugins sharing the tools' one `@volar/typescript`, which decorates a
    // tsserver project once: only the first of them to load works. Outside a Vue project
    // CSS Modules Kit goes first; a Vue project keeps Vue's (`<style module>` is Vue's own).
    // ponytail: a monorepo whose root isn't the Vue package gives CSS Modules Kit the project.
    let before = (!vue::vue_project(server_root)).then_some(vue::PLUGIN);
    insert_global_plugin(cfg, crate::css_modules::tsserver_plugin(location), before);
    true
}

/// Adds `plugin` to vtsls' `globalPlugins`, replacing an entry of the same name.
fn push_global_plugin(cfg: &mut LanguageServerConfig, plugin: Value) {
    insert_global_plugin(cfg, plugin, None);
}

/// Adds `plugin` to vtsls' `globalPlugins` (replacing an entry of the same name), in front of
/// the plugin named `before` when that one is there, else last.
fn insert_global_plugin(cfg: &mut LanguageServerConfig, plugin: Value, before: Option<&str>) {
    let mut current =
        cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| json!({}));
    let mut node = &mut current;
    for key in ["vtsls", "tsserver"] {
        node = object_entry(node, key);
    }
    let plugins =
        node.as_object_mut().expect("made an object above").entry("globalPlugins").or_insert_with(|| json!([]));
    if !plugins.is_array() {
        *plugins = json!([]);
    }
    let plugins = plugins.as_array_mut().expect("made an array above");
    plugins.retain(|p| p.get("name") != plugin.get("name"));
    let at = before
        .and_then(|name| plugins.iter().position(|p| p.get("name").and_then(Value::as_str) == Some(name)))
        .unwrap_or(plugins.len());
    plugins.insert(at, plugin);
    match toml::Value::try_from(current) {
        Ok(v) => cfg.initialization_options = Some(v),
        Err(e) => tracing::warn!("{}: cannot apply settings to initialization options: {e}", cfg.name),
    }
}

/// Leaves out CSS's vtsls route (`languages/css.toml`) while the CSS Modules Kit plugin is not
/// installed: without it vtsls has nothing for CSS files.
pub fn drop_css_modules_route(servers: &mut Vec<LanguageServerConfig>) {
    servers.retain(|c| c.name != "vtsls" || !c.root_markers.iter().any(|m| m == crate::css_modules::MARKER));
}

/// Lets vtsls load the tsserver plugins that the project's tsconfig.json / jsconfig.json
/// declare (Next.js) with any TypeScript version, from a plugin probe location under
/// `data_dir` that loads the project's packages (#6336). A plugin the IDE registers globally
/// keeps the IDE's copy, also when a tsconfig names it, so call this after those are
/// registered. No-op without declared plugins, and for TypeScript 7's native server.
pub fn configure_tsconfig_plugins(cfg: &mut LanguageServerConfig, server_root: &Path, data_dir: &Path) -> bool {
    if cfg.name != "vtsls" || !cfg.tsserver_project {
        return false;
    }
    let options = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok());
    let global: Vec<String> = options
        .as_ref()
        .and_then(|v| v.pointer("/vtsls/tsserver/globalPlugins")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.get("name")?.as_str().map(str::to_owned))
        .collect();
    let mut declared = crate::tsconfig_plugins::declared(server_root);
    declared.packages.retain(|name, _| !global.contains(name));
    let Some(location) = crate::tsconfig_plugins::probe_location(data_dir, server_root, &declared) else {
        return false;
    };
    merge_init_options(cfg, json!({ "typescript": { "tsserver": { "pluginPaths": [location] } } }));
    true
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

/// Built-in servers given an executable path in Settings › Language Servers, as
/// (definition's command, path): they run that executable (see [`server_launch_overrides`]).
pub fn server_command_paths<'a>(
    servers: impl IntoIterator<Item = &'a LanguageServerConfig>,
    root: &Path,
    s: &Settings,
) -> Vec<(String, PathBuf)> {
    servers
        .into_iter()
        .filter_map(|server| {
            let command = s.language_servers.get(&server.name)?.command.trim();
            let path = command.contains(['/', '\\']).then(|| setting_path(root, command))??;
            Some((server.command.clone(), path))
        })
        .collect()
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
        requires_env: Vec::new(),
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
        replaces: Vec::new(),
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        display_name: None,
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
    // A server shipped as a runnable jar (groovy-language-server-all.jar) runs on `java -jar`;
    // `configure_server` then picks the project JDK's `java`.
    if Path::new(&cfg.command).extension().is_some_and(|e| e.eq_ignore_ascii_case("jar")) {
        let jar = std::mem::replace(&mut cfg.command, "java".to_owned());
        cfg.args.splice(0..0, ["-jar".to_owned(), jar]);
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
        let astro_tsdk = (cfg.name == astro::SERVER)
            .then(|| cfg.initialization_options.as_ref()?.get("typescript")?.get("tsdk")?.as_str().map(str::to_owned))
            .flatten();
        merge_init_options(cfg, options.clone());
        if let Some(tsdk) = astro_tsdk {
            merge_init_options(cfg, json!({ "typescript": { "tsdk": tsdk } }));
        }
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
    let selected = tsdk(server_root, s).or_else(|| tsdk(root, s)).filter(|l| has_ts_api(l));
    let package = vue::server_package(&cfg.command, &search_path());
    let own = package.as_deref().and_then(own_typescript);
    let workspace = || workspace_tsdk(server_root).or_else(|| workspace_tsdk(root)).filter(|l| has_ts_api(l));
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

/// Whether `cmd` is a Python executable by its name (`python`, `python3.12`, `python.exe`).
pub fn is_python_command(cmd: &str) -> bool {
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
    if arg == "-U" || arg == "--update-snapshots" {
        return Some("-U");
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
    } else if let Some(target) = settings.languages.python.run_target().filter(|_| is_python_config(config, &name)) {
        // The project interpreter is a run target's: Python runs there.
        return Some(target);
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

fn is_python_config(config: &RunConfig, program: &str) -> bool {
    matches!(config.kind.as_str(), "python" | "pytest" | "unittest" | "doctest" | "django-test")
        || is_python_command(program)
}

/// Whether the configuration's `JAVA_HOME` is the one Settings choose (the Maven runner JRE,
/// the Gradle JVM) rather than a choice of its own: an IDE-generated build-tool configuration —
/// a Maven goal or Gradle task from the tool window — carries the model's `JAVA_HOME`, which
/// Settings derived when the model was built (IDEA has no JRE field on such a task either).
/// Such a value is derived: Settings win, and [`without_derived`] drops it, so a corrected JDK
/// applies to the next run, also across a restart (#2433). Every other configuration keeps its
/// own `JAVA_HOME`, even one this build cannot parse.
fn java_home_is_derived(c: &RunConfig) -> bool {
    generated_maven_goal(c) || (c.id.starts_with("gradle:task:") && c.extras.params.is_empty())
}

/// Applies the `JAVA_HOME` of `env` (the one Settings resolved) to `c`. A derived value is
/// replaced, also when Settings resolve none (a dead path must not outlive the setting it came
/// from); an explicit `JAVA_HOME` of the configuration still wins.
fn apply_java_home(c: &mut RunConfig, env: &std::collections::BTreeMap<String, String>, derived: bool) {
    match env.get("JAVA_HOME") {
        Some(value) if derived => {
            c.env.insert("JAVA_HOME".into(), value.clone());
        }
        Some(value) => {
            c.env.entry("JAVA_HOME".into()).or_insert_with(|| value.clone());
        }
        None if derived => {
            c.env.remove("JAVA_HOME");
        }
        None => {}
    }
}

/// The Maven environment from Settings (the runner JRE), applied to `c`: a derived `JAVA_HOME`
/// is replaced, an explicit one stays (see [`apply_java_home`]).
pub fn apply_maven_env(c: &mut RunConfig, root: &Path, s: &Settings) {
    let env = maven_build_env(root, s, None);
    apply_java_home(c, &env, java_home_is_derived(c));
    for (key, value) in env {
        c.env.entry(key).or_insert(value);
    }
}

/// Points run configurations at the selected toolchains: Python configs use the
/// project interpreter, npm scripts the chosen package manager and Node.js,
/// cargo / go configs the selected toolchain, Maven / Gradle their runner JDK
/// (and Maven the configured home and options).
pub fn apply_to_run_configs(configs: &mut [RunConfig], root: &Path, s: &Settings) {
    apply_to_run_configs_in(configs, root, None, s)
}

/// [`apply_to_run_configs`] with an inherited fallback project: a workspace member
/// (`root`) with no Python of its own (no interpreter setting, virtualenv or pin)
/// runs on the primary project's (`fallback`) — the module SDK a member without its
/// own inherits in IDEA. `None` keeps the configuration's own project.
pub fn apply_to_run_configs_in(configs: &mut [RunConfig], root: &Path, fallback: Option<&Path>, s: &Settings) {
    let inherited = fallback.filter(|f| *f != root);
    // An interpreter whose executable is gone is skipped (like PyCharm's "Invalid"
    // SDKs): the run configuration uses the venv / fallback instead of a dead path.
    let explicit_python = setting_path(root, &s.languages.python.interpreter).filter(|p| p.is_file());
    let inherited_python = inherited
        .and_then(|f| setting_path(f, &s.languages.python.interpreter))
        .filter(|p| p.is_file())
        .filter(|_| explicit_python.is_none());
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
                    // A member with no Python of its own runs on the primary project's.
                    "python" => python_interpreter_near(root, Some(near), s)
                        .or_else(|| inherited.and_then(|f| python_interpreter_near(f, Some(f), s))),
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
            "python" | "pytest" | "unittest" | "doctest" | "django-test" => {
                let command = Path::new(&c.command);
                let own = !c.detected && command.components().count() > 1 && is_python_command(&c.command);
                let python = if own {
                    let cwd = root.join(c.cwd.as_deref().unwrap_or(Path::new("")));
                    Some(ide_core::project_roots::resolve(&cwd, command))
                } else {
                    toolchain("python", &owner)
                };
                // The member's explicit interpreter, else the inherited one, else the
                // member's own venv / pin.
                if !own && let Some(py) = explicit_python.as_ref().or(inherited_python.as_ref()).or(python.as_ref()) {
                    let runner = PY_RUNNERS.contains(&c.command.as_str());
                    // Options for the runner itself (`uv run --with rich …`, `--no-sync`,
                    // `--project member`) only mean something to it: keep that command (#5874).
                    let runner_options = runner
                        && c.args.first().map(String::as_str) == Some("run")
                        && c.args.get(1).is_some_and(|a| a.starts_with('-'));
                    if matches!(c.kind.as_str(), "python" | "unittest" | "doctest" | "django-test")
                        && !runner_options
                        && (runner || is_python_command(&c.command))
                    {
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
                let env = gradle_build_env(root, &build_dir, &c.command, s, None);
                apply_java_home(c, &env, java_home_is_derived(c));
                for (key, value) in env {
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
            // JAR Application's default JRE is the project JDK; a chosen JRE is an absolute `java`.
            "jar-application" => {
                if let Some(jdk) = &jdk
                    && c.command == "java"
                {
                    let java = crate::java::java_executable(&jdk.home);
                    if java.is_file() {
                        c.command = java.to_string_lossy().into_owned();
                    }
                }
            }
            "tomcat" => {
                if let Some(jdk) = &jdk {
                    c.env.entry("JAVA_HOME".into()).or_insert_with(|| jdk.home.to_string_lossy().into_owned());
                }
            }
            // A JUnit configuration runs the module's own Maven or Gradle command line: it needs
            // that build's environment (its JDK), not another launcher or extra options.
            "junit" => {
                let name = Path::new(&c.command).file_name().map(|n| n.to_string_lossy().to_ascii_lowercase());
                match name.as_deref() {
                    Some(n) if n.starts_with("mvn") => apply_maven_env(c, root, s),
                    Some(n) if n.starts_with("gradle") => {
                        let build_dir =
                            c.cwd.as_ref().map(|p| root.join(p.as_ref())).unwrap_or_else(|| root.to_path_buf());
                        let env = gradle_build_env(root, &build_dir, &c.command, s, None);
                        apply_java_home(c, &env, java_home_is_derived(c));
                        for (key, value) in env {
                            c.env.entry(key).or_insert(value);
                        }
                    }
                    _ => {}
                }
            }
            "maven" => {
                apply_maven_env(c, root, s);
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
    without_derived_in(config, root, None, s)
}

/// [`without_derived`] with the inherited fallback project the configuration runs with
/// (see [`apply_to_run_configs_in`]): a derived command or environment entry is derived
/// only when re-applying settings with the same fallback reproduces it.
pub fn without_derived_in(config: &RunConfig, root: &Path, fallback: Option<&Path>, s: &Settings) -> RunConfig {
    let applied = |c: &RunConfig| {
        let mut c = c.clone();
        apply_to_run_configs_in(std::slice::from_mut(&mut c), root, fallback, s);
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
            // Settings choose the `JAVA_HOME` of a generated build-tool configuration, also when
            // a corrected setting no longer reproduces the value the model froze there (#2433).
            if key.as_str() == "JAVA_HOME" && java_home_is_derived(&out) {
                return true;
            }
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
        // Generated configurations name the bare program (`java`), also on Windows where the
        // derived path ends in `java.exe` (`flutter.bat`).
        let bare = name
            .len()
            .checked_sub(4)
            .filter(|&at| name[at..].eq_ignore_ascii_case(".exe") || name[at..].eq_ignore_ascii_case(".bat"))
            .map(|at| &name[..at]);
        for candidate in bare.into_iter().chain([name.as_str()]) {
            let mut probe = out.clone();
            probe.command = candidate.to_owned();
            if applied(&probe).command == config.command {
                out.command = candidate.to_owned();
                break;
            }
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
    let python = python_interpreter(root, s)?;
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let name = Path::new(name).file_stem().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let Some(venv) = venv_of(&python) else {
        return conda_activation(
            &python,
            &name,
            std::env::var_os("CONDA_EXE").map(PathBuf::from),
            crate::discover::conda_exe(),
        );
    };
    if std::env::var_os("VIRTUAL_ENV").is_some_and(|v| Path::new(&v) == venv) {
        return None;
    }
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

/// The prefix of the conda environment `python` belongs to (it holds `conda-meta/`).
pub fn conda_env_prefix(python: &Path) -> Option<PathBuf> {
    crate::discover::conda_env_home(python).filter(|env| env.join("conda-meta").is_dir())
}

/// `conda activate <prefix>` for a conda interpreter, as PyCharm does for a Conda project
/// interpreter: conda envs have no activate script of their own, and the shells' conda hook
/// comes from the installation (the env itself for `base`, the parent of `envs/`, else
/// `CONDA_EXE` or the `conda` on PATH). `name` is the shell's lowercased file stem.
fn conda_activation(python: &Path, name: &str, conda_exe: Option<PathBuf>, on_path: Option<PathBuf>) -> Option<String> {
    let env = crate::discover::conda_env_home(python).filter(|env| env.join("conda-meta").is_dir())?;
    if std::env::var_os("CONDA_PREFIX").is_some_and(|p| Path::new(&p) == env) {
        return None;
    }
    let is_base = |dir: &Path| dir.join("condabin").is_dir();
    // `<base>/bin/conda`, `<base>/condabin/conda[.bat]`, `<base>\Scripts\conda.exe`.
    let base_of = |exe: PathBuf| exe.parent()?.parent().map(Path::to_path_buf).filter(|b| is_base(b));
    let base = Some(env.clone())
        .filter(|e| is_base(e))
        .or_else(|| {
            env.parent()
                .filter(|p| p.file_name().is_some_and(|n| n == "envs"))?
                .parent()
                .map(Path::to_path_buf)
                .filter(|b| is_base(b))
        })
        .or_else(|| conda_exe.and_then(base_of))
        .or_else(|| on_path.and_then(base_of))?;
    let prefix = env.to_string_lossy();
    let conda = if cfg!(windows) { base.join("Scripts").join("conda.exe") } else { base.join("bin").join("conda") };
    let posix = |hook: &str| {
        conda.is_file().then(|| {
            format!(
                "eval \"$({} shell.{hook} hook)\" && conda activate {}",
                sh_quote(&conda.to_string_lossy()),
                sh_quote(&prefix)
            )
        })
    };
    match name {
        "cmd" => {
            let bat = base.join("condabin").join("conda.bat");
            bat.is_file().then(|| format!("call \"{}\" activate \"{prefix}\"", bat.display()))
        }
        "pwsh" | "powershell" => {
            let hook = base.join("shell").join("condabin").join("conda-hook.ps1");
            let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
            hook.is_file().then(|| format!("& {}; conda activate {}", quote(&hook.to_string_lossy()), quote(&prefix)))
        }
        "bash" => posix("bash"),
        "zsh" => posix("zsh"),
        "sh" | "dash" | "ksh" | "mksh" | "ash" => posix("posix"),
        "fish" => conda.is_file().then(|| {
            format!(
                "{} shell.fish hook | source; and conda activate {}",
                sh_quote(&conda.to_string_lossy()),
                sh_quote(&prefix)
            )
        }),
        _ => None,
    }
}

#[cfg(test)]
mod python_user_path_tests {
    use super::*;

    fn venv(dir: &Path) -> PathBuf {
        let python = dir.join(".venv").join(crate::bin_dir()).join(crate::exe("python"));
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        std::fs::write(dir.join(".venv/pyvenv.cfg"), "").unwrap();
        python
    }

    fn text(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn user_paths_follow_the_interpreter_and_skip_what_cannot_be_imported() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (lib, other) = (root.join("shared"), root.join("other"));
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let python = venv(&root);
        let other_python = root.join("other-python");

        let mut s = Settings::default();
        s.languages.python.interpreter_paths = [
            // Gone, duplicated, relative and a file: none of them reach the import path.
            (text(&python), vec![text(&lib), text(&root.join("gone")), text(&lib), "relative".into(), text(&python)]),
            (text(&other_python), vec![text(&other)]),
        ]
        .into();
        assert_eq!(interpreter_user_paths(&python, &s), std::slice::from_ref(&lib));
        assert_eq!(interpreter_user_paths(&other_python, &s), [other]);
        assert!(interpreter_user_paths(&root.join("unknown-python"), &s).is_empty());
    }

    #[test]
    fn a_folder_that_stays_off_the_import_path_says_why() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        assert_eq!(user_path(&text(&root)), Ok(root.clone()));
        assert_eq!(user_path(&text(&root.join("gone"))), Err(UserPathProblem::Missing));
        assert_eq!(user_path("relative/dir"), Err(UserPathProblem::Invalid));
        assert_eq!(user_path(" "), Err(UserPathProblem::Invalid));
        // One entry with the separator in it would make `PYTHONPATH` impossible to build.
        #[cfg(unix)]
        {
            let odd = root.join("libs:v2");
            std::fs::create_dir(&odd).unwrap();
            assert_eq!(user_path(&text(&odd)), Err(UserPathProblem::Invalid));
            let mut s = Settings::default();
            s.languages.python.interpreter_paths = [("/bin/python".into(), vec![text(&odd), text(&root)])].into();
            assert_eq!(interpreter_user_paths(Path::new("/bin/python"), &s), [root]);
        }
    }

    #[test]
    fn a_language_server_takes_the_interpreter_of_its_own_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let sub = root.join("services/api");
        let (python, sub_python) = (venv(&root), venv(&sub));
        let mut s = Settings::default();
        assert_eq!(python_server_interpreter(&root, &root, &s), Some(python.clone()));
        assert_eq!(python_server_interpreter(&root, &sub, &s), Some(sub_python));
        // A configured interpreter is the one every server of the project uses.
        s.languages.python.interpreter = text(&python);
        assert_eq!(python_server_interpreter(&root, &sub, &s), Some(python));
        s.languages.python.interpreter = "target:docker".into();
        assert_eq!(python_server_interpreter(&root, &root, &s), None);
    }
}

#[cfg(test)]
mod java_compiler_tests {
    use super::*;

    fn options(cfg: &LanguageServerConfig) -> Value {
        serde_json::to_value(cfg.initialization_options.as_ref().unwrap()).unwrap()
    }

    fn prefs_path(options: &Value) -> PathBuf {
        let url = options.pointer("/settings/java/settings/url").unwrap().as_str().unwrap();
        url::Url::parse(url).unwrap().to_file_path().unwrap()
    }

    #[test]
    fn serial_version_inspection_sets_the_compiler_option() {
        let tmp = tempfile::tempdir().unwrap();
        let url = |inspections: &InspectionSettings| {
            let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
            configure_java_compiler(&mut cfg, tmp.path(), inspections);
            prefs_path(&options(&cfg))
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
        let url = options.pointer("/settings/java/settings/url").unwrap().as_str().unwrap();
        assert!(url.starts_with("file://") && !url.contains(' '), "{url}");
        let path = prefs_path(&options);
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
        // The Java import of a build that declares no Java version still needs a JVM its Gradle runs on.
        assert_eq!(newest_gradle_jdk((8, 4), &installed).unwrap().major, 17);
        assert_eq!(newest_gradle_jdk((7, 2), &installed).unwrap().major, 11);
        assert_eq!(newest_gradle_jdk((9, 1), &installed).unwrap().major, 25);
        assert!(newest_gradle_jdk((9, 0), &installed[4..]).is_none());
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
    fn hybrid_vtsls_gets_one_server_a_full_heap_and_no_type_acquisition() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // The Vue package the hybrid block finds through the command's package dir.
        let bin = root.join("tools/node_modules/.bin/vue-language-server");
        let pkg = root.join("tools/node_modules/@vue/language-server/package.json");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::create_dir_all(pkg.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::write(&pkg, "{}").unwrap();
        let mut s = Settings::default();
        s.tools
            .insert(vue::SERVER.into(), ide_core::settings::ToolSettings { path: bin.to_string_lossy().into_owned() });
        std::fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
        configure_server(&mut cfg, root, root, &s);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert_eq!(options.pointer("/typescript/tsserver/useSyntaxServer"), Some(&json!("never")));
        assert_eq!(options.pointer("/typescript/tsserver/maxTsServerMemory"), Some(&json!(8192)));
        assert_eq!(options.pointer("/typescript/disableAutomaticTypeAcquisition"), Some(&json!(true)));
        // A user-set limit wins over the automatic one.
        s.languages.typescript.tsserver_max_memory = 6144;
        let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
        configure_server(&mut cfg, root, root, &s);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert_eq!(options.pointer("/typescript/tsserver/maxTsServerMemory"), Some(&json!(6144)));
    }

    #[test]
    fn vtsls_probes_the_tsconfig_plugins_but_not_its_global_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let (root, data) = (tmp.path().join("app"), tmp.path().join("data"));
        std::fs::create_dir_all(root.join("node_modules/next")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/@vue/typescript-plugin")).unwrap();
        let vtsls = || {
            let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
            cfg.tsserver_project = true;
            merge_init_options(
                &mut cfg,
                json!({ "vtsls": { "tsserver": { "globalPlugins": [{ "name": vue::PLUGIN }] } } }),
            );
            cfg
        };
        let probed = |cfg: &LanguageServerConfig| {
            serde_json::to_value(&cfg.initialization_options)
                .unwrap()
                .pointer("/typescript/tsserver/pluginPaths")
                .cloned()
        };
        std::fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"strict":true}}"#).unwrap();
        let mut cfg = vtsls();
        assert!(!configure_tsconfig_plugins(&mut cfg, &root, &data));
        assert_eq!(probed(&cfg), None);

        let plugins = format!(r#"[{{"name":"next"}},{{"name":"{}"}}]"#, vue::PLUGIN);
        std::fs::write(root.join("tsconfig.json"), format!(r#"{{"compilerOptions":{{"plugins":{plugins}}}}}"#))
            .unwrap();
        let mut cfg = vtsls();
        assert!(configure_tsconfig_plugins(&mut cfg, &root, &data));
        let location = PathBuf::from(probed(&cfg).unwrap()[0].as_str().unwrap());
        assert!(location.starts_with(&data) && location.join("node_modules/next/index.js").is_file());
        // The IDE's Vue plugin is not replaced by the project's.
        assert!(!location.join("node_modules").join(vue::PLUGIN).exists());
        // TypeScript 7's native server hosts no plugins.
        let mut native = vtsls();
        native.tsserver_project = false;
        assert!(!configure_tsconfig_plugins(&mut native, &root, &data));
    }

    #[test]
    fn typescript_7_keeps_vtsls_when_the_vue_server_is_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // The Vue server, as the hybrid block finds it through the tool's package dir.
        let bin = root.join("tools/node_modules/.bin/vue-language-server");
        let pkg = root.join("tools/node_modules/@vue/language-server/package.json");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::create_dir_all(pkg.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::write(&pkg, "{}").unwrap();
        let mut s = Settings::default();
        s.tools
            .insert(vue::SERVER.into(), ide_core::settings::ToolSettings { path: bin.to_string_lossy().into_owned() });
        // A Vue project whose TypeScript is 7: the native executable would take over.
        std::fs::write(root.join("package.json"), r#"{"dependencies":{"vue":"^3.0.0"}}"#).unwrap();
        let modules = root.join("node_modules");
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            os => os,
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            arch => arch,
        };
        std::fs::create_dir_all(modules.join("typescript/lib")).unwrap();
        std::fs::write(modules.join("typescript/package.json"), r#"{"name":"typescript","version":"7.0.2"}"#).unwrap();
        let native = modules.join(format!("@typescript/typescript-{os}-{arch}/lib")).join(crate::exe("tsc"));
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "").unwrap();
        s.languages.typescript.version = "workspace".into();

        // vtsls hosts the Vue plugin's tsserver; the native server cannot, so it loses.
        let mut cfg = crate::tests::server("vtsls");
        configure_server(&mut cfg, root, root, &s);
        assert_eq!(cfg.command, "vtsls");
        assert_eq!(
            serde_json::to_value(cfg.initialization_options).unwrap().pointer("/vtsls/tsserver/globalPlugins/0/name"),
            Some(&json!("@vue/typescript-plugin"))
        );
        assert_eq!(cfg.tsserver_project_extras.extensions, [vue::EXTENSION.to_string()]);

        // typescript-language-server gets no plugin route: the native server still applies.
        let mut cfg = crate::tests::server("typescript-language-server");
        configure_server(&mut cfg, root, root, &s);
        assert_eq!(Path::new(&cfg.command), native);
    }

    #[test]
    fn hybrid_without_a_config_keeps_type_acquisition_and_plain_vtsls_stays_default() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let bin = root.join("tools/node_modules/.bin/vue-language-server");
        let pkg = root.join("tools/node_modules/@vue/language-server/package.json");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::create_dir_all(pkg.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::write(&pkg, "{}").unwrap();
        let mut s = Settings::default();
        s.tools
            .insert(vue::SERVER.into(), ide_core::settings::ToolSettings { path: bin.to_string_lossy().into_owned() });
        // No tsconfig/jsconfig anywhere: inferred projects still want the typings installer.
        let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
        configure_server(&mut cfg, root, root, &s);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert!(options.pointer("/typescript/disableAutomaticTypeAcquisition").is_none());
        assert_eq!(options.pointer("/typescript/tsserver/maxTsServerMemory"), Some(&json!(8192)));
        // Without the Vue package there is no hybrid mode: nothing is injected. The
        // command points at a bare binary, so the package lookup finds nothing
        // (a bare name would resolve on the host's PATH and break the test).
        std::fs::write(root.join("bare-vue-language-server"), "#!/bin/sh\n").unwrap();
        s.tools
            .insert(vue::SERVER.into(), ide_core::settings::ToolSettings { path: "bare-vue-language-server".into() });
        let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
        configure_server(&mut cfg, root, root, &s);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert!(options.pointer("/typescript/tsserver/useSyntaxServer").is_none());
        assert!(options.pointer("/typescript/tsserver/maxTsServerMemory").is_none());
        // A user-set limit applies to plain TypeScript projects too.
        s.languages.typescript.tsserver_max_memory = 12288;
        let mut cfg = custom_server("vtsls", &LanguageServerSettings::default());
        configure_server(&mut cfg, root, root, &s);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert_eq!(options.pointer("/typescript/tsserver/maxTsServerMemory"), Some(&json!(12288)));
        assert!(options.pointer("/typescript/tsserver/useSyntaxServer").is_none());
    }

    #[test]
    fn default_maven_repository_reads_the_user_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        assert_eq!(default_maven_repository_in(home), Some(home.join(".m2/repository")));
        std::fs::create_dir_all(home.join(".m2")).unwrap();
        let settings = home.join(".m2/settings.xml");
        std::fs::write(
            &settings,
            "<settings><!-- <localRepository>/old</localRepository> --><localRepository>/repo</localRepository></settings>",
        )
        .unwrap();
        assert_eq!(default_maven_repository_in(home), Some(PathBuf::from("/repo")));
        std::fs::write(&settings, "<settings><localRepository>${user.home}/m2repo</localRepository></settings>")
            .unwrap();
        assert_eq!(default_maven_repository_in(home), Some(home.join("m2repo")));
        std::fs::write(&settings, "<settings><localRepository>${env.REPO}</localRepository></settings>").unwrap();
        assert_eq!(default_maven_repository_in(home), Some(home.join(".m2/repository")));
    }

    #[test]
    fn maven_sources_download_follows_the_setting() {
        let mut settings = Settings::default();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        cfg.settings = Some(json!({"java": {"maven": {"downloadSources": true, "updateSnapshots": false}}}));
        configure_maven_sources(&mut cfg, &settings);
        assert_eq!(
            cfg.settings,
            Some(json!({"java": {"maven": {"downloadSources": false, "updateSnapshots": false}}}))
        );
        settings.languages.java.maven.download_sources = true;
        settings.languages.java.maven.update_snapshots = true;
        configure_maven_sources(&mut cfg, &settings);
        assert_eq!(cfg.settings.unwrap()["java"]["maven"], json!({"downloadSources": true, "updateSnapshots": true}));

        let mut other = custom_server("kotlin", &LanguageServerSettings::default());
        configure_maven_sources(&mut other, &settings);
        assert_eq!(other.settings, None);
    }

    #[test]
    fn gradle_import_runs_the_gradle_the_ide_builds_with() {
        let root = Path::new("/p");
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        cfg.settings = Some(json!({"java": {"import": {"gradle": {"enabled": true}}}}));
        let initial = cfg.clone();
        let mut settings = Settings::default();
        configure_gradle_runtime(&mut cfg, root, root, &settings);
        assert_eq!(cfg, initial, "no Gradle settings: jdtls keeps its own defaults and the wrapper");

        let g = &mut settings.languages.java.gradle;
        g.distribution = ide_core::settings::GradleDistribution::Local;
        g.home = "tools/gradle-5.2.1".into();
        g.user_home = "/caches/gradle".into();
        g.jvm = "/jdk/8".into();
        configure_gradle_runtime(&mut cfg, root, root, &settings);
        let gradle = &cfg.settings.as_ref().unwrap()["java"]["import"]["gradle"];
        assert_eq!(gradle["enabled"], json!(true), "merged, not replaced");
        let resolved = |s: &str| json!(setting_path(root, s).unwrap().to_string_lossy());
        assert_eq!(gradle["home"], json!(root.join("tools/gradle-5.2.1").to_string_lossy()));
        assert_eq!(gradle["wrapper"]["enabled"], json!(false));
        assert_eq!(gradle["user"]["home"], resolved("/caches/gradle"));
        assert_eq!(gradle["java"]["home"], resolved("/jdk/8"));

        // The wrapper distribution keeps the wrapper even with a home left over.
        let mut cfg = initial.clone();
        settings.languages.java.gradle.distribution = ide_core::settings::GradleDistribution::Wrapper;
        configure_gradle_runtime(&mut cfg, root, root, &settings);
        let gradle = &cfg.settings.as_ref().unwrap()["java"]["import"]["gradle"];
        assert!(gradle.get("home").is_none() && gradle.get("wrapper").is_none());
        assert_eq!(gradle["user"]["home"], resolved("/caches/gradle"));
    }

    #[test]
    fn gradle_import_adds_the_projects_a_source_set_compiles_against() {
        let temp = tempfile::tempdir().unwrap();
        let spaced = temp.path().join("Application Support").join("gradle");
        let plain = temp.path().join("cache").join("gradle");
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        cfg.settings = Some(json!({"java": {"import": {"gradle": {"enabled": true}}}}));
        configure_gradle_classpath(&mut cfg, &[spaced.clone(), plain.clone()]);
        let gradle = &cfg.settings.as_ref().unwrap()["java"]["import"]["gradle"];
        assert_eq!(gradle["enabled"], json!(true), "merged, not replaced");
        let args = gradle["arguments"].as_array().unwrap();
        assert_eq!(args[0], json!("--init-script"));
        let script = PathBuf::from(args[1].as_str().unwrap());
        assert_eq!(script.parent(), Some(plain.as_path()), "Buildship splits arguments at spaces");
        assert!(!spaced.exists());
        let text = std::fs::read_to_string(&script).unwrap();
        assert!(text.contains("compileClasspath") && text.contains("whenMerged"));

        let mut other = custom_server("pyright", &LanguageServerSettings::default());
        configure_gradle_classpath(&mut other, &[plain]);
        assert!(other.settings.is_none(), "only jdtls imports Gradle builds");

        let mut nowhere = custom_server("jdtls", &LanguageServerSettings::default());
        configure_gradle_classpath(&mut nowhere, &[spaced]);
        assert!(nowhere.settings.is_none(), "no usable directory: the import runs without it");
    }

    #[test]
    fn gradle_classpath_script_applies_plugins_to_the_project() {
        // Inside the script's closures a bare `apply` is the init script's own: on Gradle 7 the
        // Eclipse plugin then fails to start and the whole import fails.
        let script = include_str!("gradle-classpath.init.gradle");
        let bare: Vec<&str> = script.lines().filter(|line| line.trim_start().starts_with("apply ")).collect();
        assert!(bare.is_empty(), "{bare:?}");
        assert!(script.contains("project.apply plugin: 'eclipse'"));
    }

    #[test]
    fn gradle_import_of_a_gradle_build_runs_on_the_project_jdk_like_the_ides_builds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(root.join("build.gradle"), "plugins { id 'java' }").unwrap();
        let jdk = root.join("jdk11");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("bin").join(crate::exe("java")), "").unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"11.0.2\"\n").unwrap();
        let mut settings = Settings::default();
        settings.languages.java.jdk = jdk.to_string_lossy().into_owned();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        configure_gradle_runtime(&mut cfg, root, root, &settings);
        let gradle = &cfg.settings.as_ref().unwrap()["java"]["import"]["gradle"];
        let expected =
            gradle_build_env(root, root, &gradle_command(root, root, &settings).to_string_lossy(), &settings, None);
        assert_eq!(gradle["java"]["home"], json!(expected["JAVA_HOME"]));
        assert!(expected["JAVA_HOME"].ends_with("jdk11"));
        assert!(gradle.get("wrapper").is_none(), "the wrapper stays on");

        // An explicit Gradle JVM wins over the Project JDK.
        settings.languages.java.gradle.jvm = "/gradle-jdk".into();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        configure_gradle_runtime(&mut cfg, root, root, &settings);
        let gradle = &cfg.settings.as_ref().unwrap()["java"]["import"]["gradle"];
        assert_eq!(gradle["java"]["home"], json!(setting_path(root, "/gradle-jdk").unwrap().to_string_lossy()));
    }

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
        configure_maven_import(&mut cfg, tmp.path(), &["a/child/pom.xml".into(), "a/pom.xml".into()], &[], None);
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        let exclusions = options.pointer("/settings/java/import/exclusions").unwrap().as_array().unwrap();
        assert!(exclusions.contains(&json!("**/custom")));
        assert!(exclusions.contains(&json!(tmp.path().join("a").to_string_lossy().replace('\\', "/"))));
        assert!(exclusions.contains(&json!(tmp.path().join("a/child").to_string_lossy().replace('\\', "/"))));
        assert!(cfg.args[1].starts_with("/cache/jdtls-maven-"));
        assert!(options.get("projectConfigurations").is_none());
    }

    #[test]
    fn import_excludes_the_projects_excluded_folders_and_changes_persistent_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = |p: &str| tmp.path().join(p).to_string_lossy().replace('\\', "/");
        let workspace = |excluded: &[String]| {
            let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
            cfg.args = vec!["-data".into(), "/cache/jdtls".into()];
            configure_maven_import(&mut cfg, tmp.path(), &[], excluded, None);
            (serde_json::to_value(cfg.initialization_options).unwrap(), cfg.args[1].clone())
        };
        let (options, data) = workspace(&[".worktrees".into(), "out/[old]".into()]);
        let exclusions = options.pointer("/settings/java/import/exclusions").unwrap().as_array().unwrap();
        // The folder and everything below it; glob characters in the path stay literal.
        assert!(exclusions.contains(&json!(dir(".worktrees"))));
        assert!(exclusions.contains(&json!(format!("{}/**", dir(".worktrees")))));
        assert!(exclusions.contains(&json!(format!("{}/\\[old\\]/**", dir("out")))));
        assert!(exclusions.contains(&json!("**/node_modules/**")));
        assert!(options.get("projectConfigurations").is_none());
        // Projects imported before the folder was excluded stay in the old workspace.
        assert!(data.starts_with("/cache/jdtls-maven-"));
        assert_ne!(data, workspace(&[".other".into()]).1);
        assert_eq!(workspace(&[]).1, "/cache/jdtls");
    }

    #[test]
    fn import_lists_the_build_files_when_given() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        let files = ["file:///p/r/x/pom.xml".to_owned(), "file:///p/build.gradle".to_owned()];
        configure_maven_import(&mut cfg, tmp.path(), &["r/y/pom.xml".into()], &[], Some(&files));
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        assert_eq!(options["projectConfigurations"], json!(files));
        // Nothing unlinked: jdtls finds the build files itself.
        let mut cfg = custom_server("jdtls", &LanguageServerSettings::default());
        configure_maven_import(&mut cfg, tmp.path(), &[], &[], Some(&files));
        assert!(serde_json::to_value(cfg.initialization_options).unwrap().get("projectConfigurations").is_none());
    }

    #[test]
    fn compose_file_overrides_populate_yaml_schemas_and_typed_exclusions() {
        let root = Path::new("/work");
        let mut s = Settings::default();
        s.files.compose_file_overrides.insert("custom-stack.yml".into(), ide_core::settings::ComposeFileOverride::Kept);
        s.files
            .compose_file_overrides
            .insert("/work/docker/playground-compose.yml".into(), ide_core::settings::ComposeFileOverride::Excluded);
        let mut cfg = custom_server("yaml-language-server", &LanguageServerSettings::default());
        cfg.settings = Some(json!({
            "yaml": {
                "schemas": {
                    ide_language::COMPOSE_SCHEMA_URL: ["compose.yml", "*-compose.yml"]
                }
            }
        }));
        configure_server(&mut cfg, root, root, &s);
        let yaml = &cfg.settings.as_ref().unwrap()["yaml"];
        assert!(yaml.get("disableSchemaDetection").is_none());
        let list = yaml["schemas"][ide_language::COMPOSE_SCHEMA_URL]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(list.contains(&"compose.yml"));
        assert!(list.contains(&"/work/custom-stack.yml"));
        assert!(list.contains(&"!/work/docker/playground-compose.yml"));
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

#[cfg(test)]
mod java_compliance_tests {
    #[test]
    fn maps_every_java_language_level_to_jdt_compliance() {
        let c = |l: &str| super::java_compliance(l);
        assert_eq!(c("6"), Some(("6".into(), "1.6".into())));
        assert_eq!(c("1.7"), Some(("7".into(), "1.7".into())));
        assert_eq!(c("8"), Some(("8".into(), "1.8".into())));
        assert_eq!(c(" 1.8 "), Some(("8".into(), "1.8".into())));
        assert_eq!(c("14"), Some(("14".into(), "14".into())));
        assert_eq!(c("25"), Some(("25".into(), "25".into())));
        assert_eq!(c("1.14"), None);
        assert_eq!(c("4"), None);
        assert_eq!(c(""), None);
        assert_eq!(c("latest"), None);
    }
}

#[cfg(test)]
mod conda_activation_tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    /// A conda prefix with its interpreter where conda puts it on this OS.
    fn prefix(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir.join("conda-meta")).unwrap();
        let python = if cfg!(windows) { dir.join("python.exe") } else { dir.join("bin").join("python") };
        touch(&python);
        python
    }

    #[test]
    fn conda_envs_activate_through_the_installations_shell_hooks() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("miniconda3");
        let base_python = prefix(&base);
        std::fs::create_dir_all(base.join("condabin")).unwrap();
        let conda = if cfg!(windows) { base.join("Scripts").join("conda.exe") } else { base.join("bin").join("conda") };
        touch(&conda);
        let bat = base.join("condabin").join("conda.bat");
        touch(&bat);
        let hook = base.join("shell").join("condabin").join("conda-hook.ps1");
        touch(&hook);
        let env = base.join("envs").join("agent-gateway");
        let python = prefix(&env);
        let q = |p: &Path| sh_quote(&p.to_string_lossy());

        assert_eq!(
            conda_activation(&python, "zsh", None, None).unwrap(),
            format!("eval \"$({} shell.zsh hook)\" && conda activate {}", q(&conda), q(&env))
        );
        assert_eq!(
            conda_activation(&python, "cmd", None, None).unwrap(),
            format!("call \"{}\" activate \"{}\"", bat.display(), env.display())
        );
        assert_eq!(
            conda_activation(&python, "powershell", None, None).unwrap(),
            format!("& '{}'; conda activate '{}'", hook.display(), env.display())
        );
        assert_eq!(
            conda_activation(&python, "fish", None, None).unwrap(),
            format!("{} shell.fish hook | source; and conda activate {}", q(&conda), q(&env))
        );
        assert_eq!(conda_activation(&python, "nu", None, None), None, "no conda hook for this shell");
        assert!(conda_activation(&base_python, "bash", None, None).unwrap().ends_with(&q(&base)), "base itself");

        // A `--prefix` env elsewhere finds the installation through CONDA_EXE or PATH.
        let elsewhere = tmp.path().join("project").join(".conda");
        let python = prefix(&elsewhere);
        assert_eq!(conda_activation(&python, "bash", None, None), None);
        let line = conda_activation(&python, "bash", Some(conda.clone()), None).unwrap();
        assert!(line.ends_with(&format!("conda activate {}", q(&elsewhere))), "{line}");
        assert!(conda_activation(&python, "cmd", None, Some(bat.clone())).is_some());

        // Not a conda prefix.
        let plain = tmp.path().join("python");
        touch(&plain.join("bin").join("python"));
        assert_eq!(conda_activation(&plain.join("bin").join("python"), "bash", Some(conda), None), None);
    }
}

#[cfg(test)]
mod biome_tests {
    use super::*;

    fn binary(dir: &Path) -> PathBuf {
        let bin = dir.join(if cfg!(windows) { "biome.cmd" } else { "biome" });
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&bin, "").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        bin
    }

    #[test]
    fn biome_runs_the_projects_own_biome_unless_an_executable_is_set() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let web = root.join("apps/web");
        let configured = |s: &Settings, server_root: &Path| {
            let mut cfg = custom_server("biome", &LanguageServerSettings::default());
            cfg.command = "biome".into();
            configure_server(&mut cfg, &root, server_root, s);
            PathBuf::from(cfg.command)
        };
        let workspace = binary(&root.join("node_modules/.bin"));
        assert_eq!(configured(&Settings::default(), &web), workspace);
        let member = binary(&web.join("node_modules/.bin"));
        assert_eq!(configured(&Settings::default(), &web), member);
        // Outside the project: not the project's installation.
        binary(&tmp.path().join("node_modules/.bin"));
        assert_eq!(configured(&Settings::default(), &tmp.path().join("other")), PathBuf::from("biome"));
        let custom = binary(&tmp.path().join("custom"));
        let mut s = Settings::default();
        s.tools
            .insert("biome".into(), ide_core::settings::ToolSettings { path: custom.to_string_lossy().into_owned() });
        assert_eq!(configured(&s, &web), custom);
    }
}
