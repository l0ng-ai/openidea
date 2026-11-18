//! Java project queries for launches when jdtls does not serve the module: another Java
//! language server (java-analyzer) answers the classpath and JDK, if it supports it.

use crate::LspManager;
use crate::jdtls::{JavaClasspath, SERVER as JDTLS};
use ide_core::{CancellationToken, IdeError, IdeResult, LanguageId};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `{ uri, scope: "runtime" | "test" }` → `{ projectRoot, classPaths, modulePaths, jdkHome }`.
const CLASSPATH: &str = "java-analyzer/projectClasspath";
/// Waiting for the server to start and import the project.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Classpath and JDK of a module, as a Java language server other than jdtls computes them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServerClasspath {
    pub classpath: JavaClasspath,
    pub jdk_home: Option<PathBuf>,
}

impl LspManager {
    /// Whether jdtls serves the Java files of `path`. Without it, launches build with the
    /// build tool and take the classpath from [`Self::java_server_classpath`] or the build model.
    pub fn java_served_by_jdtls(&self, path: &Path) -> bool {
        self.servers_for(&LanguageId::new("java"), path).iter().any(|s| s.name == JDTLS)
    }

    /// The java-analyzer executable among the Java servers of `path`, whatever the server is
    /// named in settings: its `dap` subcommand debugs modules jdtls doesn't serve.
    pub fn java_analyzer_binary(&self, path: &Path) -> Option<PathBuf> {
        self.servers_for(&LanguageId::new("java"), path).into_iter().find_map(|s| {
            let binary = s.resolved_binary.read().clone().unwrap_or_else(|| s.effective_config().command.into());
            is_java_analyzer(&binary).then_some(binary)
        })
    }

    /// Runtime (`test == false`) or test classpath of the module at `path` from the first
    /// Java server other than jdtls. `None` when there is none or it doesn't support the query.
    pub async fn java_server_classpath(
        &self,
        path: &Path,
        test: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<ServerClasspath>> {
        let Some(server) =
            self.servers_for(&LanguageId::new("java"), path).into_iter().find(|s| s.name != JDTLS && !s.gave_up())
        else {
            return Ok(None);
        };
        self.ensure_started(&server);
        let Some(run) = crate::jdtls::cancellable_wait(cancel, server.wait_ready(READY_TIMEOUT)).await? else {
            tracing::debug!(server = server.name, "Java server not ready; no classpath from it");
            return Ok(None);
        };
        let params = json!({
            "uri": crate::uri::path_to_uri_string(path),
            "scope": if test { "test" } else { "runtime" },
        });
        let request = run.peer.request::<Value, Value>(CLASSPATH, params, Some(cancel.clone()));
        match tokio::time::timeout(REQUEST_TIMEOUT, request).await {
            Ok(Ok(v)) => Ok(parse(&v)),
            Ok(Err(ide_jsonrpc::RpcError::Server { code: ide_jsonrpc::codes::METHOD_NOT_FOUND, .. })) => Ok(None),
            Ok(Err(e)) if cancel.is_cancelled() => {
                tracing::debug!("{CLASSPATH}: {e}");
                Err(IdeError::cancelled())
            }
            Ok(Err(e)) => Err(crate::rpc_err(&server.name, CLASSPATH, e)),
            Err(_) => Err(IdeError::unavailable(format!(
                "{}: {CLASSPATH} timed out after {} s",
                server.name,
                REQUEST_TIMEOUT.as_secs()
            ))),
        }
    }
}

/// `None` for a `null` answer (the server has no module for the path).
fn parse(v: &Value) -> Option<ServerClasspath> {
    if v.is_null() {
        return None;
    }
    let strings = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    let path = |key: &str| v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from);
    Some(ServerClasspath {
        classpath: JavaClasspath {
            project_root: path("projectRoot").map(Into::into),
            class_paths: strings("classPaths"),
            module_paths: strings("modulePaths"),
        },
        jdk_home: path("jdkHome"),
    })
}

/// `java-analyzer` or `java-analyzer.exe`, wherever it is installed.
fn is_java_analyzer(binary: &Path) -> bool {
    binary.file_stem().is_some_and(|stem| stem == "java-analyzer")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_java_analyzer_by_its_executable() {
        assert!(is_java_analyzer(Path::new("/src/java-analyzer/target/release/java-analyzer")));
        assert!(is_java_analyzer(Path::new("java-analyzer")));
        assert!(is_java_analyzer(Path::new("/tools/java-analyzer.exe")));
        assert!(!is_java_analyzer(Path::new("/opt/jdtls/bin/jdtls")));
        assert!(!is_java_analyzer(Path::new("/opt/java-analyzer/bin/start.sh")));
    }

    #[test]
    fn parses_a_classpath_answer() {
        let v = json!({
            "projectRoot": "/p/app",
            "classPaths": ["/p/app/target/classes", "/m2/a.jar"],
            "modulePaths": [],
            "outputDirs": ["/p/app/target/classes"],
            "jdkHome": "/jdk",
            "languageLevel": 17,
        });
        let cp = parse(&v).unwrap();
        assert_eq!(cp.classpath.class_paths, ["/p/app/target/classes", "/m2/a.jar"]);
        assert!(cp.classpath.module_paths.is_empty());
        assert_eq!(cp.classpath.project_root, Some(PathBuf::from("/p/app").into()));
        assert_eq!(cp.jdk_home, Some(PathBuf::from("/jdk")));
    }

    #[test]
    fn a_null_answer_has_no_classpath() {
        assert_eq!(parse(&Value::Null), None);
        assert_eq!(parse(&json!({ "classPaths": [], "jdkHome": "" })).unwrap().jdk_home, None);
    }
}
