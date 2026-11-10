//! Drives real debug adapters against tiny programs (one per language), checking the
//! launch templates and the IDEA-parity features: line / method breakpoints, Smart Step
//! Into, Reset Frame, Force Step Over, Force Run to Cursor and Set Value.
//!
//! Ignored by default (needs the adapters installed). Run with
//! `OPENIDEA_DAP_FIXTURES=<dir> cargo test -p ide-dap --test real_adapters -- --ignored --nocapture`
//! where `<dir>` holds `py/app.py`, `node/app.js`, `go/demo` (built with `-N -l`),
//! `rust/target/debug/demo` and `c/main`. Adapters not found on `PATH` are skipped.

use ide_core::event::DebugEvent;
use ide_core::{DebugSessionId, IdeEvent, SharedSink};
use ide_dap::*;
use ide_language::LanguageRegistry;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Case {
    adapter: &'static str,
    /// Source file and the 0-based line of `total += parse(...)` inside the loop.
    source: PathBuf,
    loop_line: u32,
    /// Line of the `return total` after the loop (Force Run to Cursor target).
    after_loop: u32,
    function: &'static str,
    /// Persistent field watchpoint id, when the adapter has one (java-debug).
    field: Option<&'static str>,
    config: LaunchConfig,
}

fn launch(adapter: &str, program: &Path, cwd: &Path, extra: serde_json::Value) -> LaunchConfig {
    LaunchConfig {
        name: format!("{adapter} fixture"),
        adapter: adapter.into(),
        request: "launch".into(),
        program: Some(program.display().to_string()),
        args: vec![],
        cwd: Some(cwd.into()),
        env: BTreeMap::from([("OPENIDEA_FIXTURE".into(), "1".into())]),
        extra_json: Some(extra.to_string()),
    }
}

fn cases(dir: &Path) -> Vec<Case> {
    let py = dir.join("py");
    let node = dir.join("node");
    let go = dir.join("go");
    let rust = dir.join("rust");
    let c = dir.join("c");
    let java = dir.join("java");
    // java-debug runs inside jdtls: OPENIDEA_JAVA_DEBUG_SERVER is the port the IDE's
    // `java_debug_server` returned for this folder (classes compiled to java/out).
    let java_case =
        std::env::var("OPENIDEA_JAVA_DEBUG_SERVER").ok().and_then(|p| p.parse::<u16>().ok()).map(|port| Case {
            adapter: "java-debug",
            source: java.join("src/demo/Main.java"),
            loop_line: 14,
            after_loop: 16,
            function: "demo.Main#parse",
            field: Some("demo.Main#count"),
            config: LaunchConfig {
                program: None,
                ..launch(
                    "java-debug",
                    Path::new(""),
                    &java,
                    serde_json::json!({
                        "debugServer": port,
                        "mainClass": "demo.Main",
                        "classPaths": [java.join("out")],
                        "console": "internalConsole",
                    }),
                )
            },
        });
    let mut out: Vec<Case> = java_case.into_iter().collect();
    out.extend(vec![
        Case {
            adapter: "debugpy",
            source: py.join("app.py"),
            loop_line: 8,
            after_loop: 9,
            function: "parse",
            field: None,
            config: launch(
                "debugpy",
                &py.join("app.py"),
                &py,
                serde_json::json!({
                    "console": "internalConsole",
                    "justMyCode": true,
                    "redirectOutput": true,
                    "python": python(),
                }),
            ),
        },
        Case {
            adapter: "js-debug",
            source: node.join("app.js"),
            loop_line: 8,
            after_loop: 10,
            function: "parse",
            field: None,
            config: launch(
                "js-debug",
                &node.join("app.js"),
                &node,
                serde_json::json!({"type": "pwa-node", "console": "internalConsole", "outputCapture": "std"}),
            ),
        },
        Case {
            adapter: "delve",
            source: go.join("main.go"),
            loop_line: 15,
            after_loop: 17,
            function: "main.parse",
            field: None,
            config: launch("delve", &go.join("demo"), &go, serde_json::json!({"mode": "exec"})),
        },
        Case {
            adapter: "codelldb",
            source: rust.join("src/main.rs"),
            loop_line: 8,
            after_loop: 10,
            function: "parse",
            field: None,
            config: launch(
                "codelldb",
                &rust.join("target/debug/demo"),
                &rust,
                serde_json::json!({"sourceLanguages": ["rust"]}),
            ),
        },
        Case {
            adapter: "codelldb",
            source: c.join("main.c"),
            loop_line: 13,
            after_loop: 15,
            function: "parse",
            field: None,
            config: launch("codelldb", &c.join("main"), &c, serde_json::json!({})),
        },
        Case {
            adapter: "lldb-dap",
            source: c.join("main.c"),
            loop_line: 13,
            after_loop: 15,
            function: "parse",
            field: None,
            config: launch("lldb-dap", &c.join("main"), &c, serde_json::json!({"env": ["OPENIDEA_FIXTURE=1"]})),
        },
        // GDB's own DAP interpreter needs GDB 14+; older ones are skipped by `installed`.
        Case {
            adapter: "gdb",
            source: c.join("main.c"),
            loop_line: 13,
            after_loop: 15,
            function: "parse",
            field: None,
            config: launch("gdb", &c.join("main"), &c, serde_json::json!({})),
        },
    ]);
    out
}

struct Run {
    manager: Arc<DebugManager>,
    events: Arc<Mutex<Vec<(DebugSessionId, DebugEvent)>>>,
    owner: SessionOwner,
}

impl Run {
    fn new() -> Self {
        let events: Arc<Mutex<Vec<(DebugSessionId, DebugEvent)>>> = Arc::default();
        let sink_events = events.clone();
        let sink: SharedSink = Arc::new(move |e: IdeEvent| {
            if let IdeEvent::Debug { session, event } = e {
                sink_events.lock().push((session, event));
            }
        });
        let languages = Arc::new(LanguageRegistry::from_configs(Vec::new()));
        Self { manager: DebugManager::new(languages), events, owner: SessionOwner::new("test", sink) }
    }

    /// Waits for a `stopped` event after `seen` events; returns (session, thread, reason).
    async fn stopped_after(&self, seen: usize) -> Option<(DebugSessionId, i64, String)> {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            let found = self.events.lock().iter().skip(seen).find_map(|(s, e)| match e {
                DebugEvent::Stopped { thread_id, reason, .. } => Some((*s, *thread_id, reason.clone())),
                _ => None,
            });
            if found.is_some() {
                return found;
            }
            if self.events.lock().iter().skip(seen).any(|(_, e)| matches!(e, DebugEvent::Terminated)) {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }

    fn seen(&self) -> usize {
        self.events.lock().len()
    }

    async fn top(&self, s: DebugSessionId, thread: i64) -> StackFrame {
        self.manager.stack_trace(s, thread).await.unwrap().into_iter().next().unwrap()
    }
}

/// Bin dirs of the IDE's managed tools (the app prepends them to `PATH` at startup).
fn add_managed_tools_to_path() {
    // `RUST_LOG=ide_dap::wire=trace` prints the DAP traffic.
    let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).try_init();
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    // Like the app: adapters installed by OpenIDEA are found without being on PATH.
    adapter::set_tools_root(home.join("Library/Application Support/ai.l0ng.openidea/tools"));
}

/// The debuggee interpreter (`OPENIDEA_PYTHON`, e.g. one without debugpy).
fn python() -> String {
    std::env::var("OPENIDEA_PYTHON").unwrap_or_else(|_| "python3".into())
}

fn installed(adapter: &str) -> bool {
    let cmd = match adapter {
        "debugpy" => {
            let managed = adapter::tools_root()
                .is_some_and(|r| r.join(adapter::DEBUGPY_TOOL).join("lib/debugpy/__init__.py").is_file());
            return managed
                || std::process::Command::new(python())
                    .args(["-c", "import debugpy"])
                    .status()
                    .is_ok_and(|s| s.success());
        }
        "js-debug" => "js-debug-adapter",
        "delve" => "dlv",
        "java-debug" => return true,
        // Only a GDB with the DAP interpreter (14+) counts as installed.
        "gdb" => {
            return std::process::Command::new("gdb").arg("--version").output().is_ok_and(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .and_then(adapter::parse_gdb_version)
                    .is_some_and(|(major, _)| major >= 14)
            });
        }
        other => other,
    };
    adapter::resolve_binary(cmd, Path::new("/")).is_some()
}

async fn scenario(case: &Case) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    let run = Run::new();
    let m = &run.manager;
    let line_bp =
        Breakpoint { line: case.loop_line, condition: None, hit_condition: None, log_message: None, enabled: true };
    m.set_breakpoints(case.source.clone(), vec![line_bp]).await.map_err(|e| e.message)?;

    let seen = run.seen();
    let id = m.start(case.config.clone(), run.owner.clone()).await.map_err(|e| format!("start: {}", e.message))?;
    let Some((s, thread, reason)) = run.stopped_after(seen).await else {
        let log: Vec<String> = run.events.lock().iter().map(|(_, e)| format!("{e:?}")).collect();
        return Err(format!(
            "no stop at the line breakpoint; events: {log:#?}; states: {:?}",
            m.breakpoint_states(&case.source)
        ));
    };
    let top = run.top(s, thread).await;
    if top.line != case.loop_line {
        return Err(format!("stopped at line {} ({reason}), expected {}", top.line, case.loop_line));
    }
    report.push(format!("launch + line breakpoint: stopped at {}:{}", top.name, top.line + 1));
    let caps = m.capabilities(s).map_err(|e| e.message)?;
    report.push(format!("capabilities: {caps:?}"));

    // Set Value on the first local that is an integer.
    let scopes = m.scopes(s, top.id).await.map_err(|e| e.message)?;
    for scope in scopes.iter().filter(|sc| !sc.expensive) {
        let vars = m.variables(s, scope.variables_reference).await.map_err(|e| e.message)?;
        if let Some(v) = vars.iter().find(|v| v.name == "total") {
            match m
                .set_variable(
                    s,
                    scope.variables_reference,
                    v.name.clone(),
                    v.evaluate_name.clone(),
                    Some(top.id),
                    "40".into(),
                )
                .await
            {
                Ok(nv) => report.push(format!("set value: total = {}", nv.value)),
                Err(e) => report.push(format!("set value: FAILED {}", e.message)),
            }
            break;
        }
    }

    // Reset Frame: one line further, then back to the start of `run`.
    if caps.restart_frame {
        let seen = run.seen();
        m.step(s, thread, StepKind::Over).await.map_err(|e| e.message)?;
        run.stopped_after(seen).await.ok_or("no stop after step over")?;
        let before = run.top(s, thread).await;
        let seen = run.seen();
        match m.restart_frame(s, before.id).await {
            Ok(()) => {
                run.stopped_after(seen).await.ok_or("no stop after reset frame")?;
                let r = run.top(s, thread).await;
                report.push(format!("reset frame: {}:{} -> {}:{}", before.name, before.line + 1, r.name, r.line + 1));
            }
            Err(e) => report.push(format!("reset frame: FAILED {}", e.message)),
        }
        let seen = run.seen();
        m.resume(s, thread).await.map_err(|e| e.message)?;
        run.stopped_after(seen).await.ok_or("no stop at the loop after reset frame")?;
    }

    // Smart Step Into.
    if caps.step_in_targets {
        let targets = m.step_in_targets(s, top.id).await.map_err(|e| e.message)?;
        report.push(format!("step-in targets: {:?}", targets.iter().map(|t| t.label.as_str()).collect::<Vec<_>>()));
        if let Some(t) = targets.iter().find(|t| t.label.contains("parse")) {
            let seen = run.seen();
            m.step_in_target(s, thread, t.id).await.map_err(|e| e.message)?;
            run.stopped_after(seen).await.ok_or("no stop after smart step into")?;
            let f = run.top(s, thread).await;
            report.push(format!("smart step into: now in {}", f.name));
            // Reset Frame back to the start of parse.
            if caps.restart_frame {
                let seen = run.seen();
                match m.restart_frame(s, f.id).await {
                    Ok(()) => {
                        run.stopped_after(seen).await.ok_or("no stop after reset frame")?;
                        let r = run.top(s, thread).await;
                        report.push(format!("reset frame: at {}:{}", r.name, r.line + 1));
                    }
                    Err(e) => report.push(format!("reset frame: FAILED {}", e.message)),
                }
            }
            let seen = run.seen();
            m.step(s, thread, StepKind::Out).await.map_err(|e| e.message)?;
            run.stopped_after(seen).await.ok_or("no stop after step out")?;
        }
    } else {
        report.push("step-in targets: not supported".into());
    }

    // Method breakpoint: continue → stops in `parse`.
    if caps.function_breakpoints {
        let fb = FunctionBreakpoint { name: case.function.into(), condition: None, hit_condition: None, enabled: true };
        let states = m.set_function_breakpoints(vec![fb]).await.map_err(|e| e.message)?;
        report.push(format!("method breakpoint `{}`: verified={}", case.function, states[0].verified));
        m.set_breakpoints(case.source.clone(), vec![]).await.map_err(|e| e.message)?;
        let seen = run.seen();
        m.resume(s, thread).await.map_err(|e| e.message)?;
        match run.stopped_after(seen).await {
            Some((_, t, reason)) => {
                let f = run.top(s, t).await;
                report.push(format!("method breakpoint hit: {reason} in {}", f.name));
            }
            None => report.push("method breakpoint: NOT HIT".into()),
        }
        m.set_function_breakpoints(vec![]).await.map_err(|e| e.message)?;
        m.set_breakpoints(case.source.clone(), vec![line_bp_at(case.loop_line)]).await.map_err(|e| e.message)?;
        let seen = run.seen();
        m.step(s, thread, StepKind::Out).await.map_err(|e| e.message)?;
        run.stopped_after(seen).await.ok_or("no stop after step out of parse")?;
    } else {
        report.push("method breakpoints: not supported".into());
    }

    // Force Step Over ignores the breakpoint inside parse.
    m.set_breakpoints(case.source.clone(), vec![line_bp_at(case.loop_line)]).await.map_err(|e| e.message)?;
    let seen = run.seen();
    m.force_step_over(s, thread).await.map_err(|e| e.message)?;
    let (_, t, reason) = run.stopped_after(seen).await.ok_or("no stop after force step over")?;
    let f = run.top(s, t).await;
    report.push(format!("force step over: {reason} at line {}", f.line + 1));

    // Field watchpoint / data breakpoint on `total` (java-debug: a field id).
    if caps.data_breakpoints {
        let frame = run.top(s, thread).await;
        let mut data_id = case.field.map(str::to_owned);
        if data_id.is_none() {
            for scope in m.scopes(s, frame.id).await.map_err(|e| e.message)?.iter().filter(|sc| !sc.expensive) {
                if let Ok(info) =
                    m.data_breakpoint_info(s, scope.variables_reference, "total".into(), Some(frame.id)).await
                    && info.data_id.is_some()
                {
                    data_id = info.data_id;
                    break;
                }
            }
        }
        match data_id {
            Some(data_id) => {
                let wp = DataBreakpoint {
                    data_id: data_id.clone(),
                    access_type: Some("write".into()),
                    condition: None,
                    hit_condition: None,
                    enabled: true,
                };
                let states = m.set_data_breakpoints(vec![wp]).await.map_err(|e| e.message)?;
                m.set_breakpoints(case.source.clone(), vec![]).await.map_err(|e| e.message)?;
                let seen = run.seen();
                m.resume(s, thread).await.map_err(|e| e.message)?;
                match run.stopped_after(seen).await {
                    Some((_, t, reason)) => {
                        let f = run.top(s, t).await;
                        report.push(format!(
                            "watchpoint `{data_id}` (verified={}): {reason} at {}:{}",
                            states[0].verified,
                            f.name,
                            f.line + 1
                        ));
                    }
                    None => report.push(format!("watchpoint `{data_id}`: NOT HIT")),
                }
                m.set_data_breakpoints(vec![]).await.map_err(|e| e.message)?;
                m.set_breakpoints(case.source.clone(), vec![line_bp_at(case.loop_line)])
                    .await
                    .map_err(|e| e.message)?;
            }
            None => report.push("watchpoint: no data id for `total`".into()),
        }
    }

    // Force Run to Cursor past the loop, ignoring the loop breakpoint.
    let seen = run.seen();
    m.run_to(s, thread, case.source.clone(), case.after_loop, true).await.map_err(|e| e.message)?;
    let (_, t, reason) = run.stopped_after(seen).await.ok_or("no stop after force run to cursor")?;
    let f = run.top(s, t).await;
    report.push(format!("force run to cursor: {reason} at line {} (want {})", f.line + 1, case.after_loop + 1));

    m.stop(id).await.map_err(|e| e.message)?;
    Ok(report)
}

fn line_bp_at(line: u32) -> Breakpoint {
    Breakpoint { line, condition: None, hit_condition: None, log_message: None, enabled: true }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs real debug adapters and OPENIDEA_DAP_FIXTURES"]
async fn real_adapters() {
    let Some(dir) = std::env::var_os("OPENIDEA_DAP_FIXTURES").map(PathBuf::from) else {
        eprintln!("OPENIDEA_DAP_FIXTURES not set");
        return;
    };
    add_managed_tools_to_path();
    let only = std::env::var("OPENIDEA_DAP_ONLY").ok();
    let mut failures = Vec::new();
    for case in cases(&dir) {
        if only.as_deref().is_some_and(|o| o != case.adapter) {
            continue;
        }
        let name = format!("{} ({})", case.adapter, case.source.file_name().unwrap().to_string_lossy());
        if !installed(case.adapter) {
            println!("== {name}: SKIPPED (not installed)");
            continue;
        }
        match tokio::time::timeout(Duration::from_secs(240), scenario(&case)).await {
            Ok(Ok(lines)) => {
                println!("== {name}: OK");
                for l in lines {
                    println!("   {l}");
                }
            }
            Ok(Err(e)) => {
                println!("== {name}: FAILED {e}");
                failures.push(name);
            }
            Err(_) => {
                println!("== {name}: TIMED OUT");
                failures.push(name);
            }
        }
    }
    assert!(failures.is_empty(), "failed: {failures:?}");
}

struct AttachCase {
    kind: attach::AttachKind,
    command: Vec<String>,
    source: PathBuf,
    /// 0-based line inside `tick`.
    line: u32,
    extra: fn(u32, Option<u16>) -> serde_json::Value,
}

/// Attach to Process: each fixture server is listed with the right debugger, and attaching
/// with the request `attach.ts` builds stops at a breakpoint in its loop.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs real debug adapters and OPENIDEA_DAP_FIXTURES"]
async fn attach_to_processes() {
    let Some(dir) = std::env::var_os("OPENIDEA_DAP_FIXTURES").map(PathBuf::from) else { return };
    add_managed_tools_to_path();
    let s = |p: &Path| p.display().to_string();
    let java_server = std::env::var("OPENIDEA_JAVA_DEBUG_SERVER").ok().and_then(|p| p.parse::<u16>().ok());
    let mut cases = vec![
        // `debugpy --pid` injection ships only an x86_64 helper on macOS, so on Apple
        // Silicon the attach goes through a `debugpy --listen` process.
        AttachCase {
            kind: attach::AttachKind::Python,
            command: vec![
                "python3".into(),
                "-m".into(),
                "debugpy".into(),
                "--listen".into(),
                "127.0.0.1:5931".into(),
                s(&dir.join("py/server.py")),
            ],
            source: dir.join("py/server.py"),
            line: 4,
            extra: |pid, port| match port {
                // `debugpy --listen` runs its own adapter on that port: talk DAP to it directly.
                Some(port) => serde_json::json!({"debugServer": port, "justMyCode": true}),
                None => serde_json::json!({"processId": pid, "justMyCode": true}),
            },
        },
        AttachCase {
            kind: attach::AttachKind::Node,
            command: match std::env::var("OPENIDEA_NODE_INSPECT") {
                Ok(flag) => vec!["node".into(), flag, s(&dir.join("node/server.js"))],
                Err(_) => vec!["node".into(), s(&dir.join("node/server.js"))],
            },
            source: dir.join("node/server.js"),
            line: 2,
            extra: |pid, port| match port {
                Some(port) => {
                    serde_json::json!({"type": "pwa-node", "address": "127.0.0.1", "port": port, "continueOnAttach": true})
                }
                None => serde_json::json!({"type": "pwa-node", "processId": pid.to_string(), "continueOnAttach": true}),
            },
        },
        AttachCase {
            kind: attach::AttachKind::Go,
            command: vec![s(&dir.join("goserver/server"))],
            source: dir.join("goserver/main.go"),
            line: 5,
            extra: |pid, _| serde_json::json!({"mode": "local", "processId": pid}),
        },
        AttachCase {
            kind: attach::AttachKind::Native,
            command: vec![s(&dir.join("c/server"))],
            source: dir.join("c/server.c"),
            line: 3,
            extra: |pid, _| serde_json::json!({"pid": pid}),
        },
    ];
    if java_server.is_some() {
        cases.insert(
            0,
            AttachCase {
                kind: attach::AttachKind::Java,
                command: vec![
                    "java".into(),
                    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5917".into(),
                    "-cp".into(),
                    s(&dir.join("java/out")),
                    "demo.Server".into(),
                ],
                source: dir.join("java/src/demo/Server.java"),
                line: 4,
                extra: |_, port| serde_json::json!({"hostName": "localhost", "port": port}),
            },
        );
    }
    let only = std::env::var("OPENIDEA_DAP_ONLY").ok();
    let mut failures = Vec::new();
    for case in cases {
        let label = format!("{:?}", case.kind);
        if only.as_deref().is_some_and(|o| !label.eq_ignore_ascii_case(o)) {
            continue;
        }
        let mut child = std::process::Command::new(&case.command[0])
            .args(&case.command[1..])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let result = async {
            let list =
                tokio::task::spawn_blocking(attach::attachable_processes).await.unwrap().map_err(|e| e.message)?;
            let p = list.iter().find(|p| p.pid == child.id()).ok_or("process not listed")?;
            if p.kind != case.kind {
                return Err(format!("listed as {:?}", p.kind));
            }
            let mut extra = (case.extra)(p.pid, p.port);
            if p.kind == attach::AttachKind::Java {
                extra["debugServer"] = java_server.unwrap().into();
            }
            let config = LaunchConfig {
                name: format!("{} ({})", p.name, p.pid),
                adapter: p.adapter.clone(),
                request: "attach".into(),
                program: None,
                args: vec![],
                cwd: case.source.parent().map(Into::into),
                env: BTreeMap::new(),
                extra_json: Some(extra.to_string()),
            };
            let run = Run::new();
            run.manager
                .set_breakpoints(case.source.clone(), vec![line_bp_at(case.line)])
                .await
                .map_err(|e| e.message)?;
            let id =
                run.manager.start(config, run.owner.clone()).await.map_err(|e| format!("attach: {}", e.message))?;
            let Some((s, thread, reason)) = run.stopped_after(0).await else {
                let mut log: Vec<String> = run.events.lock().iter().map(|(_, e)| format!("{e:?}")).collect();
                for info in run.manager.sessions(None) {
                    let threads = run.manager.threads(info.id).await;
                    log.push(format!("session {:?} threads {threads:?}", info.id));
                    if let Ok(t) = threads
                        && let Some(t) = t.first()
                    {
                        let seen = run.seen();
                        let _ = run.manager.pause(info.id, t.id).await;
                        if let Some((s, th, r)) = run.stopped_after(seen).await {
                            let frames = run.manager.stack_trace(s, th).await;
                            log.push(format!(
                                "paused ({r}): {:?}",
                                frames.map(|f| f
                                    .into_iter()
                                    .take(3)
                                    .map(|f| (f.name, f.path, f.line))
                                    .collect::<Vec<_>>())
                            ));
                        }
                    }
                }
                log.push(format!("states: {:?}", run.manager.breakpoint_states(&case.source)));
                let _ = run.manager.stop(id).await;
                return Err(format!("no stop after attaching: {log:#?}"));
            };
            let top = run.top(s, thread).await;
            let _ = run.manager.stop(id).await;
            Ok::<_, String>(format!("{} via {}: {reason} at {}:{}", p.name, p.adapter, top.name, top.line + 1))
        };
        let outcome = tokio::time::timeout(Duration::from_secs(150), result).await;
        let _ = child.kill();
        let _ = child.wait();
        match outcome {
            Ok(Ok(line)) => println!("== attach {label}: OK {line}"),
            Ok(Err(e)) => {
                println!("== attach {label}: FAILED {e}");
                failures.push(label);
            }
            Err(_) => {
                println!("== attach {label}: TIMED OUT");
                failures.push(label);
            }
        }
    }
    assert!(failures.is_empty(), "failed: {failures:?}");
}
