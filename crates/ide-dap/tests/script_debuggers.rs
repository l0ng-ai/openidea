//! Drives the script-language debuggers (debugpy, js-debug for Node / TypeScript / npm
//! scripts / Deno) through a whole session with the launch arguments the UI builds
//! (`src/features/debugger/launch.ts`): breakpoint verified and hit, stack, scopes,
//! variables, evaluate, step into / over / out, continue, run to exit, then a restart
//! that is terminated while paused.
//!
//! Ignored by default (needs the adapters and runtimes). Run with
//! `OPENIDEA_DAP_FIXTURES=<dir> cargo test -p ide-dap --test script_debuggers -- --ignored --nocapture`
//! where `<dir>` holds `py/app.py`, `node/app.js`, `ts/app.ts`, `tsmap/app.ts` compiled
//! with `tsc --sourceMap --outDir out`, `tsx/app.ts` (with `npm i tsx` there), `npm/`
//! (script `start` = `node app.js`) and `deno/app.ts`, all with the same layout (see `LOOP_LINE`). `OPENIDEA_DAP_ONLY=<case>`
//! runs one case. Cases whose adapter or runtime is missing are skipped.

use ide_core::event::DebugEvent;
use ide_core::{DebugSessionId, IdeEvent, SharedSink};
use ide_dap::*;
use ide_language::LanguageRegistry;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 0-based line of `total += parse(s)` in every fixture.
const LOOP_LINE: u32 = 8;
/// First line of `parse`'s body, and the one after it.
const PARSE_BODY: u32 = 2;
/// `console.log` / `print` of the result: `total 12`.
const OUTPUT: &str = "total 12";

struct Case {
    name: &'static str,
    /// Breakpoints are set here (the TypeScript source for source-mapped cases).
    source: PathBuf,
    /// The runtime that must be installed, besides the adapter.
    runtime: &'static str,
    config: LaunchConfig,
}

fn config(adapter: &str, program: Option<PathBuf>, cwd: &Path, extra: Value) -> LaunchConfig {
    LaunchConfig {
        name: "fixture".into(),
        adapter: adapter.into(),
        request: "launch".into(),
        program: program.map(|p| p.display().to_string()),
        args: vec![],
        cwd: Some(cwd.into()),
        env: BTreeMap::new(),
        extra_json: Some(extra.to_string()),
    }
}

/// `jsDebugLaunch` in launch.ts, plus `more`.
fn js_extra(more: Value) -> Value {
    let mut extra = json!({
        "type": "pwa-node",
        "console": "internalConsole",
        "outputCapture": "std",
        "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
        "autoAttachChildProcesses": true,
    });
    if let (Some(e), Value::Object(more)) = (extra.as_object_mut(), more) {
        e.extend(more);
    }
    extra
}

fn cases(dir: &Path) -> Vec<Case> {
    let d = |s: &str| dir.join(s);
    vec![
        Case {
            name: "python",
            source: d("py/app.py"),
            runtime: "python3",
            config: config(
                "debugpy",
                Some(d("py/app.py")),
                &d("py"),
                json!({
                    "python": "python3",
                    "console": "internalConsole",
                    "justMyCode": true,
                    "subProcess": true,
                    "redirectOutput": true,
                }),
            ),
        },
        Case {
            name: "node",
            source: d("node/app.js"),
            runtime: "node",
            config: config("js-debug", Some(d("node/app.js")), &d("node"), js_extra(json!({}))),
        },
        Case {
            // Node 22.18+ strips types natively.
            name: "typescript",
            source: d("ts/app.ts"),
            runtime: "node",
            config: config("js-debug", Some(d("ts/app.ts")), &d("ts"), js_extra(json!({}))),
        },
        Case {
            name: "typescript-flag",
            source: d("ts/app.ts"),
            runtime: "node",
            config: config(
                "js-debug",
                None,
                &d("ts"),
                js_extra(json!({"runtimeExecutable": "node", "runtimeArgs": ["--experimental-strip-types", "app.ts"]})),
            ),
        },
        Case {
            // `tsx/node_modules/.bin/tsx` (`npm i tsx` there): a runner on Node, source-mapped.
            name: "tsx",
            source: d("tsx/app.ts"),
            runtime: "node",
            config: config(
                "js-debug",
                None,
                &d("tsx"),
                js_extra(json!({
                    "runtimeExecutable": d("tsx/node_modules/.bin/tsx"),
                    "runtimeArgs": ["app.ts"],
                })),
            ),
        },
        Case {
            name: "sourcemap",
            source: d("tsmap/app.ts"),
            runtime: "node",
            config: config("js-debug", Some(d("tsmap/out/app.js")), &d("tsmap"), js_extra(json!({}))),
        },
        Case {
            name: "npm",
            source: d("npm/app.js"),
            runtime: "npm",
            config: config(
                "js-debug",
                None,
                &d("npm"),
                js_extra(json!({"runtimeExecutable": "npm", "runtimeArgs": ["run", "start"]})),
            ),
        },
        Case {
            name: "deno",
            source: d("deno/app.ts"),
            runtime: "deno",
            config: config(
                "js-debug",
                None,
                &d("deno"),
                js_extra(json!({
                    "runtimeExecutable": "deno",
                    "runtimeArgs": ["run", "--inspect-wait=127.0.0.1:${freePort}", "app.ts"],
                    "attachSimplePort": "${freePort}",
                })),
            ),
        },
    ]
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

    fn seen(&self) -> usize {
        self.events.lock().len()
    }

    fn log(&self) -> String {
        let log: Vec<String> = self.events.lock().iter().map(|(s, e)| format!("{}: {e:?}", s.0)).collect();
        log.join("\n")
    }

    async fn wait<T>(
        &self,
        seen: usize,
        what: &str,
        f: impl Fn(DebugSessionId, &DebugEvent) -> Option<T>,
    ) -> Result<T, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Some(hit) = self.events.lock().iter().skip(seen).find_map(|(s, e)| f(*s, e)) {
                return Ok(hit);
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Err(format!("timed out waiting for {what}; events:\n{}", self.log()))
    }

    async fn stopped(&self, seen: usize, what: &str) -> Result<(DebugSessionId, i64), String> {
        self.wait(seen, what, |s, e| match e {
            DebugEvent::Stopped { thread_id, .. } => Some((s, *thread_id)),
            _ => None,
        })
        .await
    }

    async fn step(&self, s: DebugSessionId, thread: i64, kind: StepKind) -> Result<StackFrame, String> {
        let seen = self.seen();
        self.manager.step(s, thread, kind).await.map_err(|e| e.message)?;
        self.stopped(seen, &format!("{kind:?}")).await?;
        self.top(s, thread).await
    }

    async fn top(&self, s: DebugSessionId, thread: i64) -> Result<StackFrame, String> {
        let frames = self.manager.stack_trace(s, thread).await.map_err(|e| e.message)?;
        frames.into_iter().next().ok_or_else(|| "empty stack".into())
    }

    /// Every session of the run has ended (js-debug runs the program in a child session).
    async fn all_terminated(&self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if self.manager.sessions(None).is_empty() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(format!("sessions still live: {:?}", self.manager.sessions(None)))
    }
}

fn bp(line: u32) -> Breakpoint {
    Breakpoint { line, condition: None, hit_condition: None, log_message: None, enabled: true }
}

fn expect_line(f: &StackFrame, line: u32, what: &str) -> Result<(), String> {
    if f.line == line {
        Ok(())
    } else {
        Err(format!("{what}: at {}:{} ({:?}), expected line {}", f.name, f.line + 1, f.path, line + 1))
    }
}

async fn scenario(case: &Case) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    let run = Run::new();
    let m = &run.manager;
    m.set_breakpoints("test", case.source.clone(), vec![bp(LOOP_LINE)]).await.map_err(|e| e.message)?;
    let id = m.start(case.config.clone(), run.owner.clone()).await.map_err(|e| format!("start: {}", e.message))?;

    let (s, thread) = run.stopped(0, "the loop breakpoint").await?;
    // js-debug verifies in a `breakpoint` event right after the stop.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !m.breakpoint_states(&case.source).first().is_some_and(|st| st.verified) {
        if Instant::now() > deadline {
            return Err(format!("breakpoint not verified: {:?}", m.breakpoint_states(&case.source)));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let top = run.top(s, thread).await?;
    expect_line(&top, LOOP_LINE, "breakpoint")?;
    if top.path.as_deref().map(|p| p.canonicalize().ok()) != Some(case.source.canonicalize().ok()) {
        return Err(format!("frame source {:?}, expected {}", top.path, case.source.display()));
    }
    report.push(format!("hit {}:{} (verified)", top.name, top.line + 1));

    let scopes = m.scopes(s, top.id).await.map_err(|e| e.message)?;
    // js-debug puts the loop variable in a Block scope before Local.
    let mut vars = Vec::new();
    for scope in scopes.iter().filter(|sc| !sc.expensive) {
        vars.extend(m.variables(s, scope.variables_reference).await.map_err(|e| e.message)?);
    }
    let total = vars.iter().find(|v| v.name == "total").ok_or_else(|| format!("no `total` in {vars:?}"))?;
    let items = vars.iter().find(|v| v.name == "items").ok_or_else(|| format!("no `items` in {vars:?}"))?;
    let children = m.variables(s, items.variables_reference).await.map_err(|e| e.message)?;
    report.push(format!(
        "scopes {:?}; total = {}; items has {} children",
        scopes.iter().map(|sc| sc.name.as_str()).collect::<Vec<_>>(),
        total.value,
        children.len()
    ));
    let v = m.evaluate(s, Some(top.id), "total + 100".into()).await.map_err(|e| e.message)?;
    if v.value != "100" {
        return Err(format!("evaluate: {}", v.value));
    }

    let f = run.step(s, thread, StepKind::Into).await?;
    if !f.name.ends_with("parse") {
        return Err(format!("step into: in {} at {}", f.name, f.line + 1));
    }
    expect_line(&f, PARSE_BODY, "step into")?;
    let f = run.step(s, thread, StepKind::Over).await?;
    expect_line(&f, PARSE_BODY + 1, "step over")?;
    let f = run.step(s, thread, StepKind::Out).await?;
    if !f.name.ends_with("run") {
        return Err(format!("step out: in {} at {}", f.name, f.line + 1));
    }
    report.push(format!("step into / over / out: back in {}:{}", f.name, f.line + 1));

    // Continue: the loop breakpoint again (second item).
    let seen = run.seen();
    m.resume(s, thread).await.map_err(|e| e.message)?;
    let (s2, t2) = run.stopped(seen, "the second hit").await?;
    expect_line(&run.top(s2, t2).await?, LOOP_LINE, "continue")?;

    // Without breakpoints, the program runs to its end.
    m.set_breakpoints("test", case.source.clone(), vec![]).await.map_err(|e| e.message)?;
    let seen = run.seen();
    m.resume(s2, t2).await.map_err(|e| e.message)?;
    run.wait(seen, "terminated", |s, e| (s == id && matches!(e, DebugEvent::Terminated)).then_some(())).await?;
    // debugpy may deliver one `print` in several chunks.
    let stdout: String = run
        .events
        .lock()
        .iter()
        .filter_map(|(_, e)| match e {
            DebugEvent::Output { category, output } if category == "stdout" => Some(output.as_str()),
            _ => None,
        })
        .collect();
    if !stdout.contains(OUTPUT) {
        return Err(format!("stdout {stdout:?} lacks {OUTPUT:?}"));
    }
    run.all_terminated().await?;
    report.push("continue to exit: output and terminated".into());

    // Restart (the UI starts the same configuration again), then Stop while paused.
    m.set_breakpoints("test", case.source.clone(), vec![bp(LOOP_LINE)]).await.map_err(|e| e.message)?;
    let seen = run.seen();
    let again = m.start(case.config.clone(), run.owner.clone()).await.map_err(|e| format!("restart: {}", e.message))?;
    let (s, thread) = run.stopped(seen, "the breakpoint after restart").await?;
    expect_line(&run.top(s, thread).await?, LOOP_LINE, "restart")?;
    let seen = run.seen();
    m.stop(again).await.map_err(|e| e.message)?;
    run.wait(seen, "terminated after stop", |s, e| (s == again && matches!(e, DebugEvent::Terminated)).then_some(()))
        .await?;
    run.all_terminated().await?;
    report.push("restart + stop while paused: terminated".into());
    Ok(report)
}

fn on_path(cmd: &str) -> bool {
    adapter::resolve_binary(cmd, Path::new("/")).is_some()
}

fn installed(case: &Case) -> bool {
    let adapter = match case.config.adapter.as_str() {
        "debugpy" => {
            std::process::Command::new("python3").args(["-c", "import debugpy"]).status().is_ok_and(|s| s.success())
                || adapter::tools_root()
                    .is_some_and(|r| r.join(adapter::DEBUGPY_TOOL).join("lib/debugpy/__init__.py").is_file())
        }
        _ => on_path("js-debug-adapter"),
    };
    adapter && on_path(case.runtime) && case.source.is_file()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs real debug adapters and OPENIDEA_DAP_FIXTURES"]
async fn script_debuggers() {
    let Some(dir) = std::env::var_os("OPENIDEA_DAP_FIXTURES").map(PathBuf::from) else {
        eprintln!("OPENIDEA_DAP_FIXTURES not set");
        return;
    };
    let dir = dir.canonicalize().unwrap();
    let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).try_init();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        adapter::set_tools_root(home.join("Library/Application Support/ai.l0ng.openidea/tools"));
    }
    let only = std::env::var("OPENIDEA_DAP_ONLY").ok();
    let mut failures = Vec::new();
    for case in cases(&dir) {
        if only.as_deref().is_some_and(|o| o != case.name) {
            continue;
        }
        if !installed(&case) {
            println!("== {}: SKIPPED (adapter, runtime or fixture missing)", case.name);
            continue;
        }
        match tokio::time::timeout(Duration::from_secs(180), scenario(&case)).await {
            Ok(Ok(lines)) => {
                println!("== {}: OK", case.name);
                for l in lines {
                    println!("   {l}");
                }
            }
            Ok(Err(e)) => {
                println!("== {}: FAILED {e}", case.name);
                failures.push(case.name);
            }
            Err(_) => {
                println!("== {}: TIMED OUT", case.name);
                failures.push(case.name);
            }
        }
    }
    assert!(failures.is_empty(), "failed: {failures:?}");
}
