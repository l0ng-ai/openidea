//! Debugger tools: sessions, breakpoints, execution and inspection.
//!
//! JetBrains calls this the Debugger MCP toolset (`xdebug_*`). OpenIDEA's DAP layer
//! (`ide-dap`) already owns sessions and breakpoints; these tools expose that state to
//! MCP clients. A `sessionId` is the session name, or `name#id` when several sessions
//! share a name; a bare numeric OpenIDEA session id is accepted as well.
//!
//! Breakpoints set here update the IDE backend's list for the window and are sent to sessions
//! this window starts. The editor keeps its own list in local storage and can replace the
//! backend's list when it syncs, so MCP breakpoints are not shown in the editor. Program output
//! goes to the Debug tool window; unlike JetBrains these tools do not return an output file.

use super::page::{OFFSET, Page};
use super::run::configs::{
    BuildErrors, ExecutionTarget, apply_overrides, before_launch, config_from_code_location, confirmation_detail,
    execution_failed, execution_target, load_configs, resolve_jvm_application,
};
use super::tool::{Call, Output, Param, ParamType, Tool};
use crate::ops;
use futures::future::BoxFuture;
use ide_core::settings::DebuggerSettings;
use ide_core::{DebugSessionId, IdeError, IdeResult};
use ide_dap::{Breakpoint, LaunchConfig, SessionInfo, StackFrame, StepKind, Variable};
use ide_run::RunConfig;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// Bounds one inspection call so a deeply nested or wide value cannot flood the answer.
const MAX_TREE_DEPTH: usize = 5;
const MAX_CHILDREN: usize = 50;
const MAX_VALUE_NODES: usize = 1_000;
/// Serializes MCP breakpoint edits: read-modify-write of the window's whole list must not race.
static BREAKPOINT_EDITS: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

pub fn tools() -> Vec<Tool> {
    vec![
        get_debugger_status(),
        start_debugger_session(),
        control_session(),
        list_breakpoints(),
        set_breakpoint(),
        remove_breakpoint(),
        run_to_line(),
        get_threads(),
        get_stack(),
        get_frame_values(),
        get_value_by_path(),
        evaluate_expression(),
        set_variable(),
    ]
}

// ---------------------------------------------------------------- sessions

fn sessions(call: &Call) -> IdeResult<Vec<SessionInfo>> {
    ops::debug::debug_sessions(&call.host(), call.window())
}

/// The id an agent passes back: the name, or `name#id` when the name is ambiguous.
fn public_id(all: &[SessionInfo], session: &SessionInfo) -> String {
    if all.iter().filter(|s| s.name == session.name).count() > 1 {
        format!("{}#{}", session.name, session.id.0)
    } else {
        session.name.clone()
    }
}

/// Resolve a `sessionId` (name, `name#id`, or a bare numeric id) against live sessions.
fn resolve_session(all: &[SessionInfo], id: Option<&str>) -> IdeResult<DebugSessionId> {
    if all.is_empty() {
        return Err(IdeError::not_found("no active debug session; start one with xdebug_start_debugger_session"));
    }
    let Some(raw) = id.map(str::trim).filter(|s| !s.is_empty()) else {
        return if all.len() == 1 {
            Ok(all[0].id)
        } else {
            Err(IdeError::invalid("several debug sessions are active; pass sessionId"))
        };
    };
    if let Ok(n) = raw.parse::<u32>()
        && all.iter().any(|s| s.id.0 == n)
    {
        return Ok(DebugSessionId(n));
    }
    if let Some((name, suffix)) = raw.rsplit_once('#')
        && let Ok(n) = suffix.parse::<u32>()
        && let Some(session) = all.iter().find(|s| s.name == name && s.id.0 == n)
    {
        return Ok(session.id);
    }
    let named: Vec<_> = all.iter().filter(|s| s.name == raw).collect();
    match named.as_slice() {
        [one] => Ok(one.id),
        [] => Err(IdeError::not_found(format!("no debug session named `{raw}`; call xdebug_get_debugger_status"))),
        many => Err(IdeError::invalid(format!(
            "{} sessions named `{raw}`; pass sessionId `{}`",
            many.len(),
            public_id(all, many[0])
        ))),
    }
}

fn session_status(call: &Call, id: DebugSessionId) -> &'static str {
    match ops::debug::debug_session_suspended(&call.host(), id) {
        Some(true) => "paused",
        Some(false) => "running",
        None => "stopped",
    }
}

fn session_value(call: &Call, all: &[SessionInfo], session: &SessionInfo) -> Value {
    json!({
        "id": public_id(all, session),
        "sessionId": session.id.0,
        "name": session.name,
        "adapter": session.adapter,
        "parent": session.parent.map(|p| p.0),
        "status": session_status(call, session.id),
    })
}

fn session_of(all: &[SessionInfo], id: DebugSessionId) -> Option<&SessionInfo> {
    all.iter().find(|s| s.id == id)
}

async fn require_suspended(call: &Call, session: DebugSessionId) -> IdeResult<()> {
    if session_status(call, session) != "paused" {
        return Err(IdeError::invalid(
            "the session is not suspended; call xdebug_control_session(action=WAIT_FOR_PAUSE) or PAUSE first",
        ));
    }
    Ok(())
}

/// Polls OpenIDEA's suspension state; a session that disappears has stopped.
async fn wait_for_pause(call: &Call, session: DebugSessionId, timeout: Duration) -> IdeResult<&'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        match session_status(call, session) {
            "paused" => return Ok("paused"),
            "stopped" => return Ok("stopped"),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Ok("running");
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
        }
    }
}

async fn thread_id(call: &Call, session: DebugSessionId, raw: Option<&str>) -> IdeResult<i64> {
    let threads = ops::debug::debug_threads(&call.host(), session).await?;
    if let Some(name) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        let found = name
            .parse::<i64>()
            .ok()
            .and_then(|id| threads.iter().find(|t| t.id == id).map(|t| t.id))
            .or_else(|| threads.iter().find(|t| t.name == name).map(|t| t.id));
        return found.ok_or_else(|| IdeError::not_found(format!("no thread named or id-ed `{name}` in this session")));
    }
    // The thread that stopped is the one whose frames and variables matter; adapters list
    // threads in no particular order, so the first one is only a fallback.
    ops::debug::debug_stopped_thread(&call.host(), session)
        .filter(|id| threads.iter().any(|t| t.id == *id))
        .or_else(|| threads.first().map(|t| t.id))
        .ok_or_else(|| IdeError::invalid("the session has no threads"))
}

async fn frame_at(call: &Call, session: DebugSessionId, index: usize, thread: Option<&str>) -> IdeResult<StackFrame> {
    let thread = thread_id(call, session, thread).await?;
    let frames = ops::debug::debug_stack_trace(&call.host(), session, thread).await?;
    frames
        .get(index)
        .cloned()
        .ok_or_else(|| IdeError::invalid(format!("frameIndex {index} is out of range ({} frames)", frames.len())))
}

fn get_debugger_status() -> Tool {
    Tool::new(
        "xdebug_get_debugger_status",
        "Returns the debugger's current state: every active session of this project with its `id`, `name`, \
`adapter`, `parent` and `status` (`running`, `paused` or `stopped`), plus `activeSessionId` when only one session \
is active. Call this first when no session id is known, and again after a session stops: ids from an earlier call \
must not be reused. Pass the returned `id` as `sessionId` to the other debugger tools.",
        |call| async move {
            let all = sessions(&call)?;
            let list: Vec<Value> = all.iter().map(|s| session_value(&call, &all, s)).collect();
            let active = if all.len() == 1 { Some(public_id(&all, &all[0])) } else { None };
            Output::json(json!({ "sessions": list, "activeSessionId": active }))
        },
    )
}

// ---------------------------------------------------------------- starting

/// A command with a directory part is relative to `cwd`; a bare name stays on `PATH`.
fn resolve_command(command: &str, cwd: &Path) -> String {
    let relative = command.strip_prefix("./").unwrap_or(command);
    if Path::new(relative).components().count() > 1 {
        cwd.join(relative).to_string_lossy().into_owned()
    } else {
        relative.to_owned()
    }
}

fn command_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    name.strip_suffix(".exe").or_else(|| name.strip_suffix(".cmd")).unwrap_or(name).to_owned()
}

fn extra_json(value: Value) -> Option<String> {
    serde_json::to_string(&value).ok()
}

/// A Python command name like `python`, `python3` or `python3.12`.
fn is_python(name: &str) -> bool {
    name == "python"
        || name
            .strip_prefix("python")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

fn system_python() -> &'static str {
    if cfg!(windows) { "python" } else { "python3" }
}

/// A console script's debugger must run with the interpreter beside it in its venv, not a system one.
fn python_for(command: &str, cwd: &Path, name: &str) -> String {
    if is_python(name) {
        return resolve_command(command, cwd);
    }
    if let Some(i) = command.rfind(|c| c == '/' || c == '\\') {
        let dir = &command[..=i];
        for exe in if cfg!(windows) { ["python.exe", "python"] } else { ["python", "python.exe"] } {
            let candidate = resolve_command(&format!("{dir}{exe}"), cwd);
            if Path::new(&candidate).is_file() {
                return candidate;
            }
        }
    }
    system_python().to_owned()
}

/// Mirrors the IDE's debugpy launch: console scripts become modules, venv interpreters are used,
/// and project managers (`uv run`, `poetry run`, …) keep their own options on the launcher.
fn debugpy_launch(cwd: &Path, config: &RunConfig, launch: &mut LaunchConfig, dbg: &DebuggerSettings) {
    let name = command_name(&config.command);
    let managers = ["uv", "poetry", "pdm", "pipenv", "hatch", "rye"];
    let value_options = [
        "--with",
        "--with-editable",
        "--requirements",
        "--project",
        "--directory",
        "--python",
        "--package",
        "--extra",
        "--group",
        "--env-file",
        "--index",
        "--index-url",
        "--extra-index-url",
    ];
    let python = python_for(&config.command, cwd, &name);
    let mut args = config.args.clone();
    let mut extra = json!({
        "python": python,
        "console": "integratedTerminal",
        "justMyCode": dbg.skip_library_code,
        "subProcess": dbg.python.attach_subprocess,
    });
    if dbg.python.gevent {
        extra["gevent"] = json!(true);
    }
    let mut tool = (!is_python(&name)).then(|| name.clone());
    if managers.contains(&name.as_str()) && args.first().map(String::as_str) == Some("run") {
        let mut i = 1;
        while i < args.len() && args[i].starts_with('-') && args[i] != "-m" && args[i] != "--module" {
            i += usize::from(value_options.contains(&args[i].as_str())) + 1;
        }
        i = i.min(args.len());
        if i < args.len() {
            let named = is_python(&command_name(&args[i]));
            let mut interpreter = vec![resolve_command(&config.command, cwd)];
            interpreter.extend(args[0..i].iter().cloned());
            interpreter.push(if named { args[i].clone() } else { system_python().to_owned() });
            extra["python"] = json!(interpreter);
            extra["debugLauncherPython"] = json!(system_python());
            args = args[i + usize::from(named)..].to_vec();
            if args.first().map(String::as_str) == Some("--module") {
                args[0] = "-m".into();
            }
            tool =
                if named || args.first().is_some_and(|a| a == "-m") || args.first().is_some_and(|a| a.ends_with(".py"))
                {
                    None
                } else {
                    args.first().cloned()
                };
            if tool.is_some() && !args.is_empty() {
                args.remove(0);
            }
        }
    }
    match tool {
        Some(script) => {
            extra["module"] = json!(if script == "django-admin" { "django" } else { script.as_str() });
            launch.args = args;
        }
        None if args.first().map(String::as_str) == Some("-m") && args.len() > 1 => {
            extra["module"] = json!(args[1]);
            launch.args = args[2..].to_vec();
        }
        None => {
            let mut pos = 0;
            while pos < args.len() && args[pos].starts_with('-') {
                pos += 1;
            }
            if pos > 0 {
                // debugpy takes interpreter flags in the `python` array, not in a `pythonArgs` field.
                let flags = &args[..pos];
                match extra["python"].take() {
                    Value::String(interpreter) => {
                        let mut list = vec![interpreter];
                        list.extend(flags.iter().cloned());
                        extra["python"] = json!(list);
                    }
                    Value::Array(mut list) => {
                        list.extend(flags.iter().map(|flag| json!(flag)));
                        extra["python"] = json!(list);
                    }
                    other => extra["python"] = other,
                }
            }
            if let Some(script) = args.get(pos) {
                launch.program = Some(cwd.join(script).to_string_lossy().into_owned());
                launch.args = args[pos + 1..].to_vec();
                if script.ends_with("manage.py") {
                    extra["django"] = json!(true);
                }
            } else {
                launch.program = Some(resolve_command(&config.command, cwd));
                launch.args = args;
            }
        }
    }
    launch.extra_json = extra_json(extra);
}

/// Mirrors the IDE's Delve launch: test selection flags stay on the debuggee, build flags go to
/// `buildFlags`, and a saved Go configuration's own form fields take precedence over the command line.
fn go_launch(cwd: &Path, root: &Path, config: &RunConfig, launch: &mut LaunchConfig) -> IdeResult<()> {
    let params = &config.extras.params;
    let words = |value: &str| -> Vec<String> {
        super::run::split_words(value).unwrap_or_else(|_| value.split_whitespace().map(str::to_owned).collect())
    };
    if let Some(kind) = params.get("goKind") {
        let test = kind == "test";
        let module_dir = params.get("module").map(String::as_str).unwrap_or(".");
        let module = if module_dir.is_empty() || module_dir == "." {
            root.to_path_buf()
        } else {
            root.join(module_dir.strip_prefix("./").unwrap_or(module_dir))
        };
        let target = params.get("target").map(String::as_str).unwrap_or(".");
        let file_scope = params.get("scope").map(String::as_str) == Some("file");
        let program = if params.get("scope").map(String::as_str) == Some("package")
            && !target.starts_with('.')
            && !Path::new(target).is_absolute()
        {
            target.to_owned()
        } else {
            module.join(target.split('|').next().unwrap_or(target).trim()).to_string_lossy().into_owned()
        };
        let flags = words(params.get("toolArgs").map(String::as_str).unwrap_or(""));
        let mut args = if test {
            params.get("pattern").map(|p| vec!["-test.run".to_owned(), p.clone()]).unwrap_or_default()
        } else {
            Vec::new()
        };
        args.extend(words(params.get("programArgs").map(String::as_str).unwrap_or("")));
        launch.program = Some(program);
        launch.args = args;
        let mut extra = json!({
            "mode": if test { "test" } else { "debug" },
            "dlvCwd": module.to_string_lossy(),
            "__goToolArgs": flags,
            "__goTargets": [target],
            "__goBuildDir": module.to_string_lossy(),
            "__goExecutable": resolve_command(&config.command, &module),
            "__goUseTags": params.get("useTags").map(String::as_str) != Some("false"),
        });
        if file_scope {
            let files: Vec<String> =
                target.split('|').map(|file| module.join(file.trim()).to_string_lossy().into_owned()).collect();
            extra["__goFiles"] = json!(files);
        }
        if let Some(dir) = params.get("outputDir") {
            extra["output"] = json!(root.join(dir).join("go-debug").to_string_lossy());
        }
        launch.extra_json = extra_json(extra);
        return Ok(());
    }
    let args = &config.args;
    let sub = args.first().map(String::as_str).unwrap_or_default();
    let test = sub == "test";
    let pivot = args.iter().position(|a| a == "--" || (test && a == "-args")).unwrap_or(args.len());
    let mut program_args = args.iter().skip(pivot).skip(1).cloned().collect::<Vec<_>>();
    let rest = &args[1..pivot.min(args.len())];
    let bool_flags = [
        "-a",
        "-n",
        "-race",
        "-msan",
        "-asan",
        "-cover",
        "-linkshared",
        "-modcacherw",
        "-buildvcs",
        "-trimpath",
        "-v",
        "-work",
        "-x",
        "-json",
        "-c",
    ];
    let selectors = [
        "-run",
        "-skip",
        "-bench",
        "-benchtime",
        "-count",
        "-timeout",
        "-parallel",
        "-cpu",
        "-list",
        "-fuzz",
        "-fuzztime",
        "-fuzzminimizetime",
    ];
    let mut flags = Vec::new();
    let mut test_flags = Vec::new();
    let mut targets: Vec<String> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        if test
            && selectors.iter().any(|f| arg == f || arg.starts_with(&format!("-test.{}", f.trim_start_matches('-'))))
        {
            test_flags.push(if arg.starts_with("-test.") {
                arg.clone()
            } else {
                format!("-test.{}", arg.trim_start_matches('-'))
            });
            if !arg.contains('=')
                && let Some(value) = rest.get(i + 1)
            {
                test_flags.push(value.clone());
                i += 1;
            }
        } else if arg.starts_with('-') {
            if !(test && (arg == "-json" || arg == "-c")) {
                flags.push(arg.clone());
                if !arg.contains('=')
                    && !bool_flags.contains(&arg.as_str())
                    && let Some(value) = rest.get(i + 1)
                {
                    flags.push(value.clone());
                    i += 1;
                }
            }
        } else if sub == "run"
            && !targets.is_empty()
            && !(arg.ends_with(".go") && targets.iter().all(|t| t.ends_with(".go")))
        {
            program_args.clone_from(&rest[i..].to_vec());
            break;
        } else {
            targets.push(arg.clone());
        }
        i += 1;
    }
    let target = targets.first().map(String::as_str).unwrap_or(".");
    let program = if target.ends_with(".go") || target.starts_with('.') || Path::new(target).is_absolute() {
        cwd.join(target)
    } else {
        PathBuf::from(target)
    };
    launch.program = Some(program.to_string_lossy().into_owned());
    launch.args = test_flags.into_iter().chain(program_args).collect();
    launch.extra_json = extra_json(json!({
        "mode": if test { "test" } else { "debug" },
        "buildFlags": flags.join(" "),
        "dlvCwd": cwd.to_string_lossy(),
        "__goToolArgs": flags,
        "__goTargets": if targets.is_empty() { vec![".".to_owned()] } else { targets },
        "__goExecutable": resolve_command(&config.command, cwd),
    }));
    Ok(())
}

/// Builds a DAP launch configuration from the run configuration the IDE would debug.
/// The adapter-specific cases mirror the IDE's Run/Debug dialog; anything else gets the
/// plain program, arguments, working directory and environment of the configuration.
fn launch_config(root: &Path, config: &RunConfig, dbg: &DebuggerSettings) -> IdeResult<LaunchConfig> {
    let adapter = config.debug_adapter.clone().ok_or_else(|| {
        IdeError::invalid(format!(
            "run configuration `{}` has no debugger adapter; use get_run_configurations to pick a debuggable one",
            config.name
        ))
    })?;
    let cwd = config.cwd.as_deref().map(|p| root.join(p)).unwrap_or_else(|| root.to_path_buf());
    let mut launch = LaunchConfig {
        name: config.name.clone(),
        adapter: adapter.clone(),
        request: "launch".into(),
        program: None,
        args: Vec::new(),
        cwd: Some(cwd.clone().into()),
        env: config.env.clone(),
        extra_json: None,
    };
    match adapter.as_str() {
        "codelldb" | "lldb-dap" | "gdb" if config.kind == "cargo" => {
            let pivot = config.args.iter().position(|a| a == "--").unwrap_or(config.args.len());
            let (cargo_args, program_args) = config.args.split_at(pivot);
            let sub = cargo_args.first().map(String::as_str).unwrap_or_default();
            let mut build = if sub == "test" || sub == "nextest" {
                vec!["test".to_owned(), "--no-run".to_owned()]
            } else {
                vec!["build".to_owned()]
            };
            build.extend(cargo_args.iter().skip(1).filter(|a| a.as_str() != "--no-run").cloned());
            let mut extra = json!({ "cargo": { "args": build } });
            if sub != "test" && sub != "nextest" {
                extra["cargo"]["filter"] = json!({ "kind": "bin" });
            }
            if let Some(i) = cargo_args.iter().position(|a| a == "--bin" || a == "--example") {
                let kind = if cargo_args[i] == "--example" { "example" } else { "bin" };
                if let Some(name) = cargo_args.get(i + 1) {
                    extra["cargo"]["filter"] = json!({ "name": name, "kind": kind });
                }
            }
            launch.args = program_args.iter().skip(1).cloned().collect();
            launch.extra_json = extra_json(extra);
        }
        "debugpy" => debugpy_launch(&cwd, config, &mut launch, dbg),
        "js-debug" => {
            let mut extra = json!({
                "type": "pwa-node",
                "console": "integratedTerminal",
                "autoAttachChildProcesses": true,
                "skipFiles": if dbg.skip_library_code { json!(["<node_internals>/**", "**/node_modules/**"]) } else { json!([]) },
            });
            let name = command_name(&config.command);
            if name == "node" && config.args.first().is_some_and(|a| !a.starts_with('-')) {
                launch.program = Some(cwd.join(&config.args[0]).to_string_lossy().into_owned());
                launch.args = config.args.iter().skip(1).cloned().collect();
                if config.command != name {
                    extra["runtimeExecutable"] = json!(resolve_command(&config.command, &cwd));
                }
            } else {
                extra["runtimeExecutable"] = json!(config.command);
                extra["runtimeArgs"] = json!(config.args);
            }
            launch.extra_json = extra_json(extra);
        }
        "delve" => go_launch(&cwd, root, config, &mut launch)?,
        "bun-dap" => {
            let mut args = config.args.clone();
            if args.first().map(String::as_str) == Some("run") {
                args.remove(0);
            }
            let file = args.first().cloned().unwrap_or_default();
            launch.extra_json = extra_json(json!({
                "program": cwd.join(file).to_string_lossy(),
                "runtime": config.command,
                "runtimeArgs": args.iter().skip(1).collect::<Vec<_>>(),
            }));
        }
        "netcoredbg" => {
            let program = config
                .extras
                .params
                .get("targetPath")
                .ok_or_else(|| IdeError::invalid("a .NET configuration without targetPath cannot be debugged"))?;
            launch.program = Some(program.clone());
            let raw = config
                .extras
                .params
                .get("programArgs")
                .or_else(|| config.extras.params.get("profileArgs"))
                .map(String::as_str)
                .unwrap_or_default();
            launch.args = raw.split_whitespace().map(str::to_owned).collect();
            launch.extra_json = extra_json(json!({ "justMyCode": dbg.skip_library_code }));
        }
        "godot" => {
            let project = config
                .args
                .iter()
                .position(|a| a == "--path")
                .and_then(|i| config.args.get(i + 1))
                .map(|p| cwd.join(p))
                .unwrap_or_else(|| cwd.clone());
            let scene =
                config
                    .args
                    .iter()
                    .find(|a| {
                        let lower = a.to_ascii_lowercase();
                        lower.ends_with(".scn") || lower.ends_with(".tscn")
                    })
                    .map(|s| {
                        if s.starts_with("res://") {
                            s.clone()
                        } else {
                            format!("res://{}", s.trim_start_matches("./"))
                        }
                    })
                    .unwrap_or_else(|| "main".to_owned());
            launch.cwd = Some(project.clone().into());
            launch.extra_json = extra_json(json!({
                "project": project.to_string_lossy(),
                "scene": scene,
            }));
        }
        "codelldb" | "lldb-dap" | "gdb" => {
            launch.program = Some(resolve_command(&config.command, &cwd));
            launch.args = config.args.clone();
            if adapter == "lldb-dap" {
                let env = config.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>();
                let mut extra = json!({ "env": env });
                if let (Some(from), Some(to)) =
                    (config.extras.params.get("cmakeSourceRoot"), config.extras.params.get("cmakeCanonicalSourceRoot"))
                {
                    extra["sourceMap"] = json!([[from, to]]);
                }
                launch.extra_json = extra_json(extra);
            }
        }
        "java-debug" | "java-analyzer" | "dart" | "php-debug" | "unity" => {
            return Err(IdeError::invalid(format!(
                "the `{adapter}` debugger cannot start a run configuration through MCP; use the IDE's Run/Debug dialog"
            )));
        }
        _ => {
            launch.program = Some(resolve_command(&config.command, &cwd));
            launch.args = config.args.clone();
        }
    }
    Ok(launch)
}

fn start_debugger_session() -> Tool {
    Tool::new(
        "xdebug_start_debugger_session",
        "Starts a debugger session for an existing run configuration (`configurationName`) or for a run point \
(`filePath` + `line`) in this project, then returns the session id and its status. Use \
`get_run_configurations` to find configuration names and runnable lines. Set at least one breakpoint first with \
`xdebug_set_breakpoint`, otherwise the program may finish without pausing. After the call, use \
`xdebug_control_session(action=WAIT_FOR_PAUSE)` and then `xdebug_get_stack` / `xdebug_get_frame_values`.\n\
Launch overrides (`programArguments`, `workingDirectory`, `envs`) apply to this launch only; pass them only when \
the configuration reports `supportsDynamicLaunchOverrides=true`, as other configurations refuse them. Missing or \
empty string keeps the configured value; a whitespace-only string clears it for this launch.\n\
In OpenIDEA the user is asked first; the run's before-launch tasks run; the session shows in the Debug tool window. \
Program output goes there rather than into this tool's result. Java configurations that need the IDE's classpath \
resolution are best started from the Run/Debug dialog; attach to a JVM with a JDWP configuration instead.",
        |call| async move {
            let target =
                execution_target(call.opt_str("configurationName")?, call.opt_str("filePath")?, call.opt_i64("line")?)?;
            let envs = call.args.get("envs").filter(|v| !v.is_null()).map(|_| call.str_map("envs")).transpose()?;
            let configs = load_configs(&call).await?;
            let mut config = match &target {
                ExecutionTarget::ByName(name) => configs
                    .iter()
                    .find(|c| c.name == *name)
                    .cloned()
                    .ok_or_else(|| IdeError::not_found(format!("run configuration `{name}` not found")))?,
                ExecutionTarget::ByContext(file, line) => {
                    config_from_code_location(&call, configs.clone(), file, *line).await?
                }
            };
            let stored_env = config.env.clone();
            let overrides: Vec<(String, String)> = envs.clone().unwrap_or_default();
            apply_overrides(
                &mut config,
                call.root(),
                call.opt_str("programArguments")?,
                call.opt_str("workingDirectory")?,
                envs,
            )?;
            if !config.extras.compound.is_empty() {
                return Err(IdeError::invalid(format!(
                    "`{}` is a compound configuration; debug its configurations one by one",
                    config.name
                )));
            }
            let cwd = config.cwd.as_deref().map(|p| call.root().join(p)).unwrap_or_else(|| call.root().to_path_buf());
            let detail = confirmation_detail(&config, &call.display(&cwd), &stored_env, &overrides, &configs);
            call.confirm(&config.name, Some(detail)).await?;
            let mut errors = BuildErrors::default();
            if let Some(reason) = before_launch(&call, &config, &configs, &mut Vec::new(), &mut errors).await? {
                return Err(execution_failed(&[errors.text(), Some(reason)]));
            }
            let config = match resolve_jvm_application(&call, config, &mut errors).await? {
                Ok(config) => config,
                Err(reason) => return Err(execution_failed(&[errors.text(), Some(reason)])),
            };
            let debugger = call.project().settings.effective().debugger.clone();
            let launch = launch_config(call.root(), &config, &debugger)?;
            let limit = super::run::timeout(&call, 60_000)?;
            let id = tokio::time::timeout(limit, ops::debug::debug_start(&call.host(), call.window(), launch))
                .await
                .map_err(|_| IdeError::invalid("timed out starting the debug session"))??;
            let grace = Duration::from_millis(call.opt_i64("graceWaitMs")?.unwrap_or(2_000).max(0) as u64);
            if !grace.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(grace) => {}
                    _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
                }
            }
            let all = sessions(&call)?;
            let name = session_of(&all, id).map(|s| s.name.clone()).unwrap_or_default();
            Output::json(json!({
                "sessionId": session_of(&all, id).map(|s| public_id(&all, s)),
                "id": id.0,
                "name": name,
                "status": session_status(&call, id),
                "runConfigurationName": config.name,
            }))
        },
    )
    .write()
    .param(Param::optional("configurationName", ParamType::String, "Name of the existing run configuration to debug"))
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "Project-relative file path. Provide together with `line` to debug a run point in that file.",
    ))
    .param(Param::optional(
        "line",
        ParamType::Integer,
        "1-based line number for `filePath`; mutually exclusive with `configurationName`.",
    ))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for the session to start (default 60000)",
    ))
    .param(Param::optional(
        "graceWaitMs",
        ParamType::Integer,
        "Milliseconds to wait after the start before reporting the refreshed state (default 2000)",
    ))
    .param(Param::optional(
        "programArguments",
        ParamType::String,
        "Program arguments for this debug launch only; empty keeps the configured value, whitespace clears it.",
    ))
    .param(Param::optional(
        "workingDirectory",
        ParamType::String,
        "Working directory for this debug launch only; empty keeps the configured value, whitespace clears it.",
    ))
    .param(Param::optional(
        "envs",
        ParamType::StringMap,
        "Environment overrides for this debug launch only, merged over the configuration's environment.",
    ))
}

// ---------------------------------------------------------------- control

fn control_session() -> Tool {
    Tool::new(
        "xdebug_control_session",
        "Controls a debug session: STEP_INTO, STEP_OVER, STEP_OUT, RESUME, PAUSE, STOP, WAIT_FOR_PAUSE and \
DRAIN_EVENTS. `STEP_*` and `RESUME` need a suspended session; if the program is running use \
WAIT_FOR_PAUSE or PAUSE first. After RESUME, call WAIT_FOR_PAUSE to confirm the next suspension. Paused results \
include a `frameValues` snapshot of the top frame. The result carries `status`: `running`, `paused` or `stopped`.\n\
JVM-only breakpoint errors and tracepoint output are not buffered by OpenIDEA, so DRAIN_EVENTS returns empty tails; \
breakpoint verification messages come from `xdebug_list_breakpoints`.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            let action = call.str("action")?.to_uppercase();
            let timeout = Duration::from_millis(call.opt_i64("timeout")?.unwrap_or(30_000).max(0) as u64);
            let mut result = Map::new();
            result.insert(
                "sessionId".into(),
                session_of(&all, id).map(|s| public_id(&all, s)).unwrap_or_default().into(),
            );
            let status = match action.as_str() {
                "STEP_INTO" | "STEP_OVER" | "STEP_OUT" | "RESUME" | "PAUSE" => {
                    if action != "PAUSE" {
                        require_suspended(&call, id).await?;
                    }
                    let thread = thread_id(&call, id, call.opt_str("threadId")?.as_deref()).await?;
                    match action.as_str() {
                        "RESUME" => ops::debug::debug_resume(&call.host(), id, thread).await?,
                        "PAUSE" => ops::debug::debug_pause(&call.host(), id, thread).await?,
                        step => {
                            let kind = match step {
                                "STEP_INTO" => StepKind::Into,
                                "STEP_OUT" => StepKind::Out,
                                _ => StepKind::Over,
                            };
                            ops::debug::debug_step(&call.host(), id, thread, kind).await?;
                        }
                    }
                    session_status(&call, id)
                }
                "STOP" => {
                    ops::debug::debug_stop(&call.host(), id).await?;
                    wait_for_pause(&call, id, timeout).await?
                }
                "WAIT_FOR_PAUSE" => wait_for_pause(&call, id, timeout).await?,
                "DRAIN_EVENTS" => {
                    result.insert("breakpointErrorsTail".into(), json!([]));
                    result.insert("tracepointOutputsTail".into(), json!([]));
                    session_status(&call, id)
                }
                other => {
                    return Err(IdeError::invalid(format!(
                        "unknown action `{other}`; use STEP_INTO, STEP_OVER, STEP_OUT, RESUME, PAUSE, STOP, \
WAIT_FOR_PAUSE or DRAIN_EVENTS"
                    )));
                }
            };
            result.insert("status".into(), status.into());
            if status == "paused"
                && let Ok(values) = frame_values(&call, id, 0, 0, None).await
            {
                result.insert("frameValues".into(), values);
            }
            Output::json(Value::Object(result))
        },
    )
    .write()
    .param(Param::optional(
        "sessionId",
        ParamType::String,
        "Current session id from xdebug_get_debugger_status; optional when exactly one session is active.",
    ))
    .param(Param::required(
        "action",
        ParamType::String,
        "STEP_INTO, STEP_OVER, STEP_OUT, RESUME, PAUSE, STOP, WAIT_FOR_PAUSE or DRAIN_EVENTS.",
    ))
    .param(Param::optional("threadId", ParamType::String, "Thread id or name; defaults to the active thread."))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for STOP/WAIT_FOR_PAUSE (default 30000)",
    ))
    .param(Param::optional("eventsLimit", ParamType::Integer, "Accepted for compatibility; no events are buffered."))
    .param(Param::optional(
        "clearEventsAfterRead",
        ParamType::Boolean,
        "Accepted for compatibility; events are always cleared.",
    ))
}

// -------------------------------------------------------------- breakpoints

/// Canonical, project-unique id: `line:<project-relative file>:<1-based line>`.
fn line_bp_id(file: &str, line0: u32) -> String {
    format!("line:{file}:{}", line0 + 1)
}

fn parse_line_bp_id(id: &str) -> IdeResult<(String, u32)> {
    let file = id.strip_prefix("line:").ok_or_else(|| {
        IdeError::invalid("breakpointId must come from xdebug_set_breakpoint or xdebug_list_breakpoints")
    })?;
    let (file, line) = file.rsplit_once(':').ok_or_else(|| IdeError::invalid("malformed breakpointId"))?;
    let line =
        line.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(|| IdeError::invalid("malformed breakpointId"))?;
    Ok((file.to_owned(), line - 1))
}

/// Verification state of breakpoint `index` of a file (the states are index-aligned).
fn verified(call: &Call, path: &Path, index: usize) -> (bool, Option<String>) {
    match ops::debug::debug_breakpoint_states(&call.host(), path.to_path_buf()).ok() {
        Some(states) => states.get(index).map(|s| (s.verified, s.message.clone())).unwrap_or((false, None)),
        None => (false, None),
    }
}

fn line_bp_json(call: &Call, path: &Path, line0: u32, bp: &Breakpoint, index: usize) -> Value {
    let (is_verified, message) = verified(call, path, index);
    json!({
        "id": line_bp_id(&call.display(path), line0),
        "type": "line",
        "file": call.display(path),
        "line": line0 + 1,
        "enabled": bp.enabled,
        "condition": bp.condition,
        "hitCondition": bp.hit_condition,
        "isLogMessage": bp.log_message.is_some(),
        "temporary": false,
        "verified": is_verified,
        "message": message,
    })
}

fn list_breakpoints() -> Tool {
    Tool::new(
        "xdebug_list_breakpoints",
        "Lists all breakpoints of this project, or only those in `filePath`. Each line breakpoint has a canonical \
`id`, `file`, 1-based `line`, `enabled`, `condition`, `hitCondition`, `isLogMessage`, `verified` and an optional \
`message` from the last verification. Function and data breakpoints are listed too, with ids prefixed `function:` \
and `data:`. Call this before RESUME to check that an enabled breakpoint will be hit. These are the IDE backend's \
breakpoints for this window; the editor keeps a separate list and can replace this one when it syncs, so verify \
with this tool after any editor action.",
        |call| async move {
            let file_filter = call.opt_str("filePath")?;
            let filter = file_filter.as_deref().map(|f| call.resolve_inside(f)).transpose()?;
            let (lines, functions, data) = ops::debug::debug_breakpoints(&call.host(), call.window());
            let mut out = Vec::new();
            for (path, bps) in lines {
                if filter.as_ref().is_some_and(|f| f != &path) {
                    continue;
                }
                for (index, bp) in bps.iter().enumerate() {
                    out.push(line_bp_json(&call, &path, bp.line, bp, index));
                }
            }
            if filter.is_none() {
                for bp in functions {
                    out.push(json!({
                        "id": format!("function:{}", bp.name),
                        "type": "function",
                        "name": bp.name,
                        "enabled": bp.enabled,
                        "condition": bp.condition,
                        "hitCondition": bp.hit_condition,
                    }));
                }
                for bp in data {
                    out.push(json!({
                        "id": format!("data:{}", bp.data_id),
                        "type": "data",
                        "dataId": bp.data_id,
                        "accessType": bp.access_type,
                        "enabled": bp.enabled,
                    }));
                }
            }
            Output::json(json!({ "breakpoints": out }))
        },
    )
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "Project-relative file to list; all files when omitted.",
    ))
}

/// An absent field keeps the existing value; an explicit null clears it.
fn apply_optional_string(call: &Call, name: &str, slot: &mut Option<String>) -> IdeResult<()> {
    match call.args.get(name) {
        None => Ok(()),
        Some(Value::Null) => {
            *slot = None;
            Ok(())
        }
        Some(Value::String(s)) => {
            *slot = Some(s.clone());
            Ok(())
        }
        Some(_) => Err(IdeError::invalid(format!("{name} must be a string or null"))),
    }
}

fn apply_optional_bool(call: &Call, name: &str, slot: &mut bool) -> IdeResult<()> {
    if let Some(value) = call.args.get(name) {
        *slot = value.as_bool().ok_or_else(|| IdeError::invalid(format!("{name} must be a boolean")))?;
    }
    Ok(())
}

/// A truncated excerpt of the source line a breakpoint sits on (dirty buffers included).
fn line_text(call: &Call, path: &Path, line0: usize) -> Option<String> {
    let text = call.project().documents.text_of(path).or_else(|| std::fs::read_to_string(path).ok())?;
    let line = text.lines().nth(line0)?.trim();
    if line.is_empty() {
        return None;
    }
    Some(match line.chars().count() {
        n if n > 160 => format!("{}…", line.chars().take(159).collect::<String>()),
        _ => line.to_owned(),
    })
}

fn set_breakpoint() -> Tool {
    Tool::new(
        "xdebug_set_breakpoint",
        "Creates or updates a line breakpoint. By location pass `filePath` (project-relative) and 1-based `line`; \
by id pass a canonical `breakpointId` from `xdebug_set_breakpoint` or `xdebug_list_breakpoints` (optionally with a \
new `filePath`/`line` to relocate it). Fields you pass are applied to the breakpoint; fields you omit keep their \
current value, and an explicit null clears a string field. `isLogMessage`/`logMessage` make a tracepoint. \
`isLogStack`, `temporary` and `suspendPolicy` are accepted for compatibility but OpenIDEA always suspends the \
thread and does not implement one-shot or stack-logging breakpoints. Condition errors are reported as the \
breakpoint's `message` after the IDE verifies it. A successful result includes `lineText` so the placement can be \
checked before RESUME.",
        |call| async move {
            let _guard = BREAKPOINT_EDITS.lock().await;
            let host = call.host();
            let (mut lines, _, _) = ops::debug::debug_breakpoints(&host, call.window());
            let id = call.opt_str("breakpointId")?;
            let (path, line0) = if let Some(id) = id {
                if let Some(name) = id.strip_prefix("function:") {
                    return Err(IdeError::invalid(format!(
                        "function breakpoint `{name}` cannot be edited; remove it first"
                    )));
                }
                if id.starts_with("data:") {
                    return Err(IdeError::invalid("data breakpoints cannot be edited; remove it first"));
                }
                let (old_file, old_line) = parse_line_bp_id(&id)?;
                let old_path = call.resolve_inside(&old_file)?;
                // Relocation by id: a supplied filePath/line moves the breakpoint.
                let (new_file, new_line) = (call.opt_str("filePath")?, call.opt_i64("line")?);
                let (path, line0) = match (new_file, new_line) {
                    (None, None) => (old_path.clone(), old_line),
                    (file, Some(n)) if n >= 1 => {
                        let target = match file {
                            Some(file) => call.resolve_inside(&file)?,
                            None => old_path.clone(),
                        };
                        (target, (n - 1) as u32)
                    }
                    (Some(file), None) => (call.resolve_inside(&file)?, old_line),
                    _ => return Err(IdeError::invalid("line must be >= 1")),
                };
                if path != old_path || line0 != old_line {
                    if let Some(bps) = lines.get_mut(&old_path) {
                        bps.retain(|b| b.line != old_line);
                        let cleared = bps.clone();
                        ops::debug::debug_set_breakpoints(&host, call.window(), old_path, cleared).await?;
                    }
                }
                (path, line0)
            } else {
                let file = call.str("filePath")?;
                let line = call
                    .opt_i64("line")
                    .ok()
                    .flatten()
                    .ok_or_else(|| IdeError::invalid("pass either breakpointId or both filePath and line"))?;
                if line < 1 {
                    return Err(IdeError::invalid("line must be >= 1"));
                }
                (call.resolve_inside(&file)?, line as u32 - 1)
            };
            let mut bps = lines.get(&path).cloned().unwrap_or_default();
            let existing_index = bps.iter().position(|b| b.line == line0);
            let mut bp = existing_index.and_then(|i| bps.get(i).cloned()).unwrap_or(Breakpoint {
                line: line0,
                condition: None,
                hit_condition: None,
                log_message: None,
                enabled: true,
            });
            bp.line = line0;
            apply_optional_string(&call, "condition", &mut bp.condition)?;
            apply_optional_string(&call, "hitCondition", &mut bp.hit_condition)?;
            apply_optional_bool(&call, "enabled", &mut bp.enabled)?;
            let mut log = bp.log_message.is_some();
            apply_optional_bool(&call, "isLogMessage", &mut log)?;
            if log {
                let mut message = bp.log_message.clone();
                apply_optional_string(&call, "logMessage", &mut message)?;
                bp.log_message = Some(message.unwrap_or_else(|| format!("{}:{} hit", call.display(&path), line0 + 1)));
            } else {
                bp.log_message = None;
            }
            match existing_index {
                Some(i) => bps[i] = bp.clone(),
                None => bps.push(bp.clone()),
            }
            let states = ops::debug::debug_set_breakpoints(&call.host(), call.window(), path.clone(), bps).await?;
            let (is_verified, message) = states
                .iter()
                .enumerate()
                .find(|(_, s)| s.line == line0)
                .map(|(_, s)| (s.verified, s.message.clone()))
                .unwrap_or((false, None));
            Output::json(json!({
                "id": line_bp_id(&call.display(&path), line0),
                "file": call.display(&path),
                "line": line0 + 1,
                "lineText": line_text(&call, &path, line0 as usize),
                "verified": is_verified,
                "message": message,
            }))
        },
    )
    .write()
    .param(Param::optional("breakpointId", ParamType::String, "Canonical id to update, or omitted to set by location."))
    .param(Param::optional("filePath", ParamType::String, "Project-relative path of the file to break in."))
    .param(Param::optional("line", ParamType::Integer, "1-based line number; required in location mode."))
    .param(Param::optional("condition", ParamType::String, "Condition expression; null clears an existing one."))
    .param(Param::optional("hitCondition", ParamType::String, "Hit-count expression for the breakpoint."))
    .param(Param::optional("isLogMessage", ParamType::Boolean, "Log the hit instead of suspending (tracepoint)."))
    .param(Param::optional("logMessage", ParamType::String, "Message template logged for a tracepoint."))
    .param(Param::optional("isLogStack", ParamType::Boolean, "Accepted for compatibility; not implemented."))
    .param(Param::optional("temporary", ParamType::Boolean, "Accepted for compatibility; not implemented."))
    .param(Param::optional(
        "suspendPolicy",
        ParamType::String,
        "Accepted for compatibility; the adapter's default is used.",
    ))
    .param(Param::optional("enabled", ParamType::Boolean, "Whether the breakpoint is enabled (default true)."))
}

fn remove_breakpoint() -> Tool {
    Tool::new(
        "xdebug_remove_breakpoint",
        "Removes breakpoints. Pass a canonical `breakpointId` from `xdebug_set_breakpoint` / \
`xdebug_list_breakpoints`, or `filePath` with an optional 1-based `line`; with only a `filePath`, all breakpoints in \
that file are removed; with neither (the default `owner=agent`), all breakpoints of this project are removed, \
including function and data breakpoints. Removal of a missing breakpoint is not an error: `removed` says whether \
anything was removed. `owner` is accepted for compatibility; OpenIDEA keeps one set of breakpoints per window.",
        |call| async move {
            let _guard = BREAKPOINT_EDITS.lock().await;
            let owner = call.opt_str("owner")?;
            if owner.as_deref().is_some_and(|o| o != "agent" && o != "user") {
                return Err(IdeError::invalid("owner must be `agent` or `user`"));
            }
            let id = call.opt_str("breakpointId")?;
            let file = call.opt_str("filePath")?;
            let line = call.opt_i64("line")?.filter(|n| *n > 0).map(|n| n as u32 - 1);
            let host = call.host();
            let (mut lines, mut functions, mut data) = ops::debug::debug_breakpoints(&host, call.window());
            let mut count = 0;
            if let Some(id) = id {
                if let Some(name) = id.strip_prefix("function:") {
                    let before = functions.len();
                    functions.retain(|b| b.name != name);
                    count += before - functions.len();
                    ops::debug::debug_set_function_breakpoints(&host, call.window(), functions).await?;
                } else if let Some(key) = id.strip_prefix("data:") {
                    let before = data.len();
                    data.retain(|b| b.data_id != key);
                    count += before - data.len();
                    ops::debug::debug_set_data_breakpoints(&host, call.window(), data).await?;
                } else {
                    let (path, line0) = parse_line_bp_id(&id)?;
                    let path = call.resolve_inside(&path)?;
                    if let Some(bps) = lines.get_mut(&path) {
                        let before = bps.len();
                        bps.retain(|b| b.line != line0);
                        count += before - bps.len();
                        ops::debug::debug_set_breakpoints(&host, call.window(), path.clone(), bps.clone()).await?;
                    }
                }
            } else if let Some(file) = file {
                let path = call.resolve_inside(&file)?;
                if let Some(bps) = lines.get_mut(&path) {
                    match line {
                        Some(line0) => {
                            let before = bps.len();
                            bps.retain(|b| b.line != line0);
                            count += before - bps.len();
                        }
                        None => {
                            count += bps.len();
                            bps.clear();
                        }
                    }
                    ops::debug::debug_set_breakpoints(&host, call.window(), path, bps.clone()).await?;
                }
            } else {
                count = lines.values().map(Vec::len).sum::<usize>() + functions.len() + data.len();
                ops::debug::debug_replace_breakpoints(&host, call.window(), BTreeMap::new()).await?;
                ops::debug::debug_set_function_breakpoints(&host, call.window(), Vec::new()).await?;
                ops::debug::debug_set_data_breakpoints(&host, call.window(), Vec::new()).await?;
            }
            Output::json(json!({ "removed": count > 0, "count": count }))
        },
    )
    .write()
    .param(Param::optional("breakpointId", ParamType::String, "Canonical id of a breakpoint to remove."))
    .param(Param::optional("filePath", ParamType::String, "Project-relative file whose breakpoints to remove."))
    .param(Param::optional("line", ParamType::Integer, "1-based line; with filePath removes only that line."))
    .param(Param::optional("owner", ParamType::String, "Compatibility selector: `agent` (default) or `user`."))
}

// --------------------------------------------------------------- execution

fn run_to_line() -> Tool {
    Tool::new(
        "xdebug_run_to_line",
        "Resumes a suspended session until a source line is reached (Run to Cursor). Pass a project-relative \
`filePath` and a 1-based `line`; the tool waits up to `timeout` milliseconds and reports whether the session is \
`paused`, still `running` after the timeout, or `stopped`. After a pause, call `xdebug_get_stack` and \
`xdebug_get_frame_values` for evidence at the new location.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let path = call.resolve_inside(&call.str("filePath")?)?;
            let line = call.opt_i64("line").ok().flatten().ok_or_else(|| IdeError::invalid("line is required"))?;
            if line < 1 {
                return Err(IdeError::invalid("line must be >= 1"));
            }
            let thread = thread_id(&call, id, call.opt_str("threadId")?.as_deref()).await?;
            ops::debug::debug_run_to(&call.host(), id, thread, path, line as u32 - 1, false).await?;
            let status = wait_for_pause(
                &call,
                id,
                Duration::from_millis(call.opt_i64("timeout")?.unwrap_or(30_000).max(0) as u64),
            )
            .await?;
            Output::json(json!({
                "sessionId": session_of(&all, id).map(|s| public_id(&all, s)),
                "status": status,
            }))
        },
    )
    .write()
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(Param::optional("threadId", ParamType::String, "Thread id or name; defaults to the active thread."))
    .param(Param::required("filePath", ParamType::String, "Project-relative file to run to."))
    .param(Param::required("line", ParamType::Integer, "1-based target line."))
    .param(Param::optional("timeout", ParamType::Integer, "Milliseconds to wait for a pause (default 30000)."))
}

// --------------------------------------------------------------- inspection

fn get_threads() -> Tool {
    Tool::new(
        "xdebug_get_threads",
        "Lists the threads of a suspended debug session. Each thread has an `id`, `name`, `state`, `isCurrent` and \
`frameCount`. `isCurrent` marks the thread that last stopped; with an all-threads stop every thread is `paused`. \
Use a returned `id` as `threadId` for `xdebug_get_stack` and the frame tools. Results are paged with `offset` and \
`limit` (50 by default).",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let threads = ops::debug::debug_threads(&call.host(), id).await?;
            let page = Page::of(&call, 50)?;
            let current = ops::debug::debug_stopped_thread(&call.host(), id);
            let mut out = Map::new();
            out.insert("total".into(), threads.len().into());
            page.mark(threads.len() > page.end(), &mut out);
            // The stack is fetched only for the returned page, so frameCount stays cheap.
            let mut values = Vec::new();
            for t in threads.iter().skip(page.offset).take(page.limit) {
                let count = ops::debug::debug_stack_trace(&call.host(), id, t.id).await.map(|f| f.len()).unwrap_or(0);
                values.push(json!({
                    "id": t.id.to_string(),
                    "name": t.name,
                    "state": if current.is_none() || current == Some(t.id) { "paused" } else { "running" },
                    "isCurrent": current == Some(t.id),
                    "frameCount": count,
                }));
            }
            out.insert("threads".into(), Value::Array(values));
            Output::json(Value::Object(out))
        },
    )
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(Param::optional("limit", ParamType::Integer, "Threads to return at most (default 50)"))
    .param(Param::optional("offset", ParamType::Integer, OFFSET))
}

fn get_stack() -> Tool {
    Tool::new(
        "xdebug_get_stack",
        "Returns the call stack of a suspended session, top frame first. Pass `threadId` from `xdebug_get_threads` \
or omit it for the active thread. Each frame has an `index`, `file` (project-relative when possible), 1-based \
`line`, `isCurrent` for the top frame and a `presentation` label. Use a frame's `index` as `frameIndex` in \
`xdebug_get_frame_values`, `xdebug_get_value_by_path` and `xdebug_evaluate_expression`. Results are paged.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let thread = thread_id(&call, id, call.opt_str("threadId")?.as_deref()).await?;
            let frames = ops::debug::debug_stack_trace(&call.host(), id, thread).await?;
            let page = Page::of(&call, 200)?;
            let mut out = Map::new();
            let list: Vec<Value> = page
                .take(frames, &mut out)
                .into_iter()
                .enumerate()
                .map(|(i, f)| {
                    let index = page.offset + i;
                    json!({
                        "index": index,
                        "file": f.path.as_ref().map(|p| call.display(p)),
                        "line": (f.line as u64) + 1,
                        "isCurrent": index == 0,
                        "presentation": f.name,
                    })
                })
                .collect();
            out.insert("frames".into(), Value::Array(list));
            Output::json(Value::Object(out))
        },
    )
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(Param::optional("threadId", ParamType::String, "Thread id or name; defaults to the active thread."))
    .param(Param::optional("limit", ParamType::Integer, "Frames to return at most (default 200)"))
    .param(Param::optional("offset", ParamType::Integer, OFFSET))
}

/// One variable and the container its children come from.
#[derive(Clone)]
struct Located {
    var: Variable,
    container: i64,
}

async fn frame_variables(call: &Call, session: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Located>> {
    let mut out = Vec::new();
    for scope in ops::debug::debug_scopes(&call.host(), session, frame_id).await? {
        for var in ops::debug::debug_variables(&call.host(), session, scope.variables_reference).await? {
            out.push(Located { var, container: scope.variables_reference });
        }
    }
    Ok(out)
}

/// Follow `path` through the frame's variables, returning the value and its container.
async fn located_at(call: &Call, session: DebugSessionId, frame_id: i64, path: &[String]) -> IdeResult<Located> {
    if path.is_empty() {
        return Err(IdeError::invalid("path must not be empty"));
    }
    let mut vars = frame_variables(call, session, frame_id).await?;
    for (i, token) in path.iter().enumerate() {
        let found = vars
            .into_iter()
            .find(|v| v.var.name == *token)
            .ok_or_else(|| IdeError::not_found(format!("no value named `{token}` in this frame")))?;
        if i + 1 == path.len() {
            return Ok(found);
        }
        let container = found.var.variables_reference;
        if container <= 0 {
            return Err(IdeError::invalid(format!("`{}` has no children", found.var.name)));
        }
        vars = ops::debug::debug_variables(&call.host(), session, container)
            .await?
            .into_iter()
            .map(|var| Located { var, container })
            .collect();
    }
    unreachable!("a non-empty path returns in the loop")
}

fn variable_node(var: &Variable, children: Vec<Value>) -> Value {
    let mut node = json!({
        "name": var.name,
        "value": var.value,
        "type": var.type_name,
        "hasChildren": var.variables_reference > 0,
    });
    if !children.is_empty() {
        node["children"] = Value::Array(children);
    }
    node
}

/// Boxed so values can be expanded recursively without an unbounded future size. The shared
/// budget bounds the whole tree, not just each level, and the call can be cancelled mid-walk.
fn value_tree<'a>(
    call: &'a Call,
    session: DebugSessionId,
    var: Variable,
    depth: usize,
    budget: &'a Arc<AtomicUsize>,
) -> BoxFuture<'a, IdeResult<Value>> {
    Box::pin(async move {
        if call.cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let mut children = Vec::new();
        if depth > 0 && var.variables_reference > 0 {
            for child in ops::debug::debug_variables(&call.host(), session, var.variables_reference)
                .await?
                .into_iter()
                .take(MAX_CHILDREN)
            {
                if budget.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1)).is_err() {
                    break;
                }
                children.push(value_tree(call, session, child, depth - 1, budget).await?);
            }
        }
        Ok(variable_node(&var, children))
    })
}

async fn frame_values(
    call: &Call,
    session: DebugSessionId,
    frame_index: usize,
    depth: usize,
    thread: Option<&str>,
) -> IdeResult<Value> {
    let frame = frame_at(call, session, frame_index, thread).await?;
    let vars = frame_variables(call, session, frame.id).await?;
    let depth = depth.min(MAX_TREE_DEPTH);
    let budget = Arc::new(AtomicUsize::new(MAX_VALUE_NODES));
    let mut values = Vec::new();
    for located in vars.into_iter().take(MAX_CHILDREN) {
        values.push(value_tree(call, session, located.var, depth, &budget).await?);
    }
    Ok(json!({
        "frame": {
            "index": frame_index,
            "presentation": frame.name,
            "file": frame.path.as_ref().map(|p| call.display(p)),
            "line": (frame.line as u64) + 1,
        },
        "values": values,
    }))
}

fn frame_param() -> Param {
    Param::optional("frameIndex", ParamType::Integer, "0-based stack frame index (0 = top frame; default 0).")
}

fn thread_param() -> Param {
    Param::optional(
        "threadId",
        ParamType::String,
        "Thread id or name from xdebug_get_threads; defaults to the thread that last stopped.",
    )
}

fn depth_param() -> Param {
    Param::optional("depth", ParamType::Integer, "Levels of children to expand (0 = value only; default 0, max 5).")
}

fn get_frame_values() -> Tool {
    Tool::new(
        "xdebug_get_frame_values",
        "Returns the variables visible in a stack frame as a tree. The session must be suspended; `frameIndex` is \
the 0-based index from the current `xdebug_get_stack` result (0 = top frame). Nodes with children have \
`hasChildren: true` and a `children` array when `depth` expands them. Use `xdebug_get_value_by_path` to drill into \
a node, or `xdebug_evaluate_expression` to compute a value. Do not reuse a `frameIndex` after RESUME, a step or \
`xdebug_run_to_line`.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let index = call.opt_i64("frameIndex")?.unwrap_or(0).max(0) as usize;
            let depth = call.opt_i64("depth")?.unwrap_or(0).max(0) as usize;
            let thread = call.opt_str("threadId")?;
            Output::json(frame_values(&call, id, index, depth, thread.as_deref()).await?)
        },
    )
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(thread_param())
    .param(frame_param())
    .param(depth_param())
}

fn get_value_by_path() -> Tool {
    Tool::new(
        "xdebug_get_value_by_path",
        "Follows a list of child names from the current stack frame and returns the value at that path. For \
`obj.field.subField` pass `[\"obj\", \"field\", \"subField\"]`; for an array element pass the index token as \
written by the debugger, e.g. `[\"items\", \"[0]\", \"name\"]`. Use the exact names from \
`xdebug_get_frame_values` / a previous call and refresh them after every pause. `depth` expands children of the \
found value.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let path = call.str_list("path")?;
            let thread = call.opt_str("threadId")?;
            let frame =
                frame_at(&call, id, call.opt_i64("frameIndex")?.unwrap_or(0).max(0) as usize, thread.as_deref())
                    .await?;
            let found = located_at(&call, id, frame.id, &path).await?;
            let depth = call.opt_i64("depth")?.unwrap_or(0).max(0) as usize;
            let budget = Arc::new(AtomicUsize::new(MAX_VALUE_NODES));
            let value = value_tree(&call, id, found.var.clone(), depth.min(MAX_TREE_DEPTH), &budget).await?;
            Output::json(json!({ "value": value }))
        },
    )
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(thread_param())
    .param(frame_param())
    .param(Param::required("path", ParamType::StringList, "Child names to follow from the frame's variables."))
    .param(depth_param())
}

fn evaluate_expression() -> Tool {
    Tool::new(
        "xdebug_evaluate_expression",
        "Evaluates a raw expression in the context of a stack frame (0 = top frame by default) of a suspended \
session. Pass the expression exactly as the debugger's evaluator expects it, without JSON escaping. `depth` \
expands children of the result. Use it for computed checks, then continue with `xdebug_control_session`.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let thread = call.opt_str("threadId")?;
            let frame =
                frame_at(&call, id, call.opt_i64("frameIndex")?.unwrap_or(0).max(0) as usize, thread.as_deref())
                    .await?;
            let value = ops::debug::debug_evaluate(&call.host(), id, Some(frame.id), call.str("expression")?).await?;
            let depth = call.opt_i64("depth")?.unwrap_or(0).max(0) as usize;
            let budget = Arc::new(AtomicUsize::new(MAX_VALUE_NODES));
            let value = value_tree(&call, id, value, depth.min(MAX_TREE_DEPTH), &budget).await?;
            Output::json(json!({ "value": value }))
        },
    )
    .write()
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(thread_param())
    .param(frame_param())
    .param(Param::required("expression", ParamType::String, "Expression in the language of the current frame."))
    .param(depth_param())
}

fn set_variable() -> Tool {
    Tool::new(
        "xdebug_set_variable",
        "Changes a variable's value in a suspended session. `path` names the value as in \
`xdebug_get_value_by_path` and `newValue` is a raw expression in the language of the frame. The result reports \
the old and new values and whether the change was applied; re-read the value to confirm it.",
        |call| async move {
            let all = sessions(&call)?;
            let id = resolve_session(&all, call.opt_str("sessionId")?.as_deref())?;
            require_suspended(&call, id).await?;
            let path = call.str_list("path")?;
            let thread = call.opt_str("threadId")?;
            let frame =
                frame_at(&call, id, call.opt_i64("frameIndex")?.unwrap_or(0).max(0) as usize, thread.as_deref())
                    .await?;
            let located = located_at(&call, id, frame.id, &path).await?;
            let new_value = call.str("newValue")?;
            let updated = ops::debug::debug_set_variable(
                &call.host(),
                id,
                located.container,
                located.var.name.clone(),
                located.var.evaluate_name.clone(),
                Some(frame.id),
                new_value.clone(),
            )
            .await?;
            Output::json(json!({
                "applied": true,
                "oldValue": located.var.value,
                "newValue": updated.value,
            }))
        },
    )
    .write()
    .param(Param::optional("sessionId", ParamType::String, "Current session id; optional with a single session."))
    .param(thread_param())
    .param(frame_param())
    .param(Param::required("path", ParamType::StringList, "Path to the variable to change."))
    .param(Param::required("newValue", ParamType::String, "Assignable expression in the language of the frame."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::DebugSessionId;

    fn info(id: u32, name: &str) -> SessionInfo {
        SessionInfo { id: DebugSessionId(id), name: name.into(), adapter: "debugpy".into(), parent: None }
    }

    fn config(adapter: Option<&str>, kind: &str, command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "x".into(),
            name: "run x".into(),
            kind: kind.into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cwd: None,
            env: Default::default(),
            detected: false,
            is_test: false,
            debug_adapter: adapter.map(str::to_owned),
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    fn debugger() -> DebuggerSettings {
        DebuggerSettings::default()
    }

    #[test]
    fn a_native_launch_uses_the_program_and_arguments() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("codelldb"), "application", "./target/debug/app", &["--flag"]),
            &debugger(),
        )
        .unwrap();
        assert_eq!(launch.program.as_deref(), Some("/p/target/debug/app"));
        assert_eq!(launch.args, vec!["--flag"]);
    }

    #[test]
    fn a_cargo_launch_builds_first_and_keeps_program_arguments() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("codelldb"), "cargo", "cargo", &["run", "--bin", "app", "--", "arg"]),
            &debugger(),
        )
        .unwrap();
        assert_eq!(launch.args, vec!["arg"]);
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["cargo"]["args"], json!(["build", "--bin", "app"]));
        assert_eq!(extra["cargo"]["filter"], json!({ "name": "app", "kind": "bin" }));
    }

    #[test]
    fn a_cargo_test_launch_has_no_binary_filter() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("codelldb"), "cargo", "cargo", &["test", "--", "math::tests::adds", "--exact"]),
            &debugger(),
        )
        .unwrap();
        assert_eq!(launch.args, vec!["math::tests::adds", "--exact"]);
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["cargo"]["args"], json!(["test", "--no-run"]));
        assert!(extra["cargo"]["filter"].is_null(), "test artifacts are not bins");
    }

    #[test]
    fn a_python_launch_finds_the_script() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("debugpy"), "python", "python3", &["app.py", "--flag"]),
            &debugger(),
        )
        .unwrap();
        assert_eq!(launch.program.as_deref(), Some("/p/app.py"));
        assert_eq!(launch.args, vec!["--flag"]);
    }

    #[test]
    fn a_python_console_script_becomes_a_module() {
        let launch =
            launch_config(Path::new("/p"), &config(Some("debugpy"), "pytest", "pytest", &["-q"]), &debugger()).unwrap();
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["module"], "pytest");
        assert_eq!(extra["python"], system_python());
        assert_eq!(launch.args, vec!["-q"]);
    }

    #[test]
    fn a_manager_python_launch_keeps_the_run_subcommand() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("debugpy"), "pytest", "uv", &["run", "-m", "pytest"]),
            &debugger(),
        )
        .unwrap();
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["python"], json!(["uv", "run", system_python()]));
        assert_eq!(extra["module"], "pytest");
    }

    #[test]
    fn a_go_file_scope_launch_names_the_selected_files() {
        let mut configuration = config(Some("delve"), "go", "go", &[]);
        configuration.extras.params.insert("goKind".into(), "test".into());
        configuration.extras.params.insert("scope".into(), "file".into());
        configuration.extras.params.insert("target".into(), "a_test.go|b_test.go".into());
        let launch = launch_config(Path::new("/p"), &configuration, &debugger()).unwrap();
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["__goFiles"][0], "/p/a_test.go");
        assert_eq!(extra["__goFiles"][1], "/p/b_test.go");
    }

    #[test]
    fn a_go_test_launch_keeps_the_test_selection() {
        let launch = launch_config(
            Path::new("/p"),
            &config(Some("delve"), "go", "go", &["test", "-run", "^TestFoo$", "-race", "./pkg"]),
            &debugger(),
        )
        .unwrap();
        assert_eq!(launch.args, vec!["-test.run", "^TestFoo$"]);
        let extra: Value = serde_json::from_str(launch.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["buildFlags"], "-race");
        assert_eq!(extra["__goTargets"][0], "./pkg");
    }

    #[test]
    fn a_configuration_without_an_adapter_cannot_be_debugged() {
        assert!(launch_config(Path::new("/p"), &config(None, "python", "python3", &[]), &debugger()).is_err());
    }

    #[test]
    fn a_single_session_is_selected_without_an_id() {
        let sessions = vec![info(7, "app")];
        assert_eq!(resolve_session(&sessions, None).unwrap(), DebugSessionId(7));
        assert_eq!(resolve_session(&sessions, Some("app")).unwrap(), DebugSessionId(7));
        assert_eq!(resolve_session(&sessions, Some("7")).unwrap(), DebugSessionId(7));
        assert!(resolve_session(&sessions, Some("missing")).is_err());
    }

    #[test]
    fn duplicate_names_need_a_qualified_id() {
        let sessions = vec![info(7, "app"), info(8, "app")];
        assert!(resolve_session(&sessions, None).is_err());
        assert!(resolve_session(&sessions, Some("app")).is_err());
        assert_eq!(resolve_session(&sessions, Some("app#8")).unwrap(), DebugSessionId(8));
        assert_eq!(public_id(&sessions, &sessions[1]), "app#8");
    }

    #[test]
    fn breakpoint_ids_round_trip() {
        let id = line_bp_id("src/main.rs", 9);
        assert_eq!(id, "line:src/main.rs:10");
        assert_eq!(parse_line_bp_id(&id).unwrap(), ("src/main.rs".into(), 9));
        assert!(parse_line_bp_id("function:main").is_err());
    }
}
