#![cfg(windows)]

use ide_core::{IdeEvent, SharedSink};
use ide_run::{OutputChunk, ProcessManager, RunConfig, StartOptions};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

/// Stdout and stderr of a shell command line run on pipes in a UTF-8 console.
fn run(command: &str) -> String {
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: SharedSink = Arc::new(move |e: IdeEvent| {
        let _ = tx.lock().send(e);
    });
    let root = tempfile::tempdir().unwrap();
    let config = RunConfig {
        id: "t:out".into(),
        name: "t:out".into(),
        kind: "shell".into(),
        command: command.into(),
        args: Vec::new(),
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let chunks: Arc<Mutex<Vec<OutputChunk>>> = Arc::default();
    let out = chunks.clone();
    let pm = ProcessManager::new();
    let info = pm
        .start(root.path(), &config, &StartOptions::default(), sink, Box::new(move |c| out.lock().push(c)))
        .expect("start");
    loop {
        match events.recv_timeout(Duration::from_secs(20)).expect("RunExited event") {
            IdeEvent::RunExited { run, .. } if run == info.id => break,
            _ => {}
        }
    }
    chunks
        .lock()
        .iter()
        .filter_map(|c| match c {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// `cmd`'s own messages reach the pipe in the console code page (GBK, Shift_JIS, EUC-KR,
/// 437…, by the system's language), and still read right in a UTF-8 console.
#[test]
fn native_messages_in_the_console_code_page_are_decoded() {
    let text = run(r"dir C:\openidea-no-such-dir");
    assert!(text.trim().lines().count() >= 2, "{text:?}");
    assert!(!text.contains('\u{FFFD}'), "{text:?}");
}

/// `cmd /u` writes UTF-16LE, as `wsl.exe` does; it reads right whatever the system's language.
#[test]
fn utf16_output_is_decoded() {
    let text = run("cmd /u /c echo 中文 한국어 OK");
    assert_eq!(text, "中文 한국어 OK\r\n");
}
