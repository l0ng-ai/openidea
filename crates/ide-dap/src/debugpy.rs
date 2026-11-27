//! Python Debug Server (`attach` with `listen`): the program connects with its own debugpy,
//! which may differ from the IDE's adapter. Nothing in the protocol compares them.

use crate::session::Session;
use ide_core::IdeError;
use ide_core::event::DebugEvent;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

pub(crate) fn listens(adapter: &str, request: &str, arguments: &Value) -> bool {
    adapter == "debugpy" && request == "attach" && arguments.get("listen").is_some()
}

/// debugpy's adapter leaves an `attach` whose port is taken unanswered (it only logs the error),
/// which would wait for the program forever: find out before starting it. Listening again right
/// after a program ended races the previous adapter, which still listens until its shutdown ends.
pub(crate) async fn require_free_port(arguments: &Value) -> Result<(), IdeError> {
    // ponytail: polls; waiting on the previous session's shutdown would report a taken port sooner.
    const RELEASE: Duration = Duration::from_secs(5);
    let listen = &arguments["listen"];
    let host = listen["host"].as_str().unwrap_or("127.0.0.1");
    let Some(port) = listen["port"].as_u64().and_then(|p| u16::try_from(p).ok()) else { return Ok(()) };
    let deadline = tokio::time::Instant::now() + RELEASE;
    loop {
        match std::net::TcpListener::bind((host, port)) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => return Err(IdeError::unavailable(format!("Cannot listen on {host}:{port}: {e}"))),
        }
    }
}

/// On the program's first stop: warns in the Debug console when its debugpy is not the adapter's.
/// Evaluated in the stopped frame as a hover: without a frame, debugpy before 1.8 runs the
/// expression as a statement and prints its value into the program's output.
pub(crate) async fn check_version(s: Arc<Session>, thread: i64) {
    const WAIT: Duration = Duration::from_secs(5);
    let request = |command: &'static str, arguments: Value| s.conn.request_timeout(command, arguments, WAIT);
    let Ok(info) = request("debugpySystemInfo", json!({})).await else { return };
    let Some(ide) = info.pointer("/debugpy/version").and_then(Value::as_str) else { return };
    let Ok(trace) = request("stackTrace", json!({ "threadId": thread, "levels": 1 })).await else { return };
    let Some(frame) = trace.pointer("/stackFrames/0/id").and_then(Value::as_i64) else { return };
    let expression = json!({ "expression": "__import__('debugpy').__version__", "frameId": frame, "context": "hover" });
    let Ok(reply) = request("evaluate", expression).await else { return };
    let Some(program) = reply.get("result").and_then(Value::as_str) else { return };
    if let Some(warning) = version_warning(ide, program) {
        s.emit(DebugEvent::Output { category: "console".into(), output: warning });
    }
}

fn version_warning(ide: &str, program: &str) -> Option<String> {
    let program = program.trim_matches(|c| c == '\'' || c == '"');
    (program != ide).then(|| {
        format!(
            "The program uses debugpy {program}, the IDE's debugger debugpy {ide}. If breakpoints or stepping \
             misbehave, install the same version where the program runs: pip install debugpy=={ide}\n"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_only_when_versions_differ() {
        assert_eq!(version_warning("1.8.22", "'1.8.22'"), None);
        assert_eq!(version_warning("1.8.22", "1.8.22"), None);
        let w = version_warning("1.8.22", "'1.8.0'").unwrap();
        assert!(w.contains("debugpy 1.8.0") && w.ends_with("pip install debugpy==1.8.22\n"), "{w}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_taken_port_is_reported_before_the_adapter_starts() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let listen = json!({"listen": {"host": "127.0.0.1", "port": port}});
        let e = require_free_port(&listen).await.unwrap_err();
        assert!(e.to_string().contains(&format!("Cannot listen on 127.0.0.1:{port}")), "{e}");
        drop(taken);
        assert!(require_free_port(&listen).await.is_ok());
    }

    #[tokio::test]
    async fn an_address_the_machine_lacks_is_reported_at_once() {
        // 192.0.2.0/24 is reserved for documentation, never a local address.
        let started = std::time::Instant::now();
        let e = require_free_port(&json!({"listen": {"host": "192.0.2.1", "port": 5678}})).await.unwrap_err();
        assert!(e.to_string().contains("Cannot listen on 192.0.2.1:5678"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn waits_for_the_previous_adapter_to_release_the_port() {
        let previous = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = previous.local_addr().unwrap().port();
        let released = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(previous);
        });
        require_free_port(&json!({"listen": {"host": "127.0.0.1", "port": port}})).await.unwrap();
        released.await.unwrap();
    }

    #[test]
    fn only_debugpy_listen_attaches_check() {
        assert!(listens("debugpy", "attach", &json!({"listen": {"port": 5678}})));
        assert!(!listens("debugpy", "attach", &json!({"connect": {"port": 5678}})));
        assert!(!listens("debugpy", "launch", &json!({"listen": {}})));
    }
}
