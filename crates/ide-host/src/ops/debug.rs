use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{DebugSessionId, IdeResult};
use ide_dap::*;
use std::path::PathBuf;

/// Starts a session owned by this window: its events (and those of child sessions) go here only.
pub async fn debug_start(host: &Host, window: &str, config: LaunchConfig) -> IdeResult<DebugSessionId> {
    let mut config = match_java_debug_encoding(config, cfg!(windows));
    if config.adapter == "debugpy"
        && config.request == "launch"
        && let Ok(project) = host.project(window)
    {
        super::python::prepare_debug(&mut config, &super::python::paths(&project))?;
    }
    let label = window;
    let owner = SessionOwner::new(host.owner_window(label), host.window_sink(label));
    let settings = match host.project(label) {
        Ok(project) => project.settings.effective(),
        Err(_) => host.global_settings.effective(),
    };
    let root = config.cwd.clone().map(PathBuf::from).unwrap_or_default();
    let custom = |command: &str| {
        let path = ide_sdk::apply::tool_command(&root, &settings, command)?;
        Some(path.to_string_lossy().into_owned())
    };
    host.debugger.start_with(config, owner, custom).await
}

/// A JVM launched by java-debug writes what java-debug decodes its output as
/// (see [`ide_core::output_encoding::java_debug_vm_args`]).
fn match_java_debug_encoding(mut config: LaunchConfig, windows: bool) -> LaunchConfig {
    if config.adapter != "java-debug" || config.request != "launch" {
        return config;
    }
    let Some(serde_json::Value::Object(mut extra)) =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok())
    else {
        return config;
    };
    let vm_args = extra.get("vmArgs").and_then(|v| v.as_str()).unwrap_or_default();
    let encoding = extra.get("encoding").and_then(|v| v.as_str());
    if let Some(vm_args) = ide_core::output_encoding::java_debug_vm_args(vm_args, encoding, windows) {
        extra.insert("vmArgs".into(), vm_args.into());
        config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    }
    config
}

pub async fn debug_set_breakpoints(
    host: &Host,
    _window: &str,
    path: PathBuf,
    breakpoints: Vec<Breakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_breakpoints(path, breakpoints).await
}

pub async fn debug_threads(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<Vec<ThreadInfo>> {
    host.debugger.threads(session).await
}

pub async fn debug_stack_trace(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<Vec<StackFrame>> {
    host.debugger.stack_trace(session, thread_id).await
}

pub async fn debug_scopes(host: &Host, _window: &str, session: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Scope>> {
    host.debugger.scopes(session, frame_id).await
}

pub async fn debug_variables(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    reference: i64,
) -> IdeResult<Vec<Variable>> {
    host.debugger.variables(session, reference).await
}

pub async fn debug_evaluate(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
) -> IdeResult<Variable> {
    host.debugger.evaluate(session, frame_id, expression).await
}

pub async fn debug_resume(host: &Host, _window: &str, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    host.debugger.resume(session, thread_id).await
}

pub async fn debug_pause(host: &Host, _window: &str, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    host.debugger.pause(session, thread_id).await
}

pub async fn debug_step(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    thread_id: i64,
    kind: StepKind,
) -> IdeResult<()> {
    host.debugger.step(session, thread_id, kind).await
}

pub async fn debug_run_to(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    thread_id: i64,
    path: PathBuf,
    line: u32,
    force: bool,
) -> IdeResult<()> {
    host.debugger.run_to(session, thread_id, path, line, force).await
}

pub async fn debug_stop(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.stop(session).await
}

/// Evaluate with an explicit DAP context: `repl`, `watch`, `hover` or `clipboard`.
pub async fn debug_evaluate_in(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
    context: Option<String>,
) -> IdeResult<Variable> {
    host.debugger.evaluate_in(session, frame_id, expression, context).await
}

/// Last known verification states of a file's breakpoints (refetch on `breakpointsChanged`).
pub fn debug_breakpoint_states(host: &Host, _window: &str, path: PathBuf) -> IdeResult<Vec<BreakpointState>> {
    Ok(host.debugger.breakpoint_states(&path))
}

/// This window's live sessions, including adapter-started child sessions.
pub fn debug_sessions(host: &Host, window: &str) -> IdeResult<Vec<SessionInfo>> {
    Ok(host.debugger.sessions(Some(host.owner_window(window))))
}

pub fn debug_exception_filters(host: &Host, window: &str) -> IdeResult<Vec<SessionExceptionFilters>> {
    Ok(host.debugger.exception_filters(Some(host.owner_window(window))))
}

pub async fn debug_set_exception_breakpoints(
    host: &Host,
    _window: &str,
    choices: std::collections::BTreeMap<String, bool>,
) -> IdeResult<()> {
    host.debugger.set_exception_breakpoints(choices).await
}

#[allow(clippy::too_many_arguments)]
pub async fn debug_set_variable(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    container: i64,
    name: String,
    evaluate_name: Option<String>,
    frame_id: Option<i64>,
    value: String,
) -> IdeResult<Variable> {
    host.debugger.set_variable(session, container, name, evaluate_name, frame_id, value).await
}

/// Force Step Over: step over with every breakpoint suspended until the step ends.
pub async fn debug_force_step_over(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    thread_id: i64,
) -> IdeResult<()> {
    host.debugger.force_step_over(session, thread_id).await
}

/// Smart Step Into: the calls on the current line of `frame_id`.
pub async fn debug_step_in_targets(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    frame_id: i64,
) -> IdeResult<Vec<StepInTarget>> {
    host.debugger.step_in_targets(session, frame_id).await
}

pub async fn debug_step_in_target(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    thread_id: i64,
    target_id: i64,
) -> IdeResult<()> {
    host.debugger.step_in_target(session, thread_id, target_id).await
}

/// Reset Frame (Drop Frame).
pub async fn debug_restart_frame(host: &Host, _window: &str, session: DebugSessionId, frame_id: i64) -> IdeResult<()> {
    host.debugger.restart_frame(session, frame_id).await
}

pub fn debug_capabilities(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<DebugCapabilities> {
    host.debugger.capabilities(session)
}

/// Method breakpoints (all files); states aligned with `breakpoints`.
pub async fn debug_set_function_breakpoints(
    host: &Host,
    _window: &str,
    breakpoints: Vec<FunctionBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_function_breakpoints(breakpoints).await
}

/// Field watchpoints; states aligned with `breakpoints`.
pub async fn debug_set_data_breakpoints(
    host: &Host,
    _window: &str,
    breakpoints: Vec<DataBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_data_breakpoints(breakpoints).await
}

pub async fn debug_data_breakpoint_info(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    container: i64,
    name: String,
    frame_id: Option<i64>,
) -> IdeResult<DataBreakpointInfo> {
    host.debugger.data_breakpoint_info(session, container, name, frame_id).await
}

/// Attach to Process: the user's processes a debugger can attach to.
pub async fn debug_attachable_processes(_host: &Host, _window: &str) -> IdeResult<Vec<attach::AttachableProcess>> {
    tokio::task::spawn_blocking(attach::attachable_processes)
        .await
        .map_err(|e| ide_core::IdeError::internal(format!("listing processes failed: {e}")))?
}

/// Remote JVM Debug in listen mode: waits (cancellable through `request`) for the remote
/// JVM to connect to `host:port`; returns the loopback port java-debug attaches to.
pub async fn debug_listen_for_jvm(
    host: &Host,
    _window: &str,
    request: ide_core::RequestId,
    jvm_host: String,
    port: u16,
) -> IdeResult<u16> {
    let token = host.begin_request(request);
    let result = jdwp::listen_for_jvm(&jvm_host, port, token).await;
    host.end_request(request);
    result
}

/// HotSwap (Reload Changed Classes) in a java-debug session.
pub async fn debug_redefine_classes(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<HotSwapResult> {
    host.debugger.redefine_classes(session).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("debug_start", |c| async move { debug_start(&c.host, &c.window, c.arg("config")?).await });
    d.add("debug_set_breakpoints", |c| async move {
        debug_set_breakpoints(&c.host, &c.window, c.arg("path")?, c.arg("breakpoints")?).await
    });
    d.add("debug_threads", |c| async move { debug_threads(&c.host, &c.window, c.arg("session")?).await });
    d.add("debug_stack_trace", |c| async move {
        debug_stack_trace(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?).await
    });
    d.add(
        "debug_scopes",
        |c| async move { debug_scopes(&c.host, &c.window, c.arg("session")?, c.arg("frameId")?).await },
    );
    d.add("debug_variables", |c| async move {
        debug_variables(&c.host, &c.window, c.arg("session")?, c.arg("reference")?).await
    });
    d.add("debug_evaluate", |c| async move {
        debug_evaluate(&c.host, &c.window, c.arg("session")?, c.arg("frameId")?, c.arg("expression")?).await
    });
    d.add(
        "debug_resume",
        |c| async move { debug_resume(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?).await },
    );
    d.add(
        "debug_pause",
        |c| async move { debug_pause(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?).await },
    );
    d.add("debug_step", |c| async move {
        debug_step(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?, c.arg("kind")?).await
    });
    d.add("debug_run_to", |c| async move {
        debug_run_to(
            &c.host,
            &c.window,
            c.arg("session")?,
            c.arg("threadId")?,
            c.arg("path")?,
            c.arg("line")?,
            c.arg("force")?,
        )
        .await
    });
    d.add("debug_stop", |c| async move { debug_stop(&c.host, &c.window, c.arg("session")?).await });
    d.add("debug_evaluate_in", |c| async move {
        debug_evaluate_in(
            &c.host,
            &c.window,
            c.arg("session")?,
            c.arg("frameId")?,
            c.arg("expression")?,
            c.arg("context")?,
        )
        .await
    });
    d.add("debug_breakpoint_states", |c| async move { debug_breakpoint_states(&c.host, &c.window, c.arg("path")?) });
    d.add("debug_sessions", |c| async move { debug_sessions(&c.host, &c.window) });
    d.add("debug_exception_filters", |c| async move { debug_exception_filters(&c.host, &c.window) });
    d.add("debug_set_exception_breakpoints", |c| async move {
        debug_set_exception_breakpoints(&c.host, &c.window, c.arg("choices")?).await
    });
    d.add("debug_set_variable", |c| async move {
        debug_set_variable(
            &c.host,
            &c.window,
            c.arg("session")?,
            c.arg("container")?,
            c.arg("name")?,
            c.arg("evaluateName")?,
            c.arg("frameId")?,
            c.arg("value")?,
        )
        .await
    });
    d.add("debug_force_step_over", |c| async move {
        debug_force_step_over(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?).await
    });
    d.add("debug_step_in_targets", |c| async move {
        debug_step_in_targets(&c.host, &c.window, c.arg("session")?, c.arg("frameId")?).await
    });
    d.add("debug_step_in_target", |c| async move {
        debug_step_in_target(&c.host, &c.window, c.arg("session")?, c.arg("threadId")?, c.arg("targetId")?).await
    });
    d.add("debug_restart_frame", |c| async move {
        debug_restart_frame(&c.host, &c.window, c.arg("session")?, c.arg("frameId")?).await
    });
    d.add("debug_capabilities", |c| async move { debug_capabilities(&c.host, &c.window, c.arg("session")?) });
    d.add("debug_set_function_breakpoints", |c| async move {
        debug_set_function_breakpoints(&c.host, &c.window, c.arg("breakpoints")?).await
    });
    d.add("debug_set_data_breakpoints", |c| async move {
        debug_set_data_breakpoints(&c.host, &c.window, c.arg("breakpoints")?).await
    });
    d.add("debug_data_breakpoint_info", |c| async move {
        debug_data_breakpoint_info(
            &c.host,
            &c.window,
            c.arg("session")?,
            c.arg("container")?,
            c.arg("name")?,
            c.arg("frameId")?,
        )
        .await
    });
    d.add("debug_attachable_processes", |c| async move { debug_attachable_processes(&c.host, &c.window).await });
    d.add("debug_listen_for_jvm", |c| async move {
        debug_listen_for_jvm(&c.host, &c.window, c.arg("request")?, c.arg("host")?, c.arg("port")?).await
    });
    d.add(
        "debug_redefine_classes",
        |c| async move { debug_redefine_classes(&c.host, &c.window, c.arg("session")?).await },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(adapter: &str, request: &str, extra: serde_json::Value) -> LaunchConfig {
        LaunchConfig {
            name: "DromaraApplication".into(),
            adapter: adapter.into(),
            request: request.into(),
            program: None,
            args: vec![],
            cwd: None,
            env: Default::default(),
            extra_json: Some(extra.to_string()),
        }
    }

    fn vm_args(config: &LaunchConfig) -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()["vmArgs"].clone()
    }

    #[test]
    fn java_debug_launches_on_windows_write_utf8() {
        let extra =
            serde_json::json!({"mainClass": "org.dromara.DromaraApplication", "vmArgs": "-Xmx1g", "debugServer": 1});
        let fixed = match_java_debug_encoding(launch("java-debug", "launch", extra.clone()), true);
        assert_eq!(
            vm_args(&fixed),
            "-Xmx1g -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(fixed.extra_json.as_deref().unwrap()).unwrap()["mainClass"],
            "org.dromara.DromaraApplication"
        );
        // Attaching, other adapters and other platforms are left alone.
        for (adapter, request, windows) in
            [("java-debug", "attach", true), ("debugpy", "launch", true), ("java-debug", "launch", false)]
        {
            assert_eq!(vm_args(&match_java_debug_encoding(launch(adapter, request, extra.clone()), windows)), "-Xmx1g");
        }
    }
}
