mod output;

use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{DebugSessionId, IdeResult};
use ide_dap::*;
use std::path::PathBuf;

/// Starts a session owned by this window: its events (and those of child sessions) go here only.
pub async fn debug_start(host: &Host, window: &str, config: LaunchConfig) -> IdeResult<DebugSessionId> {
    host.require_trust(window)?;
    let mut config = match_java_debug_encoding(start_java_attach_listener(config, cfg!(windows)), cfg!(windows));
    if config.adapter == "debugpy"
        && config.request == "launch"
        && let Ok(project) = host.project(window)
    {
        super::python::prepare_debug(&mut config, &super::python::paths(&project))?;
    }
    let label = window;
    let (sink, flush_output) = output::coalescing_sink(host.window_sink(label));
    let owner = SessionOwner::new(host.owner_window(label), sink);
    let settings = match host.project(label) {
        Ok(project) => project.settings.effective(),
        Err(_) => host.global_settings.effective(),
    };
    if config.adapter == "delve" && config.request == "launch" {
        let root = host.project(window).map(|p| p.root.clone()).unwrap_or_default();
        let settings = settings.clone();
        config = host
            .blocking(move || {
                ide_sdk::go::debug_environment(&root, &settings, &mut config.env);
                ide_sdk::go::apply_to_debug(
                    &mut config.env,
                    &mut config.extra_json,
                    &settings.languages.go.build_tags,
                )?;
                Ok(config)
            })
            .await?;
    }
    if config.adapter == ide_dap::kotlin::ADAPTER {
        let data_dir = host.local_data_dir.clone();
        let runtime_root = config.cwd.clone().map(PathBuf::from).unwrap_or_default();
        let runtime_settings = settings.clone();
        let runtime = host
            .blocking(move || {
                if let Some(jdk) = ide_sdk::apply::jdtls_jdk(&runtime_root, &runtime_settings)
                    .map_err(ide_core::IdeError::unavailable)?
                {
                    if jdk.major >= 11 {
                        return Ok(jdk);
                    }
                    return Err(ide_core::IdeError::unavailable(
                        "Kotlin debugger needs JDK 11 or newer. Choose a newer language server JDK in Settings.",
                    ));
                }
                let jdks = ide_sdk::java::jdtls_jdks(11, &data_dir);
                ide_sdk::java::jdtls_runtime(&jdks, 11).cloned().ok_or_else(|| {
                    ide_core::IdeError::unavailable(
                        "Kotlin debugger needs JDK 11 or newer. Download or choose a language server JDK in Settings.",
                    )
                })
            })
            .await?;
        let mut extra: serde_json::Value = config
            .extra_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| ide_core::IdeError::invalid(e.to_string()))?
            .unwrap_or_else(|| serde_json::json!({}));
        extra["__adapterJavaHome"] = serde_json::json!(runtime.home);
        config.extra_json = Some(extra.to_string());
    }
    let root = config.cwd.clone().map(PathBuf::from).unwrap_or_default();
    let custom = |command: &str| {
        let path = ide_sdk::apply::tool_command(&root, &settings, command)?;
        Some(path.to_string_lossy().into_owned())
    };
    host.require_trust(window)?;
    let server_port = debug_server_port(&config);
    let result = host.debugger.start_with(config, owner, custom).await;
    flush_output();
    if let (Ok(id), Some(port)) = (&result, server_port) {
        attach_jvm_inspector(host, window, *id, port);
    }
    result
}

/// The port of the java-debug server this machine's jdtls started; `debugServer` as `host:port`
/// names an adapter on another machine, whose jdtls is not ours to ask.
fn debug_server_port(config: &LaunchConfig) -> Option<u16> {
    if config.adapter != "java-debug" {
        return None;
    }
    let extra: serde_json::Value = serde_json::from_str(config.extra_json.as_deref()?).ok()?;
    extra.get("debugServer")?.as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port != 0)
}

/// Lets the session ask the jdtls that runs it about its JVM. Without a module (no jdtls, or a
/// debug server it did not start) the session keeps the debugger-only memory view.
fn attach_jvm_inspector(host: &Host, window: &str, session: DebugSessionId, port: u16) {
    let Ok(project) = host.project(window) else { return };
    let Some(module) = project.lsp.java_debug_server_module(port) else { return };
    let inspector = std::sync::Arc::new(ide_lsp::JdtJvmInspector::new(project.lsp.clone(), module));
    if let Err(e) = host.debugger.set_jvm_inspector(session, inspector) {
        tracing::debug!("jvm inspector for session {session:?}: {e}");
    }
}

/// The JVM memory tab reads the class table over the attach socket, which only exists once the
/// JVM has started its attach listener. The flag goes first so the user's arguments still win.
/// Not on Windows (`windows`: the JVM runs there), which the memory view does not support.
fn start_java_attach_listener(mut config: LaunchConfig, windows: bool) -> LaunchConfig {
    if windows || config.adapter != "java-debug" || config.request != "launch" {
        return config;
    }
    let Some(serde_json::Value::Object(mut extra)) =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok())
    else {
        return config;
    };
    // java-debug also takes an array; rewriting one would drop the user's arguments.
    let vm_args = match extra.get("vmArgs") {
        None | Some(serde_json::Value::Null) => "",
        Some(serde_json::Value::String(args)) => args,
        Some(_) => return config,
    };
    if !ide_jvm_attach::wants_listener_flag(vm_args) {
        return config;
    }
    let vm_args = if vm_args.is_empty() {
        ide_jvm_attach::START_LISTENER_FLAG.to_string()
    } else {
        format!("{} {vm_args}", ide_jvm_attach::START_LISTENER_FLAG)
    };
    extra.insert("vmArgs".into(), vm_args.into());
    config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    config
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
    if let Some(vm_args) = ide_core::output_encoding::java_debug_vm_args(
        vm_args,
        &config.env,
        |key| std::env::var(key).ok(),
        encoding,
        windows,
    ) {
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

/// Types `text` into the session's program (a `runInTerminal` program).
pub async fn debug_send_input(host: &Host, _window: &str, session: DebugSessionId, text: String) -> IdeResult<()> {
    host.debugger.send_input(session, &text)
}

pub async fn debug_hot_reload(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.hot_reload(session).await
}

pub async fn debug_hot_restart(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.hot_restart(session).await
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

/// The adapter's completions for an expression being typed in the frame `frame_id`.
pub async fn debug_completions(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
    frame_id: Option<i64>,
    text: String,
    line: u32,
    column: u32,
) -> IdeResult<Vec<ide_dap::DebugCompletion>> {
    host.debugger.completions(session, frame_id, text, line, column).await
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
    window: &str,
    request: ide_core::RequestId,
    jvm_host: String,
    port: u16,
) -> IdeResult<u16> {
    host.require_trust(window)?;
    let token = host.begin_request(request);
    let result = jdwp::listen_for_jvm(&jvm_host, port, token).await;
    host.end_request(request);
    result
}

/// HotSwap (Reload Changed Classes) in a java-debug session.
pub async fn debug_redefine_classes(host: &Host, _window: &str, session: DebugSessionId) -> IdeResult<HotSwapResult> {
    host.debugger.redefine_classes(session).await
}

/// The debuggee JVM's loaded classes, or why they cannot be read.
pub async fn debug_jvm_memory_classes(
    host: &Host,
    _window: &str,
    session: DebugSessionId,
) -> IdeResult<JvmMemoryResult> {
    host.debugger.jvm_memory_classes(session).await
}

/// Up to `limit` live instances of the class in the stopped JVM.
pub async fn debug_jvm_memory_instances(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    class_name: String,
    limit: u32,
) -> IdeResult<JvmInstancesResult> {
    host.require_trust(window)?;
    host.debugger.jvm_memory_instances(session, class_name, limit).await
}

/// The fields (or array elements) of an instance listed by [`debug_jvm_memory_instances`].
pub async fn debug_jvm_memory_fields(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    object: JvmObjectRef,
) -> IdeResult<JvmFieldsResult> {
    host.require_trust(window)?;
    host.debugger.jvm_memory_fields(session, object).await
}

/// The objects that hold a reference to `object`; `limit` 0 selects the default.
pub async fn debug_jvm_memory_referrers(
    host: &Host,
    window: &str,
    session: DebugSessionId,
    object: JvmObjectRef,
    limit: u32,
) -> IdeResult<JvmReferrersResult> {
    host.require_trust(window)?;
    host.debugger.jvm_memory_referrers(session, object, limit).await
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
    d.add("debug_send_input", |c| async move {
        debug_send_input(&c.host, &c.window, c.arg("session")?, c.arg("text")?).await
    });
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
    d.add("debug_completions", |c| async move {
        debug_completions(
            &c.host,
            &c.window,
            c.arg("session")?,
            c.arg("frameId")?,
            c.arg("text")?,
            c.arg("line")?,
            c.arg("column")?,
        )
        .await
    });
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
    d.add("debug_jvm_memory_classes", |c| async move {
        debug_jvm_memory_classes(&c.host, &c.window, c.arg("session")?).await
    });
    d.add("debug_jvm_memory_instances", |c| async move {
        debug_jvm_memory_instances(&c.host, &c.window, c.arg("session")?, c.arg("className")?, c.arg("limit")?).await
    });
    d.add("debug_jvm_memory_fields", |c| async move {
        debug_jvm_memory_fields(&c.host, &c.window, c.arg("session")?, c.arg("object")?).await
    });
    d.add("debug_jvm_memory_referrers", |c| async move {
        debug_jvm_memory_referrers(&c.host, &c.window, c.arg("session")?, c.arg("object")?, c.arg("limit")?).await
    });
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
            env: [("JDK_JAVA_OPTIONS".into(), "".into()), ("JAVA_TOOL_OPTIONS".into(), "".into())].into(),
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
            "-Xmx1g -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -Dfile.encoding=UTF-8"
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

    /// The flag as added for a JVM on macOS or Linux.
    fn on_unix(config: LaunchConfig) -> LaunchConfig {
        start_java_attach_listener(config, false)
    }

    #[test]
    fn java_debug_launches_start_the_attach_listener() {
        let fixed = on_unix(launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"})));
        assert_eq!(vm_args(&fixed), "-XX:+StartAttachListener -Xmx1g");
        assert_eq!(
            vm_args(&on_unix(launch("java-debug", "launch", serde_json::json!({})))),
            "-XX:+StartAttachListener"
        );
        for extra in [
            serde_json::json!({"vmArgs": "-XX:-StartAttachListener"}),
            serde_json::json!({"vmArgs": "-XX:+DisableAttachMechanism"}),
        ] {
            assert_eq!(vm_args(&on_unix(launch("java-debug", "launch", extra.clone()))), extra["vmArgs"]);
        }
        assert_eq!(
            vm_args(&on_unix(launch("java-debug", "attach", serde_json::json!({"vmArgs": "-Xmx1g"})))),
            "-Xmx1g"
        );
    }

    #[test]
    fn java_debug_launches_on_windows_get_no_attach_listener() {
        let config = launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"}));
        assert_eq!(vm_args(&start_java_attach_listener(config, true)), "-Xmx1g");
    }

    #[test]
    fn java_debug_array_vm_args_are_left_alone() {
        let config = launch("java-debug", "launch", serde_json::json!({"vmArgs": ["-Xmx1g", "-Dk=v"]}));
        assert_eq!(on_unix(config.clone()).extra_json, config.extra_json);
        assert_eq!(
            vm_args(&on_unix(launch("java-debug", "launch", serde_json::json!({"vmArgs": null})))),
            "-XX:+StartAttachListener"
        );
    }

    #[test]
    fn debug_server_port_only_for_local_java_debug() {
        let port = |adapter: &str, request: &str, extra| debug_server_port(&launch(adapter, request, extra));
        assert_eq!(port("java-debug", "launch", serde_json::json!({"debugServer": 4711})), Some(4711));
        assert_eq!(port("java-debug", "attach", serde_json::json!({"debugServer": 4711})), Some(4711));
        assert_eq!(port("java-debug", "launch", serde_json::json!({"debugServer": "10.0.0.5:4711"})), None);
        assert_eq!(port(ide_dap::kotlin::ADAPTER, "launch", serde_json::json!({"debugServer": 4711})), None);
        assert_eq!(port("java-debug", "launch", serde_json::json!({})), None);
        assert_eq!(port("java-debug", "launch", serde_json::json!({"debugServer": 0})), None);
    }

    #[test]
    fn java_debug_launches_respect_environment_encoding() {
        for key in ["JDK_JAVA_OPTIONS", "JAVA_TOOL_OPTIONS"] {
            let mut config = launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Dstdout.encoding=GBK"}));
            config.env.insert(key.into(), "-Dfile.encoding=GBK".into());
            assert_eq!(vm_args(&match_java_debug_encoding(config, true)), "-Dstdout.encoding=GBK");
        }
    }
}
