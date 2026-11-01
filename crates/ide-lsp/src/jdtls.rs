//! jdtls extensions used to run and debug Java: workspace build, runtime
//! classpaths and the project's JDK (`java.project.*`), and the java-debug
//! bundle's debug server (`vscode.java.startDebugSession`).
//!
//! jdtls is started on demand for the module, so a run configuration works
//! without a Java editor open.

use crate::LspManager;
use crate::server::{Running, Server};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SERVER: &str = "jdtls";
/// First start imports the Maven / Gradle model, which can take minutes.
const READY_TIMEOUT: Duration = Duration::from_secs(240);
/// A workspace build of a large multi-module project can take far longer than
/// an editor request; the user can always cancel the launch waiting on it.
const BUILD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// How long to retry while the project is still being imported.
const IMPORT_WAIT: Duration = Duration::from_secs(90);
/// Compile errors listed with a launch; the rest are only counted.
const MAX_LAUNCH_ERRORS: usize = 10;
/// Build markers can be published just after `java/buildWorkspace` answers.
const ERRORS_WAIT: Duration = Duration::from_secs(2);

const ACCESS_OPTIONS: [&str; 2] = [
    "org.eclipse.jdt.core.compiler.problem.forbiddenReference",
    "org.eclipse.jdt.core.compiler.problem.discouragedReference",
];

/// Keep the source model in protocol settings so jdtls's invisible-project
/// initialization and configuration use the same roots as workspace builds.
pub fn configure_source_paths(cfg: &mut ide_language::LanguageServerConfig, paths: Option<Vec<String>>) {
    if cfg.name != SERVER {
        return;
    }
    if let Some(paths) = paths {
        let mut settings = cfg.settings.take().unwrap_or_else(|| json!({}));
        settings["java"]["project"]["sourcePaths"] = json!(paths);
        cfg.settings = Some(settings);
    }
}

pub(crate) fn source_paths_removed(
    current: &ide_language::LanguageServerConfig,
    next: &ide_language::LanguageServerConfig,
) -> bool {
    current.name == SERVER
        && crate::handler::all_settings(current).pointer("/java/project/sourcePaths").is_some()
        && crate::handler::all_settings(next).pointer("/java/project/sourcePaths").is_none()
}

pub(crate) fn source_trigger(root: &Path, paths: &[Value]) -> Option<PathBuf> {
    for path in paths.iter().filter_map(Value::as_str) {
        // Runs can start jdtls without an editor. Invisible-project import still
        // needs a Java trigger file; discovery is bounded and runs off async workers.
        let found = ignore::WalkBuilder::new(root.join(path))
            .standard_filters(false)
            .max_depth(Some(32))
            .build()
            .take(4000)
            .filter_map(Result::ok)
            .find(|e| {
                e.file_type().is_some_and(|t| t.is_file()) && e.path().extension().is_some_and(|ext| ext == "java")
            });
        if let Some(entry) = found {
            return Some(entry.into_path());
        }
    }
    None
}

fn compiler_defaults(cfg: &ide_language::LanguageServerConfig) -> Value {
    // updateSettings persists project options. Only use it when jdtls redirects
    // generated metadata into its workspace, and never touch an existing .settings.
    let metadata = cfg.args.iter().rev().find_map(|a| {
        a.strip_prefix("--jvm-arg=").unwrap_or(a).strip_prefix("-Djava.import.generatesMetadataFilesAtProjectRoot=")
    });
    if metadata != Some("false") {
        return json!({});
    }
    let settings = crate::handler::all_settings(cfg);
    let Some(url) = settings
        .pointer("/java/settings/url")
        .or_else(|| settings.pointer("/settings/java/settings/url"))
        .and_then(Value::as_str)
    else {
        return json!({});
    };
    let path = crate::uri::uri_to_path(url).unwrap_or_else(|| PathBuf::from(url));
    let Ok(prefs) = std::fs::read_to_string(path) else { return json!({}) };
    let mut options = serde_json::Map::new();
    for line in prefs.lines() {
        if let Some((key, value)) = line.split_once('=')
            && ACCESS_OPTIONS.contains(&key.trim())
            && ["error", "warning", "info", "ignore"].contains(&value.trim())
        {
            options.insert(key.trim().into(), json!(value.trim()));
        }
    }
    Value::Object(options)
}

fn cache_owned_maven_settings(root: &Path) -> bool {
    root.join("pom.xml").is_file() && matches!(root.join(".settings").try_exists(), Ok(false))
}

fn project_path(uri: &str) -> Option<PathBuf> {
    // jdtls commands use Java's `file:/p` as well as LSP's `file:///p`.
    let normalized = match uri.strip_prefix("file:") {
        Some(rest) if !rest.starts_with("//") => format!("file://{rest}"),
        _ => uri.to_owned(),
    };
    crate::uri::uri_to_path(&normalized)
}

/// Result of `java/buildWorkspace` (jdtls `BuildWorkspaceStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JavaBuildStatus {
    Failed,
    Succeeded,
    /// Compiled, but some project has compile errors.
    WithErrors,
    Cancelled,
}

impl JavaBuildStatus {
    pub fn from_code(code: i64) -> Self {
        match code {
            1 => Self::Succeeded,
            2 => Self::WithErrors,
            3 => Self::Cancelled,
            _ => Self::Failed,
        }
    }
}

/// What it takes to start a JVM for a module: classpath entries in order and
/// the JDK jdtls compiles the project against.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaClasspath {
    pub project_root: Option<ide_core::IpcPath>,
    pub class_paths: Vec<String>,
    pub module_paths: Vec<String>,
}

/// Everything needed to launch a class of a module: build outcome, classpath and JDK.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaLaunchInfo {
    /// `None` when no build was requested.
    pub build: Option<JavaBuildStatus>,
    pub project_root: Option<ide_core::IpcPath>,
    pub class_paths: Vec<String>,
    pub module_paths: Vec<String>,
    /// Path list separator of the host that runs the JVM.
    pub path_list_separator: String,
    /// JDK home jdtls compiles the project against.
    pub java_home: Option<ide_core::IpcPath>,
    /// The `java` launcher to use (filled in by the caller from the installed JDKs).
    pub java_exec: Option<String>,
    /// How a launcher that builds the command line itself must shorten it (java-debug's
    /// `shortenCommandLine`: `none` | `jarmanifest` | `argfile`; filled in by the caller).
    pub shorten_command_line: Option<String>,
    /// First compile errors of the workspace when the build had errors.
    pub errors: Vec<JavaCompileError>,
    /// All compile errors (`errors` is capped).
    pub error_count: u32,
    /// Likely causes of the errors worth telling the user (e.g. a missing Lombok agent).
    pub hints: Vec<String>,
}

/// One error diagnostic; `line` / `column` are 1-based for display.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaCompileError {
    pub path: ide_core::IpcPath,
    pub line: u32,
    pub column: u32,
    pub message: String,
}

/// Holds off JDT writers while an external compiler builds and snapshots launch outputs.
/// Restores current settings even when preparation fails or is cancelled.
pub struct JavaExternalBuild {
    server: Arc<Server>,
    run: Running,
    _lock: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for JavaExternalBuild {
    fn drop(&mut self) {
        self.server.java_autobuild_suspended.store(false, std::sync::atomic::Ordering::SeqCst);
        let settings = crate::handler::all_settings(&self.server.effective_config());
        if let Err(e) = self.run.peer.notify("workspace/didChangeConfiguration", json!({ "settings": settings })) {
            tracing::debug!("jdtls: restoring autobuild: {e}");
        }
    }
}

/// Error diagnostics sorted by file and position, capped at `limit`, and their total.
pub fn compile_errors(
    diagnostics: Vec<(PathBuf, lsp_types::Diagnostic)>,
    limit: usize,
) -> (Vec<JavaCompileError>, u32) {
    let mut errors: Vec<JavaCompileError> = diagnostics
        .into_iter()
        .filter(|(_, d)| d.severity == Some(lsp_types::DiagnosticSeverity::ERROR))
        .map(|(path, d)| JavaCompileError {
            path: path.into(),
            line: d.range.start.line + 1,
            column: d.range.start.character + 1,
            message: d.message.lines().next().unwrap_or_default().to_owned(),
        })
        .collect();
    errors.sort_by(|a, b| (&a.path, a.line, a.column).cmp(&(&b.path, b.line, b.column)));
    let count = u32::try_from(errors.len()).unwrap_or(u32::MAX);
    errors.truncate(limit);
    (errors, count)
}

/// `java.project.getClasspaths` result.
pub fn parse_classpaths(v: &Value) -> JavaClasspath {
    let strings = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    JavaClasspath {
        project_root: v
            .get("projectRoot")
            .and_then(Value::as_str)
            .map(|r| project_path(r).unwrap_or_else(|| PathBuf::from(r)).into()),
        class_paths: strings("classpaths"),
        module_paths: strings("modulepaths"),
    }
}

/// `vscode.java.startDebugSession` answers the port as a number (or numeric string).
pub fn parse_port(v: &Value) -> Option<u16> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).and_then(|p| u16::try_from(p).ok())
}

/// `java.project.getSettings` → the project's VM install location, if any.
pub fn parse_vm_location(v: &Value) -> Option<PathBuf> {
    v.get("org.eclipse.jdt.ls.core.vm.location").and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// Errors that mean "jdtls has not imported this project (yet)".
fn not_imported(e: &IdeError) -> bool {
    let m = e.message.to_ascii_lowercase();
    m.contains("does not belong to any java project")
        || m.contains("not a java project")
        || m.contains("no project")
        || m.contains("cannot find")
}

/// The java-debug bundle is not loaded into jdtls.
fn missing_bundle(e: &IdeError) -> bool {
    let m = e.message.to_ascii_lowercase();
    m.contains("no delegatecommandhandler") || m.contains("unsupported command") || m.contains("not supported")
}

/// Cancel local waits without interrupting a shared server's startup or import.
async fn cancellable_wait<T>(cancel: &CancellationToken, wait: impl std::future::Future<Output = T>) -> IdeResult<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(IdeError::cancelled()),
        result = wait => Ok(result),
    }
}

impl LspManager {
    /// m2e generates a project-specific forbidden-reference error, overriding
    /// workspace defaults. Apply those defaults only to cache-owned metadata.
    async fn java_configure_compiler(&self, server: &Server, run: &Running) -> IdeResult<bool> {
        let options = compiler_defaults(&server.effective_config());
        if options.as_object().is_none_or(|o| o.is_empty()) {
            return Ok(false);
        }
        let command = |name: &str, arguments: Value| {
            let params = json!({"command": name, "arguments": arguments});
            let peer = run.peer.clone();
            async move {
                tokio::time::timeout(
                    COMMAND_TIMEOUT,
                    peer.request::<_, Value>("workspace/executeCommand", params, None),
                )
                .await
                .unwrap_or(Err(ide_jsonrpc::RpcError::Timeout))
                .map_err(|e| crate::rpc_err(SERVER, "workspace/executeCommand", e))
            }
        };
        let projects = command("java.project.getAll", json!([])).await?;
        let mut changed = false;
        for uri in projects.as_array().into_iter().flatten().filter_map(Value::as_str) {
            let Some(root) = project_path(uri) else { continue };
            // An existing .settings is owned by the project, even if it currently
            // contains preferences for another Eclipse plugin.
            if !cache_owned_maven_settings(&root) {
                continue;
            }
            let keys: Vec<_> = options.as_object().unwrap().keys().collect();
            let current = command("java.project.getSettings", json!([uri, keys])).await?;
            if options.as_object().unwrap().iter().all(|(k, v)| current.get(k) == Some(v)) {
                continue;
            }
            command("java.project.updateSettings", json!([uri, options])).await?;
            changed = true;
        }
        Ok(changed)
    }

    pub(crate) fn java_import_ready(self: &Arc<Self>, server: Arc<Server>, generation: u64) {
        let mgr = self.clone();
        self.runtime.spawn(async move {
            let Some(run) = server.running_gen(generation) else { return };
            if let Err(e) = mgr.java_configure_compiler(&server, &run).await {
                tracing::warn!("jdtls: cannot apply compiler defaults: {e}");
            }
        });
    }

    /// The jdtls instance serving `path` (a module directory or source file),
    /// started if needed and waited for.
    async fn jdtls(&self, path: &Path, cancel: &CancellationToken) -> IdeResult<(Arc<Server>, Running)> {
        let java = LanguageId::new("java");
        let server = self
            .servers_for(&java, path)
            .into_iter()
            .find(|s| s.name == SERVER)
            .ok_or_else(|| IdeError::unavailable("no Java language server (jdtls) is configured"))?;
        self.ensure_started(&server);
        match cancellable_wait(cancel, server.wait_ready(READY_TIMEOUT)).await? {
            Some(run) => Ok((server, run)),
            None => {
                let status = server.status();
                Err(IdeError::unavailable(match status {
                    ide_core::event::ServerStatus::Missing => {
                        "jdtls is not installed (Settings › Languages & Frameworks › Language Servers)".to_owned()
                    }
                    ide_core::event::ServerStatus::Misconfigured | ide_core::event::ServerStatus::Crashed => {
                        server.status_message().unwrap_or_else(|| "jdtls cannot start".to_owned())
                    }
                    _ => format!("jdtls is not ready ({status:?})"),
                }))
            }
        }
    }

    async fn jdtls_request(
        &self,
        path: &Path,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> IdeResult<Value> {
        let started = Instant::now();
        let (server, run) = self.jdtls(path, cancel).await?;
        let ready_ms = started.elapsed().as_millis();
        let phase = params.get("command").and_then(Value::as_str).unwrap_or(method).to_owned();
        let fut = run.peer.request::<Value, Value>(method, params, Some(cancel.clone()));
        let result = match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r.map_err(|e| crate::rpc_err(&server.name, method, e)),
            Err(_) => Err(IdeError::new(
                ErrorKind::Protocol,
                format!(
                    "{SERVER}: {method} timed out after {} s; retry, or check that jdtls is not stuck",
                    timeout.as_secs()
                ),
            )),
        };
        tracing::info!(
            phase,
            ready_ms,
            request_ms = started.elapsed().as_millis() - ready_ms,
            success = result.is_ok(),
            "Java launch request"
        );
        result
    }

    /// `workspace/executeCommand` on the jdtls serving `path`.
    pub async fn jdtls_command(&self, path: &Path, command: &str, arguments: Vec<Value>) -> IdeResult<Value> {
        self.jdtls_command_cancellable(path, command, arguments, &CancellationToken::new()).await
    }

    async fn jdtls_command_cancellable(
        &self,
        path: &Path,
        command: &str,
        arguments: Vec<Value>,
        cancel: &CancellationToken,
    ) -> IdeResult<Value> {
        self.jdtls_request(
            path,
            "workspace/executeCommand",
            json!({ "command": command, "arguments": arguments }),
            COMMAND_TIMEOUT,
            cancel,
        )
        .await
    }

    /// Like [`jdtls_command`](Self::jdtls_command), retried while the project is still importing.
    async fn jdtls_project_command(
        &self,
        path: &Path,
        command: &str,
        arguments: Vec<Value>,
        cancel: &CancellationToken,
    ) -> IdeResult<Value> {
        let deadline = Instant::now() + IMPORT_WAIT;
        loop {
            match self.jdtls_command_cancellable(path, command, arguments.clone(), cancel).await {
                Err(e) if not_imported(&e) && Instant::now() < deadline => {
                    tracing::debug!("{command}: {e}; waiting for the project import");
                    cancellable_wait(cancel, tokio::time::sleep(Duration::from_millis(1500))).await?;
                }
                r => return r,
            }
        }
    }

    /// Tells jdtls the build files of `uris` changed (`java/projectConfigurationsUpdate`),
    /// so it re-imports their projects (e.g. after `~/.m2` gained an artifact it could
    /// not resolve). Best-effort: skipped while jdtls is not already running.
    pub async fn java_update_project_configs(&self, path: &Path, uris: Vec<String>) -> IdeResult<()> {
        if uris.is_empty() {
            return Ok(());
        }
        let java = LanguageId::new("java");
        let Some(server) = self.servers_for(&java, path).into_iter().find(|s| s.name == SERVER) else {
            return Ok(());
        };
        let Some(run) = server.running() else { return Ok(()) };
        let identifiers: Vec<Value> = uris.iter().map(|u| json!({ "uri": u })).collect();
        run.peer
            .notify("java/projectConfigurationsUpdate", json!({ "identifiers": identifiers }))
            .map_err(|e| crate::rpc_err(&server.name, "java/projectConfigurationsUpdate", e))
    }

    /// Pause autobuild before resolving the launch classpath. That query takes the
    /// Java project's workspace scheduling rule, draining the interrupted autobuild.
    /// Keep this guard until Maven outputs have been copied out of JDT's reach.
    pub async fn java_external_build(&self, path: &Path, cancel: &CancellationToken) -> IdeResult<JavaExternalBuild> {
        let (server, run) = self.jdtls(path, cancel).await?;
        let lock = cancellable_wait(cancel, server.java_build_lock.clone().lock_owned()).await?;
        server.java_autobuild_suspended.store(true, std::sync::atomic::Ordering::SeqCst);
        let guard = JavaExternalBuild { server, run, _lock: lock };
        let settings = crate::handler::all_settings(&guard.server.effective_config());
        guard
            .run
            .peer
            .notify("workspace/didChangeConfiguration", json!({ "settings": settings }))
            .map_err(|e| crate::rpc_err(SERVER, "workspace/didChangeConfiguration", e))?;
        Ok(guard)
    }

    /// Incremental build of the jdtls workspace (`java/buildWorkspace`), so
    /// class files are up to date before a launch.
    pub async fn java_build(&self, path: &Path, cancel: &CancellationToken) -> IdeResult<JavaBuildStatus> {
        let (server, _) = self.jdtls(path, cancel).await?;
        let _lock = cancellable_wait(cancel, server.java_build_lock.lock()).await?;
        let mut v = self.jdtls_request(path, "java/buildWorkspace", json!(false), BUILD_TIMEOUT, cancel).await?;
        // The first build can finish the Maven import before ServiceReady is handled.
        let (server, run) = self.jdtls(path, cancel).await?;
        let changed = cancellable_wait(cancel, self.java_configure_compiler(&server, &run)).await??;
        // ServiceReady can update the options concurrently with that first build.
        let recheck = v.as_i64() == Some(2)
            && compiler_defaults(&server.effective_config()).as_object().is_some_and(|o| !o.is_empty());
        if changed || recheck {
            v = self.jdtls_request(path, "java/buildWorkspace", json!(false), BUILD_TIMEOUT, cancel).await?;
        }
        Ok(JavaBuildStatus::from_code(v.as_i64().unwrap_or(0)))
    }

    /// Runtime (`test == false`) or test classpath of the project containing `path`.
    pub async fn java_classpath(
        &self,
        path: &Path,
        test: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<JavaClasspath> {
        let uri = crate::uri::path_to_uri_string(path);
        let options = json!({ "scope": if test { "test" } else { "runtime" } }).to_string();
        let v = self
            .jdtls_project_command(path, "java.project.getClasspaths", vec![json!(uri), json!(options)], cancel)
            .await?;
        Ok(parse_classpaths(&v))
    }

    /// The JDK home jdtls uses for the project containing `path`.
    pub async fn java_vm_location(&self, path: &Path, cancel: &CancellationToken) -> IdeResult<Option<PathBuf>> {
        let uri = crate::uri::path_to_uri_string(path);
        let v = self
            .jdtls_project_command(
                path,
                "java.project.getSettings",
                vec![json!(uri), json!(["org.eclipse.jdt.ls.core.vm.location"])],
                cancel,
            )
            .await?;
        Ok(parse_vm_location(&v))
    }

    /// Builds (when asked), then resolves the classpath and JDK of the module at `module`.
    pub async fn java_launch(
        &self,
        module: &Path,
        test: bool,
        build: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<JavaLaunchInfo> {
        let build = if build { Some(self.java_build(module, cancel).await?) } else { None };
        if build == Some(JavaBuildStatus::Cancelled) {
            return Err(IdeError::cancelled());
        }
        let (errors, error_count) = match build {
            Some(JavaBuildStatus::WithErrors | JavaBuildStatus::Failed) => {
                cancellable_wait(cancel, self.java_compile_errors(module)).await?
            }
            _ => (Vec::new(), 0),
        };
        let cp = self.java_classpath(module, test, cancel).await?;
        let java_home = match self.java_vm_location(module, cancel).await {
            Ok(home) => home,
            Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
            Err(e) => {
                tracing::debug!("java.project.getSettings: {e}");
                None
            }
        };
        Ok(JavaLaunchInfo {
            build,
            project_root: cp.project_root,
            class_paths: cp.class_paths,
            module_paths: cp.module_paths,
            path_list_separator: if cfg!(windows) { ";" } else { ":" }.into(),
            java_home: java_home.map(Into::into),
            java_exec: None,
            shorten_command_line: None,
            errors,
            error_count,
            hints: Vec::new(),
        })
    }

    /// Compile errors jdtls reports for its workspace (all modules it imported).
    async fn java_compile_errors(&self, module: &Path) -> (Vec<JavaCompileError>, u32) {
        let Ok((server, _)) = self.jdtls(module, &CancellationToken::new()).await else { return (Vec::new(), 0) };
        let collect = || compile_errors(server.diagnostics_snapshot(), MAX_LAUNCH_ERRORS);
        let found = collect();
        if found.1 > 0 {
            return found;
        }
        let _ = tokio::time::timeout(ERRORS_WAIT, server.published_notify.notified()).await;
        collect()
    }

    /// Resolve a disk/archive class to project source or the server's binary document.
    /// Archive URIs must come from JDT's Java model: fabricated handles cannot map debug lines.
    pub async fn java_class_file(&self, path: &Path, archive: Option<(PathBuf, String)>) -> IdeResult<String> {
        let cancel = CancellationToken::new();
        self.jdtls(&self.project_root, &cancel).await?;
        if let Some((jar, entry)) = archive {
            let entry = entry
                .strip_prefix("META-INF/versions/")
                .and_then(|s| s.split_once('/').map(|(_, s)| s))
                .unwrap_or(&entry);
            let class = entry.strip_suffix(".class").ok_or_else(|| IdeError::not_found("expected a class file"))?;
            let outer = class.split('$').next().unwrap_or(class);
            let (package, name) = outer.rsplit_once('/').unwrap_or(("", outer));
            let query = outer.replace('/', ".");
            let symbols = self.workspace_symbols(&query, cancel).await?;
            let package = package.replace('/', ".");
            let name = name.to_owned();
            let outer = outer.to_owned();
            return tokio::task::spawn_blocking(move || {
                symbols
                    .into_iter()
                    .filter_map(|s| s.location.uri)
                    .find(|uri| crate::virtual_doc::matches_class(uri, &jar, &package, &name))
                    .ok_or_else(|| {
                        IdeError::not_found(format!("jdtls could not resolve {} in {}", outer, jar.display()))
                    })
            })
            .await
            .map_err(|e| IdeError::internal(e.to_string()))?;
        }
        let uri = crate::uri::path_to_uri_string(path);
        // classFileContents accepts file URIs, but java-debug's line mapping only accepts JDT handles.
        let doc = self.virtual_document(&uri).await?;
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").split('$').next().unwrap_or("");
        let package = doc
            .text
            .lines()
            .find_map(|l| l.trim().strip_prefix("package ").and_then(|p| p.strip_suffix(';')))
            .unwrap_or("");
        let relative = PathBuf::from(package.replace('.', "/")).join(format!("{name}.java"));
        let key = "org.eclipse.jdt.ls.core.sourcePaths";
        let settings = self
            .jdtls_project_command(path, "java.project.getSettings", vec![json!(uri), json!([key])], &cancel)
            .await?;
        let roots: Vec<PathBuf> =
            settings[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from).collect();
        let source =
            tokio::task::spawn_blocking(move || roots.into_iter().map(|r| r.join(&relative)).find(|p| p.is_file()))
                .await
                .map_err(|e| IdeError::internal(e.to_string()))?;
        Ok(source.map(|s| s.to_string_lossy().into_owned()).unwrap_or(uri))
    }

    /// Starts (or reuses) java-debug's DAP server inside jdtls and returns its port.
    pub async fn java_debug_server(&self, path: &Path) -> IdeResult<u16> {
        let v = self.jdtls_command(path, "vscode.java.startDebugSession", Vec::new()).await.map_err(|e| {
            if missing_bundle(&e) {
                IdeError::unavailable("the Java debugger (java-debug) is not loaded into jdtls")
            } else {
                e
            }
        })?;
        // Hot code replace after each (auto-)build; errors only cost the feature.
        let settings = json!({ "debugSupportOnDecompiledSource": "on", "hotCodeReplace": "auto", "showStaticVariables": false, "showQualifiedNames": false,
            "showLogicalStructure": true, "showToString": true, "maxStringLength": 0,
            // java-debug NPEs on a missing level (java.util.logging names).
            "logLevel": "WARNING" });
        if let Err(e) =
            self.jdtls_command(path, "vscode.java.updateDebugSettings", vec![json!(settings.to_string())]).await
            && e.kind != ErrorKind::Cancelled
        {
            tracing::debug!("vscode.java.updateDebugSettings: {e}");
        }
        parse_port(&v).ok_or_else(|| IdeError::new(ErrorKind::Protocol, format!("unexpected debug server port: {v}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn java_config() -> ide_language::LanguageServerConfig {
        let language: ide_language::LanguageConfig =
            toml::from_str(include_str!("../../../languages/java.toml")).unwrap();
        language.language_servers.into_iter().next().unwrap()
    }

    #[test]
    fn source_settings_preserve_java_defaults_and_library_resolution() {
        let mut cfg = java_config();
        configure_source_paths(&mut cfg, Some(vec!["src/main/java".into(), "tests".into()]));
        let settings = crate::handler::all_settings(&cfg);
        assert_eq!(settings["java"]["project"]["sourcePaths"], json!(["src/main/java", "tests"]));
        assert_eq!(settings["java"]["project"]["referencedLibraries"], json!(["lib/**/*.jar"]));
        assert_eq!(settings["java"]["autobuild"]["enabled"], true);
        assert_eq!(settings["java"]["contentProvider"]["preferred"], "fernflowerContentProvider");
        assert!(settings.get("bundles").is_none());
        assert!(settings.get("settings").is_none(), "didChangeConfiguration takes java settings directly");
    }

    #[test]
    fn unmarked_and_managed_source_models_are_not_overridden() {
        let mut cfg = java_config();
        let initial = cfg.clone();
        configure_source_paths(&mut cfg, None);
        assert_eq!(cfg, initial);
        assert!(crate::handler::all_settings(&cfg).pointer("/java/project/sourcePaths").is_none());
        configure_source_paths(&mut cfg, Some(vec!["custom".into()]));
        assert!(source_paths_removed(&cfg, &initial));
        assert!(!source_paths_removed(&initial, &cfg));
        let mut other = initial;
        other.name = "other".into();
        let initial = other.clone();
        configure_source_paths(&mut other, Some(vec!["custom".into()]));
        assert_eq!(other, initial);
    }

    #[test]
    fn explicit_java_protocol_settings_override_defaults_in_either_shape() {
        for wrapped in [false, true] {
            let mut cfg = java_config();
            let settings = json!({"java": {"project": {"referencedLibraries": ["vendor/*.jar"]}}});
            cfg.settings = Some(if wrapped { json!({"settings": settings}) } else { settings });
            configure_source_paths(&mut cfg, Some(vec!["custom".into()]));
            let settings = crate::handler::all_settings(&cfg);
            assert_eq!(settings["java"]["project"]["referencedLibraries"], json!(["vendor/*.jar"]));
            assert_eq!(settings["java"]["project"]["sourcePaths"], json!(["custom"]));
        }
    }

    #[test]
    fn run_without_an_editor_discovers_a_trigger_inside_its_source_roots() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/demo/engine")).unwrap();
        let file = dir.path().join("src/demo/engine/Main.java");
        std::fs::write(&file, "package demo.engine; public class Main {}").unwrap();
        assert_eq!(source_trigger(dir.path(), &[json!("generated"), json!("src")]), Some(file));
        assert_eq!(source_trigger(dir.path(), &[json!("tests")]), None);
    }

    #[tokio::test]
    async fn cancellation_ends_a_pending_wait() {
        let cancel = CancellationToken::new();
        let waiting = cancellable_wait(&cancel, std::future::pending::<()>());
        let cancelling = async {
            tokio::task::yield_now().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(waiting, cancelling) })
            .await
            .expect("cancelled wait must finish");
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    }

    #[test]
    fn launch_errors_are_sorted_and_capped() {
        let diag = |line: u32, severity, message: &str| lsp_types::Diagnostic {
            range: lsp_types::Range::new(lsp_types::Position::new(line, 4), lsp_types::Position::new(line, 9)),
            severity: Some(severity),
            message: message.into(),
            ..Default::default()
        };
        let (errors, count) = compile_errors(
            vec![
                (PathBuf::from("/p/B.java"), diag(1, lsp_types::DiagnosticSeverity::ERROR, "b")),
                (PathBuf::from("/p/A.java"), diag(9, lsp_types::DiagnosticSeverity::ERROR, "a2\nmore")),
                (PathBuf::from("/p/A.java"), diag(2, lsp_types::DiagnosticSeverity::WARNING, "warning")),
                (PathBuf::from("/p/A.java"), diag(3, lsp_types::DiagnosticSeverity::ERROR, "a1")),
            ],
            2,
        );
        assert_eq!(count, 3);
        let shown: Vec<(u32, u32, &str)> = errors.iter().map(|e| (e.line, e.column, e.message.as_str())).collect();
        assert_eq!(shown, [(4, 5, "a1"), (10, 5, "a2")]);
    }

    #[test]
    fn compiler_defaults_require_redirected_metadata_and_respect_server_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("compiler defaults 测试.prefs");
        std::fs::write(&file, format!("{}=warning\n{}=ignore\nother=error\n", ACCESS_OPTIONS[0], ACCESS_OPTIONS[1]))
            .unwrap();
        let mut cfg: ide_language::LanguageServerConfig = toml::from_str("name = 'jdtls'\ncommand = 'jdtls'").unwrap();
        cfg.initialization_options = Some(
            toml::Value::try_from(json!({"settings": {"java": {"settings": {"url": file.to_string_lossy()}}}}))
                .unwrap(),
        );
        assert_eq!(compiler_defaults(&cfg), json!({}));
        for prefix in ["", "--jvm-arg="] {
            cfg.args = vec![format!("{prefix}-Djava.import.generatesMetadataFilesAtProjectRoot=false")];
            assert_eq!(compiler_defaults(&cfg), json!({ACCESS_OPTIONS[0]: "warning", ACCESS_OPTIONS[1]: "ignore"}));
        }
        cfg.args.push("--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=true".into());
        assert_eq!(compiler_defaults(&cfg), json!({}), "the final JVM property wins");
        cfg.args.pop();
        cfg.settings = Some(json!({"java": {"settings": {"url": "https://example.invalid/custom.prefs"}}}));
        assert_eq!(compiler_defaults(&cfg), json!({}), "explicit server settings win");
    }

    #[test]
    fn project_settings_are_never_updated_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!cache_owned_maven_settings(root));
        std::fs::write(root.join("pom.xml"), "<project/>").unwrap();
        assert!(cache_owned_maven_settings(root));
        let lsp_uri = crate::uri::path_to_uri_string(root);
        let java_uri = lsp_uri.replacen("file://", "file:", 1);
        for uri in [lsp_uri, java_uri] {
            assert_eq!(project_path(&uri).as_deref(), Some(root));
            assert!(cache_owned_maven_settings(&project_path(&uri).unwrap()));
        }
        std::fs::create_dir(root.join(".settings")).unwrap();
        assert!(!cache_owned_maven_settings(root), "even unrelated Eclipse settings belong to the project");
        let prefs = root.join(".settings/org.eclipse.jdt.core.prefs");
        std::fs::write(&prefs, format!("{}=error\n", ACCESS_OPTIONS[0])).unwrap();
        assert!(!cache_owned_maven_settings(root));
        assert_eq!(std::fs::read_to_string(prefs).unwrap(), format!("{}=error\n", ACCESS_OPTIONS[0]));
    }

    #[test]
    fn access_warnings_do_not_hide_real_compile_errors() {
        let path = PathBuf::from("src/Main.java");
        let restriction =
            "Access restriction: The type 'BASE64Decoder' is not accessible (restriction on required library rt.jar)";
        let diagnostic = |severity, message: &str| lsp_types::Diagnostic {
            severity: Some(severity),
            message: message.into(),
            ..Default::default()
        };
        let warnings: Vec<_> = [restriction, "The type 'BASE64Encoder' is discouraged"]
            .into_iter()
            .map(|message| (path.clone(), diagnostic(lsp_types::DiagnosticSeverity::WARNING, message)))
            .collect();
        assert_eq!(compile_errors(warnings.clone(), 10), (Vec::new(), 0));
        let mut diagnostics = warnings;
        diagnostics.push((
            path.clone(),
            diagnostic(lsp_types::DiagnosticSeverity::ERROR, "Missing cannot be resolved to a type"),
        ));
        let (errors, count) = compile_errors(diagnostics, 10);
        assert_eq!(count, 1);
        assert_eq!(errors[0].message, "Missing cannot be resolved to a type");
        // A project's explicit error severity must still be respected.
        let (_, count) =
            compile_errors(vec![(path, diagnostic(lsp_types::DiagnosticSeverity::ERROR, restriction))], 10);
        assert_eq!(count, 1);
    }

    #[test]
    fn classpaths() {
        let v = json!({
            "projectRoot": "file:///p/demo",
            "classpaths": ["/p/demo/target/classes", "/m2/spring-core.jar"],
            "modulepaths": [],
        });
        let cp = parse_classpaths(&v);
        assert_eq!(cp.project_root, Some("/p/demo".into()));
        assert_eq!(cp.class_paths, ["/p/demo/target/classes", "/m2/spring-core.jar"]);
        assert!(cp.module_paths.is_empty());
        assert_eq!(parse_classpaths(&Value::Null), JavaClasspath::default());
        let java_style = parse_classpaths(&json!({ "projectRoot": "file:/p/my%20demo" }));
        assert_eq!(java_style.project_root, Some("/p/my demo".into()));
    }

    #[test]
    fn ports_settings_and_status() {
        assert_eq!(parse_port(&json!(53122)), Some(53122));
        assert_eq!(parse_port(&json!("4711")), Some(4711));
        assert_eq!(parse_port(&json!(70000)), None);
        assert_eq!(parse_port(&Value::Null), None);
        let s = json!({ "org.eclipse.jdt.ls.core.vm.location": "/jdk21" });
        assert_eq!(parse_vm_location(&s), Some(PathBuf::from("/jdk21")));
        assert_eq!(parse_vm_location(&json!({})), None);
        assert_eq!(JavaBuildStatus::from_code(1), JavaBuildStatus::Succeeded);
        assert_eq!(JavaBuildStatus::from_code(2), JavaBuildStatus::WithErrors);
        assert_eq!(JavaBuildStatus::from_code(0), JavaBuildStatus::Failed);
    }

    #[test]
    fn error_classification() {
        let e = IdeError::invalid("Given URI does not belong to any Java project.");
        assert!(not_imported(&e));
        assert!(missing_bundle(&IdeError::invalid("No delegateCommandHandler for vscode.java.startDebugSession")));
        assert!(!missing_bundle(&e));
    }
}
