mod kotlin;
#[cfg(test)]
mod kotlin_tests;
mod output;

use crate::Host;
use ide_command::command;
use ide_core::{DebugSessionId, IdeResult};
use ide_dap::*;
use std::path::PathBuf;

/// Starts a session owned by this window: its events (and those of child sessions) go here only.
#[command(trust = trusted)]
pub async fn debug_start(host: &Host, window: &str, config: LaunchConfig) -> IdeResult<DebugSessionId> {
    host.require_trust(window)?;
    let unity_pid = if config.adapter == "unity" {
        if config.request != "attach" {
            return Err(ide_core::IdeError::invalid("Unity debugging only supports attachment to a running Editor"));
        }
        let arguments = launch_arguments(&config)?;
        let pid = arguments["name"]
            .as_str()
            .and_then(|name| name.strip_prefix("Unity Editor ("))
            .and_then(|name| name.strip_suffix(')'))
            .and_then(|pid| pid.parse::<u32>().ok());
        if let Some(pid) = pid {
            require_unity_editor(pid)?;
        }
        let cwd = config.cwd.as_ref().map(|path| path.as_ref()).unwrap_or_else(|| std::path::Path::new("."));
        unity::require_runtime(cwd)?;
        pid
    } else {
        None
    };
    let mut config = config;
    let enhanced = take_enhanced_redefinition(&mut config);
    let executor = take_executor(&mut config);
    let java_exec = java_exec_path(&config);
    let mut agents = if is_jvm_launch(&config) {
        ide_run::java_agent::current_for_executor(java_exec.as_deref(), executor.as_deref())
    } else {
        ide_run::java_agent::Agents::default()
    };
    match enhanced {
        Some(Ok(option)) => agents.options.insert(0, option.to_owned()),
        Some(Err(note)) => agents.notes.push(note),
        None => {}
    }
    let config = add_java_agents(config, &agents.options);
    let mut config = match_java_debug_encoding(start_java_attach_listener(config, cfg!(windows)), cfg!(windows));
    if config.adapter == "debugpy"
        && config.request == "launch"
        && let Ok(project) = host.project(window)
    {
        let python = super::python::debug_python(&config);
        let paths = super::python::with_user_paths(
            super::python::paths(&project),
            &host.config_dir,
            &project,
            python.as_deref(),
            config.cwd.as_deref(),
        );
        let plots = super::plots::prepare(host, &project);
        super::python::prepare_debug(&mut config, &paths, plots.as_ref())?;
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
                ide_sdk::go::prepare_debug_compiler(&mut config.env, &config.extra_json)?;
                ide_sdk::go::configure_environment(&root, &settings, &mut config.env);
                ide_sdk::go::apply_to_debug(
                    &mut config.env,
                    &mut config.program,
                    &mut config.args,
                    &mut config.extra_json,
                    &settings.languages.go.build_tags,
                )?;
                Ok(config)
            })
            .await?;
    }
    config = kotlin::choose_kotlin_debugger(host, window, config).await?;
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
    if finds_java_sources(&config)
        && let Ok(project) = host.project(window)
    {
        let roots = host.blocking(move || Ok(java_source_roots(&project))).await?;
        config = add_java_source_paths(config, &roots);
    }
    let root = config.cwd.clone().map(PathBuf::from).unwrap_or_default();
    let mut ruby_tools = Vec::new();
    if config.adapter == "rdbg" && config.request == "launch" {
        let project_root = host.project(window).map(|p| p.root.clone()).unwrap_or_else(|_| root.clone());
        let (dir, settings) = (root.clone(), settings.clone());
        (config, ruby_tools) = host
            .blocking(move || {
                let tools = ide_sdk::ruby::debug_environment(&project_root, &dir, &settings, &mut config.env);
                Ok((config, tools))
            })
            .await?;
    }
    let java_analyzer = java_analyzer_command(host, window, &config)?;
    let custom = |command: &str| {
        if let Some(binary) = java_analyzer {
            return Some(binary.to_string_lossy().into_owned());
        }
        let path = ide_sdk::apply::tool_command(&root, &settings, command)
            .or_else(|| ruby_tools.into_iter().find(|(name, _)| *name == command).map(|(_, path)| path))?;
        Some(path.to_string_lossy().into_owned())
    };
    host.require_trust(window)?;
    let server_port = debug_server_port(&config);
    let exception_classes = server_port.and_then(|port| exception_class_backend(host, window, port));
    let result = host.debugger.start_with_exception_classes(config, owner, custom, exception_classes).await;
    flush_output();
    if let Ok(id) = &result {
        let sink = host.window_sink(label);
        for note in &agents.notes {
            sink.emit(ide_core::IdeEvent::Debug {
                session: *id,
                event: ide_core::event::DebugEvent::Output { category: "console".into(), output: format!("{note}\n") },
            });
        }
    }
    if result.is_err()
        && let Some(pid) = unity_pid
    {
        require_unity_editor(pid)?;
    }
    if let (Ok(id), Some(port)) = (&result, server_port) {
        attach_jvm_inspector(host, window, *id, port);
    }
    result
}

/// For java-analyzer's debugger, the executable of the java-analyzer serving the module
/// (`projectRoot`, else the working directory), so the session debugs with the server that
/// analyzes the code.
fn java_analyzer_command(host: &Host, window: &str, config: &LaunchConfig) -> IdeResult<Option<PathBuf>> {
    if config.adapter != ide_dap::adapter::JAVA_ANALYZER {
        return Ok(None);
    }
    let project = host.project(window)?;
    let extra: serde_json::Value =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok()).unwrap_or_default();
    let module = extra["projectRoot"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| config.cwd.clone().map(PathBuf::from))
        .unwrap_or_else(|| project.root.clone());
    project.lsp.java_analyzer_binary(&module).map(Some).ok_or_else(|| {
        ide_core::IdeError::unavailable(
            "No java-analyzer serves this module: configure it as a Java language server to debug without jdtls",
        )
    })
}

fn require_unity_editor(pid: u32) -> IdeResult<()> {
    if !ide_core::process::process_alive(pid) {
        return Err(ide_core::IdeError::unavailable(format!(
            "Unity Editor (PID {pid}) is no longer running. Refresh the Unity process list and select a running Editor."
        )));
    }
    Ok(())
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
    let inspector = std::sync::Arc::new(ide_lsp::JdtJvmInspector::new(project.lsp.clone(), module.clone()));
    if let Err(e) = host.debugger.set_jvm_inspector(session, inspector) {
        tracing::debug!("jvm inspector for session {session:?}: {e}");
        return;
    }
    let tracer = std::sync::Arc::new(ide_lsp::JdtStreamTracer::new(project.lsp.clone(), module));
    if let Err(e) = host.debugger.set_stream_tracer(session, tracer) {
        tracing::debug!("stream tracer for session {session:?}: {e}");
    }
}

/// Given before the session starts, unlike the inspector: the breakpoints are armed before
/// `configurationDone`, so a throw in `main`'s first line stops.
fn exception_class_backend(
    host: &Host,
    window: &str,
    port: u16,
) -> Option<std::sync::Arc<dyn ide_jvm_inspect::ExceptionClassBreakpoints>> {
    let project = host.project(window).ok()?;
    let module = project.lsp.java_debug_server_module(port)?;
    Some(std::sync::Arc::new(ide_lsp::JdtExceptionBreakpoints::new(project.lsp.clone(), module)))
}

/// A JVM the debugger starts itself: an Application or Spring Boot configuration, launched by
/// java-debug, java-analyzer or the Kotlin debugger (JAR Application debugs through a run with a
/// JDWP agent).
fn is_jvm_launch(config: &LaunchConfig) -> bool {
    config.request == "launch"
        && matches!(config.adapter.as_str(), "java-debug" | ide_dap::kotlin::ADAPTER | ide_dap::adapter::JAVA_ANALYZER)
}

/// `javaExec` from the launch extras, for gating contributed `vmOptions` on JetBrains Runtime.
fn java_exec_path(config: &LaunchConfig) -> Option<std::path::PathBuf> {
    let extra: serde_json::Value = serde_json::from_str(config.extra_json.as_deref()?).ok()?;
    extra.get("javaExec").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(std::path::PathBuf::from)
}

/// The configuration's Enhanced class redefinition (`enhancedClassRedefinition` in the launch
/// extras, which this removes): for a JVM the debugger starts, JetBrains Runtime's flag, or the
/// console line saying why the session runs without it.
fn take_enhanced_redefinition(config: &mut LaunchConfig) -> Option<Result<&'static str, String>> {
    let Some(serde_json::Value::Object(mut extra)) =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok())
    else {
        return None;
    };
    let on = extra.remove("enhancedClassRedefinition")?.as_bool() == Some(true);
    config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    (on && is_jvm_launch(config))
        .then(|| ide_run::java_hotswap::enhanced_redefinition(java_exec_path(config).as_deref()))
}

/// The plugin executor the session launches through (`executor` in the launch extras, which
/// this removes): its plugin's executor-bound Java agent loads only then.
fn take_executor(config: &mut LaunchConfig) -> Option<String> {
    let Some(serde_json::Value::Object(mut extra)) =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok())
    else {
        return None;
    };
    let executor = extra.remove("executor")?;
    config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    executor.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Plugins' Java agents ([`ide_run::java_agent`]) after the configuration's VM options:
/// java-debug's and java-analyzer's `vmArgs` (one line, or a list) or the Kotlin debugger's
/// `vmArguments` (a list).
fn add_java_agents(mut config: LaunchConfig, options: &[String]) -> LaunchConfig {
    if options.is_empty() || !is_jvm_launch(&config) {
        return config;
    }
    let Some(serde_json::Value::Object(mut extra)) =
        config.extra_json.as_deref().and_then(|e| serde_json::from_str(e).ok())
    else {
        return config;
    };
    let key = if config.adapter == ide_dap::kotlin::ADAPTER { "vmArguments" } else { "vmArgs" };
    let value = match extra.get(key) {
        None | Some(serde_json::Value::Null) if key == "vmArgs" => {
            ide_run::java_agent::add_to_vm_args_text("", options).into()
        }
        Some(serde_json::Value::String(text)) => ide_run::java_agent::add_to_vm_args_text(text, options).into(),
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Array(_)) => {
            let mut list: Vec<String> = extra
                .get(key)
                .and_then(serde_json::Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            ide_run::java_agent::add_to_vm_args(&mut list, options);
            list.into()
        }
        Some(_) => return config,
    };
    extra.insert(key.into(), value);
    config.extra_json = Some(serde_json::Value::Object(extra).to_string());
    config
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

/// The project's source and test roots, as the IDE detects them (no Maven / Gradle import needed).
fn java_source_roots(project: &crate::project::Project) -> Vec<PathBuf> {
    use ide_workspace::roots::RootKind;
    project
        .roots()
        .roots
        .iter()
        .filter(|r| matches!(r.kind, RootKind::Source | RootKind::Test))
        .map(|r| project.root.join(&r.path))
        .filter(|p| p.is_dir())
        .collect()
}

/// Debuggers that look a frame's source up in `sourcePaths` when their own model has no file:
/// java-debug after jdtls (which has not imported a project whose Maven sync failed), and
/// java-analyzer after the module it debugs (whose sibling modules it does not load).
fn finds_java_sources(config: &LaunchConfig) -> bool {
    matches!(config.adapter.as_str(), "java-debug" | ide_dap::adapter::JAVA_ANALYZER)
}

/// Without a file for the stopped frame the editor cannot follow the execution point, so Java
/// sessions get every source root of the project. The user's own list wins.
fn add_java_source_paths(mut config: LaunchConfig, roots: &[PathBuf]) -> LaunchConfig {
    if !finds_java_sources(&config) || roots.is_empty() {
        return config;
    }
    let mut extra = match config.extra_json.as_deref().map(serde_json::from_str) {
        None => serde_json::Map::new(),
        Some(Ok(serde_json::Value::Object(extra))) => extra,
        Some(_) => return config,
    };
    if extra.get("sourcePaths").is_some_and(|v| !v.is_null()) {
        return config;
    }
    let paths: Vec<String> = roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
    extra.insert("sourcePaths".into(), paths.into());
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

/// This window's breakpoints of `path`.
#[command(trust = trusted)]
pub async fn debug_set_breakpoints(
    host: &Host,
    window: &str,
    path: PathBuf,
    breakpoints: Vec<Breakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_breakpoints(host.owner_window(window), path, breakpoints).await
}

/// Replaces all of this window's line breakpoints with `files`.
#[command(trust = trusted)]
pub async fn debug_replace_breakpoints(
    host: &Host,
    window: &str,
    files: std::collections::BTreeMap<PathBuf, Vec<Breakpoint>>,
) -> IdeResult<()> {
    host.debugger.replace_breakpoints(host.owner_window(window), files).await
}

#[command(trust = trusted)]
pub async fn debug_threads(host: &Host, session: DebugSessionId) -> IdeResult<Vec<ThreadInfo>> {
    host.debugger.threads(session).await
}

#[command(trust = trusted)]
pub async fn debug_stack_trace(host: &Host, session: DebugSessionId, thread_id: i64) -> IdeResult<Vec<StackFrame>> {
    host.debugger.stack_trace(session, thread_id).await
}

#[command(trust = trusted)]
pub async fn debug_scopes(host: &Host, session: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Scope>> {
    host.debugger.scopes(session, frame_id).await
}

#[command(trust = trusted)]
pub async fn debug_variables(host: &Host, session: DebugSessionId, reference: i64) -> IdeResult<Vec<Variable>> {
    host.debugger.variables(session, reference).await
}

#[command(trust = trusted)]
pub async fn debug_resolve_variable(host: &Host, session: DebugSessionId, variable: Variable) -> IdeResult<Variable> {
    host.debugger.resolve_variable(session, variable).await
}

#[command(trust = trusted)]
pub async fn debug_evaluate(
    host: &Host,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
) -> IdeResult<Variable> {
    host.debugger.evaluate(session, frame_id, expression).await
}

#[command(trust = trusted)]
pub async fn debug_resume(host: &Host, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    host.debugger.resume(session, thread_id).await
}

#[command(trust = trusted)]
pub async fn debug_pause(host: &Host, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    host.debugger.pause(session, thread_id).await
}

/// Types `text` into the session's program (a `runInTerminal` program).
#[command(trust = trusted)]
pub async fn debug_send_input(host: &Host, session: DebugSessionId, text: String) -> IdeResult<()> {
    host.debugger.send_input(session, &text)
}

pub async fn debug_hot_reload(host: &Host, session: DebugSessionId, reason: HotReloadReason) -> IdeResult<()> {
    host.debugger.hot_reload(session, reason).await
}

pub async fn debug_hot_restart(host: &Host, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.hot_restart(session).await
}

#[command(trust = trusted)]
pub async fn debug_step(host: &Host, session: DebugSessionId, thread_id: i64, kind: StepKind) -> IdeResult<()> {
    host.debugger.step(session, thread_id, kind).await
}

#[command(trust = trusted)]
pub async fn debug_run_to(
    host: &Host,
    session: DebugSessionId,
    thread_id: i64,
    path: PathBuf,
    line: u32,
    force: bool,
) -> IdeResult<()> {
    host.debugger.run_to(session, thread_id, path, line, force).await
}

#[command(trust = always)]
pub async fn debug_stop(host: &Host, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.stop(session).await
}

/// Completions for an expression typed in Evaluate (`line` / `column` 0-based, UTF-16).
#[command(trust = trusted)]
pub async fn debug_completions(
    host: &Host,
    session: DebugSessionId,
    frame_id: Option<i64>,
    text: String,
    line: u32,
    column: u32,
) -> IdeResult<Vec<ide_dap::DebugCompletion>> {
    host.debugger.completions(session, frame_id, text, line, column).await
}

/// Evaluate with an explicit DAP context: `repl`, `watch`, `hover` or `clipboard`.
#[command(trust = trusted)]
pub async fn debug_evaluate_in(
    host: &Host,
    session: DebugSessionId,
    frame_id: Option<i64>,
    expression: String,
    context: Option<String>,
) -> IdeResult<Variable> {
    host.debugger.evaluate_in(session, frame_id, expression, context).await
}

/// Last known verification states of a file's breakpoints (refetch on `breakpointsChanged`).
#[command(trust = trusted)]
pub fn debug_breakpoint_states(host: &Host, path: PathBuf) -> IdeResult<Vec<BreakpointState>> {
    Ok(host.debugger.breakpoint_states(&path))
}

/// This window's live sessions, including adapter-started child sessions.
#[command(trust = always)]
pub fn debug_sessions(host: &Host, window: &str) -> IdeResult<Vec<SessionInfo>> {
    Ok(host.debugger.sessions(Some(host.owner_window(window))))
}

#[command(trust = trusted)]
pub fn debug_exception_filters(host: &Host, window: &str) -> IdeResult<Vec<SessionExceptionFilters>> {
    Ok(host.debugger.exception_filters(Some(host.owner_window(window))))
}

#[command(trust = trusted)]
pub async fn debug_set_exception_breakpoints(
    host: &Host,
    choices: std::collections::BTreeMap<String, bool>,
) -> IdeResult<()> {
    host.debugger.set_exception_breakpoints(choices).await
}

/// Exception breakpoints on chosen classes (all sessions that take them, and later ones).
#[command(trust = trusted)]
pub async fn debug_set_exception_class_breakpoints(
    host: &Host,
    breakpoints: Vec<ExceptionClassBreakpoint>,
) -> IdeResult<()> {
    host.debugger.set_exception_class_breakpoints(breakpoints).await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn debug_set_variable(
    host: &Host,
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
#[command(trust = trusted)]
pub async fn debug_force_step_over(host: &Host, session: DebugSessionId, thread_id: i64) -> IdeResult<()> {
    host.debugger.force_step_over(session, thread_id).await
}

/// Smart Step Into: the calls on the current line of `frame_id`.
#[command(trust = trusted)]
pub async fn debug_step_in_targets(
    host: &Host,
    session: DebugSessionId,
    frame_id: i64,
) -> IdeResult<Vec<StepInTarget>> {
    host.debugger.step_in_targets(session, frame_id).await
}

#[command(trust = trusted)]
pub async fn debug_step_in_target(
    host: &Host,
    session: DebugSessionId,
    thread_id: i64,
    target_id: i64,
) -> IdeResult<()> {
    host.debugger.step_in_target(session, thread_id, target_id).await
}

/// Reset Frame (Drop Frame).
#[command(trust = trusted)]
pub async fn debug_restart_frame(host: &Host, session: DebugSessionId, frame_id: i64) -> IdeResult<()> {
    host.debugger.restart_frame(session, frame_id).await
}

/// Breakpoints of a debugged page on DOM events and on requests (js-debug).
#[command(trust = trusted)]
pub async fn debug_js_custom_breakpoints(
    host: &Host,
    session: DebugSessionId,
    ids: Vec<String>,
    xhr: Vec<String>,
) -> IdeResult<()> {
    host.debugger.js_set_custom_breakpoints(session, ids, xhr).await
}

/// The responses a debugged page gets in place of the server's, by a part of the URL; none
/// switches the replacing off.
#[command(trust = trusted)]
pub async fn debug_js_response_overrides(
    host: &Host,
    session: DebugSessionId,
    rules: Vec<ide_dap::JsResponseRule>,
) -> IdeResult<()> {
    host.debugger.js_set_response_overrides(session, rules).await
}

/// The body of a response a debugged page received.
#[command(trust = trusted)]
pub async fn debug_js_response_body(
    host: &Host,
    session: DebugSessionId,
    request_id: String,
) -> IdeResult<ide_dap::JsResponseBody> {
    host.debugger.js_response_body(session, request_id).await
}

/// Starts recording a debugged page's CPU profile.
#[command(trust = trusted)]
pub async fn debug_js_start_profile(host: &Host, session: DebugSessionId) -> IdeResult<()> {
    host.debugger.js_start_profile(session).await
}

/// Ends the recording: a directory holding the profile as `page.cpuprofile`.
#[command(trust = trusted)]
pub async fn debug_js_stop_profile(host: &Host, session: DebugSessionId) -> IdeResult<ide_core::IpcPath> {
    host.debugger.js_stop_profile(session).await.map(Into::into)
}

#[command(trust = trusted)]
pub fn debug_capabilities(host: &Host, session: DebugSessionId) -> IdeResult<DebugCapabilities> {
    host.debugger.capabilities(session)
}

/// Method breakpoints (all files); states aligned with `breakpoints`.
#[command(trust = trusted)]
pub async fn debug_set_function_breakpoints(
    host: &Host,
    window: &str,
    breakpoints: Vec<FunctionBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_function_breakpoints(host.owner_window(window), breakpoints).await
}

/// Field watchpoints; states aligned with `breakpoints`.
#[command(trust = trusted)]
pub async fn debug_set_data_breakpoints(
    host: &Host,
    window: &str,
    breakpoints: Vec<DataBreakpoint>,
) -> IdeResult<Vec<BreakpointState>> {
    host.debugger.set_data_breakpoints(host.owner_window(window), breakpoints).await
}

#[command(trust = trusted)]
pub async fn debug_data_breakpoint_info(
    host: &Host,
    session: DebugSessionId,
    container: i64,
    name: String,
    frame_id: Option<i64>,
) -> IdeResult<DataBreakpointInfo> {
    host.debugger.data_breakpoint_info(session, container, name, frame_id).await
}

/// Attach to Process: the user's processes a debugger can attach to.
#[command(trust = always)]
pub async fn debug_attachable_processes() -> IdeResult<Vec<attach::AttachableProcess>> {
    tokio::task::spawn_blocking(attach::attachable_processes)
        .await
        .map_err(|e| ide_core::IdeError::internal(format!("listing processes failed: {e}")))?
}

/// A loopback port that is free right now, for a debug agent the launch line starts.
#[command(trust = trusted)]
pub async fn debug_free_port(host: &Host, window: &str) -> IdeResult<u16> {
    // `address=127.0.0.1:<port>` — used when its "Listening for transport" line never reaches
    // the console (a Surefire fork holds it until the tests run, which `suspend=y` prevents).
    host.require_trust(window)?;
    ide_dap::adapter::free_port().map_err(ide_core::IdeError::from)
}

#[command(trust = trusted)]
pub async fn debug_unity_processes(host: &Host, window: &str) -> IdeResult<Vec<attach::AttachableProcess>> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    if ide_workspace::unity::detect(&project.root).is_none() {
        return Err(ide_core::IdeError::invalid("Open a Unity project before attaching to the Editor"));
    }
    let command = ide_sdk::apply::tool_command(&project.root, &project.settings.effective(), "unity-debug")
        .map(|p| p.to_string_lossy().into_owned());
    unity::editors(command, project.root.clone()).await
}

/// Remote JVM Debug in listen mode: waits (cancellable through `request`) for the remote
/// JVM to connect to `host:port`; returns the loopback port java-debug attaches to.
#[command(trust = trusted)]
pub async fn debug_listen_for_jvm(
    ide: &Host,
    window: &str,
    request: ide_core::RequestId,
    host: String,
    port: u16,
) -> IdeResult<u16> {
    ide.require_trust(window)?;
    let token = ide.begin_request(request);
    let result = jdwp::listen_for_jvm(&host, port, token).await;
    ide.end_request(request);
    result
}

/// HotSwap (Reload Changed Classes) in a java-debug session.
#[command(trust = trusted)]
pub async fn debug_redefine_classes(host: &Host, session: DebugSessionId) -> IdeResult<HotSwapResult> {
    host.debugger.redefine_classes(session).await
}

/// The debuggee JVM's loaded classes (instances and shallow bytes), or why they cannot be read.
#[command(trust = trusted)]
pub async fn debug_jvm_memory_classes(
    host: &Host,
    window: &str,
    session: DebugSessionId,
) -> IdeResult<JvmMemoryResult> {
    host.require_trust(window)?;
    host.debugger.jvm_memory_classes(session).await
}

/// A `Thread.print -l` of the debuggee JVM (with the JSON dump on JDK 21+), or why it cannot be
/// taken.
#[command(trust = trusted)]
pub async fn debug_jvm_thread_dump(host: &Host, window: &str, session: DebugSessionId) -> IdeResult<JvmThreadsResult> {
    host.require_trust(window)?;
    let heap_root = host.heap.root().to_path_buf();
    let dir = host.blocking(move || Ok(super::thread_dump::json_dir(&heap_root))).await?;
    let result = host.debugger.jvm_thread_dump(session, dir.clone()).await;
    let _ = host
        .blocking(move || {
            super::thread_dump::discard_json_dir(dir);
            Ok(())
        })
        .await;
    result
}

/// Up to `limit` live instances of the class in the stopped JVM.
#[command(trust = trusted)]
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

/// The fields (or array elements) of an instance in the stopped JVM.
#[command(trust = trusted)]
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
#[command(trust = trusted)]
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
    fn java_debug_sessions_look_up_sources_in_project_roots() {
        let roots = [PathBuf::from("/p/src/main/java"), PathBuf::from("/p/src/test/java")];
        let source_paths = |config: &LaunchConfig| {
            serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()["sourcePaths"]
                .clone()
        };
        for adapter in ["java-debug", ide_dap::adapter::JAVA_ANALYZER] {
            for request in ["launch", "attach"] {
                let config = add_java_source_paths(launch(adapter, request, serde_json::json!({"port": 5005})), &roots);
                assert_eq!(source_paths(&config), serde_json::json!(["/p/src/main/java", "/p/src/test/java"]));
            }
        }
        let mut bare = launch("java-debug", "attach", serde_json::json!({}));
        bare.extra_json = None;
        assert_eq!(
            source_paths(&add_java_source_paths(bare, &roots)),
            serde_json::json!(["/p/src/main/java", "/p/src/test/java"])
        );

        let own = launch("java-debug", "launch", serde_json::json!({"sourcePaths": ["/elsewhere"]}));
        assert_eq!(source_paths(&add_java_source_paths(own, &roots)), serde_json::json!(["/elsewhere"]));
        let other = launch("debugpy", "launch", serde_json::json!({}));
        assert_eq!(add_java_source_paths(other.clone(), &roots).extra_json, other.extra_json);
        let none = launch("java-debug", "launch", serde_json::json!({}));
        assert_eq!(add_java_source_paths(none.clone(), &[]).extra_json, none.extra_json);
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
    fn plugin_java_agents_join_the_vm_options_of_jvm_launches() {
        let agent = "-javaagent:/my plugins/agent.jar=port=0".to_owned();
        let options = std::slice::from_ref(&agent);
        let field = |config: &LaunchConfig, key: &str| {
            serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()[key].clone()
        };
        let debugged =
            add_java_agents(launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"})), options);
        assert_eq!(vm_args(&debugged), "-Xmx1g \"-javaagent:/my plugins/agent.jar=port=0\"");
        assert_eq!(add_java_agents(debugged.clone(), options).extra_json, debugged.extra_json, "not added twice");
        let none = add_java_agents(launch("java-debug", "launch", serde_json::json!({"vmArgs": null})), options);
        assert_eq!(vm_args(&none), "\"-javaagent:/my plugins/agent.jar=port=0\"");
        let list = add_java_agents(launch("java-debug", "launch", serde_json::json!({"vmArgs": ["-Xmx1g"]})), options);
        assert_eq!(vm_args(&list), serde_json::json!(["-Xmx1g", agent]));
        let kotlin = launch(ide_dap::kotlin::ADAPTER, "launch", serde_json::json!({"vmArguments": ["-Xmx1g"]}));
        assert_eq!(field(&add_java_agents(kotlin, options), "vmArguments"), serde_json::json!(["-Xmx1g", agent]));
        let kotlin = launch(ide_dap::kotlin::ADAPTER, "launch", serde_json::json!({}));
        assert_eq!(field(&add_java_agents(kotlin, options), "vmArguments"), serde_json::json!([agent]));
        let java_analyzer =
            launch(ide_dap::adapter::JAVA_ANALYZER, "launch", serde_json::json!({"vmArgs": ["-Xmx1g"]}));
        assert_eq!(vm_args(&add_java_agents(java_analyzer, options)), serde_json::json!(["-Xmx1g", agent]));
        // Attaching (remote debug included), other adapters, and no granted agent: unchanged.
        for config in [
            launch("java-debug", "attach", serde_json::json!({"vmArgs": "-Xmx1g"})),
            launch("debugpy", "launch", serde_json::json!({"vmArgs": "-Xmx1g"})),
        ] {
            assert_eq!(add_java_agents(config.clone(), options).extra_json, config.extra_json);
        }
        let config = launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"}));
        assert_eq!(add_java_agents(config.clone(), &[]).extra_json, config.extra_json);
    }

    #[test]
    fn enhanced_class_redefinition_is_taken_from_the_launch_extras() {
        let tmp = tempfile::tempdir().unwrap();
        let jdk = |name: &str, implementor: &str| {
            let home = tmp.path().join(name);
            std::fs::create_dir_all(home.join("bin")).unwrap();
            std::fs::write(home.join("release"), format!("IMPLEMENTOR=\"{implementor}\"\n")).unwrap();
            std::fs::write(home.join("bin/java"), "").unwrap();
            home.join("bin/java").to_string_lossy().into_owned()
        };
        let (jbr, temurin) = (jdk("jbr", "JetBrains s.r.o."), jdk("temurin", "Eclipse Adoptium"));
        let extras = |config: &LaunchConfig| {
            serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()
        };

        let mut config = launch(
            "java-debug",
            "launch",
            serde_json::json!({"javaExec": jbr, "vmArgs": "-Xmx1g", "enhancedClassRedefinition": true}),
        );
        assert_eq!(take_enhanced_redefinition(&mut config), Some(Ok(ide_run::java_hotswap::OPTION)));
        assert!(extras(&config).get("enhancedClassRedefinition").is_none(), "not passed on to the adapter");
        assert_eq!(extras(&config)["vmArgs"], "-Xmx1g");

        let mut config =
            launch("java-debug", "launch", serde_json::json!({"javaExec": temurin, "enhancedClassRedefinition": true}));
        let note = take_enhanced_redefinition(&mut config).unwrap().unwrap_err();
        assert!(note.contains("is not a JetBrains Runtime"), "{note}");
        let mut config = launch("java-debug", "launch", serde_json::json!({"enhancedClassRedefinition": true}));
        assert!(take_enhanced_redefinition(&mut config).unwrap().unwrap_err().contains("is unknown"));

        // Off, absent, or not a JVM the debugger starts: nothing to add, and no note.
        for (adapter, request, extra) in [
            ("java-debug", "launch", serde_json::json!({"javaExec": jbr, "enhancedClassRedefinition": false})),
            ("java-debug", "launch", serde_json::json!({"javaExec": jbr})),
            ("java-debug", "attach", serde_json::json!({"javaExec": jbr, "enhancedClassRedefinition": true})),
        ] {
            let mut config = launch(adapter, request, extra);
            assert_eq!(take_enhanced_redefinition(&mut config), None);
            assert!(extras(&config).get("enhancedClassRedefinition").is_none());
        }
    }

    #[test]
    fn the_executor_is_taken_out_of_the_launch_extras() {
        let extras = |config: &LaunchConfig| {
            serde_json::from_str::<serde_json::Value>(config.extra_json.as_deref().unwrap()).unwrap()
        };
        let mut config =
            launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g", "executor": "acme.reload"}));
        assert_eq!(take_executor(&mut config).as_deref(), Some("acme.reload"));
        assert!(extras(&config).get("executor").is_none(), "not passed on to the adapter");
        assert_eq!(extras(&config)["vmArgs"], "-Xmx1g");
        let mut plain = launch("java-debug", "launch", serde_json::json!({"vmArgs": "-Xmx1g"}));
        assert_eq!(take_executor(&mut plain), None);
        assert_eq!(extras(&plain)["vmArgs"], "-Xmx1g");
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

ide_command::domain!(
    debug:
    debug_attachable_processes,
    debug_breakpoint_states,
    debug_capabilities,
    debug_completions,
    debug_data_breakpoint_info,
    debug_evaluate,
    debug_evaluate_in,
    debug_exception_filters,
    debug_force_step_over,
    debug_free_port,
    debug_js_custom_breakpoints,
    debug_js_response_body,
    debug_js_response_overrides,
    debug_js_start_profile,
    debug_js_stop_profile,
    debug_jvm_memory_classes,
    debug_jvm_memory_fields,
    debug_jvm_memory_instances,
    debug_jvm_memory_referrers,
    debug_jvm_thread_dump,
    debug_listen_for_jvm,
    debug_pause,
    debug_redefine_classes,
    debug_replace_breakpoints,
    debug_resolve_variable,
    debug_restart_frame,
    debug_resume,
    debug_run_to,
    debug_scopes,
    debug_send_input,
    debug_sessions,
    debug_set_breakpoints,
    debug_set_data_breakpoints,
    debug_set_exception_breakpoints,
    debug_set_exception_class_breakpoints,
    debug_set_function_breakpoints,
    debug_set_variable,
    debug_stack_trace,
    debug_start,
    debug_step,
    debug_step_in_target,
    debug_step_in_targets,
    debug_stop,
    debug_threads,
    debug_unity_processes,
    debug_variables,
);
