//! A stdio server that dies before the handshake: what it printed (on stderr, and
//! on stdout outside the protocol, in any encoding) must reach the crash message.
#![cfg(unix)]

use ide_core::event::ServerStatus;
use ide_core::{CancellationToken, DocId, IdeEvent, LanguageId};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::{LspManager, ProcessLauncher};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

/// Shaped like `jdtls.bat` on a Chinese Windows whose Python step fails: an error on
/// stderr, then `pause` prompting in GBK on stdout (`请按任意键继续. . .`), reading one
/// key from stdin, exiting with an error.
const LAUNCHER: &str = r#"#!/bin/sh
echo "'python' is not recognized as an internal or external command" >&2
printf '\307\353\260\264\310\316\322\342\274\374\274\314\320\370. . . '
head -c 1 >/dev/null
printf '\r\n'
exit 1
"#;

#[tokio::test(flavor = "multi_thread")]
async fn crash_before_the_handshake_reports_what_the_server_printed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let script = root.join("fake-jdtls");
    std::fs::write(&script, LAUNCHER).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

    let server: LanguageServerConfig =
        toml::from_str(&format!("name = \"fake\"\ncommand = {:?}", script.to_string_lossy())).unwrap();
    let lang: LanguageConfig = toml::from_str("id = \"java\"\nname = \"Java\"\nextensions = [\"java\"]").unwrap();
    let lang = LanguageConfig { language_servers: vec![server], ..lang };
    let registry = Arc::new(LanguageRegistry::from_configs(vec![lang]));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let mgr = LspManager::with_launcher(root.clone(), registry, sink, Arc::new(ProcessLauncher));
    let path = root.join("A.java");
    std::fs::write(&path, "class A {}\n").unwrap();
    mgr.did_open(DocId::next(), &path, &LanguageId::new("java"), 1, "class A {}\n");

    let crashed = || {
        events.lock().iter().find_map(|e| match e {
            IdeEvent::LanguageServer { status: ServerStatus::Crashed, message, .. } => message.clone(),
            _ => None,
        })
    };
    let mut message = None;
    for _ in 0..1000 {
        message = crashed();
        if message.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let message = message.expect("the server is reported as crashed");
    assert!(message.starts_with("fake exited with code 1:\n"), "{message}");
    assert!(message.contains("'python' is not recognized"), "{message}");
    // The stdout prompt, decoded (code page 936 on Windows, lossily elsewhere).
    assert!(message.contains(". . ."), "{message}");
    mgr.shutdown_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_that_needs_a_crashed_jdtls_reports_why_it_crashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let script = root.join("fake-jdtls");
    std::fs::write(&script, LAUNCHER).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

    let server: LanguageServerConfig =
        toml::from_str(&format!("name = \"jdtls\"\ncommand = {:?}", script.to_string_lossy())).unwrap();
    let lang: LanguageConfig = toml::from_str("id = \"java\"\nname = \"Java\"\nextensions = [\"java\"]").unwrap();
    let lang = LanguageConfig { language_servers: vec![server], ..lang };
    let registry = Arc::new(LanguageRegistry::from_configs(vec![lang]));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let mgr = LspManager::with_launcher(root.clone(), registry, sink, Arc::new(ProcessLauncher));
    let path = root.join("A.java");
    std::fs::write(&path, "class A {}\n").unwrap();
    mgr.did_open(DocId::next(), &path, &LanguageId::new("java"), 1, "class A {}\n");
    for _ in 0..1000 {
        let crashed =
            events.lock().iter().any(|e| matches!(e, IdeEvent::LanguageServer { status: ServerStatus::Crashed, .. }));
        if crashed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let error = mgr.java_classpath(&path, false, &CancellationToken::new()).await.unwrap_err();
    assert!(error.message.contains("jdtls exited with code 1"), "{}", error.message);
    assert!(error.message.contains("'python' is not recognized"), "{}", error.message);
    mgr.shutdown_all().await;
}
