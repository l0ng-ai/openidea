//! Protocol flow against an in-memory fake adapter.

use super::*;
use crate::adapter::{AdapterIo, LaunchFuture};
use ide_core::IdeEvent;
use ide_core::event::DebugEvent;
use ide_jsonrpc::framing;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Clone)]
struct Script {
    /// Send a `runInTerminal` reverse request when `launch` arrives.
    run_in_terminal: Option<Vec<String>>,
    /// Send a `startDebugging` reverse request (child session) when a non-child `launch` arrives.
    start_debugging: bool,
    ignore_configuration_done: bool,
    source_path: Option<String>,
    /// Report this process id in the adapter's `process` event (the program being debugged).
    debuggee_pid: Option<u32>,
    /// java-debug's spelling of the same event.
    java_process_id: bool,
    /// Send one more output event right after the `terminated` event (a program still logging
    /// while it shuts down).
    output_after_terminate: bool,
    /// Advertise `supportsTerminateRequest` (java-debug does not, so Stop signals the program).
    supports_terminate: bool,
    /// Answer `setBreakpoints` only once this many are waiting (a client that waits for each never gets one).
    hold_set_breakpoints: usize,
    /// Send a `continued` event right after the first `stopped` one.
    continued_after_stop: bool,
    /// Close the connection when a `pause` request arrives (the adapter dies).
    hang_up_on_pause: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            run_in_terminal: None,
            start_debugging: false,
            ignore_configuration_done: false,
            source_path: None,
            debuggee_pid: None,
            java_process_id: false,
            output_after_terminate: false,
            supports_terminate: true,
            hold_set_breakpoints: 0,
            continued_after_stop: false,
            hang_up_on_pause: false,
        }
    }
}

struct FakeLauncher {
    log: Log,
    script: Script,
}

impl AdapterLauncher for FakeLauncher {
    fn launch(&self, _spec: AdapterSpec, _reuse: Option<u16>) -> LaunchFuture {
        let (client, server) = tokio::io::duplex(1 << 16);
        let log = self.log.clone();
        let script = self.script.clone();
        tokio::spawn(fake_adapter(server, log, script));
        let (r, w) = tokio::io::split(client);
        Box::pin(async move {
            Ok(AdapterIo {
                reader: Box::new(r),
                writer: Box::new(w),
                child: None,
                port: None,
                stderr: Arc::default(),
                program_output: None,
            })
        })
    }
}

async fn fake_adapter<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(stream: S, log: Log, script: Script) {
    let (r, mut w) = tokio::io::split(stream);
    let mut r = BufReader::new(r);
    let mut seq = 1000;
    let mut pending_launch: Option<i64> = None;
    let mut held: Vec<Value> = Vec::new();
    macro_rules! send {
        ($v:expr) => {{
            let mut v: Value = $v;
            seq += 1;
            v["seq"] = seq.into();
            framing::write_message(&mut w, &serde_json::to_vec(&v).unwrap()).await.unwrap();
        }};
    }
    macro_rules! ok {
        ($req:expr, $body:expr) => {
            send!(json!({"type": "response", "request_seq": $req["seq"], "command": $req["command"], "success": true, "body": $body}))
        };
    }
    while let Ok(Some(body)) = framing::read_message(&mut r).await {
        let msg: Value = serde_json::from_slice(&body).unwrap();
        log.lock().push(msg.clone());
        if msg["type"] == "response" {
            continue;
        }
        match msg["command"].as_str().unwrap_or_default() {
            "initialize" => ok!(
                msg,
                json!({
                    "supportsConfigurationDoneRequest": true,
                    "supportsCompletionsRequest": true,
                    "supportsTerminateRequest": script.supports_terminate,
                    "supportsSetVariable": true,
                    "supportsFunctionBreakpoints": true,
                    "supportsDataBreakpoints": true,
                    "supportsStepInTargetsRequest": true,
                    "supportsRestartFrame": true,
                    "exceptionBreakpointFilters": [
                        {"filter": "raised", "label": "Raised"},
                        {"filter": "uncaught", "label": "Uncaught", "default": true, "description": "Uncaught exceptions"},
                    ],
                })
            ),
            "launch" | "attach" => {
                pending_launch = msg["seq"].as_i64();
                if let Some(args) = &script.run_in_terminal {
                    send!(
                        json!({"type": "request", "command": "runInTerminal", "arguments": {"kind": "integrated", "args": args, "cwd": std::env::temp_dir()}})
                    );
                }
                if script.start_debugging && msg["arguments"]["isChild"] != true {
                    send!(
                        json!({"type": "request", "command": "startDebugging", "arguments": {"request": "launch", "configuration": {"name": "child", "isChild": true}}})
                    );
                }
                send!(json!({"type": "event", "event": "initialized"}));
            }
            "setBreakpoints" => {
                held.push(msg);
                if held.len() < script.hold_set_breakpoints {
                    continue;
                }
                for msg in std::mem::take(&mut held) {
                    let bps: Vec<Value> = msg["arguments"]["breakpoints"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(i, b)| json!({"id": i + 1, "verified": true, "line": b["line"]}))
                        .collect();
                    ok!(msg, json!({"breakpoints": bps}));
                }
            }
            "setExceptionBreakpoints" => ok!(msg, json!({})),
            "setFunctionBreakpoints" | "setDataBreakpoints" => {
                let bps: Vec<Value> = msg["arguments"]["breakpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| json!({"verified": b["name"] != "missing", "message": b["name"]}))
                    .collect();
                ok!(msg, json!({"breakpoints": bps}));
            }
            "dataBreakpointInfo" => ok!(
                msg,
                json!({"dataId": format!("Req#{}", msg["arguments"]["name"].as_str().unwrap()), "description": "field", "accessTypes": ["write", "read"]})
            ),
            "stepInTargets" => ok!(
                msg,
                json!({"targets": [{"id": 1, "label": "parse()", "line": 5, "column": 9, "endColumn": 16}, {"id": 2, "label": "run()"}]})
            ),
            "restartFrame" => {
                ok!(msg, Value::Null);
                send!(json!({"type": "event", "event": "stopped", "body": {"reason": "restart", "threadId": 1}}));
            }
            "next" => {
                ok!(msg, Value::Null);
                send!(json!({"type": "event", "event": "stopped", "body": {"reason": "step", "threadId": 1}}));
            }
            "setVariable" => {
                ok!(msg, json!({"value": format!("{}!", msg["arguments"]["value"].as_str().unwrap()), "type": "int"}))
            }
            "configurationDone" => {
                if !script.ignore_configuration_done {
                    ok!(msg, Value::Null);
                }
                if let Some(l) = pending_launch.take() {
                    send!(json!({"type": "response", "request_seq": l, "command": "launch", "success": true}));
                }
                if let Some(pid) = script.debuggee_pid {
                    let event = if script.java_process_id {
                        json!({"type": "event", "event": "processid", "body": {"processId": pid, "shellProcessId": pid}})
                    } else {
                        json!({"type": "event", "event": "process", "body": {"name": "prog", "systemProcessId": pid}})
                    };
                    send!(event);
                }
                send!(json!({"type": "event", "event": "output", "body": {"category": "stdout", "output": "hello\n"}}));
                send!(
                    json!({"type": "event", "event": "stopped", "body": {"reason": "breakpoint", "threadId": 1, "allThreadsStopped": true}})
                );
                if script.continued_after_stop {
                    send!(json!({"type": "event", "event": "continued", "body": {"threadId": 1}}));
                }
                send!(
                    json!({"type": "event", "event": "breakpoint", "body": {"reason": "changed", "breakpoint": {"id": 1, "verified": false, "message": "moved", "line": 9, "source": {"path": script.source_path}}}})
                );
            }
            "threads" => ok!(msg, json!({"threads": [{"id": 1, "name": "MainThread"}]})),
            "stackTrace" => ok!(
                msg,
                json!({"stackFrames": [
                    {"id": 10, "name": "main", "line": 5, "column": 3, "source": {"path": script.source_path.as_deref().unwrap_or("/p/a.py")}},
                    {"id": 11, "name": "lib", "line": 1, "column": 1, "source": {"path": "/usr/lib/x.py", "presentationHint": "deemphasize"}},
                ]})
            ),
            "scopes" => {
                ok!(msg, json!({"scopes": [{"name": "Locals", "variablesReference": 100, "expensive": false}]}))
            }
            "variables" => ok!(
                msg,
                json!({"variables": [
                    {"name": "x", "value": "1", "type": "int", "variablesReference": 0},
                    {"name": "req", "value": "{Req}", "type": "Req", "variablesReference": 101, "evaluateName": "req"},
                ]})
            ),
            "evaluate" => ok!(msg, json!({"result": "42", "type": "int", "variablesReference": 0})),
            "completions" => ok!(
                msg,
                json!({"targets": [
                    {"label": "getName()", "text": "getName", "type": "method", "detail": "String"},
                    {"label": "name", "type": "field"},
                    {"label": ""},
                ]})
            ),
            "continue" => {
                ok!(msg, json!({"allThreadsContinued": true}));
                send!(json!({"type": "event", "event": "exited", "body": {"exitCode": 3}}));
                send!(json!({"type": "event", "event": "terminated"}));
            }
            "pause" if script.hang_up_on_pause => break,
            "stepIn" | "stepOut" | "pause" => ok!(msg, Value::Null),
            "redefineClasses" => {
                send!(
                    json!({"type": "event", "event": "hotcodereplace", "body": {"changeType": "STARTING", "message": "Start hot code replacement procedure..."}})
                );
                ok!(msg, json!({"changedClasses": ["com.x.App"]}));
                send!(
                    json!({"type": "event", "event": "hotcodereplace", "body": {"changeType": 3, "message": "Build completed"}})
                );
            }
            "terminate" => {
                ok!(msg, Value::Null);
                send!(json!({"type": "event", "event": "terminated"}));
                if script.output_after_terminate {
                    send!(
                        json!({"type": "event", "event": "output", "body": {"category": "stdout", "output": "late\n"}})
                    );
                }
            }
            "disconnect" => {
                ok!(msg, Value::Null);
                let _ = w.shutdown().await;
                break;
            }
            other => send!(
                json!({"type": "response", "request_seq": msg["seq"], "command": other, "success": false, "message": "unsupported"})
            ),
        }
    }
}

struct Harness {
    manager: Arc<DebugManager>,
    log: Log,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    owner: SessionOwner,
}

/// An owner whose events are collected in the returned list.
fn recording_owner(key: &str) -> (SessionOwner, Arc<Mutex<Vec<IdeEvent>>>) {
    let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: SharedSink = Arc::new(move |e: IdeEvent| sink_events.lock().push(e));
    (SessionOwner::new(key, sink), events)
}

fn harness(script: Script) -> Harness {
    let log: Log = Arc::default();
    let (owner, events) = recording_owner("main");
    let manager = DebugManager::with_launcher(
        Arc::new(LanguageRegistry::from_configs(Vec::new())),
        Arc::new(FakeLauncher { log: log.clone(), script }),
    );
    // A local attach must not send requests to the developer's own JVMs.
    manager.set_jvm_finder(Arc::new(|_, _| None));
    Harness { manager, log, events, owner }
}

/// Session ids that appear in debug events.
fn event_sessions(events: &Mutex<Vec<IdeEvent>>) -> std::collections::BTreeSet<u32> {
    events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::Debug { session, .. } => Some(session.0),
            _ => None,
        })
        .collect()
}

impl Harness {
    async fn start(&self, config: LaunchConfig) -> IdeResult<DebugSessionId> {
        self.manager.start(config, self.owner.clone()).await
    }

    async fn wait_event(&self, pred: impl Fn(&DebugEvent) -> bool) -> DebugEvent {
        for _ in 0..200 {
            let found = self.events.lock().iter().find_map(|e| match e {
                IdeEvent::Debug { event, .. } if pred(event) => Some(event.clone()),
                _ => None,
            });
            if let Some(e) = found {
                return e;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("event not received; got {:?}", self.events.lock());
    }

    fn commands(&self) -> Vec<String> {
        self.log
            .lock()
            .iter()
            .filter(|m| m["type"] == "request")
            .map(|m| m["command"].as_str().unwrap().to_owned())
            .collect()
    }

    fn request(&self, command: &str) -> Value {
        self.log.lock().iter().find(|m| m["command"] == command && m["type"] == "request").cloned().unwrap()
    }
}

fn config() -> LaunchConfig {
    LaunchConfig {
        name: "app".into(),
        adapter: "debugpy".into(),
        request: "launch".into(),
        program: Some("/p/a.py".into()),
        args: vec!["--flag".into()],
        cwd: Some("/p".into()),
        env: BTreeMap::from([("A".into(), "1".into())]),
        extra_json: Some(r#"{"justMyCode": false, "args": ["--override"]}"#.into()),
    }
}

fn bp(line: u32) -> Breakpoint {
    Breakpoint { line, condition: None, hit_condition: None, log_message: None, enabled: true }
}

#[tokio::test]
async fn full_protocol_flow() {
    let h = harness(Script::default());
    let path = PathBuf::from("/p/a.py");
    let disabled = Breakpoint { enabled: false, ..bp(2) };
    let cond = Breakpoint { condition: Some("x > 1".into()), ..bp(7) };
    let states = h.manager.set_breakpoints(path.clone(), vec![bp(4), disabled, cond]).await.unwrap();
    assert!(states.iter().all(|s| !s.verified), "no session yet");

    let id = h.start(config()).await.unwrap();
    assert!(
        matches!(h.events.lock().first(), Some(IdeEvent::Debug { session, event: DebugEvent::Started { parent: None, .. } }) if *session == id),
        "a session is announced first"
    );
    assert_eq!(
        h.commands(),
        ["initialize", "launch", "setBreakpoints", "setExceptionBreakpoints", "configurationDone"],
        "lifecycle order"
    );
    let init = h.request("initialize");
    assert_eq!(init["arguments"]["clientID"], "openidea");
    assert_eq!(init["arguments"]["linesStartAt1"], true);
    assert_eq!(init["arguments"]["columnsStartAt1"], true);
    assert_eq!(init["arguments"]["pathFormat"], "path");
    assert_eq!(init["arguments"]["supportsRunInTerminalRequest"], true);
    let launch = h.request("launch");
    assert_eq!(launch["arguments"]["program"], "/p/a.py");
    assert_eq!(launch["arguments"]["args"], json!(["--override"]), "extra_json wins");
    assert_eq!(launch["arguments"]["justMyCode"], false);
    assert_eq!(launch["arguments"]["env"]["A"], "1");
    assert_eq!(launch["arguments"]["cwd"], "/p");
    let sb = h.request("setBreakpoints");
    assert_eq!(sb["arguments"]["source"]["path"], "/p/a.py");
    // 0-based → 1-based, disabled omitted, condition passed through.
    assert_eq!(sb["arguments"]["breakpoints"], json!([{"line": 5}, {"line": 8, "condition": "x > 1"}]));
    assert_eq!(h.request("setExceptionBreakpoints")["arguments"]["filters"], json!(["uncaught"]), "defaults");

    match h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await {
        DebugEvent::Stopped { thread_id, reason, all_threads_stopped, .. } => {
            assert_eq!((thread_id, reason.as_str(), all_threads_stopped), (1, "breakpoint", true));
        }
        _ => unreachable!(),
    }
    h.wait_event(
        |e| matches!(e, DebugEvent::Output { category, output } if category == "stdout" && output == "hello\n"),
    )
    .await;
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;

    // Breakpoint states: stored after configuration, updated by the `breakpoint` event (id 1 → first bp).
    h.wait_event(|e| matches!(e, DebugEvent::BreakpointsChanged { path } if path.ends_with("a.py"))).await;
    for _ in 0..100 {
        if h.manager.breakpoint_states(&path).first().is_some_and(|s| !s.verified) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let states = h.manager.breakpoint_states(&path);
    assert_eq!(states[0], BreakpointState { line: 8, verified: false, message: Some("moved".into()) });
    assert_eq!(states[1].message.as_deref(), Some("Disabled"));
    assert!(states[2].verified);

    let threads = h.manager.threads(id).await.unwrap();
    assert_eq!((threads[0].id, threads[0].name.as_str()), (1, "MainThread"));
    let frames = h.manager.stack_trace(id, 1).await.unwrap();
    assert_eq!((frames[0].line, frames[0].column), (4, 2), "1-based → 0-based");
    assert_eq!(frames[0].path.as_deref(), Some(Path::new("/p/a.py")));
    assert_eq!(frames[1].presentation_hint.as_deref(), Some("subtle"));
    let scopes = h.manager.scopes(id, 10).await.unwrap();
    assert_eq!(scopes[0].variables_reference, 100);
    let vars = h.manager.variables(id, 100).await.unwrap();
    assert_eq!(vars[0].type_name.as_deref(), Some("int"));
    assert_eq!(vars[1].variables_reference, 101);
    let v = h.manager.evaluate_in(id, Some(10), "x * 42".into(), Some("watch".into())).await.unwrap();
    assert_eq!((v.name.as_str(), v.value.as_str()), ("x * 42", "42"));
    let eval = h.request("evaluate");
    assert_eq!(eval["arguments"]["context"], "watch");
    assert_eq!(eval["arguments"]["frameId"], 10);
    let items = h.manager.completions(id, Some(10), "req.na".into(), 0, 6).await.unwrap();
    assert_eq!(
        items.iter().map(|c| (c.label.as_str(), c.text.as_deref(), c.kind.as_deref())).collect::<Vec<_>>(),
        [("getName()", Some("getName"), Some("method")), ("name", None, Some("field"))]
    );
    let asked = h.request("completions");
    assert_eq!((asked["arguments"]["line"].clone(), asked["arguments"]["column"].clone()), (json!(1), json!(7)));
    assert_eq!(asked["arguments"]["frameId"], 10);

    // Live breakpoint updates reach the session.
    let states = h.manager.set_breakpoints(path.clone(), vec![bp(0)]).await.unwrap();
    assert!(states[0].verified);

    h.manager.resume(id, 1).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Continued { thread_id: 1, .. })).await;
    h.wait_event(|e| matches!(e, DebugEvent::Exited { code: 3 })).await;
    h.wait_event(|e| matches!(e, DebugEvent::Terminated)).await;
    for _ in 0..100 {
        if h.manager.sessions(None).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(h.manager.sessions(None).is_empty(), "session removed after termination");
    assert!(h.commands().contains(&"disconnect".to_owned()));
    let terminated =
        h.events.lock().iter().filter(|e| matches!(e, IdeEvent::Debug { event: DebugEvent::Terminated, .. })).count();
    assert_eq!(terminated, 1, "terminated emitted once");
}

#[tokio::test]
async fn run_to_cursor_uses_temporary_breakpoint() {
    let h = harness(Script::default());
    let path = PathBuf::from("/p/a.py");
    h.manager.set_breakpoints(path.clone(), vec![bp(1)]).await.unwrap();
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    h.manager.run_to(id, 1, path.clone(), 9, false).await.unwrap();
    let sets: Vec<Value> = h
        .log
        .lock()
        .iter()
        .filter(|m| m["command"] == "setBreakpoints" && m["type"] == "request")
        .map(|m| m["arguments"]["breakpoints"].clone())
        .collect();
    assert_eq!(sets.last().unwrap(), &json!([{"line": 2}, {"line": 10}]));
    assert!(h.commands().contains(&"continue".to_owned()));
}

#[tokio::test]
async fn stop_terminates_and_disconnects() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    h.manager.stop(id).await.unwrap();
    let cmds = h.commands();
    let t = cmds.iter().position(|c| c == "terminate").unwrap();
    let d = cmds.iter().position(|c| c == "disconnect").unwrap();
    assert!(t < d);
    assert!(h.manager.sessions(None).is_empty());
    h.wait_event(|e| matches!(e, DebugEvent::Terminated)).await;
    assert!(h.manager.threads(id).await.is_err());
}

#[tokio::test]
async fn concurrent_sessions_are_independent() {
    let h = harness(Script::default());
    let a = h.start(config()).await.unwrap();
    let b = h.start(config()).await.unwrap();
    assert_ne!(a, b);
    assert_eq!(h.manager.sessions(None).len(), 2);
    h.manager.stop(a).await.unwrap();
    assert_eq!(h.manager.sessions(None).iter().map(|s| s.id).collect::<Vec<_>>(), [b]);
    h.manager.stop(b).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn run_in_terminal_spawns_debuggee() {
    let h = harness(Script {
        run_in_terminal: Some(vec!["sh".into(), "-c".into(), "echo from-debuggee".into()]),
        ..Script::default()
    });
    h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Output { category, output } if category == "stdout" && output.contains("from-debuggee")))
        .await;
    let response =
        h.log.lock().iter().find(|m| m["type"] == "response" && m["command"] == "runInTerminal").cloned().unwrap();
    assert_eq!(response["success"], true);
    assert!(response["body"]["processId"].as_u64().unwrap() > 0);
}

#[cfg(unix)]
#[tokio::test]
async fn run_in_terminal_program_reads_typed_input() {
    let h = harness(Script {
        // CodeLLDB's launcher asks to clear the terminal; the console keeps its output.
        run_in_terminal: Some(vec![
            "sh".into(),
            "-c".into(),
            "[ -t 0 ] && echo 'name?' && read name && echo \"hello $name\"".into(),
            "--clear-screen".into(),
        ]),
        ..Script::default()
    });
    let session = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::ProgramInput)).await;
    h.wait_event(|e| matches!(e, DebugEvent::Output { output, .. } if output.contains("name?"))).await;
    h.manager.send_input(session, "Bob\n").unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Output { output, .. } if output.contains("hello Bob"))).await;
    let output: String = h
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::Debug { event: DebugEvent::Output { category, output }, .. } if category == "stdout" => {
                Some(output.clone())
            }
            _ => None,
        })
        .collect();
    assert!(!output.contains('\r'), "{output:?}");
    h.manager.stop(session).await.unwrap();
    assert!(h.manager.send_input(session, "x\n").is_err());
}

#[test]
fn launch_arguments_merge_and_defaults() {
    let mut c = config();
    c.extra_json = None;
    c.args.clear();
    c.env.clear();
    let args = launch_arguments(&c).unwrap();
    assert_eq!(
        args,
        json!({"name": "app", "request": "launch", "type": "debugpy", "program": "/p/a.py", "cwd": "/p"}),
        "`request` is in the arguments, as VS Code sends it"
    );
    c.extra_json = Some("[1]".into());
    assert!(launch_arguments(&c).is_err());
    c.extra_json = Some("{bad".into());
    assert!(launch_arguments(&c).is_err());
}

#[test]
fn frame_and_variable_conversion() {
    let f = frame_from(&json!({"id": 1, "name": "f", "line": 1, "column": 1}));
    assert_eq!((f.line, f.column, f.path), (0, 0, None));
    let f = frame_from(&json!({"id": 1, "name": "f", "line": 0, "column": 0, "presentationHint": "label"}));
    assert_eq!((f.line, f.presentation_hint.as_deref()), (0, Some("label")));
    let v = variable_from(&json!({"name": "a", "value": "1", "type": ""}));
    assert_eq!(v.type_name, None);
}

#[tokio::test]
async fn unknown_adapter_is_unavailable() {
    let h = harness(Script::default());
    let mut c = config();
    c.adapter = "no-such-adapter".into();
    let err = h.start(c).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
}

#[tokio::test]
async fn exception_filters_and_set_variable() {
    let h = harness(Script::default());
    h.manager.set_exception_breakpoints(BTreeMap::from([("raised".into(), true)])).await.unwrap();
    let id = h.start(config()).await.unwrap();
    let sets = || -> Vec<Value> {
        h.log
            .lock()
            .iter()
            .filter(|m| m["command"] == "setExceptionBreakpoints" && m["type"] == "request")
            .map(|m| m["arguments"]["filters"].clone())
            .collect()
    };
    assert_eq!(sets(), [json!(["raised", "uncaught"])], "choice + default applied at start");

    let all = h.manager.exception_filters(Some("main"));
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].session, id);
    assert_eq!(all[0].filters[1].label, "Uncaught");
    assert!(all[0].filters[1].default);
    assert_eq!(all[0].filters[1].description.as_deref(), Some("Uncaught exceptions"));

    h.manager
        .set_exception_breakpoints(BTreeMap::from([("raised".into(), false), ("uncaught".into(), false)]))
        .await
        .unwrap();
    assert_eq!(sets().last().unwrap(), &json!([]), "live update");
    h.manager
        .set_exception_breakpoints(BTreeMap::from([
            ("debugpy:raised".into(), true),
            ("raised".into(), false),
            ("js-debug:uncaught".into(), true),
        ]))
        .await
        .unwrap();
    assert_eq!(
        sets().last().unwrap(),
        &json!(["raised", "uncaught"]),
        "adapter-scoped choice wins; others' don't apply"
    );

    let v = h.manager.set_variable(id, 100, "x".into(), None, Some(10), "5".into()).await.unwrap();
    assert_eq!((v.value.as_str(), v.type_name.as_deref()), ("5!", Some("int")));
    let req = h.request("setVariable");
    assert_eq!(req["arguments"], json!({"variablesReference": 100, "name": "x", "value": "5"}));
    // No setExpression support: a variable without a container cannot be changed.
    assert!(h.manager.set_variable(id, 0, "y".into(), Some("y".into()), None, "1".into()).await.is_err());
    h.manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn sessions_deliver_events_to_their_owner_only() {
    let h = harness(Script { start_debugging: true, ..Script::default() });
    let (other, other_events) = recording_owner("other");
    let a = h.start(config()).await.unwrap();
    let b = h.manager.start(config(), other).await.unwrap();

    // Each adapter starts a child session, which inherits its parent's owner.
    let mut child = None;
    for _ in 0..200 {
        child = h.manager.sessions(Some("main")).into_iter().find(|s| s.parent == Some(a));
        if child.is_some() && h.manager.sessions(Some("other")).iter().any(|s| s.parent == Some(b)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let child = child.expect("child session started").id;
    for _ in 0..200 {
        if event_sessions(&h.events).contains(&child.0) && event_sessions(&other_events).contains(&b.0) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;

    let ids =
        |owner| h.manager.sessions(Some(owner)).into_iter().map(|s| s.id.0).collect::<std::collections::BTreeSet<_>>();
    let (main_ids, other_ids) = (ids("main"), ids("other"));
    assert!(main_ids.contains(&a.0) && main_ids.contains(&child.0) && !main_ids.contains(&b.0));
    assert!(other_ids.contains(&b.0) && main_ids.is_disjoint(&other_ids));
    assert_eq!(other_ids.len(), 2, "b and its child");

    let mine = event_sessions(&h.events);
    let theirs = event_sessions(&other_events);
    assert!(mine.contains(&a.0) && mine.contains(&child.0), "owner gets its sessions and their children: {mine:?}");
    assert!(mine.is_subset(&main_ids), "no events of another owner's sessions: {mine:?}");
    assert!(theirs.contains(&b.0) && theirs.is_subset(&other_ids), "other owner only sees its own: {theirs:?}");
    // A child is announced to its owner with its parent, before any of its other events.
    let first_of_child = h.events.lock().iter().find_map(|e| match e {
        IdeEvent::Debug { session, event } if *session == child => Some(event.clone()),
        _ => None,
    });
    assert!(
        matches!(&first_of_child, Some(DebugEvent::Started { name, parent: Some(p), .. }) if name == "child" && *p == a),
        "{first_of_child:?}"
    );
    let filters: Vec<u32> = h.manager.exception_filters(Some("other")).iter().map(|f| f.session.0).collect();
    assert!(filters.iter().all(|id| other_ids.contains(id)) && filters.contains(&b.0));
    assert_eq!(h.manager.sessions(None).len(), 4);

    h.manager.stop(b).await.unwrap();
    for _ in 0..100 {
        if other_events.lock().iter().any(|e| matches!(e, IdeEvent::Debug { event: DebugEvent::Terminated, .. })) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !h.events
            .lock()
            .iter()
            .any(|e| matches!(e, IdeEvent::Debug { session, event: DebugEvent::Terminated } if *session == b)),
        "termination of another owner's session is not delivered here"
    );
    assert!(other_events.lock().iter().any(|e| matches!(e, IdeEvent::Debug { event: DebugEvent::Terminated, .. })));
    h.manager.stop(a).await.unwrap();
}

#[test]
fn debug_server_is_taken_from_launch_arguments() {
    let local = |port| Some(DebugServer { host: None, port });
    let remote = |host: &str, port| Some(DebugServer { host: Some(host.into()), port });
    let mut args = json!({"name": "x", "debugServer": 4711, "mainClass": "a.B"});
    assert_eq!(take_debug_server(&mut args).unwrap(), local(4711));
    assert!(args.get("debugServer").is_none());
    assert_eq!(args["mainClass"], "a.B");
    assert_eq!(take_debug_server(&mut json!({"debugServer": "5005"})).unwrap(), local(5005));
    assert_eq!(take_debug_server(&mut json!({"name": "x"})).unwrap(), None);
    // A remote adapter: `dlv --headless --listen=:2345`, `debugpy --listen 0.0.0.0:5678`.
    assert_eq!(take_debug_server(&mut json!({"debugServer": "build-box:2345"})).unwrap(), remote("build-box", 2345));
    assert_eq!(take_debug_server(&mut json!({"debugServer": "10.0.0.7:5678"})).unwrap(), remote("10.0.0.7", 5678));
    assert_eq!(take_debug_server(&mut json!({"debugServer": "[::1]:2345"})).unwrap(), remote("::1", 2345));
    assert_eq!(take_debug_server(&mut json!({"debugServer": ":2345"})).unwrap(), local(2345));
    assert!(take_debug_server(&mut json!({"debugServer": 0})).is_err());
    assert!(take_debug_server(&mut json!({"debugServer": 70000})).is_err());
    assert!(take_debug_server(&mut json!({"debugServer": "host:"})).is_err());
    assert!(take_debug_server(&mut json!({"debugServer": "host:abc"})).is_err());
}

#[test]
fn free_port_placeholder_is_one_port_everywhere() {
    let mut args = json!({
        "runtimeArgs": ["run", "--inspect-wait=127.0.0.1:${freePort}", "main.ts"],
        "attachSimplePort": "${freePort}",
        "env": {"PORT": "${freePort}"},
        "name": "no placeholder",
    });
    let mut calls = 0;
    substitute_free_port(&mut args, &mut || {
        calls += 1;
        Ok(9339)
    })
    .unwrap();
    assert_eq!(calls, 1, "one port per launch");
    assert_eq!(args["runtimeArgs"], json!(["run", "--inspect-wait=127.0.0.1:9339", "main.ts"]));
    assert_eq!(args["attachSimplePort"], json!(9339), "a bare placeholder becomes a number");
    assert_eq!(args["env"]["PORT"], "9339", "environment values stay strings");
    assert_eq!(args["name"], "no placeholder");
    let mut none = json!({"program": "a.js"});
    substitute_free_port(&mut none, &mut || panic!("no port needed")).unwrap();
}

/// Deno under js-debug: the placeholder gets a real port, and js-debug gets the
/// workspace folder its default `outFiles` (TypeScript breakpoints via source maps) need.
#[tokio::test]
async fn js_debug_launch_gets_port_and_workspace_folder() {
    let h = harness(Script::default());
    let config = LaunchConfig {
        name: "main.ts".into(),
        adapter: "js-debug".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        cwd: Some("/p".into()),
        env: BTreeMap::new(),
        extra_json: Some(
            json!({
                "runtimeExecutable": "deno",
                "runtimeArgs": ["run", "--inspect-wait=127.0.0.1:${freePort}", "main.ts"],
                "attachSimplePort": "${freePort}",
            })
            .to_string(),
        ),
    };
    h.start(config).await.unwrap();
    let launch = h.request("launch")["arguments"].clone();
    let port = launch["attachSimplePort"].as_u64().expect("a number");
    assert!(port > 0);
    assert_eq!(launch["runtimeArgs"][1], format!("--inspect-wait=127.0.0.1:{port}"));
    assert_eq!(launch["__workspaceFolder"], "/p");
    assert_eq!(launch["type"], "pwa-node");
}

/// CodeLLDB treats console input as LLDB commands unless told otherwise: Evaluate Expression
/// and the Debug Console send expressions, so its console evaluates them. A launch
/// configuration that picks a console mode keeps it.
#[tokio::test]
async fn codelldb_console_evaluates_expressions() {
    let launch_with = |extra: Value| async move {
        let h = harness(Script::default());
        let config = LaunchConfig {
            name: "demo".into(),
            adapter: "codelldb".into(),
            request: "launch".into(),
            program: Some("/p/target/debug/demo".into()),
            args: vec![],
            cwd: Some("/p".into()),
            env: BTreeMap::new(),
            extra_json: Some(extra.to_string()),
        };
        h.start(config).await.unwrap();
        h.request("launch")["arguments"].clone()
    };
    let launch = launch_with(json!({})).await;
    assert_eq!(launch["_adapterSettings"]["consoleMode"], "evaluate");
    assert_eq!(launch["sourceLanguages"], json!(["rust"]));

    let launch =
        launch_with(json!({"_adapterSettings": {"consoleMode": "commands", "showDisassembly": "never"}})).await;
    assert_eq!(launch["_adapterSettings"], json!({"consoleMode": "commands", "showDisassembly": "never"}));
    let launch = launch_with(json!({"_adapterSettings": {"showDisassembly": "never"}})).await;
    assert_eq!(launch["_adapterSettings"], json!({"consoleMode": "evaluate", "showDisassembly": "never"}));
}

/// An adapter that is already listening (java-debug inside jdtls): the client
/// connects over TCP to the `debugServer` port instead of spawning anything.
#[tokio::test]
async fn connects_to_running_debug_server_over_tcp() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream, server_log, Script::default()).await;
    });
    let (owner, events) = recording_owner("main");
    let manager = DebugManager::new(Arc::new(LanguageRegistry::from_configs(Vec::new())));
    let config = LaunchConfig {
        name: "App".into(),
        adapter: "java-debug".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        cwd: Some(std::env::temp_dir().into()),
        env: BTreeMap::new(),
        extra_json: Some(json!({"debugServer": port, "mainClass": "demo.App"}).to_string()),
    };
    let id = manager.start(config, owner).await.unwrap();
    let launch = log.lock().iter().find(|m| m["command"] == "launch").cloned().unwrap();
    assert_eq!(launch["arguments"]["mainClass"], "demo.App");
    assert_eq!(launch["arguments"]["type"], "java");
    assert!(launch["arguments"].get("debugServer").is_none(), "consumed by the client");
    assert_eq!(manager.threads(id).await.unwrap()[0].name, "MainThread");
    manager.stop(id).await.unwrap();
    assert!(manager.sessions(None).is_empty());
    assert!(events.lock().iter().any(|e| matches!(e, IdeEvent::Debug { event: DebugEvent::Started { .. }, .. })));
}

/// Go Remote / Python remote: the adapter runs on another machine (`dlv --headless`,
/// `debugpy --listen`); `debugServer: "host:port"` connects there instead of spawning one.
#[tokio::test]
async fn connects_to_remote_debug_server_by_host() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream, server_log, Script::default()).await;
    });
    let (owner, _events) = recording_owner("main");
    let manager = DebugManager::new(Arc::new(LanguageRegistry::from_configs(Vec::new())));
    let config = LaunchConfig {
        name: "Remote".into(),
        adapter: "delve".into(),
        request: "attach".into(),
        program: None,
        args: vec![],
        cwd: Some(std::env::temp_dir().into()),
        env: BTreeMap::new(),
        extra_json: Some(
            json!({"debugServer": format!("localhost:{port}"), "mode": "remote", "substitutePath": [{"from": "/src", "to": "/app"}]})
                .to_string(),
        ),
    };
    let id = manager.start(config, owner).await.unwrap();
    let attach = log.lock().iter().find(|m| m["command"] == "attach").cloned().unwrap();
    assert_eq!(attach["arguments"]["mode"], "remote");
    assert_eq!(attach["arguments"]["substitutePath"][0]["to"], "/app");
    assert!(attach["arguments"].get("debugServer").is_none(), "consumed by the client");
    manager.stop(id).await.unwrap();
}

fn requests(h: &Harness, command: &str) -> Vec<Value> {
    h.log
        .lock()
        .iter()
        .filter(|m| m["command"] == command && m["type"] == "request")
        .map(|m| m["arguments"].clone())
        .collect()
}

fn function_bp(name: &str, enabled: bool) -> FunctionBreakpoint {
    FunctionBreakpoint { name: name.into(), condition: None, hit_condition: None, enabled }
}

#[tokio::test]
async fn function_and_data_breakpoints_are_stored_and_sent() {
    let h = harness(Script::default());
    let cond = FunctionBreakpoint { condition: Some("n > 1".into()), ..function_bp("com.a.B#run", true) };
    let states = h.manager.set_function_breakpoints(vec![cond, function_bp("off", false)]).await.unwrap();
    assert!(!states[0].verified && states[1].message.as_deref() == Some("Disabled"), "no session yet");
    let watch = DataBreakpoint {
        data_id: "Req#count".into(),
        access_type: Some("write".into()),
        condition: None,
        hit_condition: Some("2".into()),
        enabled: true,
    };
    h.manager.set_data_breakpoints(vec![watch]).await.unwrap();

    let id = h.start(config()).await.unwrap();
    assert_eq!(
        requests(&h, "setFunctionBreakpoints"),
        [json!({"breakpoints": [{"name": "com.a.B#run", "condition": "n > 1"}]})],
        "sent during configuration, disabled omitted"
    );
    assert_eq!(
        requests(&h, "setDataBreakpoints"),
        [json!({"breakpoints": [{"dataId": "Req#count", "accessType": "write", "hitCondition": "2"}]})]
    );
    let order = h.commands();
    let pos = |c: &str| order.iter().position(|x| x == c).unwrap();
    assert!(pos("setFunctionBreakpoints") < pos("configurationDone"));

    let states =
        h.manager.set_function_breakpoints(vec![function_bp("missing", true), function_bp("ok", true)]).await.unwrap();
    assert_eq!((states[0].verified, states[1].verified), (false, true), "live states from the session");

    let info = h.manager.data_breakpoint_info(id, 101, "count".into(), Some(10)).await.unwrap();
    assert_eq!(info.data_id.as_deref(), Some("Req#count"));
    assert_eq!(info.access_types, ["write", "read"]);
    assert_eq!(
        h.request("dataBreakpointInfo")["arguments"],
        json!({"name": "count", "variablesReference": 101, "frameId": 10})
    );

    let caps = h.manager.capabilities(id).unwrap();
    assert!(caps.function_breakpoints && caps.data_breakpoints && caps.restart_frame && caps.step_in_targets);
    assert!(caps.set_value && !caps.log_points);
    h.manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn smart_step_into_and_reset_frame() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    let targets = h.manager.step_in_targets(id, 10).await.unwrap();
    assert_eq!(targets.len(), 2);
    assert_eq!(
        targets[0],
        StepInTarget { id: 1, label: "parse()".into(), line: Some(4), column: Some(8), end_column: Some(15) }
    );
    assert_eq!(targets[1].line, None);
    h.manager.step_in_target(id, 1, 2).await.unwrap();
    assert_eq!(requests(&h, "stepIn").last().unwrap(), &json!({"threadId": 1, "targetId": 2}));

    h.manager.restart_frame(id, 11).await.unwrap();
    assert_eq!(h.request("restartFrame")["arguments"], json!({"frameId": 11}));
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { reason, .. } if reason == "restart")).await;
    h.manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn force_stepping_suspends_breakpoints_until_the_next_stop() {
    let h = harness(Script::default());
    let a = PathBuf::from("/p/a.py");
    let b = PathBuf::from("/p/b.py");
    h.manager.set_breakpoints(a.clone(), vec![bp(1)]).await.unwrap();
    h.manager.set_breakpoints(b.clone(), vec![bp(3)]).await.unwrap();
    h.manager.set_breakpoints(PathBuf::from("/p/off.py"), vec![Breakpoint { enabled: false, ..bp(5) }]).await.unwrap();
    h.manager.set_function_breakpoints(vec![function_bp("run", true)]).await.unwrap();
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    let sent_for = |path: &str| -> Vec<Value> {
        requests(&h, "setBreakpoints")
            .into_iter()
            .filter(|r| r["source"]["path"] == path)
            .map(|r| r["breakpoints"].clone())
            .collect()
    };

    h.manager.force_step_over(id, 1).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { reason, .. } if reason == "step")).await;
    for _ in 0..100 {
        if sent_for("/p/b.py").len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(sent_for("/p/b.py"), [json!([{"line": 4}]), json!([]), json!([{"line": 4}])], "muted, then restored");
    let functions = requests(&h, "setFunctionBreakpoints");
    assert_eq!(functions[1], json!({"breakpoints": []}));
    assert_eq!(functions[2], json!({"breakpoints": [{"name": "run"}]}));

    // Force run to cursor: only the temporary breakpoint stays in the target file.
    h.manager.run_to(id, 1, a.clone(), 9, true).await.unwrap();
    assert_eq!(sent_for("/p/a.py").last().unwrap(), &json!([{"line": 10}]));
    assert_eq!(sent_for("/p/b.py").last().unwrap(), &json!([]));
    assert!(sent_for("/p/off.py").is_empty(), "nothing enabled there, nothing to suspend or restore");
}

#[tokio::test]
async fn startup_sends_every_file_at_once_and_skips_files_with_nothing_enabled() {
    let h = harness(Script { hold_set_breakpoints: 2, ..Script::default() });
    h.manager.set_breakpoints(PathBuf::from("/p/a.py"), vec![bp(1)]).await.unwrap();
    h.manager.set_breakpoints(PathBuf::from("/p/b.py"), vec![bp(3)]).await.unwrap();
    let off = PathBuf::from("/p/off.py");
    h.manager.set_breakpoints(off.clone(), vec![Breakpoint { enabled: false, ..bp(5) }]).await.unwrap();
    // Waiting for each answer before the next request would stall until the request timeout.
    tokio::time::timeout(Duration::from_secs(5), h.start(config())).await.expect("requests pipelined").unwrap();
    let paths: Vec<Value> = requests(&h, "setBreakpoints").into_iter().map(|r| r["source"]["path"].clone()).collect();
    assert_eq!(paths, [json!("/p/a.py"), json!("/p/b.py")]);
    assert_eq!(
        h.manager.breakpoint_states(&off),
        [BreakpointState { line: 5, verified: false, message: Some("Disabled".into()) }]
    );
}

#[tokio::test]
async fn hot_swap_only_for_java_debug() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    assert!(!h.manager.capabilities(id).unwrap().hot_code_replace);
    let err = h.manager.redefine_classes(id).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);

    let java = LaunchConfig { adapter: "java-debug".into(), extra_json: None, ..config() };
    let id = h.start(java).await.unwrap();
    assert!(h.manager.capabilities(id).unwrap().hot_code_replace);
    let result = h.manager.redefine_classes(id).await.unwrap();
    assert_eq!(result, HotSwapResult { changed_classes: vec!["com.x.App".into()], error_message: None });
    match h
        .wait_event(|e| matches!(e, DebugEvent::HotCodeReplace { change_type, .. } if change_type == "BUILD_COMPLETE"))
        .await
    {
        DebugEvent::HotCodeReplace { message, .. } => assert_eq!(message, "Build completed"),
        other => panic!("{other:?}"),
    }
    let failed = hot_swap_result(&json!({"changedClasses": [], "errorMessage": "boom"}));
    assert_eq!(failed.error_message.as_deref(), Some("boom"));
}

fn godot_registry(port: u16, command: &str, args: &[&str]) -> Arc<LanguageRegistry> {
    let lang = ide_language::LanguageConfig {
        id: ide_core::LanguageId::new("gdscript"),
        name: "GDScript".into(),
        extensions: vec!["gd".into()],
        filenames: vec![],
        first_line: None,
        line_comment: None,
        block_comment: None,
        indent: None,
        ui_mode: None,
        framework_ui_modes: Vec::new(),
        formatter: None,
        scratch_template: None,
        tree_sitter: None,
        language_servers: vec![],
        debugger: Some(ide_language::DebuggerConfig {
            adapter: "godot".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            transport: "tcp".into(),
            connect: Some(format!("127.0.0.1:{port}")),
            install_hint: Some("Open the project in the Godot editor".into()),
            pinned: None,
        }),
    };
    Arc::new(LanguageRegistry::from_configs(vec![lang]))
}

fn godot_launch(project: &std::path::Path) -> LaunchConfig {
    LaunchConfig {
        name: "Main Scene".into(),
        adapter: "godot".into(),
        request: "launch".into(),
        program: None,
        args: vec![],
        cwd: Some(project.to_path_buf().into()),
        env: BTreeMap::new(),
        extra_json: Some(json!({"project": project, "scene": "main"}).to_string()),
    }
}

/// Godot's debug adapter runs inside the editor (port 6006): an open editor is
/// used as is, nothing is started.
#[tokio::test]
async fn godot_connects_to_the_editor_adapter() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream, server_log, Script::default()).await;
    });
    let (owner, _events) = recording_owner("main");
    let manager = DebugManager::new(godot_registry(port, "openidea-no-such-godot", &[]));
    let project = std::env::temp_dir();
    let id = manager.start(godot_launch(&project), owner).await.unwrap();
    let launch = log.lock().iter().find(|m| m["command"] == "launch").cloned().unwrap();
    assert_eq!(launch["arguments"]["scene"], "main");
    assert_eq!(launch["arguments"]["project"], json!(std::fs::canonicalize(&project).unwrap()));
    assert!(log.lock().iter().any(|m| m["command"] == "configurationDone"));
    manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn godot_without_editor_or_executable_says_what_to_do() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let (owner, _events) = recording_owner("main");
    let manager = DebugManager::new(godot_registry(port, "openidea-no-such-godot", &[]));
    let err = manager.start(godot_launch(&std::env::temp_dir()), owner).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
    assert!(err.message.contains("Open the project in the Godot editor"), "{}", err.message);
}

/// No editor open: the command (a headless editor) is started for the project and
/// the client connects once it listens; the started process ends with the session.
#[cfg(unix)]
#[tokio::test]
async fn godot_starts_a_headless_editor_when_none_is_open() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream, server_log, Script::default()).await;
    });
    let (owner, _events) = recording_owner("main");
    // `sleep` stands in for `godot --headless --editor --path ${root} …`.
    let manager = DebugManager::new(godot_registry(port, "sleep", &["30"]));
    let id = manager.start(godot_launch(&std::env::temp_dir()), owner).await.unwrap();
    assert!(log.lock().iter().any(|m| m["command"] == "launch"));
    manager.stop(id).await.unwrap();
}

/// Godot never stops at a breakpoint given through a symlinked path (it maps scripts
/// to `res://` by its resolved project path): breakpoints and `project` go out resolved.
#[cfg(unix)]
#[tokio::test]
async fn godot_gets_resolved_paths() {
    let real = std::env::temp_dir().join(format!("openidea-godot-real-{}", std::process::id()));
    let link = std::env::temp_dir().join(format!("openidea-godot-link-{}", std::process::id()));
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("player.gd"), "extends Node\n").unwrap();
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let real = std::fs::canonicalize(&real).unwrap();

    let log: Log = Arc::default();
    let (owner, _events) = recording_owner("main");
    let manager = DebugManager::with_launcher(
        godot_registry(1, "godot", &[]),
        Arc::new(FakeLauncher { log: log.clone(), script: Script::default() }),
    );
    let bp = Breakpoint { line: 0, condition: None, hit_condition: None, log_message: None, enabled: true };
    manager.set_breakpoints(link.join("player.gd"), vec![bp]).await.unwrap();
    let id = manager.start(godot_launch(&link), owner).await.unwrap();
    let sent = log.lock().iter().find(|m| m["command"] == "setBreakpoints").cloned().unwrap();
    assert_eq!(sent["arguments"]["source"]["path"], json!(real.join("player.gd")));
    let launch = log.lock().iter().find(|m| m["command"] == "launch").cloned().unwrap();
    assert_eq!(launch["arguments"]["project"], json!(real));
    manager.stop(id).await.unwrap();
    std::fs::remove_file(&link).ok();
    std::fs::remove_dir_all(&real).ok();
}

#[test]
fn root_and_address_placeholders() {
    let args: Vec<String> = ["--path", "${root}", "--dap-port", "${port}"].iter().map(|s| s.to_string()).collect();
    let args = adapter::substitute_port(&adapter::substitute_root(&args, std::path::Path::new("/g")), 6010);
    assert_eq!(args, ["--path", "/g", "--dap-port", "6010"]);
    assert_eq!(adapter::parse_address("127.0.0.1:6006"), Some(("127.0.0.1".into(), 6006)));
    assert_eq!(adapter::parse_address("[::1]:6006"), Some(("::1".into(), 6006)));
    assert_eq!(adapter::parse_address("6006"), None);
}

#[tokio::test]
async fn kotlin_configures_without_configuration_done_response() {
    let h = harness(Script { ignore_configuration_done: true, ..Default::default() });
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("Main.kt");
    std::fs::write(&path, "package org.example\nfun main() {}\n").unwrap();
    h.manager.set_breakpoints(path.clone(), vec![bp(1)]).await.unwrap();
    let mut config = config();
    config.adapter = kotlin::ADAPTER.into();
    config.request = "attach".into();
    config.cwd = Some(project.path().to_owned().into());
    config.extra_json = Some(json!({"projectRoot": project.path(), "hostName": "127.0.0.1", "port": 5005}).to_string());
    let id = tokio::time::timeout(Duration::from_secs(2), h.start(config)).await.unwrap().unwrap();
    let root = PathBuf::from(h.request("attach")["arguments"]["projectRoot"].as_str().unwrap());
    assert!(!root.starts_with(project.path()));
    let request = h.request("setBreakpoints");
    assert_eq!(request["arguments"]["source"]["name"], "Main.kt");
    let mapped = PathBuf::from(request["arguments"]["source"]["path"].as_str().unwrap());
    assert!(mapped.starts_with(&root));
    assert!(mapped.is_file());
    assert_eq!(h.manager.session(id).unwrap().client_path(mapped.to_str().unwrap()), Some(path));
    h.manager.stop(id).await.unwrap();
}

/// Requires a compiled no-delay reporter fixture (Main.kt, package org.example,
/// loop at line 5, println(i) at line 6), and the unmodified official adapter.
/// KOTLIN_PROBE_CONFIG is a LaunchConfig JSON file; KOTLIN_PROBE_ADAPTER is its executable.
#[tokio::test]
#[ignore = "requires official Kotlin adapter and compiled reporter fixture"]
async fn kotlin_official_release_ten_no_delay_runs() {
    let config: LaunchConfig = serde_json::from_slice(
        &std::fs::read(std::env::var("KOTLIN_PROBE_CONFIG").expect("KOTLIN_PROBE_CONFIG")).unwrap(),
    )
    .unwrap();
    let adapter = std::env::var("KOTLIN_PROBE_ADAPTER").expect("KOTLIN_PROBE_ADAPTER");
    let source = PathBuf::from(config.cwd.clone().unwrap()).join("src/main/kotlin/Main.kt");
    for run in 1..=10 {
        let (owner, events) = recording_owner("kotlin-probe");
        let manager = DebugManager::new(Arc::new(LanguageRegistry::from_configs(Vec::new())));
        let h = Harness { manager, owner, events, log: Arc::default() };
        h.manager.set_breakpoints(source.clone(), vec![bp(5)]).await.unwrap();
        let id = h.manager.start_with(config.clone(), h.owner.clone(), |_| Some(adapter.clone())).await.unwrap();
        let stopped = h.wait_event(|e| matches!(e, DebugEvent::Stopped { reason, .. } if reason == "breakpoint")).await;
        let DebugEvent::Stopped { thread_id, .. } = stopped else { unreachable!() };
        let frames = h.manager.stack_trace(id, thread_id).await.unwrap();
        assert_eq!(frames[0].line, 5);
        assert_eq!(frames[0].path.as_deref(), Some(source.as_path()));
        let scopes = h.manager.scopes(id, frames[0].id).await.unwrap();
        let mut variables = Vec::new();
        for scope in scopes {
            variables.extend(h.manager.variables(id, scope.variables_reference).await.unwrap());
        }
        assert!(variables.iter().any(|v| v.name == "i" && v.value == "0"));
        h.manager.step(id, thread_id, StepKind::Over).await.unwrap();
        h.wait_event(|e| matches!(e, DebugEvent::Stopped { reason, .. } if reason == "step")).await;
        let frames = h.manager.stack_trace(id, thread_id).await.unwrap();
        assert_eq!(frames[0].line, 4);
        h.manager.stop(id).await.unwrap();
        println!("Run {run}/10: breakpoint Main.kt:6, i=0, step Main.kt:5; stopped");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn netcoredbg_windows_source_paths_round_trip() {
    let client = "D:/work/LoginController.cs";
    let native = r"D:\work\LoginController.cs";
    let h = harness(Script { source_path: Some(native.into()), ..Script::default() });
    let path = PathBuf::from(client);
    h.manager.set_breakpoints(path.clone(), vec![bp(25)]).await.unwrap();
    let mut cfg = config();
    cfg.adapter = "netcoredbg".into();
    let id = h.start(cfg).await.unwrap();
    assert_eq!(h.request("setBreakpoints")["arguments"]["source"]["path"], native);
    let frames = h.manager.stack_trace(id, 1).await.unwrap();
    assert_eq!(frames[0].path.as_deref(), Some(path.as_path()));
    h.manager.stop(id).await.unwrap();
}

#[tokio::test]
async fn java_windows_source_paths_for_launch_and_attach() {
    for request in ["launch", "attach"] {
        for (client, native, returned) in [
            ("C:/work/Main.java", r"C:\work\Main.java", r"C:\work\Main.java"),
            ("C:/work/Main.java", r"C:\work\Main.java", "C:/work/Main.java"),
            (r"c:\work\Main.java", r"c:\work\Main.java", "c:/work/Main.java"),
            (r"D:/my project\Main.java", r"D:\my project\Main.java", r"D:\my project\Main.java"),
            ("//server/share/Main.java", r"\\server\share\Main.java", "//server/share/Main.java"),
            (r"\\server\share/Main.java", r"\\server\share\Main.java", "//server/share/Main.java"),
            ("/work/Main.java", "/work/Main.java", "/work/Main.java"),
        ] {
            let h = harness(Script { source_path: Some(returned.into()), ..Script::default() });
            let path = PathBuf::from(client);
            h.manager.set_breakpoints(path.clone(), vec![bp(4)]).await.unwrap();
            let mut cfg = config();
            cfg.adapter = "java-debug".into();
            cfg.request = request.into();
            let id = h.start(cfg).await.unwrap();
            assert_eq!(h.request("initialize")["arguments"]["pathFormat"], "path");
            assert_eq!(h.request("setBreakpoints")["arguments"]["source"]["path"], native);
            let commands = h.commands();
            assert!(
                commands.iter().position(|c| c == "setBreakpoints").unwrap()
                    < commands.iter().position(|c| c == "configurationDone").unwrap()
            );
            let frames = h.manager.stack_trace(id, 1).await.unwrap();
            assert_eq!(frames[0].path.as_deref(), Some(path.as_path()));
            h.wait_event(|e| {
                matches!(e, DebugEvent::BreakpointsChanged { path: p } if p.as_ref() == path.as_path())
                    && h.manager.breakpoint_states(&path)[0].message.as_deref() == Some("moved")
            })
            .await;
            assert_eq!(h.manager.breakpoint_states(&path)[0].message.as_deref(), Some("moved"));
            h.manager.stop(id).await.unwrap();
        }
    }
}

#[tokio::test]
async fn java_stack_frames_without_breakpoints_normalize_windows_paths() {
    for (returned, expected) in [
        (r"C:\work\Other.java", "C:/work/Other.java"),
        (r"\\server\share\Other.java", "//server/share/Other.java"),
        ("C:/work/Other.java", "C:/work/Other.java"),
        ("/work/Other.java", "/work/Other.java"),
    ] {
        let h = harness(Script { source_path: Some(returned.into()), ..Script::default() });
        let mut cfg = config();
        cfg.adapter = "java-debug".into();
        let id = h.start(cfg).await.unwrap();
        let frames = h.manager.stack_trace(id, 1).await.unwrap();
        assert_eq!(frames[0].path.as_deref(), Some(PathBuf::from(expected).as_path()));
        h.manager.stop(id).await.unwrap();
    }
}

/// A built-in language definition (GDScript) shipped by a plugin
/// instead: its debugger starts the program approved for the plugin's
/// `process:godot` grant, and refuses once that file changed.
#[cfg(unix)]
#[tokio::test]
async fn a_plugin_language_runs_its_debug_adapter_from_the_approved_program() {
    use ide_language::ProgramPin;
    use ide_language::plugin_point::{PluginLanguages, parse_definition};
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("openidea-plugin-dap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Stands in for `godot --headless --editor …`.
    let program = dir.join("godot");
    std::fs::write(&program, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let mut gdscript = parse_definition(include_str!("../../../languages/gdscript.toml")).unwrap();
    let debugger = gdscript.debugger.as_mut().unwrap();
    debugger.args.clear();
    debugger.connect = Some(format!("127.0.0.1:{port}"));

    // No built-in GDScript: it comes from the plugin.
    let registry = Arc::new(LanguageRegistry::from_configs(Vec::new()));
    let store = PluginLanguages::new();
    registry.attach_plugins(store.clone());
    let pin = ProgramPin::approve(&program).unwrap();
    store.set_process_policy(Arc::new(move |plugin, cap| {
        (plugin == "acme.godot" && cap.to_string() == "process:godot").then(|| pin.clone())
    }));
    let _language = store.add("acme.godot".into(), gdscript);

    let log: Log = Arc::default();
    let server_log = log.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        fake_adapter(stream, server_log, Script::default()).await;
    });
    let (owner, _events) = recording_owner("main");
    let manager = DebugManager::new(registry.clone());
    let id = manager.start(godot_launch(&dir), owner).await.unwrap();
    assert!(log.lock().iter().any(|m| m["command"] == "launch"));
    manager.stop(id).await.unwrap();

    // Replaced after approval: refused before anything starts.
    std::fs::write(&program, "#!/bin/sh\nexec sleep 31\n").unwrap();
    let (owner, _events) = recording_owner("main");
    let err = manager.start(godot_launch(&dir), owner).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::PermissionDenied, "{}", err.message);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn flutter_projects_are_found_from_the_program_or_the_working_directory() {
    let root = std::env::temp_dir().join(format!("openidea-flutter-{}", std::process::id()));
    let app = root.join("app");
    let tool = root.join("tool");
    std::fs::create_dir_all(app.join("lib")).unwrap();
    std::fs::create_dir_all(tool.join("bin")).unwrap();
    std::fs::write(app.join("pubspec.yaml"), "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n").unwrap();
    std::fs::write(tool.join("pubspec.yaml"), "name: tool\ndependencies:\n  args: ^2.0.0\n").unwrap();
    assert!(is_flutter_project(&app, None));
    assert!(is_flutter_project(&root, Some(&app.join("lib/main.dart"))));
    assert!(!is_flutter_project(&tool, Some(&tool.join("bin/main.dart"))));
    assert!(!is_flutter_project(&root, None));
    std::fs::remove_dir_all(&root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stop_waits_for_the_launched_program_to_exit() {
    // The adapter answers `disconnect` at once; the program it started is still alive and
    // holds its port for a while. Stop must not report the session as over before it exits.
    // Reaped by a waiting thread: a zombie still "exists" for `kill(pid, 0)`, unlike the
    // program an adapter starts and reaps.
    // Ignores SIGTERM: Stop must wait for the program, not assume the signal ended it.
    let mut child = std::process::Command::new("python3")
        .args(["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1)"])
        .spawn()
        .unwrap();
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let h = harness(Script { debuggee_pid: Some(pid), ..Default::default() });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    for _ in 0..100 {
        if h.manager.session(id).map(|s| s.debuggee_pid.load(Ordering::Acquire)).ok() == Some(i64::from(pid)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await; // let the program install its trap
    let started = Instant::now();
    h.manager.stop(id).await.unwrap();
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(800), "stop returned after {elapsed:?}, before the program exited");
    assert!(elapsed < Duration::from_secs(5), "stop waited {elapsed:?} for a program that ended after a second");
    h.wait_event(|e| matches!(e, DebugEvent::Terminated)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_second_stop_kills_the_program_instead_of_waiting() {
    let mut child = std::process::Command::new("python3")
        .args(["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"])
        .spawn()
        .unwrap();
    let pid = child.id();
    let exited = Arc::new(AtomicBool::new(false));
    {
        let exited = exited.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            exited.store(true, Ordering::Release);
        });
    }
    let h = harness(Script { debuggee_pid: Some(pid), ..Default::default() });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    for _ in 0..100 {
        if h.manager.session(id).map(|s| s.debuggee_pid.load(Ordering::Acquire)).ok() == Some(i64::from(pid)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let first = tokio::spawn({
        let manager = h.manager.clone();
        async move { manager.stop(id).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!exited.load(Ordering::Acquire), "the program is still alive while the first Stop waits");
    let started = Instant::now();
    h.manager.stop(id).await.unwrap();
    let first_result = tokio::time::timeout(Duration::from_secs(5), first).await.expect("the first Stop returns");
    first_result.unwrap().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "a second Stop does not wait out the program");
    for _ in 0..100 {
        if exited.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(exited.load(Ordering::Acquire), "the second Stop killed the program");
}

#[cfg(unix)]
#[tokio::test]
async fn stop_waits_for_the_program_when_the_adapter_uses_javas_processid_event() {
    // Ignores SIGTERM: Stop must wait for the program, not assume the signal ended it.
    let mut child = std::process::Command::new("python3")
        .args(["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1)"])
        .spawn()
        .unwrap();
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let h = harness(Script { debuggee_pid: Some(pid), java_process_id: true, ..Default::default() });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    for _ in 0..100 {
        if h.manager.session(id).map(|s| s.debuggee_pid.load(Ordering::Acquire)).ok() == Some(i64::from(pid)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let started = Instant::now();
    h.manager.stop(id).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(800),
        "stop returned after {:?}, before the program exited",
        started.elapsed()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn output_keeps_arriving_while_a_stopped_program_is_exiting() {
    // Ignores SIGTERM: Stop must wait for the program, not assume the signal ended it.
    let mut child = std::process::Command::new("python3")
        .args(["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1)"])
        .spawn()
        .unwrap();
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let h = harness(Script { debuggee_pid: Some(pid), output_after_terminate: true, ..Default::default() });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    for _ in 0..100 {
        if h.manager.session(id).map(|s| s.debuggee_pid.load(Ordering::Acquire)).ok() == Some(i64::from(pid)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = Instant::now();
    let stop = tokio::spawn({
        let manager = h.manager.clone();
        async move { manager.stop(id).await }
    });
    // The last line must reach the console while Stop still waits for the program.
    h.wait_event(|e| matches!(e, DebugEvent::Output { output, .. } if output == "late\n")).await;
    assert!(started.elapsed() < Duration::from_millis(800), "output arrived only after the program was gone");
    stop.await.unwrap().unwrap();
}

#[tokio::test]
async fn closing_a_project_stops_the_debug_sessions_it_started() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    // The session's cwd is /p, whatever key it was started under.
    h.manager.stop_under(Path::new("/p")).await;
    h.wait_event(|e| matches!(e, DebugEvent::Terminated)).await;
    assert!(h.manager.sessions(None).is_empty(), "session {id:?} is gone");
}

#[cfg(unix)]
#[tokio::test]
async fn stop_kills_the_program_started_by_the_reported_launcher() {
    use std::io::BufRead;
    // java-debug reports the launcher shell; the JVM is its child. Stopping only the reported
    // pid orphans the program, which keeps running (and keeps its ports).
    let mut launcher = std::process::Command::new("sh")
        .args(["-c", "python3 -c 'import time; time.sleep(30)' & echo $!; wait"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let launcher_pid = launcher.id();
    let mut line = String::new();
    std::io::BufReader::new(launcher.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let program: i32 = line.trim().parse().expect("child pid");
    // Reap the launcher: a zombie still "exists" for `kill(pid, 0)`, unlike the shell jdtls reaps.
    std::thread::spawn(move || {
        let _ = launcher.wait();
    });

    let h = harness(Script {
        debuggee_pid: Some(launcher_pid),
        supports_terminate: false, // java-debug does not advertise it
        ..Default::default()
    });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Initialized)).await;
    for _ in 0..100 {
        if h.manager.session(id).map(|s| s.debuggee_pid.load(Ordering::Acquire)).ok() == Some(i64::from(launcher_pid)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    h.manager.stop(id).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(program, 0) } == 0 {
        assert!(Instant::now() < deadline, "the program the launcher started survived stop");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[test]
fn delve_leftovers_are_removed_without_touching_other_files() {
    let dir = std::env::temp_dir().join(format!("openidea-delve-bin-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["__debug_bin", "__debug_bin.exe", "__debug_bin.exe3323301925"] {
        std::fs::write(dir.join(name), b"bin").unwrap();
    }
    // Lookalikes that are not Delve's own binaries stay: sources, a future
    // in-progress build, and a directory that happens to share the name.
    for name in ["__debug_bin.go", "__debug_bin.go.exe", "main.go"] {
        std::fs::write(dir.join(name), b"keep").unwrap();
    }
    std::fs::create_dir(dir.join("__debug_bin.dir")).unwrap();
    remove_delve_binaries(&dir);
    for name in ["__debug_bin", "__debug_bin.exe", "__debug_bin.exe3323301925"] {
        assert!(!dir.join(name).exists(), "{name} should be gone");
    }
    for name in ["__debug_bin.go", "__debug_bin.go.exe", "main.go", "__debug_bin.dir"] {
        assert!(dir.join(name).exists(), "{name} should stay");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

fn is_suspended(h: &Harness, id: DebugSessionId) -> bool {
    h.manager.session(id).unwrap().suspended.get()
}

#[tokio::test]
async fn stopped_event_marks_session_suspended() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    assert!(is_suspended(&h, id));
}

#[tokio::test]
async fn resume_clears_suspended_without_continued_event() {
    let h = harness(Script::default());
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    // The fake adapter ends the session after `continue`, so keep the session alive here.
    let session = h.manager.session(id).unwrap();
    assert!(session.suspended.get());
    h.manager.resume(id, 1).await.unwrap();
    assert!(!session.suspended.get());
}

#[tokio::test]
async fn continued_event_clears_suspended() {
    let h = harness(Script { continued_after_stop: true, ..Script::default() });
    let id = h.start(config()).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Continued { .. })).await;
    assert!(!is_suspended(&h, id));
}

fn java_config(request: &str) -> LaunchConfig {
    LaunchConfig { adapter: "java-debug".into(), request: request.into(), extra_json: None, ..config() }
}

fn remote_attach(adapter: &str, project: &std::path::Path) -> LaunchConfig {
    LaunchConfig {
        adapter: adapter.into(),
        cwd: Some(project.to_owned().into()),
        extra_json: Some(json!({"projectRoot": project, "hostName": "10.0.0.5", "port": 5005}).to_string()),
        ..java_config("attach")
    }
}

#[tokio::test]
async fn attach_session_reports_capability() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    for adapter in ["java-debug", kotlin::ADAPTER] {
        let id = h.start(remote_attach(adapter, project.path())).await.unwrap();
        assert!(h.manager.capabilities(id).unwrap().jvm_memory, "{adapter}");
    }

    let id = h.start(config()).await.unwrap();
    assert!(!h.manager.capabilities(id).unwrap().jvm_memory);
    assert_eq!(
        h.manager.jvm_memory_classes(id).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::NoJvmProcess }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn ended_attach_session_without_pid_reports_program_exited() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let id = h.start(remote_attach("java-debug", project.path())).await.unwrap();
    h.manager.session(id).unwrap().terminated.store(true, Ordering::Release);
    assert_eq!(
        h.manager.jvm_memory_classes(id).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::ProgramExited }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn listen_mode_attach_is_not_scanned() {
    let h = harness(Script::default());
    let scans = Arc::new(Mutex::new(Vec::new()));
    let counted = scans.clone();
    h.manager.set_jvm_finder(Arc::new(move |port, _| {
        counted.lock().push(port);
        None
    }));
    let (_jvm, relay) = jdwp::tests::connected_jvm().await;
    let mut cfg = java_config("attach");
    cfg.extra_json = Some(json!({"hostName": "127.0.0.1", "port": relay}).to_string());
    let id = h.start(cfg).await.unwrap();
    assert_eq!(
        h.manager.jvm_memory_classes(id).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::ListenModeNotSupported }
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(scans.lock().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn remote_host_is_not_scanned() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let id = h.start(remote_attach("java-debug", project.path())).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert_eq!(session.jdwp_port.get(), None);
    assert_eq!(
        h.manager.jvm_memory_classes(id).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::AttachedJvmNotFound }
    );
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn local_attach_remembers_its_jdwp_port() {
    let h = harness(Script::default());
    let ports = Arc::new(Mutex::new(Vec::new()));
    let asked = ports.clone();
    h.manager.set_jvm_finder(Arc::new(move |port, _| {
        asked.lock().push(port);
        Some(4242)
    }));
    let mut cfg = java_config("attach");
    cfg.extra_json = Some(json!({"hostName": "localhost", "port": "5005"}).to_string());
    let id = h.start(cfg).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert_eq!(session.jdwp_port.get(), Some(&5005));
    assert_eq!(h.request("attach")["arguments"]["port"], "5005");
    for _ in 0..200 {
        if session.jvm_pid.load(Ordering::Acquire) != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 4242);
    assert_eq!(ports.lock().first(), Some(&5005));
}

/// A fake `find_jvm_by_jdwp_port` for the JVM 4242, recording whether each scan ran while
/// suspended. A JVM not `safe_while_suspended` (JDK below 17) is skipped by a suspended scan.
#[cfg(unix)]
fn counting_find(
    safe_while_suspended: bool,
) -> (Arc<Mutex<Vec<bool>>>, impl Fn(bool) -> Option<u32> + Clone + Send + 'static) {
    let scans = Arc::new(Mutex::new(Vec::new()));
    let counted = scans.clone();
    (scans, move |suspended| {
        counted.lock().push(suspended);
        (!suspended || safe_while_suspended).then_some(4242)
    })
}

#[cfg(unix)]
async fn suspended_remote_attach(h: &Harness) -> Arc<Session> {
    let project = tempfile::tempdir().unwrap();
    let id = h.start(remote_attach("java-debug", project.path())).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    let session = h.manager.session(id).unwrap();
    assert!(session.suspended.get());
    session
}

#[cfg(unix)]
#[tokio::test]
async fn background_scan_skips_an_old_jdk_while_suspended() {
    let h = harness(Script::default());
    let session = suspended_remote_attach(&h).await;
    let (scans, find) = counting_find(false);
    let task =
        jvm_memory::watch_for_attached_jvm(&session, 5005, find, Duration::from_millis(5), Duration::from_secs(5));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!scans.lock().is_empty() && scans.lock().iter().all(|&suspended| suspended));
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 0);

    session.suspended.continued();
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert_eq!(scans.lock().last(), Some(&false));
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 4242);
}

#[cfg(unix)]
#[tokio::test]
async fn background_scan_finds_a_jdk_17_or_later_while_suspended() {
    let h = harness(Script::default());
    let session = suspended_remote_attach(&h).await;
    let (scans, find) = counting_find(true);
    let task =
        jvm_memory::watch_for_attached_jvm(&session, 5005, find, Duration::from_millis(5), Duration::from_secs(5));
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert_eq!(*scans.lock(), [true]);
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 4242);
}

#[cfg(unix)]
#[tokio::test]
async fn background_scan_keeps_a_known_pid_and_stops_with_the_session() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let id = h.start(remote_attach("java-debug", project.path())).await.unwrap();
    h.wait_event(|e| matches!(e, DebugEvent::Stopped { .. })).await;
    let session = h.manager.session(id).unwrap();
    session.suspended.continued();
    session.jvm_pid.store(7, Ordering::Release);
    let watch = |find| {
        jvm_memory::watch_for_attached_jvm(&session, 5005, find, Duration::from_millis(5), Duration::from_secs(5))
    };
    let (scans, find) = counting_find(true);
    tokio::time::timeout(Duration::from_secs(2), watch(find)).await.unwrap().unwrap();
    assert!(scans.lock().is_empty(), "a known pid needs no scan");
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 7);

    // A refresh stores the pid while this scan is still running.
    session.jvm_pid.store(0, Ordering::Release);
    let racing = session.clone();
    let find = move |_| {
        racing.jvm_pid.store(7, Ordering::Release);
        Some(4242)
    };
    let task =
        jvm_memory::watch_for_attached_jvm(&session, 5005, find, Duration::from_millis(5), Duration::from_secs(5));
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert_eq!(session.jvm_pid.load(Ordering::Acquire), 7, "a pid stored first is kept");

    h.manager.stop(id).await.unwrap();
    let (scans, find) = counting_find(true);
    tokio::time::timeout(Duration::from_secs(2), watch(find)).await.unwrap().unwrap();
    assert!(scans.lock().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn unknown_pid_reports_no_jvm_process() {
    let h = harness(Script::default());
    let id = h.start(java_config("launch")).await.unwrap();
    assert!(h.manager.capabilities(id).unwrap().jvm_memory);
    assert_eq!(
        h.manager.jvm_memory_classes(id).await.unwrap(),
        JvmMemoryResult::Unavailable { reason: JvmMemoryUnavailable::NoJvmProcess }
    );
}

fn kotlin_attach(project: &std::path::Path, host: &str, port: u16) -> LaunchConfig {
    LaunchConfig {
        adapter: kotlin::ADAPTER.into(),
        cwd: Some(project.to_owned().into()),
        extra_json: Some(json!({"projectRoot": project, "hostName": host, "port": port}).to_string()),
        ..java_config("attach")
    }
}

#[test]
fn link_options_hold_only_for_fwcd() {
    assert!(kotlin::link_options(kotlin::ADAPTER).hold_resumes);
    assert!(!kotlin::link_options("x").hold_resumes);
}

#[tokio::test]
async fn kotlin_session_installs_link_inspector() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let id = h.start(kotlin_attach(project.path(), "127.0.0.1", 5005)).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert!(session.jdwp_link.lock().is_some());
    assert!(session.jvm_inspector.lock().is_some());
}

#[tokio::test]
async fn attach_target_recorded_before_kotlin_rewrite() {
    let h = harness(Script::default());
    let project = tempfile::tempdir().unwrap();
    let id = h.start(kotlin_attach(project.path(), "10.0.0.5", 5005)).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert_eq!(session.attach_target.get(), Some(&("10.0.0.5".to_owned(), 5005)));
    let sent = &h.request("attach")["arguments"];
    assert_eq!(sent["hostName"], "127.0.0.1");
    let link_port = sent["port"].as_u64().unwrap();
    assert!(link_port != 0 && link_port != 5005);
}

#[tokio::test]
async fn java_attach_records_target() {
    let h = harness(Script::default());
    let mut cfg = java_config("attach");
    cfg.extra_json = Some(json!({"hostName": "localhost", "port": 5005}).to_string());
    let id = h.start(cfg).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert_eq!(session.attach_target.get(), Some(&("localhost".to_owned(), 5005)));
    assert!(session.jdwp_link.lock().is_none());
    assert!(session.jvm_inspector.lock().is_none());
}

#[tokio::test]
async fn attach_target_recorded_for_any_adapter() {
    let h = harness(Script::default());
    let mut cfg = java_config("attach");
    // "x" is not a registered adapter; debugpy has no JVM link or memory support.
    cfg.adapter = "debugpy".into();
    cfg.extra_json = Some(json!({"hostName": "h", "port": 7}).to_string());
    let id = h.start(cfg).await.unwrap();
    assert_eq!(h.manager.session(id).unwrap().attach_target.get(), Some(&("h".to_owned(), 7)));
}

#[tokio::test]
async fn launch_sessions_have_no_attach_target() {
    let h = harness(Script::default());
    let id = h.start(java_config("launch")).await.unwrap();
    assert_eq!(h.manager.session(id).unwrap().attach_target.get(), None);
}

#[tokio::test]
async fn closing_the_session_drops_the_link() {
    let h = harness(Script { hang_up_on_pause: true, ..Script::default() });
    let project = tempfile::tempdir().unwrap();
    let id = h.start(kotlin_attach(project.path(), "127.0.0.1", 5005)).await.unwrap();
    let session = h.manager.session(id).unwrap();
    assert!(session.jdwp_link.lock().is_some() && session.jvm_inspector.lock().is_some());
    let _ = session.conn.request_timeout("pause", json!({"threadId": 1}), Duration::from_secs(2)).await;
    for _ in 0..200 {
        if h.manager.session(id).is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(session.jdwp_link.lock().is_none());
    assert!(session.jvm_inspector.lock().is_none());
}
