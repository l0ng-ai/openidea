//! End-to-end against a real debugpy (`python3 -m debugpy --version` must work).
//! Run with `cargo test -p ide-dap --test debugpy -- --ignored`.

use ide_core::event::DebugEvent;
use ide_core::{IdeEvent, SharedSink};
use ide_dap::{Breakpoint, DebugManager, LaunchConfig, SessionOwner};
use ide_language::LanguageRegistry;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

async fn wait(events: &Mutex<Vec<IdeEvent>>, pred: impl Fn(&DebugEvent) -> bool) -> DebugEvent {
    for _ in 0..1500 {
        let hit = events.lock().iter().find_map(|e| match e {
            IdeEvent::Debug { event, .. } if pred(event) => Some(event.clone()),
            _ => None,
        });
        if let Some(e) = hit {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out; events: {:?}", events.lock());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs python3 with debugpy installed"]
async fn debugpy_end_to_end() {
    let ok = std::process::Command::new("python3").args(["-m", "debugpy", "--version"]).output();
    if !ok.is_ok_and(|o| o.status.success()) {
        eprintln!("debugpy not installed; skipping");
        return;
    }
    let dir = std::env::temp_dir().join(format!("openidea-dap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("prog.py");
    std::fs::write(
        &script,
        "def main():\n    total = 0\n    for i in range(3):\n        total += i\n    print('total', total)\n\nmain()\n",
    )
    .unwrap();
    let script = script.canonicalize().unwrap();

    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: SharedSink = Arc::new(move |e: IdeEvent| sink_events.lock().push(e));
    let manager = DebugManager::new(Arc::new(LanguageRegistry::from_configs(Vec::new())));
    let bp = Breakpoint { line: 3, condition: None, hit_condition: None, log_message: None, enabled: true };
    manager.set_breakpoints("main", script.clone(), vec![bp]).await.unwrap();
    let id = manager
        .start(
            LaunchConfig {
                name: "prog".into(),
                adapter: "debugpy".into(),
                request: "launch".into(),
                program: Some(script.to_string_lossy().into_owned()),
                args: vec![],
                cwd: Some(dir.clone().into()),
                env: BTreeMap::new(),
                extra_json: Some(r#"{"console": "internalConsole", "justMyCode": true}"#.into()),
            },
            SessionOwner::new("main", sink),
        )
        .await
        .unwrap();
    let DebugEvent::Stopped { thread_id, .. } = wait(&events, |e| matches!(e, DebugEvent::Stopped { .. })).await else {
        unreachable!()
    };
    let frames = manager.stack_trace(id, thread_id).await.unwrap();
    assert_eq!(frames[0].line, 3, "0-based");
    let scopes = manager.scopes(id, frames[0].id).await.unwrap();
    let vars = manager.variables(id, scopes[0].variables_reference).await.unwrap();
    assert!(vars.iter().any(|v| v.name == "total"), "{vars:?}");
    let v = manager.evaluate(id, Some(frames[0].id), "total + 100".into()).await.unwrap();
    assert_eq!(v.value, "100");
    manager.set_breakpoints("main", script.clone(), vec![]).await.unwrap();
    manager.resume(id, thread_id).await.unwrap();
    wait(&events, |e| matches!(e, DebugEvent::Output { output, .. } if output.contains("total 3"))).await;
    wait(&events, |e| matches!(e, DebugEvent::Terminated)).await;
    let _ = std::fs::remove_dir_all(&dir);
}
