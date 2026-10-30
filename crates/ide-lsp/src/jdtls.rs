//! jdtls extensions used to run and debug Java: workspace build, runtime
//! classpaths and the project's JDK (`java.project.*`), and the java-debug
//! bundle's debug server (`vscode.java.startDebugSession`).
//!
//! jdtls is started on demand for the module, so a run configuration works
//! without a Java editor open.

use crate::LspManager;
use crate::server::{Running, Server};
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeResult, LanguageId};
use ide_jsonrpc::RpcError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SERVER: &str = "jdtls";
/// First start imports the Maven / Gradle model, which can take minutes.
const READY_TIMEOUT: Duration = Duration::from_secs(240);
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// How long to retry while the project is still being imported.
const IMPORT_WAIT: Duration = Duration::from_secs(90);
/// Compile errors listed with a launch; the rest are only counted.
const MAX_LAUNCH_ERRORS: usize = 10;
/// Build markers can be published just after `java/buildWorkspace` answers.
const ERRORS_WAIT: Duration = Duration::from_secs(2);

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
        project_root: v.get("projectRoot").and_then(Value::as_str).map(|r| {
            // jdtls answers `file:/p/demo` (Java URI style) as well as `file:///p/demo`.
            let normalized = match r.strip_prefix("file:") {
                Some(rest) if !rest.starts_with("//") => format!("file://{rest}"),
                _ => r.to_owned(),
            };
            crate::uri::uri_to_path(&normalized).unwrap_or_else(|| PathBuf::from(r)).into()
        }),
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

impl LspManager {
    /// The jdtls instance serving `path` (a module directory or source file),
    /// started if needed and waited for.
    async fn jdtls(&self, path: &Path) -> IdeResult<(Arc<Server>, Running)> {
        let java = LanguageId::new("java");
        let server = self
            .servers_for(&java, path)
            .into_iter()
            .find(|s| s.name == SERVER)
            .ok_or_else(|| IdeError::unavailable("no Java language server (jdtls) is configured"))?;
        self.ensure_started(&server);
        match server.wait_ready(READY_TIMEOUT).await {
            Some(run) => Ok((server, run)),
            None => {
                let status = server.status();
                Err(IdeError::unavailable(match status {
                    ide_core::event::ServerStatus::Missing => {
                        "jdtls is not installed (Settings › Languages & Frameworks › Language Servers)".to_owned()
                    }
                    ide_core::event::ServerStatus::Misconfigured => {
                        server.status_message().unwrap_or_else(|| "jdtls cannot start".to_owned())
                    }
                    _ => format!("jdtls is not ready ({status:?})"),
                }))
            }
        }
    }

    async fn jdtls_request(&self, path: &Path, method: &str, params: Value, timeout: Duration) -> IdeResult<Value> {
        let (server, run) = self.jdtls(path).await?;
        let fut = run.peer.request::<Value, Value>(method, params, None);
        match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r.map_err(|e| crate::rpc_err(&server.name, method, e)),
            Err(_) => Err(crate::rpc_err(&server.name, method, RpcError::Timeout)),
        }
    }

    /// `workspace/executeCommand` on the jdtls serving `path`.
    pub async fn jdtls_command(&self, path: &Path, command: &str, arguments: Vec<Value>) -> IdeResult<Value> {
        self.jdtls_request(
            path,
            "workspace/executeCommand",
            json!({ "command": command, "arguments": arguments }),
            COMMAND_TIMEOUT,
        )
        .await
    }

    /// Like [`jdtls_command`](Self::jdtls_command), retried while the project is still importing.
    async fn jdtls_project_command(&self, path: &Path, command: &str, arguments: Vec<Value>) -> IdeResult<Value> {
        let deadline = Instant::now() + IMPORT_WAIT;
        loop {
            match self.jdtls_command(path, command, arguments.clone()).await {
                Err(e) if not_imported(&e) && Instant::now() < deadline => {
                    tracing::debug!("{command}: {e}; waiting for the project import");
                    tokio::time::sleep(Duration::from_millis(1500)).await;
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

    /// Incremental build of the jdtls workspace (`java/buildWorkspace`), so
    /// class files are up to date before a launch.
    pub async fn java_build(&self, path: &Path) -> IdeResult<JavaBuildStatus> {
        let v = self.jdtls_request(path, "java/buildWorkspace", json!(false), BUILD_TIMEOUT).await?;
        Ok(JavaBuildStatus::from_code(v.as_i64().unwrap_or(0)))
    }

    /// Runtime (`test == false`) or test classpath of the project containing `path`.
    pub async fn java_classpath(&self, path: &Path, test: bool) -> IdeResult<JavaClasspath> {
        let uri = crate::uri::path_to_uri_string(path);
        let options = json!({ "scope": if test { "test" } else { "runtime" } }).to_string();
        let v =
            self.jdtls_project_command(path, "java.project.getClasspaths", vec![json!(uri), json!(options)]).await?;
        Ok(parse_classpaths(&v))
    }

    /// The JDK home jdtls uses for the project containing `path`.
    pub async fn java_vm_location(&self, path: &Path) -> IdeResult<Option<PathBuf>> {
        let uri = crate::uri::path_to_uri_string(path);
        let v = self
            .jdtls_project_command(
                path,
                "java.project.getSettings",
                vec![json!(uri), json!(["org.eclipse.jdt.ls.core.vm.location"])],
            )
            .await?;
        Ok(parse_vm_location(&v))
    }

    /// Builds (when asked), then resolves the classpath and JDK of the module at `module`.
    pub async fn java_launch(&self, module: &Path, test: bool, build: bool) -> IdeResult<JavaLaunchInfo> {
        let build = if build { Some(self.java_build(module).await?) } else { None };
        let (errors, error_count) = match build {
            Some(JavaBuildStatus::WithErrors | JavaBuildStatus::Failed) => self.java_compile_errors(module).await,
            _ => (Vec::new(), 0),
        };
        let cp = self.java_classpath(module, test).await?;
        let java_home = match self.java_vm_location(module).await {
            Ok(home) => home,
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
        let Ok((server, _)) = self.jdtls(module).await else { return (Vec::new(), 0) };
        let collect = || compile_errors(server.diagnostics_snapshot(), MAX_LAUNCH_ERRORS);
        let found = collect();
        if found.1 > 0 {
            return found;
        }
        let _ = tokio::time::timeout(ERRORS_WAIT, server.published_notify.notified()).await;
        collect()
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
        let settings = json!({ "hotCodeReplace": "auto", "showStaticVariables": false, "showQualifiedNames": false,
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
