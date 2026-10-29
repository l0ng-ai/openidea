//! Protocol flow against an in-memory fake adapter.

use super::*;
use crate::adapter::{AdapterIo, LaunchFuture};
use ide_core::IdeEvent;
use ide_core::event::DebugEvent;
use ide_jsonrpc::framing;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Clone, Default)]
struct Script {
    /// Send a `runInTerminal` reverse request when `launch` arrives.
    run_in_terminal: Option<Vec<String>>,
    /// Send a `startDebugging` reverse request (child session) when a non-child `launch` arrives.
    start_debugging: bool,
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
            Ok(AdapterIo { reader: Box::new(r), writer: Box::new(w), child: None, port: None, stderr: Arc::default() })
        })
    }
}

async fn fake_adapter<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(stream: S, log: Log, script: Script) {
    let (r, mut w) = tokio::io::split(stream);
    let mut r = BufReader::new(r);
    let mut seq = 1000;
    let mut pending_launch: Option<i64> = None;
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
                    "supportsTerminateRequest": true,
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
                let bps: Vec<Value> = msg["arguments"]["breakpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(i, b)| json!({"id": i + 1, "verified": true, "line": b["line"]}))
                    .collect();
                ok!(msg, json!({"breakpoints": bps}));
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
                ok!(msg, Value::Null);
                if let Some(l) = pending_launch.take() {
                    send!(json!({"type": "response", "request_seq": l, "command": "launch", "success": true}));
                }
                send!(json!({"type": "event", "event": "output", "body": {"category": "stdout", "output": "hello\n"}}));
                send!(
                    json!({"type": "event", "event": "stopped", "body": {"reason": "breakpoint", "threadId": 1, "allThreadsStopped": true}})
                );
                send!(
                    json!({"type": "event", "event": "breakpoint", "body": {"reason": "changed", "breakpoint": {"id": 1, "verified": false, "message": "moved", "line": 9}}})
                );
            }
            "threads" => ok!(msg, json!({"threads": [{"id": 1, "name": "MainThread"}]})),
            "stackTrace" => ok!(
                msg,
                json!({"stackFrames": [
                    {"id": 10, "name": "main", "line": 5, "column": 3, "source": {"path": "/p/a.py"}},
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
            "continue" => {
                ok!(msg, json!({"allThreadsContinued": true}));
                send!(json!({"type": "event", "event": "exited", "body": {"exitCode": 3}}));
                send!(json!({"type": "event", "event": "terminated"}));
            }
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
        tree_sitter: None,
        language_servers: vec![],
        debugger: Some(ide_language::DebuggerConfig {
            adapter: "godot".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            transport: "tcp".into(),
            connect: Some(format!("127.0.0.1:{port}")),
            install_hint: Some("Open the project in the Godot editor".into()),
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
