// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/ExecutionToolset.kt,
// mcpserver.toolsets/src/util/execution.util.kt, mcpserver.toolsets/src/util/RunConfigurationBuildErrors.kt), Apache-2.0.
//! `get_run_configurations` and `execute_run_configuration`.

use super::build::build_once;
use super::output::OutputCollector;
use super::process::{quote, split_words};
use super::targets;
use crate::tool::{Call, Output, Param, ParamType, Tool};
use crate::tools::run::timeout;
use ide_build::compile::BuildKind;
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult, RunId, Severity};
use ide_run::{OutputChunk, RunConfig};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: usize = 10_000;
/// No limit in JetBrains; the process keeps running after the timeout anyway.
const MAX_TIMEOUT_MS: usize = 1_800_000;
/// Output of a failed before-launch process kept for the error message.
const MAX_PROCESS_OUTPUT_LENGTH: usize = 20_000;
/// A before-launch build gets this long.
const BEFORE_LAUNCH_BUILD_TIMEOUT: Duration = Duration::from_secs(3600);

async fn load_configs(call: &Call) -> IdeResult<Vec<RunConfig>> {
    let host = call.host();
    let window = call.window().to_owned();
    let h = host.clone();
    host.blocking(move || ide_host::ops::run::configs(&h, &window)).await
}

fn supports_overrides(config: &RunConfig) -> bool {
    config.extras.compound.is_empty() && !config.command.trim().is_empty()
}

fn command_line(config: &RunConfig) -> String {
    std::iter::once(config.command.clone()).chain(config.args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ")
}

fn describe_config(call: &Call, c: &RunConfig) -> Value {
    let mut v = json!({
        "name": c.name,
        "description": c.kind,
        "supportsDynamicLaunchOverrides": supports_overrides(c),
    });
    if supports_overrides(c) {
        v["commandLine"] = command_line(c).into();
        if let Some(cwd) = c.cwd.as_deref() {
            v["workingDirectory"] = call.display(&call.root().join(cwd)).into();
        }
        if !c.env.is_empty() {
            v["environment"] = json!(c.env);
        }
    }
    v
}

/// A file of the project to look for run points in: its path, `/`-separated project-relative
/// path and current text (unsaved edits included).
fn read_file(call: &Call, file: &str) -> IdeResult<(PathBuf, String, String)> {
    let path = call.resolve_inside(file)?;
    let meta = std::fs::metadata(&path).map_err(|_| IdeError::not_found(format!("File not found: {file}")))?;
    if !meta.is_file() {
        return Err(IdeError::invalid(format!("Not a file: {file}")));
    }
    let rel = path.strip_prefix(call.root()).unwrap_or(&path).to_string_lossy().replace('\\', "/");
    let text = match call.project().documents.text_of(&path) {
        Some(text) => text,
        None => std::fs::read_to_string(&path).map_err(|e| IdeError::invalid(format!("Cannot read {file}: {e}")))?,
    };
    Ok((path, rel, text))
}

pub fn get_run_configurations() -> Tool {
    Tool::new(
        "get_run_configurations",
        McpToolKind::Read,
        "Returns either project run configurations or executable code locations, depending on the input.

Without `filePath`, this tool lists the project's existing run configurations. The result includes configuration
names and, when available, launch details such as program arguments, working directory, environment variables,
and `supportsDynamicLaunchOverrides`.

`supportsDynamicLaunchOverrides` is the source-of-truth capability flag for one-time launch overrides
(`programArguments`, `workingDirectory`, `envs`) in `execute_run_configuration` and `xdebug_start_debugger_session`.
Only pass those override parameters when this flag is `true` for the selected configuration.

With `filePath`, this tool discovers executable entry points (run points) in that file, such as test methods,
main methods, or other executable entry points where the IDE shows a Run gutter icon. The result contains `filePath` and
`runPoints`; use the returned line numbers with `execute_run_configuration` to run from code.
In OpenIDEA the configurations are the saved ones and those detected from the build files (package.json scripts, \
Cargo targets, Gradle/Maven tasks, Go, Python, Makefile…); `description` is the configuration type and `commandLine` \
the whole command. Run points are found in Rust, JavaScript/TypeScript, Python and Go files.",
        |call| async move {
            let configs = load_configs(&call).await?;
            if let Some(file) = call.opt_str("filePath")? {
                let (_, rel, text) = read_file(&call, &file)?;
                let mut points: Vec<Value> = Vec::new();
                let mut lines = std::collections::HashSet::new();
                for t in targets::detect(&text, &rel) {
                    if lines.contains(&t.line) {
                        continue;
                    }
                    if let Some(config) = targets::target_config(call.root(), &t, &rel, &configs, &text) {
                        lines.insert(t.line);
                        points.push(json!({
                            "line": t.line + 1,
                            "description": format!("Run '{}'", config.name),
                            "elementText": t.name,
                        }));
                    }
                }
                return Output::json(json!({ "filePath": file, "runPoints": points }));
            }
            let list: Vec<Value> = configs.iter().map(|c| describe_config(&call, c)).collect();
            Output::json(json!({ "configurations": list }))
        },
    )
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "Optional file path relative to the project root. When provided, returns run points (executable entry points) \
in the file instead of project-wide run configurations.",
    ))
}

/// What `execute_run_configuration` runs.
enum ExecutionTarget {
    ByName(String),
    ByContext(String, i64),
}

fn execution_target(name: Option<String>, file: Option<String>, line: Option<i64>) -> IdeResult<ExecutionTarget> {
    let name = name.filter(|n| !n.trim().is_empty());
    let file = file.filter(|f| !f.trim().is_empty());
    match (name, file, line) {
        (Some(_), f, l) if f.is_some() || l.is_some() => {
            Err(IdeError::invalid("Pass either configurationName or filePath + line, but not both."))
        }
        (Some(name), _, _) => Ok(ExecutionTarget::ByName(name)),
        (None, Some(file), Some(line)) => Ok(ExecutionTarget::ByContext(file, line)),
        (None, Some(_), None) | (None, None, Some(_)) => {
            Err(IdeError::invalid("Pass both filePath and line together, or use configurationName."))
        }
        (None, None, None) => Err(IdeError::invalid("Pass either configurationName or filePath + line.")),
    }
}

/// The temporary configuration of the run point at `file:line` (1-based): the target declared
/// on that line, else the whole file's (its tests, its main function).
fn config_from_code_location(call: &Call, configs: &[RunConfig], file: &str, line: i64) -> IdeResult<RunConfig> {
    let (_, rel, text) = read_file(call, file)?;
    if line < 1 {
        return Err(IdeError::invalid(format!("Line number must be >= 1, got: {line}")));
    }
    let count = text.split('\n').count();
    if line as usize > count {
        return Err(IdeError::invalid(format!("Line {line} is out of range (file has {count} lines)")));
    }
    let root = call.root();
    targets::detect(&text, &rel)
        .iter()
        .filter(|t| t.line + 1 == line as usize)
        .find_map(|t| targets::target_config(root, t, &rel, configs, &text))
        .or_else(|| targets::context_config(root, &rel, configs, &text))
        .ok_or_else(|| {
            IdeError::not_found(format!(
                "No run configuration could be created from {file}:{line}. Use get_run_configurations with filePath \
to find valid run locations."
            ))
        })
}

/// Applies the one-off overrides (JetBrains' `prepareRunConfigurationForExecution`): a missing or
/// empty string keeps the value, a whitespace-only one clears it; `envs` merge over the configuration's.
fn apply_overrides(
    config: &mut RunConfig,
    root: &Path,
    args: Option<String>,
    cwd: Option<String>,
    envs: Option<Vec<(String, String)>>,
) -> IdeResult<()> {
    let args = args.filter(|a| !a.is_empty());
    let cwd = cwd.filter(|d| !d.is_empty());
    if args.is_none() && cwd.is_none() && envs.is_none() {
        return Ok(());
    }
    if !supports_overrides(config) {
        return Err(IdeError::invalid(format!(
            "Run configuration '{}' of type '{}' doesn't support dynamic launch overrides (programArguments, \
workingDirectory, envs).",
            config.name,
            if config.extras.compound.is_empty() { config.kind.as_str() } else { "Compound" }
        )));
    }
    if let Some(args) = args {
        let words = split_words(&args)?;
        // A configuration that is one shell line (`npm run dev`, no separate arguments)
        // keeps its command and gets the new line's arguments appended.
        let shell_line = config.args.is_empty() && config.command.trim().contains(char::is_whitespace);
        if shell_line {
            if !words.is_empty() {
                config.command = format!("{} {}", config.command.trim(), args.trim());
            }
        } else {
            config.args = words;
        }
    }
    if let Some(dir) = cwd {
        if dir.trim().is_empty() {
            config.cwd = None;
        } else {
            let path = crate::project::resolve(root, &dir)?;
            if !path.is_dir() {
                return Err(IdeError::not_found(format!("workingDirectory {} is not a directory", path.display())));
            }
            config.cwd = Some(path.into());
        }
    }
    config.env.extend(envs.into_iter().flatten());
    Ok(())
}

/// Polls how run `id` ended: `None` while running, else its exit code (if known).
fn run_exit(host: &ide_host::Host, id: RunId) -> Option<Option<i32>> {
    match host.processes.exit_code(id) {
        Ok(exit) => exit,
        // Remote (SSH) runs, or a finished run already forgotten: the run list knows whether it runs.
        Err(_) => match ide_host::ops::run::list(host).into_iter().find(|r| r.id == id) {
            Some(r) if r.running => None,
            _ => Some(None),
        },
    }
}

/// Waits for run `id` to exit, until `deadline`: `None` when it is still running. Cancelling
/// the call stops the run.
async fn wait_exit(call: &Call, id: RunId, deadline: Option<Instant>) -> IdeResult<Option<Option<i32>>> {
    let host = call.host();
    loop {
        if let Some(exit) = run_exit(&host, id) {
            return Ok(Some(exit));
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return Ok(None);
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            _ = call.cancel.cancelled() => {
                let _ = ide_host::ops::run::stop(&host, call.window(), id);
                return Err(IdeError::cancelled());
            }
        }
    }
}

/// An output callback that skips the IDE's own lines (`Process finished…`), as JetBrains
/// skips `ProcessOutputType.SYSTEM`.
fn process_output(mut f: impl FnMut(&str) + Send + 'static) -> ide_host::ops::Emit<OutputChunk> {
    let f = Mutex::new(move |t: &str| f(t));
    Arc::new(move |chunk: OutputChunk| match &chunk {
        OutputChunk::Stdout { text } | OutputChunk::Stderr { text } => (f.lock())(text),
        OutputChunk::System { .. } => {}
    })
}

/// What failed before launch (JetBrains' `RunConfigurationBuildErrors`): build errors as
/// `path:line: message`, else the output of before-launch processes that failed.
#[derive(Default)]
struct BuildErrors {
    errors: Vec<String>,
    process_outputs: Vec<String>,
}

impl BuildErrors {
    fn text(&self) -> Option<String> {
        let mut seen = std::collections::HashSet::new();
        let errors: Vec<&String> = self.errors.iter().filter(|e| seen.insert(*e)).collect();
        if !errors.is_empty() {
            return Some(errors.iter().map(|e| e.as_str()).collect::<Vec<_>>().join("\n"));
        }
        let outputs: Vec<&str> = self.process_outputs.iter().map(|o| o.trim()).filter(|o| !o.is_empty()).collect();
        (!outputs.is_empty()).then(|| outputs.join("\n"))
    }
}

/// Runs `config` to its end; `Ok(false)` (with its output recorded) when it failed.
async fn run_to_end(call: &Call, config: RunConfig, errors: &mut BuildErrors) -> IdeResult<bool> {
    let tail = Arc::new(Mutex::new(String::new()));
    let sink = tail.clone();
    let emit = process_output(move |text| {
        let mut t = sink.lock();
        t.push_str(text);
        if t.len() > 2 * MAX_PROCESS_OUTPUT_LENGTH {
            let mut cut = t.len() - MAX_PROCESS_OUTPUT_LENGTH;
            while !t.is_char_boundary(cut) {
                cut += 1;
            }
            t.drain(..cut);
        }
    });
    let info = ide_host::ops::run::start(&call.host(), call.window(), config, emit).await?;
    let exit = wait_exit(call, info.id, None).await?.flatten();
    if exit == Some(0) {
        return Ok(true);
    }
    let t = tail.lock();
    let start = t.char_indices().rev().nth(MAX_PROCESS_OUTPUT_LENGTH - 1).map_or(0, |(i, _)| i);
    errors.process_outputs.push(t[start..].to_owned());
    Ok(false)
}

/// The configuration's before-launch tasks, as the Run tool window runs them; returns why
/// the launch is aborted, if it is. Tool windows are not activated.
async fn before_launch(
    call: &Call,
    config: &RunConfig,
    configs: &[RunConfig],
    chain: &mut Vec<String>,
    errors: &mut BuildErrors,
) -> IdeResult<Option<String>> {
    chain.push(config.id.clone());
    for task in &config.extras.before_launch {
        let target = task.target.as_str();
        let (label, failure) = match task.kind.as_str() {
            "build" => {
                let console = Arc::new(Mutex::new(String::new()));
                let deadline = Instant::now() + BEFORE_LAUNCH_BUILD_TIMEOUT;
                let failure = match build_once(call, BuildKind::Build, None, deadline, &console).await {
                    Ok(Some(r)) => {
                        for m in r.messages.iter().filter(|m| m.severity == Severity::Error) {
                            errors.errors.push(match (&m.path, m.range) {
                                (Some(p), Some(r)) => format!("{}:{}: {}", p.display(), r.start.line + 1, m.text),
                                _ => m.text.clone(),
                            });
                        }
                        (!r.success).then(|| "Build failed".to_owned())
                    }
                    Ok(None) => Some("The build timed out".to_owned()),
                    Err(e) => Some(e.message),
                };
                ("Build Project".to_owned(), failure)
            }
            "run" => {
                let other = configs.iter().find(|c| c.id == target);
                let label = format!("Run '{}'", other.map_or(target, |c| c.name.as_str()));
                let failure = if chain.iter().any(|c| c == target) {
                    Some("The before launch tasks run in a cycle".to_owned())
                } else if let Some(other) = other {
                    let ok = Box::pin(before_launch(call, other, configs, chain, errors)).await?.is_none()
                        && run_to_end(call, other.clone(), errors).await?;
                    (!ok).then(|| format!("'{}' failed", other.name))
                } else {
                    Some(format!("Configuration '{target}' no longer exists"))
                };
                (label, failure)
            }
            "command" => {
                let failure = if target.trim().is_empty() {
                    Some("No command".to_owned())
                } else {
                    let run = RunConfig {
                        id: format!("before-launch:{}:{target}", config.id),
                        name: target.to_owned(),
                        kind: "shell".into(),
                        command: target.to_owned(),
                        args: Vec::new(),
                        cwd: config.cwd.clone(),
                        env: Default::default(),
                        detected: true,
                        is_test: false,
                        debug_adapter: None,
                        allow_parallel: false,
                        extras: Default::default(),
                    };
                    (!run_to_end(call, run, errors).await?).then(|| format!("'{target}' failed"))
                };
                (format!("Run '{target}'"), failure)
            }
            "toolWindow" => continue,
            "tool" => (format!("External tool '{target}'"), Some("External tools cannot run through MCP".to_owned())),
            other => (other.to_owned(), Some(format!("Unknown before launch task '{other}'"))),
        };
        if let Some(failure) = failure {
            chain.pop();
            return Ok(Some(format!("Before launch: {label}: {failure}")));
        }
    }
    chain.pop();
    Ok(None)
}

fn execution_failed(details: &[Option<String>]) -> IdeError {
    let details: Vec<&str> = details.iter().flatten().map(String::as_str).collect();
    IdeError::invalid(format!("Execution failed: {}", details.join("\n")))
}

pub fn execute_run_configuration() -> Tool {
    Tool::new(
        "execute_run_configuration",
        McpToolKind::Execute,
        "Run either an existing run configuration by name or a temporary run configuration created from a code location \
(`filePath` + `line`) in the current project, then wait up to specified timeout for it to finish.

Use this tool with either a configuration name returned by `get_run_configurations`, or with a run point
(`filePath` + `line`) returned by `get_run_configurations(filePath = ...)`.

Optional launch overrides (`programArguments`, `workingDirectory`, `envs`) are applied only for this run and are not persisted.
Do not pass these override parameters unless you explicitly need to change the configured launch values for this run.
Missing/null override parameters keep existing run configuration values unchanged.
For string overrides (`programArguments`, `workingDirectory`), missing/null or empty string (`\"\"`) keeps the existing value unchanged.
Pass a whitespace-only string such as `\" \"` to clear an existing value for this launch.

Pass either `configurationName`, or `filePath` together with `line`. These modes are mutually exclusive.

Behavior:
- When `waitForExit=true`, waits up to `timeout` milliseconds for process termination. If the timeout expires,
  the process keeps running in the background and `exitCode` is omitted from the result.
- When `waitForExit=false`, waits only for the process to start, then returns immediately without applying `timeout`.
- `fullOutputPath` points to a temp file with the full raw output and may continue growing while the process is alive.

Returns the execution result including current output snapshot, optional exit code, and optional `fullOutputPath`.
In OpenIDEA the user is asked first unless brave mode is on; `programArguments` replace the configuration's \
arguments (appended to a command that is one shell line, such as `npm run dev`); the run does not appear in the Run \
tool window; output files are private and deleted after a day.",
        |call| async move {
            let target = execution_target(
                call.opt_str("configurationName")?,
                call.opt_str("filePath")?,
                call.opt_i64("line")?,
            )?;
            let wait = call.flag("waitForExit", true)?;
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)?;
            let envs = call.args.get("envs").filter(|v| !v.is_null()).map(|_| call.str_map("envs")).transpose()?;
            let configs = load_configs(&call).await?;
            let mut config = match &target {
                ExecutionTarget::ByName(name) => configs
                    .iter()
                    .find(|c| c.name == *name)
                    .cloned()
                    .ok_or_else(|| IdeError::not_found(format!("Run configuration with name '{name}' not found.")))?,
                ExecutionTarget::ByContext(file, line) => config_from_code_location(&call, &configs, file, *line)?,
            };
            // The user approves the environment overrides too (`NODE_OPTIONS`, `PATH`, ...).
            let env_detail: String = envs.iter().flatten().map(|(k, v)| format!("\n{k}={v}")).collect();
            apply_overrides(
                &mut config,
                call.root(),
                call.opt_str("programArguments")?,
                call.opt_str("workingDirectory")?,
                envs,
            )?;
            if !config.extras.compound.is_empty() {
                return Err(IdeError::invalid(format!(
                    "`{}` is a compound configuration, which cannot run through MCP; run its configurations ({}) \
one by one",
                    config.name,
                    config.extras.compound.join(", ")
                )));
            }
            let cwd = match config.cwd.as_deref() {
                Some(p) => call.root().join(p),
                None => call.root().to_path_buf(),
            };
            call.confirm(&config.name, Some(format!("{}\nin {}{env_detail}", command_line(&config), call.display(&cwd))))
                .await?;

            let mut errors = BuildErrors::default();
            if let Some(reason) = before_launch(&call, &config, &configs, &mut Vec::new(), &mut errors).await? {
                return Err(execution_failed(&[errors.text(), Some(reason)]));
            }
            let collector = Arc::new(Mutex::new(OutputCollector::create(&config.name)?));
            let sink = collector.clone();
            let emit = process_output(move |text| sink.lock().append(text));
            let info = ide_host::ops::run::start(&call.host(), call.window(), config, emit)
                .await
                .map_err(|e| execution_failed(&[errors.text(), Some(e.message)]))?;

            let exit = if wait { wait_exit(&call, info.id, Some(Instant::now() + limit)).await? } else { None };
            let c = collector.lock();
            let mut result = Map::new();
            if let Some(Some(code)) = exit {
                result.insert("exitCode".into(), code.into());
            }
            result.insert("output".into(), c.preview().into());
            // An exited run whose whole output is in `output` needs no file.
            if exit.is_none() || c.truncated {
                result.insert("fullOutputPath".into(), c.path.to_string_lossy().into_owned().into());
            } else {
                let _ = std::fs::remove_file(&c.path);
            }
            Output::json(Value::Object(result))
        },
    )
    .param(Param::optional("configurationName", ParamType::String, "Name of the existing run configuration to execute"))
    .param(Param::optional(
        "filePath",
        ParamType::String,
        "File path relative to the project root. Provide together with `line` to create and execute a temporary run \
configuration from code context.",
    ))
    .param(Param::optional(
        "line",
        ParamType::Integer,
        "1-based line number for `filePath`. Provide together with `filePath` and do not combine with \
`configurationName`.",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Timeout in milliseconds"))
    .param(Param::optional(
        "waitForExit",
        ParamType::Boolean,
        "Whether to wait for process termination. If false, the tool returns immediately after the process starts and \
ignores `timeout`.",
    ))
    .param(Param::optional(
        "programArguments",
        ParamType::String,
        "Optional program arguments override for this launch only. Missing/null or empty string keeps the existing \
value; whitespace-only string clears it.",
    ))
    .param(Param::optional(
        "workingDirectory",
        ParamType::String,
        "Optional working directory override for this launch only. Missing/null or empty string keeps the existing \
value; whitespace-only string clears it.",
    ))
    .param(Param::optional(
        "envs",
        ParamType::StringMap,
        "Optional environment variable overrides for this launch only. Missing/null keeps existing env unchanged; when \
provided, values are merged over existing env.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RunConfig {
        RunConfig {
            id: "user:x".into(),
            name: "x".into(),
            kind: "shell".into(),
            command: "prog".into(),
            args: vec!["a".into()],
            cwd: Some(PathBuf::from("sub").into()),
            env: [("A".to_owned(), "1".to_owned())].into(),
            detected: false,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    #[test]
    fn empty_overrides_keep_and_blank_ones_clear() {
        let root = Path::new("/");
        let mut c = config();
        apply_overrides(&mut c, root, Some(String::new()), Some(String::new()), None).unwrap();
        assert_eq!(c, config());
        apply_overrides(&mut c, root, Some(" ".into()), Some(" ".into()), Some(vec![("C".into(), "3".into())]))
            .unwrap();
        assert!(c.args.is_empty());
        assert!(c.cwd.is_none());
        assert_eq!(c.env.keys().collect::<Vec<_>>(), ["A", "C"]);
        apply_overrides(&mut c, root, Some("x 'y z'".into()), None, None).unwrap();
        assert_eq!(c.args, ["x", "y z"]);
    }

    #[test]
    fn execution_targets_are_exclusive() {
        let err = |n: Option<&str>, f: Option<&str>, l| {
            execution_target(n.map(Into::into), f.map(Into::into), l).err().map(|e| e.message)
        };
        assert_eq!(
            err(Some("a"), Some("f"), Some(1)).as_deref(),
            Some("Pass either configurationName or filePath + line, but not both.")
        );
        assert_eq!(
            err(None, Some("f"), None).as_deref(),
            Some("Pass both filePath and line together, or use configurationName.")
        );
        assert_eq!(err(None, None, None).as_deref(), Some("Pass either configurationName or filePath + line."));
        assert!(err(Some("a"), None, None).is_none());
    }
}
